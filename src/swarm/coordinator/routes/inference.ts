// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Inference routes: model list, submit, chunk upload and streaming.
 */
import { nwcSpotBuyer, nwcTally } from "../direct-payments.js";
import { z } from "zod";
import type { ResourceClass, Subtask } from "../../../common/types.js";
import { DuplicateDebitError, reserveTaskCredits, rewardAccountForAgent, taskReserveKey } from "../../../credits/store.js";
import { cSatsPerMTokens, cSatsToMsat, msatToCSats, ratePerSecondMsat } from "../../../economy/job-pricing.js";
import { modelTokenPrice } from "../../../economy/cloud-pricing.js";
import { cloudModelSpec, isCloudModel, orderCloudModels } from "../../../cloud-host/catalog.js";
import { catalogEntryForTag } from "../../../model/catalog.js";
import { paramsB } from "../../../inference-api/auto-route.js";
import { contextNeeded } from "../../../inference-api/ollama.js";
import type { ChatMessage } from "../../../inference-api/types.js";
import { agentContextWindow, agentLoadReport, claimCandidates, freeModelSlots, preferAgent, preferenceOf, releasePreference, setClaimAdmission } from "../dispatch.js";
import { agentUnavailable, circuitBlocks, circuitOpen, circuitState, memoryAdmits, modelLoadedOn, onCircuitTrip, setCircuitSlotsLookup } from "../memory-admission.js";
import { AUTO_MODEL_ID } from "../../../inference-api/auto-route.js";
import { cleanHints, describeJob, type JobDescriptor } from "../../../inference-api/job-descriptor.js";
import type { BestFitResult } from "../best-fit.js";
import { agentFailRate, agentRegionCode, agentRttMs, bestFitConfig, complexityWeights, coordinatorLoadSignals, localAgentViews, recordDecision, recordPlacement, resolveAuto, routingSummary, type RoutingSummary } from "../routing.js";
import { cleanRegion, clientRegionOf, sanitizeCoordinatorChoice } from "../../../common/coordinator-choice.js";
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
import { CC, FALLBACK_BTC_USD, claimedTradePrice, reservations, taskBilling, settledBilling, usagePending, queue, identity, securityLog, requestOrigin, agentRateLimiter, agentChunkRateLimiter, agentLeaseRateLimiter } from "../context.js";
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
  inferenceCallExpectedMsat,
  inferenceCallReserve,
  orderBook,
  MARKET_DEFAULT_BID_PREMIUM_BPS
} from "../economy.js";
import { registerRestrictedRoutes } from "./restricted.js";
import { servedBy } from "../served-by-route.js";
import { isFrontierModelId } from "../../../inference-api/frontier-models.js";
import { taskIdInUse, pricingInFlight, settleTaskIfDone, refundTaskSubmit, LATE_RESULT_GRACE_MS, reclaimLateInferenceResult } from "../results.js";
import { registerInferenceCancelRoute, requesterCancelled } from "../inference-cancel.js";
import { recordMeshWork } from "../world-activity.js";
import { agentSocketLost, noteAgentHttpAlive } from "../agent-liveness.js";
import { armAutoReplace, autoPlacementOf, cloudOverflowReserveMsat, overrunAlternativeExists, rearmAutoDecision, placeAfterOverrun, replaceAutoNow, setReplaceAdmission, type AutoPlacement } from "../auto-replace.js";
import { freeLocalHolders, LOCALITY_PREFER_MS, LOCALITY_PULL_HOLD_MS, nearestFreeHolder, peerWithFreeCapacity, type PeerFit } from "../locality.js";
import { agentHeldBack, agentStolenRecently, agentWithholding, type ClassCompletion, completionByClass, completionLimitMs, hostServiceMs, hostSpeed, type HostSpeedSource, judgeCompletion, modelPickups, modelSlots, noteHeldCounts, parseCompletionPrior, promptTokenEstimate, serviceTimes, stalledClaimMs, startEtaLimitMs, startEtaMs, withholdingHolders } from "../start-eta.js";
import { expectedOutputTokens, judgedOutputOf, noteJudgedOutput, pruneJudged } from "../expected-output.js";

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
type NoCapacityReason = "busy" | "none_in_class" | "draining" | "cooling_down" | "price";
const noCapacity = new Map<string, { accountId: string; subtaskId: string; atMs: number; reason: NoCapacityReason; computeClass?: string; model?: string; coordinatorUrl?: string; startEtaMs?: number; neededCSats?: number }>();

