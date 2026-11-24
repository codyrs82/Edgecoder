// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Inference routes: model list, submit, chunk upload and streaming.
 */
import { nwcSpotBuyer, nwcTally } from "../direct-payments.js";
import { z } from "zod";
import type { ResourceClass, Subtask } from "../../../common/types.js";
import { DuplicateDebitError, rewardAccountForAgent, spendCredits, taskReserveKey } from "../../../credits/store.js";
import { cSatsPerMTokens, msatToCSats, ratePerSecondMsat } from "../../../economy/job-pricing.js";
import { modelTokenPrice } from "../../../economy/cloud-pricing.js";
import { cloudModelSpec } from "../../../cloud-host/catalog.js";
import { paramsB } from "../../../inference-api/auto-route.js";
import { contextNeeded } from "../../../inference-api/ollama.js";
import type { ChatMessage } from "../../../inference-api/types.js";
import { agentContextWindow, agentLoadReport, freeModelSlots, preferAgent } from "../dispatch.js";
import { agentUnavailable, memoryAdmits, modelLoadedOn } from "../memory-admission.js";
import { AUTO_MODEL_ID } from "../../../inference-api/auto-route.js";
import { cleanHints, describeJob, type JobDescriptor } from "../../../inference-api/job-descriptor.js";
import type { BestFitResult } from "../best-fit.js";
import { agentRttMs, bestFitConfig, complexityWeights, coordinatorLoadSignals, recordDecision, recordPlacement, resolveAuto, routingSummary, type RoutingSummary } from "../routing.js";
import { sanitizeCoordinatorChoice } from "../../../common/coordinator-choice.js";
import { InferenceStreams, boundTokenCounts, maxTokensOf } from "../../inference-streams.js";
import { DegenerateReplyTracker, billableFraction, detectDegenerateOutput, type DegeneracyVerdict } from "../../inference-degeneracy.js";
import { pgStore } from "../../../db/store.js";
import {
  ACCEPTED_COMPUTE_CLASS_IDS,
  capacityGap,
  resolveRequestedClass,
  type ComputeClassId
} from "../../../economy/compute-classes.js";
import { syncReservations } from "../../../economy/reservations.js";
import { agentHasModel, agentHasModelForOwner, routableModels } from "../../model-catalog.js";
import { agentsReportingInstalled } from "../model-control.js";
import { rawBodyOf } from "../../../security/request-signing.js";
import { app as coordinatorApp, type CoordinatorApp } from "../app.js";
import { CC, FALLBACK_BTC_USD, claimedTradePrice, reservations, taskBilling, settledBilling, usagePending, queue, identity, securityLog, requestOrigin } from "../context.js";
import { pickSameNetworkAgent } from "../../lan-proximity.js";
import { mutable } from "../mutable-state.js";
import { agentCapabilities, activeBlacklistRecord, autoBlacklister } from "../agent-state.js";
import { agentSignatureAtGate, hasPortalServiceToken, resolveSubmitterAccount, verifyAgentRequest } from "../auth.js";
import { readHeaderValue } from "../../coordinator-utils.js";
import {
  RESTRICTED_LOG_PROMPTS,
  accountHoldsTier,
  admitRestrictedCall,
  agentMayHostTier,
  restrictedCalls,
  restrictedCatalog,
  restrictedSubmitGate,
  setRestrictedCanceller
} from "../restricted.js";
import {
  effectiveHardware,
  rateOracleConfig,
  classRefMsatPerCredit,
  inferenceCallReserve,
  orderBook,
  MARKET_DEFAULT_BID_PREMIUM_BPS
} from "../economy.js";
import { registerRestrictedRoutes } from "./restricted.js";
import { servedBy } from "../served-by-route.js";
import { isFrontierModelId } from "../../../inference-api/frontier-models.js";
import { taskIdInUse, accrualsInFlight, settleTaskIfDone, refundTaskSubmit } from "../results.js";
import { recordMeshWork } from "../world-activity.js";

// ── Network inference (chat completions on agents' local models, streamed) ──────────────────
export const inferenceStreams = new InferenceStreams();
setInterval(() => inferenceStreams.prune(), 60_000).unref?.();
const INFERENCE_MAX_TIMEOUT_MS = 300_000;
/** Output cap for a call that sets none (INFERENCE_DEFAULT_MAX_TOKENS). */
export const INFERENCE_DEFAULT_MAX_TOKENS = CC.INFERENCE_DEFAULT_MAX_TOKENS;
/** Which agents' recent replies were degenerate (token padding); a pattern is a behaviour strike. */
export const degenerateReplies = new DegenerateReplyTracker();

/**
 * A successful model call is about to be paid: judge the reply the requester got (this
 * coordinator's own copy of the stream) and bill only its clean prefix (inference-degeneracy.ts).
 * The output tokens and the measured duration the call is priced on are cut to the clean share,
 * so the per-token price and the per-second power floor both stop at the point the reply turned
 * degenerate; what is not charged goes back to the requester when the task settles. A pattern of
 * degenerate replies from one agent is a behaviour strike. Returns the verdict, and the duration
 * to price the call on.
 */
export function judgeInferenceReply(
  subtask: Subtask,
  agentId: string,
  output: string,
  durationMs: number,
  nowMs = Date.now()
): { verdict: DegeneracyVerdict; durationMs: number; fraction: number } {
  const text = inferenceStreams.replyText(subtask.id) ?? output;
  const verdict = detectDegenerateOutput(text);
  const seen = degenerateReplies.record(agentId, verdict.degenerate, nowMs);
  if (!verdict.degenerate) return { verdict, durationMs, fraction: 1 };
  const fraction = billableFraction(text, verdict.cleanChars, inferenceStreams.toolCallBytes(subtask.id));
  const cut = (n: number | undefined) => (n === undefined ? undefined : Math.ceil(n * fraction));
  const u = usagePending.get(subtask.taskId);
  const b = taskBilling.get(subtask.taskId);
  const reportedOutputTokens = u?.outputTokens ?? b?.outputTokens;
  if (u) u.outputTokens = cut(u.outputTokens);
  if (b) b.outputTokens = cut(b.outputTokens);
  const billedDurationMs = Math.round(durationMs * fraction);
  securityLog.log({
    level: securityLog.severity("inference_output_degenerate"),
    event: "inference_output_degenerate",
    source: { type: "agent", id: agentId },
    details: {
      taskId: subtask.taskId, subtaskId: subtask.id, model: subtask.requestedModel, reason: verdict.reason, ...verdict.detail,
      totalChars: verdict.totalChars, cleanChars: verdict.cleanChars, billedFraction: Number(fraction.toFixed(4)),
      reportedOutputTokens, billedOutputTokens: cut(reportedOutputTokens), degenerateInWindow: seen.degenerate, repliesInWindow: seen.total,
    },
    action: "degenerate_tail_not_billed",
    coordinatorId: identity.peerId,
  });
  if (seen.strike) {
    autoBlacklister.processAnomalies(agentId, [
      {
        ruleId: "INF001",
        ruleName: "inference_output_degenerate",
        severity: "WARN",
        blacklistReason: "forged_results",
        description: "most of the agent's recent model replies turned into repeated or degenerate text (token padding)",
        stats: { degenerate: seen.degenerate, replies: seen.total, subtaskId: subtask.id, reason: verdict.reason ?? "" },
      },
    ], nowMs);
  }
  return { verdict, durationMs: billedDurationMs, fraction };
}

