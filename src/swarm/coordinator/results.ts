// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Result handling: verification, credit accrual, task budgets, settlement and refunds.
 */
import { recordNwcCall } from "./direct-payments.js";
import { request } from "undici";
import type { Subtask, SubtaskResult } from "../../common/types.js";
import { signForwardedResult } from "../../mesh/peer-trust.js";
import type { AgentResultEnvelope } from "../../mesh/forwarded-agent-envelope.js";
import { accruePricedJob, grantCreditsIdempotent, refundTxId, rewardAccountForAgent } from "../../credits/store.js";
import {
  clampToBand,
  inferenceCostMsat,
  jobCostMsat,
  msatToCSats,
  ratePerSecondMsat,
  splitJobCost,
  FEE_ROUNDING
} from "../../economy/job-pricing.js";
import { paramsB } from "../../inference-api/auto-route.js";
import { pgStore } from "../../db/store.js";
import type { PostgresStore } from "../../db/postgres.js";
import { modalityMultiplier, settlementClassFor, type ComputeClassId } from "../../economy/compute-classes.js";
import { catalogEntryForTag } from "../../model/catalog.js";
import { resultReportId } from "../result-integrity.js";
import {
  ResultVerifier,
  executorKey,
  payableWinners,
  verificationConfigFromEnv,
  verificationKindsWarning,
  verificationStartupWarning,
  type ExecutionResult,
  type PendingVerificationSnapshot,
  type ReplicaRequest,
  type VerificationOutcome
} from "../verification.js";
import { app } from "./app.js";
import { agentLoadReport } from "./dispatch.js";
import {
  rememberSettled,
  queue,
  protocol,
  identity,
  COORDINATOR_PUBLIC_URL,
  coordinatorKeys,
  mesh,
  type ResultMeta,
  securityLog,
  noteUsageRun,
  claimedTradePrice,
  usagePending,
  FALLBACK_BTC_USD,
  taskOriginMap,
  MESH_AUTH_TOKEN,
  taskBilling,
  peerOfferBudgetMsat,
  saveUsage,
  remoteGrants,
  peerGrants
} from "./context.js";
import { mutable } from "./mutable-state.js";
import { autoBlacklister, agentCapabilities, behaviorTracker, ordering } from "./agent-state.js";
import {
  hardwareVerifier,
  effectiveHardware,
  classRefMsatPerCredit,
  NETWORK_FEE_BPS,
  marketHistory,
  orderBook
} from "./economy.js";
import { depTracker, recordWorkReceipt } from "./services.js";
import { persistStatsLedgerRecord } from "./stats-ledger.js";
import { attestAgentSigningKey } from "./attested-keys.js";

/** Store a subtask's output and release (and gossip) the subtasks that depended on it. */
export function releaseDependents(subtaskId: string, output: string): void {
  const released = depTracker.recordCompletionAndRelease(
    subtaskId,
    output,
    (s, opts) => queue.enqueueSubtask(s, opts)
  );
  for (const releasedSubtask of released) {
    app.log.info(
      { subtaskId: releasedSubtask.id, taskId: releasedSubtask.taskId },
      "dependent_subtask_released"
    );
    // Gossip released subtasks to peer coordinators
    offerSubtaskToPeers(releasedSubtask);
  }
}

/**
 * Offer a queued subtask to peer coordinators. A peer that wants it asks for a grant (task_claim);
 * this coordinator stays the authority on who runs it (src/swarm/remote-grants.ts).
 */
export function offerSubtaskToPeers(subtask: Subtask): void {
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
      // The requester's bid travels with the offer (projectMeta carries the class and ceiling): a
      // default bid on "any" class is relative to each class's reference, which the premium says.
      ...(orderBook.bidFor(subtask.taskId)?.premiumBps !== undefined ? { bidPremiumBps: orderBook.bidFor(subtask.taskId)!.premiumBps } : {}),
    },
    coordinatorKeys.privateKeyPem,
    60_000
  );
  void mesh.broadcast(offerMsg);
}

/** Subtasks of a task still queued, running here or on a granted peer, or held behind dependencies. */
export function taskOpenCount(taskId: string): number {
  return queue.openSubtaskCount(taskId) + depTracker.heldCountForTask(taskId) + remoteGrants.openCountForTask(taskId);
}

/** A subtask a peer coordinator offered us and granted to us: its requester is billed at the origin. */
export function isPeerOffered(subtaskId: string): boolean {
  const origin = taskOriginMap.get(subtaskId);
  return Boolean(origin && origin.coordinatorId !== identity.peerId);
}

