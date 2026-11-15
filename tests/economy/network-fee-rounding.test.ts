import { describe, expect, it } from "vitest";
import { splitJobCost } from "../../src/economy/job-pricing.js";
import { reconcileLedger, type ReconcileInput } from "../../src/ledger/reconcile.js";

// Live regtest finding (2026-11-15): model calls cost 2-30 msat, and the 5 % network fee was
// floored to whole msat, so a 16 msat call paid EdgeCoder nothing (0.8 -> 0) and the host 100 %.
// Over the measured calls EdgeCoder kept well under the 5 % the owner set. The fee is now rounded
// to the nearest msat (unbiased); accruals recorded before carry no feeRounding and still verify
// with the old floor rule.

describe("network fee rounding", () => {
  it("rounds the fee to the nearest msat; the parts still add up", () => {
    expect(splitJobCost(16, 500)).toEqual({ agentMsat: 15, feeMsat: 1 });
    expect(splitJobCost(9, 500)).toEqual({ agentMsat: 9, feeMsat: 0 }); // 0.45
    expect(splitJobCost(10, 500)).toEqual({ agentMsat: 9, feeMsat: 1 }); // 0.5 rounds up
    expect(splitJobCost(11_160, 500)).toEqual({ agentMsat: 10_602, feeMsat: 558 });
    expect(splitJobCost(16, 500, "floor")).toEqual({ agentMsat: 16, feeMsat: 0 });
  });

  it("over many small calls the fee comes to 5 % (floor kept far less)", () => {
    let cost = 0, nearest = 0, floor = 0;
    for (let c = 2; c <= 40; c++) { cost += c; nearest += splitJobCost(c, 500).feeMsat; floor += splitJobCost(c, 500, "floor").feeMsat; }
    expect(Math.abs(nearest / cost - 0.05)).toBeLessThan(0.003);
    expect(floor / cost).toBeLessThan(0.035);
  });

  it("ledger verification recomputes old (floor) and new (nearest) accruals with the rule they were made with", () => {
    const acc = (id: string, costMsat: number, rounding?: "nearest") => {
      const s = splitJobCost(costMsat, 500, rounding ?? "floor");
      return { s, rec: { id: `rec-${id}`, subtaskId: id, taskId: `t-${id}`, actorId: "acct", coordinatorId: "c", payload: { accountId: "acct", credits: s.agentMsat / 1000, msat: s.agentMsat, costMsat, feeMsat: s.feeMsat, networkFeeBps: 500, pricingBasis: "tokens", ...(rounding ? { feeRounding: rounding } : {}) } } };
    };
    const old = acc("a", 16);
    const neu = acc("b", 16, "nearest");
    const input: ReconcileInput = {
      balances: [{ accountId: "acct", earned: (old.s.agentMsat + neu.s.agentMsat) / 1000, spent: 0, rows: 2 }],
      reports: [{ reportId: "result:a", accountId: "acct", taskId: "t-a" }, { reportId: "result:b", accountId: "acct", taskId: "t-b" }],
      accrualRecords: [old.rec, neu.rec],
      earnRows: [
        { accountId: "acct", taskId: "t-a", rows: 1, credits: String(old.s.agentMsat / 1000), msat: String(old.s.agentMsat), msatRows: 1 },
        { accountId: "acct", taskId: "t-b", rows: 1, credits: String(neu.s.agentMsat / 1000), msat: String(neu.s.agentMsat), msatRows: 1 }
      ],
      feeRows: [{ taskId: "t-b", rows: 1, msat: String(neu.s.feeMsat) }],
      projections: [{ accountId: "acct", totalCredits: (old.s.agentMsat + neu.s.agentMsat) / 1000 }],
      reservations: [],
      chain: { records: 0, forks: [], duplicateHashes: [], sequenceBreaks: [], gaps: 0 }
    };
    expect(reconcileLedger(input, { localCoordinatorIds: ["c"], feePoolAccountId: "network:fee_pool" })).toMatchObject({ ok: true, mismatches: 0 });
  });
});
