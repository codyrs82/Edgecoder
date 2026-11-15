// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Task routes: submit, pull and result.
 */
import { agentMayClaim, inferenceOnlyAgent } from "../../sandbox-enforcement.js";
import { createHash, randomUUID } from "node:crypto";
import { request } from "undici";
import type { z } from "zod";
import { contributionPolicyDecision } from "../../coordinator-utils.js";
import type { ResourceClass, Subtask } from "../../../common/types.js";
import { signPayload } from "../../../mesh/peer.js";
import { verifyForwardedResult } from "../../../mesh/peer-trust.js";
import { buildAgentEnvelope, verifyForwardedAgentEnvelope } from "../../../mesh/forwarded-agent-envelope.js";
import { DuplicateDebitError, rewardAccountForAgent, spendCredits } from "../../../credits/store.js";
import { msatToCSats } from "../../../economy/job-pricing.js";
import { pgStore } from "../../../db/store.js";
import { resolveRequestedClass, type ComputeClassId } from "../../../economy/compute-classes.js";
import { capabilityConstraints, meetsCapability } from "../../../economy/order-book.js";
import { isProduction } from "../../../common/env-guard.js";
import {
  checkResultClaim,
  classifyResultAuth,
  creditedDurationMs,
  RESULT_ROUTE_BODY_LIMIT_BYTES,
  resultBodyTooLarge
} from "../../result-integrity.js";
import { executorKey, type ExecutionResult, type VerificationOutcome } from "../../verification.js";
import { resultModelMismatch, subtaskModelEligible } from "../../model-catalog.js";
import { evaluateAgentPowerPolicy } from "../../power-policy.js";
import {
  createTaskEnvelope,
  decryptResult as decryptEnvelopeResult,
  type EncryptedResult
} from "../../../security/envelope.js";
import { rawBodyOf } from "../../../security/request-signing.js";
import { lateResultRejectionDurable } from "../../lease-gate.js";
import type { CoordinatorApp } from "../app.js";
import {
  CONTRIBUTION_BURST_CREDITS,
  MIN_CONTRIBUTION_RATIO,
  SUBTASK_RESERVE_TIMEOUT_MS,
  taskBilling,
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
  reservations,
  claimedTradePrice,
  MESH_AUTH_TOKEN,
  MESH_PEER_ALLOWLIST,
  forwardReplayCache,
  PEER_ALLOWLIST_ENFORCED,
  offeredToPeers,
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
  REQUIRE_SIGNED_AGENT_REQUESTS,
  meshBlacklistReason,
  evaluateAndEnforce
} from "../agent-state.js";
import { resolveSubmitterAccount, verifyAgentRequest, extractSignedHeaders, hasMeshToken } from "../auth.js";
import {
  rateOracleConfig,
  subtaskReserveMsat,
  marketOrders,
  orderBook,
  MARKET_DEFAULT_BID_PREMIUM_BPS,
  askCapabilityOf,
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
  addTaskCost,
  accrueResultCredits,
  settleTaskIfDone
} from "../results.js";
import { inferenceStreams } from "./inference.js";

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