const FORWARD_RETRY_DELAYS_MS = [1_000, 3_000, 6_000];

/**
 * Send a result for a peer-offered subtask back to its origin and return what the origin charged its
 * requester for it (msat): all an agent here may be paid for the work. 0 when the origin refused it
 * (not granted to us, the grant expired, or a failure) or could not be reached.
 */
async function forwardResultToOrigin(
  origin: { coordinatorId: string; coordinatorUrl: string },
  result: SubtaskResult,
  agentEnvelope?: AgentResultEnvelope,
  peerCostMsat?: number
): Promise<number> {
  // peerCostMsat: what the work cost here by the pricing formulas, which the origin charges its
  // requester (never more than it set aside); covered by our forward signature.
  const forwardJson = JSON.stringify({ ...result, ...(agentEnvelope ? { agentEnvelope } : {}), ...(peerCostMsat !== undefined ? { peerCostMsat } : {}) });
  for (let attempt = 0; ; attempt++) {
    let retry = false;
    try {
      const res = await request(`${origin.coordinatorUrl}/result`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : {}),
          // #52: the origin checks this against our allowlisted key (signed per attempt: replay cache).
          ...signForwardedResult(identity.peerId, coordinatorKeys.privateKeyPem, forwardJson)
        },
        body: forwardJson,
        signal: AbortSignal.timeout(15_000)
      });
      const text = await res.body.text().catch(() => "");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = {};
      }
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const charged = typeof body.chargedMsat === "number" && Number.isFinite(body.chargedMsat) ? Math.max(0, body.chargedMsat) : 0;
        app.log.info({ subtaskId: result.subtaskId, to: origin.coordinatorUrl, chargedMsat: charged }, "result_forwarded_to_origin");
        return charged;
      }
      retry = res.statusCode === 409 && body.error === "forward_in_progress";
      if (!retry) {
        app.log.warn({ subtaskId: result.subtaskId, originUrl: origin.coordinatorUrl, status: res.statusCode, error: body.error }, "result_forward_refused");
        return 0;
      }
    } catch (e) {
      retry = true;
      app.log.warn({ subtaskId: result.subtaskId, originUrl: origin.coordinatorUrl, err: String(e) }, "result_forward_failed");
    }
    if (!retry || attempt >= FORWARD_RETRY_DELAYS_MS.length) return 0;
    await new Promise((r) => setTimeout(r, FORWARD_RETRY_DELAYS_MS[attempt]));
  }
}

const verificationConfig = verificationConfigFromEnv();
export const resultVerifier = new ResultVerifier<ResultMeta>(verificationConfig);
if (!hardwareVerifier.config.enabled) app.log.warn("HARDWARE_VERIFICATION=0: self-reported hardware tiers are paid unverified");
{
  const warning = verificationStartupWarning(verificationConfig);
  if (warning) app.log.warn({ rate: verificationConfig.rate, mintReplicaRewards: verificationConfig.mintReplicaRewards, kinds: verificationConfig.kinds }, warning);
  const kindsWarning = verificationKindsWarning();
  if (kindsWarning) app.log.warn(kindsWarning);
}

function queueVerificationWrite(write: () => Promise<unknown>): void {
  mutable.verificationWrites = mutable.verificationWrites
    .then(write)
    .then(
      () => undefined,
      (error) => app.log.warn({ error: String(error) }, "result_verification_persist_failed")
    );
}
resultVerifier.onChange((change) => {
  const store = pgStore;
  if (!store) return;
  if (change.kind === "reputation") {
    queueVerificationWrite(async () =>
      resultVerifier.primeReputation(change.key, await store.adjustVerificationReputation(change.key, change.delta, verificationConfig.initialReputation))
    );
  } else if (change.kind === "pending") {
    queueVerificationWrite(() => store.upsertPendingVerification(identity.peerId, change.originalSubtaskId, change.snapshot, change.snapshot.startedAtMs));
  } else {
    queueVerificationWrite(() => store.deletePendingVerification(identity.peerId, change.originalSubtaskId));
  }
});

/** #162: the key reputation and sampling use (the reward account), with its stored reputation loaded. */
export async function verificationAccountFor(agentId: string): Promise<string> {
  const accountId = await rewardAccountForAgent(agentId);
  const stored = await pgStore?.getVerificationReputation(accountId).catch(() => undefined);
  if (stored !== undefined) resultVerifier.primeReputation(accountId, stored);
  return accountId;
}

