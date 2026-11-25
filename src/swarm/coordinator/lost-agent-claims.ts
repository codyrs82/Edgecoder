// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * #524: a model call held by an agent that vanished is run elsewhere once, without waiting out the
 * lease.
 *
 * When an agent's authenticated socket closes and nothing is heard from it over HTTP for
 * SOCKET_LOST_CLAIM_GRACE_MS (agent-liveness.ts; a live agent heartbeats every 15 s while it holds
 * a claim, and pulls every 1-3 s while its socket reconnects), the model calls it holds that have
 * streamed nothing to the requester yet are handed to another agent through the same path as an
 * empty reply (routes/inference.ts retryInferenceElsewhere):
 *
 * - once per call (a call already retried is left to its lease, as before);
 * - only when another live agent holds the model and the request has time left;
 * - the reserve stays with the call and is settled by the retry's result, or refunded in full by
 *   the no-capacity bound when nobody takes it; nothing is charged or paid for the lost run;
 * - the lost holder may not claim it again, and its late chunks and result are refused (it is
 *   recorded like a holder whose lease expired), so the call can never be paid twice.
 *
 * A call that already streamed part of its reply keeps today's behaviour: at lease expiry it ends
 * with agent_lost_mid_reply and a full refund (a second agent would splice a new reply onto it).
 * Nothing else happens when no other agent could take the call: the lease expires as before and
 * the call is requeued, then refunded by the no-capacity bound if nobody comes.
 */

import { queue } from "./context.js";
import { app } from "./app.js";
import { agentsLostFor, SOCKET_LOST_CLAIM_GRACE_MS } from "./agent-liveness.js";
import { noteAgentLapse } from "./memory-admission.js";
import { inferenceStreams, retryInferenceElsewhere } from "./routes/inference.js";

/** How often the coordinator looks for calls held by lost agents. */
export const LOST_AGENT_SWEEP_MS = 5_000;

/** Hand the unstarted model calls of agents lost for the grace period to other agents. Returns their subtask ids. */
export async function requeueLostAgentClaims(nowMs = Date.now(), graceMs = SOCKET_LOST_CLAIM_GRACE_MS): Promise<string[]> {
  const lost = new Set(agentsLostFor(graceMs, nowMs));
  if (lost.size === 0) return [];
  const moved: string[] = [];
  for (const call of queue.inferenceCalls()) {
    const holder = call.claimedBy;
    if (!holder || !lost.has(holder)) continue;
    // Part of the reply already reached the requester: left to the lease (agent_lost_mid_reply).
    if (inferenceStreams.hasContent(call.subtaskId)) continue;
    const subtask = queue.getSubtask(call.subtaskId);
    if (!subtask) continue;
    if (!(await retryInferenceElsewhere(subtask, holder, "agent_socket_lost", nowMs))) continue;
    // A lost holder is a timeout for its circuit breaker, as a lapsed lease would have been (its
    // calls moved together count once).
    noteAgentLapse(holder, nowMs);
    moved.push(call.subtaskId);
    app.log.warn({ taskId: subtask.taskId, subtaskId: subtask.id, agentId: holder }, "inference_requeued_from_lost_agent");
  }
  return moved;
}

let timer: ReturnType<typeof setInterval> | undefined;
export function startLostAgentSweep(): void {
  if (timer) return;
  timer = setInterval(() => {
    void requeueLostAgentClaims().catch((err) => app.log.error({ err }, "lost_agent_sweep_failed"));
  }, LOST_AGENT_SWEEP_MS);
  timer.unref?.();
}
