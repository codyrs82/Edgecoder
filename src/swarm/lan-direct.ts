// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Direct LAN transfer of a model call (opt-in per machine: AGENT_LAN_DIRECT, default off;
 * docs/security/lan-proximity.md "Direct transfer").
 *
 * When the coordinator places a call on a host that is on the requester's LAN and both have direct
 * transfer on, it answers the requester's /inference/submit with a ticket:
 *
 *   { v, tid, taskId, subtaskId, hostLanId, hostAgentId, requesterAgentId, requesterPub, hostPub,
 *     model, maxTokens, temperature?, timeoutMs, inputSha256, exp, nonce, mac }
 *
 * - mac: HMAC-SHA256 over the other fields with a key derived from the LAN key the host registered
 *   for `hostLanId` (only the host and its coordinator know it). The requester cannot forge or
 *   change a ticket; another host cannot use it (wrong LAN id, wrong agent, wrong key).
 * - exp: LAN_TICKET_TTL_MS after issue. tid: single use (the host keeps the ids it has seen).
 * - requesterPub: an X25519 key the requester's agent made for this call; hostPub: the host's
 *   envelope key (#328). Both sides derive the session keys from X25519 + HKDF (salt tid), so the
 *   coordinator never has them.
 * - inputSha256: the call's messages and tools as the coordinator holds them (inputDigest). The host
 *   runs only a request that matches.
 *
 * Wire format (TCP, one call per connection): frames of a 4-byte length and a body (at most
 * MAX_FRAME_BYTES). The first frame is plaintext JSON { t: "hello", ticket }; the host closes the
 * connection at once on anything else, a bad ticket, or nothing within HELLO_TIMEOUT_MS. After it,
 * every frame is AES-256-GCM (12-byte nonce: direction + counter; AAD: tid):
 *
 *   host -> requester  { t: "ack" }
 *   requester -> host  { t: "req", messages, tools? }
 *   host -> requester  { t: "chunk", seq, delta }...  then { t: "done", toolCalls?, promptTokens?, outputTokens? }
 *                      or { t: "err", reason }
 *
 * The coordinator path is unchanged underneath: the host still claims the call with a signed /pull,
 * streams it to the coordinator and reports its signed result and receipt, which is what is billed
 * and verified. The requester confirms what it received (/inference/lan-receipt).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { x25519SharedSecret } from "../security/envelope.js";
import { isLanAddress, isLanId } from "./lan-discovery.js";

export const LAN_TICKET_TTL_MS = 15_000;
/** The requester gives up on the direct path and reads through the coordinator after this. */
export const LAN_DIRECT_CONNECT_MS = 500;
export const HELLO_TIMEOUT_MS = 2_000;
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const MAX_HELLO_BYTES = 16 * 1024;
export const LAN_DIRECT_MAX_CONNECTIONS = 8;
export const LAN_DIRECT_MAX_PER_SOURCE = 2;
/** Hellos per source address per minute. */
export const LAN_DIRECT_HELLO_PER_MIN = 30;

export interface LanTicketFields {
  v: 1;
  tid: string;
  taskId: string;
  subtaskId: string;
  hostLanId: string;
  hostAgentId: string;
  requesterAgentId: string;
  requesterPub: string;
  hostPub: string;
  model: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs: number;
  inputSha256: string;
  exp: number;
  nonce: string;
}

export interface LanTicket extends LanTicketFields {
  mac: string;
}

const FIELD_ORDER: Array<keyof LanTicketFields> = ["v", "tid", "taskId", "subtaskId", "hostLanId", "hostAgentId", "requesterAgentId", "requesterPub", "hostPub", "model", "maxTokens", "temperature", "timeoutMs", "inputSha256", "exp", "nonce"];

function canonicalTicket(t: LanTicketFields): string {
  return JSON.stringify(FIELD_ORDER.map((k) => (t[k] === undefined ? null : t[k])));
}

/** The ticket MAC key for a host's LAN key (domain-separated from its discovery proofs). */
export function ticketMacKey(lanKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", lanKey, "edgecoder-lan-ticket", "edgecoder-lan-ticket/v1", 32));
}

export function signTicket(fields: Omit<LanTicketFields, "v" | "tid" | "nonce" | "exp"> & { exp?: number }, lanKey: Buffer, nowMs: number): LanTicket {
  const full: LanTicketFields = {
    v: 1,
    tid: randomBytes(16).toString("hex"),
    ...fields,
    exp: fields.exp ?? nowMs + LAN_TICKET_TTL_MS,
    nonce: randomBytes(8).toString("hex"),
  };
  const mac = createHmac("sha256", ticketMacKey(lanKey)).update(canonicalTicket(full)).digest("hex");
  return { ...full, mac };
}

/** Ticket ids seen, kept until they expire (single use). */
export class TicketReplayCache {
  private readonly seen = new Map<string, number>();
  constructor(private readonly max = 4096) {}
  /** True the first time; false for an id already used. */
  use(tid: string, exp: number, nowMs: number): boolean {
    for (const [id, until] of this.seen) if (until < nowMs) this.seen.delete(id);
    if (this.seen.has(tid)) return false;
    if (this.seen.size >= this.max) this.seen.delete(this.seen.keys().next().value as string);
    this.seen.set(tid, exp);
    return true;
  }
}

export type TicketCheck = { ok: true; ticket: LanTicket } | { ok: false; reason: "malformed" | "bad_mac" | "expired" | "wrong_host" | "replayed" };

const HEX = (n: number) => new RegExp(`^[0-9a-f]{${n}}$`);
const B64_32 = /^[A-Za-z0-9+/]{43}=$/;

function shapeOk(t: unknown): t is LanTicket {
  if (!t || typeof t !== "object") return false;
  const x = t as Record<string, unknown>;
  const str = (k: string, max = 200) => typeof x[k] === "string" && (x[k] as string).length > 0 && (x[k] as string).length <= max;
  return (
    x.v === 1 && HEX(32).test(String(x.tid)) && str("taskId") && str("subtaskId") && isLanId(x.hostLanId) && str("hostAgentId") && str("requesterAgentId") &&
    B64_32.test(String(x.requesterPub)) && B64_32.test(String(x.hostPub)) && str("model") && Number.isInteger(x.maxTokens) && (x.maxTokens as number) > 0 &&
    (x.temperature === undefined || x.temperature === null || typeof x.temperature === "number") && Number.isInteger(x.timeoutMs) && HEX(64).test(String(x.inputSha256)) &&
    Number.isInteger(x.exp) && HEX(16).test(String(x.nonce)) && HEX(64).test(String(x.mac))
  );
}

/**
 * The host's check: well-formed, MAC under the key of one of its own LAN ids, for this agent,
 * unexpired, and not used before (the id is recorded only when everything else holds).
 */
export function verifyTicket(raw: unknown, opts: { selfAgentId: string; keyFor: (lanId: string) => Buffer | null; nowMs: number; replay: TicketReplayCache }): TicketCheck {
  if (!shapeOk(raw)) return { ok: false, reason: "malformed" };
  const t = raw;
  const key = opts.keyFor(t.hostLanId);
  if (!key) return { ok: false, reason: "wrong_host" };
  const { mac, ...fields } = t;
  const want = createHmac("sha256", ticketMacKey(key)).update(canonicalTicket(fields)).digest();
  if (!timingSafeEqual(want, Buffer.from(mac, "hex"))) return { ok: false, reason: "bad_mac" };
  if (t.hostAgentId !== opts.selfAgentId) return { ok: false, reason: "wrong_host" };
  if (opts.nowMs > t.exp) return { ok: false, reason: "expired" };
  if (!opts.replay.use(t.tid, t.exp, opts.nowMs)) return { ok: false, reason: "replayed" };
  return { ok: true, ticket: t };
}

// ── The call's digest ──

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = stable(x);
    }
    return out;
  }
  return v;
}