/** #105: hold again the verifications this coordinator held before a restart, re-issuing their replicas. */
export async function restorePendingVerifications(store: PostgresStore): Promise<number> {
  const snapshots = await store.listPendingVerifications<PendingVerificationSnapshot<ResultMeta>>(identity.peerId);
  let restored = 0;
  for (const snap of snapshots) {
    const next = resultVerifier.restore(snap);
    if (!next) continue;
    restored += 1;
    enqueueReplica(next);
  }
  await mutable.verificationWrites;
  if (restored > 0) app.log.info({ restored }, "result_verifications_restored");
  return restored;
}

/**
 * #50/#106/#117: one pass of the verification clock: penalize and reassign stalled replica
 * claims, then settle verifications past their deadline. Runs every minute (initCoordinator).
 */
export async function runResultVerificationTick(): Promise<void> {
  const stalled = resultVerifier.reassignStalled();
  for (const a of stalled.abandoned) {
    securityLog.log({
      level: securityLog.severity("result_verification_replica_abandoned"),
      event: "result_verification_replica_abandoned",
      source: { type: "agent", id: a.agentId },
      details: { originalSubtaskId: a.originalSubtaskId, accountId: a.accountId, reputation: resultVerifier.reputation(a.accountId) },
      action: "replica_reassigned",
      coordinatorId: identity.peerId,
    });
  }
  for (const r of stalled.replacements) {
    queue.removeHeld(r.replaces); // the abandoner's late report then fails the claim check
    enqueueReplica(r.request);
  }
  for (const outcome of resultVerifier.expire()) await settleVerification(outcome);
  await mutable.verificationWrites;
}

/** #105: a result outvoted by a verification majority is a strike towards an automatic blacklist. */
function recordVerificationMismatchStrike(loser: ExecutionResult<ResultMeta>, originalSubtaskId: string): void {
  autoBlacklister.processAnomalies(loser.agentId, [
    {
      ruleId: "VRF001",
      ruleName: "result_verification_mismatch",
      severity: "HIGH",
      blacklistReason: "forged_results",
      description: "result disagreed with a verified majority of independent executions",
      stats: { originalSubtaskId, executedSubtaskId: loser.subtaskId, accountId: executorKey(loser) }
    }
  ]);
}

export function enqueueReplica(req: ReplicaRequest): void {
  queue.enqueueSubtask(req.subtask, { excludeAgents: req.excludeAgents, excludeAccounts: req.excludeAccounts });
  app.log.info(
    { replicaId: req.subtask.id, excludeAgents: req.excludeAgents, excludeAccounts: req.excludeAccounts },
    "verification_replica_enqueued"
  );
}

/**
 * What an accepted execution costs by the pricing formulas (job-pricing.ts), before it is capped by
 * what its payer set aside. Reads, never consumes, the trade price agreed at claim.
 */
