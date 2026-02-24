import { describe, expect, test } from "vitest";
import {
  computeIntentFee,
  weightedMedian,
} from "../../src/swarm/coordinator-utils.js";

// ---------------------------------------------------------------------------
// computeIntentFee boundary cases
// ---------------------------------------------------------------------------
describe("computeIntentFee boundary cases", () => {
  test("zero amount yields zero fee and zero net", () => {
    expect(computeIntentFee(0, 150)).toEqual({ feeSats: 0, netSats: 0 });
  });

  test("zero BPS yields zero fee, full net", () => {
    expect(computeIntentFee(1000, 0)).toEqual({ feeSats: 0, netSats: 1000 });
  });

  test("100% BPS (10000) takes entire amount", () => {
    expect(computeIntentFee(1000, 10000)).toEqual({
      feeSats: 1000,
      netSats: 0,
    });
  });

  test("normal case: 10000 sats at 150 BPS", () => {
    expect(computeIntentFee(10000, 150)).toEqual({
      feeSats: 150,
      netSats: 9850,
    });
  });

  test("rounding down via Math.floor for tiny amount", () => {
    // 1 * 150 / 10000 = 0.015 -> floor -> 0
    expect(computeIntentFee(1, 150)).toEqual({ feeSats: 0, netSats: 1 });
  });

  test("large amount: 1 BTC worth of sats at 150 BPS", () => {
    expect(computeIntentFee(100_000_000, 150)).toEqual({
      feeSats: 1_500_000,
      netSats: 98_500_000,
    });
  });
});

// ---------------------------------------------------------------------------
// weightedMedian with price-consensus scenarios
// ---------------------------------------------------------------------------
describe("weightedMedian price consensus", () => {
  test("single price quote returns that price", () => {
    expect(weightedMedian([{ value: 30, weight: 1 }])).toBe(30);
  });

  test("two coordinators equal weight returns lower (hits >= half first)", () => {
    // sorted: [25, 35]; totalWeight = 2; half = 1
    // cumulative after 25 -> 1, which >= 1 -> returns 25
    expect(
      weightedMedian([
        { value: 25, weight: 1 },
        { value: 35, weight: 1 },
      ]),
    ).toBe(25);
  });

  test("skewed weight favoring higher price returns higher", () => {
    // sorted: [10(w1), 50(w10)]; totalWeight = 11; half = 5.5
    // cumulative after 10 -> 1 (< 5.5), after 50 -> 11 (>= 5.5) -> 50
    expect(
      weightedMedian([
        { value: 10, weight: 1 },
        { value: 50, weight: 10 },
      ]),
    ).toBe(50);
  });

  test("many entries: realistic multi-coordinator scenario", () => {
    // Five coordinators quoting BTC prices (in thousands) with varying stake
    const quotes = [
      { value: 61000, weight: 5 },
      { value: 62000, weight: 10 },
      { value: 62500, weight: 20 },
      { value: 63000, weight: 10 },
      { value: 65000, weight: 2 },
    ];
    // totalWeight = 47, half = 23.5
    // sorted asc; cumulative: 5 -> 15 -> 35 (>= 23.5) -> returns 62500
    expect(weightedMedian(quotes)).toBe(62500);
  });
});

// ---------------------------------------------------------------------------
// Fee split math: feeSats + netSats === amountSats
// ---------------------------------------------------------------------------
describe("fee split math", () => {
  test("feeSats + netSats equals amountSats for known values", () => {
    const { feeSats, netSats } = computeIntentFee(10000, 150);
    expect(feeSats).toBe(150);
    expect(netSats).toBe(9850);
    expect(feeSats + netSats).toBe(10000);
  });

  test("feeSats + netSats equals amountSats across a range of inputs", () => {
    const amounts = [0, 1, 99, 500, 1000, 12345, 100_000_000];
    const bpsValues = [0, 1, 150, 500, 9999, 10000];
    for (const amount of amounts) {
      for (const bps of bpsValues) {
        const { feeSats, netSats } = computeIntentFee(amount, bps);
        expect(feeSats + netSats).toBe(amount);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Duplicate txRef guard pattern (idempotency via Set)
// ---------------------------------------------------------------------------
describe("duplicate txRef guard pattern", () => {
  test("Set tracks seen txRefs and prevents duplicate processing", () => {
    const seenTxRefs = new Set<string>();
    const txRef = "tx_abc123def456";

    // First encounter: not seen yet
    expect(seenTxRefs.has(txRef)).toBe(false);
    seenTxRefs.add(txRef);

    // Second encounter: already seen, should be rejected
    expect(seenTxRefs.has(txRef)).toBe(true);
  });
});
