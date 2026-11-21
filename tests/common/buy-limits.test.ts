import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as B from "../../src/common/buy-limits.js";

describe("buy-limits (shared by the desktop app and the portal)", () => {
  it("is byte-identical in src/common and desktop/src/lib", () => {
    const shared = readFileSync(new URL("../../src/common/buy-limits.ts", import.meta.url), "utf8");
    const desktop = readFileSync(new URL("../../desktop/src/lib/buy-limits.ts", import.meta.url), "utf8");
    expect(desktop).toBe(shared);
  });

  it("is the global 100 to 1M range", () => {
    const l = B.buyLimit({});
    expect(l).toEqual({ minSats: 100, maxSats: 1_000_000 });
    expect(B.buyRangeLabel(l)).toBe("100 to 1M");
    expect(B.buyAmountFits(500_000, l)).toBe(true);
    expect(B.buyAmountFits(2_000_000, l)).toBe(false);
    expect(B.buyRangeLabel(B.buyLimit({ globalMin: 1_000, globalMax: 50_000 }))).toBe("1,000 to 50,000");
  });

  it("clamps amounts into the limit", () => {
    const l = B.buyLimit({});
    expect(B.clampBuyAmount(5_000_000, l)).toBe(1_000_000);
    expect(B.clampBuyAmount(20_000, l)).toBe(20_000);
    expect(B.clampBuyAmount(10, l)).toBe(100);
  });

  it("explains an amount outside the limit before submit", () => {
    const l = B.buyLimit({});
    expect(B.buyLimitText(45_000, l)).toBe("");
    expect(B.buyLimitText(50, l)).toBe("The minimum is 100 sats.");
    expect(B.buyLimitText(2_000_000, l)).toBe("The most you can buy at once is 1,000,000 sats.");
  });

  it("turns every purchase error code into plain language, never the code", () => {
    for (const code of ["invalid_amount", "amount_too_small", "amount_too_large", "payments_disabled", "coordinator_unreachable", "not_enrolled", "not_authenticated", "rate_limited", "weird_new_code", "", undefined]) {
      const t = B.buyErrorText(code as string);
      expect(t.length).toBeGreaterThan(10);
      if (code) expect(t).not.toContain(code);
    }
  });
});
