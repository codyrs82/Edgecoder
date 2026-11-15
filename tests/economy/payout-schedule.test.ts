import { describe, expect, it } from "vitest";
import { MemoryPayoutRunClaimStore, payoutTickMs, runPayoutJobIfDue } from "../../src/economy/payout-schedule.js";

// Live regtest finding (2026-11-15): auto payouts ran on setInterval(6 h) with no first run, and
// the seeds were redeployed more often than every 6 h, so no automatic payout ever ran.
describe("durable payout schedule", () => {
  const H = 3_600_000;

  it("runs once per interval even when the process restarts every hour", async () => {
    const store = new MemoryPayoutRunClaimStore(); // stands in for payout_controls (survives restarts)
    let now = 0;
    let runs = 0;
    const interval = 6 * H;
    for (let restart = 0; restart < 24; restart++) {
      // a fresh process each hour: ticks every payoutTickMs from its start
      for (let t = 60_000; t < H; t += payoutTickMs(interval)) {
        await runPayoutJobIfDue(store, "auto_payouts", interval, async () => { runs++; }, () => now + t);
      }
      now += H;
    }
    expect(runs).toBe(4); // 24 h / 6 h
  });

  it("two seeds sharing the store do not both run in one window", async () => {
    const store = new MemoryPayoutRunClaimStore();
    const a = await runPayoutJobIfDue(store, "auto_payouts", 60_000, async () => undefined, () => 1_000);
    const b = await runPayoutJobIfDue(store, "auto_payouts", 60_000, async () => undefined, () => 2_000);
    expect([a, b]).toEqual(["ran", "not_due"]);
    expect(await runPayoutJobIfDue(store, "auto_payouts", 60_000, async () => undefined, () => 61_000)).toBe("ran");
  });

  it("ticks at most every 5 minutes and at least every 10 s", () => {
    expect(payoutTickMs(6 * H)).toBe(300_000);
    expect(payoutTickMs(60_000)).toBe(60_000);
    expect(payoutTickMs(1)).toBe(10_000);
  });
});
