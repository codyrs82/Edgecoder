// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * A requester that goes away cancels its model call (POST /inference/cancel).
 *
 * Before this, a client that disconnected (its stream closed, its session deleted or cancelled)
 * left its network call running: the agent finished the whole reply and the call was billed for it,
 * 1 to 2.5 minutes of work nobody read (2026-11-24 run). The client (network-inference.ts, and so
 * the portal's hosted /v1 and chat, and the IDE) now sends a cancel when it stops reading before the
 * reply ended. The coordinator then:
 *
 * - unclaimed call: takes it off the queue (no agent can claim it), ends the requester's stream and
 *   refunds the whole reserve (nothing ran);
 * - claimed call: marks it cancelled. The agent's next /inference/chunks answer says `cancelled`; an
 *   agent that understands it stops generating and reports what it produced as its result, which is
 *   settled as any call (priced on the tokens and seconds it reports, within the bound on reported
 *   counts; a cost past the reserve comes from the buyer's balance; the
 *   unused reserve comes back). An agent that does not (an older release) keeps going, so when no
 *   result has come within CANCEL_GRACE_MS the call is ended: its claim is closed (later pieces and
 *   the result are refused), nothing is paid and the reserve comes back in full.
 *
 * A cancelled call is never retried on another agent or re-placed (routes/inference.ts
 * retryInferenceElsewhere, lost-agent-claims.ts, auto-replace.ts check requesterCancelled).
 * Idempotent: a second cancel, or one for a call already settled, changes nothing.
 */

import { z } from "zod";
import { app as coordinatorApp, type CoordinatorApp } from "./app.js";
import { readHeaderValue } from "../coordinator-utils.js";
import { hasPortalServiceToken, resolveSubmitterAccount } from "./auth.js";
import { claimedTradePrice, queue, taskBilling } from "./context.js";
import { orderBook } from "./economy.js";
import { refundTaskSubmit } from "./results.js";
import { restrictedCalls } from "./restricted.js";
import { clearClaimDeadline, inferenceStreams } from "./routes/inference.js";

/** How long a cancelled call's agent has to stop and report what it produced before the call is ended unpaid. */
export const CANCEL_GRACE_MS = 15_000;
/** What the requester's stream ends with (a requester that is still reading sees it). */
export const CANCELLED_BY_REQUESTER = "cancelled_by_requester";
const KEEP_MS = 30 * 60_000;

/** subtaskId -> when its requester cancelled it. */
const cancelled = new Map<string, number>();
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** The requester cancelled this call: never retry, re-place or requeue it. */
export function requesterCancelled(subtaskId: string): boolean {
  return cancelled.has(subtaskId);
}

export type CancelOutcome = "cancelled" | "stopping" | "already_done";

/** Cancel one model call for its requester (ownership is checked by the route). */
export async function cancelInferenceCall(taskId: string, subtaskId: string, nowMs = Date.now(), graceMs = CANCEL_GRACE_MS): Promise<CancelOutcome> {
  const claim = queue.getClaim(subtaskId);
  if (!claim || claim.subtask.taskId !== taskId || claim.subtask.kind !== "inference" || inferenceStreams.isDone(subtaskId)) return "already_done";
  if (!cancelled.has(subtaskId)) cancelled.set(subtaskId, nowMs);
  // Nobody holds it: off the queue now (synchronous, so a claim racing this gets it first or not at all).
  if (!claim.claimedBy && queue.markRemoteClaimed(subtaskId)) {
    await endCall(taskId, subtaskId);
    coordinatorApp.log.info({ taskId, subtaskId }, "inference_cancelled_unclaimed");
    return "cancelled";
  }
  if (!graceTimers.has(subtaskId)) {
    const t = setTimeout(() => {
      graceTimers.delete(subtaskId);
      void endIfStillOpen(taskId, subtaskId).catch((err) => coordinatorApp.log.error({ err, subtaskId }, "inference_cancel_end_failed"));
    }, graceMs);
    t.unref?.();
    graceTimers.set(subtaskId, t);
  }
  coordinatorApp.log.info({ taskId, subtaskId, agentId: claim.claimedBy }, "inference_cancel_requested");
  return "stopping";
}

/** The grace ran out with the call still open: end it unpaid and refund the reserve in full. */
export async function endIfStillOpen(taskId: string, subtaskId: string): Promise<boolean> {
  if (!queue.getSubtask(subtaskId) || queue.getResult(subtaskId)) return false;
  await endCall(taskId, subtaskId);
  coordinatorApp.log.warn({ taskId, subtaskId }, "inference_cancelled_agent_did_not_stop");
  return true;
}

async function endCall(taskId: string, subtaskId: string): Promise<void> {
  clearClaimDeadline(subtaskId);
  // A failed result from the coordinator: the subtask leaves the queue, any holder loses its claim.
  queue.complete({ subtaskId, taskId, agentId: "coordinator", ok: false, output: "", error: CANCELLED_BY_REQUESTER, durationMs: 0 });
  inferenceStreams.finish(subtaskId, CANCELLED_BY_REQUESTER);
  restrictedCalls.ended(subtaskId, "failed");
  claimedTradePrice.delete(subtaskId);
  orderBook.removeBid(taskId);
  // Nothing was paid for it: the whole reserve goes back (idempotent, one refund row per task).
  await refundTaskSubmit(taskId);
}

setInterval(() => {
  const cutoff = Date.now() - KEEP_MS;
  for (const [id, at] of cancelled) if (at < cutoff) cancelled.delete(id);
}, 60_000).unref?.();

export function registerInferenceCancelRoute(app: CoordinatorApp): void {
  app.post("/inference/cancel", async (req, reply) => {
    const body = z.object({ taskId: z.string().min(1).max(200), subtaskId: z.string().min(1).max(200) }).parse(req.body);
    const owner = taskBilling.get(body.taskId)?.accountId;
    if (!owner) return reply.send({ ok: true, outcome: "already_done" as CancelOutcome });
    // The portal names the account it acts for (x-edgecoder-account): it must be the call's owner.
    // A signed agent (desktop, IDE, local forwarder) is checked against its owner.
    const headers = ((req as any).headers ?? {}) as Record<string, unknown>;
    const portalNamed = headers["x-portal-service-token"] !== undefined && hasPortalServiceToken(headers) ? readHeaderValue(headers, "x-edgecoder-account") : undefined;
    const caller = await resolveSubmitterAccount(req as any, portalNamed || owner, "/inference/cancel");
    if ("error" in caller || caller.accountId !== owner) return reply.code(403).send({ error: "not_requester" });
    return reply.send({ ok: true, outcome: await cancelInferenceCall(body.taskId, body.subtaskId) });
  });
}

/** Tests. */
export function resetInferenceCancels(): void {
  for (const t of graceTimers.values()) clearTimeout(t);
  graceTimers.clear();
  cancelled.clear();
}
