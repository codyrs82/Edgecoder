import { describe, expect, it } from "vitest";
import { maxFeeMsatFor, payoutCapacityMsat, type PayoutPolicy } from "../../src/economy/payouts.js";

describe("maxFeeMsatFor", () => {
  const policy = {
    minFeeFloorSats: 10,
    maxFeeBps: 100
  } as PayoutPolicy;

  it("applies the fee floor to small amounts", () => {
    // Amount is 500 sats (500,000 msat)
    // Fee cap would be 500,000 * 100 / 10,000 = 5,000 msat
    // But minFeeFloorSats is 10, so it should return 10,000 msat (10 sats)
    expect(maxFeeMsatFor(500_000, policy)).toBe(10_000);
  });

  it("applies the basis-points cap to large amounts and rounds up", () => {
    // Amount is 100,000 sats (100,000,000 msat)
    // Fee cap would be 100,000,000 * 100 / 10,000 = 1,000,000 msat
    // Should return exactly 1,000,000 msat (1,000 sats)
    expect(maxFeeMsatFor(100_000_000, policy)).toBe(1_000_000);
    
    // Amount is 50,500 sats (50,500,000 msat)
    // Fee cap would be 50,500,000 * 100 / 10,000 = 505,000 msat
    // Should return exactly 505,000 msat (505 sats)
    expect(maxFeeMsatFor(50_500_000, policy)).toBe(505_000);
    
    // Amount is 50,499 sats (50,499,000 msat)
    // Fee cap would be 50,499,000 * 100 / 10,000 = 504,990 msat
    // Math.ceil(504,990) = 504,990 (no rounding up needed)
    expect(maxFeeMsatFor(50_499_000, policy)).toBe(504_990);
  });
});

describe("payoutCapacityMsat", () => {
  const policy = {
    reserveBps: 200
  } as PayoutPolicy;

  it("subtracts the reserve and what is already paid or pending", () => {
    // receivedMsat = 1,000,000 sats (1,000,000,000 msat)
    // paidOrPendingMsat = 200,000 sats (200,000,000 msat)
    // reserve = 1,000,000,000 * 200 / 10,000 = 20,000 sats (20,000,000 msat)
    // capacity = 1,000,000,000 - 20,000,000 - 200,000,000 = 780,000,000 msat (780,000 sats)
    expect(payoutCapacityMsat({ receivedMsat: 1_000_000_000, paidOrPendingMsat: 200_000_000 }, policy)).toBe(780_000_000);
  });

  it("never goes below 0", () => {
    // receivedMsat = 100,000 sats (100,000,000 msat)
    // paidOrPendingMsat = 150,000 sats (150,000,000 msat) 
    // reserve = 100,000,000 * 200 / 10,000 = 2,000 sats (2,000,000 msat)
    // capacity = 100,000,000 - 2,000,000 - 150,000,000 = -52,000,000 msat
    // Should return 0 (never negative)
    expect(payoutCapacityMsat({ receivedMsat: 100_000_000, paidOrPendingMsat: 150_000_000 }, policy)).toBe(0);
    
    // receivedMsat = 10,000 sats (10,000,000 msat)
    // paidOrPendingMsat = 10,000 sats (10,000,000 msat)
    // reserve = 10,000,000 * 200 / 10,000 = 200 sats (200,000 msat)
    // capacity = 10,000,000 - 200,000 - 10,000,000 = -200,000 msat
    // Should return 0 (never negative)
    expect(payoutCapacityMsat({ receivedMsat: 10_000_000, paidOrPendingMsat: 10_000_000 }, policy)).toBe(0);
  });
});