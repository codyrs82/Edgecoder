// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Inference routes: model list, submit, chunk upload and streaming.
 */
import { z } from "zod";
import type { ResourceClass } from "../../../common/types.js";
import { DuplicateDebitError, rewardAccountForAgent, spendCredits } from "../../../credits/store.js";
import { cSatsPerMTokens, msatToCSats, ratePerSecondMsat } from "../../../economy/job-pricing.js";
import { paramsB } from "../../../inference-api/auto-route.js";
import { InferenceStreams, boundTokenCounts } from "../../inference-streams.js";
import { pgStore } from "../../../db/store.js";
import {
  ACCEPTED_COMPUTE_CLASS_IDS,
  resolveRequestedClass,
  type ComputeClassId
} from "../../../economy/compute-classes.js";
import { syncReservations } from "../../../economy/reservations.js";
import { agentHasModel, routableModels } from "../../model-catalog.js";
import { rawBodyOf } from "../../../security/request-signing.js";
import type { CoordinatorApp } from "../app.js";
import { FALLBACK_BTC_USD, reservations, taskBilling, usagePending, queue } from "../context.js";
import { mutable } from "../mutable-state.js";
import { agentCapabilities, activeBlacklistRecord } from "../agent-state.js";
import { resolveSubmitterAccount, verifyAgentRequest } from "../auth.js";
import {
  effectiveHardware,
  rateOracleConfig,
  classRefMsatPerCredit,
  subtaskReserveMsat,
  orderBook,
  MARKET_DEFAULT_BID_PREMIUM_BPS
} from "../economy.js";
import { taskIdInUse, accrualsInFlight, settleTaskIfDone } from "../results.js";

// ── Network inference (chat completions on agents' local models, streamed) ──────────────────
export const inferenceStreams = new InferenceStreams();
setInterval(() => inferenceStreams.prune(), 60_000).unref?.();
const INFERENCE_MAX_TIMEOUT_MS = 300_000;

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
});

export function registerInferenceRoutes(app: CoordinatorApp): void {
  /** Models agents on the network can run now, with how many agents and the price per class. */
  app.get("/inference/models", async () => {
    const now = Date.now();
    const byModel = new Map<string, { agents: number; classes: Set<ComputeClassId> }>();
    for (const [id, cap] of agentCapabilities) {
      if (activeBlacklistRecord(id) || (cap.lastSeenMs !== undefined && now - cap.lastSeenMs > 3 * 60_000)) continue;
      const cls = (effectiveHardware(id, cap)?.computeClass ?? "cpu") as ComputeClassId;
      // #54: only models the agent reported (what it can actually be routed).
      for (const m of new Set(routableModels(cap))) {
        const e = byModel.get(m) ?? { agents: 0, classes: new Set<ComputeClassId>() };
        e.agents++;
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
        .map(([model, e]) => ({ model, agents: e.agents, classes: [...e.classes], cSatsPerMTokens: cSatsPerMTokens(paramsB(model), mutable.latestRateEpoch?.btcUsd ?? FALLBACK_BTC_USD) }))
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
    if (taskIdInUse(body.taskId)) return reply.code(409).send({ error: "duplicate_task", taskId: body.taskId });
    const billed = !reservationId && !onlyAccountId;
    const resolved = resolveRequestedClass(body.computeClass, body.maxBidMsatPerCredit, {}, rateOracleConfig.computeClasses);
    const taskClass = (billed ? resolved.computeClass ?? "any" : "any") as ComputeClassId | "any";
    const resourceClass: ResourceClass = taskClass === "cpu" ? "cpu" : "gpu";
    const reserve = billed ? subtaskReserveMsat(resourceClass, taskClass, body.timeoutMs, resolved.msatPerCredit) : 0;
    if (reserve > 0) {
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
    });
    const marketBid = billed ? orderBook.postBid(body.taskId, taskClass, resolved.msatPerCredit, MARKET_DEFAULT_BID_PREMIUM_BPS, Date.now(), {}) : undefined;
    const subtask = queue.enqueueSubtask({
      taskId: body.taskId,
      kind: "inference",
      language: "python",
      input: JSON.stringify({ messages: body.messages, tools: body.tools, maxTokens: body.maxTokens, temperature: body.temperature }),
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
    inferenceStreams.open(subtask.id, body.taskId);
    app.log.info({ taskId: body.taskId, subtaskId: subtask.id, model: body.model, computeClass: taskClass, reserveMsat: reserve, holders: holders.length }, "inference_submitted");
    return reply.send({ taskId: body.taskId, subtaskId: subtask.id, reservedCSats: msatToCSats(reserve), billing: reservationId ? "reservation" : onlyAccountId ? "own_machine" : "per_second" });
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
      })
      .parse(req.body);
    const claim = queue.getClaim(body.subtaskId);
    if (claim?.claimedBy !== verified.agentId) return reply.code(403).send({ error: "not_claimant" });
    const r = inferenceStreams.append(body.subtaskId, body.seq, body.delta, body.done, body.error, body.toolCalls);
    // Taken once, from the piece that ended the stream (a refused, repeated or later piece changes
    // nothing), set rather than added, and kept within what the request and the reply could hold.
    if (r === "ok" && body.done && (body.promptTokens !== undefined || body.outputTokens !== undefined)) {
      const u = usagePending.get(claim.subtask.taskId);
      if (u) {
        const bounded = boundTokenCounts(body, Buffer.byteLength(claim.subtask.input, "utf8"), inferenceStreams.replyBytes(body.subtaskId) ?? 0);
        u.promptTokens = bounded.promptTokens;
        u.outputTokens = bounded.outputTokens;
      }
    }
    return reply.code(r === "ok" || r === "duplicate" ? 200 : 409).send({ status: r });
  });

  /** The requester reads the reply as it streams (long poll; signed by the requester's own agent). */
  app.post("/inference/stream", async (req, reply) => {
    const body = z.object({ taskId: z.string().min(1), subtaskId: z.string().min(1), after: z.number().int().min(0).default(0), waitMs: z.number().int().min(0).max(25_000).default(15_000) }).parse(req.body);
    const billing = taskBilling.get(body.taskId);
    const reader = await resolveSubmitterAccount(req as any, billing?.accountId ?? "", "/inference/stream");
    if ("error" in reader || !billing || reader.accountId !== billing.accountId) return reply.code(403).send({ error: "not_requester" });
    // The subtask must be one of this task's: owning a task gives no read of another's stream.
    if (inferenceStreams.taskOf(body.subtaskId) !== body.taskId) return reply.code(404).send({ error: "unknown_stream" });
    const r = await inferenceStreams.read(body.subtaskId, body.after, body.waitMs);
    if (!r) return reply.code(404).send({ error: "unknown_stream" });
    // The agent's last piece arrives just before its result, which settles the cost: wait for it briefly.
    let result = r.done ? queue.getResult(body.subtaskId) : undefined;
    for (let i = 0; r.done && (!result || accrualsInFlight.has(body.taskId)) && i < 40; i++) {
      await new Promise((res) => setTimeout(res, 100));
      result = queue.getResult(body.subtaskId);
    }
    if (result) await settleTaskIfDone(body.taskId);
    return reply.send({ ...r, ...(result ? { creditsSpent: msatToCSats(billing.refunded ? billing.costMsat : billing.reservedMsat), durationMs: result.durationMs } : {}) });
  });
}
