// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Inference routes: model list, submit, chunk upload and streaming.
 */
import { z } from "zod";
import type { ResourceClass, Subtask } from "../../../common/types.js";
import { DuplicateDebitError, rewardAccountForAgent, spendCredits } from "../../../credits/store.js";
import { cSatsPerMTokens, msatToCSats, ratePerSecondMsat } from "../../../economy/job-pricing.js";
import { paramsB } from "../../../inference-api/auto-route.js";
import { contextNeeded } from "../../../inference-api/ollama.js";
import type { ChatMessage } from "../../../inference-api/types.js";
import { agentContextWindow, freeModelSlots, preferAgent } from "../dispatch.js";
import { AUTO_MODEL_ID } from "../../../inference-api/auto-route.js";
import { cleanHints, describeJob, type JobDescriptor } from "../../../inference-api/job-descriptor.js";
import type { BestFitResult } from "../best-fit.js";
import { bestFitConfig, complexityWeights, recordDecision, resolveAuto, routingSummary, type RoutingSummary } from "../routing.js";
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
import { agentHasModel, routableModels } from "../../model-catalog.js";
import { rawBodyOf } from "../../../security/request-signing.js";
import { app as coordinatorApp, type CoordinatorApp } from "../app.js";
import { CC, FALLBACK_BTC_USD, claimedTradePrice, reservations, taskBilling, usagePending, queue, identity, securityLog } from "../context.js";
import { mutable } from "../mutable-state.js";
import { agentCapabilities, activeBlacklistRecord, autoBlacklister } from "../agent-state.js";
import { resolveSubmitterAccount, verifyAgentRequest } from "../auth.js";
import {
  effectiveHardware,
  rateOracleConfig,
  classRefMsatPerCredit,
  subtaskReserveMsat,
  orderBook,
  MARKET_DEFAULT_BID_PREMIUM_BPS
} from "../economy.js";
import { taskIdInUse, accrualsInFlight, settleTaskIfDone, refundTaskSubmit } from "../results.js";

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
    if (excluded.has(id) || activeBlacklistRecord(id) || !agentHasModel(cap, subtask.requestedModel ?? "")) continue;
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
  if (subtask.kind !== "inference" || claimDeadlines.has(subtask.id)) return;
  const submittedAtMs = usagePending.get(subtask.taskId)?.atMs;
  if (submittedAtMs === undefined) return;
  armClaimDeadline(subtask.taskId, subtask.id, Math.min(INFERENCE_CLAIM_TIMEOUT_MS, submittedAtMs + subtask.timeoutMs - nowMs));
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
});