/** Granted classes of the online, unblacklisted agents that hold `model` (one entry per agent), free of a reservation unless `includeReserved`. */
function holderClasses(model: string, nowMs = Date.now(), includeReserved = false): ComputeClassId[] {
  const out: ComputeClassId[] = [];
  for (const [id, cap] of agentCapabilities) {
    if (!agentHasModel(cap, model) || activeBlacklistRecord(id) || agentSocketLost(id, nowMs)) continue;
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
/** When each armed claim bound runs out (run 6: the waiting sweep judges a call against the time left). */
const claimDeadlineAt = new Map<string, number>();

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
export async function cancelUnclaimedInference(taskId: string, subtaskId: string, draining?: { peerUrl: string | null }, why?: "cooling_down", startEtaMs?: number, price?: { neededCSats: number }): Promise<boolean> {
  const timer = claimDeadlines.get(subtaskId);
  if (timer) clearTimeout(timer);
  claimDeadlines.delete(subtaskId);
  claimDeadlineAt.delete(subtaskId);
  const decision = claimDecisions.get(subtaskId);
  if (decision) clearTimeout(decision);
  claimDecisions.delete(subtaskId);
  if (!queue.markRemoteClaimed(subtaskId)) return false;
  const accountId = taskBilling.get(taskId)?.accountId ?? usagePending.get(taskId)?.accountId ?? "";
  // Say which: every agent of the class was busy, or (now) no agent of the class holds the model.
  const usage = usagePending.get(taskId);
  const gap = usage?.model && usage.computeClass ? capacityGap(usage.computeClass as ComputeClassId, holderClasses(usage.model)) : "busy";
  // Draining: the caller is told so, with a peer to send the call to (it was refunded here in full).
  const reason: NoCapacityReason = draining ? "draining" : why ?? (price ? "price" : gap === "none_in_class" ? "none_in_class" : "busy");
  noCapacity.set(taskId, { accountId, subtaskId, atMs: Date.now(), reason, ...(usage?.computeClass ? { computeClass: usage.computeClass } : {}), ...(usage?.model ? { model: usage.model } : {}), ...(draining?.peerUrl ? { coordinatorUrl: draining.peerUrl } : {}), ...(startEtaMs !== undefined ? { startEtaMs: Math.round(startEtaMs) } : {}), ...(price ? { neededCSats: Math.round(price.neededCSats * 1000) / 1000 } : {}) });
  // A failed result from the coordinator (like a lease failure), so the subtask is settled everywhere.
  queue.complete({ subtaskId, taskId, agentId: "coordinator", ok: false, output: "", error: "no_capacity", durationMs: 0 });
  inferenceStreams.finish(subtaskId, "no_capacity");
  restrictedCalls.ended(subtaskId, "no_capacity");
  orderBook.removeBid(taskId);
  // Nothing ran, so nothing was spent: the refund is the whole reserve (refundTaskSubmit is idempotent).
  await refundTaskSubmit(taskId);
  coordinatorApp.log.warn({ taskId, subtaskId, reason, claimTimeoutMs: INFERENCE_CLAIM_TIMEOUT_MS }, "inference_no_capacity_cancelled");
  return true;
}

/**
 * B4 (network test 2026-11-24: calls sat 45 s behind cloud-fireworks-1's open circuit): an agent that
 * could take `subtask` now or soon, other than those whose circuit blocks them. A busy holder
 * counts (the call waits for its slot as usual).
 */
function usableHolderExists(subtask: Subtask, claims: Map<string, { all: number; inference: number }>, nowMs: number): boolean {
  const model = subtask.requestedModel ?? "";
  const excluded = new Set(queue.excludedAgents(subtask.id));
  for (const [id, cap] of agentCapabilities) {
    if (excluded.has(id) || !agentHasModel(cap, model) || activeBlacklistRecord(id) || agentSocketLost(id, nowMs)) continue;
    if (cap.lastSeenMs !== undefined && nowMs - cap.lastSeenMs > 3 * 60_000) continue;
    if (cap.hostApproved === false || reservations.isHeld(id, nowMs)) continue;
    if (circuitBlocks(id, claims.get(id)?.all ?? 0, nowMs)) continue;
    return true;
  }
  return false;
}

/**
 * B4: `agentId`'s circuit just opened. Its waiting Auto calls are re-placed now (auto-replace.ts),
 * and network calls it could have served that no other agent can take any more are ended now with
 * a retryable no_capacity ("cooling_down", refunded in full) instead of waiting out the claim bound.
 * Calls another holder can take stay queued. Reserved and own-machine calls keep their bound.
 */
export async function moveCallsOffTrippedAgent(agentId: string, nowMs = Date.now()): Promise<{ replaced: number; cancelled: number }> {
  const replaced = await replaceAutoNow(agentId, nowMs);
  const cap = agentCapabilities.get(agentId);
  let cancelled = 0;
  if (!cap) return { replaced, cancelled };
  const claims = queue.activeClaims();
  for (const c of queue.inferenceCalls()) {
    if (c.claimedBy) continue;
    const st = queue.getSubtask(c.subtaskId);
    if (!st?.requestedModel || st.projectMeta.reservationId || st.projectMeta.onlyAccountId) continue;
    // Run 12 (inf-1795660747963-19ae1aba, -1795661418742-13214fc9: Auto calls on the Mac ended
    // "cooling_down" when its circuit opened, while the cloud host was free): an Auto call is not
    // ended here; its decision (auto-replace.ts) moves it, to the cloud overflow if need be, or refuses it.
    if (autoPlacementOf(st.id)) continue;
    if (!agentHasModel(cap, st.requestedModel) || usableHolderExists(st, claims, nowMs)) continue;
    if (await cancelUnclaimedInference(st.taskId, st.id, undefined, "cooling_down").catch(() => false)) cancelled++;
  }
  if (replaced || cancelled) coordinatorApp.log.warn({ agentId, replaced, cancelled }, "circuit_open_calls_moved");
  return { replaced, cancelled };
}

/** Named network calls and the agent they were placed on (#526 locality preference), while unclaimed. */
const namedPlacements = new Map<string, string>();
setInterval(() => {
  for (const id of namedPlacements.keys()) if (queue.getClaim(id)?.claimedBy || !queue.getSubtask(id)) namedPlacements.delete(id);
}, 60_000).unref?.();

/**
 * Run 5 (3a probe, inf-1795598815019-*): a call whose placement was lost waited out the 45 s claim
 * bound and was then refused as "busy". When `agentId` is lost (agent-liveness.ts; swept by
 * lost-agent-claims.ts), its waiting calls are handled now:
 *
 * - Auto calls placed on it are placed again on the next candidate (auto-replace.ts);
 * - a named call placed on it, or one no other live holder could ever take, stays queued only while
 *   another live holder has a free slot for it; otherwise it is ended now with a retryable
 *   no_capacity ("busy"), refunded in full, instead of waiting for the claim bound.
 *
 * Reserved and own-machine calls keep their bound. Returns how many were re-placed and ended.
 */
export async function moveCallsOffLostAgent(agentId: string, nowMs = Date.now()): Promise<{ replaced: number; cancelled: number }> {
  const replaced = await replaceAutoNow(agentId, nowMs);
  const cap = agentCapabilities.get(agentId);
  let cancelled = 0;
  const claims = queue.activeClaims();
  for (const c of queue.inferenceCalls()) {
    if (c.claimedBy) continue;
    const st = queue.getSubtask(c.subtaskId);
    if (!st?.requestedModel || st.projectMeta.reservationId || st.projectMeta.onlyAccountId) continue;
    // Run 12 (inf-1795660747963-19ae1aba, -1795661418742-13214fc9: Auto calls on the Mac ended
    // "cooling_down" when its circuit opened, while the cloud host was free): an Auto call is not
    // ended here; its decision (auto-replace.ts) moves it, to the cloud overflow if need be, or refuses it.
    if (autoPlacementOf(st.id)) continue;
    const placedHere = namedPlacements.get(st.id) === agentId;
    const heldHere = !!cap && agentHasModel(cap, st.requestedModel);
    if (!placedHere && !(heldHere && !usableHolderExists(st, claims, nowMs))) continue;
    const excluded = new Set([agentId, ...queue.excludedAgents(st.id)]);
    const cls = (st.projectMeta.computeClass ?? "any") as ComputeClassId | "any";
    const room = freeLocalHolders(st.requestedModel, cls, inferenceTokensNeededOf(st), nowMs).filter((h) => !excluded.has(h.agentId));
    if (room.length > 0) {
      namedPlacements.delete(st.id);
      continue;
    }
    if (await cancelUnclaimedInference(st.taskId, st.id).catch(() => false)) cancelled++;
  }
  if (replaced || cancelled) coordinatorApp.log.warn({ agentId, replaced, cancelled }, "lost_agent_calls_moved");
  return { replaced, cancelled };
}

/** Tokens a waiting call needs (contextNeeded of its input), 0 when it cannot be read. */
function inferenceTokensNeededOf(st: Subtask): number {
  try {
    const input = JSON.parse(st.input) as { messages?: ChatMessage[]; tools?: unknown[]; maxTokens?: number };
    return Array.isArray(input.messages) ? contextNeeded(input.messages, input.tools, input.maxTokens) : 0;
  } catch {
    return 0;
  }
}

// The breaker's trip threshold scales with the agent's slots, and a trip moves its waiting calls.
setCircuitSlotsLookup((id) => agentLoadReport(id)?.slots);
// Per-agent request budgets grow with the slots it reports too (src/security/agent-rate-limiter.ts).
for (const limiter of [agentRateLimiter, agentChunkRateLimiter, agentLeaseRateLimiter]) limiter.setSlotsLookup((id) => agentLoadReport(id)?.slots);
onCircuitTrip((agentId) => {
  queueMicrotask(() => void moveCallsOffTrippedAgent(agentId).catch((err) => coordinatorApp.log.error({ err, agentId }, "circuit_open_move_failed")));
});

/**
 * #524 (restart under load, 2026-11-24): right after a restart no agent has registered yet (they come
 * back in ~50 s), and a named call was refused at once with no_agent_has_model. For this long after
 * start a call for a catalog model nobody holds yet is accepted and queued instead; its claim bound
 * is stretched to the end of the grace plus the usual bound, and refunds it in full if no agent comes.
 */
const STARTED_AT_MS = Date.now();
export const STARTUP_GRACE_MS = CC.COORDINATOR_STARTUP_GRACE_MS;
export function inStartupGrace(nowMs = Date.now(), startedAtMs = STARTED_AT_MS, graceMs = STARTUP_GRACE_MS): boolean {
  return nowMs - startedAtMs < graceMs;
}
/** Claim bound for a call accepted in the startup grace: until the grace ends, plus the usual bound. */
function startupClaimBoundMs(nowMs = Date.now()): number {
  return Math.max(0, STARTED_AT_MS + STARTUP_GRACE_MS - nowMs) + INFERENCE_CLAIM_TIMEOUT_MS;
}
/**
 * A model an agent could come back with: a catalog or cloud model, or an Ollama-style tag
 * (name:size). Anything else (no agent can ever have it) is refused at once, as before.
 */
function knownModel(model: string): boolean {
  return isCloudModel(model) || catalogEntryForTag(model) !== undefined || /^[a-z0-9][a-z0-9._/-]{0,80}:[a-z0-9][a-z0-9._-]{0,40}$/i.test(model);
}

/**
 * Drain (a deploy or restart): calls nobody claimed cannot run here any more. They are taken off the
 * queue and refunded in full now (the requester's stream answers no_capacity with a short
 * Retry-After, and its client sends the call again), rather than waiting for the next instance to
 * restore and refund them. The stream answer says "draining" and names a peer coordinator, so a
 * client that allows redirects (the portal) sends the call there at once (test 6, 2026-11-24: calls
 * queued on a stopping EU seed came back as "busy" 503s while the US seed had room). Claimed calls
 * are left to finish (their billing is restored if not).
 */
export async function cancelUnclaimedForDrain(peerUrl: string | null = null): Promise<number> {
  let n = 0;
  for (const c of queue.inferenceCalls()) {
    if (c.claimedBy) continue;
    const st = queue.getSubtask(c.subtaskId);
    if (st && (await cancelUnclaimedInference(st.taskId, st.id, { peerUrl }).catch(() => false))) n++;
  }
  return n;
}

/** A failed call is given to another agent only with at least this much of its time left. */
export const INFERENCE_RETRY_MIN_LEFT_MS = 15_000;

/** Each model call's own timeout as submitted (a re-run's subtask carries its re-run budget instead). */
const submittedTimeouts = new Map<string, number>();
setInterval(() => {
  for (const id of submittedTimeouts.keys()) if (!queue.getSubtask(id)) submittedTimeouts.delete(id);
}, 60_000).unref?.();

/**
 * Run 4 (3a): the time a re-run of a model call gets on its next agent, after its agent was lost or
 * failed with nothing sent. A fresh timeout (the run before may have used most of the first), but
 * the call never ends later than submit + its timeout + INFERENCE_RERUN_BUDGET_MS, so re-runs cannot
 * go on forever: min(timeout, that end - now). 0 or less: no time left for a re-run.
 */
export function rerunTimeoutMs(timeoutMs: number, submittedAtMs: number, nowMs = Date.now(), rerunBudgetMs: number = CC.INFERENCE_RERUN_BUDGET_MS): number {
  const endMs = submittedAtMs + timeoutMs + Math.max(0, rerunBudgetMs);
  return Math.min(timeoutMs, endMs - nowMs);
}

/** Give a re-run its own timeout (rerunTimeoutMs): the next agent and its claim lease run on it. */
function startRerunBudget(subtask: Subtask, budgetMs: number): void {
  if (!submittedTimeouts.has(subtask.id)) submittedTimeouts.set(subtask.id, subtask.timeoutMs);
  subtask.timeoutMs = Math.max(INFERENCE_RETRY_MIN_LEFT_MS, Math.round(budgetMs));
}

/** The call's timeout as submitted (before any re-run budget). */
function submittedTimeoutMs(subtask: Subtask): number {
  return submittedTimeouts.get(subtask.id) ?? subtask.timeoutMs;
}
/** #557: the cloud host's reasoning-room overrun (src/cloud-host/backend.ts REASONING_OVERRUN_ERROR): retryable elsewhere. */
export const CLOUD_REASONING_OVERRUN = /^cloud_reasoning_overrun\b/;
/** Failures another agent would only repeat (the request itself is bad, or its max_tokens ends inside the reasoning). */
const NOT_RETRYABLE = /^(bad inference request|no model requested|reasoning_only)/;
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
  if (subtask.kind !== "inference" || retriedInference.has(subtask.id) || requesterCancelled(subtask.id)) return false;
  if (error && NOT_RETRYABLE.test(error)) return false;
  const submittedAtMs = usagePending.get(subtask.taskId)?.atMs;
  if (submittedAtMs === undefined) return false;
  // A run that used up its whole time with nothing sent ("timed out after N s") gets no re-run budget:
  // the call already had its timeout; it is retried only within it, as before.
  const leftMs = rerunTimeoutMs(submittedTimeoutMs(subtask), submittedAtMs, nowMs, error && /^timed out after \d+ s$/.test(error) ? 0 : CC.INFERENCE_RERUN_BUDGET_MS);
  if (leftMs < INFERENCE_RETRY_MIN_LEFT_MS) return false;
  // A reserved call runs only on its lease's agent.
  if (subtask.projectMeta.reservationId) return false;
  const excluded = new Set([agentId, ...queue.excludedAgents(subtask.id)]);
  // #557: the cloud host ran out of reasoning room (nothing sent, nothing charged). An Auto call goes
  // to the next candidate without that host (a non-reasoning model) when one can take it.
  const overrun = !!error && CLOUD_REASONING_OVERRUN.test(error);
  let other = overrun && (await overrunAlternativeExists(subtask.id, agentId, nowMs).catch(() => false));
  for (const [id, cap] of other ? [] : agentCapabilities) {
    // The owner's own call may also go to an owner-only model (kept off the network) on another of their machines.
    const has = subtask.projectMeta.onlyAccountId ? agentHasModelForOwner(cap, subtask.requestedModel) : agentHasModel(cap, subtask.requestedModel ?? "");
    if (excluded.has(id) || activeBlacklistRecord(id) || !has) continue;
    if (nowMs - cap.lastSeenMs > 3 * 60_000 || agentSocketLost(id, nowMs)) continue;
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
  // The retry runs on its own budget, and gets the same claim bound as a new call (never past it).
  startRerunBudget(subtask, leftMs);
  armClaimDeadline(subtask.taskId, subtask.id, Math.min(INFERENCE_CLAIM_TIMEOUT_MS, leftMs));
  if (overrun) await placeAfterOverrun(subtask.id, agentId, nowMs).catch((err) => coordinatorApp.log.error({ err, subtaskId: subtask.id }, "overrun_replace_failed"));
  armRequeueDecision(subtask, nowMs);
  coordinatorApp.log.warn({ taskId: subtask.taskId, subtaskId: subtask.id, agentId, error }, "inference_retry_elsewhere");
  return true;
}

/** Drop the call's no-capacity bound (it is being ended another way: inference-cancel.ts). */
export function clearClaimDeadline(subtaskId: string): void {
  const timer = claimDeadlines.get(subtaskId);
  if (timer) clearTimeout(timer);
  claimDeadlines.delete(subtaskId);
  claimDeadlineAt.delete(subtaskId);
  decisionBoundAt.delete(subtaskId);
}

/** Cancel (and refund) the call if nobody claims it within `ms`; replaces an earlier bound. */
/**
 * Run 9 (CPU ramp: 57 calls refused "none could start this request in time" 6-82 s after submit,
 * p50 6-55 s): a network call waited in the queue on a start estimate and was refused later. Now a
 * call nobody claimed within INFERENCE_CLAIM_DECISION_MS of its submit is decided
 * (decideUnclaimedCall): it keeps waiting only while a host here has a free slot for it (not held
 * back, not excluded from it, and it would finish there), once; otherwise it is refused at once
 * (retryable no_capacity "busy", refunded in full). A claim ends it. Run 10: a call taken back or
 * re-run elsewhere is decided again (armRequeueDecision); one back after a lapsed claim (its holder
 * went quiet; its late result may still come) keeps its bound. Auto calls are re-placed (auto-replace.ts) and reserved, own-machine,
 * startup-grace and peer calls keep their bounds, as before.
 */
export const INFERENCE_CLAIM_DECISION_MS = CC.INFERENCE_CLAIM_DECISION_MS;
const claimDecisions = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Run 14 (4 named refusals at 2.27-2.47 s at the portal, logged at 2.25 s here: decided at 1.5 s
 * with a host "ready" that never came, then a second wait of 0.75 s): the whole decision, the wait
 * for a ready host included, ends within CLAIM_DECISION_BOUND windows (run 14: 1.8 s) of its
 * submit, or of the call being back on the queue. A call sent here by another coordinator
 * (route_elsewhere, `redirected`) spent part of its time there and on the way: its bound is
 * REDIRECT_ALLOWANCE windows shorter (1.5 s), so the portal still answers within 2 s.
 * Run 16 (inf-1795695736422-911d2b62: decided at 1.801 s on the EU coordinator, 2.002 s at the
 * portal; the portal-to-EU hop took ~0.2 s, Fly clients saw up to 2.24 s): 16/15 windows, 1.6 s by
 * default (1.3 s for a redirected call), so the portal answers within 2 s with a ~0.3 s hop.
 */
/** Run 19: a host failing this share of its recent calls (routing.ts agentFailRate) is not listed as a free host for the portal. */
export const FREE_HOST_MAX_FAIL_RATE = 0.5;

export const CLAIM_DECISION_BOUND = 16 / 15;
export const REDIRECT_ALLOWANCE = 0.2;
/** A wait shorter than this is not armed: the call is decided now. */
const MIN_DECISION_WAIT_MS = 50;
const decisionBoundAt = new Map<string, number>();

/**
 * Run 17 (inf-1795701115698-86c8011f: 665 ms, inf-1795701115520-4516c048: 821 ms between the
 * completion estimate and inference_submitted during a burst, the credit reserve's database round
 * trip; 2.17 s and 2.23 s at the portal though the decision kept its 1.5 s / 1.3 s window): the
 * window and the bound run from when this coordinator received the submit (`receivedAtMs`), not
 * from when the call was queued. What the submit itself took comes off the window.
 */
export function armClaimDecision(taskId: string, subtaskId: string, final = false, ms = INFERENCE_CLAIM_DECISION_MS, opts: { redirected?: boolean; receivedAtMs?: number } = {}): void {
  const old = claimDecisions.get(subtaskId);
  if (old) clearTimeout(old);
  claimDecisions.delete(subtaskId);
  if (!final) decisionBoundAt.delete(subtaskId);
  if (!(ms > 0)) return;
  if (!final) {
    const nowMs = Date.now();
    const startMs = Math.min(nowMs, opts.receivedAtMs ?? nowMs);
    const boundMs = Math.round(ms * (CLAIM_DECISION_BOUND - (opts.redirected ? REDIRECT_ALLOWANCE : 0)));
    decisionBoundAt.set(subtaskId, startMs + boundMs);
    ms = Math.max(1, Math.min(ms, boundMs) - (nowMs - startMs));
  }
  const timer = setTimeout(() => {
    claimDecisions.delete(subtaskId);
    void decideUnclaimedCall(taskId, subtaskId, Date.now(), final).catch((err) => coordinatorApp.log.error({ err, taskId }, "inference_claim_decision_failed"));
  }, ms);
  timer.unref?.();
  claimDecisions.set(subtaskId, timer);
}

/**
 * Decide a network call still unclaimed (armClaimDecision): "waiting" while a host here could claim it
 * now (dispatch.ts claimCandidates: free slot, pulling within PULL_FRESH_MS, admitted), once, until
 * its locality hold has ended plus a quarter window (at most one more window); else "ended".
 * Run 10: the free slot is no longer judged from the model's slot count, which counted hosts that
 * reported one free slot long ago and had not pulled since (23 calls refused at exactly 4.0 s in run
 * 10 after waiting on such slots). Each refusal logs the hosts considered and why (inference_unclaimed_refused).
 */
export async function decideUnclaimedCall(taskId: string, subtaskId: string, nowMs = Date.now(), final = false): Promise<"claimed" | "left" | "waiting" | "ended"> {
  const boundAt = decisionBoundAt.get(subtaskId);
  if (!queue.isUnclaimed(subtaskId) || !claimDeadlineAt.has(subtaskId)) {
    decisionBoundAt.delete(subtaskId);
    return "claimed";
  }
  const st = queue.getSubtask(subtaskId);
  if (!st?.requestedModel || st.projectMeta.reservationId || st.projectMeta.onlyAccountId || autoPlacementOf(st.id) || usagePending.get(st.taskId) === undefined) {
    decisionBoundAt.delete(subtaskId);
    return "left";
  }
  const model = st.requestedModel;
  const cls = (st.projectMeta.computeClass ?? "any") as ComputeClassId | "any";
  const exclude = queue.excludedAgents(st.id);
  const { ready, not } = claimCandidates(st, nowMs);
  const pref = preferenceOf(st.id, nowMs);
  const fits = ready.length > 0 && waitingCallFits(st, model, cls, undefined, nowMs, { exclude, waiting: 0 });
  const elapsedMs = nowMs - (usagePending.get(st.taskId)?.atMs ?? nowMs);
  // Run 14: the wait for a ready host ends by the call's decision bound.
  const wait = Math.min(INFERENCE_CLAIM_DECISION_MS, Math.max(Math.round(INFERENCE_CLAIM_DECISION_MS / 2), (pref?.holdLeftMs ?? 0) + Math.round(INFERENCE_CLAIM_DECISION_MS / 4)), boundAt === undefined ? Infinity : boundAt - nowMs);
  if (!final && fits && wait >= MIN_DECISION_WAIT_MS) {
    // Run 14: the nearest host held for it has not taken it within the window; the call ends by its
    // bound, so other ready hosts may take it now rather than wait out the hold.
    const released = !!pref?.holding && ready.some((id) => id !== pref.agentId) && releasePreference(subtaskId, nowMs);
    if (released) coordinatorApp.log.info({ taskId, subtaskId, preferred: pref?.agentId ?? null }, "inference_preference_released");
    armClaimDecision(taskId, subtaskId, true, wait);
    coordinatorApp.log.info({ taskId, subtaskId, model, elapsedMs, waitMs: wait, ready, preferred: pref?.agentId ?? null, preferredHolding: pref?.holding ?? false }, "inference_unclaimed_waiting");
    return "waiting";
  }
  decisionBoundAt.delete(subtaskId);
  const room = modelSlots(model, cls, inferenceTokensNeededOf(st), nowMs, exclude);
  const eta = room.slots > 0 ? startEtaOf(model, cls, Math.max(1, queue.waitingInference(model) - room.free), room.slots, nowMs) : null;
  if (!(await cancelUnclaimedInference(taskId, subtaskId, undefined, undefined, eta?.etaMs).catch(() => false))) return "claimed";
  const reason = ready.length === 0 ? "no_host_can_claim" : !fits ? "would_not_finish" : "not_claimed_in_time";
  coordinatorApp.log.warn({ taskId, subtaskId, model, reason, elapsedMs, final, ready, notReady: not, preferred: pref?.agentId ?? null }, "inference_unclaimed_refused");
  return "ended";
}

/**
 * Run 10 (CPU ramp tail 39-118 s, the three "deepseek busy" Auto calls at ~48 s): a call taken back
 * from its host or re-run elsewhere got only the 45 s claim bound again (armed outside the submit, so
 * no decision window): it waited out that bound. It is now decided again as at submit: a named call
 * by armClaimDecision, an Auto call by its re-placement decision (auto-replace.ts rearmAutoDecision).
 */
function armRequeueDecision(st: Subtask, nowMs = Date.now()): void {
  if (st.projectMeta.reservationId || st.projectMeta.onlyAccountId || usagePending.get(st.taskId) === undefined) return;
  if (autoPlacementOf(st.id)) rearmAutoDecision(st.id, nowMs);
  else armClaimDecision(st.taskId, st.id);
}

function armClaimDeadline(taskId: string, subtaskId: string, ms: number): void {
  const old = claimDeadlines.get(subtaskId);
  if (old) clearTimeout(old);
  claimDeadlineAt.set(subtaskId, Date.now() + Math.max(0, ms));
  const deadline = setTimeout(() => {
    claimDeadlines.delete(subtaskId);
    claimDeadlineAt.delete(subtaskId);
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
    // Run 4: a holder still sending when its claim reached the hard deadline (claim + timeout +
    // grace) ran out its time; it was not lost. The requester is told the call timed out, so a
    // non-streamed reply returns what was sent as a reply cut at the limit (inference-api/routes.ts).
    const lapsed = queue.lapsedClaim(subtask.id);
    const timedOut = lapsed !== undefined && lapsed.atMs - lapsed.claimedAt >= subtask.timeoutMs;
    queueMicrotask(() => void endInferenceLostMidReply(subtask, timedOut ? `timed out after ${Math.round(subtask.timeoutMs / 1000)} s` : undefined).catch((err) => coordinatorApp.log.error({ err, subtaskId: subtask.id }, "inference_lost_mid_reply_end_failed")));
    return;
  }
  const submittedAtMs = usagePending.get(subtask.taskId)?.atMs;
  if (submittedAtMs === undefined) return;
  // Run 4 (3a): a re-run gets a fresh timeout, capped at submit + timeout + INFERENCE_RERUN_BUDGET_MS
  // (it kept the first run's deadline and timed out on the second agent).
  const leftMs = rerunTimeoutMs(submittedTimeoutMs(subtask), submittedAtMs, nowMs);
  if (queue.lapsedClaim(subtask.id) && leftMs >= INFERENCE_RETRY_MIN_LEFT_MS) startRerunBudget(subtask, leftMs);
  if (claimDeadlines.has(subtask.id)) return;
  // Its claim lapsed with no time left for another agent: it waits (off limits to others) for the
  // lapsed holder's late result for LATE_RESULT_GRACE_MS (results.ts), then is cancelled and refunded
  // as before. It was cancelled at once, and a result the host sent just after was never paid.
  if (leftMs < INFERENCE_RETRY_MIN_LEFT_MS && queue.holdForLateResult(subtask.id, nowMs + LATE_RESULT_GRACE_MS)) {
    armClaimDeadline(subtask.taskId, subtask.id, LATE_RESULT_GRACE_MS);
    return;
  }
  armClaimDeadline(subtask.taskId, subtask.id, Math.min(INFERENCE_CLAIM_TIMEOUT_MS, leftMs));
}

/** What the requester is told when the machine running its call vanished after part of the reply. */
export const AGENT_LOST_MID_REPLY = "agent_lost_mid_reply: the machine running this call stopped responding after part of the reply; nothing was charged. Send the request again.";

/**
 * End a model call whose holder was lost after the requester got part of the reply: settled as
 * failed, the requester's stream ends with AGENT_LOST_MID_REPLY, and the reserve is refunded in full
 * (accrueResultCredits pays successes only; the lost holder's later pieces and result are refused,
 * its claim is gone). Does nothing when an agent claimed it again in between. `timedOut`: its holder
 * was still sending when its claim reached the hard deadline; the stream ends with that timeout
 * ("timed out after N s") instead, so a non-streamed reply returns the part it got.
 */
export async function endInferenceLostMidReply(subtask: Subtask, timedOut?: string): Promise<boolean> {
  const timer = claimDeadlines.get(subtask.id);
  if (timer) clearTimeout(timer);
  claimDeadlines.delete(subtask.id);
  claimDeadlineAt.delete(subtask.id);
  if (!queue.markRemoteClaimed(subtask.id)) return false;
  queue.complete({ subtaskId: subtask.id, taskId: subtask.taskId, agentId: "coordinator", ok: false, output: "", error: timedOut ?? "agent_lost_mid_reply", durationMs: 0 });
  inferenceStreams.finish(subtask.id, timedOut ?? AGENT_LOST_MID_REPLY);
  restrictedCalls.ended(subtask.id, "failed");
  claimedTradePrice.delete(subtask.id);
  orderBook.removeBid(subtask.taskId);
  await refundTaskSubmit(subtask.taskId);
  coordinatorApp.log.warn({ taskId: subtask.taskId, subtaskId: subtask.id, replyBytes: inferenceStreams.replyBytes(subtask.id), ...(timedOut ? { timedOut: true } : {}) }, "inference_lost_mid_reply");
  return true;
}

/**
 * Why a model call's reply ended, for the requester's finish_reason (run 5: Flash replies cut at the
 * caller's max_tokens reached the client as "stop"). The agent's word when it sends one; an agent
 * that does not (before this field) reported as many output tokens as the call allowed: cut there.
 */
export function replyFinishReason(body: { finishReason?: "stop" | "length"; outputTokens?: number; error?: string }, maxTokens: number | undefined): "stop" | "length" {
  if (body.finishReason) return body.finishReason;
  return maxTokens !== undefined && body.outputTokens !== undefined && body.outputTokens >= maxTokens ? "length" : "stop";
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

function noCapacityReply(reply: { code: (n: number) => { header: (k: string, v: string) => { send: (b: unknown) => unknown } } }, c?: { reason: NoCapacityReason; computeClass?: string; model?: string; coordinatorUrl?: string; retryAfterSec?: number; startEtaMs?: number; completionEtaMs?: number; limitMs?: number; neededCSats?: number }) {
  const noneInClass = c?.reason === "none_in_class";
  const overPrice = c?.reason === "price";
  const draining = c?.reason === "draining";
  const coolingDown = c?.reason === "cooling_down";
  const retryAfterSec = draining ? 1 : c?.retryAfterSec !== undefined ? c.retryAfterSec : NO_CAPACITY_RETRY_AFTER_SEC;
  return reply
    .code(503)
    .header("retry-after", String(retryAfterSec))
    .send({
      error: "no_capacity",
      reason: c?.reason ?? "busy",
      ...(c?.computeClass ? { computeClass: c.computeClass } : {}),
      ...(c?.coordinatorUrl ? { coordinatorUrl: c.coordinatorUrl } : {}),
      ...(c?.startEtaMs !== undefined ? { startEtaMs: c.startEtaMs } : {}),
      ...(c?.completionEtaMs !== undefined ? { completionEtaMs: c.completionEtaMs } : {}),
      ...(c?.limitMs !== undefined ? { limitMs: c.limitMs } : {}),
      ...(c?.neededCSats !== undefined ? { neededCSats: c.neededCSats } : {}),
      message: overPrice
        ? `No machine within this call's price ceiling could start it in time; a cloud host could, for about ${c?.neededCSats ?? "?"} cSats. Nothing was charged. Send it again with a ceiling that covers that.`
        : draining
        ? "This coordinator is restarting; the call had not started and nothing was charged. Send it again (to the coordinator named, if any)."
        : coolingDown
        ? `The machine serving ${c?.model ?? "this model"} is cooling down after failed calls; nothing was charged. Send it again shortly or pick another model.`
        : noneInClass
        ? `No ${c?.computeClass} machine runs ${c?.model ?? "this model"} right now; nothing was charged.`
        : c?.completionEtaMs !== undefined || c?.limitMs !== undefined
        ? `No machine serving ${c?.model ?? "this model"} here would finish this call within its timeout (${c.completionEtaMs !== undefined ? `about ${Math.round(c.completionEtaMs / 1000)} s expected, ` : ""}${Math.round((c.limitMs ?? 0) / 1000)} s allowed); nothing was charged. Send it again shortly, with a smaller max_tokens, or with a longer timeout.`
        : c?.startEtaMs !== undefined
        ? `Every machine serving ${c?.model ?? "this model"} here is busy (it would start in about ${Math.round(c.startEtaMs / 1000)} s); nothing was charged. Send it again shortly.`
        : `No agent could take this call within ${Math.round(INFERENCE_CLAIM_TIMEOUT_MS / 1000)} s; nothing was charged.`,
      retryAfterSec,
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
  claimDeadlineAt.delete(call.subtaskId);
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
  /**
   * The caller can resubmit to a peer coordinator (route_elsewhere): model "auto" when the best fit
   * is there; a named network model when nothing here has a free slot for it and a peer does (#526).
   */
  routeRedirect: z.boolean().default(false),
  /**
   * Run 6: another coordinator sent this call here (route_elsewhere; backends.ts marks the follow-up).
   * It is judged without exploration and refused at once when it would not finish in time.
   */
  redirected: z.boolean().default(false),
  /** Where the buyer is (a Fly region, or "cc-<country>"): free agents near it are preferred (#526). */
  clientRegion: z.string().max(40).optional(),
  /** The portal's latency-aware coordinator choice (common/coordinator-choice.ts); kept only from the portal. */
  coordinatorChoice: z.record(z.string(), z.unknown()).optional(),
});

/** The class a named call is placed in (as resolveRequestedClass does for a class name), for locality and redirects. */
function namedClass(requested: string): ComputeClassId | "any" {
  return (resolveRequestedClass(requested, undefined, {}, rateOracleConfig.computeClasses).computeClass ?? "any") as ComputeClassId | "any";
}
const sumFree = (hs: ReadonlyArray<{ free: number }>) => hs.reduce((n, h) => n + h.free, 0);

/**
 * C9: the call's estimated start here (start-eta.ts) when it is past the limit for its timeout,
 * else null (a slot is left, too few service times are known, or the check is off).
 */
function startEtaOverLimit(model: string, taskClass: ComputeClassId | "any", neededTokens: number, timeoutMs: number, nowMs = Date.now()): { etaMs: number; limitMs: number; waiting: number; slots: number; free: number; typicalMs: number | null; pickupEtaMs: number | null } | null {
  const limitMs = startEtaLimitMs(timeoutMs, CC.INFERENCE_START_ETA_FRACTION, INFERENCE_CLAIM_TIMEOUT_MS);
  if (!Number.isFinite(limitMs)) return null;
  const { slots, free } = modelSlots(model, taskClass, neededTokens, nowMs);
  const waiting = queue.waitingInference(model);
  if (free > waiting) return null;
  // Run 7: every holder of the model withholds its slots (a throttled CPU, #563): nothing here will
  // take the call for a while (the agent's hold is minutes), so it does not start within its timeout.
  if (slots <= 0 && withholdingHolders(model, nowMs).length > 0) return { etaMs: timeoutMs, limitMs: Math.round(limitMs), waiting, slots, free, typicalMs: null, pickupEtaMs: null };
  const etaMs = startEtaOf(model, taskClass, waiting - free + 1, slots, nowMs);
  return etaMs !== null && etaMs.etaMs > limitMs ? { ...etaMs, limitMs: Math.round(limitMs), waiting, slots, free } : null;
}

/**
 * When a call with `ahead` calls before it (itself included) on a saturated model would start: the
 * later of the median-service estimate (C9) and, run 6, the model's actual pickup rate while saturated
 * (start-eta.ts ModelPickups). Null when neither is known.
 */
function startEtaOf(model: string, taskClass: ComputeClassId | "any", ahead: number, slots: number, nowMs: number): { etaMs: number; typicalMs: number | null; pickupEtaMs: number | null } | null {
  // Run 7: the mean hold, not the median (start-eta.ts ServiceTimes.meanMs): a few long calls hold
  // the slots, and the median of mostly short lookups said they would free far sooner than they did.
  const typicalMs = serviceTimes.meanMs(model, taskClass, nowMs);
  const byService = typicalMs !== null && slots > 0 ? Math.round((Math.max(1, ahead) / slots) * typicalMs) : null;
  const pickupEtaMs = modelPickups.etaMs(model, ahead, nowMs);
  if (byService === null && pickupEtaMs === null) return null;
  return { etaMs: Math.max(byService ?? 0, pickupEtaMs ?? 0), typicalMs, pickupEtaMs };
}

// Run 6: each model's pickups, for the start estimate while it is saturated.
queue.onClaimed((_agentId, st) => {
  if (st.kind === "inference" && st.requestedModel) modelPickups.record(st.requestedModel);
  // Run 9: a claimed call is decided (armClaimDecision).
  const decision = claimDecisions.get(st.id);
  if (decision) clearTimeout(decision);
  claimDecisions.delete(st.id);
});

/** How often the waiting calls are judged again (sweepWaitingInference). */
export const WAITING_SWEEP_MS = 1_000;

/**
 * Run 6 (CPU ramp: 16 "busy" refusals 40-50 s after submit, all from the 45 s claim bound): each
 * waiting network call is judged again every WAITING_SWEEP_MS. A named call with no free slot for it
 * whose estimated start (startEtaOf, from its place in the model's queue) is past the time left in
 * its claim bound cannot start in time: it is ended now with a retryable no_capacity ("busy"),
 * refunded in full, instead of when the bound runs out. Auto calls are left to re-placement
 * (auto-replace.ts), reserved, own-machine and startup-grace calls to their bound. Also records
 * which models are saturated (start-eta.ts ModelPickups). Returns how many were ended.
 */
export async function sweepWaitingInference(nowMs = Date.now()): Promise<number> {
  const byModel = new Map<string, Subtask[]>();
  for (const c of queue.inferenceCalls()) {
    if (c.claimedBy) continue;
    const st = queue.getSubtask(c.subtaskId);
    if (!st?.requestedModel) continue;
    const list = byModel.get(st.requestedModel) ?? [];
    list.push(st);
    byModel.set(st.requestedModel, list);
  }
  for (const model of modelPickups.saturatedModels()) if (!byModel.has(model)) modelPickups.noteSaturated(model, false, nowMs);
  // Run 8: each agent's held calls, so an idle slot its agent stopped pulling for is known (start-eta.ts agentHeldBack).
  noteHeldCounts(nowMs);
  let ended = 0;
  for (const [model, waiting] of byModel) {
    const { slots, free } = modelSlots(model, "any", 0, nowMs);
    modelPickups.noteSaturated(model, slots > 0 && free < waiting.length, nowMs);
    for (let i = 0; i < waiting.length; i++) {
      const st = waiting[i];
      if (st.projectMeta.reservationId || st.projectMeta.onlyAccountId || autoPlacementOf(st.id)) continue;
      const deadlineAt = claimDeadlineAt.get(st.id);
      if (deadlineAt === undefined) continue;
      const cls = (st.projectMeta.computeClass ?? "any") as ComputeClassId | "any";
      // Run 8: without the agents this call may not go to (taken back from them, or failed there): a
      // re-queued call's only "free" slot was often the host it had just been taken from.
      const room = modelSlots(model, cls, inferenceTokensNeededOf(st), nowMs, queue.excludedAgents(st.id));
      // Run 7: no slot here will take it (every holder withholds its slots: a throttled CPU, #563): ended now.
      if (room.slots <= 0) {
        if (withholdingHolders(model, nowMs).length > 0 && (await cancelUnclaimedInference(st.taskId, st.id).catch(() => false))) {
          ended++;
          coordinatorApp.log.warn({ taskId: st.taskId, subtaskId: st.id, model, leftMs: deadlineAt - nowMs }, "inference_waiting_no_slot");
        }
        continue;
      }
      // Run 7: a start in time is not enough when it would not finish in the time it has left
      // (completionCheck on the time since submit, as Auto re-placement does): ended now, not at the deadline.
      // Run 8: judged also when a slot is free for it: the claim admission (claimAdmits) refuses a call
      // that would not finish, so it would otherwise sit out its claim bound beside the free slot.
      const hasSlot = i < room.free;
      const fits = waitingCallFits(st, model, cls, undefined, nowMs, { exclude: queue.excludedAgents(st.id), ...(hasSlot ? { waiting: 0 } : {}) });
      if (hasSlot && fits) continue;
      const eta = hasSlot ? null : startEtaOf(model, cls, i - room.free + 1, room.slots, nowMs);
      if (fits && (eta === null || eta.etaMs <= deadlineAt - nowMs)) continue;
      if (await cancelUnclaimedInference(st.taskId, st.id, undefined, undefined, eta?.etaMs).catch(() => false)) {
        ended++;
        coordinatorApp.log.warn({ taskId: st.taskId, subtaskId: st.id, model, startEtaMs: eta?.etaMs ?? null, leftMs: deadlineAt - nowMs, ahead: i - room.free + 1, ...(fits ? {} : { completion: "over_limit" }) }, "inference_waiting_cannot_start");
      }
    }
  }
  ended += await takeBackStalledClaims(nowMs);
  return ended;
}

/**
 * Run 7 (CPU ramp): inf-1795617240059-949e8a28 and inf-1795617241236-f9c28e38 were claimed within
 * 3 s by a host whose CPU credit ran out as it started them; nothing came in 180 s and the sweep,
 * which looked only at unclaimed calls, never saw them. Other ramp calls waited 14-37 s for their
 * first piece on hosts that had just become throttled. A claimed network call with nothing sent yet
 * is now taken back from its agent (once) when that agent withholds its slots (a throttled CPU,
 * start-eta.ts agentWithholding), or when its first piece is overdue (stalledClaimMs). It goes back
 * on the queue without that agent, with the time it has left, when it can still finish there
 * (completionCheck on the time since submit); else it is ended now with a retryable no_capacity
 * ("busy"), refunded in full. The agent's later pieces and result are refused (not the claimant).
 * Returns how many were ended (re-queued calls are judged by the next sweep).
 */
export async function takeBackStalledClaims(nowMs = Date.now()): Promise<number> {
  let ended = 0;
  for (const c of queue.inferenceCalls()) {
    if (!c.claimedBy) continue;
    const claim = queue.getClaim(c.subtaskId);
    const st = claim?.subtask;
    const agentId = claim?.claimedBy;
    if (!st || !agentId || claim.claimedAt === undefined || !st.requestedModel) continue;
    // Run 8: not only once. A call taken from the backlog after a take-back (or a failed run) on another
    // host is taken back again from a held-back one, up to STALL_TAKE_BACKS times while it has time left.
    if (st.projectMeta.reservationId || st.projectMeta.onlyAccountId || (takenBack.get(st.id) ?? 0) >= STALL_TAKE_BACKS || requesterCancelled(st.id)) continue;
    if (inferenceStreams.firstPieceAt(st.id) !== undefined || inferenceStreams.hasContent(st.id) || inferenceStreams.isDone(st.id)) continue;
    const ageMs = nowMs - claim.claimedAt;
    const cls = effectiveHardware(agentId)?.computeClass ?? agentCapabilities.get(agentId)?.computeClass ?? "cpu";
    // Run 10: never a cloud host for withheld slots. It runs calls on a hosted API (no CPU credit to run
    // out of), reasons before its first piece, and its slot report lags its claims: the three run-10
    // "deepseek busy" calls were taken back from it this way within seconds (the coordinator showed
    // them unclaimed while the cloud host still ran them: idle, 13/16 free) and, excluded from the only
    // deepseek host, waited out the 45 s bound.
    const throttled = cls !== "cloud" && ageMs >= STALL_REPORT_GRACE_MS && agentWithholding(agentId, nowMs);
    const boundMs = throttled ? null : stalledClaimMs(st.requestedModel, cls, Math.ceil(Buffer.byteLength(st.input, "utf8") / 4), nowMs);
    if (!throttled && (boundMs === null || ageMs < boundMs)) continue;
    const submittedAtMs = usagePending.get(st.taskId)?.atMs;
    if (submittedAtMs === undefined) continue;
    if (!inferenceStreams.reopenIfEmpty(st.id) || !queue.releaseForRetry(st.id, agentId, nowMs)) continue;
    retriedInference.set(st.id, nowMs);
    takenBack.set(st.id, (takenBack.get(st.id) ?? 0) + 1);
    claimedTradePrice.delete(st.id);
    const leftMs = rerunTimeoutMs(submittedTimeoutMs(st), submittedAtMs, nowMs, 0);
    const why = throttled ? "agent_withholding" : "first_piece_overdue";
    if (leftMs < INFERENCE_RETRY_MIN_LEFT_MS || !waitingCallFits(st, st.requestedModel, st.projectMeta.computeClass ?? "any", undefined, nowMs, { exclude: queue.excludedAgents(st.id) })) {
      if (await cancelUnclaimedInference(st.taskId, st.id).catch(() => false)) ended++;
      coordinatorApp.log.warn({ taskId: st.taskId, subtaskId: st.id, agentId, ageMs, why, leftMs }, "inference_stalled_claim_ended");
      continue;
    }
    startRerunBudget(st, leftMs);
    armClaimDeadline(st.taskId, st.id, Math.min(INFERENCE_CLAIM_TIMEOUT_MS, leftMs));
    armRequeueDecision(st, nowMs);
    coordinatorApp.log.warn({ taskId: st.taskId, subtaskId: st.id, agentId, ageMs, why, leftMs }, "inference_stalled_claim_requeued");
  }
  return ended;
}
/** A claim this young is not taken back for its agent's withheld slots (its report may predate the claim). */
export const STALL_REPORT_GRACE_MS = 2_000;
/** Run 8: how many times one call may be taken back from a stalled or held-back host. */
export const STALL_TAKE_BACKS = 2;
/** Calls taken back (takeBackStalledClaims), and how often. */
const takenBack = new Map<string, number>();
setInterval(() => {
  for (const id of takenBack.keys()) if (!queue.getSubtask(id)) takenBack.delete(id);
  pruneJudged((id) => queue.getSubtask(id) !== undefined);
}, 60_000).unref?.();
setInterval(() => void sweepWaitingInference().catch((err) => coordinatorApp.log.error({ err }, "inference_waiting_sweep_failed")), WAITING_SWEEP_MS).unref?.();

/**
 * Run 4: whether a call can finish here within its timeout (start-eta.ts completionByClass):
 * `exclude`, the agents of classes that would not finish it in time; `none`, no class here would;
 * `etaMs`, the soonest known completion. Nothing is judged without speed samples or with the check off.
 */
export function completionCheck(
  model: string, taskClass: ComputeClassId | "any", messages: ChatMessage[], tools: unknown[] | undefined, maxTokens: number | undefined, timeoutMs: number, nowMs = Date.now(),
  opts: CompletionCheckOptions = {},
): { exclude: string[]; none: boolean; etaMs: number | null; limitMs: number; classes: ClassCompletion[] } {
  const elapsedMs = Math.max(0, opts.elapsedMs ?? 0);
  const limitMs = completionLimitMs(timeoutMs, CC.INFERENCE_COMPLETION_ETA_FRACTION) - elapsedMs;
  if (!Number.isFinite(limitMs)) return { exclude: [], none: false, etaMs: null, limitMs, classes: [] };
  const { promptTokens, outputTokens } = completionWork(messages, tools, maxTokens, opts.outputTokens);
  // Run 7: the decode-rate estimate judges a reply of the call's own max_tokens; a call that set none is
  // judged on a typical long reply (COMPLETION_UNSET_MAX_TOKENS) at the speed estimate, as before.
  // Run 9: an Auto call is judged on its expected reply (expected-output.ts), at the decode rate too.
  const decode = maxTokens !== undefined || opts.outputTokens !== undefined;
  const classes = completionByClass({ model, taskClass, neededTokens: contextNeeded(messages, tools, maxTokens ?? INFERENCE_DEFAULT_MAX_TOKENS), promptTokens, outputTokens, waiting: opts.waiting ?? queue.waitingInference(model), prior: completionPrior(), decode, ...(opts.exclude?.length ? { exclude: opts.exclude } : {}) }, nowMs);
  return { ...judgeCompletion(classes, limitMs, opts.explore === false ? 0 : timeoutMs - elapsedMs), limitMs: Math.round(limitMs), classes };
}

/**
 * Run 10: the completion estimate's parts per class, for the admission log line
 * (inference_completion_estimate), so a network run can check each against what the call did:
 * prompt tokens, the prefill rate and where it came from, the decode rate (and after the prompt),
 * the speed estimate, contention, start and total.
 */
export function completionEstimateLog(check: { classes: ClassCompletion[]; limitMs: number; none: boolean; exclude: string[] }): Record<string, unknown> {
  return {
    limitMs: check.limitMs, none: check.none, excluded: check.exclude.length,
    classes: check.classes.map((c) => {
      const p = c.parts;
      const r = p?.rate ?? null;
      return {
        computeClass: c.computeClass, agents: c.agents.length, startEtaMs: c.startEtaMs, completionEtaMs: c.completionEtaMs, priorOnly: c.priorOnly ?? false,
        ...(p ? { promptTokens: p.promptTokens, outputTokens: p.outputTokens, bySpeedMs: p.bySpeedMs, speedFrom: p.speedFrom, slowdown: p.slowdown } : {}),
        ...(r ? { rateMs: r.ms, prefillTps: r.prefillTps, prefillFrom: r.prefillFrom, prefillSamples: r.prefillSamples, prefillMs: r.prefillMs, decodeTps: r.decodeTps, decodeFrom: r.decodeFrom, effectiveDecodeTps: r.effectiveDecodeTps, decodeMs: r.decodeMs } : {}),
      };
    }),
  };
}

/**
 * Run 6: `elapsedMs`, time the call already used (a re-placement judges the time left: auto-replace.ts);
 * `explore: false`, no exploration (a call another coordinator sent here: it is refused at once if
 * this coordinator's estimate says it would not finish).
 */
export interface CompletionCheckOptions {
  elapsedMs?: number;
  explore?: boolean;
  /** Run 8: calls ahead of this one (default: every call waiting for the model; 0 for a call being claimed now). */
  waiting?: number;
  /** Run 8: agents this call may not go to (not counted as capacity for it). */
  exclude?: readonly string[];
  /**
   * Run 9: the reply the call is judged on (tokens), in place of its max_tokens: an Auto call's
   * expected output (expected-output.ts). Never above max_tokens.
   */
  outputTokens?: number;
}

/** An "about" cSats figure for a message: 2 decimals under 10, whole above. */
const fmtCSats = (c: number) => (c < 10 ? c.toFixed(2).replace(/\.?0+$/, "") : String(Math.round(c)));

/**
 * The 402 a model call gets when the buyer's balance can't cover its reserve: what it sets aside
 * (`neededCSats`) and what it is expected to cost (`expectedCSats`), as data and in words.
 */
export function insufficientCreditsBody(reserveMsat: number, expectedMsat: number): { error: "insufficient_credits"; neededCSats: number; expectedCSats: number; message: string } {
  const neededCSats = msatToCSats(reserveMsat);
  const expectedCSats = Number(msatToCSats(Math.max(0, Math.min(reserveMsat, expectedMsat))).toFixed(3));
  return {
    error: "insufficient_credits",
    neededCSats,
    expectedCSats,
    message: `Not enough cSats for this request (it sets aside up to ${neededCSats} cSats; expected cost about ${fmtCSats(expectedCSats)} cSats; unused cSats come back).`,
  };
}

/**
 * The tokens completion admission judges a call on: its prompt, and its reply (max_tokens, else
 * COMPLETION_UNSET_MAX_TOKENS) × the output share. Run 9: the prompt at its real density
 * (start-eta.ts promptTokenEstimate: digits are tokens of their own); `expectedOutput`, an Auto call's
 * expected reply (expected-output.ts), judged as it is (capped by max_tokens).
 */
export function completionWork(messages: ChatMessage[], tools: unknown[] | undefined, maxTokens: number | undefined, expectedOutput?: number): { promptTokens: number; outputTokens: number } {
  const promptTokens = promptTokenEstimate(JSON.stringify({ messages, tools: tools ?? [] }));
  if (expectedOutput !== undefined && Number.isFinite(expectedOutput) && expectedOutput > 0) {
    return { promptTokens, outputTokens: Math.max(1, Math.ceil(maxTokens !== undefined ? Math.min(expectedOutput, maxTokens) : expectedOutput)) };
  }
  // A call that sets no max_tokens is judged on a typical long reply, not the default cap (a billing bound).
  const judgedMax = maxTokens ?? Math.min(INFERENCE_DEFAULT_MAX_TOKENS, COMPLETION_UNSET_MAX_TOKENS);
  return { promptTokens, outputTokens: Math.max(1, Math.ceil(judgedMax * CC.INFERENCE_COMPLETION_OUTPUT_SHARE)) };
}

/** Run 6: what a peer's free host must finish the call within to be sent it (locality.ts peerWithFreeCapacity). */
function peerFit(messages: ChatMessage[], tools: unknown[] | undefined, maxTokens: number | undefined, timeoutMs: number): PeerFit {
  return { ...completionWork(messages, tools, maxTokens), limitMs: completionLimitMs(timeoutMs, CC.INFERENCE_COMPLETION_ETA_FRACTION), prior: completionPrior(), decode: maxTokens !== undefined };
}

/**
 * Run 6: whether a waiting call would finish on `model` in `cls` in the time it has left (since its
 * submit), by the same completion check as a submit. A call's stored max_tokens equal to the default
 * cap is taken as unset (judged on COMPLETION_UNSET_MAX_TOKENS, as at submit).
 */
function waitingCallFits(st: Subtask, model: string, cls: string, agentId: string | undefined, nowMs: number, opts: Pick<CompletionCheckOptions, "waiting" | "exclude"> = {}): boolean {
  let input: { messages?: ChatMessage[]; tools?: unknown[]; maxTokens?: number };
  try {
    input = JSON.parse(st.input);
  } catch {
    return true;
  }
  if (!Array.isArray(input.messages)) return true;
  const submittedAtMs = usagePending.get(st.taskId)?.atMs ?? nowMs;
  const taskClass = ((ACCEPTED_COMPUTE_CLASS_IDS as readonly string[]).includes(cls) ? cls : "any") as ComputeClassId | "any";
  const maxTokens = input.maxTokens === INFERENCE_DEFAULT_MAX_TOKENS ? undefined : input.maxTokens;
  // Run 9: an Auto call is judged on the reply it was placed on (expected-output.ts), as at submit.
  const judgedOutput = judgedOutputOf(st.id);
  const check = completionCheck(model, taskClass, input.messages, input.tools, maxTokens, submittedTimeoutMs(st), nowMs, { elapsedMs: nowMs - submittedAtMs, ...opts, ...(judgedOutput !== undefined ? { outputTokens: judgedOutput } : {}) });
  return agentId ? !check.exclude.includes(agentId) : !check.none;
}

/**
 * Run 8 (CPU ramp: inf-1795626005562-e8d4e4d0, -42b56eeb, -b008d3ec, -12a17597 waited in the shared
 * backlog, were claimed by hosts that had just run out of CPU credit and ran to the 180 s timeout):
 * a network model call is judged again when an agent pulls it, as placement judges it at submit:
 *  - not by a host that is held back (start-eta.ts agentStolenRecently: CPU steal or its throttle
 *    guard reported within WITHHELD_REPORT_FRESH_MS, including with this very pull);
 *  - not when it would no longer finish on that host's class in the time it has left (the completion
 *    gate on the time since submit, with nothing ahead of it: the host has a slot for it now), when
 *    it would have at submit (a call let in without that judgement is left to the waiting sweep).
 * Left waiting, it goes to another host or is ended by the waiting sweep. Reserved and own-machine
 * calls run where they are placed; a call gossiped from a peer is judged by its origin.
 */
export function claimAdmits(agentId: string, st: Subtask, nowMs = Date.now()): boolean {
  if (st.kind !== "inference" || !st.requestedModel) return true;
  if (st.projectMeta.reservationId || st.projectMeta.onlyAccountId) return true;
  const cls = effectiveHardware(agentId)?.computeClass ?? agentCapabilities.get(agentId)?.computeClass ?? "cpu";
  // Run 9 (three standard Auto calls refused "deepseek busy" after 25-48 s while the cloud host had
  // 12-16 free slots): a cloud host runs the call on a hosted API. Its CPU is not what serves it, and
  // its measured call times are mostly reasoning, which does not grow with max_tokens, so the
  // completion estimate scaled them far past what best fit (the API's own rate) placed it on. With a
  // free slot (mayTakeNow), it is admitted.
  if (cls === "cloud") return true;
  if (agentStolenRecently(agentId, nowMs)) return false;
  if (usagePending.get(st.taskId) === undefined) return true;
  if (waitingCallFits(st, st.requestedModel, cls, agentId, nowMs, { waiting: 0 })) return true;
  // Refused only for the time it spent waiting: a call that would not have fit this class at submit
  // either was let in there (exploration, or no holder yet right after a restart) and is not second-guessed.
  const submittedAtMs = usagePending.get(st.taskId)?.atMs ?? nowMs;
  return !waitingCallFits(st, st.requestedModel, cls, agentId, submittedAtMs, { waiting: 0 });
}
setClaimAdmission(claimAdmits);

setReplaceAdmission({
  fits: (p: AutoPlacement, pick, nowMs) => {
    const st = queue.getSubtask(p.subtaskId);
    return !st || waitingCallFits(st, pick.model, pick.computeClass, pick.agentId, nowMs);
  },
  currentFits: (p: AutoPlacement, nowMs) => {
    const st = queue.getSubtask(p.subtaskId);
    return !st?.requestedModel || waitingCallFits(st, st.requestedModel, st.projectMeta.computeClass ?? "any", undefined, nowMs);
  },
  refuse: (p: AutoPlacement, price?: { neededCSats: number }) => cancelUnclaimedInference(p.taskId, p.subtaskId, undefined, undefined, undefined, price),
});

/** Run 5: the output a call without max_tokens is judged on (it may write up to INFERENCE_DEFAULT_MAX_TOKENS). */
export const COMPLETION_UNSET_MAX_TOKENS = 1_024;
/** Run 5: each class's prior speed for the completion estimate (start-eta.ts parseCompletionPrior), read when used. */
let priorCache: { raw: string | undefined; prior: Record<string, number> } | undefined;
function completionPrior(): Record<string, number> {
  const raw = process.env.INFERENCE_COMPLETION_PRIOR_SPEED;
  if (!priorCache || priorCache.raw !== raw) priorCache = { raw, prior: parseCompletionPrior(raw) };
  return priorCache.prior;
}

/** Auto picks at most this many times while its pick would not finish the call in time. */
const AUTO_COMPLETION_PICKS = 3;

/** Median of the known round trips (ms), null when none is known. */
function medianRtt(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/** /inference/models freeHosts entry: one host with a free slot for the model. */
type FreeHostReport = { region: string; free: number; computeClass: string; rttMs?: number; serviceMs?: number; speed?: number; speedFrom?: HostSpeedSource; speedAgeMs?: number };

export function registerInferenceRoutes(app: CoordinatorApp): void {
  // Security research tier: entitlement pushes from the portal and the admin view (routes/restricted.ts).
  registerRestrictedRoutes(app);
  // The requester went away: POST /inference/cancel (inference-cancel.ts).
  registerInferenceCancelRoute(app);
  /** Models agents on the network can run now, with how many agents and the price per class. */
  app.get("/inference/models", async (req) => {
    const now = Date.now();
    // Security research tier: a restricted model is listed only to an account entitled to it.
    const viewer = restrictedCatalog.size > 0 ? await modelViewerAccount(req) : undefined;
    const byModel = new Map<string, { agents: number; idle: number; free: number; classes: Set<ComputeClassId>; byClass: Partial<Record<ComputeClassId, number>>; ctx?: number; rtts: number[]; freeRtts: number[]; freeRegions: Set<string>; freeHosts: FreeHostReport[] }>();
    const classAgents: Partial<Record<ComputeClassId, Set<string>>> = {};
    const claims = queue.activeClaims();
    for (const [id, cap] of agentCapabilities) {
      if (activeBlacklistRecord(id) || (cap.lastSeenMs !== undefined && now - cap.lastSeenMs > 3 * 60_000)) continue;
      // #524: an agent whose socket closed (nothing heard since) is not capacity: the portal must not
      // send calls here for it.
      if (agentSocketLost(id, now)) continue;
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
        const e = byModel.get(m) ?? { agents: 0, idle: 0, free: 0, classes: new Set<ComputeClassId>(), byClass: {}, rtts: [], freeRtts: [], freeRegions: new Set<string>(), freeHosts: [] };
        e.agents++;
        e.byClass[cls] = (e.byClass[cls] ?? 0) + 1;
        (classAgents[cls] ??= new Set()).add(id);
        if (queue.agentClaims(id) === 0 && !unavailable) e.idle++;
        // Run 8: a held-back host (CPU steal, or not pulling with an idle slot) has no free slot to offer.
        const free = unavailable || !memoryAdmits(id, m, held, now) || agentHeldBack(id, held, now) ? 0 : freeModelSlots(id, claims);
        e.free += free;
        // #526: where the free slots are, so the portal can send a buyer to the coordinator with a free host near it.
        const region = free > 0 ? agentRegionCode(cap) : null;
        if (region && e.freeRegions.size < 32) e.freeRegions.add(region);
        // Coordinator <-> agent round trip (the portal adds it to a coordinator's expected latency).
        const rtt = agentRttMs(id);
        if (rtt !== null && Number.isFinite(rtt)) {
          e.rtts.push(rtt);
          if (free > 0) e.freeRtts.push(rtt);
        }
        // freeHosts: each free host's own region, free slots, round trip and time for a reference call of
        // the model (portal coordinator-latency.ts scores the free host nearest the buyer with its own numbers).
        // Run 6: also its class and speed (ms per ms of expectedWorkMs) and where that comes from, so the
        // portal scales it to the call it places and compares two hosts of one class by distance unless
        // both have measured speeds. serviceMs (a reference call) stays for older portals. Run 7: with a
        // measured speed, how old its newest sample is (speedAgeMs): the portal trusts only a fresh one.
        // Run 19: a host that keeps failing calls or not picking them up (routing fail rate ≥ 0.5) is
        // not offered as a free host: its speed (often a class prior) must not win the portal's latency rule.
        if (region && free > 0 && e.freeHosts.length < 32 && !((agentFailRate(id) ?? 0) >= FREE_HOST_MAX_FAIL_RATE)) {
          const sp = hostSpeed(m, id, cls, now, completionPrior()[cls]);
          const svc = sp === null ? null : hostServiceMs(m, id, cls, now, completionPrior()[cls]);
          e.freeHosts.push({ region, free, computeClass: cls, ...(rtt !== null && Number.isFinite(rtt) ? { rttMs: Math.round(rtt) } : {}), ...(svc !== null ? { serviceMs: svc } : {}), ...(sp !== null ? { speed: Math.round(sp.speed * 1000) / 1000, speedFrom: sp.from, ...(sp.ageMs !== undefined ? { speedAgeMs: Math.round(sp.ageMs) } : {}) } : {}) });
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
      // Cloud models in catalog rank order among themselves (cloudRank: the default cloud model first).
      models: orderCloudModels([...byModel.entries()]
        // idleAgents / freeSlots / waiting: how busy this coordinator is for the model, so the portal can
        // send new calls where a slot is free (inference runs where it was submitted; it is never relayed).
        // freeSlots counts parallel model slots, so two half-busy coordinators still compare by room left.
        .map(([model, e]) => {
          const restricted = restrictedCatalog.tierOf(model);
          // restricted: runs only on your own machines or a lease you hold, never as a network call.
          // agentRttMs: median round trip to the agents with a free slot for it (else to all that hold it).
          const agentRtt = medianRtt(e.freeRtts.length ? e.freeRtts : e.rtts);
          // A cloud model (src/cloud-host/): its cost-plus price, its own context window, and where it
          // comes from (origin: the data for a "no models of origin X" filter) and who serves it;
          // cloudRank / cloudHint: its place among cloud models and its picker hint (catalog.ts).
          // paramsB: billions of parameters (MoE total), for the portal's model list.
          const cloud = cloudModelSpec(model);
          const ctx = cloud ? Math.min(e.ctx ?? cloud.contextWindow, cloud.contextWindow) : e.ctx;
          // serviceMs: typical time a call of this model holds a slot here (C9; the portal's queue estimate).
          const serviceMs = serviceTimes.typicalMs(model, "any", now);
          return { model, agents: e.agents, agentsByClass: e.byClass, idleAgents: e.idle, freeSlots: e.free, waiting: queue.waitingInference(model), ...(serviceMs !== null ? { serviceMs } : {}), classes: [...e.classes], paramsB: paramsB(model), cSatsPerMTokens: cSatsPerMTokens(paramsB(model), mutable.latestRateEpoch?.btcUsd ?? FALLBACK_BTC_USD, modelTokenPrice(model)), ...(ctx ? { contextWindow: ctx } : {}), ...(cloud ? { origin: cloud.origin, hostedBy: cloud.provider, cloudRank: cloud.rank, ...(cloud.hint ? { cloudHint: cloud.hint } : {}) } : {}), ...(restricted ? { restricted } : {}), ...(agentRtt !== null ? { agentRttMs: agentRtt } : {}), ...(e.freeRegions.size ? { freeRegions: [...e.freeRegions] } : {}), ...(e.freeHosts.length ? { freeHosts: e.freeHosts } : {}) };
        })
        .sort((a, b) => b.agents - a.agents || a.model.localeCompare(b.model)), (r) => r.model, (r) => r.cloudRank),
      classes,
      // Queueing here, for the portal's latency-aware coordinator choice: pickup p90 and call p50 (ms; null when no recent calls).
      load: coordinatorLoadSignals(),
    };
  });

  app.post("/inference/submit", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    // Run 17: the claim decision's window runs from here (armClaimDecision, auto-replace.ts).
    const receivedAtMs = Date.now();
    const body = inferenceSubmitSchema.parse(req.body);
    // Frontier models run on their owner's own API key in their own IDE provider, never on the network.
    if (isFrontierModelId(body.model)) return reply.code(400).send({ error: "frontier_model_not_routable", message: "frontier/<provider>/<model> runs only on your own key on your own computer; the network never serves it." });
    const submitter = await resolveSubmitterAccount(req as any, body.submitterAccountId, "/inference/submit");
    if ("error" in submitter) return reply.code(submitter.status).send({ error: submitter.error });
    if (submitter.accountId === "anonymous") return reply.code(403).send({ error: "account_required" });
    const accountId = submitter.accountId;
    // The portal's coordinator choice is believed only from the portal (service token).
    const portalChoice = body.coordinatorChoice && hasPortalServiceToken((req as any).headers ?? {}) ? sanitizeCoordinatorChoice(body.coordinatorChoice) : undefined;
    // #526: the buyer's region (sent by the portal, else the request's edge headers): only a preference.
    const clientRegion = cleanRegion(body.clientRegion) ?? portalChoice?.clientRegion ?? clientRegionOf((req as any).headers ?? {});
    // model "auto": best-fit routing picks the model, the class and a preferred agent (routing.ts).
    let routed: { job: JobDescriptor; result: BestFitResult; summary: RoutingSummary; judgedOutput: number; onlyClass?: string } | undefined;
    // Run 4: agents that would not finish this call within its timeout (completionCheck): they do not get it.
    let slowAgents: string[] = [];
    if (body.model === AUTO_MODEL_ID) {
      if (body.reservationId || body.target === "mine") return reply.code(400).send({ error: "auto_network_only", detail: "model auto routes network calls; name a model for your own machines or a reservation" });
      const hints = cleanHints(body.routing);
      const job = describeJob({ messages: body.messages as ChatMessage[], tools: body.tools, maxTokens: body.maxTokens }, hints, complexityWeights);
      // Run 9: the completion check judges the reply the call is expected to write (the median of
      // recent calls of its job type, else the descriptor's estimate; capped by max_tokens), not its
      // max_tokens: a simple chat with a generous cap is not cloud overflow while a CPU host is free.
      const judgedOutput = expectedOutputTokens(job);
      // A class named on the submit, else in the hints (a bot on "Network GPU only"), limits best fit to it.
      const onlyClass = body.computeClass !== "any" ? body.computeClass : hints.computeClass;
      const autoOpts = { peers: body.routeRedirect, requesterAccountId: accountId, clientRegion, ...(onlyClass ? { computeClass: onlyClass } : {}) };
      let { result, elsewhere } = await resolveAuto(job, autoOpts);
      // Run 4: best fit's pick here would not finish the call in time (a heavy prompt and a long reply
      // on a slow class): pick again without the agents that would not, up to AUTO_COMPLETION_PICKS times.
      let late: { etaMs: number | null; limitMs: number } | undefined;
      for (let pick = 0; result.chosen?.local && !elsewhere; pick++) {
        const chosenClass = (ACCEPTED_COMPUTE_CLASS_IDS as readonly string[]).includes(result.chosen.computeClass) ? (result.chosen.computeClass as ComputeClassId) : "any";
        const check = completionCheck(result.chosen.model, chosenClass, body.messages as ChatMessage[], body.tools, body.maxTokens, body.timeoutMs, Date.now(), { explore: !body.redirected, outputTokens: judgedOutput });
        req.log.info({ taskId: body.taskId, model: result.chosen.model, auto: true, pick, ...completionEstimateLog(check) }, "inference_completion_estimate");
        const fresh = check.exclude.filter((id) => !slowAgents.includes(id));
        slowAgents = [...slowAgents, ...fresh];
        if (!check.exclude.includes(result.chosen.agentId)) break;
        late = { etaMs: check.etaMs, limitMs: check.limitMs };
        if (pick + 1 >= AUTO_COMPLETION_PICKS || fresh.length === 0) {
          result = { ...result, chosen: null };
          break;
        }
        ({ result, elsewhere } = await resolveAuto(job, { ...autoOpts, excludeAgents: slowAgents }));
      }
      if (!result.chosen && slowAgents.length > 0) {
        // Run 11: a long prompt no machine here would finish in time goes to a cloud host here when
        // one is online with room (the overflow), not a 503: best fit once more without every
        // non-cloud machine. A named call keeps its clean 503.
        const nonCloud = localAgentViews().filter((a) => a.computeClass !== "cloud").map((a) => a.agentId);
        const last = await resolveAuto(job, { ...autoOpts, peers: false, excludeAgents: [...new Set([...slowAgents, ...nonCloud])] });
        if (last.result.chosen?.local && last.result.chosen.computeClass === "cloud") {
          req.log.info({ taskId: body.taskId, model: last.result.chosen.model, slowAgents: slowAgents.length, ...(late ?? {}) }, "inference_completion_cloud_overflow");
          result = last.result;
          elsewhere = undefined;
        }
      }
      if (!result.chosen && slowAgents.length > 0) {
        // Only machines that would not finish it in time: refused now, retryable, nothing reserved.
        req.log.info({ computeClass: onlyClass ?? null, slowAgents: slowAgents.length, ...(late ?? {}) }, "inference_completion_over_limit");
        return noCapacityReply(reply as any, { reason: "busy", model: AUTO_MODEL_ID, retryAfterSec: NO_CAPACITY_RETRY_AFTER_SEC, ...(late?.etaMs != null ? { completionEtaMs: late.etaMs } : {}), limitMs: late?.limitMs ?? Math.round(completionLimitMs(body.timeoutMs, CC.INFERENCE_COMPLETION_ETA_FRACTION)) });
      }
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
      routed = { job, result, summary, judgedOutput, ...(onlyClass ? { onlyClass } : {}) };
    }
    // Security research tier: a restricted model needs an entitlement and your own or leased machines.
    const gate = await restrictedSubmitGate(accountId, body.model, { target: body.target, reservationId: body.reservationId });
    if (!gate.ok) return reply.code(gate.status).send(gate.body);
    const restrictedTier = gate.tier;
    // #524: an agent whose socket closed (nothing heard since) holds nothing a call could wait for.
    const holders = [...agentCapabilities.entries()].filter(([id, cap]) => agentHasModel(cap, body.model) && !activeBlacklistRecord(id) && !agentSocketLost(id));
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
    } else {
      // A named network model with no free slot here that a peer has free (#526): resubmit there,
      // before anything is reserved (the same redirect as an Auto call whose best fit is on a peer).
      if (body.routeRedirect && !routed && !restrictedTier && sumFree(freeLocalHolders(body.model, namedClass(body.computeClass), contextNeeded(body.messages as ChatMessage[], body.tools, body.maxTokens ?? INFERENCE_DEFAULT_MAX_TOKENS))) <= queue.waitingInference(body.model)) {
        const peer = await peerWithFreeCapacity(body.model, body.computeClass, clientRegion, Date.now(), peerFit(body.messages as ChatMessage[], body.tools, body.maxTokens, body.timeoutMs)).catch(() => null);
        if (peer) {
          recordMeshWork(peer.coordinatorId);
          return reply.code(409).send({ error: "route_elsewhere", coordinatorId: peer.coordinatorId, coordinatorUrl: peer.url, model: body.model });
        }
      }
      // Just restarted, agents not back yet: a known model's call waits for them (bounded, refunded if none comes).
      if (!holders.some(([id]) => !reservations.isHeld(id)) && !(holders.length === 0 && inStartupGrace() && knownModel(body.model))) return reply.code(409).send({ error: "no_agent_has_model", model: body.model });
      // C9: a call that would not start here in time (start-eta.ts) goes to a peer with a free slot
      // (route_elsewhere) or is refused now, retryable, before anything is reserved.
      const overloaded = startEtaOverLimit(body.model, namedClass(body.computeClass), contextNeeded(body.messages as ChatMessage[], body.tools, body.maxTokens ?? INFERENCE_DEFAULT_MAX_TOKENS), body.timeoutMs);
      if (overloaded) {
        const peer = body.routeRedirect && !restrictedTier ? await peerWithFreeCapacity(body.model, body.computeClass, clientRegion, Date.now(), peerFit(body.messages as ChatMessage[], body.tools, body.maxTokens, body.timeoutMs)).catch(() => null) : null;
        req.log.info({ model: body.model, computeClass: body.computeClass, ...overloaded, peer: peer?.coordinatorId ?? null }, "inference_start_eta_over_limit");
        if (peer) {
          recordMeshWork(peer.coordinatorId);
          return reply.code(409).send({ error: "route_elsewhere", coordinatorId: peer.coordinatorId, coordinatorUrl: peer.url, model: body.model, reason: "start_eta", startEtaMs: overloaded.etaMs, ...(routed ? { routing: routed.summary } : {}) });
        }
        return noCapacityReply(reply as any, { reason: "busy", model: body.model, retryAfterSec: Math.max(1, Math.min(60, Math.ceil(overloaded.etaMs / 2_000))), startEtaMs: overloaded.etaMs });
      }
      // Run 4: a call that would start in time but not finish in time (completionCheck). The classes
      // that would not finish it do not get it; with none here in time it goes to a peer with a free
      // slot (route_elsewhere) or is refused now, retryable, before anything is reserved.
      if (!routed) {
        // Run 6: a call another coordinator sent here gets no exploration: refused now if it would not finish.
        const late = completionCheck(body.model, namedClass(body.computeClass), body.messages as ChatMessage[], body.tools, body.maxTokens, body.timeoutMs, Date.now(), { explore: !body.redirected });
        req.log.info({ taskId: body.taskId, model: body.model, auto: false, ...completionEstimateLog(late) }, "inference_completion_estimate");
        if (late.none) {
          // Run 6: only to a peer whose free host would finish it (locality.ts peerCompletionMs), else 503 now.
          const peer = body.routeRedirect && !restrictedTier ? await peerWithFreeCapacity(body.model, body.computeClass, clientRegion, Date.now(), peerFit(body.messages as ChatMessage[], body.tools, body.maxTokens, body.timeoutMs)).catch(() => null) : null;
          req.log.info({ model: body.model, computeClass: body.computeClass, completionEtaMs: late.etaMs, limitMs: late.limitMs, peer: peer?.coordinatorId ?? null }, "inference_completion_over_limit");
          if (peer) {
            recordMeshWork(peer.coordinatorId);
            return reply.code(409).send({ error: "route_elsewhere", coordinatorId: peer.coordinatorId, coordinatorUrl: peer.url, model: body.model, reason: "completion_eta", ...(late.etaMs !== null ? { completionEtaMs: late.etaMs } : {}) });
          }
          return noCapacityReply(reply as any, { reason: "busy", model: body.model, ...(late.etaMs !== null ? { completionEtaMs: late.etaMs } : {}), limitMs: late.limitMs });
        }
        slowAgents = late.exclude;
      }
    }
    // B4: every machine holding the model has its circuit open (cooling down after failures): say so
    // now, retryable, rather than queue the call for the claim bound behind the breaker.
    if (!reservationId && !onlyAccountId && holders.length > 0) {
      const free = holders.filter(([id]) => !reservations.isHeld(id));
      const nowMs = Date.now();
      if (free.length > 0 && free.every(([id]) => circuitOpen(id, nowMs))) {
        const soonest = Math.min(...free.map(([id]) => circuitState(id, nowMs).openUntilMs ?? nowMs));
        return noCapacityReply(reply as any, { reason: "cooling_down", model: body.model, retryAfterSec: Math.max(1, Math.min(NO_CAPACITY_RETRY_AFTER_SEC * 4, Math.ceil((soonest - nowMs) / 1000))) });
      }
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
    if (billed && taskClass !== "any" && holders.length > 0) {
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
    // The prompt is held at its digit-aware estimate × 1.25 or bytes / 2, whichever is more (a local
    // model; a cloud model at bytes / 3): a cost past the hold is settled from the balance at settle.
    const sized = billed ? inferenceCallReserve({ model: body.model, taskClass, timeoutMs: body.timeoutMs, inputBytes: Buffer.byteLength(input, "utf8"), maxTokens, promptTokens: promptTokenEstimate(input), ...(maxCSats !== undefined ? { maxCSats } : {}) }) : undefined;
    // Run 11: an Auto call may overflow to a cloud host here if nothing else can start it (auto-replace.ts):
    // its reserve covers that worst case too (the unused part is refunded at settle, as always).
    const overflowMsat = routed && billed && taskClass !== "cloud" ? cloudOverflowReserveMsat({ inputBytes: Buffer.byteLength(input, "utf8"), maxTokens, timeoutMs: body.timeoutMs, ...(maxCSats !== undefined ? { maxCSats } : {}), ...(routed.onlyClass ? { onlyClass: routed.onlyClass } : {}), job: routed.job }) : 0;
    const reserve = Math.max(sized?.reserveMsat ?? 0, overflowMsat);
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
      // B2: the row and the debit go in one round trip (reserveTaskCredits); a refused debit writes
      // neither, so there is no billing row to close afterwards.
      try {
        const billingRow = await reserveTaskCredits({ taskId: body.taskId, coordinatorId: identity.peerId, accountId, kind: "inference", perSubtaskReserveMsat: reserve, createdAtMs: Date.now() }, msatToCSats(reserve), "inference_reserve", { idempotencyKey: taskReserveKey(body.taskId) });
        if (billingRow === "conflict") return reply.code(409).send({ error: "duplicate_task", taskId: body.taskId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof DuplicateDebitError) return reply.code(409).send({ error: "duplicate_task", taskId: body.taskId });
        if (message.startsWith("insufficient_credits")) {
          // What the call sets aside and what it is expected to cost, so the buyer sees both.
          const work = completionWork(body.messages as ChatMessage[], body.tools, body.maxTokens, routed?.judgedOutput);
          const expectedMsat = Math.min(reserve, inferenceCallExpectedMsat({ model: body.model, taskClass, timeoutMs: body.timeoutMs, ...work }));
          return reply.code(402).send(insufficientCreditsBody(reserve, expectedMsat));
        }
        req.log.error({ err, taskId: body.taskId }, "inference_debit_failed");
        return reply.code(500).send({ error: "credit_debit_failed" });
      }
    }
    // A cost past the reserve is taken from the balance at settle, up to the buyer's maxCSats (results.ts).
    const overflowCapMsat = maxCSats !== undefined && Number.isFinite(maxCSats) && maxCSats > 0 ? Math.max(reserve, Math.floor(cSatsToMsat(maxCSats))) : Number.MAX_SAFE_INTEGER;
    taskBilling.set(body.taskId, { accountId, reservedMsat: reserve, perSubtaskReserveMsat: reserve, costMsat: 0, refunded: false, submittedAtMs: Date.now(), ...(nwcSpot ? { nwc: true } : reserve > 0 ? { overflowCapMsat } : {}) });
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
    }, routed || slowAgents.length ? { ...(routed ? { excludeAccounts: [accountId] } : {}), ...(slowAgents.length ? { excludeAgents: slowAgents } : {}) } : undefined);
    if (routed) {
      // Run 9: judged on its expected reply from here on (claim time, the waiting sweep, re-placement).
      noteJudgedOutput(subtask.id, routed.job.job, routed.judgedOutput);
      // A soft preference: the chosen agent gets the call for a moment, then anyone eligible may take it
      // (never the requester's own machines: excludeAccounts above, as in best-fit).
      if (routed.result.chosen?.local) preferAgent(subtask.id, routed.result.chosen.agentId, bestFitConfig.preferMs);
      recordDecision(body.taskId, subtask.id, routed.job, routed.result, Date.now(), portalChoice);
      // #523: nobody picks it up within BEST_FIT_REPLACE_MS: the next candidate, not a 45 s wait (auto-replace.ts).
      if (routed.result.chosen?.local) {
        armAutoReplace({ taskId: body.taskId, subtaskId: subtask.id, job: routed.job, accountId, clientRegion, receivedAtMs, tried: [...slowAgents.filter((id) => id !== routed!.result.chosen!.agentId), routed.result.chosen.agentId], ...(routed.onlyClass ? { onlyClass: routed.onlyClass } : {}), ...(body.maxBidMsatPerCredit !== undefined ? { maxBidMsatPerCredit: body.maxBidMsatPerCredit } : {}) });
      }
    } else {
      if (billed) {
        // A named model: log the decision (Network page, routing decisions), with the portal's
        // coordinator choice when it placed the call. Hosted CLI calls without a choice are logged too.
        recordPlacement(body.taskId, subtask.id, { model: body.model, computeClass: taskClass === "any" ? null : taskClass }, portalChoice);
      }
      // #526: a named network call goes first to the free holder nearest the buyer (locality.ts).
      const near = billed ? nearestFreeHolder(freeLocalHolders(body.model, taskClass, needTokens).filter((h) => !slowAgents.includes(h.agentId)), clientRegion, body.model) : undefined;
      if (near) {
        preferAgent(subtask.id, near.agentId, LOCALITY_PREFER_MS, undefined, { untilPullMs: LOCALITY_PULL_HOLD_MS });
        namedPlacements.set(subtask.id, near.agentId);
      }
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
    const startupBound = holders.length === 0 && inStartupGrace();
    armClaimDeadline(body.taskId, subtask.id, startupBound ? startupClaimBoundMs() : INFERENCE_CLAIM_TIMEOUT_MS);
    armClaimDecision(body.taskId, subtask.id, false, !startupBound && !routed && billed ? INFERENCE_CLAIM_DECISION_MS : 0, { redirected: body.redirected, receivedAtMs });
    app.log.info({ taskId: body.taskId, subtaskId: subtask.id, model: body.model, computeClass: taskClass, reserveMsat: reserve, ...(sized ? { reserveTokenMsat: sized.tokenMsat, reserveFloorMsat: sized.floorMsat, reserveCappedByMaxCSats: sized.capped } : {}), ...(overflowMsat > (sized?.reserveMsat ?? 0) ? { reserveCloudOverflowMsat: overflowMsat } : {}), holders: holders.length, ...(body.redirected ? { redirected: true } : {}) }, "inference_submitted");
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
        // Reading the prompt and writing the reply (Ollama's durations): shown to the requester, and the
        // power floor counts at most their sum (job-pricing.ts floorWorkMs), so time a call waited on a
        // busy host is not billed to it. They only ever lower the price (wall time stays the ceiling).
        promptMs: z.number().min(0).max(INFERENCE_MAX_TIMEOUT_MS).optional(),
        genMs: z.number().min(0).max(INFERENCE_MAX_TIMEOUT_MS).optional(),
        // Why the model stopped ("length": cut at the call's max_tokens), passed to the requester's finish_reason.
        finishReason: z.enum(["stop", "length"]).optional(),
      })
      .parse(req.body);
    let claim = queue.getClaim(body.subtaskId);
    // The holder whose claim just lapsed is still sending the reply, and nobody else took the call:
    // the claim goes back to it (results.ts reclaimLateInferenceResult), so its result is paid once.
    if (claim && !claim.claimedBy && reclaimLateInferenceResult(body.subtaskId, verified.agentId)) {
      clearClaimDeadline(body.subtaskId);
      coordinatorApp.log.info({ subtaskId: body.subtaskId, agentId: verified.agentId }, "late_reply_reclaimed");
      claim = queue.getClaim(body.subtaskId);
    }
    if (!claim || claim.claimedBy !== verified.agentId) return reply.code(403).send({ error: "not_claimant" });
    // A holder posting pieces is alive: its lease is renewed like a heartbeat's, so a heartbeat that is
    // late (rate limited, a busy machine) cannot lapse a call while its reply is streaming.
    queue.renewClaim(body.subtaskId, verified.agentId);
    noteAgentHttpAlive(verified.agentId);
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
        b.servedModel = claim.subtask.requestedModel;
        if (b.submittedAtMs !== undefined && claim.claimedAt !== undefined) b.pickupMs = Math.max(0, claim.claimedAt - b.submittedAtMs);
        if (body.promptMs !== undefined) b.promptMs = Math.round(body.promptMs);
        if (body.genMs !== undefined) b.genMs = Math.round(body.genMs);
        b.finishReason = replyFinishReason(body, maxTokensOf(claim.subtask.input));
      }
    }
    // The requester cancelled (inference-cancel.ts): the agent should stop and report what it produced.
    return reply.code(r === "ok" || r === "duplicate" ? 200 : 409).send({ status: r, ...(requesterCancelled(body.subtaskId) ? { cancelled: true } : {}) });
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
    // Who served it (an ownership lookup): fetched while the result is awaited, not after.
    const servedAgentId = () => billing.servedAgentId ?? queue.getResult(body.subtaskId)?.agentId;
    let servedP = r.done && billing.servedAgentId ? servedBy(billing.servedAgentId, owner, billing) : undefined;
    // The agent's last piece arrives just before its result, which prices the call: wait for it briefly.
    // B2: only until the cost is on the billing entry (pricingInFlight), not for the ledger writes
    // and the refund, which the result route finishes (and settleTaskIfDone below repeats) after.
    let result = r.done ? queue.getResult(body.subtaskId) : undefined;
    for (let i = 0; r.done && (!result || pricingInFlight.has(body.taskId)) && i < 160; i++) {
      await new Promise((res) => setTimeout(res, 25));
      result = queue.getResult(body.subtaskId);
    }
    // The token counts this call was billed on (agent-reported, bounded at /inference/chunks).
    const tokens = {
      ...(billing.promptTokens !== undefined ? { promptTokens: billing.promptTokens } : {}),
      ...(billing.outputTokens !== undefined ? { outputTokens: billing.outputTokens } : {})
    };
    // Why the reply ended ("length": cut at max_tokens), once it has.
    const finish = r.done && billing.finishReason ? { finishReason: billing.finishReason } : {};
    // Settled after the reply: a no-op when the result route already did; a failure is retried by
    // the idle sweep and, after a restart, by the billing restore (billing-restore.ts).
    if (result) void settleTaskIfDone(body.taskId).catch((err) => req.log.warn({ err, taskId: body.taskId }, "stream_settle_failed"));
    const agentId = r.done ? servedAgentId() : undefined;
    if (agentId && !servedP) servedP = servedBy(agentId, owner, billing);
    const served = servedP ? await servedP.catch(() => undefined) : undefined;
    // The model the answering agent ran, so the requester's route line names that attempt's model, not submit's choice.
    const servedModel = r.done ? billing.servedModel ?? queue.getSubtask(body.subtaskId)?.requestedModel : undefined;
    // The call's cost once priced (its result's cost is on the billing entry), the reserve until then.
    const priced = billing.refunded || (result !== undefined && !pricingInFlight.has(body.taskId));
    return reply.send({ ...r, ...finish, ...(result ? { creditsSpent: msatToCSats(priced ? billing.costMsat : billing.reservedMsat), durationMs: result.durationMs, ...tokens } : {}), ...(served ? { served } : {}), ...(servedModel ? { servedModel } : {}) });
  });
}
