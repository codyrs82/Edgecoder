// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Execution grants between coordinators (src/swarm/remote-grants.ts): a subtask offered to peers is
 * run by one coordinator only, and a peer pays its agent only what the origin charged for it.
 */
import type { MeshPeerIdentity, Subtask } from "../../common/types.js";
import { agentMayClaim } from "../sandbox-enforcement.js";
import { remoteGrantTtlMs, type GrantDecision } from "../remote-grants.js";
import { app } from "./app.js";
import {
  peerMayTakeBilledWork,
  queue,
  protocol,
  identity,
  coordinatorKeys,
  mesh,
  remoteGrants,
  peerGrants,
  offeredToPeers,
  taskOriginMap,
  peerOfferBudgetMsat,
  PEER_OFFER_BUDGET_MAX_ENTRIES,
  LEASE_CONFIG
} from "./context.js";
import { agentCapabilities } from "./agent-state.js";
import { offerSubtaskToPeers, taskOpenCount } from "./results.js";
import { orderBook, MARKET_DEFAULT_BID_PREMIUM_BPS } from "./economy.js";
import { capabilityConstraints } from "../../economy/order-book.js";
import type { ComputeClassId } from "../../economy/compute-classes.js";

/** Most a peer may hold a grant, whatever it is told: the longest subtask plus the slack. */
const MAX_PEER_GRANT_TTL_MS = remoteGrantTtlMs(LEASE_CONFIG.maxTimeoutMs, LEASE_CONFIG.maxTimeoutMs);
/** Agents count as live for offers when seen this recently. */
const LIVE_AGENT_WINDOW_MS = 30_000;

/**
 * Origin side: `peerId` asks to run `subtaskId`. Granted when this coordinator offered it and its own
 * copy is still queued and unclaimed (the copy leaves the queue, so no local agent can run it too),
 * or when the same peer already holds the grant. Anything else is refused.
 */
export function grantSubtaskToPeer(subtaskId: string, peerId: string, nowMs = Date.now()): GrantDecision {
  // Registry-only peers (not in MESH_PEER_ALLOWLIST) peer and gossip, but take no billed work yet.
  if (!peerMayTakeBilledWork(peerId)) return { granted: false, reason: "peer_not_billable" };
  const again = remoteGrants.regrant(subtaskId, peerId, nowMs);
  if (again) return again;
  const offeredUntil = offeredToPeers.get(subtaskId);
  if (offeredUntil === undefined || offeredUntil <= nowMs) return { granted: false, reason: "not_offered" };
  const claim = queue.getClaim(subtaskId);
  if (!claim) return { granted: false, reason: "not_queued" };
  if (claim.claimedBy) return { granted: false, reason: "claimed_locally" };
  if (!queue.markRemoteClaimed(subtaskId)) return { granted: false, reason: "not_queued" };
  const ttlMs = remoteGrantTtlMs(claim.subtask.timeoutMs, LEASE_CONFIG.maxTimeoutMs);
  remoteGrants.grant(claim.subtask, peerId, nowMs, ttlMs);
  app.log.info({ subtaskId, taskId: claim.subtask.taskId, peerId, ttlMs }, "task_granted_to_peer");
  return { granted: true, ttlMs };
}

/** Is there a live local agent that could run `subtask`? */
export function hasLiveAgentFor(subtask: { kind: string }, nowMs = Date.now()): boolean {
  for (const cap of agentCapabilities.values()) {
    if (cap.lastSeenMs > nowMs - LIVE_AGENT_WINDOW_MS && agentMayClaim(cap, subtask)) return true;
  }
  return false;
}

/**
 * Peer side: ask the origin for a subtask it offered and queue it here only once granted. Until
 * then no agent here can claim it, so it never runs on two coordinators. `budgetMsat` is the most an
 * agent here may be paid for it (the origin's answer to the forwarded result caps it again).
 */
