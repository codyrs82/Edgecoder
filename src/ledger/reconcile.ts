// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * #115: credits-ledger reconciliation (read-only; it never corrects anything, fixes stay a manual
 * admin step). Input is a snapshot read from Postgres (PostgresStore.ledgerReconcileInput); this
 * module is pure so every rule is unit-testable.
 *
 * What is checked, and what can actually be recomputed:
 *  - Balances: there is no stored balance column (a balance is always SUM(earn) - SUM(spend) over
 *    credit_transactions), so the per-account check is the invariant that no balance is negative
 *    (#48) plus the stored earnings projection (coordinator_earnings_projection.total_credits),
 *    which must equal the credits of that account's earnings_accrual ledger records.
 *  - Accruals (priced jobs, job-pricing.ts / accruePricedJob): every compute_contribution report
 *    `result:<subtaskId>` needs exactly one earnings_accrual record. From its payload the network
 *    fee split (splitJobCost(costMsat, networkFeeBps) -> msat, feeMsat, credits) is recomputed for
 *    every priced accrual, and for per-second jobs also the cost (jobCostMsat(durationMs,
 *    ratePerSecondMsat)) and the rate (msatPerCredit x creditsPerSecond, msatPerCredit is stored
 *    rounded). Token-priced model calls don't record token counts or the BTC price, so only their
 *    split is recomputable. Accruals from before priced jobs (no costMsat in the payload) depended
 *    on a load snapshot that wasn't recorded: counted as not recomputable.
 *  - Credit rows: per (account, task) the compute_contribution earn rows must match the accruals
 *    (row count = report count, credits and msat sums); per task the network-fee rows must match
 *    the accruals' feeMsat. Reservation leases (report `reservation:<id>`, no ledger record) must
 *    have paid agent + fee = the lease's usedMsat.
 *  - Ordering: duplicate earnings_accrual records for one report id, ledger_records forks (two
 *    records on one prev_hash), duplicate hashes, and sequence breaks between linked records.
 *    A record whose predecessor isn't stored is a gap; gaps are reported as warnings, not
 *    mismatches, because some ordering events are never persisted (payout_settled,
 *    fee_pool_distribution, payouts_pause_changed) and persistence is best effort. Stored hashes
 *    can't be recomputed: ledger_records keeps no payload and stats_ledger_records keeps it as
 *    JSONB (key order not preserved).
 */
import { jobCostMsat, splitJobCost } from "../economy/job-pricing.js";

export interface ReconcileInput {
  /** Per account: earned and spent credits (NUMERIC sums as strings or numbers) and row count. */
  balances: Array<{ accountId: string; earned: string | number; spent: string | number; rows: number }>;
  /** compute_contribution_reports. */
  reports: Array<{ reportId: string; accountId: string; taskId: string }>;
  /** stats_ledger_records with event_type = earnings_accrual. */
  accrualRecords: Array<{ id: string; subtaskId: string | null; taskId: string; actorId: string; coordinatorId: string | null; payload: Record<string, unknown> | null }>;
  /** compute_contribution earn rows grouped by (account, task). */
  earnRows: Array<{ accountId: string; taskId: string | null; rows: number; credits: string | number; msat: string | number | null; msatRows: number }>;
  /** Fee-pool earn rows grouped by reason (network_fee:<taskId>). */
  feeRows: Array<{ taskId: string; rows: number; msat: string | number | null }>;
  /** coordinator_earnings_projection. */
  projections: Array<{ accountId: string; totalCredits: string | number }>;
  /** Ended reservation leases. */
  reservations: Array<{ id: string; agentAccountId: string; usedMsat: number }>;
  /** ledger_records structure. */
  chain: {
    records: number;
    forks: Array<{ prevHash: string; count: number }>;
    duplicateHashes: Array<{ hash: string; count: number }>;
    sequenceBreaks: Array<{ id: string; sequence: number; prevSequence: number }>;
    gaps: number;
  };
}

export type DiscrepancyKind =
  | "negative_balance"
  | "earnings_projection_mismatch"
  | "accrual_missing_ledger_record"
  | "duplicate_accrual_record"
  | "accrual_account_mismatch"
  | "accrual_pricing_mismatch"
  | "ledger_record_without_report"
  | "credit_without_report"
  | "accrual_without_credit"
  | "duplicate_credit_rows"
  | "credit_amount_mismatch"
  | "fee_mismatch"
  | "reservation_settlement_mismatch"
  | "ledger_chain_fork"
  | "ledger_duplicate_hash"
  | "ledger_sequence_break";

export interface Discrepancy {
  kind: DiscrepancyKind;
  accountId?: string;
  taskId?: string;
  reportId?: string;
  detail: Record<string, unknown>;
}

export interface ReconcileReport {
  ok: boolean;
  accountsChecked: number;
  accrualsChecked: number;
  accrualsRecomputed: number;
  /** Accruals whose credits can't be recomputed from what was recorded (see module comment). */
  notRecomputable: { legacyAccruals: number; tokenPricedSplitOnly: number };
  reservationsChecked: number;
  ledgerRecordsChecked: number;
  mismatches: number;
  byKind: Partial<Record<DiscrepancyKind, number>>;
  /** The first N discrepancies. */
  discrepancies: Discrepancy[];
  warnings: { chainGaps: number; foreignAccrualRecords: number };
}

/** Credits are NUMERIC(30,6): compare in integer micro-credits. */
const micro = (v: string | number | null | undefined): number => Math.round(Number(v ?? 0) * 1_000_000);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const roundCreditsMicro = (msat: number): number => Math.round((msat / 1000) * 1_000_000);

export function reconcileLedger(input: ReconcileInput, opts: { maxDiscrepancies?: number; localCoordinatorIds?: string[]; feePoolAccountId?: string } = {}): ReconcileReport {
  const max = Math.max(0, opts.maxDiscrepancies ?? 50);
  const local = new Set(opts.localCoordinatorIds ?? []);
  const byKind: Partial<Record<DiscrepancyKind, number>> = {};
  const discrepancies: Discrepancy[] = [];
  const flag = (d: Discrepancy) => {
    byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
    if (discrepancies.length < max) discrepancies.push(d);
  };
  const key = (account: string, task: string) => `${account}\u0000${task}`;

  // ── Balances ──
  for (const b of input.balances) {
    const balance = micro(b.earned) - micro(b.spent);
    if (balance < 0) flag({ kind: "negative_balance", accountId: b.accountId, detail: { balance: balance / 1e6, earned: Number(b.earned), spent: Number(b.spent) } });
  }

  // ── Accrual records by report id ──
  const recordsBySubtask = new Map<string, ReconcileInput["accrualRecords"]>();
  for (const r of input.accrualRecords) {
    if (!r.subtaskId) continue;
    const list = recordsBySubtask.get(r.subtaskId) ?? [];
    list.push(r);
    recordsBySubtask.set(r.subtaskId, list);
  }
  for (const [subtaskId, list] of recordsBySubtask) {
    if (list.length > 1) flag({ kind: "duplicate_accrual_record", reportId: `result:${subtaskId}`, taskId: list[0].taskId, detail: { records: list.map((r) => r.id) } });
  }

  // ── Projection: stored running total vs the ledger's accrual credits ──
  const ledgerCredits = new Map<string, number>();
  for (const r of input.accrualRecords) {
    const c = num(r.payload?.credits) ?? num(r.payload?.estimatedCredits) ?? 0;
    if (c > 0) ledgerCredits.set(r.actorId, (ledgerCredits.get(r.actorId) ?? 0) + c);
  }
  for (const p of input.projections) {
    const expected = ledgerCredits.get(p.accountId) ?? 0;
    const stored = Number(p.totalCredits);
    // Projection is DOUBLE PRECISION: allow float noise, not a missing or doubled accrual.
    if (Math.abs(stored - expected) > 1e-6 * Math.max(1, Math.abs(expected))) {
      flag({ kind: "earnings_projection_mismatch", accountId: p.accountId, detail: { stored, fromLedger: expected } });
    }
  }
  for (const [accountId, expected] of ledgerCredits) {
    if (!input.projections.some((p) => p.accountId === accountId)) flag({ kind: "earnings_projection_mismatch", accountId, detail: { stored: null, fromLedger: expected } });
  }

  // ── Accruals: one record per report, recomputed from its inputs ──
  type Expected = { reports: number; credits: number; msat: number; msatKnown: boolean; comparable: boolean };
  const expected = new Map<string, Expected>();
  const expectedFeeByTask = new Map<string, number>();
  /** Tasks whose fee rows can't be compared: a legacy, unrecorded or unpriced accrual among them. */
  const feeIncomparable = new Set<string>();
  const reportSubtasks = new Set<string>();
  let accrualsChecked = 0;
  let accrualsRecomputed = 0;
  let legacyAccruals = 0;
  let tokenPricedSplitOnly = 0;
  for (const rep of input.reports) {
    const k = key(rep.accountId, rep.taskId);
    const e = expected.get(k) ?? { reports: 0, credits: 0, msat: 0, msatKnown: true, comparable: true };
    e.reports++;
    expected.set(k, e);
    if (rep.reportId.startsWith("reservation:")) {
      e.comparable = false; // checked against the lease below
      continue;
    }
    if (!rep.reportId.startsWith("result:")) {
      legacyAccruals++;
      e.comparable = false;
      feeIncomparable.add(rep.taskId);
      continue;
    }
    const subtaskId = rep.reportId.slice("result:".length);
    reportSubtasks.add(subtaskId);
    accrualsChecked++;
    const records = recordsBySubtask.get(subtaskId) ?? [];
    if (records.length === 0) {
      flag({ kind: "accrual_missing_ledger_record", accountId: rep.accountId, taskId: rep.taskId, reportId: rep.reportId, detail: {} });
      e.comparable = false;
      feeIncomparable.add(rep.taskId);
      continue;
    }
    const rec = records[0];
    const p = rec.payload ?? {};
    const payloadAccount = typeof p.accountId === "string" ? p.accountId : rec.actorId;
    if (rec.actorId !== rep.accountId || payloadAccount !== rep.accountId) {
      flag({ kind: "accrual_account_mismatch", accountId: rep.accountId, taskId: rep.taskId, reportId: rep.reportId, detail: { recordActor: rec.actorId, payloadAccount } });
    }
    const credits = num(p.credits);
    if (credits === undefined) {
      e.comparable = false;
      feeIncomparable.add(rep.taskId);
      continue;
    }
    e.credits += Math.round(credits * 1_000_000);
    const msat = num(p.msat);
    if (msat === undefined) e.msatKnown = false;
    else e.msat += msat;

    const costMsat = num(p.costMsat);
    const feeBps = num(p.networkFeeBps);
    if (costMsat === undefined || feeBps === undefined) {
      legacyAccruals++;
      feeIncomparable.add(rep.taskId);
      continue;
    }
    accrualsRecomputed++;
    const problems: Record<string, unknown> = {};
    const split = splitJobCost(costMsat, feeBps);
    if (msat !== split.agentMsat) problems.msat = { recorded: msat ?? null, recomputed: split.agentMsat };
    if (num(p.feeMsat) !== split.feeMsat) problems.feeMsat = { recorded: p.feeMsat ?? null, recomputed: split.feeMsat };
    if (Math.round(credits * 1_000_000) !== roundCreditsMicro(split.agentMsat)) problems.credits = { recorded: credits, recomputed: roundCreditsMicro(split.agentMsat) / 1e6 };
    if (p.pricingBasis === "per_second") {
      const rate = num(p.ratePerSecondMsat);
      const durationMs = num(p.durationMs);
      if (rate !== undefined && durationMs !== undefined) {
        const cost = jobCostMsat(durationMs, rate);
        if (cost !== costMsat) problems.costMsat = { recorded: costMsat, recomputed: cost, durationMs, ratePerSecondMsat: rate };
      }
      const perCredit = num(p.msatPerCredit);
      const cps = num(p.creditsPerSecond);
      // msatPerCredit is recorded rounded to a whole msat, the rate isn't: allow that rounding.
      if (rate !== undefined && perCredit !== undefined && cps !== undefined && Math.abs(rate - perCredit * cps) > 0.5 * Math.max(0, cps) + 1e-9) {
        problems.ratePerSecondMsat = { recorded: rate, msatPerCredit: perCredit, creditsPerSecond: cps };
      }
    } else {
      tokenPricedSplitOnly++;
    }
    if (Object.keys(problems).length) flag({ kind: "accrual_pricing_mismatch", accountId: rep.accountId, taskId: rep.taskId, reportId: rep.reportId, detail: problems });
    expectedFeeByTask.set(rep.taskId, (expectedFeeByTask.get(rep.taskId) ?? 0) + split.feeMsat);
  }

  // Ledger records with no report: a credited accrual that never happened, or one made by a
  // coordinator on another database (stats sync ingests other coordinators' records).
  let foreignAccrualRecords = 0;
  for (const [subtaskId, list] of recordsBySubtask) {
    if (reportSubtasks.has(subtaskId)) continue;
    const r = list[0];
    if (r.coordinatorId && local.has(r.coordinatorId)) {
      flag({ kind: "ledger_record_without_report", accountId: r.actorId, taskId: r.taskId, reportId: `result:${subtaskId}`, detail: { recordId: r.id } });
    } else {
      foreignAccrualRecords++;
    }
  }

  // ── Credit rows vs accruals ──
  const seen = new Set<string>();
  for (const g of input.earnRows) {
    const taskId = g.taskId ?? "";
    const k = key(g.accountId, taskId);
    seen.add(k);
    const e = expected.get(k);
    if (!e) {
      flag({ kind: "credit_without_report", accountId: g.accountId, taskId, detail: { rows: g.rows, credits: Number(g.credits) } });
      continue;
    }
    if (g.rows > e.reports) flag({ kind: "duplicate_credit_rows", accountId: g.accountId, taskId, detail: { rows: g.rows, reports: e.reports } });
    if (!e.comparable) continue;
    const creditsOff = micro(g.credits) !== e.credits;
    const msatOff = e.msatKnown && g.msatRows === g.rows && Number(g.msat ?? 0) !== e.msat;
    if (creditsOff || msatOff) {
      flag({ kind: "credit_amount_mismatch", accountId: g.accountId, taskId, detail: { credits: { rows: Number(g.credits), accruals: e.credits / 1e6 }, msat: { rows: g.msat === null ? null : Number(g.msat), accruals: e.msatKnown ? e.msat : null } } });
    }
  }
  for (const [k, e] of expected) {
    if (seen.has(k) || !e.comparable || e.credits <= 0) continue;
    const [accountId, taskId] = k.split("\u0000");
    flag({ kind: "accrual_without_credit", accountId, taskId, detail: { reports: e.reports, credits: e.credits / 1e6 } });
  }

  // ── Network fee rows vs accruals ──
  const feeRows = new Map(input.feeRows.map((f) => [f.taskId, f]));
  for (const [taskId, feeMsat] of expectedFeeByTask) {
    if (feeIncomparable.has(taskId)) continue;
    const row = feeRows.get(taskId);
    const paid = Number(row?.msat ?? 0);
    if (paid !== feeMsat) flag({ kind: "fee_mismatch", accountId: opts.feePoolAccountId, taskId, detail: { rowsMsat: row ? paid : null, accrualsMsat: feeMsat, rows: row?.rows ?? 0 } });
  }

  // ── Reservation leases: agent + fee = what the lease used ──
  const earnByKey = new Map(input.earnRows.map((g) => [key(g.accountId, g.taskId ?? ""), g]));
  const reportIds = new Set(input.reports.map((r) => r.reportId));
  let reservationsChecked = 0;
  for (const r of input.reservations) {
    const taskId = `reservation:${r.id}`;
    if (!reportIds.has(taskId)) continue; // nothing accrued (used nothing, or settle pending)
    reservationsChecked++;
    const agent = earnByKey.get(key(r.agentAccountId, taskId));
    const fee = feeRows.get(taskId);
    const paid = Number(agent?.msat ?? 0) + Number(fee?.msat ?? 0);
    if (!agent || paid !== Math.round(r.usedMsat)) {
      flag({ kind: "reservation_settlement_mismatch", accountId: r.agentAccountId, taskId, detail: { usedMsat: r.usedMsat, agentMsat: agent ? Number(agent.msat ?? 0) : null, feeMsat: fee ? Number(fee.msat ?? 0) : null } });
    }
  }

  // ── Ordering (ledger_records) ──
  for (const f of input.chain.forks) flag({ kind: "ledger_chain_fork", detail: { prevHash: f.prevHash, records: f.count } });
  for (const d of input.chain.duplicateHashes) flag({ kind: "ledger_duplicate_hash", detail: { hash: d.hash, records: d.count } });
  for (const s of input.chain.sequenceBreaks) flag({ kind: "ledger_sequence_break", detail: { recordId: s.id, sequence: s.sequence, prevSequence: s.prevSequence } });

  const mismatches = Object.values(byKind).reduce((a, b) => a + (b ?? 0), 0);
  return {
    ok: mismatches === 0,
    accountsChecked: input.balances.length,
    accrualsChecked,
    accrualsRecomputed,
    notRecomputable: { legacyAccruals, tokenPricedSplitOnly },
    reservationsChecked,
    ledgerRecordsChecked: input.chain.records,
    mismatches,
    byKind,
    discrepancies,
    warnings: { chainGaps: input.chain.gaps, foreignAccrualRecords }
  };
}
