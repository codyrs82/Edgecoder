// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The coordinator's LAN proximity state (docs/security/lan-proximity.md): the registry of agents'
 * rotating LAN ids and their neighbour reports (src/swarm/lan-registry.ts), what peers share about
 * theirs (mesh-only LocalWorld fields), and direct-transfer tickets (src/swarm/lan-direct.ts).
 */
import { LanRegistry, remoteResolverFrom, type LanRegistration, type LanReport } from "../lan-registry.js";
import { inputDigest, replyDigest, signTicket, type LanTicket } from "../lan-direct.js";
import { CC } from "./context.js";

export const lanRegistry = new LanRegistry();
setInterval(() => lanRegistry.prune(Date.now()), 60_000).unref?.();

/** Direct-transfer tickets are issued (LAN_DIRECT_TICKETS, default on; agents must opt in too). */
export const LAN_DIRECT_TICKETS_ON: boolean = CC.LAN_DIRECT_TICKETS;
/** A host whose direct replies did not match what it reported this often in a day gets no more tickets. */
export const LAN_DIRECT_MISMATCH_LIMIT = 3;
const DAY_MS = 24 * 60 * 60_000;

/** Peers' agents' LAN facts (ids and proofs, raw reports), from their LocalWorld views. */
export interface PeerLanAgent {
  agentId: string;
  coordinatorId: string;
  lanProofs?: Array<{ id: string; p: string[]; w: number }>;
  lanReports?: LanReport[];
}
let peerAgents: PeerLanAgent[] = [];
let peerAgentsAtMs = 0;

/** Called by routes/network-world.ts whenever peer views are fetched. */
export function setPeerLanAgents(list: PeerLanAgent[], nowMs = Date.now()): void {
  peerAgents = list;
  peerAgentsAtMs = nowMs;
}

function freshPeerAgents(nowMs: number): PeerLanAgent[] {
  return nowMs - peerAgentsAtMs <= 5 * 60_000 ? peerAgents : [];
}

/** What a signed heartbeat says about the LAN: this agent's ids and keys, and the neighbours it measured. */
export function noteLanHeartbeat(agentId: string, lan: { ids?: LanRegistration["ids"]; direct?: boolean; neighbours?: LanReport[] }, nowMs = Date.now()): void {
  if (!lan.ids?.length) {
    // Discovery off (or an older agent): forget what was known.
    lanRegistry.forget(agentId);
    return;
  }
  lanRegistry.register(agentId, { ids: lan.ids, direct: lan.direct === true }, nowMs);
  lanRegistry.noteReports(agentId, lan.neighbours ?? [], nowMs);
}

/**
 * Agents on the same LAN as `agentId` (any coordinator, any account) with the best measured round
 * trip: what it reported (resolved here or against peers' proofs) and agents that reported it
 * (here, or on a peer whose agents' reports carry one of its ids with a valid proof).
 */
export function lanNeighboursOf(agentId: string, nowMs = Date.now()): Map<string, number> {
  const peers = freshPeerAgents(nowMs);
  const out = lanRegistry.neighboursOf(agentId, nowMs, peers.length ? remoteResolverFrom(peers) : undefined);
  for (const p of peers) {
    for (const r of p.lanReports ?? []) {
      if (lanRegistry.resolveLocal(r.id, r.p, r.w, nowMs) !== agentId) continue;
      const prev = out.get(p.agentId);
      if (prev === undefined || r.rttMs < prev) out.set(p.agentId, r.rttMs);
    }
  }
  return out;
}

// ── Direct transfer ──

const mismatches = new Map<string, number[]>();

export function noteDirectMismatch(hostAgentId: string, nowMs = Date.now()): number {
  const list = (mismatches.get(hostAgentId) ?? []).filter((t) => nowMs - t < DAY_MS);
  list.push(nowMs);
  mismatches.set(hostAgentId, list);
  return list.length;
}