export function priceExecution(r: ExecutionResult<ResultMeta>) {
  const { subtask, durationMs, taskId } = r.meta;
  const cap = agentCapabilities.get(r.agentId);
  const eff = effectiveHardware(r.agentId, cap);
  const trade = claimedTradePrice.get(r.subtaskId);
  // Throughput: the agent's verified tier mints creditsPerSecond credits per measured second (weight
  // 1 on a class's base tier), so credits × the class's flat price per credit is the tier's hour price.
  // The trade carries the grant at claim time; a grant that moved since (demotion mid-task) wins, and
  // the weight never exceeds the current grant. CPU tasks are always paid as CPU work (settlementClassFor).
  let agentClass: ComputeClassId = trade?.computeClass ?? eff?.computeClass ?? "cpu";
  let agentWeight = trade?.creditsPerSecond ?? eff?.creditsPerSecond ?? 1;
  if (trade && eff) {
    if (eff.computeClass !== trade.computeClass) [agentClass, agentWeight] = [eff.computeClass, eff.creditsPerSecond];
    else agentWeight = Math.min(agentWeight, eff.creditsPerSecond);
  }
  const { computeClass, creditsPerSecond: hardwareWeight } = settlementClassFor(subtask.projectMeta.resourceClass, agentClass, agentWeight);
  const modelParamSizeB = subtask.requestedModel ? cap?.activeModelParamSize : undefined;
  const modality = modalityMultiplier(catalogEntryForTag(cap?.activeModel ?? "")?.capabilities);
  // Sats per credit: the market price agreed at claim (agent's ask), else the oracle's class rate.
  // The msat value locked on an earn row is withdrawable as real sats, so the trade price must not
  // be trustable to inflate it. Clamp it to [0.25x, 4x] the oracle class reference, which a
  // self-dealing ask/bid cannot move (audit econ#2). Falls back to the reference when no trade.
  // One reference per class (cpu | apple | gpu | gpu.dc); epochs persisted under the legacy ids
  // are normalized at load (normalizeRateEpoch), so the clamp always has a reference.
  // Per-second pricing by class (job-pricing.ts): the matched price kept within the class band
  // (a self-dealing ask/bid can't move the sats value, audit econ#2) times the tier weight.
  void modality;
  const perCredit = clampToBand(trade?.msatPerCredit, classRefMsatPerCredit(computeClass));
  const rateMsat = ratePerSecondMsat(perCredit, hardwareWeight);
  // Model calls are priced per token (tied to the market, with a power floor); code jobs per second.
  const perSecondCostMsat = jobCostMsat(durationMs, rateMsat);
  const usageForTask = usagePending.get(taskId);
  const priced =
    subtask.kind === "inference"
      ? inferenceCostMsat({
          promptTokens: usageForTask?.promptTokens,
          outputTokens: usageForTask?.outputTokens,
          paramsB: paramsB(subtask.requestedModel ?? ""),
          btcUsd: mutable.latestRateEpoch?.btcUsd ?? FALLBACK_BTC_USD,
          durationMs,
          // The host's model load is not the buyer's: the floor counts the seconds after it.
          floorExcludeMs: taskBilling.get(taskId)?.loadMs,
          // One machine's power, shared by the calls its slots run at once.
          floorSlots: agentLoadReport(r.agentId)?.slots,
          computeClass,
          tierWeight: hardwareWeight,
          perSecondCostMsat,
        })
      : { costMsat: perSecondCostMsat, basis: "per_second" as const };
  return { cap, eff, computeClass, hardwareWeight, modelParamSizeB, perCredit, rateMsat, priced };
}

/**
 * Peer side: what an execution of a peer-offered subtask costs, capped by the most its origin set
 * aside for one subtask. The origin charges its requester this (never more than its reserve) and
 * answers with the charge, which is then what the agent is paid.
 */
export function peerWorkCostMsat(r: ExecutionResult<ResultMeta>): number {
  const { subtask } = r.meta;
  if (!r.ok || subtask.projectMeta.reservationId || subtask.projectMeta.onlyAccountId) return 0;
  const budget = peerOfferBudgetMsat.get(r.subtaskId);
  if (budget === undefined) return 0;
  const cost = priceExecution(r).priced.costMsat;
  return Number.isFinite(cost) ? Math.max(0, Math.min(Math.ceil(cost), budget)) : 0;
}

