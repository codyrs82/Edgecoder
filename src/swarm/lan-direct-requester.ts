// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The requester's side of direct LAN transfer, in the agent's local forwarder (src/swarm/local-forwarder.ts):
 *
 * - rewriteSubmit: a /forward/inference/submit that asks for direct transfer gets a fresh X25519
 *   key for the call (the private half stays here, keyed by task, for LAN_KEY_TTL_MS), but only when
 *   direct transfer is on here and a neighbour advertises it; otherwise the ask is dropped.
 * - run: POST /forward/lan/direct { ticket, request } connects to the host the ticket names (its
 *   address from this agent's own mDNS table: it never came from the coordinator), runs the call
 *   (lan-direct.ts directCall) and writes NDJSON lines: { t: "chunk" }..., { t: "done", replySha256,
 *   replyBytes }, or { t: "fallback", phase, reason, chars } when the caller must read through the
 *   coordinator (phase "connect": from the start; "stream": skipping the `chars` it already has).
 */
import { generateX25519KeyPair } from "../security/envelope.js";
import { directCall, LanDirectError, replyDigest, type DuplexLike, type LanTicket } from "./lan-direct.js";

export const LAN_KEY_TTL_MS = 60_000;

export interface LanDirectRequesterDeps {
  selfAgentId: string;
  /** Direct transfer on here (AGENT_LAN_DIRECT and discovery running). */
  enabled: () => boolean;
  /** Some neighbour advertises direct transfer. */
  anyDirectNeighbour: () => boolean;
  /** Where a neighbour's direct listener is (this agent's mDNS table). */
  lookup: (lanId: string) => { address: string; port: number } | null;
  /** Open a TCP connection (tests pass a fake). */
  connect?: (address: string, port: number) => DuplexLike;
  now?: () => number;
  connectMs?: number;
}

async function tcpConnect(address: string, port: number): Promise<DuplexLike> {
  const net = await import("node:net");
  const sock = net.connect({ host: address, port });
  sock.setNoDelay(true);
  // directCall listens too; this keeps an early refusal from being an unhandled error.
  sock.on("error", () => undefined);
  return sock;
}

export function createLanDirectRequester(deps: LanDirectRequesterDeps) {
  const now = deps.now ?? Date.now;
  const keys = new Map<string, { privateKey: Buffer; atMs: number }>();
  const prune = () => {
    const t = now();
    for (const [id, k] of keys) if (t - k.atMs > LAN_KEY_TTL_MS) keys.delete(id);
  };

  function rewriteSubmit(body: Record<string, unknown>): Record<string, unknown> {
    prune();
    const taskId = typeof body.taskId === "string" ? body.taskId : "";
    if (!taskId || !deps.enabled() || !deps.anyDirectNeighbour() || keys.size > 256) return body;
    const pair = generateX25519KeyPair();
    keys.set(taskId, { privateKey: pair.privateKey, atMs: now() });
    return { ...body, lanDirect: { pub: pair.publicKey.toString("base64") } };
  }

  async function run(raw: unknown, writeLine: (obj: unknown) => void): Promise<void> {
    const body = (raw ?? {}) as { ticket?: LanTicket; request?: { messages?: unknown[]; tools?: unknown[] } };
    const fallback = (phase: "connect" | "stream", reason: string, chars: number) => writeLine({ t: "fallback", phase, reason, chars });
    const ticket = body.ticket;
    if (!ticket || typeof ticket !== "object" || !Array.isArray(body.request?.messages)) return fallback("connect", "bad_request", 0);
    prune();
    const key = keys.get(ticket.taskId);
    keys.delete(ticket.taskId);
    if (!key || ticket.requesterAgentId !== deps.selfAgentId) return fallback("connect", "no_key", 0);
    const where = deps.lookup(ticket.hostLanId);
    if (!where) return fallback("connect", "host_not_seen", 0);
    const connect = deps.connect;
    let full = "";
    try {
      // The socket buffers the hello until it is connected; directCall's connect deadline covers both.
      const sock = connect ? connect(where.address, where.port) : await tcpConnect(where.address, where.port);
      for await (const piece of directCall({
        connect: () => sock,
        ticket,
        requesterPrivateKey: key.privateKey,
        request: { messages: body.request!.messages!, ...(Array.isArray(body.request!.tools) && body.request!.tools.length ? { tools: body.request!.tools } : {}) },
        connectMs: deps.connectMs,
      })) {
        if (piece.t === "chunk") {
          full += piece.delta;
          writeLine(piece);
        } else if (piece.t === "done") {
          writeLine({ ...piece, replySha256: replyDigest(full), replyBytes: Buffer.byteLength(full, "utf8") });
        }
      }
    } catch (err) {
      if (err instanceof LanDirectError) return fallback(err.phase, err.reason, full.length);
      return fallback(full ? "stream" : "connect", (err as Error).message ?? "error", full.length);
    }
  }

  return { rewriteSubmit, run, pendingKeys: () => keys.size };
}
