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

export async function spendCredits(
  accountId: string,
  credits: number,
  reason: string,
  relatedTaskId?: string
) {
  if (pgStore) {
    const current = await pgStore.creditBalance(accountId);
    if (current < credits) {
      throw new Error(`insufficient_credits: ${current} < ${credits}`);
    }
    const tx: CreditTransaction = {
      txId: randomUUID(),
      accountId,
      type: "spend",
      credits,
      reason,
      relatedTaskId,
      timestampMs: Date.now()
    };
    await pgStore.persistCreditTransaction(tx);
    return tx;
  }
  const tx = creditEngine.spend(accountId, credits, reason, relatedTaskId);
  return tx;
}

export async function adjustCredits(accountId: string, credits: number, reason: string) {
  if (pgStore) {
    const tx: CreditTransaction = {
      txId: randomUUID(),
      accountId,
      type: credits >= 0 ? "earn" : "spend",
      credits: Math.abs(credits),
      reason,
      timestampMs: Date.now()
    };
    await pgStore.persistCreditTransaction(tx);
    return tx;
  }
  const tx = creditEngine.adjust(accountId, credits, reason);
  return tx;
}
