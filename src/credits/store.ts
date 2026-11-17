// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createHash, randomUUID } from "node:crypto";
import { CreditEngine } from "./engine.js";
import { ComputeContributionReport, CreditTransaction } from "../common/types.js";
import { contributionCredits, splitNetworkFee, LoadSnapshot } from "./pricing.js";
import { pgStore } from "../db/store.js";
import { capBackfillSplit } from "../economy/reservation-backfill.js";

export const creditEngine = new CreditEngine();

/** Account that collects the network fee on every accrual (and the purchase fee); distributed to infrastructure hosts. */
export const NETWORK_FEE_POOL_ACCOUNT = "network:fee_pool";

export interface AccrualValuation {
  /** Sats value of one credit at accrual time (market trade price or oracle class rate). Locked on the earn row. */
  msatPerCredit: number;
  /** Network fee in basis points taken from the gross credits and moved to the fee pool. */
  networkFeeBps: number;
}

/**
 * Accrue credits for a contribution report. Idempotent on `report.reportId`
 * (#44): returns null when the report was already recorded.
 *
 * With a `valuation` the worker row carries its sats value (msat) locked at today's rate and
 * the network fee share is split off into NETWORK_FEE_POOL_ACCOUNT in the same transaction.
 * The returned row is the worker's (net) row.
 */
/**
 * Accrue a priced job (job-pricing.ts): the agent earns `agentMsat` and the fee pool `feeMsat`,
 * both in cSats (1 cSat = 1 sat, credits column) with their msat value. Idempotent on
 * `report.reportId` like accrueCredits. Returns the agent's row, or null when already recorded or
 * there is nothing to pay.
 *
 * Reservation backfill (src/economy/reservation-backfill.ts): with `backfill`, `agentMsat` is split
 * into the host's row (reason reservation_backfill_host:<lease>, `hostMsat`) and the lease
 * holder's row (reservation_backfill_holder:<lease>, `holderMsat`), written in the same
 * transaction as the report and the fee row. hostMsat + holderMsat must equal agentMsat. The
 * returned row is still the host's.
 *
 * `holderCapMsat` (the lease price) caps the holder's total backfill credit on that lease: the part
 * of holderMsat above the room left goes to the host (capBackfillSplit), read and written
 * atomically (Postgres: per-lease advisory lock in the accrual's transaction; memory: no await in
 * between). `backfill.holderMsat` / `hostMsat` are updated in place to what was credited.
 */
export async function accruePricedJob(
  report: ComputeContributionReport,
  priced: { agentMsat: number; feeMsat: number },
  backfill?: { reservationId: string; holderAccountId: string; holderMsat: number; hostMsat: number; holderCapMsat?: number; cappedMsat?: number }
): Promise<CreditTransaction | null> {
  if (!(priced.agentMsat > 0)) return null;
  if (backfill && (backfill.holderMsat < 0 || backfill.hostMsat < 0 || backfill.holderMsat + backfill.hostMsat !== Math.round(priced.agentMsat))) {
    throw new Error("backfill_split_mismatch");
  }
  const now = Date.now();
  /** What was actually credited (after the cap), reported back on `backfill`. */
  const noteCredited = () => {
    if (!backfill) return;
    const holderMsat = holderTx?.msat ?? 0;
    backfill.cappedMsat = backfill.holderMsat - holderMsat;
    backfill.holderMsat = holderMsat;
    backfill.hostMsat = tx.msat ?? 0;
  };
  const hostMsat = backfill ? backfill.hostMsat : Math.round(priced.agentMsat);
  const tx: CreditTransaction = {
    txId: randomUUID(),
    accountId: report.agentId,
    type: "earn",
    credits: roundCredits(hostMsat / 1000),
    reason: backfill ? `reservation_backfill_host:${backfill.reservationId}` : "compute_contribution",
    relatedTaskId: report.taskId,
    timestampMs: now,
    msat: hostMsat,
  };
  const holderReason = backfill ? `reservation_backfill_holder:${backfill.reservationId}` : "";
  const holderTx: CreditTransaction | undefined =
    backfill && backfill.holderMsat > 0
      ? {
          txId: randomUUID(),
          accountId: backfill.holderAccountId,
          type: "earn",
          credits: roundCredits(backfill.holderMsat / 1000),
          reason: holderReason,
          relatedTaskId: report.taskId,
          timestampMs: now,
          msat: backfill.holderMsat,
        }
      : undefined;
  const feeTx: CreditTransaction | undefined =
    priced.feeMsat > 0
      ? {
          txId: randomUUID(),
          accountId: NETWORK_FEE_POOL_ACCOUNT,
          type: "earn",
          credits: roundCredits(priced.feeMsat / 1000),
          reason: `network_fee:${report.taskId}`,
          relatedTaskId: report.taskId,
          timestampMs: now,
          msat: Math.round(priced.feeMsat),
        }
      : undefined;
  if (pgStore) {
    const seconds = report.resourceClass === "gpu" ? report.gpuSeconds : report.cpuSeconds;
    const inserted = await pgStore.persistContributionWithCredit(
      {
        report,
        accountId: report.agentId,
        sourceAgentId: report.sourceAgentId ?? report.agentId,
        reliabilityScore: report.success ? 1 : 0.75,
        weightedContribution: Number((seconds * (report.hardwareWeight ?? 1)).toFixed(6)),
      },
      tx,
      feeTx,
      holderTx ? [holderTx] : [],
      holderTx && backfill?.holderCapMsat !== undefined ? { holder: holderTx, capMsat: backfill.holderCapMsat } : undefined
    );
    if (inserted) noteCredited();
    return inserted ? tx : null;
  }
  if (!creditEngine.claimReport(report.reportId)) return null;
  if (holderTx && backfill?.holderCapMsat !== undefined) {
    // Synchronous from here to the records: concurrent accruals see each other's holder rows.
    const already = creditEngine.history(backfill.holderAccountId).reduce((n, t) => n + (t.type === "earn" && t.reason === holderReason ? (t.msat ?? 0) : 0), 0);
    const capped = capBackfillSplit({ holderMsat: holderTx.msat ?? 0, hostMsat: tx.msat ?? 0 }, already, backfill.holderCapMsat);
    holderTx.msat = capped.holderMsat;
    holderTx.credits = roundCredits(capped.holderMsat / 1000);
    tx.msat = capped.hostMsat;
    tx.credits = roundCredits(capped.hostMsat / 1000);
  }
  noteCredited();
  if (!backfill || tx.credits > 0) creditEngine.record(tx);
  if (holderTx && holderTx.credits > 0) creditEngine.record(holderTx);
  if (feeTx) creditEngine.record(feeTx);
  return tx;
}