/** SHA-256 of a call's messages and tools (keys sorted), as the coordinator and the requester both compute it. */
export function inputDigest(input: { messages: unknown; tools?: unknown }): string {
  const tools = Array.isArray(input.tools) && input.tools.length ? input.tools : null;
  return createHash("sha256").update(JSON.stringify(stable({ messages: input.messages, tools }))).digest("hex");
}

/** SHA-256 of a reply's text (the requester's receipt and the coordinator's stream compare it). */
export function replyDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ── Session crypto ──

export interface SessionKeys {
  /** requester -> host */
  r2h: Buffer;
  /** host -> requester */
  h2r: Buffer;
  aad: Buffer;
}

export function sessionKeys(myPrivateRaw: Buffer, theirPublicRaw: Buffer, tid: string): SessionKeys {
  const shared = x25519SharedSecret(myPrivateRaw, theirPublicRaw);
  const okm = Buffer.from(hkdfSync("sha256", shared, Buffer.from(tid, "hex"), "edgecoder-lan-direct/v1", 64));
  return { r2h: okm.subarray(0, 32), h2r: okm.subarray(32), aad: Buffer.from(tid, "hex") };
}

const DIR_R2H = 1;
const DIR_H2R = 2;

function nonceFor(dir: number, counter: number): Buffer {
  const n = Buffer.alloc(12);
  n.writeUInt32BE(dir, 0);
  n.writeBigUInt64BE(BigInt(counter), 4);
  return n;
}