export function directBarred(hostAgentId: string, nowMs = Date.now()): boolean {
  return (mismatches.get(hostAgentId) ?? []).filter((t) => nowMs - t < DAY_MS).length >= LAN_DIRECT_MISMATCH_LIMIT;
}

interface IssuedTicket {
  tid: string;
  taskId: string;
  hostAgentId: string;
  requesterAgentId: string;
  atMs: number;
  receipt?: { replySha256: string; replyBytes: number; match: boolean };
}
const issued = new Map<string, IssuedTicket>();

/**
 * A ticket for `hostAgentId` to take `subtaskId` directly from `requesterAgentId`, or null when the
 * host has no current LAN key or no envelope key. The digest is of the call as queued here.
 */
export function issueLanTicket(p: {
  taskId: string;
  subtaskId: string;
  hostAgentId: string;
  hostPub: string;
  requesterAgentId: string;
  requesterPub: string;
  model: string;
  input: string;
  timeoutMs: number;
}, nowMs = Date.now()): LanTicket | null {
  const hostLanId = lanRegistry.currentLanId(p.hostAgentId, nowMs);
  const key = hostLanId ? lanRegistry.keyOf(p.hostAgentId, hostLanId, nowMs) : null;
  if (!hostLanId || !key) return null;
  let parsed: { messages?: unknown; tools?: unknown; maxTokens?: unknown; temperature?: unknown };
  try {
    parsed = JSON.parse(p.input);
  } catch {
    return null;
  }
  const ticket = signTicket(
    {
      taskId: p.taskId,
      subtaskId: p.subtaskId,
      hostLanId,
      hostAgentId: p.hostAgentId,
      requesterAgentId: p.requesterAgentId,
      requesterPub: p.requesterPub,
      hostPub: p.hostPub,
      model: p.model,
      maxTokens: typeof parsed.maxTokens === "number" ? parsed.maxTokens : 1024,
      ...(typeof parsed.temperature === "number" ? { temperature: parsed.temperature } : {}),
      timeoutMs: p.timeoutMs,
      inputSha256: inputDigest({ messages: parsed.messages, tools: parsed.tools }),
    },
    key,
    nowMs
  );
  for (const [id, t] of issued) if (nowMs - t.atMs > 30 * 60_000) issued.delete(id);
  issued.set(p.subtaskId, { tid: ticket.tid, taskId: p.taskId, hostAgentId: p.hostAgentId, requesterAgentId: p.requesterAgentId, atMs: nowMs });
  return ticket;
}

export function issuedTicket(subtaskId: string): Readonly<IssuedTicket> | undefined {
  return issued.get(subtaskId);
}

/**
 * The requester's receipt for a direct call: what it received, against the reply the host streamed
 * to this coordinator (which is what is billed). A mismatch is logged and counted against the host.
 */
export function judgeLanReceipt(subtaskId: string, receipt: { replySha256: string; replyBytes: number }, coordinatorReply: string): { match: boolean; hostAgentId: string } | null {
  const t = issued.get(subtaskId);
  if (!t) return null;
  const match = receipt.replySha256 === replyDigest(coordinatorReply) && receipt.replyBytes === Buffer.byteLength(coordinatorReply, "utf8");
  t.receipt = { ...receipt, match };
  return { match, hostAgentId: t.hostAgentId };
}

/** Of `candidates` (holding the model), the nearest LAN neighbour with a free slot, or null. */
export function nearestLanHost(candidates: ReadonlyArray<{ agentId: string; freeSlots: number }>, neighbours: ReadonlyMap<string, number>): { agentId: string; rttMs: number } | null {
  let best: { agentId: string; rttMs: number } | null = null;
  for (const c of candidates) {
    const ms = neighbours.get(c.agentId);
    if (ms === undefined || c.freeSlots <= 0) continue;
    if (!best || ms < best.rttMs || (ms === best.rttMs && c.agentId < best.agentId)) best = { agentId: c.agentId, rttMs: ms };
  }
  return best;
}