export async function accrueCredits(
  report: ComputeContributionReport,
  load: LoadSnapshot,
  valuation?: AccrualValuation
): Promise<CreditTransaction | null> {
  const grossCredits = contributionCredits(report, load); // #38: single formula
  const split = valuation ? splitNetworkFee(grossCredits, valuation.networkFeeBps) : { worker: grossCredits, fee: 0 };
  const msatOf = (credits: number) => (valuation ? Math.round(credits * valuation.msatPerCredit) : undefined);
  const now = Date.now();
  const tx: CreditTransaction = {
    txId: randomUUID(),
    accountId: report.agentId,
    type: "earn",
    credits: split.worker,
    reason: "compute_contribution",
    relatedTaskId: report.taskId,
    timestampMs: now,
    ...(valuation ? { msat: msatOf(split.worker) } : {})
  };
  const feeTx: CreditTransaction | undefined =
    split.fee > 0
      ? {
          txId: randomUUID(),
          accountId: NETWORK_FEE_POOL_ACCOUNT,
          type: "earn",
          credits: split.fee,
          reason: `network_fee:${report.taskId}`,
          relatedTaskId: report.taskId,
          timestampMs: now,
          msat: msatOf(split.fee)
        }
      : undefined;

  if (pgStore) {
    const computeSeconds = report.resourceClass === "gpu" ? report.gpuSeconds : report.cpuSeconds;
    const qualityMultiplier = Math.max(0.5, Math.min(1.5, report.qualityScore));
    const resourceWeight = report.resourceClass === "gpu" ? 2 : 1;
    const reliabilityScore = report.success ? 1 : 0.75;
    const weightedContribution = Number((computeSeconds * resourceWeight * qualityMultiplier * reliabilityScore).toFixed(6));
    // Report + credit (+ fee) atomically; false => report id already recorded (idempotent re-post).
    const inserted = await pgStore.persistContributionWithCredit(
      {
        report,
        accountId: report.agentId,
        sourceAgentId: report.sourceAgentId ?? report.agentId,
        reliabilityScore,
        weightedContribution
      },
      tx,
      feeTx
    );
    return inserted ? tx : null;
  }
  try {
    const recorded = creditEngine.accrue(report, load, valuation ? { msatPerCredit: valuation.msatPerCredit } : undefined);
    if (recorded.credits > 0 && feeTx) {
      // In-memory: the engine wrote the gross row; net it down and add the fee row.
      const gross = creditEngine.history(report.agentId).find((t) => t.txId === recorded.txId);
      if (gross) {
        gross.credits = split.worker;
        gross.msat = msatOf(split.worker);
      }
      creditEngine.record(feeTx);
      return { ...tx, txId: recorded.txId };
    }
    return recorded;
  } catch (error) {
    if (error instanceof Error && error.message === "duplicate_contribution_report") return null;
    throw error;
  }
}

/** Total sats (msat) an account has earned, as locked on its earn rows. */
export async function earnedMsat(accountId: string): Promise<number> {
  if (pgStore) return pgStore.earnedMsat(accountId);
  return creditEngine.earnedMsat(accountId);
}

export async function rewardAccountForAgent(agentId: string): Promise<string> {
  const ownership = await pgStore?.getAgentOwnership(agentId);
  return ownership?.accountId ?? agentId;
}

