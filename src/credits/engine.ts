// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import { ComputeContributionReport, CreditTransaction } from "../common/types.js";
import { contributionCredits, LoadSnapshot } from "./pricing.js";

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

  /** Sats value (msat) of everything this account earned, as locked at accrual time. */
  earnedMsat(accountId: string): number {
    return (this.txByAccount.get(accountId) ?? []).reduce((sum, tx) => sum + (tx.type === "earn" ? Math.floor(tx.msat ?? 0) : 0), 0);
  }

  /** Mark a contribution report as recorded; false when it already was (#44 idempotency). */
  claimReport(reportId: string): boolean {
    if (this.seenReports.has(reportId)) return false;
    this.seenReports.add(reportId);
    return true;
  }

  accrue(report: ComputeContributionReport, load: LoadSnapshot, valuation?: { msatPerCredit: number }): CreditTransaction {
    if (this.seenReports.has(report.reportId)) {
      throw new Error("duplicate_contribution_report");
    }
    this.seenReports.add(report.reportId);
    const credits = contributionCredits(report, load); // #38: same formula as the Postgres path
    if (credits <= 0) {
      // #38: failed work earns 0 under measured credits; record nothing for it.
      return {
        txId: randomUUID(),
        accountId: report.agentId,
        type: "earn",
        credits: 0,
        reason: "compute_contribution",
        relatedTaskId: report.taskId,
        timestampMs: Date.now()
      };
    }
    return this.addTx(report.agentId, {
      type: "earn",
      credits,
      reason: "compute_contribution",
      relatedTaskId: report.taskId,
      ...(valuation ? { msat: Math.round(credits * valuation.msatPerCredit) } : {})
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

  /** #160: record `tx` unless a transaction with the same txId already exists (returns the existing one). */
  addIfAbsent(tx: CreditTransaction): CreditTransaction {
    const existing = (this.txByAccount.get(tx.accountId) ?? []).find((t) => t.txId === tx.txId);
    if (existing) return existing;
    const list = this.txByAccount.get(tx.accountId) ?? [];
    list.push({ ...tx });
    this.txByAccount.set(tx.accountId, list);
    return tx;
  }

  /** Append an arbitrary row (fee-pool credits, distributions); idempotent on txId. */
  record(tx: CreditTransaction): CreditTransaction {
    return this.addIfAbsent(tx);
  }

  private addTx(
    accountId: string,
    input: {
      type: CreditTransaction["type"];
      credits: number;
      reason: string;
      relatedTaskId?: string;
      msat?: number;
    }
  ): CreditTransaction {
    const tx: CreditTransaction = {
      txId: randomUUID(),
      accountId,
      type: input.type,
      credits: Math.round(input.credits * MICROS) / MICROS, // #108: 6 decimals, like Postgres
      reason: input.reason,
      relatedTaskId: input.relatedTaskId,
      timestampMs: Date.now(),
      ...(input.msat !== undefined ? { msat: input.msat } : {})
    };
    const existing = this.txByAccount.get(accountId) ?? [];
    existing.push(tx);
    this.txByAccount.set(accountId, existing);
    return tx;
  }
}