/** One direction of a session: seals or opens frames in order (a reordered, replayed or forged frame fails). */
export class SessionCipher {
  private counter = 0;
  constructor(private readonly key: Buffer, private readonly dir: number, private readonly aad: Buffer) {}
  seal(obj: unknown): Buffer {
    const nonce = nonceFor(this.dir, this.counter++);
    const c = createCipheriv("aes-256-gcm", this.key, nonce);
    c.setAAD(this.aad);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), "utf8")), c.final()]);
    return Buffer.concat([nonce, ct, c.getAuthTag()]);
  }
  open(frame: Buffer): unknown {
    if (frame.length < 28) throw new Error("short frame");
    const nonce = frame.subarray(0, 12);
    if (!nonce.equals(nonceFor(this.dir, this.counter))) throw new Error("bad nonce");
    const d = createDecipheriv("aes-256-gcm", this.key, nonce);
    d.setAAD(this.aad);
    d.setAuthTag(frame.subarray(frame.length - 16));
    const pt = Buffer.concat([d.update(frame.subarray(12, frame.length - 16)), d.final()]);
    this.counter++;
    return JSON.parse(pt.toString("utf8"));
  }
}

export function hostCiphers(k: SessionKeys): { send: SessionCipher; recv: SessionCipher } {
  return { send: new SessionCipher(k.h2r, DIR_H2R, k.aad), recv: new SessionCipher(k.r2h, DIR_R2H, k.aad) };
}

export function requesterCiphers(k: SessionKeys): { send: SessionCipher; recv: SessionCipher } {
  return { send: new SessionCipher(k.r2h, DIR_R2H, k.aad), recv: new SessionCipher(k.h2r, DIR_H2R, k.aad) };
}

// ── Framing ──

