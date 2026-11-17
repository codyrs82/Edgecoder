// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Task routes: submit, pull and result.
 */
import { inferenceOnlyAgent } from "../../sandbox-enforcement.js";
import { createHash, randomUUID } from "node:crypto";
import { request } from "undici";
import type { z } from "zod";
import { contributionPolicyDecision } from "../../coordinator-utils.js";
import type { ResourceClass, Subtask } from "../../../common/types.js";
import { signPayload } from "../../../mesh/peer.js";
import { verifyForwardedResult } from "../../../mesh/peer-trust.js";
import { buildAgentEnvelope, verifyForwardedAgentEnvelope } from "../../../mesh/forwarded-agent-envelope.js";
import { DuplicateDebitError, rewardAccountForAgent, spendCredits, taskReserveKey } from "../../../credits/store.js";
import { msatToCSats } from "../../../economy/job-pricing.js";
import { pgStore } from "../../../db/store.js";
import { resolveRequestedClass, type ComputeClassId } from "../../../economy/compute-classes.js";
import { capabilityConstraints } from "../../../economy/order-book.js";
import { isProduction } from "../../../common/env-guard.js";
import {
  checkResultClaim,
  classifyResultAuth,
  creditedDurationMs,
  RESULT_ROUTE_BODY_LIMIT_BYTES,
  resultBodyTooLarge,
  serverMeasuredDurationMs
} from "../../result-integrity.js";
import { executorKey, type ExecutionResult, type VerificationOutcome } from "../../verification.js";
import { resultModelMismatch } from "../../model-catalog.js";
import { evaluateAgentPowerPolicy } from "../../power-policy.js";
import {
  createTaskEnvelope,
  decryptResult as decryptEnvelopeResult,
  rederiveEnvelopeSharedKey,
  type EncryptedResult,
  type TaskEnvelope
} from "../../../security/envelope.js";
import { envelopePolicyAllows, envelopeStats } from "../../envelope-policy.js";
import { rawBodyOf } from "../../../security/request-signing.js";
import { lateResultRejectionDurable } from "../../lease-gate.js";
import type { CoordinatorApp } from "../app.js";
import {
  CONTRIBUTION_BURST_CREDITS,
  MIN_CONTRIBUTION_RATIO,
  SUBTASK_RESERVE_TIMEOUT_MS,
  taskBilling,
  taskOriginMap,
  usagePending,
  identity,
  coordinatorKeys,
  INFERENCE_AUTH_TOKEN,
  INFERENCE_URL,
  mesh,
  queue,
  protocol,
  COORDINATOR_PUBLIC_URL,
  IOS_BATTERY_PULL_MIN_INTERVAL_MS,
  IOS_BATTERY_TASK_STOP_LEVEL_PCT,
  claimedTradePrice,
  MESH_AUTH_TOKEN,
  MESH_PEER_ALLOWLIST,
  forwardReplayCache,
  PEER_ALLOWLIST_ENFORCED,
  offeredToPeers,
  remoteGrants,
  REQUIRE_AGENT_SIGNED_FORWARDS,
  type ResultMeta
} from "../context.js";
import { mutable } from "../mutable-state.js";
import {
  ordering,
  agentCapabilities,
  activeBlacklistRecord,
  REQUIRE_VERIFIED_AGENTS,
  lastTaskAssignedByAgent,
  behaviorTracker,
  envelopeSharedKeys,
  ENVELOPE_KEY_TTL_MS,
  ENVELOPE_ROOT_SECRET,
  ENVELOPE_REQUIRED,
  REQUIRE_SIGNED_AGENT_REQUESTS,
  meshBlacklistReason,
  evaluateAndEnforce,
  fastResultVerificationFlags
} from "../agent-state.js";
import { resolveSubmitterAccount, verifyAgentRequest, extractSignedHeaders, hasMeshToken } from "../auth.js";
import {
  rateOracleConfig,
  subtaskReserveMsat,
  marketOrders,
  orderBook,
  MARKET_DEFAULT_BID_PREMIUM_BPS,
  effectiveHardware,
  marketHistory,
  hardwareVerifier,
  repostAsk
} from "../economy.js";
import { depTracker } from "../services.js";
import { coordinatorPublicKeyById } from "../peers.js";
import { persistStatsLedgerRecord } from "../stats-ledger.js";
import { trustedAgentSigningKeys } from "../attested-keys.js";
import { taskSchema, pullSchema, resultSchema } from "../schemas.js";
import {
  taskIdInUse,
  refundTaskSubmit,
  resultVerifier,
  verificationAccountFor,
  enqueueReplica,
  settleVerification,
  holdSettlement,
  publishResult,
  releaseDependents,
  chargePeerWork,
  taskOpenCount,
  offerSubtaskToPeers,
  isPeerOffered,
  peerWorkCostMsat,
  accrueResultCredits,
  settleTaskIfDone
} from "../results.js";
import { inferenceStreams, judgeInferenceReply, retryInferenceElsewhere } from "./inference.js";
import { isMemoryRefusal, noteAgentResult, noteDispatched } from "../memory-admission.js";
import { EMPTY_REPLY_ERROR } from "../../inference-runner.js";
import { judgeResult } from "../../result-outcome.js";
import { claimRule, mayTakeNow, noteAgentPull, noteClaimed } from "../dispatch.js";
import { noteRestrictedOptIn, restrictedCalls, restrictedSubmitGate } from "../restricted.js";
import type { RemoteGrant } from "../../remote-grants.js";

/**
 * The account a job's failures are attributed to for the per-submitter failure cap: the billed
 * requester, else the coordinator that offered it to us, else one shared bucket.
 */
