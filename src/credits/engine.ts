// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import { ComputeContributionReport, CreditTransaction } from "../common/types.js";
import { baseRatePerSecond, loadMultiplier, LoadSnapshot } from "./pricing.js";

/** #108: in-memory balances use integer micro-credits (6 decimals, matching the Postgres migration). */
const MICROS = 1_000_000;
const toMicros = (credits: number) => Math.round(credits * MICROS);

export class CreditEngine {
  private readonly txByAccount = new Map<string, CreditTransaction[]>();
  private readonly seenReports = new Set<string>();

  balance(accountId: string): number {
    return this.balanceMicros(accountId) / MICROS;
  }

  /** #108: sum in integer micro-credits so 0.1 + 0.2 covers a 0.3 spend exactly. */
  private balanceMicros(accountId: string): number {
    return (this.txByAccount.get(accountId) ?? []).reduce((sum, tx) => {
      const m = toMicros(tx.credits);
      return sum + (tx.type === "spend" ? -m : m);
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
    if (this.balanceMicros(accountId) < toMicros(credits)) {
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
    // #48: negative adjustments are debits and can't take the balance below zero.
    const debit = Math.abs(credits);
    const current = this.balance(accountId);
    if (this.balanceMicros(accountId) < toMicros(debit)) {
      throw new Error(`insufficient_credits: ${current} < ${debit}`);
    }
    return this.addTx(accountId, { type: "spend", credits: debit, reason });
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
      credits: Math.round(input.credits * MICROS) / MICROS, // #108: 6 decimals, like Postgres
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