/** Accrue compute credits for one accepted execution (idempotent per executed subtask id, #44). */
export async function accrueResultCredits(r: ExecutionResult<ResultMeta>, opts: { originChargedMsat?: number } = {}): Promise<void> {
  const { subtask, durationMs, reportedDurationMs, taskId } = r.meta;
  const rewardAccountId = await rewardAccountForAgent(r.agentId);
  noteUsageRun(taskId, r.agentId, r.ok, durationMs, effectiveHardware(r.agentId)?.computeClass ?? agentCapabilities.get(r.agentId)?.computeClass);
  // #38: failed results earn nothing (no flat consolation credit), and the ledger payload
  // records the credits actually accrued by the pricing formula, so balances reconcile. The one
  // exception is a program error the agent credibly ran (payableFailure, src/swarm/result-outcome.ts):
  // the buyer's program used the compute, and verification sampling covers it like a success.
  if (!r.ok && !r.meta.payableFailure) return;
  // A reserved agent is paid by its lease (endReservation); your own machine isn't paid by you.
  if (subtask.projectMeta.reservationId || subtask.projectMeta.onlyAccountId) return;
  const { cap, eff, computeClass, hardwareWeight, modelParamSizeB, perCredit, rateMsat, priced } = priceExecution(r);
  claimedTradePrice.delete(r.subtaskId);
  // What is paid is what the requester is charged: taken out of what was set aside for the task
  // (never more), before the store is awaited, so results settling together cannot both spend it.
  // Work nobody set anything aside for (an anonymous task) earns nothing.
  const costMsat = takeTaskBudget(taskId, r.subtaskId, priced.costMsat, opts.originChargedMsat);
  // The reserve is an upper bound on the cost (job-pricing.ts inferenceReserveMsat); a cost above
  // what is left of it is settled at the reserve, never more. Logged: it should be rare.
  const billing = taskBilling.get(taskId);
  if (billing && !billing.refunded && Number.isFinite(priced.costMsat) && Math.round(priced.costMsat) > costMsat) {
    app.log.warn({ taskId, subtaskId: r.subtaskId, kind: subtask.kind, model: subtask.requestedModel, pricedMsat: Math.round(priced.costMsat), settledMsat: costMsat, reservedMsat: billing.reservedMsat, basis: priced.basis }, "job_cost_capped_at_reserve");
  }
  const { agentMsat, feeMsat } = splitJobCost(costMsat, NETWORK_FEE_BPS);
  if (billing?.nwc) {
    // Paid from the buyer's own wallet: a tally to the host and to EdgeCoder's fee, settled over
    // Lightning (direct-payments.ts). No cSats move.
    await recordNwcCall(billing.accountId, rewardAccountId, agentMsat, feeMsat);
    marketHistory.settleTrade(r.subtaskId, Number(((durationMs / 1000) * hardwareWeight).toFixed(6)));
    return;
  }
  const valuation = { msatPerCredit: Math.round(perCredit), networkFeeBps: NETWORK_FEE_BPS };
  let accrued: Awaited<ReturnType<typeof accruePricedJob>> = null;
  try {
    accrued = await accruePricedJob(
      {
        reportId: resultReportId(r.subtaskId),
        agentId: rewardAccountId,
        sourceAgentId: r.agentId,
        taskId,
        resourceClass: subtask.projectMeta.resourceClass,
        cpuSeconds: subtask.projectMeta.resourceClass === "cpu" ? durationMs / 1000 : 0,
        gpuSeconds: subtask.projectMeta.resourceClass === "gpu" ? durationMs / 1000 : 0,
        success: r.ok,
        qualityScore: r.ok ? 1.0 : 0.6,
        timestampMs: Date.now(),
        modelParamSizeB,
        hardwareWeight
      },
      { agentMsat, feeMsat }
    );
  } finally {
    // Nothing was paid (already recorded, #44, or the store failed): the task is not charged for it.
    if (!accrued) returnTaskBudget(taskId, costMsat);
  }
  if (accrued) {
    // Market volume stays in credits of work (base-tier seconds).
    marketHistory.settleTrade(r.subtaskId, Number(((durationMs / 1000) * hardwareWeight).toFixed(6)));
    const earningsRecord = ordering.append({
      eventType: "earnings_accrual",
      taskId,
      subtaskId: r.subtaskId,
      actorId: rewardAccountId,
      coordinatorId: identity.peerId,
      payloadJson: JSON.stringify({
        sourceAgentId: r.agentId,
        accountId: rewardAccountId,
        credits: accrued.credits,
        msat: accrued.msat,
        costMsat,
        feeMsat,
        pricingBasis: priced.basis,
        ratePerSecondMsat: rateMsat,
        msatPerCredit: valuation?.msatPerCredit,
        networkFeeBps: valuation?.networkFeeBps,
        feeRounding: FEE_ROUNDING,
        computeClass,
        hardwareTier: eff?.tier ?? cap?.hardwareClass?.tier,
        claimedTier: cap?.hardwareClass?.tier,
        hardwareVerification: hardwareVerifier.get(r.agentId)?.status,
        creditsPerSecond: hardwareWeight,
        modelParamSizeB,
        durationMs,
        reportedDurationMs,
        ok: r.ok,
        resourceClass: subtask.projectMeta.resourceClass
      })
    });
    await pgStore?.persistLedgerRecord(earningsRecord);
    await persistStatsLedgerRecord(earningsRecord);
    // Work receipt (architecture step 2): countersign the agent's claim for what was just credited.
    await recordWorkReceipt(r, accrued.credits, computeClass, valuation?.msatPerCredit).catch((error) => app.log.warn({ error, subtaskId: r.subtaskId }, "work_receipt_failed"));
  }
}

/**
 * Make a subtask result visible: queue result, task_complete ledger record, forward to
 * the origin coordinator (gossiped subtasks) and result_announce. #50: for results held
 * for verification this runs only at settle time, with the verified output.
 */