/**
 * No capacity: a call no agent claimed within INFERENCE_CLAIM_TIMEOUT_MS is cancelled. It is
 * taken off the queue (so no agent can claim it later: it never runs and nobody is paid), its
 * reserve comes back in full, and the requester's next stream read is 503 no_capacity with
 * Retry-After. Kept a while so a reader that comes back late still gets the reason.
 */
export const INFERENCE_CLAIM_TIMEOUT_MS = CC.INFERENCE_CLAIM_TIMEOUT_MS;
export const NO_CAPACITY_RETRY_AFTER_SEC = 15;
const NO_CAPACITY_KEEP_MS = 10 * 60_000;
const noCapacity = new Map<string, { accountId: string; subtaskId: string; atMs: number; reason: "busy" | "none_in_class"; computeClass?: string; model?: string }>();

/** Granted classes of the online, unblacklisted agents that hold `model` (one entry per agent), free of a reservation unless `includeReserved`. */
function holderClasses(model: string, nowMs = Date.now(), includeReserved = false): ComputeClassId[] {
  const out: ComputeClassId[] = [];
  for (const [id, cap] of agentCapabilities) {
    if (!agentHasModel(cap, model) || activeBlacklistRecord(id)) continue;
    if (cap.lastSeenMs !== undefined && nowMs - cap.lastSeenMs > 3 * 60_000) continue;
    if (!includeReserved && reservations.isHeld(id)) continue;
    out.push((effectiveHardware(id, cap)?.computeClass ?? "cpu") as ComputeClassId);
  }
  return out;
}
/**
 * The largest context window among the agents that could take a call, when every one of them is
 * smaller than the call needs (null otherwise, or when none could take it at all). Only agents in
 * the requested class count: a bigger window on another class's machine (an apple Mac holding the
 * same model as the CPU fleet) cannot serve an @cpu call, which would otherwise wait out the claim
 * bound and come back as no_capacity. Agents that report no window take any size.
 */
export function contextTooLong(holders: Array<{ contextWindow?: number; computeClass: string }>, neededTokens: number, taskClass: string): number | null {
  const eligible = taskClass === "any" ? holders : holders.filter((h) => h.computeClass === taskClass);
  if (!eligible.length || !eligible.every((h) => (h.contextWindow ?? Infinity) < neededTokens)) return null;
  return Math.max(...eligible.map((h) => h.contextWindow ?? 0));
}
const claimDeadlines = new Map<string, ReturnType<typeof setTimeout>>();

function pruneNoCapacity(now = Date.now()): void {
  for (const [taskId, c] of noCapacity) if (now - c.atMs > NO_CAPACITY_KEEP_MS) noCapacity.delete(taskId);
}
setInterval(() => pruneNoCapacity(), 60_000).unref?.();

/** True when the call was cancelled for lack of capacity (the stream read answers 503). */
export function inferenceCancelledForCapacity(taskId: string): boolean {
  return noCapacity.has(taskId);
}

/**
 * Cancel an inference subtask nobody has claimed. Returns false (and changes nothing) when an agent
 * holds it: that call runs and is settled as usual. Removal from the queue is synchronous and only
 * of an unclaimed item, so a claim racing the cancel either got it first or finds nothing.
 */
export async function cancelUnclaimedInference(taskId: string, subtaskId: string): Promise<boolean> {
  const timer = claimDeadlines.get(subtaskId);
  if (timer) clearTimeout(timer);
  claimDeadlines.delete(subtaskId);
  if (!queue.markRemoteClaimed(subtaskId)) return false;
  const accountId = taskBilling.get(taskId)?.accountId ?? usagePending.get(taskId)?.accountId ?? "";
  // Say which: every agent of the class was busy, or (now) no agent of the class holds the model.
  const usage = usagePending.get(taskId);
  const gap = usage?.model && usage.computeClass ? capacityGap(usage.computeClass as ComputeClassId, holderClasses(usage.model)) : "busy";
  noCapacity.set(taskId, { accountId, subtaskId, atMs: Date.now(), reason: gap === "none_in_class" ? "none_in_class" : "busy", ...(usage?.computeClass ? { computeClass: usage.computeClass } : {}), ...(usage?.model ? { model: usage.model } : {}) });
  // A failed result from the coordinator (like a lease failure), so the subtask is settled everywhere.
  queue.complete({ subtaskId, taskId, agentId: "coordinator", ok: false, output: "", error: "no_capacity", durationMs: 0 });
  inferenceStreams.finish(subtaskId, "no_capacity");
  restrictedCalls.ended(subtaskId, "no_capacity");
  orderBook.removeBid(taskId);
  // Nothing ran, so nothing was spent: the refund is the whole reserve (refundTaskSubmit is idempotent).
  await refundTaskSubmit(taskId);
  coordinatorApp.log.warn({ taskId, subtaskId, claimTimeoutMs: INFERENCE_CLAIM_TIMEOUT_MS }, "inference_no_capacity_cancelled");
  return true;
}

/** A failed call is given to another agent only with at least this much of its time left. */
export const INFERENCE_RETRY_MIN_LEFT_MS = 15_000;
/** Failures another agent would only repeat (the request itself is bad). */
const NOT_RETRYABLE = /^(bad inference request|no model requested)/;
/** Subtasks already given to another agent once (each call is retried at most once). */
const retriedInference = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 2 * INFERENCE_MAX_TIMEOUT_MS;
  for (const [id, at] of retriedInference) if (at < cutoff) retriedInference.delete(id);
}, 60_000).unref?.();

/**
 * A model call that failed before anything reached the requester (an empty reply, a crashed or
 * missing local model) is given to another agent once, when the request has time left and
 * another agent holds the model. Nothing is charged for the failed run (accrueResultCredits pays
 * successes only); the reserve stays in place for the retry, and the call is settled by the
 * retry's result, or refunded in full by the no-capacity cancel when nobody takes it. Returns true
 * when the subtask went back on the queue (the caller then records no result).
 */