function assertAmount(credits: number): void {
  if (!Number.isFinite(credits) || credits <= 0) throw new Error("invalid_credit_amount");
}

/**
 * #108: credits are stored as NUMERIC(30,6). Round here too, so the returned transaction
 * matches the stored row and an amount that rounds to 0 is rejected instead of writing 0.
 */
export function roundCredits(credits: number): number {
  return Math.round(credits * 1_000_000) / 1_000_000;
}

/**
 * Atomic debit (#48). Postgres: balance check + insert in one transaction under a
 * per-account advisory lock. In-memory: synchronous check + insert.
 * Throws `insufficient_credits: <balance> < <credits>`; the balance never goes negative.
 */
async function debit(accountId: string, rawCredits: number, reason: string, relatedTaskId?: string, txId?: string): Promise<CreditTransaction> {
  assertAmount(rawCredits);
  const credits = roundCredits(rawCredits);
  assertAmount(credits);
  if (pgStore) {
    const tx: CreditTransaction = {
      txId: txId ?? randomUUID(),
      accountId,
      type: "spend",
      credits,
      reason,
      relatedTaskId,
      timestampMs: Date.now()
    };
    const result = await pgStore.debitCredits(tx);
    if (result.status === "duplicate") throw new DuplicateDebitError(tx.txId);
    if (result.status === "insufficient") {
      throw new Error(`insufficient_credits: ${result.balance} < ${credits}`);
    }
    return tx;
  }
  if (txId) {
    if (creditEngine.history(accountId).some((t) => t.txId === txId)) throw new DuplicateDebitError(txId);
    const spent = creditEngine.spend(accountId, credits, reason, relatedTaskId);
    spent.txId = txId; // the engine keeps the same object, so the stored row carries the key too
    return spent;
  }
  return creditEngine.spend(accountId, credits, reason, relatedTaskId);
}

/**
 * A debit whose idempotency key was already charged (here or by another coordinator sharing
 * the database). Nothing was taken this time.
 */
export class DuplicateDebitError extends Error {
  constructor(readonly txId: string) {
    super(`duplicate_debit: ${txId}`);
    this.name = "DuplicateDebitError";
  }
}

/**
 * Debit `credits`. With `opts.idempotencyKey` the row's tx id is derived from it, so the same
 * charge submitted twice (a retry, or the same task sent to both seeds) is taken once; the
 * second call throws DuplicateDebitError.
 */
export async function spendCredits(
  accountId: string,
  credits: number,
  reason: string,
  relatedTaskId?: string,
  opts: { idempotencyKey?: string } = {}
) {
  return debit(accountId, credits, reason, relatedTaskId, opts.idempotencyKey ? debitTxId(opts.idempotencyKey) : undefined);
}

/** Deterministic tx id for an idempotent debit (same shape as refundTxId). */
export function debitTxId(idempotencyKey: string): string {
  return `debit:${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}

/**
 * Grant-only helper for callers that must never debit (the Lightning payment
 * settler, #42/#48). Zero is a no-op that returns null (a paid intent whose
 * quote rounded to 0 credits must not throw after it was marked settled);
 * negative or non-finite amounts throw, so a bad sign can never become a debit.
 */
export async function grantCredits(accountId: string, credits: number, reason: string) {
  if (credits === 0) return null;
  assertAmount(credits);
  return adjustCredits(accountId, credits, reason);
}

/**
 * #160: grant with a caller-chosen tx id. Re-running with the same id is a no-op
 * (Postgres: ON CONFLICT (tx_id) DO NOTHING; in-memory: id check), so a refund that
 * threw half-way can be retried without paying twice.
 */
export async function grantCreditsIdempotent(accountId: string, credits: number, reason: string, txId: string) {
  if (credits === 0) return null;
  assertAmount(credits);
  if (!txId.trim()) throw new Error("invalid_tx_id");
  const tx: CreditTransaction = { txId, accountId, type: "earn", credits, reason, timestampMs: Date.now() };
  if (pgStore) {
    await pgStore.persistCreditTransaction(tx);
    return tx;
  }
  return creditEngine.addIfAbsent(tx);
}

/** Deterministic tx id for the one-time refund of a task's submit charge (#160). */
export function refundTxId(taskId: string): string {
  return `task_submit_refund:${createHash("sha256").update(taskId).digest("hex").slice(0, 32)}`;
}

/** Positive = grant (earn). Negative = debit, which is balance-checked like a spend (#48). */
export async function adjustCredits(accountId: string, rawCredits: number, reason: string) {
  if (!Number.isFinite(rawCredits)) throw new Error("invalid_credit_amount");
  const credits = roundCredits(rawCredits);
  if (credits === 0) throw new Error("invalid_credit_amount");
  if (credits < 0) return debit(accountId, -credits, reason);
  if (pgStore) {
    const tx: CreditTransaction = {
      txId: randomUUID(),
      accountId,
      type: "earn",
      credits,
      reason,
      timestampMs: Date.now()
    };
    await pgStore.persistCreditTransaction(tx);
    return tx;
  }
  return creditEngine.adjust(accountId, credits, reason);
}