export function registerTaskRoutes(app: CoordinatorApp): void {
  app.post("/submit", async (req, reply) => {
    const body = taskSchema.parse(req.body);
    const submitter = await resolveSubmitterAccount(req as any, body.submitterAccountId);
    if ("error" in submitter) return reply.code(submitter.status).send({ error: submitter.error });
    body.submitterAccountId = submitter.accountId;
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
        // One charge per task id network-wide: the same task sent again (retry, or to the other seed) is refused.
        await spendCredits(body.submitterAccountId, msatToCSats(perSubtask), "task_reserve", body.taskId, { idempotencyKey: `task_reserve:${body.taskId}` });
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

    // Detect circular dependencies and warn (enqueue anyway to avoid deadlock)
    const circularIds = depTracker.detectCircularDeps(subtasksWithIds);
    if (circularIds.size > 0) {
      app.log.warn(
        { taskId: body.taskId, circularIds: [...circularIds] },
        "circular_subtask_dependencies_detected_enqueuing_anyway"
      );
    }

    const enqueueOpts = hasMeshPeers ? { claimDelayMs: GOSSIP_CLAIM_DELAY_MS } : undefined;
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
    for (const subtask of created) {
      const offerMsg = protocol.createMessage(
        "task_offer",
        identity.peerId,
        {
          subtaskId: subtask.id,
          taskId: subtask.taskId,
          kind: subtask.kind,
          language: subtask.language,
          input: subtask.input,
          timeoutMs: subtask.timeoutMs,
          snapshotRef: subtask.snapshotRef,
          projectMeta: subtask.projectMeta,
          originCoordinatorId: identity.peerId,
          originCoordinatorUrl: COORDINATOR_PUBLIC_URL,
        },
        coordinatorKeys.privateKeyPem,
        60_000
      );
      void mesh.broadcast(offerMsg);
    }

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
    // A reserved agent takes only its lease's jobs; a job for a lease or for its owner's own machines goes nowhere else.
    const lease = reservations.activeForAgent(body.agentId);
    const task = queue.claim(
      body.agentId,
      capability?.activeModel,
      pullerAccount,
      // The book enforces the bid's class, price and constraints. The subtask's own constraints are
      // checked too, so a task gossiped from a peer (no local bid) still cannot go to an under-spec agent.
      (subtask) => {
        if (!agentMayClaim(capability, subtask)) return false;
        // #54: a job that names a model goes only to an agent that reported it (inference: installed;
        // code: its active model, which is what code work runs on).
        const hasModel = subtaskModelEligible(capability, subtask);
        const meta = subtask.projectMeta;
        if (lease) return meta.reservationId === lease.id && hasModel;
        if (meta.reservationId) return false;
        if (meta.onlyAccountId) return meta.onlyAccountId === pullerAccount && hasModel;
        return orderBook.canMatch(body.agentId, subtask.taskId).ok && meetsCapability(askCapabilityOf(body.agentId, capability), meta) && hasModel;
      }
    );
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

      // Envelope encryption: if agent registered an X25519 key, encrypt the task
      const agentX25519 = capability?.x25519PublicKey;
      if (agentX25519) {
        try {
          const agentPubKey = Buffer.from(agentX25519, "base64");
          const { envelope, sharedKey } = createTaskEnvelope(
            { input: task.input, snapshotRef: task.snapshotRef, kind: task.language },
            agentPubKey,
            task.id,
            { taskId: task.taskId, resourceClass: task.projectMeta?.resourceClass, priority: task.projectMeta?.priority, language: task.language, timeoutMs: task.timeoutMs, kind: task.kind, requestedModel: task.requestedModel }
          );
          envelopeSharedKeys.set(task.id, { key: sharedKey, createdAtMs: Date.now() });
          // Expire stale shared keys
          const now = Date.now();
          for (const [sid, entry] of envelopeSharedKeys) {
            if (now - entry.createdAtMs > ENVELOPE_KEY_TTL_MS) envelopeSharedKeys.delete(sid);
          }
          app.log.info({ subtaskId: task.id, agentId: body.agentId }, "task_encrypted_with_envelope");
          return reply.send({ subtask: null, envelope });
        } catch (envelopeErr) {
          app.log.warn({ subtaskId: task.id, error: String(envelopeErr) }, "envelope_encryption_failed_falling_back");
          // Fall through to plaintext
        }
      }
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
    const cachedKey = typeof rawBody.subtaskId === "string" ? envelopeSharedKeys.get(rawBody.subtaskId) : undefined;
    let body: z.infer<typeof resultSchema>;
    let envelopeKey: Buffer | undefined;
    if (cachedKey && typeof rawBody.encryptedPayload === "string") {
      try {
        const decrypted = decryptEnvelopeResult(rawBody as unknown as EncryptedResult, cachedKey.key);
        envelopeSharedKeys.delete(rawBody.subtaskId as string);
        envelopeKey = cachedKey.key;
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
    // Server-side duration: never more than measured since claim or the subtask timeout.
    const durationMs = claim ? creditedDurationMs(body.durationMs, claim) : 0;
    // Ongoing hardware evidence: real work against the verified tier (server clock, not the agent's).
    // The ask is re-posted every time so its reliability score (minReliability bids) stays current.
    if (!isPeerForward && claim?.claimedAt) {
      const nowMs = Date.now();
      // Model calls carry the model's real token count (reported with the last streamed piece).
      hardwareVerifier.recordTask(body.agentId, { ok: body.ok, outputChars: (body.output ?? "").length, elapsedMs: nowMs - claim.claimedAt, outputTokens: usagePending.get(body.taskId)?.outputTokens }, nowMs);
      repostAsk(body.agentId, nowMs);
    }

    // ── Behavioral monitoring ── (skipped for peer-forwarded results: body.agentId is unauthenticated there)
    if (!isPeerForward) {
      behaviorTracker.recordTaskResult(body.agentId, { ok: body.ok, output: body.output, durationMs: body.durationMs });
      evaluateAndEnforce(body.agentId);
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
        meta: { report: body, taskId: body.taskId, durationMs, reportedDurationMs: body.durationMs, subtask, agentEnvelope }
      };
      if (resultVerifier.isReplica(body.subtaskId)) {
        verificationHold = true;
        const r = resultVerifier.recordReplica(body.subtaskId, execution);
        if (r && r.status === "pending") enqueueReplica(r.next);
        else if (r) verificationOutcome = r;
      } else if (resultVerifier.shouldVerify(executorKey(execution), subtask.kind)) {
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
    try {
      await publishResult(body, agentEnvelope);
      inferenceStreams.finish(body.subtaskId, body.ok ? undefined : body.error ?? "failed");
      // ── Dependency tracking: store output and release dependent subtasks ──
      releaseDependents(body.subtaskId, body.output ?? "");
      // Ran on another coordinator: its cost isn't measured here, so it is charged at the worst case.
      if (isPeerForward) addTaskCost(body.taskId, taskBilling.get(body.taskId)?.perSubtaskReserveMsat ?? 0);

      if (subtask) {
        await accrueResultCredits({
          subtaskId: body.subtaskId,
          agentId: body.agentId,
          ok: body.ok,
          output: body.output ?? "",
          meta: { report: body, taskId: body.taskId, durationMs, reportedDurationMs: body.durationMs, subtask }
        });
      }
    } finally {
      releaseSettlement();
    }
    await settleTaskIfDone(body.taskId);
    return reply.send({ ok: true });
  });
}