export async function publishResult(result: SubtaskResult, agentEnvelope?: AgentResultEnvelope, peerCostMsat?: number): Promise<number | undefined> {
  queue.complete(result);
  // Market: a task's bid leaves the book once its last subtask has a result.
  if (taskOpenCount(result.taskId) === 0) orderBook.removeBid(result.taskId);
  const completeRecord = ordering.append({
    eventType: "task_complete",
    taskId: result.taskId,
    subtaskId: result.subtaskId,
    actorId: result.agentId
  });
  await pgStore?.persistLedgerRecord(completeRecord);
  await persistStatsLedgerRecord(completeRecord);

  let originChargedMsat: number | undefined;
  const origin = taskOriginMap.get(result.subtaskId);
  if (origin && origin.coordinatorId !== identity.peerId) {
    taskOriginMap.delete(result.subtaskId);
    peerGrants.delete(result.subtaskId);
    // #122: the origin verifies the agent's own signature too, not only ours.
    if (agentEnvelope) {
      const pem = agentCapabilities.get(agentEnvelope.headers["x-agent-id"])?.publicKeyPem;
      if (pem) attestAgentSigningKey(agentEnvelope.headers["x-agent-id"], pem);
    }
    // Awaited: what the origin charged its requester is what the agent here may be paid.
    originChargedMsat = await forwardResultToOrigin(origin, result, agentEnvelope, result.ok ? peerCostMsat ?? 0 : 0);
  }

  void mesh.broadcast(
    protocol.createMessage(
      "result_announce",
      identity.peerId,
      { taskId: result.taskId, subtaskId: result.subtaskId, ok: result.ok },
      coordinatorKeys.privateKeyPem
    )
  );
  return originChargedMsat;
}

/**
 * #50: pay agreeing executions, penalize mismatches, then publish the original
 * subtask's result: the verified output when verified, a failure when unresolved,
 * and release dependents. Replica results are never published.
 */
export async function settleVerification(outcome: VerificationOutcome<ResultMeta>): Promise<void> {
  // #114: winning replicas earn minted credits only when RESULT_VERIFICATION_MINT_REPLICA_REWARDS is on.
  const payable = payableWinners(outcome, verificationConfig);
  // A peer-offered subtask is paid only what its origin charges for it, which is known once the
  // result is forwarded: those winners are paid after publishing (below).
  const peerOffered = isPeerOffered(outcome.originalSubtaskId);
  if (!peerOffered || outcome.status === "unresolved") for (const w of payable) await accrueResultCredits(w);
  for (const w of outcome.winners) {
    if (!payable.includes(w)) {
      app.log.info({ originalSubtaskId: outcome.originalSubtaskId, executedSubtaskId: w.subtaskId }, "result_verification_replica_unpaid");
    }
  }
  for (const l of outcome.losers) {
    securityLog.log({
      level: securityLog.severity("result_verification_mismatch"),
      event: "result_verification_mismatch",
      source: { type: "agent", id: l.agentId },
      details: {
        originalSubtaskId: outcome.originalSubtaskId,
        executedSubtaskId: l.subtaskId,
        status: outcome.status,
        accountId: executorKey(l),
        reputation: resultVerifier.reputation(executorKey(l))
      },
      action: "credits_withheld",
      coordinatorId: identity.peerId,
    });
    // Only a loser outvoted by an agreeing majority: "unresolved" means no two executions agreed,
    // which honest agents on non-deterministic work hit too.
    if (outcome.status === "verified") recordVerificationMismatchStrike(l, outcome.originalSubtaskId);
  }
  const original = [...outcome.winners, ...outcome.losers].find((r) => r.subtaskId === outcome.originalSubtaskId);
  if (!original) {
    app.log.error({ subtaskId: outcome.originalSubtaskId }, "result_verification_original_missing");
    return;
  }
  if (outcome.status === "unresolved") {
    app.log.warn({ subtaskId: outcome.originalSubtaskId }, "result_verification_unresolved");
    for (const agentId of outcome.abandonedBy ?? []) {
      securityLog.log({
        level: securityLog.severity("result_verification_replica_abandoned"),
        event: "result_verification_replica_abandoned",
        source: { type: "agent", id: agentId },
        details: { originalSubtaskId: outcome.originalSubtaskId },
        action: "credits_withheld",
        coordinatorId: identity.peerId,
      });
    }
    // #107: the requester gets a failure, never an unverified output. Same terminal path
    // as the #51 retry cap: fail held dependents, ledger/forward/announce, refund once.
    await finalizeFailedSubtask(
      { ...original.meta.report, ok: false, output: "", error: "result_verification_unresolved" },
      { recordResult: true }
    );
    return;
  }
  if (outcome.status === "timeout") {
    app.log.warn({ subtaskId: outcome.originalSubtaskId }, "result_verification_timeout_accepted_unverified");
  }
  // Executions on separate accounts agreed that the job fails, and at least one of them is an agent
  // that says it ran the program: the job is at fault, not the workers (buyer framing, BHV004).
  if (outcome.status === "verified" && !outcome.ok && outcome.winners.some((w) => w.meta.report.executed === true)) {
    for (const w of outcome.winners) behaviorTracker.excuseFailure(w.agentId, w.subtaskId);
  }
  // #122: forward the signature of the execution whose output is published (verification.ts picks
  // the original when it won, else the first winner).
  const ref = outcome.winners.find((w) => w.subtaskId === outcome.originalSubtaskId) ?? outcome.winners[0];
  // A peer-offered subtask: the origin is asked for what the paid original execution cost (replicas
  // have no budget here, results.ts takeTaskBudget).
  const paidOriginal = peerOffered ? payable.find((w) => w.subtaskId === outcome.originalSubtaskId) : undefined;
  const originChargedMsat = await publishResult(
    { ...original.meta.report, ok: outcome.ok, output: outcome.output },
    ref?.meta.agentEnvelope,
    peerOffered ? (paidOriginal ? peerWorkCostMsat(paidOriginal) : 0) : undefined
  );
  if (peerOffered) for (const w of payable) await accrueResultCredits(w, { originChargedMsat });
  releaseDependents(outcome.originalSubtaskId, outcome.output);
  // The verified result was the task's last open subtask: return what it set aside and did not use
  // (/result returns early for held results, so nothing else settles it).
  await settleTaskIfDone(original.meta.taskId);
}