export async function retryInferenceElsewhere(subtask: Subtask, agentId: string, error: string | undefined, nowMs = Date.now()): Promise<boolean> {
  if (subtask.kind !== "inference" || retriedInference.has(subtask.id)) return false;
  if (error && NOT_RETRYABLE.test(error)) return false;
  const submittedAtMs = usagePending.get(subtask.taskId)?.atMs;
  if (submittedAtMs === undefined) return false;
  const leftMs = submittedAtMs + subtask.timeoutMs - nowMs;
  if (leftMs < INFERENCE_RETRY_MIN_LEFT_MS) return false;
  // A reserved call runs only on its lease's agent.
  if (subtask.projectMeta.reservationId) return false;
  const excluded = new Set([agentId, ...queue.excludedAgents(subtask.id)]);
  let other = false;
  for (const [id, cap] of agentCapabilities) {
    // The owner's own call may also go to an owner-only model (kept off the network) on another of their machines.
    const has = subtask.projectMeta.onlyAccountId ? agentHasModelForOwner(cap, subtask.requestedModel) : agentHasModel(cap, subtask.requestedModel ?? "");
    if (excluded.has(id) || activeBlacklistRecord(id) || !has) continue;
    if (nowMs - cap.lastSeenMs > 3 * 60_000) continue;
    if (cap.hostApproved === false && !subtask.projectMeta.onlyAccountId) continue;
    if (subtask.projectMeta.onlyAccountId && (await rewardAccountForAgent(id)) !== subtask.projectMeta.onlyAccountId) continue;
    other = true;
    break;
  }
  if (!other) return false;
  // Only when the requester has nothing yet (the stream starts again for the next agent).
  if (!inferenceStreams.reopenIfEmpty(subtask.id)) return false;
  if (!queue.releaseForRetry(subtask.id, agentId, nowMs)) return false;
  retriedInference.set(subtask.id, nowMs);
  claimedTradePrice.delete(subtask.id);
  // The retry gets the same claim bound as a new call (never past the request's own deadline).
  armClaimDeadline(subtask.taskId, subtask.id, Math.min(INFERENCE_CLAIM_TIMEOUT_MS, leftMs));
  coordinatorApp.log.warn({ taskId: subtask.taskId, subtaskId: subtask.id, agentId, error }, "inference_retry_elsewhere");
  return true;
}

/** Cancel (and refund) the call if nobody claims it within `ms`; replaces an earlier bound. */
function armClaimDeadline(taskId: string, subtaskId: string, ms: number): void {
  const old = claimDeadlines.get(subtaskId);
  if (old) clearTimeout(old);
  const deadline = setTimeout(() => {
    claimDeadlines.delete(subtaskId);
    void cancelUnclaimedInference(taskId, subtaskId).catch((err) => coordinatorApp.log.error({ err, taskId }, "inference_no_capacity_cancel_failed"));
  }, Math.max(0, ms));
  deadline.unref?.();
  claimDeadlines.set(subtaskId, deadline);
}

/**
 * A model call back on the queue after its holder's lease expired (the agent vanished) gets the
 * no-capacity bound again: without it, a call nobody takes kept its reserve until some agent came.
 * Called from the queue's claimable hook; a call with no bound armed and its time used up is
 * cancelled now (refunded in full: nothing was charged for the lost run).
 */
export function onInferenceClaimable(subtask: Subtask, nowMs = Date.now()): void {
  if (subtask.kind !== "inference") return;
  // Back on the queue after part of the reply reached the requester (its holder's lease lapsed, or
  // it went offline): another agent would start the reply again under the text already sent (its
  // first pieces dropped as duplicates, the rest appended: two replies spliced together), so the
  // call ends here with a clear error instead. After this listener returns: the queue is mid-update.
  if (inferenceStreams.hasContent(subtask.id) && !inferenceStreams.isDone(subtask.id)) {
    queueMicrotask(() => void endInferenceLostMidReply(subtask).catch((err) => coordinatorApp.log.error({ err, subtaskId: subtask.id }, "inference_lost_mid_reply_end_failed")));
    return;
  }
  if (claimDeadlines.has(subtask.id)) return;
  const submittedAtMs = usagePending.get(subtask.taskId)?.atMs;
  if (submittedAtMs === undefined) return;
  armClaimDeadline(subtask.taskId, subtask.id, Math.min(INFERENCE_CLAIM_TIMEOUT_MS, submittedAtMs + subtask.timeoutMs - nowMs));
}

/** What the requester is told when the machine running its call vanished after part of the reply. */
export const AGENT_LOST_MID_REPLY = "agent_lost_mid_reply: the machine running this call stopped responding after part of the reply; nothing was charged. Send the request again.";

/**
 * End a model call whose holder was lost after the requester got part of the reply: settled as
 * failed, the requester's stream ends with AGENT_LOST_MID_REPLY, and the reserve is refunded in full
 * (accrueResultCredits pays successes only; the lost holder's later pieces and result are refused,
 * its claim is gone). Does nothing when an agent claimed it again in between.
 */
export async function endInferenceLostMidReply(subtask: Subtask): Promise<boolean> {
  const timer = claimDeadlines.get(subtask.id);
  if (timer) clearTimeout(timer);
  claimDeadlines.delete(subtask.id);
  if (!queue.markRemoteClaimed(subtask.id)) return false;
  queue.complete({ subtaskId: subtask.id, taskId: subtask.taskId, agentId: "coordinator", ok: false, output: "", error: "agent_lost_mid_reply", durationMs: 0 });
  inferenceStreams.finish(subtask.id, AGENT_LOST_MID_REPLY);
  restrictedCalls.ended(subtask.id, "failed");
  claimedTradePrice.delete(subtask.id);
  orderBook.removeBid(subtask.taskId);
  await refundTaskSubmit(subtask.taskId);
  coordinatorApp.log.warn({ taskId: subtask.taskId, subtaskId: subtask.id, replyBytes: inferenceStreams.replyBytes(subtask.id) }, "inference_lost_mid_reply");
  return true;
}

/** Calls that may wait per model: 4 per slot of the (available) agents that hold it, at least 16, at most 512. */
export const WAITING_PER_SLOT = 4;
export function waitingBound(holderIds: string[], nowMs = Date.now()): number {
  let slots = 0;
  for (const id of holderIds) {
    if (agentUnavailable(id, nowMs)) continue;
    slots += agentLoadReport(id)?.slots ?? 1;
  }
  return Math.max(16, Math.min(512, slots * WAITING_PER_SLOT));
}

function noCapacityReply(reply: { code: (n: number) => { header: (k: string, v: string) => { send: (b: unknown) => unknown } } }, c?: { reason: "busy" | "none_in_class"; computeClass?: string; model?: string }) {
  const noneInClass = c?.reason === "none_in_class";
  return reply
    .code(503)
    .header("retry-after", String(NO_CAPACITY_RETRY_AFTER_SEC))
    .send({
      error: "no_capacity",
      reason: c?.reason ?? "busy",
      ...(c?.computeClass ? { computeClass: c.computeClass } : {}),
      message: noneInClass
        ? `No ${c?.computeClass} machine runs ${c?.model ?? "this model"} right now; nothing was charged.`
        : `No agent could take this call within ${Math.round(INFERENCE_CLAIM_TIMEOUT_MS / 1000)} s; nothing was charged.`,
      retryAfterSec: NO_CAPACITY_RETRY_AFTER_SEC,
    });
}

