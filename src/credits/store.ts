import { randomUUID } from "node:crypto";
import { CreditEngine } from "./engine.js";
import { ComputeContributionReport, CreditTransaction } from "../common/types.js";
import { baseRatePerSecond, loadMultiplier, LoadSnapshot } from "./pricing.js";
import { pgStore } from "../db/store.js";

export const creditEngine = new CreditEngine();

export async function accrueCredits(
  report: ComputeContributionReport,
  load: LoadSnapshot
) {
  if (pgStore) {
    const computeSeconds = report.resourceClass === "gpu" ? report.gpuSeconds : report.cpuSeconds;
    const qualityMultiplier = Math.max(0.5, Math.min(1.5, report.qualityScore));
    const credits =
      computeSeconds *
      baseRatePerSecond(report.resourceClass) *
      qualityMultiplier *
      loadMultiplier(load);
    const tx: CreditTransaction = {
      txId: randomUUID(),
      accountId: report.agentId,
      type: "earn",
      credits: Number(credits.toFixed(3)),
      reason: "compute_contribution",
      relatedTaskId: report.taskId,
      timestampMs: Date.now()
    };
    await pgStore.persistCreditTransaction(tx);
    return tx;
  }
  const tx = creditEngine.accrue(report, load);
  return tx;
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
