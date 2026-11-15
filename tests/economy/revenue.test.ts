import { describe, expect, it } from "vitest";
import { DAY_MS, feeIncomeFromRows, payoutRefusalStatus, revenueDays, revenueWindowStartMs } from "../../src/economy/revenue.js";

describe("revenue report helpers", () => {
  const now = Date.UTC(2026, 10, 14, 15, 0, 0);
  const today = Math.floor(now / DAY_MS);

  it("the window is the last N UTC days, today included, zero-filled and oldest first", () => {
    expect(revenueWindowStartMs(now, 30)).toBe((today - 29) * DAY_MS);
    const days = revenueDays([{ day: today, msat: 5_000, count: 2 }, { day: today - 3, msat: 1_000, count: 1 }, { day: today, msat: 1, count: 1 }], now, 30);
    expect(days).toHaveLength(30);
    expect(days[0].date).toBe("2026-10-16");
    expect(days.at(-1)).toEqual({ date: "2026-11-14", msat: 5_001, payments: 3 });
    expect(days.at(-4)).toEqual({ date: "2026-11-11", msat: 1_000, payments: 1 });
    expect(days.filter((d) => d.msat > 0)).toHaveLength(2);
  });

  it("in-memory rows: only network_fee earn rows count; totals are all-time, days only the window", () => {
    const r = feeIncomeFromRows(
      [
        { type: "earn", reason: "network_fee:a", timestampMs: now, msat: 2_000 },
        { type: "earn", reason: "network_fee:b", timestampMs: now - 40 * DAY_MS, msat: 3_000 },
        { type: "earn", reason: "purchase_fee:c", timestampMs: now, msat: 7_000 },
        { type: "spend", reason: "network_fee:d", timestampMs: now, msat: 9_000 }
      ],
      revenueWindowStartMs(now, 30)
    );
    expect(r).toEqual({ totalMsat: 5_000, count: 2, days: [{ day: today, msat: 2_000, count: 1 }] });
  });

  it("refused payouts map to the same statuses as the account withdraw route", () => {
    expect(payoutRefusalStatus("payout_unconfirmed")).toBe(202);
    expect(payoutRefusalStatus("payouts_paused")).toBe(503);
    expect(payoutRefusalStatus("insufficient_payable")).toBe(400);
  });
});