function jobSubmitter(taskId: string, subtaskId: string): string {
  const billed = taskBilling.get(taskId)?.accountId;
  if (billed) return `acct:${billed}`;
  const origin = taskOriginMap.get(subtaskId);
  if (origin) return `peer:${origin.coordinatorId}`;
  return "unattributed";
}

async function enforceContributionFirstPolicy(accountId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!pgStore) return { ok: true };
  const stats = await pgStore.creditContributionStats(accountId);
  const balance = await pgStore.creditBalance(accountId);
  const decision = contributionPolicyDecision(stats, balance, {
    burstCredits: CONTRIBUTION_BURST_CREDITS,
    minRatio: MIN_CONTRIBUTION_RATIO
  });
  return decision.ok ? { ok: true } : decision;
}

/** Open claims any agent may hold (the worker's AGENT_PARALLEL_INFERENCE ceiling). */
const MAX_OPEN_CLAIMS_FLOOR = 16;

export function registerTaskRoutes(app: CoordinatorApp): void {
  app.post("/submit", async (req, reply) => {
    const body = taskSchema.parse(req.body);
    const submitter = await resolveSubmitterAccount(req as any, body.submitterAccountId);
    if ("error" in submitter) return reply.code(submitter.status).send({ error: submitter.error });
    body.submitterAccountId = submitter.accountId;
    // Security research tier: code work runs on the open pool, so a restricted model is refused here
    // (restricted calls go through /inference/submit on your own or leased machines).
    if (body.requestedModel) {
      const gate = await restrictedSubmitGate(body.submitterAccountId, body.requestedModel, { codeTask: true });
      if (!gate.ok) return reply.code(gate.status).send(gate.body);
    }
    if (taskIdInUse(body.taskId)) return reply.code(409).send({ error: "duplicate_task", taskId: body.taskId });
    if (body.submitterAccountId !== "anonymous") {
      const policy = await enforceContributionFirstPolicy(body.submitterAccountId);
      if (!policy.ok) {
        return reply.code(403).send({ error: "contribute_first_required", detail: policy.reason });
      }
      try {
        // Set aside the worst case for one subtask now (topped up once the task is split), settled
        // to the actual cost when it finishes (job-pricing.ts).
        const early = resolveRequestedClass(body.computeClass, body.maxBidMsatPerCredit, {}, rateOracleConfig.computeClasses);
        const perSubtask = subtaskReserveMsat(body.resourceClass as ResourceClass, (early.computeClass ?? "any") as ComputeClassId | "any", SUBTASK_RESERVE_TIMEOUT_MS, early.msatPerCredit);
        // Durable billing first (stress finding 2): a restart resumes or refunds the task. Amounts
        // are read back from the ledger, so a row whose debit never happened refunds nothing.
        // The row is also the task id's one billing record network-wide: an id already billed on
        // the other seed, or by another account or kind, is refused before anything is debited.
        if (pgStore) {
          const billingRow = await pgStore.insertTaskBilling({ taskId: body.taskId, coordinatorId: identity.peerId, accountId: body.submitterAccountId, kind: "job", perSubtaskReserveMsat: perSubtask, createdAtMs: Date.now() });
          if (billingRow === "conflict") return reply.code(409).send({ error: "duplicate_task", taskId: body.taskId });
        }
        // One charge per task id network-wide: one reserve key per task id, whatever its kind.
        await spendCredits(body.submitterAccountId, msatToCSats(perSubtask), "task_reserve", body.taskId, { idempotencyKey: taskReserveKey(body.taskId) });
        taskBilling.set(body.taskId, { accountId: body.submitterAccountId, reservedMsat: perSubtask, perSubtaskReserveMsat: perSubtask, costMsat: 0, refunded: false });
        usagePending.set(body.taskId, { id: body.taskId, accountId: body.submitterAccountId, atMs: Date.now(), kind: "job", placement: "network", computeClass: early.computeClass ?? undefined, ok: false, durationMs: 0, costMsat: 0, ...(body.source ? { source: body.source } : {}) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof DuplicateDebitError) return reply.code(409).send({ error: "duplicate_task", taskId: body.taskId });
        if (message.startsWith("insufficient_credits")) {
          return reply.code(402).send({ error: "insufficient_credits" });
        }
        // DB/lock failures are not "insufficient credits" (#48 review): surface and log them.
        req.log.error({ err, taskId: body.taskId }, "task_submit_debit_failed");
        return reply.code(500).send({ error: "credit_debit_failed" });
      }
    }

    const decomposeBody = JSON.stringify(body);
    const decomposeBodySha256 = createHash("sha256").update(decomposeBody).digest("hex");
    const decomposeTimestampMs = Date.now();
    const decomposeNonce = randomUUID();
    const decomposeSignaturePayload = JSON.stringify({
      peerId: identity.peerId,
      method: "POST",
      path: "/decompose",
      timestampMs: decomposeTimestampMs,
      nonce: decomposeNonce,
      bodySha256: decomposeBodySha256
    });
    const decomposeSignature = signPayload(decomposeSignaturePayload, coordinatorKeys.privateKeyPem);

    const decomposeHeaders: Record<string, string> = {
      "content-type": "application/json"
    };
    if (INFERENCE_AUTH_TOKEN) {
      decomposeHeaders["x-inference-token"] = INFERENCE_AUTH_TOKEN;
    }
    decomposeHeaders["x-coordinator-peer-id"] = identity.peerId;
    decomposeHeaders["x-inference-timestamp-ms"] = String(decomposeTimestampMs);
    decomposeHeaders["x-inference-nonce"] = decomposeNonce;
    decomposeHeaders["x-inference-body-sha256"] = decomposeBodySha256;
    decomposeHeaders["x-inference-signature"] = decomposeSignature;
    const decompose = await request(`${INFERENCE_URL}/decompose`, {
      method: "POST",
      headers: decomposeHeaders,
      body: decomposeBody
    });

    if (decompose.statusCode < 200 || decompose.statusCode >= 300) {
      await refundTaskSubmit(body.taskId);
      return reply.code(502).send({ error: "inference_service_unavailable" });
    }

    const payload = (await decompose.body.json()) as {
      subtasks: Array<{
        taskId: string;
        kind: "micro_loop" | "single_step";
        input: string;
        language: "python" | "javascript";
        timeoutMs: number;
        snapshotRef: string;
        dependsOn?: string[];
        subtaskIndex?: number;
      }>;
    };

    const enqueueRecord = ordering.append({
      eventType: "task_enqueue",
      taskId: body.taskId,
      actorId: body.submitterAccountId
    });
    await pgStore?.persistLedgerRecord(enqueueRecord);
    await persistStatsLedgerRecord(enqueueRecord);
    const billingEntry = taskBilling.get(body.taskId);
    if (billingEntry && payload.subtasks.length > 1) {
      const extra = billingEntry.perSubtaskReserveMsat * (payload.subtasks.length - 1);
      try {
        await spendCredits(billingEntry.accountId, msatToCSats(extra), "task_reserve", body.taskId, { idempotencyKey: `task_reserve_topup:${body.taskId}` });
        billingEntry.reservedMsat += extra;
      } catch (err) {
        await refundTaskSubmit(body.taskId);
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(message.startsWith("insufficient_credits") ? 402 : 500).send({ error: message.startsWith("insufficient_credits") ? "insufficient_credits" : "credit_debit_failed" });
      }
    }

    // If mesh peers exist, delay local claiming to give peers a chance to claim
    // via gossip first (prevents duplicate execution across coordinators).
    const hasMeshPeers = mesh.listPeers().length > 0;
    const GOSSIP_CLAIM_DELAY_MS = 3_000;

    // Market: register the requester's bid for this task (default = reference × premium). A legacy
    // class id maps onto its class, its explicit price into the current unit, and the capability it
    // implied (gpu.c24 => minVramGb 17) so an under-spec card cannot fill it; explicit constraints win.
    const resolved = resolveRequestedClass(body.computeClass, body.maxBidMsatPerCredit, { minVramGb: body.minVramGb, minMemoryGb: body.minMemoryGb, minReliability: body.minReliability }, rateOracleConfig.computeClasses);
    const taskClass = resolved.computeClass as ComputeClassId | "any"; // validated by taskSchema
    const explicitBid = resolved.msatPerCredit;
    const constraints = capabilityConstraints(resolved.constraints);
    const standingBuy = marketOrders.get(`${body.submitterAccountId}:buy`);
    const bidCeiling = explicitBid ?? (standingBuy && (standingBuy.computeClass === "any" || standingBuy.computeClass === taskClass) ? standingBuy.msatPerCredit : undefined);
    const marketBid = orderBook.postBid(body.taskId, taskClass, bidCeiling, MARKET_DEFAULT_BID_PREMIUM_BPS, Date.now(), constraints);

    // Assign stable IDs before scheduling so dependsOn references resolve
    const subtasksWithIds = payload.subtasks.map((s) => ({
      ...s,
      id: randomUUID(),
      requestedModel: body.requestedModel,
      projectMeta: {
        projectId: body.projectId,
        tenantId: body.tenantId,
        resourceClass: body.resourceClass as ResourceClass,
        priority: body.priority,
        computeClass: taskClass,
        maxBidMsatPerCredit: marketBid.maxMsatPerCredit,
        ...constraints
      }
    }));

    // Which subtasks make up the task, for a restart to tell whether it can resume them.
    if (taskBilling.has(body.taskId)) {
      await pgStore?.setTaskBillingSubtasks(body.taskId, subtasksWithIds.map((s) => s.id)).catch((err) => req.log.warn({ err, taskId: body.taskId }, "task_billing_persist_failed"));
    }

    // Detect circular dependencies and warn (enqueue anyway to avoid deadlock)
    const circularIds = depTracker.detectCircularDeps(subtasksWithIds);
    if (circularIds.size > 0) {
      app.log.warn(
        { taskId: body.taskId, circularIds: [...circularIds] },
        "circular_subtask_dependencies_detected_enqueuing_anyway"
      );
    }

    // The ids were minted above, so no lease state can be stored under them: claimable at once
    // (without freshId every job subtask waited on two Postgres round trips before a pull saw it).
    const enqueueOpts = { freshId: true, ...(hasMeshPeers ? { claimDelayMs: GOSSIP_CLAIM_DELAY_MS } : {}) };
    const created: Subtask[] = [];
    const deferred: string[] = [];

    for (const subtask of subtasksWithIds) {
      const deps = subtask.dependsOn;
      const hasDeps = Array.isArray(deps) && deps.length > 0;
      const isCircular = circularIds.has(subtask.id);

      if (hasDeps && !isCircular) {
        // Hold until dependencies complete
        depTracker.hold({
          subtask,
          dependsOn: deps!,
          enqueueOpts
        });
        deferred.push(subtask.id);
      } else {
        // Enqueue immediately (no deps, or circular — enqueue to prevent deadlock)
        const enqueued = queue.enqueueSubtask(subtask, enqueueOpts);
        created.push(enqueued);
      }
    }

    // Gossip each immediately-enqueued subtask as a task_offer to peer coordinators
    for (const subtask of created) offerSubtaskToPeers(subtask);

    const allIds = [...created.map((s) => s.id), ...deferred];
    const message = protocol.createMessage(
      "queue_summary",
      identity.peerId,
      { taskId: body.taskId, queued: created.length, deferred: deferred.length, projectId: body.projectId },
      coordinatorKeys.privateKeyPem
    );
    void mesh.broadcast(message);

    return reply.send({ taskId: body.taskId, subtasks: allIds });
  });

  app.post("/pull", async (req, reply) => {
    const verified = await verifyAgentRequest((req as any).headers ?? {}, "/pull", req.ip, { rawBody: rawBodyOf(req) });
    if (verified === "rejected") return reply.code(401).send({ error: "signature_invalid" });

    const body = pullSchema.parse(req.body);
    if (verified && verified.agentId !== body.agentId) {
      return reply.code(401).send({ error: "agent_id_mismatch" });
    }
    if (!agentCapabilities.has(body.agentId)) {
      return reply.code(401).send({ error: "mesh_unauthorized", reason: "agent_not_registered" });
    }
    const blacklisted = activeBlacklistRecord(body.agentId);
    if (blacklisted) {
      return reply.send({ subtask: null, blocked: true, reason: blacklisted.reason });
    }
    const capability = agentCapabilities.get(body.agentId);
    // Verified-only policy: /register stores the agent before its integrity check refuses it, so the
    // check is enforced where work is handed out too.
    if (REQUIRE_VERIFIED_AGENTS && (capability as { verificationStatus?: string } | undefined)?.verificationStatus !== "verified") {
      return reply.code(403).send({ error: "binary_integrity_required" });
    }
    let powerDecisionForPull: ReturnType<typeof evaluateAgentPowerPolicy> | undefined;
    if (capability) {
      powerDecisionForPull = evaluateAgentPowerPolicy({
        os: capability.os,
        telemetry: capability.powerTelemetry,
        nowMs: Date.now(),
        lastTaskAssignedAtMs: lastTaskAssignedByAgent.get(body.agentId),
        batteryPullMinIntervalMs: IOS_BATTERY_PULL_MIN_INTERVAL_MS,
        batteryTaskStopLevelPct: IOS_BATTERY_TASK_STOP_LEVEL_PCT
      });
      if (!powerDecisionForPull.allowCoordinatorTasks) {
        return reply.send({ subtask: null, powerDeferred: true, reason: powerDecisionForPull.reason });
      }
      if (powerDecisionForPull.deferMs && powerDecisionForPull.deferMs > 0) {
        return reply.send({ subtask: null, powerDeferred: true, deferMs: powerDecisionForPull.deferMs, reason: powerDecisionForPull.reason });
      }
    }
    // #45: code subtasks need a sandbox. An agent without one claims inference subtasks only
    // (they run a model, never task code); the rule is applied inside claim() below, so nothing
    // is claimed and requeued for an agent that may not run it.
    const inferenceOnly = inferenceOnlyAgent(capability);
    const pullerAccount = await rewardAccountForAgent(body.agentId);
    // Fast dispatch (dispatch.ts): the agent's model slots, and whether it takes work_available nudges.
    noteAgentPull(body.agentId, body);
    // Security research tier: only a signed pull can opt this agent in to restricted models.
    noteRestrictedOptIn(body.agentId, Boolean(verified), body.allowRestrictedModels, pullerAccount);
    const canTake = claimRule(body.agentId, capability, pullerAccount);
    const claims = queue.activeClaims();
    const nowMs = Date.now();
    const task = queue.claim(
      body.agentId,
      capability?.activeModel,
      pullerAccount,
      // The book enforces the bid's class, price and constraints. The subtask's own constraints are
      // checked too, so a task gossiped from a peer (no local bid) still cannot go to an under-spec agent.
      // A model call also needs a free slot, and is left briefly to an idle agent when this one is busy.
      // Task privacy: with ENVELOPE_REQUIRED an agent without an envelope key takes no user data.
      (subtask) => canTake(subtask) && mayTakeNow(body.agentId, subtask, claims, nowMs) && envelopePolicyAllows(capability, subtask, ENVELOPE_REQUIRED),
      // Claim hoarding: open claims per agent are bounded by what it declared, never below the
      // worker's parallel-inference ceiling (16) and never above the schema's 64.
      Math.max(capability?.maxConcurrentTasks ?? 1, MAX_OPEN_CLAIMS_FLOOR)
    );
    // Envelope encryption: an agent that registered an X25519 key only ever gets the subtask
    // encrypted. Built before anything about the claim is recorded, so a failure hands the subtask
    // straight back (it stays claimable for others) and nothing is sent in plaintext.
    const agentX25519 = capability?.x25519PublicKey;
    let envelope: TaskEnvelope | undefined;
    if (task && agentX25519) {
      try {
        const built = createTaskEnvelope(
          { input: task.input, snapshotRef: task.snapshotRef, kind: task.language },
          Buffer.from(agentX25519, "base64"),
          task.id,
          { taskId: task.taskId, resourceClass: task.projectMeta?.resourceClass, priority: task.projectMeta?.priority, language: task.language, timeoutMs: task.timeoutMs, kind: task.kind, requestedModel: task.requestedModel, ...(task.projectMeta?.onlyAccountId ? { onlyAccountId: task.projectMeta.onlyAccountId } : {}) },
          { rootSecret: ENVELOPE_ROOT_SECRET }
        );
        envelope = built.envelope;
        envelopeSharedKeys.set(task.id, { key: built.sharedKey, createdAtMs: Date.now() });
        const now = Date.now();
        for (const [sid, entry] of envelopeSharedKeys) {
          if (now - entry.createdAtMs > ENVELOPE_KEY_TTL_MS) envelopeSharedKeys.delete(sid);
        }
      } catch (envelopeErr) {
        envelopeStats.encryptFailed += 1;
        queue.requeue(task.id);
        app.log.error({ subtaskId: task.id, agentId: body.agentId, error: String(envelopeErr) }, "envelope_encryption_failed");
        return reply.code(503).send({ error: "envelope_encryption_failed" });
      }
    }
    if (task) noteClaimed(task.id);
    // Host memory: a call for a model not loaded there counts against the agent's headroom until it shows as loaded.
    if (task?.kind === "inference") noteDispatched(body.agentId, task.requestedModel, nowMs);
    if (task) restrictedCalls.claimed(task.id, body.agentId, pullerAccount);
    if (task) {
      // Market: the trade prices at the agent's ask; remembered per subtask for accrual.
      const match = orderBook.canMatch(body.agentId, task.taskId);
      if (match.ok) {
        claimedTradePrice.set(task.id, { msatPerCredit: match.msatPerCredit, computeClass: match.computeClass, creditsPerSecond: effectiveHardware(body.agentId, capability)?.creditsPerSecond ?? 1 });
        const trade = { taskId: task.taskId, subtaskId: task.id, agentId: body.agentId, computeClass: match.computeClass, msatPerCredit: match.msatPerCredit, atMs: Date.now() };
        orderBook.recordTrade(trade);
        marketHistory.recordTrade(trade);
        void pgStore?.persistMarketTrade(trade).catch(() => undefined);
      }

      // ── Power policy: small-tasks-only check ──
      if (powerDecisionForPull?.allowSmallTasksOnly && task.timeoutMs > 10_000) {
        app.log.info({ subtaskId: task.id, agentId: body.agentId, reason: powerDecisionForPull.reason }, "power_small_task_filter");
        queue.requeue(task.id);
        return reply.send({ subtask: null, powerDeferred: true, reason: powerDecisionForPull.reason });
      }

      lastTaskAssignedByAgent.set(body.agentId, Date.now());
      behaviorTracker.recordTaskClaim(body.agentId);
      // #106: remember who took a verification replica, so abandoning it can't force an unverified payout.
      // #162: keyed on the reward account, so a new agent id on the same account is still the abandoner.
      if (resultVerifier.isReplica(task.id)) resultVerifier.markReplicaClaimed(task.id, body.agentId, pullerAccount);
      const claimRecord = ordering.append({
        eventType: "task_claim",
        taskId: task.taskId,
        subtaskId: task.id,
        actorId: body.agentId
      });
      await pgStore?.persistLedgerRecord(claimRecord);
      await persistStatsLedgerRecord(claimRecord);

      if (envelope) {
        envelopeStats.encrypted += 1;
        app.log.info({ subtaskId: task.id, agentId: body.agentId }, "task_encrypted_with_envelope");
        return reply.send({ subtask: null, envelope });
      }
      // No envelope key (older agent builds, the iOS app): plaintext, counted so the operator can
      // see when ENVELOPE_REQUIRED can be turned on.
      envelopeStats.plaintext += 1;
      app.log.info({ subtaskId: task.id, agentId: body.agentId, os: capability?.os }, "task_delivered_plaintext");
    }
    // inferenceOnly tells a sandbox-less agent why it only ever gets inference work.
    return reply.send({ subtask: task ?? null, ...(inferenceOnly ? { inferenceOnly: true } : {}) });
  });

  // #122: a peer forward carries the output twice (plaintext + the agent's signed body), so the route
  // limit fits a forwarded max-size agent result; agents themselves stay at the old 1 MiB.
  app.post("/result", { bodyLimit: RESULT_ROUTE_BODY_LIMIT_BYTES }, async (req, reply) => {
    {
      const h = (req as any).headers ?? {};
      const peerForwardCandidate = !extractSignedHeaders(h) && hasMeshToken(h);
      if (resultBodyTooLarge(Buffer.byteLength(rawBodyOf(req)), peerForwardCandidate)) {
        return reply.code(413).send({ error: "payload_too_large" });
      }
    }
    // allowUnsigned only so the mesh-token peer-forward path below can be evaluated; plain
    // unsigned agent results are still rejected when REQUIRE_SIGNED_AGENT_REQUESTS is on.
    const verified = await verifyAgentRequest((req as any).headers ?? {}, "/result", req.ip, { allowUnsigned: true, rawBody: rawBodyOf(req) });
    if (verified === "rejected") return reply.code(401).send({ error: "signature_invalid" });

    const rawBody = req.body as Record<string, unknown>;

    // Check if this is an encrypted envelope result
    const isEncrypted = typeof rawBody.subtaskId === "string" && typeof rawBody.encryptedPayload === "string";
    let sharedKey = isEncrypted ? envelopeSharedKeys.get(rawBody.subtaskId as string)?.key : undefined;
    if (isEncrypted && !sharedKey) {
      // Not cached (this coordinator restarted since the claim, or the cache entry expired): the
      // key is re-derived from the coordinator's envelope root and the agent's registered key. A
      // restarted coordinator has the agent's key again once it re-registers, which it must do
      // before its signed result is accepted at all.
      const agentId = verified ? verified.agentId : typeof rawBody.agentId === "string" ? rawBody.agentId : undefined;
      const agentX25519 = agentId ? agentCapabilities.get(agentId)?.x25519PublicKey : undefined;
      if (agentX25519) {
        try {
          sharedKey = rederiveEnvelopeSharedKey(ENVELOPE_ROOT_SECRET, rawBody.subtaskId as string, Buffer.from(agentX25519, "base64"));
          envelopeStats.rederived += 1;
        } catch {
          sharedKey = undefined;
        }
      }
    }
    let body: z.infer<typeof resultSchema>;
    let envelopeKey: Buffer | undefined;
    if (isEncrypted && !sharedKey) {
      envelopeStats.decryptFailed += 1;
      app.log.error({ subtaskId: rawBody.subtaskId }, "envelope_result_key_unavailable");
      return reply.code(400).send({ error: "envelope_decrypt_failed" });
    }
    if (sharedKey && isEncrypted) {
      try {
        const decrypted = decryptEnvelopeResult(rawBody as unknown as EncryptedResult, sharedKey);
        envelopeSharedKeys.delete(rawBody.subtaskId as string);
        envelopeKey = sharedKey;
        body = resultSchema.parse({
          ...decrypted,
          subtaskId: rawBody.subtaskId,
          taskId: rawBody.taskId,
          agentId: rawBody.agentId,
          reportNonce: rawBody.reportNonce,
          reportSignature: rawBody.reportSignature,
          model: rawBody.model,
          receipt: rawBody.receipt,
        });
        app.log.info({ subtaskId: body.subtaskId }, "result_decrypted_from_envelope");
      } catch (decryptErr) {
        envelopeStats.decryptFailed += 1;
        app.log.error({ subtaskId: rawBody.subtaskId, error: String(decryptErr) }, "envelope_result_decrypt_failed");
        return reply.code(400).send({ error: "envelope_decrypt_failed" });
      }
    } else {
      body = resultSchema.parse(rawBody);
    }

    if (verified && verified.agentId !== body.agentId) {
      return reply.code(401).send({ error: "agent_id_mismatch" });
    }
    const blacklisted = activeBlacklistRecord(body.agentId);
    if (blacklisted) {
      return reply.code(403).send({ error: "agent_blacklisted", reason: blacklisted.reason });
    }
    // ── #51: a result from a holder whose lease expired is late; reject before anything else ──
    const late = await lateResultRejectionDurable(queue, body.subtaskId, body.agentId);
    if (late) return reply.code(late.statusCode).send(late.body);
    // ── #44: claim ownership, before anything is recorded ──
    const claim = queue.getClaim(body.subtaskId);
    // Results forwarded by a peer coordinator (gossip-offered subtask executed elsewhere) carry the
    // mesh token but no agent signature and have no local claim. They are accepted for bookkeeping
    // and dependency release only; no credits are accrued here.
    const resultAuth = classifyResultAuth({
      verified,
      // #44 review: "locally owned" only if a local agent actually claimed it; an unclaimed
      // queued copy of a gossiped subtask must still accept the relayed result.
      hasLocalClaim: Boolean(claim?.claimedBy),
      meshTokenConfigured: MESH_AUTH_TOKEN !== "",
      meshTokenValid: hasMeshToken((req as any).headers ?? {}),
      requireSigned: REQUIRE_SIGNED_AGENT_REQUESTS
    });
    if (resultAuth === "reject") return reply.code(401).send({ error: "signature_required" });
    const isPeerForward = resultAuth === "peer_forward";
    let grantedForward: RemoteGrant | undefined;
    if (isPeerForward) {
      // #52: a forwarded result must be signed by an allowlisted peer coordinator.
      const fwd = verifyForwardedResult({
        headers: (req as any).headers ?? {},
        // #118 review: verify the exact bytes received, not a re-serialization.
        bodyJson: (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(rawBody),
        allowlist: MESH_PEER_ALLOWLIST,
        production: isProduction(),
        publicKeyFor: (id) => (id === identity.peerId ? null : coordinatorPublicKeyById(id)),
        replay: forwardReplayCache
      });
      if (!fwd.ok) {
        app.log.warn({ subtaskId: body.subtaskId, error: fwd.error }, "forwarded_result_rejected");
        return reply.code(fwd.code).send({ error: fwd.error });
      }
      // A re-sent forward of a result already recorded gets the same answer and is not charged again.
      const settledCharge = remoteGrants.settledCharge(body.subtaskId, fwd.fromPeerId ?? "", Date.now());
      if (settledCharge !== undefined) return reply.send({ ok: true, duplicate: true, chargedMsat: settledCharge });
      // #118 review: only results for subtasks we offered to peers, and only once each.
      if (PEER_ALLOWLIST_ENFORCED) {
        const exp = offeredToPeers.get(body.subtaskId);
        if (exp === undefined || exp <= Date.now()) {
          app.log.warn({ subtaskId: body.subtaskId, from: fwd.fromPeerId }, "forwarded_result_not_offered");
          return reply.code(403).send({ error: "subtask_not_offered" });
        }
        offeredToPeers.delete(body.subtaskId);
      }
      // #122: the result itself must be signed by the agent that produced it.
      const agentCheck = await verifyForwardedAgentEnvelope({
        result: body,
        envelope: rawBody.agentEnvelope,
        required: REQUIRE_AGENT_SIGNED_FORWARDS,
        agentKeys: trustedAgentSigningKeys,
        blacklisted: meshBlacklistReason
      });
      if (!agentCheck.ok) {
        app.log.warn({ subtaskId: body.subtaskId, from: fwd.fromPeerId, agentId: agentCheck.agentId, error: agentCheck.error }, "forwarded_result_agent_check_failed");
        return reply.code(agentCheck.code).send({ error: agentCheck.error });
      }
      if (agentCheck.mode === "legacy_unenveloped") {
        app.log.warn({ subtaskId: body.subtaskId, from: fwd.fromPeerId }, "forwarded_result_without_agent_signature_accepted");
      }
      // Only the peer this coordinator granted the subtask to, once (src/swarm/remote-grants.ts).
      const admission = remoteGrants.admitForward(body.subtaskId, fwd.fromPeerId ?? "", Date.now());
      if (admission.kind === "duplicate") return reply.send({ ok: true, duplicate: true, chargedMsat: admission.chargedMsat });
      if (admission.kind === "in_progress") return reply.code(409).send({ error: "forward_in_progress" });
      if (admission.kind === "not_granted") {
        app.log.warn({ subtaskId: body.subtaskId, from: fwd.fromPeerId }, "forwarded_result_not_granted");
        return reply.code(409).send({ error: "subtask_not_granted" });
      }
      grantedForward = admission.grant;
      // The grant names the task: a forward cannot charge another one.
      body = { ...body, taskId: admission.grant.subtask.taskId };
    }
    // #122: kept with the result so the origin coordinator can check the agent's own signature.
    const signedHeaders = verified ? extractSignedHeaders((req as any).headers ?? {}) : null;
    const agentEnvelope = signedHeaders ? buildAgentEnvelope(signedHeaders, rawBodyOf(req), envelopeKey) : undefined;
    if (!isPeerForward) {
      const claimCheck = checkResultClaim(claim, body.agentId);
      if (!claimCheck.ok) return reply.code(claimCheck.code).send({ error: claimCheck.error });
    }
    const subtask = isPeerForward ? undefined : claim?.subtask;
    // #54: the agent says (signed) which model ran; it must be the one requested.
    if (subtask && resultModelMismatch(subtask.requestedModel, body.model)) {
      app.log.warn({ subtaskId: body.subtaskId, agentId: body.agentId, requestedModel: subtask.requestedModel, reportedModel: body.model }, "result_model_mismatch");
      return reply.code(409).send({ error: "result_model_mismatch", requestedModel: subtask.requestedModel });
    }
    // The claimed subtask says which task this result belongs to. Workers before 1.4.12 derived the
    // task id of an encrypted (envelope) task from the subtask id, so the requester's poll, which
    // matches on task id, never found the result.
    if (subtask && body.taskId !== subtask.taskId) body = { ...body, taskId: subtask.taskId };
    // A model call that produced no text and no tool call failed, whatever the agent says (agents
    // before this rule reported it as a success): it is not charged, and may be retried below.
    if (subtask?.kind === "inference" && body.ok && !(body.output ?? "").trim() && !inferenceStreams.hasContent(body.subtaskId)) {
      body = { ...body, ok: false, output: "", error: EMPTY_REPLY_ERROR };
    }
    // Server-side duration: never more than measured since claim or the subtask timeout.
    const durationMs = claim ? creditedDurationMs(body.durationMs, claim) : 0;
    // The program failed, or the agent did (src/swarm/result-outcome.ts). Only the agent's failures
    // count against it, and only a program error it credibly ran is paid. A peer-offered subtask's
    // failure is not (its origin charges only successes).
    const judgement = judgeResult(body, { kind: claim?.subtask.kind, serverMeasuredMs: claim ? serverMeasuredDurationMs(claim) : 0 });
    if (judgement.rejectedClaim) {
      app.log.warn({ subtaskId: body.subtaskId, agentId: body.agentId, reason: judgement.rejectedClaim }, "program_error_claim_rejected");
    }
    const payableFailure = judgement.payableFailure && !isPeerForward && !isPeerOffered(body.subtaskId);
    // Ongoing hardware evidence: real work against the verified tier (server clock, not the agent's).
    // The ask is re-posted every time so its reliability score (minReliability bids) stays current.
    // The agent handed the call back for memory ("memory_..."): not a failure of the agent, but no
    // more calls for that model to it for a while (memory-admission.ts). Other model-call results
    // feed its circuit breaker (a failure counts, a success closes it). Code results do not: a buyer
    // controls whether its program fails, and must not be able to cool an honest agent down (BHV004).
    const memoryRefusal = !isPeerForward && !!claim && !body.ok && isMemoryRefusal(body.error);
    if (!isPeerForward && claim?.subtask.kind === "inference") noteAgentResult(body.agentId, claim.subtask.requestedModel, judgement.outcome !== "agent_failure", body.error);
    if (!isPeerForward && claim?.claimedAt && !memoryRefusal) {
      const nowMs = Date.now();
      // Model calls carry the model's real token count (reported with the last streamed piece).
      hardwareVerifier.recordTask(body.agentId, { ok: judgement.outcome !== "agent_failure", outputChars: (body.output ?? "").length, elapsedMs: nowMs - claim.claimedAt, outputTokens: usagePending.get(body.taskId)?.outputTokens }, nowMs);
      repostAsk(body.agentId, nowMs);
    }

    // ── Behavioral monitoring ── (skipped for peer-forwarded results: body.agentId is unauthenticated there)
    if (!isPeerForward && claim && !memoryRefusal) {
      // BHV001 judges speed by the coordinator's clock (claim to receipt), never the reported duration.
      behaviorTracker.recordTaskResult(body.agentId, {
        ok: body.ok,
        output: body.output,
        durationMs: serverMeasuredDurationMs(claim),
        kind: claim.subtask.kind,
        outcome: judgement.outcome,
        submitter: jobSubmitter(body.taskId, body.subtaskId),
        subtaskId: body.subtaskId
      });
      evaluateAndEnforce(body.agentId);
    }

    // A failed model call that reached the requester with nothing goes to another agent once
    // (routes/inference.ts): no result is recorded and nothing is charged for this run.
    if (!isPeerForward && subtask?.kind === "inference" && !body.ok && (await retryInferenceElsewhere(subtask, body.agentId, body.error))) {
      return reply.send({ ok: true, retried: true });
    }

    // ── #50: sampled results are held for redundant verification ──
    // A held result (or a replica) doesn't release dependents or earn until the
    // verification settles (see settleVerification).
    let verificationHold = false;
    let verificationOutcome: VerificationOutcome<ResultMeta> | null = null;
    // Peer-forwarded results skip verification here: their agentId is unauthenticated and
    // they earn nothing on this coordinator; the coordinator that ran the claim verifies
    // (and holds) before paying or forwarding.
    if (!isPeerForward && subtask) {
      const execution: ExecutionResult<ResultMeta> = {
        subtaskId: body.subtaskId,
        agentId: body.agentId,
        accountId: await verificationAccountFor(body.agentId),
        ok: body.ok,
        output: body.output ?? "",
        meta: { report: body, taskId: body.taskId, durationMs, reportedDurationMs: body.durationMs, subtask, agentEnvelope, payableFailure }
      };
      if (resultVerifier.isReplica(body.subtaskId)) {
        verificationHold = true;
        const r = resultVerifier.recordReplica(body.subtaskId, execution);
        if (r && r.status === "pending") enqueueReplica(r.next);
        else if (r) verificationOutcome = r;
      } else if (resultVerifier.shouldVerify(executorKey(execution), subtask.kind, { force: resultVerifier.samplesKind(subtask.kind) && fastResultVerificationFlags.take(body.agentId) })) {
        verificationHold = true;
        enqueueReplica(resultVerifier.start(subtask, execution));
        app.log.info({ subtaskId: body.subtaskId, agentId: body.agentId }, "result_held_for_verification");
      }
    }

    if (verificationHold) {
      // #50: held original or replica. Nothing is visible to the requester or the origin
      // coordinator, and nothing is paid, until the verdict (settleVerification).
      queue.removeHeld(body.subtaskId);
      if (verificationOutcome) await settleVerification(verificationOutcome);
      await mutable.verificationWrites; // #105: the held state is stored before the agent is told
      return reply.send({ ok: true, held: true });
    }

    // The result is visible to the requester's stream read from here on, and that read settles the
    // task: it must not return the reserve before this result's cost has been taken from it.
    const releaseSettlement = holdSettlement(body.taskId);
    let chargedMsat = 0;
    let recorded = false;
    try {
      // For a subtask a peer offered us: its cost here goes to the origin with the result, and what the
      // origin charged for it (the forward's answer) is what the agent may be paid.
      const execution: ExecutionResult<ResultMeta> | undefined = subtask
        ? { subtaskId: body.subtaskId, agentId: body.agentId, ok: body.ok, output: body.output ?? "", meta: { report: body, taskId: body.taskId, durationMs, reportedDurationMs: body.durationMs, subtask, payableFailure } }
        : undefined;
      const peerCostMsat = execution && isPeerOffered(body.subtaskId) ? peerWorkCostMsat(execution) : undefined;
      const originChargedMsat = await publishResult(body, agentEnvelope, peerCostMsat);
      recorded = true;
      // Pieces lost on the way would leave the requester with less than the result it pays for.
      if (body.ok && subtask?.kind === "inference" && inferenceStreams.backfill(body.subtaskId, body.output ?? "")) {
        app.log.warn({ subtaskId: body.subtaskId, agentId: body.agentId }, "inference_stream_backfilled");
      }
      // Token padding: a reply that turns degenerate is billed for its clean prefix only.
      if (body.ok && subtask?.kind === "inference" && execution) {
        execution.meta.durationMs = judgeInferenceReply(subtask, body.agentId, body.output ?? "", execution.meta.durationMs).durationMs;
      }
      inferenceStreams.finish(body.subtaskId, body.ok ? undefined : body.error ?? "failed");
      // ── Dependency tracking: store output and release dependent subtasks ──
      releaseDependents(body.subtaskId, body.output ?? "");
      if (grantedForward) {
        // Ran on the granted peer: charged what the peer says it cost (its pricing, signed with the
        // forward), never more than the worst case for one subtask nor than what the task has left;
        // a peer that sends no cost (older build) is charged the worst case, as before. Failed work is
        // not charged. The answer tells the peer what it may pay its agent; the unused rest of the
        // reserve goes back to the requester when the task settles.
        const worstCase = taskBilling.get(body.taskId)?.perSubtaskReserveMsat ?? 0;
        const reported = (rawBody as { peerCostMsat?: unknown }).peerCostMsat;
        const peerCost = typeof reported === "number" && Number.isFinite(reported) && reported >= 0 ? reported : worstCase;
        chargedMsat = body.ok ? chargePeerWork(body.taskId, Math.min(peerCost, worstCase)) : 0;
        remoteGrants.settle(body.subtaskId, chargedMsat, Date.now());
        if (taskOpenCount(body.taskId) === 0) orderBook.removeBid(body.taskId);
      }

      if (execution) await accrueResultCredits(execution, { originChargedMsat });
    } finally {
      // Nothing recorded: the granted peer may send the result again.
      if (grantedForward && !recorded) remoteGrants.release(body.subtaskId);
      releaseSettlement();
    }
    await settleTaskIfDone(body.taskId);
    return reply.send({ ok: true, ...(grantedForward ? { chargedMsat } : {}) });
  });
}