/**
 * #51: terminal failure of a subtask the coordinator gave up on (retry cap). Does
 * what /result does for a failed result, minus any accrual (nobody earns, and
 * "coordinator" is never credited): ledger record, fail held dependents, forward
 * to the origin coordinator, announce, and refund the requester's submit charge.
 */
export async function finalizeFailedSubtask(result: SubtaskResult, opts: { recordResult?: boolean } = {}): Promise<void> {
  // The retry-cap path already recorded `result` in the queue; other callers (#107) ask us to.
  if (opts.recordResult) queue.complete(result);
  const failedResults: SubtaskResult[] = [result];
  for (const dep of depTracker.dropDependents(result.subtaskId)) {
    const depResult: SubtaskResult = {
      subtaskId: dep.id,
      taskId: dep.taskId,
      agentId: "coordinator",
      ok: false,
      output: "",
      error: `dependency_failed:${result.subtaskId}`,
      durationMs: 0
    };
    queue.complete(depResult);
    failedResults.push(depResult);
  }
  for (const r of failedResults) {
    const record = ordering.append({
      eventType: "task_complete",
      taskId: r.taskId,
      subtaskId: r.subtaskId,
      actorId: "coordinator",
      payloadJson: JSON.stringify({ ok: false, error: r.error })
    });
    await pgStore?.persistLedgerRecord(record);
    await persistStatsLedgerRecord(record);

    const origin = taskOriginMap.get(r.subtaskId);
    if (origin && origin.coordinatorId !== identity.peerId) {
      taskOriginMap.delete(r.subtaskId);
      peerGrants.delete(r.subtaskId);
      peerOfferBudgetMsat.delete(r.subtaskId);
      void forwardResultToOrigin(origin, r, undefined, 0);
    }
    void mesh.broadcast(
      protocol.createMessage(
        "result_announce",
        identity.peerId,
        { taskId: r.taskId, subtaskId: r.subtaskId, ok: false },
        coordinatorKeys.privateKeyPem
      )
    );
  }
  const refunded = await refundTaskSubmit(result.taskId);
  app.log.warn(
    { taskId: result.taskId, subtaskIds: failedResults.map((r) => r.subtaskId), refunded },
    "task_failed_max_attempts"
  );
}

/**
 * #160: refund what /submit charged, exactly once, even if the credit store fails.
 * The tx id is derived from the task id, so a retry after a thrown grant dedupes on
 * the store's primary key instead of paying twice; `refunded` is only set after the
 * grant succeeded, and the entry is pruned once settled.
 */

/**
 * Charge a finished subtask to whoever pays for it and return how much of `wantMsat` that covers,
 * which is all the agent may earn for it:
 * - a subtask offered by a peer coordinator: up to what that coordinator charged its requester for it;
 * - a task billed here: up to what its requester set aside and has not yet used;
 * - anything else has no payer (an anonymous task) and covers nothing.
 */