/** Whose /inference/models this is: the account the portal names, or the signing agent's owner. */
async function modelViewerAccount(req: { headers: Record<string, unknown> }): Promise<string | undefined> {
  const h = (req.headers ?? {}) as Record<string, unknown>;
  if (h["x-portal-service-token"] !== undefined && hasPortalServiceToken(h)) return readHeaderValue(h, "x-edgecoder-account") || undefined;
  const agentId = agentSignatureAtGate(h, "GET", "/inference/models");
  if (!agentId) return undefined;
  return (await pgStore?.getAgentOwnership(agentId))?.accountId ?? agentId;
}

/**
 * Security research tier: a suspended or revoked entitlement cancels the call at once, claimed or
 * not. The requester's stream ends with the reason, the subtask is settled as failed (the agent's
 * later chunks and result are refused: it no longer holds a claim), and anything set aside is refunded.
 */
/** Restricted calls cancelled by a suspension: the requester's stream read answers with the reason. */
const restrictedCancelled = new Map<string, { accountId: string; reason: string; atMs: number }>();
setInterval(() => {
  const cutoff = Date.now() - NO_CAPACITY_KEEP_MS;
  for (const [taskId, c] of restrictedCancelled) if (c.atMs < cutoff) restrictedCancelled.delete(taskId);
}, 60_000).unref?.();

setRestrictedCanceller(async (call, reason) => {
  restrictedCancelled.set(call.taskId, { accountId: call.accountId, reason, atMs: Date.now() });
  const timer = claimDeadlines.get(call.subtaskId);
  if (timer) clearTimeout(timer);
  claimDeadlines.delete(call.subtaskId);
  if (queue.getSubtask(call.subtaskId)) {
    queue.complete({ subtaskId: call.subtaskId, taskId: call.taskId, agentId: "coordinator", ok: false, output: "", error: reason, durationMs: 0 });
  }
  inferenceStreams.finish(call.subtaskId, reason);
  orderBook.removeBid(call.taskId);
  await refundTaskSubmit(call.taskId);
  coordinatorApp.log.warn({ taskId: call.taskId, subtaskId: call.subtaskId, agentId: call.agentId, reason }, "restricted_call_cancelled");
});

const inferenceSubmitSchema = z.object({
  taskId: z.string().min(1).max(200),
  submitterAccountId: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  // Ollama chat format: tool calls on assistant turns, tool results as role "tool".
  messages: z
    .array(z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.string().max(400_000), tool_calls: z.array(z.unknown()).max(64).optional(), tool_name: z.string().max(200).optional() }))
    .min(1)
    .max(2000),
  tools: z.array(z.unknown()).max(256).optional(),
  maxTokens: z.number().int().positive().max(32_768).optional(),
  temperature: z.number().min(0).max(2).optional(),
  computeClass: z.enum([...(ACCEPTED_COMPUTE_CLASS_IDS as [string, ...string[]]), "any"]).default("any"),
  maxBidMsatPerCredit: z.number().positive().max(1e9).optional(),
  timeoutMs: z.number().int().min(10_000).max(INFERENCE_MAX_TIMEOUT_MS).default(180_000),
  /** network: any agent, billed per second; mine: only the requester's own machines, not billed. */
  target: z.enum(["network", "mine"]).default("network"),
  /** Run on the agent a reserved-capacity lease holds (the lease pays). */
  reservationId: z.string().min(1).max(100).optional(),
  /** What sent it, for the usage page (a connection, "EdgeCoder chat", ...). */
  source: z.string().max(80).optional(),
  /**
   * model "auto": what the client says about the job (job, quality, maxCSats, latency, needsTools,
   * minContext, complexity, sessionId; src/inference-api/job-descriptor.ts). Malformed fields are dropped.
   */
  routing: z.record(z.string(), z.unknown()).optional(),
  /** model "auto": the caller can resubmit to a peer coordinator when the best fit is there (route_elsewhere). */
  routeRedirect: z.boolean().default(false),
  /** The portal's latency-aware coordinator choice (common/coordinator-choice.ts); kept only from the portal. */
  coordinatorChoice: z.record(z.string(), z.unknown()).optional(),
});

