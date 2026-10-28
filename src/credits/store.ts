// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import { CreditEngine } from "./engine.js";
import { ComputeContributionReport, CreditTransaction } from "../common/types.js";
import { contributionCredits, LoadSnapshot } from "./pricing.js";
import { pgStore } from "../db/store.js";

export const creditEngine = new CreditEngine();

/**
 * Accrue credits for a contribution report. Idempotent on `report.reportId`
 * (#44): returns null when the report was already recorded.
 */
export async function accrueCredits(
  report: ComputeContributionReport,
  load: LoadSnapshot
): Promise<CreditTransaction | null> {
  if (pgStore) {
    const computeSeconds = report.resourceClass === "gpu" ? report.gpuSeconds : report.cpuSeconds;
    const qualityMultiplier = Math.max(0.5, Math.min(1.5, report.qualityScore));
    const credits = contributionCredits(report, load); // #38: single formula
    const resourceWeight = report.resourceClass === "gpu" ? 2 : 1;
    const reliabilityScore = report.success ? 1 : 0.75;
    const weightedContribution = Number((computeSeconds * resourceWeight * qualityMultiplier * reliabilityScore).toFixed(6));
    const tx: CreditTransaction = {
      txId: randomUUID(),
      accountId: report.agentId,
      type: "earn",
      credits,
      reason: "compute_contribution",
      relatedTaskId: report.taskId,
      timestampMs: Date.now()
    };
    // Report + credit atomically; false => report id already recorded (idempotent re-post).
    const inserted = await pgStore.persistContributionWithCredit(
      {
        report,
        accountId: report.agentId,
        sourceAgentId: report.sourceAgentId ?? report.agentId,
        reliabilityScore,
        weightedContribution
      },
      tx
    );
    return inserted ? tx : null;
  }
  try {
    return creditEngine.accrue(report, load);
  } catch (error) {
    if (error instanceof Error && error.message === "duplicate_contribution_report") return null;
    throw error;
  }
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