function takeTaskBudget(taskId: string, subtaskId: string, wantMsat: number, originChargedMsat?: number): number {
  const want = Number.isFinite(wantMsat) ? Math.max(0, wantMsat) : 0;
  const offered = peerOfferBudgetMsat.get(subtaskId);
  if (offered !== undefined) {
    peerOfferBudgetMsat.delete(subtaskId);
    // Backed by the origin: never more than it charged its requester for this subtask (nothing when
    // it refused the result, e.g. the subtask was not granted to us).
    const charged = originChargedMsat !== undefined && Number.isFinite(originChargedMsat) ? Math.max(0, originChargedMsat) : 0;
    return Math.min(want, offered, charged);
  }
  const billing = taskBilling.get(taskId);
  if (!billing || billing.refunded) return 0;
  const take = Math.min(want, Math.max(0, billing.reservedMsat - billing.costMsat));
  billing.costMsat += take;
  return take;
}

/**
 * A task id is one requester's billing key until its task settles: a second submission under an id
 * that is still billed, queued or held would replace or add to someone else's bill.
 */
export function taskIdInUse(taskId: string): boolean {
  return taskBilling.has(taskId) || usagePending.has(taskId) || taskOpenCount(taskId) > 0;
}

/** Undo takeTaskBudget when nothing was paid after all. */
function returnTaskBudget(taskId: string, msat: number): void {
  const billing = taskBilling.get(taskId);
  if (billing && !billing.refunded) billing.costMsat = Math.max(0, billing.costMsat - Math.max(0, msat));
}

/**
 * Origin side: a granted peer ran a subtask of `taskId` and asks `wantMsat` for it. Charged to the
 * requester out of what the task set aside and has not used yet (never more); returns the charge,
 * which is all the peer may pay its agent.
 */
export function chargePeerWork(taskId: string, wantMsat: number): number {
  const billing = taskBilling.get(taskId);
  if (!billing || billing.refunded) return 0;
  const want = Number.isFinite(wantMsat) ? Math.max(0, wantMsat) : 0;
  const take = Math.min(want, Math.max(0, billing.reservedMsat - billing.costMsat));
  billing.costMsat += take;
  return take;
}

/** Results being paid, per task: the task is not settled (its unused reserve returned) under them. */
export const accrualsInFlight = new Map<string, number>();
export function holdSettlement(taskId: string): () => void {
  accrualsInFlight.set(taskId, (accrualsInFlight.get(taskId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (accrualsInFlight.get(taskId) ?? 1) - 1;
    if (n > 0) accrualsInFlight.set(taskId, n);
    else accrualsInFlight.delete(taskId);
  };
}

/** Once a task has no open subtasks: return what was set aside but not used. */
export async function settleTaskIfDone(taskId: string): Promise<void> {
  if (!taskBilling.has(taskId)) return;
  if (accrualsInFlight.has(taskId)) return;
  if (taskOpenCount(taskId) > 0) return;
  await refundTaskSubmit(taskId);
}

const REFUND_RETRY_DELAYS_MS = [250, 1_000, 4_000];
export async function refundTaskSubmit(taskId: string): Promise<boolean> {
  const billing = taskBilling.get(taskId);
  if (!billing) return false;
  if (billing.refunded) return true;
  const txId = refundTxId(taskId);
  for (let attempt = 0; ; attempt++) {
    try {
      const unusedMsat = billing.nwc ? 0 : Math.max(0, billing.reservedMsat - billing.costMsat);
      if (unusedMsat > 0) await grantCreditsIdempotent(billing.accountId, msatToCSats(unusedMsat), `task_submit_refund:${taskId}`, txId);
      billing.refunded = true;
      await pgStore?.markTaskBillingSettled(taskId, Date.now(), identity.peerId).catch((err) => app.log.warn({ err, taskId }, "task_billing_settle_persist_failed"));
      const usage = usagePending.get(taskId);
      if (usage) {
        usagePending.delete(taskId);
        usage.costMsat = billing.costMsat;
        void saveUsage(usage);
      }
      rememberSettled(taskId, billing);
      taskBilling.delete(taskId);
      return true;
    } catch (err) {
      if (attempt >= REFUND_RETRY_DELAYS_MS.length) {
        // Left in taskBilling with refunded=false so a later failure event or an
        // operator replay (same deterministic tx id) can complete it.
        app.log.error({ err, taskId, accountId: billing.accountId, txId }, "task_submit_refund_failed");
        return false;
      }
      await new Promise((r) => setTimeout(r, REFUND_RETRY_DELAYS_MS[attempt]));
    }
  }
}