/** Median of the known round trips (ms), null when none is known. */
function medianRtt(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

export function registerInferenceRoutes(app: CoordinatorApp): void {
  // Security research tier: entitlement pushes from the portal and the admin view (routes/restricted.ts).
  registerRestrictedRoutes(app);
  /** Models agents on the network can run now, with how many agents and the price per class. */
  app.get("/inference/models", async (req) => {
    const now = Date.now();
    // Security research tier: a restricted model is listed only to an account entitled to it.
    const viewer = restrictedCatalog.size > 0 ? await modelViewerAccount(req) : undefined;
    const byModel = new Map<string, { agents: number; idle: number; free: number; classes: Set<ComputeClassId>; byClass: Partial<Record<ComputeClassId, number>>; ctx?: number; rtts: number[]; freeRtts: number[] }>();
    const classAgents: Partial<Record<ComputeClassId, Set<string>>> = {};
    const claims = queue.activeClaims();
    for (const [id, cap] of agentCapabilities) {
      if (activeBlacklistRecord(id) || (cap.lastSeenMs !== undefined && now - cap.lastSeenMs > 3 * 60_000)) continue;
      const cls = (effectiveHardware(id, cap)?.computeClass ?? "cpu") as ComputeClassId;
      // #54: only models the agent reported (what it can actually be routed).
      // Host memory (memory-admission.ts): a model the agent can neither load nor has loaded is not
      // capacity, and an agent under memory pressure or with its circuit open has no free slot.
      const held = claims.get(id)?.inference ?? 0;
      const unavailable = agentUnavailable(id, now);
      for (const m of new Set(routableModels(cap))) {
        const tier = restrictedCatalog.tierOf(m);
        if (tier && !accountHoldsTier(viewer, tier, now)) continue;
        if (!memoryAdmits(id, m, held, now) && !modelLoadedOn(id, m, now) && !unavailable) continue;
        const e = byModel.get(m) ?? { agents: 0, idle: 0, free: 0, classes: new Set<ComputeClassId>(), byClass: {}, rtts: [], freeRtts: [] };
        e.agents++;
        e.byClass[cls] = (e.byClass[cls] ?? 0) + 1;
        (classAgents[cls] ??= new Set()).add(id);
        if (queue.agentClaims(id) === 0 && !unavailable) e.idle++;
        const free = unavailable || !memoryAdmits(id, m, held, now) ? 0 : freeModelSlots(id, claims);
        e.free += free;
        // Coordinator <-> agent round trip (the portal adds it to a coordinator's expected latency).
        const rtt = agentRttMs(id);
        if (rtt !== null && Number.isFinite(rtt)) {
          e.rtts.push(rtt);
          if (free > 0) e.freeRtts.push(rtt);
        }
        e.classes.add(cls);
        // The smallest window an agent serves the model with: what a caller can count on (agent loops compact to it).
        const ctx = agentContextWindow(id);
        if (ctx) e.ctx = e.ctx === undefined ? ctx : Math.min(e.ctx, ctx);
        byModel.set(m, e);
      }
    }
    // agents: machines online in the class with a model (the apps' "2 online" and "Available now: …").
    const classes = Object.fromEntries(
      (Object.keys(rateOracleConfig.computeClasses) as ComputeClassId[]).map((c) => [c, { label: rateOracleConfig.computeClasses[c].label, cSatsPerSecondBaseTier: msatToCSats(ratePerSecondMsat(classRefMsatPerCredit(c), 1)), agents: classAgents[c]?.size ?? 0 }])
    );
    return {
      // Model calls are priced per token: cSats per million tokens in and out, by model size.
      models: [...byModel.entries()]
        // idleAgents / freeSlots / waiting: how busy this coordinator is for the model, so the portal can
        // send new calls where a slot is free (inference runs where it was submitted; it is never relayed).
        // freeSlots counts parallel model slots, so two half-busy coordinators still compare by room left.
        .map(([model, e]) => {
          const restricted = restrictedCatalog.tierOf(model);
          // restricted: runs only on your own machines or a lease you hold, never as a network call.
          // agentRttMs: median round trip to the agents with a free slot for it (else to all that hold it).
          const agentRtt = medianRtt(e.freeRtts.length ? e.freeRtts : e.rtts);
          // A cloud model (src/cloud-host/): its cost-plus price, its own context window, and where it
          // comes from (origin: the data for a "no models of origin X" filter) and who serves it.
          const cloud = cloudModelSpec(model);
          const ctx = cloud ? Math.min(e.ctx ?? cloud.contextWindow, cloud.contextWindow) : e.ctx;
          return { model, agents: e.agents, agentsByClass: e.byClass, idleAgents: e.idle, freeSlots: e.free, waiting: queue.waitingInference(model), classes: [...e.classes], cSatsPerMTokens: cSatsPerMTokens(paramsB(model), mutable.latestRateEpoch?.btcUsd ?? FALLBACK_BTC_USD, modelTokenPrice(model)), ...(ctx ? { contextWindow: ctx } : {}), ...(cloud ? { origin: cloud.origin, hostedBy: cloud.provider } : {}), ...(restricted ? { restricted } : {}), ...(agentRtt !== null ? { agentRttMs: agentRtt } : {}) };
        })
        .sort((a, b) => b.agents - a.agents || a.model.localeCompare(b.model)),
      classes,
      // Queueing here, for the portal's latency-aware coordinator choice: pickup p90 and call p50 (ms; null when no recent calls).
      load: coordinatorLoadSignals(),
    };
  });

  app.post("/inference/submit", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const body = inferenceSubmitSchema.parse(req.body);
    // Frontier models run on their owner's own API key in their own IDE provider, never on the network.
    if (isFrontierModelId(body.model)) return reply.code(400).send({ error: "frontier_model_not_routable", message: "frontier/<provider>/<model> runs only on your own key on your own computer; the network never serves it." });
    const submitter = await resolveSubmitterAccount(req as any, body.submitterAccountId, "/inference/submit");
    if ("error" in submitter) return reply.code(submitter.status).send({ error: submitter.error });
    if (submitter.accountId === "anonymous") return reply.code(403).send({ error: "account_required" });
    const accountId = submitter.accountId;
    // The portal's coordinator choice is believed only from the portal (service token).
    const portalChoice = body.coordinatorChoice && hasPortalServiceToken((req as any).headers ?? {}) ? sanitizeCoordinatorChoice(body.coordinatorChoice) : undefined;
    // model "auto": best-fit routing picks the model, the class and a preferred agent (routing.ts).
    let routed: { job: JobDescriptor; result: BestFitResult; summary: RoutingSummary } | undefined;
    if (body.model === AUTO_MODEL_ID) {
      if (body.reservationId || body.target === "mine") return reply.code(400).send({ error: "auto_network_only", detail: "model auto routes network calls; name a model for your own machines or a reservation" });
      const hints = cleanHints(body.routing);
      const job = describeJob({ messages: body.messages as ChatMessage[], tools: body.tools, maxTokens: body.maxTokens }, hints, complexityWeights);
      // A class named on the submit, else in the hints (a bot on "Network GPU only"), limits best fit to it.
      const onlyClass = body.computeClass !== "any" ? body.computeClass : hints.computeClass;
      const { result, elsewhere } = await resolveAuto(job, { peers: body.routeRedirect, requesterAccountId: accountId, ...(onlyClass ? { computeClass: onlyClass } : {}) });
      const summary = routingSummary(job, result);
      if (!result.chosen) {
        // reason: "price" is a money problem (the ceiling is what the caller may spend), not capacity.
        return reply.code(409).send({ error: "no_route_fits", detail: result.rejected ?? result.reason, ...(result.rejectedCode ? { reason: result.rejectedCode } : {}), ...(result.cheapestCSats !== undefined ? { neededCSats: result.cheapestCSats } : {}), ...(onlyClass ? { computeClass: onlyClass } : {}), routing: summary });
      }
      if (elsewhere) recordMeshWork(elsewhere.coordinatorId);
      if (elsewhere) return reply.code(409).send({ error: "route_elsewhere", coordinatorId: elsewhere.coordinatorId, coordinatorUrl: elsewhere.url, routing: summary });
      const chosen = result.chosen;
      body.model = chosen.model;
      body.computeClass = (ACCEPTED_COMPUTE_CLASS_IDS as readonly string[]).includes(chosen.computeClass) ? (chosen.computeClass as typeof body.computeClass) : "any";
      routed = { job, result, summary };
    }
    // Security research tier: a restricted model needs an entitlement and your own or leased machines.
    const gate = await restrictedSubmitGate(accountId, body.model, { target: body.target, reservationId: body.reservationId });
    if (!gate.ok) return reply.code(gate.status).send(gate.body);
    const restrictedTier = gate.tier;
    const holders = [...agentCapabilities.entries()].filter(([id, cap]) => agentHasModel(cap, body.model) && !activeBlacklistRecord(id));
    // Unbilled targets: a lease you already paid for, or your own machines.
    let onlyAccountId: string | undefined;
    let reservationId: string | undefined;
    const ownHolders: string[] = [];
    if (body.reservationId) {
      if (reservations.get(body.reservationId)?.status !== "active") await syncReservations(reservations, pgStore).catch((err) => req.log.warn({ err }, "reservation_sync_failed"));
      const lease = reservations.get(body.reservationId);
      if (!lease || lease.accountId !== accountId || lease.status !== "active" || Date.now() >= lease.endMs) return reply.code(404).send({ error: "reservation_not_active" });
      const cap = agentCapabilities.get(lease.agentId);
      if (!agentHasModel(cap, body.model)) return reply.code(409).send({ error: "reserved_agent_lacks_model", model: body.model, models: cap?.localModelCatalog ?? [] });
      if (restrictedTier && !agentMayHostTier(lease.agentId, restrictedTier, lease.agentAccountId)) return reply.code(409).send({ error: "no_restricted_host", model: body.model, reason: "reserved_agent_not_approved_to_host" });
      reservationId = lease.id;
    } else if (body.target === "mine") {
      let own = 0;
      let approved = 0;
      // Your own machines may also run a model they keep off the network (too big for their memory
      // budget to share): reported apart as ownerModels, routed only for the owning account.
      const ownCandidates = [...agentCapabilities.entries()].filter(([id, cap]) => agentHasModelForOwner(cap, body.model) && !activeBlacklistRecord(id));
      for (const [id] of ownCandidates) {
        if ((await rewardAccountForAgent(id)) !== accountId) continue;
        own++;
        ownHolders.push(id);
        if (restrictedTier && agentMayHostTier(id, restrictedTier, accountId)) approved++;
      }
      if (own === 0) {
        // Installed on one of your machines but not offered to you: it is kept off the network
        // there and that agent predates running such a model for its owner (no ownerModels).
        const localOnlyOn: string[] = [];
        for (const id of agentsReportingInstalled(body.model).slice(0, 20)) {
          const cap = agentCapabilities.get(id);
          if (!cap || agentHasModelForOwner(cap, body.model)) continue;
          if ((await rewardAccountForAgent(id)) === accountId) localOnlyOn.push(id);
        }
        return reply.code(409).send({ error: "no_own_agent_has_model", model: body.model, ...(localOnlyOn.length ? { reason: "local_only", localOnlyOn: localOnlyOn.slice(0, 5) } : {}) });
      }
      if (restrictedTier && approved === 0) return reply.code(409).send({ error: "no_restricted_host", model: body.model, reason: "no_own_agent_approved_to_host" });
      onlyAccountId = accountId;
    } else if (!holders.some(([id]) => !reservations.isHeld(id))) {
      return reply.code(409).send({ error: "no_agent_has_model", model: body.model });
    }
    // Backpressure: network calls wait for a slot up to a bound (waitingBound); past it the
    // caller hears no_capacity at once (nothing reserved or charged) instead of piling more onto
    // the queue every fitting agent is already behind.
    if (!reservationId && !onlyAccountId && queue.waitingInference(body.model) >= waitingBound(holders.map(([id]) => id))) {
      return noCapacityReply(reply as any, { reason: "busy", model: body.model });
    }
    // Every call has an output cap: what an agent can bill for a reply is bounded by it.
    const maxTokens = body.maxTokens ?? INFERENCE_DEFAULT_MAX_TOKENS;
    const needTokens = contextNeeded(body.messages as ChatMessage[], body.tools, maxTokens);
    if (taskIdInUse(body.taskId)) return reply.code(409).send({ error: "duplicate_task", taskId: body.taskId });
    const billed = !reservationId && !onlyAccountId;
    const resolved = resolveRequestedClass(body.computeClass, body.maxBidMsatPerCredit, {}, rateOracleConfig.computeClasses);
    const taskClass = (billed ? resolved.computeClass ?? "any" : "any") as ComputeClassId | "any";
    // Agents hold the model, but none is paid at the requested class (matching is by granted class):
    // say so now instead of waiting out the claim bound and calling every machine "busy".
    if (billed && taskClass !== "any") {
      const classes = holderClasses(body.model);
      if (capacityGap(taskClass, classes) === "none_in_class") {
        return reply.code(409).send({ error: "no_agent_in_class", model: body.model, computeClass: taskClass, availableClasses: [...new Set(classes)].sort() });
      }
    }
    // Every agent that could take the call (holds the model, in the requested class) serves a
    // smaller context window than it needs: say so now rather than wait for the no-capacity bound.
    const largest = contextTooLong(
      holders.map(([id, cap]) => ({ contextWindow: agentContextWindow(id), computeClass: (effectiveHardware(id, cap)?.computeClass ?? "cpu") as string })),
      needTokens,
      taskClass,
    );
    if (largest !== null) {
      return reply.code(413).send({ error: "context_too_long", neededTokens: needTokens, largestContextWindow: largest, model: body.model, ...(taskClass !== "any" ? { computeClass: taskClass } : {}) });
    }
    const resourceClass: ResourceClass = taskClass === "cpu" ? "cpu" : "gpu";
    const input = JSON.stringify({ messages: body.messages, tools: body.tools, maxTokens, temperature: body.temperature });
    // Size-aware reserve (2026-11-16): an upper bound on this call's own cost (its model's token
    // price for its input and output cap, or the class power floor for its timeout, × 1.5), capped
    // by the buyer's maxCSats; was 180 s at the top of the dearest band (~750 cSats) for every call.
    const maxCSats = cleanHints(body.routing).maxCSats ?? routed?.job.maxCSats;
    const sized = billed ? inferenceCallReserve({ model: body.model, taskClass, timeoutMs: body.timeoutMs, inputBytes: Buffer.byteLength(input, "utf8"), maxTokens, ...(maxCSats !== undefined ? { maxCSats } : {}) }) : undefined;
    const reserve = sized?.reserveMsat ?? 0;
    // Optional "pay from your own wallet" (PAYMENTS_NWC): no debit; the reserve bounds the call's
    // cost against the buyer's exposure cap (unsettled tallies), and the cost goes on the tally.
    const nwcSpot = billed && nwcSpotBuyer(accountId);
    if (nwcSpot) {
      const admit = nwcTally.admit(accountId, reserve);
      if (!admit.ok) return reply.code(402).send({ error: admit.error === "settle_first" ? "settle_first" : admit.error === "paused" ? "payments_paused" : "no_wallet", ...(admit.reason ? { reason: admit.reason } : {}), ...(admit.unsettledSats !== undefined ? { unsettledCSats: admit.unsettledSats, capCSats: admit.capSats } : {}) });
    } else if (reserve > 0) {
      // Durable billing (stress finding 2): a restart refunds what this call did not use.
      // The task id's one billing row network-wide: an id billed on the other seed, or by another
      // account or kind, is refused before anything is debited.
      try {
        if (pgStore) {
          const billingRow = await pgStore.insertTaskBilling({ taskId: body.taskId, coordinatorId: identity.peerId, accountId, kind: "inference", perSubtaskReserveMsat: reserve, createdAtMs: Date.now() });
          if (billingRow === "conflict") return reply.code(409).send({ error: "duplicate_task", taskId: body.taskId });
        }
        await spendCredits(accountId, msatToCSats(reserve), "inference_reserve", body.taskId, { idempotencyKey: taskReserveKey(body.taskId) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof DuplicateDebitError) return reply.code(409).send({ error: "duplicate_task", taskId: body.taskId });
        if (message.startsWith("insufficient_credits")) return reply.code(402).send({ error: "insufficient_credits", neededCSats: msatToCSats(reserve) });
        req.log.error({ err, taskId: body.taskId }, "inference_debit_failed");
        return reply.code(500).send({ error: "credit_debit_failed" });
      }
    }
    taskBilling.set(body.taskId, { accountId, reservedMsat: reserve, perSubtaskReserveMsat: reserve, costMsat: 0, refunded: false, submittedAtMs: Date.now(), ...(nwcSpot ? { nwc: true } : {}) });
    usagePending.set(body.taskId, {
      id: body.taskId, accountId, atMs: Date.now(), kind: "inference", placement: reservationId ? "reserved" : onlyAccountId ? "mine" : "network",
      model: body.model, ...(taskClass !== "any" ? { computeClass: taskClass } : {}), ok: false, durationMs: 0, costMsat: 0, ...(body.source ? { source: body.source } : {}),
      ...(routed ? { routing: routed.summary.line.slice(0, 300) } : {}),
    });
    const marketBid = billed ? orderBook.postBid(body.taskId, taskClass, resolved.msatPerCredit, MARKET_DEFAULT_BID_PREMIUM_BPS, Date.now(), {}) : undefined;
    const subtask = queue.enqueueSubtask({
      taskId: body.taskId,
      kind: "inference",
      language: "python",
      input,
      timeoutMs: body.timeoutMs,
      snapshotRef: "inference",
      requestedModel: body.model,
      projectMeta: {
        projectId: `inference:${accountId}`, resourceClass, priority: 60, computeClass: taskClass,
        ...(marketBid ? { maxBidMsatPerCredit: marketBid.maxMsatPerCredit } : {}),
        ...(onlyAccountId ? { onlyAccountId } : {}),
        ...(reservationId ? { reservationId } : {}),
      },
    }, routed ? { excludeAccounts: [accountId] } : undefined);
    if (routed) {
      // A soft preference: the chosen agent gets the call for a moment, then anyone eligible may take it
      // (never the requester's own machines: excludeAccounts above, as in best-fit).
      if (routed.result.chosen?.local) preferAgent(subtask.id, routed.result.chosen.agentId, bestFitConfig.preferMs);
      recordDecision(body.taskId, subtask.id, routed.job, routed.result, Date.now(), portalChoice);
    } else if (portalChoice && billed) {
      // A named model the portal placed here: log which coordinator and why (Network page, routing decisions).
      recordPlacement(body.taskId, subtask.id, { model: body.model, computeClass: taskClass === "any" ? null : taskClass }, portalChoice);
    }
    if (onlyAccountId && !reservationId && !hasPortalServiceToken((req as any).headers ?? {})) {
      // "My machines" from the desktop app: a soft preference for the requester's own machine on the
      // same local network (same public address), so the reply comes from the nearest one. Any own
      // machine may still take it once the preference lapses (src/swarm/lan-proximity.ts).
      const claims = queue.activeClaims();
      const near = pickSameNetworkAgent(
        ownHolders.map((id) => ({ agentId: id, sourceIp: agentCapabilities.get(id)?.sourceIp ?? null, freeSlots: freeModelSlots(id, claims) })),
        requestOrigin(req).clientIp
      );
      if (near) preferAgent(subtask.id, near, bestFitConfig.preferMs);
    }
    if (restrictedTier) {
      admitRestrictedCall({
        subtaskId: subtask.id, taskId: body.taskId, accountId, model: body.model, tier: restrictedTier,
        placement: reservationId ? "reserved" : "mine", ...(reservationId ? { reservationId } : {}),
      });
    }
    inferenceStreams.open(subtask.id, body.taskId);
    armClaimDeadline(body.taskId, subtask.id, INFERENCE_CLAIM_TIMEOUT_MS);
    app.log.info({ taskId: body.taskId, subtaskId: subtask.id, model: body.model, computeClass: taskClass, reserveMsat: reserve, ...(sized ? { reserveTokenMsat: sized.tokenMsat, reserveFloorMsat: sized.floorMsat, reserveCappedByMaxCSats: sized.capped } : {}), holders: holders.length }, "inference_submitted");
    return reply.send({ taskId: body.taskId, subtaskId: subtask.id, model: body.model, reservedCSats: msatToCSats(reserve), billing: reservationId ? "reservation" : onlyAccountId ? "own_machine" : "per_second", ...(routed ? { routing: routed.summary } : {}) });
  });

  app.post("/inference/chunks", async (req, reply) => {
    const verified = await verifyAgentRequest((req as any).headers ?? {}, "/inference/chunks", req.ip, { requireSigned: true, rawBody: rawBodyOf(req) });
    if (!verified || verified === "rejected") return reply.code(401).send({ error: "signature_invalid" });
    const body = z
      .object({
        subtaskId: z.string().min(1), seq: z.number().int().min(0), delta: z.string().max(1_000_000), done: z.boolean().default(false), error: z.string().max(2000).optional(),
        toolCalls: z.array(z.unknown()).max(64).optional(),
        // Token counts from the model, with the last piece. The call is priced on them
        // (accrueResultCredits), so they are bounded below and never cost more than was set aside.
        promptTokens: z.number().int().min(0).max(10_000_000).optional(),
        outputTokens: z.number().int().min(0).max(10_000_000).optional(),
        // Of promptTokens, those a cloud model's provider served from its prompt cache: priced at the
        // cheaper cached-input rate (economy/cloud-pricing.ts). Only ever lowers the price; kept ≤ promptTokens.
        cachedPromptTokens: z.number().int().min(0).max(10_000_000).optional(),
        // The agent's model-load time for this call: left out of the power floor (job-pricing.ts). Only
        // the agent is paid by the floor, so reporting more than it spent only lowers its own pay.
        loadMs: z.number().min(0).max(INFERENCE_MAX_TIMEOUT_MS).optional(),
        // Reading the prompt and writing the reply (Ollama's durations): shown to the requester, never priced.
        promptMs: z.number().min(0).max(INFERENCE_MAX_TIMEOUT_MS).optional(),
        genMs: z.number().min(0).max(INFERENCE_MAX_TIMEOUT_MS).optional(),
      })
      .parse(req.body);
    const claim = queue.getClaim(body.subtaskId);
    if (claim?.claimedBy !== verified.agentId) return reply.code(403).send({ error: "not_claimant" });
    // A holder posting pieces is alive: its lease is renewed like a heartbeat's, so a heartbeat that is
    // late (rate limited, a busy machine) cannot lapse a call while its reply is streaming.
    queue.renewClaim(body.subtaskId, verified.agentId);
    const r = inferenceStreams.append(body.subtaskId, body.seq, body.delta, body.done, body.error, body.toolCalls);
    // Security research tier: the call log records how a restricted call ended (prompts only if configured).
    if (r === "ok" && body.done && restrictedCalls.get(body.subtaskId)) {
      const bounded = boundTokenCounts(body, Buffer.byteLength(claim.subtask.input, "utf8"), inferenceStreams.replyBytes(body.subtaskId) ?? 0, maxTokensOf(claim.subtask.input));
      restrictedCalls.ended(body.subtaskId, body.error ? "failed" : "ok", {
        ...(body.promptTokens !== undefined ? { promptTokens: bounded.promptTokens } : {}),
        ...(body.outputTokens !== undefined ? { outputTokens: bounded.outputTokens } : {}),
        ...(RESTRICTED_LOG_PROMPTS ? { prompt: claim.subtask.input, output: inferenceStreams.replyText(body.subtaskId) ?? "" } : {}),
      });
    }
    // Taken once, from the piece that ended the stream (a refused, repeated or later piece changes
    // nothing), set rather than added, and kept within what the request and the reply could hold.
    if (r === "ok" && body.done && inferenceStreams.isDone(body.subtaskId) && (body.promptTokens !== undefined || body.outputTokens !== undefined)) {
      // A cloud host (allowlisted, the platform's own) relays the provider's billed counts, which
      // include tokens that never reach the reply text (tool calls, a reasoning pass): bounding them
      // by the reply's bytes would price the call below the provider's cost. Its output stays
      // bounded by the call's own max_tokens, which caps the provider's completion tokens too.
      const cloudCall = cloudModelSpec(claim.subtask.requestedModel) !== undefined && effectiveHardware(verified.agentId)?.computeClass === "cloud";
      const replyBytes = cloudCall ? Number.MAX_SAFE_INTEGER : (inferenceStreams.replyBytes(body.subtaskId) ?? 0);
      const bounded = boundTokenCounts(body, Buffer.byteLength(claim.subtask.input, "utf8"), replyBytes, maxTokensOf(claim.subtask.input));
      const u = usagePending.get(claim.subtask.taskId);
      if (u) {
        u.promptTokens = bounded.promptTokens;
        u.outputTokens = bounded.outputTokens;
      }
      // Kept on the billing entry too, which outlives the usage record until the requester reads the result.
      const b = taskBilling.get(claim.subtask.taskId);
      if (b) {
        b.promptTokens = bounded.promptTokens;
        b.outputTokens = bounded.outputTokens;
        if (body.cachedPromptTokens !== undefined) b.cachedPromptTokens = Math.min(body.cachedPromptTokens, bounded.promptTokens ?? 0);
        if (body.loadMs !== undefined) b.loadMs = Math.round(body.loadMs);
      }
    }
    // Where it ran, for the requester's last read (agent, pickup, prompt and generation time).
    if (r === "ok" && body.done) {
      const b = taskBilling.get(claim.subtask.taskId);
      if (b) {
        b.servedAgentId = verified.agentId;
        if (b.submittedAtMs !== undefined && claim.claimedAt !== undefined) b.pickupMs = Math.max(0, claim.claimedAt - b.submittedAtMs);
        if (body.promptMs !== undefined) b.promptMs = Math.round(body.promptMs);
        if (body.genMs !== undefined) b.genMs = Math.round(body.genMs);
      }
    }
    return reply.code(r === "ok" || r === "duplicate" ? 200 : 409).send({ status: r });
  });

  /** The requester reads the reply as it streams (long poll; signed by the requester's own agent). */
  app.post("/inference/stream", async (req, reply) => {
    const body = z.object({ taskId: z.string().min(1), subtaskId: z.string().min(1), after: z.number().int().min(0).default(0), waitMs: z.number().int().min(0).max(25_000).default(15_000) }).parse(req.body);
    // A call whose result already settled it is read from the settled entry (its last poll can land just after).
    const billing = taskBilling.get(body.taskId) ?? settledBilling.get(body.taskId);
    // A call cancelled for lack of capacity was refunded (its billing entry is gone): its owner is kept with the cancellation.
    const owner = billing?.accountId ?? noCapacity.get(body.taskId)?.accountId ?? restrictedCancelled.get(body.taskId)?.accountId;
    const reader = await resolveSubmitterAccount(req as any, owner ?? "", "/inference/stream");
    if ("error" in reader || !owner || reader.accountId !== owner) return reply.code(403).send({ error: "not_requester" });
    // The subtask must be one of this task's: owning a task gives no read of another's stream.
    if (inferenceStreams.taskOf(body.subtaskId) !== body.taskId) return reply.code(404).send({ error: "unknown_stream" });
    if (noCapacity.has(body.taskId)) return noCapacityReply(reply, noCapacity.get(body.taskId));
    const cancelled = restrictedCancelled.get(body.taskId);
    if (cancelled) return reply.code(403).send({ error: cancelled.reason, message: "Security research access for this account was suspended; the call was cancelled." });
    if (!billing) return reply.code(403).send({ error: "not_requester" });
    const r = await inferenceStreams.read(body.subtaskId, body.after, body.waitMs);
    if (!r) return reply.code(404).send({ error: "unknown_stream" });
    // Cancelled while this read waited.
    if (noCapacity.has(body.taskId)) return noCapacityReply(reply, noCapacity.get(body.taskId));
    // The agent's last piece arrives just before its result, which settles the cost: wait for it briefly.
    let result = r.done ? queue.getResult(body.subtaskId) : undefined;
    for (let i = 0; r.done && (!result || accrualsInFlight.has(body.taskId)) && i < 40; i++) {
      await new Promise((res) => setTimeout(res, 100));
      result = queue.getResult(body.subtaskId);
    }
    // The token counts this call was billed on (agent-reported, bounded at /inference/chunks).
    const tokens = {
      ...(billing.promptTokens !== undefined ? { promptTokens: billing.promptTokens } : {}),
      ...(billing.outputTokens !== undefined ? { outputTokens: billing.outputTokens } : {})
    };
    if (result) await settleTaskIfDone(body.taskId);
    const served = r.done && (billing.servedAgentId ?? result?.agentId) ? await servedBy(billing.servedAgentId ?? result!.agentId, owner, billing) : undefined;
    return reply.send({ ...r, ...(result ? { creditsSpent: msatToCSats(billing.refunded ? billing.costMsat : billing.reservedMsat), durationMs: result.durationMs, ...tokens } : {}), ...(served ? { served } : {}) });
  });
}
