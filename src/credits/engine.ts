// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import { ComputeContributionReport, CreditTransaction } from "../common/types.js";
import { baseRatePerSecond, loadMultiplier, LoadSnapshot } from "./pricing.js";

export class CreditEngine {
  private readonly txByAccount = new Map<string, CreditTransaction[]>();
  private readonly seenReports = new Set<string>();

  balance(accountId: string): number {
    return (this.txByAccount.get(accountId) ?? []).reduce((sum, tx) => {
      return sum + (tx.type === "spend" ? -tx.credits : tx.credits);
    }, 0);
  }

  history(accountId: string): CreditTransaction[] {
    return [...(this.txByAccount.get(accountId) ?? [])];
  }

  accrue(report: ComputeContributionReport, load: LoadSnapshot): CreditTransaction {
    if (this.seenReports.has(report.reportId)) {
      throw new Error("duplicate_contribution_report");
    }
    this.seenReports.add(report.reportId);
    const computeSeconds = report.resourceClass === "gpu" ? report.gpuSeconds : report.cpuSeconds;
    const qualityMultiplier = Math.max(0.5, Math.min(1.5, report.qualityScore));
    const credits =
      computeSeconds *
      baseRatePerSecond(report.resourceClass) *
      qualityMultiplier *
      loadMultiplier(load);
    return this.addTx(report.agentId, {
      type: "earn",
      credits: Number(credits.toFixed(3)),
      reason: "compute_contribution",
      relatedTaskId: report.taskId
    });
  }

  spend(accountId: string, credits: number, reason: string, relatedTaskId?: string): CreditTransaction {
    const current = this.balance(accountId);
    if (current < credits) {
      throw new Error(`insufficient_credits: ${current} < ${credits}`);
    }
    return this.addTx(accountId, {
      type: "spend",
      credits,
      reason,
      relatedTaskId
    });
  }

  adjust(accountId: string, credits: number, reason: string): CreditTransaction {
    if (credits >= 0) {
      return this.addTx(accountId, { type: "earn", credits, reason });
    }
    return this.addTx(accountId, { type: "spend", credits: Math.abs(credits), reason });
  }

  private addTx(
    accountId: string,
    input: {
      type: CreditTransaction["type"];
      credits: number;
      reason: string;
      relatedTaskId?: string;
    }
  ): CreditTransaction {
    const tx: CreditTransaction = {
      txId: randomUUID(),
      accountId,
      type: input.type,
      credits: input.credits,
      reason: input.reason,
      relatedTaskId: input.relatedTaskId,
      timestampMs: Date.now()
    };
    const existing = this.txByAccount.get(accountId) ?? [];
    existing.push(tx);
    this.txByAccount.set(accountId, existing);
    return tx;
  }
}