export function frame(body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

/** Splits a byte stream into frames; throws on a frame over `max`. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private max = MAX_FRAME_BYTES) {}
  setMax(max: number): void {
    this.max = max;
  }
  push(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Buffer[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > this.max) throw new Error("frame too large");
      if (this.buf.length < 4 + len) {
        if (this.buf.length > this.max + 4) throw new Error("frame too large");
        break;
      }
      out.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

/** What both ends need of a socket (net.Socket, or a stream pair in tests). */
export interface DuplexLike {
  write(chunk: Buffer): unknown;
  end(): unknown;
  destroy(): unknown;
  on(event: "data", cb: (chunk: Buffer) => void): unknown;
  on(event: "close" | "end", cb: () => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
}

// ── Host ──

export interface DirectRequest {
  messages: unknown[];
  tools?: unknown[];
}

export type DirectPiece =
  | { t: "chunk"; seq: number; delta: string }
  | { t: "done"; toolCalls?: unknown[]; promptTokens?: number; outputTokens?: number; error?: string }
  | { t: "err"; reason: string };

/** A verified call on the host: the ticket, the request, and a way to stream the reply back. */
export interface DirectSession {
  ticket: LanTicket;
  request: DirectRequest;
  remoteAddress: string;
  /** Send a piece to the requester (false once the connection is gone). */
  send(piece: DirectPiece): boolean;
  close(): void;
  /** Called once when the connection closes. */
  onClose(cb: () => void): void;
  readonly closed: boolean;
}

export interface LanDirectHostOptions {
  selfAgentId: string;
  /** The key of one of this agent's current LAN ids (null for anything else). */
  keyFor: (lanId: string) => Buffer | null;
  /** This agent's envelope (X25519) private key, raw. */
  envelopePrivateKey: () => Buffer;
  /** A verified call is ready to run. */
  onSession: (s: DirectSession) => void;
  now?: () => number;
  log?: (event: string, details: Record<string, unknown>) => void;
  maxConnections?: number;
  maxPerSource?: number;
  helloTimeoutMs?: number;
}

/** Counts per source over a minute (hellos). */
class MinuteCounter {
  private readonly m = new Map<string, { n: number; start: number }>();
  over(key: string, limit: number, nowMs: number): boolean {
    const e = this.m.get(key);
    if (!e || nowMs - e.start >= 60_000) {
      if (this.m.size > 1024) this.m.clear();
      this.m.set(key, { n: 1, start: nowMs });
      return false;
    }
    e.n++;
    return e.n > limit;
  }
}

/**
 * The host's listener logic, independent of the socket: give it each accepted connection with
 * the remote address. Only private / link-local sources, LAN_DIRECT_MAX_CONNECTIONS at once and
 * LAN_DIRECT_MAX_PER_SOURCE per address; anything but a valid ticket is closed at once.
 */
export class LanDirectHost {
  private open = 0;
  private readonly perSource = new Map<string, number>();
  private readonly hellos = new MinuteCounter();
  readonly replay = new TicketReplayCache();
  private readonly now: () => number;
  stats = { accepted: 0, refused: 0, badTicket: 0, sessions: 0 };

  constructor(private readonly opts: LanDirectHostOptions) {
    this.now = opts.now ?? Date.now;
  }

  handle(sock: DuplexLike, remoteAddress: string): void {
    const addr = String(remoteAddress ?? "").replace(/^::ffff:/i, "");
    const per = this.perSource.get(addr) ?? 0;
    if (!isLanAddress(addr) || this.open >= (this.opts.maxConnections ?? LAN_DIRECT_MAX_CONNECTIONS) || per >= (this.opts.maxPerSource ?? LAN_DIRECT_MAX_PER_SOURCE) || this.hellos.over(addr, LAN_DIRECT_HELLO_PER_MIN, this.now())) {
      this.stats.refused++;
      sock.destroy();
      return;
    }
    this.stats.accepted++;
    this.open++;
    this.perSource.set(addr, per + 1);
    let released = false;
    const closeCbs: Array<() => void> = [];
    const release = () => {
      if (released) return;
      released = true;
      this.open--;
      const n = (this.perSource.get(addr) ?? 1) - 1;
      if (n <= 0) this.perSource.delete(addr);
      else this.perSource.set(addr, n);
      for (const cb of closeCbs.splice(0)) cb();
    };
    sock.on("close", release);
    sock.on("error", () => {
      sock.destroy();
      release();
    });
    const kill = (why: string) => {
      this.opts.log?.("lan_direct_refused", { reason: why });
      sock.destroy();
      release();
    };
    const helloTimer = setTimeout(() => kill("hello_timeout"), this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    const reader = new FrameReader(MAX_HELLO_BYTES);
    let phase: "hello" | "req" | "run" = "hello";
    let ciphers: { send: SessionCipher; recv: SessionCipher } | null = null;
    let ticket: LanTicket | null = null;
    sock.on("data", (chunk: Buffer) => {
      if (released) return;
      let frames: Buffer[];
      try {
        frames = reader.push(chunk);
      } catch {
        return kill("frame_too_large");
      }
      for (const f of frames) {
        if (phase === "hello") {
          let hello: { t?: unknown; ticket?: unknown };
          try {
            hello = JSON.parse(f.toString("utf8"));
          } catch {
            return kill("bad_hello");
          }
          if (hello?.t !== "hello") return kill("bad_hello");
          const check = verifyTicket(hello.ticket, { selfAgentId: this.opts.selfAgentId, keyFor: this.opts.keyFor, nowMs: this.now(), replay: this.replay });
          if (!check.ok) {
            this.stats.badTicket++;
            return kill(`ticket_${check.reason}`);
          }
          ticket = check.ticket;
          try {
            ciphers = hostCiphers(sessionKeys(this.opts.envelopePrivateKey(), Buffer.from(ticket.requesterPub, "base64"), ticket.tid));
          } catch {
            return kill("key_agreement_failed");
          }
          clearTimeout(helloTimer);
          reader.setMax(MAX_FRAME_BYTES);
          phase = "req";
          sock.write(frame(ciphers.send.seal({ t: "ack" })));
        } else if (phase === "req") {
          let req: { t?: unknown; messages?: unknown; tools?: unknown };
          try {
            req = ciphers!.recv.open(f) as typeof req;
          } catch {
            return kill("bad_frame");
          }
          if (req?.t !== "req" || !Array.isArray(req.messages) || (req.tools !== undefined && !Array.isArray(req.tools))) return kill("bad_request");
          const request: DirectRequest = { messages: req.messages, ...(Array.isArray(req.tools) && req.tools.length ? { tools: req.tools } : {}) };
          if (inputDigest(request) !== ticket!.inputSha256) {
            sock.write(frame(ciphers!.send.seal({ t: "err", reason: "input_mismatch" })));
            sock.end();
            return;
          }
          phase = "run";
          this.stats.sessions++;
          const c = ciphers!;
          const session: DirectSession = {
            ticket: ticket!,
            request,
            remoteAddress: addr,
            get closed() {
              return released;
            },
            send: (piece) => {
              if (released) return false;
              try {
                sock.write(frame(c.send.seal(piece)));
                if (piece.t !== "chunk") sock.end();
                return true;
              } catch {
                return false;
              }
            },
            close: () => {
              sock.destroy();
              release();
            },
            onClose: (cb) => {
              if (released) cb();
              else closeCbs.push(cb);
            },
          };
          this.opts.onSession(session);
        } else {
          // One call per connection: nothing more is read.
          return kill("unexpected_frame");
        }
      }
    });
  }
}

/** Listen on an ephemeral TCP port on every interface (the port is announced only over mDNS). */
export async function listenLanDirect(host: LanDirectHost): Promise<{ port: number; close: () => void }> {
  const net = await import("node:net");
  const server = net.createServer({ allowHalfOpen: false }, (sock) => {
    sock.setNoDelay(true);
    host.handle(sock, sock.remoteAddress ?? "");
  });
  server.maxConnections = LAN_DIRECT_MAX_CONNECTIONS * 2;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", () => undefined);
  const addr = server.address();
  return { port: typeof addr === "object" && addr ? addr.port : 0, close: () => server.close() };
}

// ── Requester ──

export class LanDirectError extends Error {
  constructor(readonly reason: string, readonly phase: "connect" | "stream", readonly receivedSeq = 0) {
    super(`lan direct ${phase}: ${reason}`);
  }
}

/**
 * Run the call over the direct connection; yields the host's pieces. Throws LanDirectError with
 * phase "connect" when no ack came within `connectMs` (the caller reads through the coordinator
 * from the start) or phase "stream" when it broke later (the caller continues from `receivedSeq`).
 */
export async function* directCall(opts: {
  connect: () => DuplexLike;
  ticket: LanTicket;
  requesterPrivateKey: Buffer;
  request: DirectRequest;
  connectMs?: number;
  /** Silence between pieces after which the stream counts as broken. */
  idleMs?: number;
}): AsyncGenerator<DirectPiece> {
  const keys = requesterCiphers(sessionKeys(opts.requesterPrivateKey, Buffer.from(opts.ticket.hostPub, "base64"), opts.ticket.tid));
  const queue: Array<DirectPiece | { t: "_closed" } | { t: "_error"; reason: string }> = [];
  let wake: (() => void) | null = null;
  const push = (x: (typeof queue)[number]) => {
    queue.push(x);
    wake?.();
  };
  let sock: DuplexLike;
  try {
    sock = opts.connect();
  } catch (err) {
    throw new LanDirectError((err as Error).message, "connect");
  }
  const reader = new FrameReader();
  let acked = false;
  sock.on("data", (chunk: Buffer) => {
    try {
      for (const f of reader.push(chunk)) {
        const msg = keys.recv.open(f) as { t?: string };
        if (!acked) {
          if (msg?.t !== "ack") return push({ t: "_error", reason: "no_ack" });
          acked = true;
          // Queued before the request goes out: a host may answer within the write.
          push({ t: "_ack" } as never);
          sock.write(frame(keys.send.seal({ t: "req", ...opts.request })));
          continue;
        }
        push(msg as DirectPiece);
      }
    } catch {
      push({ t: "_error", reason: "bad_frame" });
    }
  });
  sock.on("error", (err) => push({ t: "_error", reason: err.message || "socket_error" }));
  sock.on("close", () => push({ t: "_closed" }));
  sock.on("end", () => push({ t: "_closed" }));
  sock.write(frame(Buffer.from(JSON.stringify({ t: "hello", ticket: opts.ticket }), "utf8")));

  const next = (ms: number) =>
    new Promise<(typeof queue)[number] | null>((resolve) => {
      if (queue.length) return resolve(queue.shift()!);
      const timer = setTimeout(() => {
        wake = null;
        resolve(null);
      }, ms);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve(queue.shift()!);
      };
    });

  let seq = 0;
  try {
    const first = await next(opts.connectMs ?? LAN_DIRECT_CONNECT_MS);
    if (!first || (first as { t: string }).t !== "_ack") throw new LanDirectError(!first ? "timeout" : (first as { reason?: string }).reason ?? "closed", "connect");
    for (;;) {
      const x = await next(opts.idleMs ?? 60_000);
      if (!x) throw new LanDirectError("idle", "stream", seq);
      if (x.t === "_closed") throw new LanDirectError("closed", "stream", seq);
      if (x.t === "_error") throw new LanDirectError((x as { reason: string }).reason, "stream", seq);
      const piece = x as DirectPiece;
      if (piece.t === "err") throw new LanDirectError(piece.reason, seq === 0 ? "connect" : "stream", seq);
      if (piece.t === "chunk") {
        if (piece.seq !== seq || typeof piece.delta !== "string") throw new LanDirectError("out_of_order", "stream", seq);
        seq++;
        yield piece;
        continue;
      }
      if (piece.t === "done") {
        yield piece;
        return;
      }
    }
  } finally {
    sock.destroy();
  }
}
