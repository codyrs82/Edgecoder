import { describe, expect, it } from "vitest";
import { splitJobCost } from "../../src/economy/job-pricing.js";
import { reconcileLedger, type ReconcileInput } from "../../src/ledger/reconcile.js";

// #115: the reconciliation rules on hand-built snapshots (the Postgres reads are covered by
// tests/ledger/ledger-verify-pg.test.ts).

const FEE = "network:fee_pool";
const emptyChain = { records: 0, forks: [], duplicateHashes: [], sequenceBreaks: [], gaps: 0 };

function pricedAccrual(subtaskId: string, account: string, taskId: string, costMsat: number, extra: Record<string, unknown> = {}) {
  const { agentMsat, feeMsat } = splitJobCost(costMsat, 1000);
  return {
    record: { id: `rec-${subtaskId}`, subtaskId, taskId, actorId: account, coordinatorId: "coord-a", payload: { accountId: account, credits: agentMsat / 1000, msat: agentMsat, costMsat, feeMsat, networkFeeBps: 1000, pricingBasis: "tokens", ...extra } },
    agentMsat,
    feeMsat
  };
}

function snapshot(over: Partial<ReconcileInput> = {}): ReconcileInput {
  const a = pricedAccrual("s1", "acct", "t1", 10_000);
  return {
    balances: [{ accountId: "acct", earned: a.agentMsat / 1000, spent: 0, rows: 1 }],
    reports: [{ reportId: "result:s1", accountId: "acct", taskId: "t1" }],
    accrualRecords: [a.record],
    earnRows: [{ accountId: "acct", taskId: "t1", rows: 1, credits: String(a.agentMsat / 1000), msat: String(a.agentMsat), msatRows: 1 }],
    feeRows: [{ taskId: "t1", rows: 1, msat: String(a.feeMsat) }],
    projections: [{ accountId: "acct", totalCredits: a.agentMsat / 1000 }],
    reservations: [],
    chain: emptyChain,
    ...over
  };
}
const run = (s: ReconcileInput) => reconcileLedger(s, { localCoordinatorIds: ["coord-a"], feePoolAccountId: FEE });

describe("#115 reconcileLedger", () => {
  it("a consistent snapshot is ok; a token-priced accrual has only its split recomputed", () => {
    const r = run(snapshot());
    expect(r).toMatchObject({ ok: true, mismatches: 0, accountsChecked: 1, accrualsChecked: 1, accrualsRecomputed: 1, notRecomputable: { legacyAccruals: 0, tokenPricedSplitOnly: 1 } });
  });

  it("flags a negative balance", () => {
    const r = run(snapshot({ balances: [{ accountId: "acct", earned: "1.000000", spent: "1.000001", rows: 2 }] }));
    expect(r.byKind).toEqual({ negative_balance: 1 });
  });

  it("flags a per-second accrual whose cost doesn't follow from duration x rate", () => {
    const a = pricedAccrual("s1", "acct", "t1", 10_000, { pricingBasis: "per_second", durationMs: 1_000, ratePerSecondMsat: 9_000, msatPerCredit: 9_000, creditsPerSecond: 1 });
    const r = run(snapshot({ accrualRecords: [a.record] }));
    expect(r.byKind).toEqual({ accrual_pricing_mismatch: 1 });
    expect(r.discrepancies[0].detail.costMsat).toMatchObject({ recorded: 10_000, recomputed: 9_000 });
  });

  it("flags duplicate ledger records for one report id", () => {
    const a = pricedAccrual("s1", "acct", "t1", 10_000);
    const r = run(snapshot({ accrualRecords: [a.record, { ...a.record, id: "rec-dup" }], projections: [{ accountId: "acct", totalCredits: (2 * a.agentMsat) / 1000 }] }));
    expect(r.byKind).toEqual({ duplicate_accrual_record: 1 });
  });

  it("a fee row that doesn't match the accruals' fee is flagged", () => {
    const r = run(snapshot({ feeRows: [{ taskId: "t1", rows: 2, msat: "2000" }] }));
    expect(r.byKind).toEqual({ fee_mismatch: 1 });
  });

  it("credit rows with no report are flagged; ledger records with no report only when this database's coordinator wrote them", () => {
    const orphanLocal = pricedAccrual("s9", "acct", "t9", 5_000).record;
    const foreign = { ...pricedAccrual("s8", "other", "t8", 5_000).record, coordinatorId: "coord-elsewhere" };
    const s = snapshot({
      accrualRecords: [snapshot().accrualRecords[0], orphanLocal, foreign],
      earnRows: [...snapshot().earnRows, { accountId: "acct", taskId: "t7", rows: 1, credits: "1", msat: "1000", msatRows: 1 }],
      projections: [{ accountId: "acct", totalCredits: 9 + 4.5 }, { accountId: "other", totalCredits: 4.5 }]
    });
    const r = run(s);
    expect(r.byKind).toEqual({ ledger_record_without_report: 1, credit_without_report: 1 });
    expect(r.warnings.foreignAccrualRecords).toBe(1);
  });

  it("legacy accruals (no recorded pricing inputs) are counted, not recomputed", () => {
    const r = run(snapshot({ reports: [...snapshot().reports, { reportId: "legacy-123", accountId: "acct", taskId: "t0" }], earnRows: [...snapshot().earnRows, { accountId: "acct", taskId: "t0", rows: 1, credits: "3", msat: null, msatRows: 0 }] }));
    expect(r.ok).toBe(true);
    expect(r.notRecomputable.legacyAccruals).toBe(1);
  });

  it("a reservation must have paid agent + fee = usedMsat", () => {
    const base = snapshot();
    const res = {
      reports: [...base.reports, { reportId: "reservation:r1", accountId: "owner", taskId: "reservation:r1" }],
      earnRows: [...base.earnRows, { accountId: "owner", taskId: "reservation:r1", rows: 1, credits: "0.9", msat: "900", msatRows: 1 }],
      feeRows: [...base.feeRows, { taskId: "reservation:r1", rows: 1, msat: "100" }]
    };
    expect(run({ ...base, ...res, reservations: [{ id: "r1", agentAccountId: "owner", usedMsat: 1000 }] }).ok).toBe(true);
    const r = run({ ...base, ...res, reservations: [{ id: "r1", agentAccountId: "owner", usedMsat: 1500 }] });
    expect(r.byKind).toEqual({ reservation_settlement_mismatch: 1 });
    expect(r.reservationsChecked).toBe(1);
  });

  it("chain: forks, duplicate hashes and sequence breaks are mismatches; gaps are warnings", () => {
    const r = run(snapshot({ chain: { records: 10, forks: [{ prevHash: "h1", count: 2 }], duplicateHashes: [{ hash: "h2", count: 2 }], sequenceBreaks: [{ id: "x", sequence: 9, prevSequence: 3 }], gaps: 4 } }));
    expect(r.byKind).toEqual({ ledger_chain_fork: 1, ledger_duplicate_hash: 1, ledger_sequence_break: 1 });
    expect(r.warnings.chainGaps).toBe(4);
    expect(r.ledgerRecordsChecked).toBe(10);
  });

  it("returns at most N discrepancies but counts them all", () => {
    const balances = Array.from({ length: 30 }, (_, i) => ({ accountId: `a${i}`, earned: 0, spent: 1, rows: 1 }));
    const r = reconcileLedger(snapshot({ balances }), { maxDiscrepancies: 5 });
    expect(r.mismatches).toBe(30);
    expect(r.discrepancies).toHaveLength(5);
  });
});