export async function requestOfferGrant(
  origin: MeshPeerIdentity,
  subtask: Subtask,
  budgetMsat: number,
  bid?: { computeClass: ComputeClassId | "any"; maxMsatPerCredit?: number; premiumBps?: number }
): Promise<boolean> {
  if (peerGrants.has(subtask.id) || queue.getSubtask(subtask.id)) return false;
  const claimMsg = protocol.createMessage(
    "task_claim",
    identity.peerId,
    { subtaskId: subtask.id, taskId: subtask.taskId, claimedByCoordinator: identity.peerId },
    coordinatorKeys.privateKeyPem
  );
  const res = await mesh.send(origin.peerId, claimMsg);
  const granted = res !== null && res.statusCode >= 200 && res.statusCode < 300 && res.body?.granted === true;
  if (!granted) {
    app.log.info({ subtaskId: subtask.id, origin: origin.peerId, status: res?.statusCode, reason: res?.body?.reason ?? res?.body?.error }, "task_offer_not_granted");
    return false;
  }
  const ttl = Number(res!.body?.grantTtlMs);
  const ttlMs = Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, MAX_PEER_GRANT_TTL_MS) : 0;
  if (ttlMs <= 0) return false;
  if (peerGrants.has(subtask.id) || queue.getSubtask(subtask.id)) return false;
  peerGrants.set(subtask.id, { originId: origin.peerId, deadlineMs: Date.now() + ttlMs });
  if (peerOfferBudgetMsat.size >= PEER_OFFER_BUDGET_MAX_ENTRIES) peerOfferBudgetMsat.delete(peerOfferBudgetMsat.keys().next().value as string);
  peerOfferBudgetMsat.set(subtask.id, budgetMsat);
  // Results go back to the origin peer's pinned URL from the peer table.
  taskOriginMap.set(subtask.id, { coordinatorId: origin.peerId, coordinatorUrl: origin.coordinatorUrl });
  // The requester's bid, in our book: /pull lets only agents within its class, ceiling and
  // capability constraints claim (OrderBook.canMatch), as at the origin.
  if (bid && !orderBook.bidFor(subtask.taskId)) {
    orderBook.postBid(subtask.taskId, bid.computeClass, bid.maxMsatPerCredit, bid.premiumBps ?? MARKET_DEFAULT_BID_PREMIUM_BPS, Date.now(), capabilityConstraints(subtask.projectMeta));
  }
  queue.enqueueSubtask(subtask);
  app.log.info({ subtaskId: subtask.id, from: origin.peerId, ttlMs }, "task_offer_granted");
  return true;
}

/** Peer side: may a local agent still take this granted subtask (enough of the grant left to run it)? */
export function peerGrantAllowsClaim(subtask: Subtask, nowMs = Date.now()): boolean {
  const g = peerGrants.get(subtask.id);
  if (!g) return true;
  const timeout = Number.isFinite(subtask.timeoutMs) && subtask.timeoutMs > 0 ? Math.min(subtask.timeoutMs, LEASE_CONFIG.maxTimeoutMs) : LEASE_CONFIG.maxTimeoutMs;
  return nowMs + timeout <= g.deadlineMs;
}

/** Drop the local bookkeeping of a peer-offered subtask (it left our queue without a result). */
function forgetPeerOffered(subtaskId: string, taskId: string): void {
  if (taskOpenCount(taskId) === 0) orderBook.removeBid(taskId);
  peerGrants.delete(subtaskId);
  peerOfferBudgetMsat.delete(subtaskId);
  taskOriginMap.delete(subtaskId);
}

/**
 * Periodic: (origin) grants whose result never came back go back on the local queue and are offered
 * again; a late result from the expired grant is refused. (Peer) granted subtasks no local agent took
 * in time are dropped.
 */
export function sweepGrants(nowMs = Date.now()): { requeued: number; dropped: number } {
  let requeued = 0;
  for (const g of remoteGrants.expire(nowMs)) {
    app.log.warn({ subtaskId: g.subtask.id, taskId: g.subtask.taskId, peerId: g.peerId }, "remote_grant_expired_requeued");
    const hasPeers = mesh.listPeers().length > 0;
    queue.enqueueSubtask(g.subtask, hasPeers ? { claimDelayMs: 3_000 } : undefined);
    if (hasPeers) offerSubtaskToPeers(g.subtask);
    requeued++;
  }
  let dropped = 0;
  for (const [subtaskId, g] of peerGrants) {
    const claim = queue.getClaim(subtaskId);
    if (!claim) {
      if (!taskOriginMap.has(subtaskId)) peerGrants.delete(subtaskId);
      continue;
    }
    if (claim.claimedBy || peerGrantAllowsClaim(claim.subtask, nowMs)) continue;
    if (queue.markRemoteClaimed(subtaskId)) {
      forgetPeerOffered(subtaskId, claim.subtask.taskId);
      dropped++;
      app.log.warn({ subtaskId, origin: g.originId }, "peer_grant_lapsed_dropped");
    }
  }
  return { requeued, dropped };
}
