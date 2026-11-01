// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash, randomUUID } from "node:crypto";
import { CreditEngine } from "./engine.js";
import { ComputeContributionReport, CreditTransaction } from "../common/types.js";
import { contributionCredits, splitNetworkFee, LoadSnapshot } from "./pricing.js";
import { pgStore } from "../db/store.js";

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
 * Atomic debit (#48). Postgres: balance check + insert in one transaction under a
 * per-account advisory lock. In-memory: synchronous check + insert.
 * Throws `insufficient_credits: <balance> < <credits>`; the balance never goes negative.
 */
async function debit(accountId: string, credits: number, reason: string, relatedTaskId?: string): Promise<CreditTransaction> {
  assertAmount(credits);
  if (pgStore) {
    const tx: CreditTransaction = {
      txId: randomUUID(),
      accountId,
      type: "spend",
      credits,
      reason,
      relatedTaskId,
      timestampMs: Date.now()
    };
    const result = await pgStore.debitCredits(tx);
    if (result.status === "insufficient") {
      throw new Error(`insufficient_credits: ${result.balance} < ${credits}`);
    }
    return tx;
  }
  return creditEngine.spend(accountId, credits, reason, relatedTaskId);
}

export async function spendCredits(
  accountId: string,
  credits: number,
  reason: string,
  relatedTaskId?: string
) {
  return debit(accountId, credits, reason, relatedTaskId);
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
export async function adjustCredits(accountId: string, credits: number, reason: string) {
  if (!Number.isFinite(credits) || credits === 0) throw new Error("invalid_credit_amount");
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
