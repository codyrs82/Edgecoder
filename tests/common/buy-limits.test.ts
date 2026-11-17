import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as B from "../../src/common/buy-limits.js";

const invite = (o: Partial<B.LaunchCaps> = {}): B.LaunchCaps => ({ mode: "invite", maxBuySatsPerDay: 50_000, maxBalanceSats: 200_000, maxPayoutSatsPerDay: 50_000, boughtWindowSats: 0, ...o });

describe("buy-limits (shared by the desktop app and the portal)", () => {
  it("is byte-identical in src/common and desktop/src/lib", () => {
    const shared = readFileSync(new URL("../../src/common/buy-limits.ts", import.meta.url), "utf8");
    const desktop = readFileSync(new URL("../../desktop/src/lib/buy-limits.ts", import.meta.url), "utf8");
    expect(desktop).toBe(shared);
  });

  it("is the global 100 to 1M range without early access", () => {
    const l = B.buyLimit({ launch: null, balanceCSats: 5_000 });
    expect(l).toMatchObject({ minSats: 100, maxSats: 1_000_000, reason: "global" });
    expect(B.buyRangeLabel(l)).toBe("100 to 1M");
    expect(B.buyAmountFits(500_000, l)).toBe(true);
  });

  it("takes the lowest of the daily cap left, the balance room and the global max", () => {
    const daily = B.buyLimit({ launch: invite({ boughtWindowSats: 5_000 }), balanceCSats: 1_000 });
    expect(daily).toMatchObject({ maxSats: 45_000, reason: "daily", dailyLeftSats: 45_000 });
    expect(B.buyRangeLabel(daily)).toBe("100 to 45,000 today");
    const bal = B.buyLimit({ launch: invite(), balanceCSats: 190_000 });
    expect(bal).toMatchObject({ maxSats: 10_000, reason: "balance" });
    // A 1 % purchase fee lets the amount be a bit over the room left (the balance gets amount − fee).
    const fee = B.buyLimit({ launch: invite(), balanceCSats: 190_000, feeBps: 100 });
    expect(fee.maxSats - Math.floor((fee.maxSats * 100) / 10_000)).toBeLessThanOrEqual(10_000);
    expect(fee.maxSats + 1 - Math.floor(((fee.maxSats + 1) * 100) / 10_000)).toBeGreaterThan(10_000);
    const g = B.buyLimit({ launch: invite({ maxBuySatsPerDay: 0, maxBalanceSats: 0 }), balanceCSats: 0 });
    expect(g.reason).toBe("global");
    const none = B.buyLimit({ launch: invite({ boughtWindowSats: 50_000 }) });
    expect(none.maxSats).toBe(0);
    expect(B.buyRangeLabel(none)).toBe("None left today");
  });

  it("clamps amounts into the limit", () => {
    const l = B.buyLimit({ launch: invite({ boughtWindowSats: 5_000 }) });
    expect(B.clampBuyAmount(500_000, l)).toBe(45_000);
    expect(B.clampBuyAmount(20_000, l)).toBe(20_000);
    expect(B.clampBuyAmount(10, l)).toBe(100);
  });

  it("explains an amount over the limit before submit", () => {
    const l = B.buyLimit({ launch: invite({ boughtWindowSats: 5_000 }) });
    expect(B.buyLimitText(500_000, l)).toBe("Early access: up to 50,000 sats per day (45,000 left today).");
    expect(B.buyLimitText(45_000, l)).toBe("");
    expect(B.buyLimitText(50, l)).toBe("The minimum is 100 sats.");
    expect(B.buyLimitText(20_000, B.buyLimit({ launch: invite(), balanceCSats: 190_000 }))).toMatch(/^Early access: a balance of up to 200,000 cSats\. You can add up to 10,000 sats now\.$/);
    expect(B.buyLimitText(2_000_000, B.buyLimit({}))).toBe("The most you can buy at once is 1,000,000 sats.");
  });

  it("turns every purchase error code into plain language, never the code", () => {
    expect(B.buyErrorText("launch_buy_daily_cap", { remainingSats: 45_000, limitSats: 50_000 })).toBe("That's over today's early-access limit. You can buy up to 45,000 sats more today.");
    expect(B.buyErrorText("launch_buy_daily_cap", { remainingSats: 0, limitSats: 50_000 })).toMatch(/reached today's early-access limit of 50,000 sats/);
    expect(B.buyErrorText("launch_balance_cap", { remainingSats: 10_000, limitSats: 200_000 })).toBe("That would take your balance over the early-access limit of 200,000 cSats. You can add up to 10,000 cSats now.");
    for (const code of ["launch_buy_daily_cap", "launch_balance_cap", "invalid_amount", "amount_too_small", "amount_too_large", "payments_disabled", "coordinator_unreachable", "not_enrolled", "not_authenticated", "rate_limited", "weird_new_code", "", undefined]) {
      const t = B.buyErrorText(code as string);
      expect(t.length).toBeGreaterThan(10);
      if (code) expect(t).not.toContain(code);
    }
  });
});
