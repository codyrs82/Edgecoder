// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * What the Network page's pulses are drawn from (src/swarm/network-world.ts, `activity`): calls each
 * agent took in the last minute, and work and gossip each peer coordinator sent this one in the
 * last minute. Counts only, keyed by agent id or peer id: no account, no request content.
 *
 *   agent calls   a claim of a subtask (queue.onClaimed, wired in routes/network-world.ts)
 *   mesh work     a task offer, claim or result from a peer, and a call this coordinator sent
 *                 elsewhere (route_elsewhere)
 *   mesh gossip   every other verified mesh message from a peer (capability summaries, peer
 *                 exchange, blacklist and ledger updates)
 */
import { RecentEvents } from "../recent-events.js";

export const agentCalls = new RecentEvents(60_000, 5_000, 1_000);
export const meshWork = new RecentEvents(60_000, 64, 2_000);
export const meshGossip = new RecentEvents(60_000, 64, 2_000);

const WORK_TYPES = new Set(["task_offer", "task_claim", "result_announce"]);

/** A verified mesh message from `peerId` (mesh.ts handleMeshIngest). */
export function recordMeshMessage(peerId: string, type: string, nowMs = Date.now()): void {
  (WORK_TYPES.has(type) ? meshWork : meshGossip).record(peerId, nowMs);
}

/** A call this coordinator sent to a peer (route_elsewhere). */
export function recordMeshWork(peerId: string, nowMs = Date.now()): void {
  meshWork.record(peerId, nowMs);
}

setInterval(() => {
  const now = Date.now();
  agentCalls.prune(now);
  meshWork.prune(now);
  meshGossip.prune(now);
}, 60_000).unref?.();