export function registerInferenceRoutes(app: CoordinatorApp): void {
  /** Models agents on the network can run now, with how many agents and the price per class. */
  app.get("/inference/models", async () => {
    const now = Date.now();
    const byModel = new Map<string, { agents: number; idle: number; free: number; classes: Set<ComputeClassId> }>();
    const claims = queue.activeClaims();
    for (const [id, cap] of agentCapabilities) {
      if (activeBlacklistRecord(id) || (cap.lastSeenMs !== undefined && now - cap.lastSeenMs > 3 * 60_000)) continue;
      const cls = (effectiveHardware(id, cap)?.computeClass ?? "cpu") as ComputeClassId;
      // #54: only models the agent reported (what it can actually be routed).
      for (const m of new Set(routableModels(cap))) {
        const e = byModel.get(m) ?? { agents: 0, idle: 0, free: 0, classes: new Set<ComputeClassId>() };
        e.agents++;
        if (queue.agentClaims(id) === 0) e.idle++;
        e.free += freeModelSlots(id, claims);
        e.classes.add(cls);
        byModel.set(m, e);
      }
    }
    const classes = Object.fromEntries(
      (Object.keys(rateOracleConfig.computeClasses) as ComputeClassId[]).map((c) => [c, { label: rateOracleConfig.computeClasses[c].label, cSatsPerSecondBaseTier: msatToCSats(ratePerSecondMsat(classRefMsatPerCredit(c), 1)) }])
    );
    return {
      // Model calls are priced per token: cSats per million tokens in and out, by model size.
      models: [...byModel.entries()]
        // idleAgents / freeSlots / waiting: how busy this coordinator is for the model, so the portal can
        // send new calls where a slot is free (inference runs where it was submitted; it is never relayed).
        // freeSlots counts parallel model slots, so two half-busy coordinators still compare by room left.
        .map(([model, e]) => ({ model, agents: e.agents, idleAgents: e.idle, freeSlots: e.free, waiting: queue.waitingInference(model), classes: [...e.classes], cSatsPerMTokens: cSatsPerMTokens(paramsB(model), mutable.latestRateEpoch?.btcUsd ?? FALLBACK_BTC_USD) }))
        .sort((a, b) => b.agents - a.agents || a.model.localeCompare(b.model)),
      classes,
    };
  });

  app.post("/inference/submit", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const body = inferenceSubmitSchema.parse(req.body);
    const submitter = await resolveSubmitterAccount(req as any, body.submitterAccountId, "/inference/submit");
    if ("error" in submitter) return reply.code(submitter.status).send({ error: submitter.error });
    if (submitter.accountId === "anonymous") return reply.code(403).send({ error: "account_required" });
    const accountId = submitter.accountId;
    // model "auto": best-fit routing picks the model, the class and a preferred agent (routing.ts).
    let routed: { job: JobDescriptor; result: BestFitResult; summary: RoutingSummary } | undefined;
    if (body.model === AUTO_MODEL_ID) {
      if (body.reservationId || body.target === "mine") return reply.code(400).send({ error: "auto_network_only", detail: "model auto routes network calls; name a model for your own machines or a reservation" });
      const job = describeJob({ messages: body.messages as ChatMessage[], tools: body.tools, maxTokens: body.maxTokens }, cleanHints(body.routing), complexityWeights);
      const { result, elsewhere } = await resolveAuto(job, { peers: body.routeRedirect, ...(body.computeClass !== "any" ? { computeClass: body.computeClass } : {}) });
      const summary = routingSummary(job, result);
      if (!result.chosen) return reply.code(409).send({ error: "no_route_fits", detail: result.rejected ?? result.reason, routing: summary });
      if (elsewhere) return reply.code(409).send({ error: "route_elsewhere", coordinatorId: elsewhere.coordinatorId, coordinatorUrl: elsewhere.url, routing: summary });
      const chosen = result.chosen;
      body.model = chosen.model;
      body.computeClass = (ACCEPTED_COMPUTE_CLASS_IDS as readonly string[]).includes(chosen.computeClass) ? (chosen.computeClass as typeof body.computeClass) : "any";
      routed = { job, result, summary };
    }
    const holders = [...agentCapabilities.entries()].filter(([id, cap]) => agentHasModel(cap, body.model) && !activeBlacklistRecord(id));
    // Unbilled targets: a lease you already paid for, or your own machines.
    let onlyAccountId: string | undefined;
    let reservationId: string | undefined;
    if (body.reservationId) {
      if (reservations.get(body.reservationId)?.status !== "active") await syncReservations(reservations, pgStore).catch((err) => req.log.warn({ err }, "reservation_sync_failed"));
      const lease = reservations.get(body.reservationId);
      if (!lease || lease.accountId !== accountId || lease.status !== "active" || Date.now() >= lease.endMs) return reply.code(404).send({ error: "reservation_not_active" });
      const cap = agentCapabilities.get(lease.agentId);
      if (!agentHasModel(cap, body.model)) return reply.code(409).send({ error: "reserved_agent_lacks_model", model: body.model, models: cap?.localModelCatalog ?? [] });
      reservationId = lease.id;
    } else if (body.target === "mine") {
      let own = 0;
      for (const [id] of holders) if ((await rewardAccountForAgent(id)) === accountId) own++;
      if (own === 0) return reply.code(409).send({ error: "no_own_agent_has_model", model: body.model });
      onlyAccountId = accountId;
    } else if (!holders.some(([id]) => !reservations.isHeld(id))) {
      return reply.code(409).send({ error: "no_agent_has_model", model: body.model });
    }
    // Every agent with the model serves a smaller context window than this call needs: say so now
    // rather than wait for the no-capacity bound (agents that report no window take any size).
    // Every call has an output cap: what an agent can bill for a reply is bounded by it.
    const maxTokens = body.maxTokens ?? INFERENCE_DEFAULT_MAX_TOKENS;
    const needTokens = contextNeeded(body.messages as ChatMessage[], body.tools, maxTokens);
    if (holders.length > 0 && holders.every(([id]) => (agentContextWindow(id) ?? Infinity) < needTokens)) {
      const largest = Math.max(...holders.map(([id]) => agentContextWindow(id) ?? 0));
      return reply.code(413).send({ error: "context_too_long", neededTokens: needTokens, largestContextWindow: largest, model: body.model });
    }
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
    const resourceClass: ResourceClass = taskClass === "cpu" ? "cpu" : "gpu";
    const reserve = billed ? subtaskReserveMsat(resourceClass, taskClass, body.timeoutMs, resolved.msatPerCredit) : 0;
    if (reserve > 0) {
      // Durable billing (stress finding 2): a restart refunds what this call did not use.
      await pgStore?.insertTaskBilling({ taskId: body.taskId, coordinatorId: identity.peerId, accountId, kind: "inference", perSubtaskReserveMsat: reserve, createdAtMs: Date.now() })
        .catch((err) => req.log.warn({ err, taskId: body.taskId }, "task_billing_persist_failed"));
      try {
        await spendCredits(accountId, msatToCSats(reserve), "inference_reserve", body.taskId, { idempotencyKey: `inference_reserve:${body.taskId}` });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof DuplicateDebitError) return reply.code(409).send({ error: "duplicate_task", taskId: body.taskId });
        if (message.startsWith("insufficient_credits")) return reply.code(402).send({ error: "insufficient_credits", neededCSats: msatToCSats(reserve) });
        req.log.error({ err, taskId: body.taskId }, "inference_debit_failed");
        return reply.code(500).send({ error: "credit_debit_failed" });
      }
    }
    taskBilling.set(body.taskId, { accountId, reservedMsat: reserve, perSubtaskReserveMsat: reserve, costMsat: 0, refunded: false });
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
      input: JSON.stringify({ messages: body.messages, tools: body.tools, maxTokens, temperature: body.temperature }),
      timeoutMs: body.timeoutMs,
      snapshotRef: "inference",
      requestedModel: body.model,
      projectMeta: {
        projectId: `inference:${accountId}`, resourceClass, priority: 60, computeClass: taskClass,
        ...(marketBid ? { maxBidMsatPerCredit: marketBid.maxMsatPerCredit } : {}),
        ...(onlyAccountId ? { onlyAccountId } : {}),
        ...(reservationId ? { reservationId } : {}),
      },
    });
    if (routed) {
      // A soft preference: the chosen agent gets the call for a moment, then anyone eligible may take it.
      if (routed.result.chosen?.local) preferAgent(subtask.id, routed.result.chosen.agentId, bestFitConfig.preferMs);
      recordDecision(body.taskId, subtask.id, routed.job, routed.result);
    }
    inferenceStreams.open(subtask.id, body.taskId);
    armClaimDeadline(body.taskId, subtask.id, INFERENCE_CLAIM_TIMEOUT_MS);
    app.log.info({ taskId: body.taskId, subtaskId: subtask.id, model: body.model, computeClass: taskClass, reserveMsat: reserve, holders: holders.length }, "inference_submitted");
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
        // The agent's model-load time for this call: left out of the power floor (job-pricing.ts). Only
        // the agent is paid by the floor, so reporting more than it spent only lowers its own pay.
        loadMs: z.number().min(0).max(INFERENCE_MAX_TIMEOUT_MS).optional(),
      })
      .parse(req.body);
    const claim = queue.getClaim(body.subtaskId);
    if (claim?.claimedBy !== verified.agentId) return reply.code(403).send({ error: "not_claimant" });
    const r = inferenceStreams.append(body.subtaskId, body.seq, body.delta, body.done, body.error, body.toolCalls);
    // Taken once, from the piece that ended the stream (a refused, repeated or later piece changes
    // nothing), set rather than added, and kept within what the request and the reply could hold.
    if (r === "ok" && body.done && inferenceStreams.isDone(body.subtaskId) && (body.promptTokens !== undefined || body.outputTokens !== undefined)) {
      const bounded = boundTokenCounts(body, Buffer.byteLength(claim.subtask.input, "utf8"), inferenceStreams.replyBytes(body.subtaskId) ?? 0, maxTokensOf(claim.subtask.input));
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
        if (body.loadMs !== undefined) b.loadMs = Math.round(body.loadMs);
      }
    }
    return reply.code(r === "ok" || r === "duplicate" ? 200 : 409).send({ status: r });
  });

  /** The requester reads the reply as it streams (long poll; signed by the requester's own agent). */
  app.post("/inference/stream", async (req, reply) => {
    const body = z.object({ taskId: z.string().min(1), subtaskId: z.string().min(1), after: z.number().int().min(0).default(0), waitMs: z.number().int().min(0).max(25_000).default(15_000) }).parse(req.body);
    const billing = taskBilling.get(body.taskId);
    // A call cancelled for lack of capacity was refunded (its billing entry is gone): its owner is kept with the cancellation.
    const owner = billing?.accountId ?? noCapacity.get(body.taskId)?.accountId;
    const reader = await resolveSubmitterAccount(req as any, owner ?? "", "/inference/stream");
    if ("error" in reader || !owner || reader.accountId !== owner) return reply.code(403).send({ error: "not_requester" });
    // The subtask must be one of this task's: owning a task gives no read of another's stream.
    if (inferenceStreams.taskOf(body.subtaskId) !== body.taskId) return reply.code(404).send({ error: "unknown_stream" });
    if (noCapacity.has(body.taskId)) return noCapacityReply(reply, noCapacity.get(body.taskId));
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
    return reply.send({ ...r, ...(result ? { creditsSpent: msatToCSats(billing.refunded ? billing.costMsat : billing.reservedMsat), durationMs: result.durationMs, ...tokens } : {}) });
  });
}
