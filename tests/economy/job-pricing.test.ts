import { describe, expect, it } from "vitest";
import { clampToBand, cSatsToMsat, jobCostMsat, msatToCSats, ratePerSecondMsat, reserveMsat, splitJobCost } from "../../src/economy/job-pricing.js";

describe("job pricing (cSats = sats)", () => {
  it("prices measured seconds at the tier's rate", () => {
    // 200 msat per base-tier second, a tier with weight 4.5: 900 msat/s; 12.4 s of work.
    const rate = ratePerSecondMsat(200, 4.5);
    expect(rate).toBe(900);
    expect(jobCostMsat(12_400, rate)).toBe(11_160);
    expect(jobCostMsat(0, rate)).toBe(0);
  });

  it("keeps a matched price inside the class band", () => {
    expect(clampToBand(10_000, 200)).toBe(800);
    expect(clampToBand(1, 200)).toBe(50);
    expect(clampToBand(undefined, 200)).toBe(200);
    expect(clampToBand(300, 200)).toBe(300);
  });

  it("splits the network fee out of the cost; the parts add up", () => {
    const { agentMsat, feeMsat } = splitJobCost(11_160, 500);
    expect(feeMsat).toBe(558);
    expect(agentMsat + feeMsat).toBe(11_160);
  });

  it("sets aside the worst case, or the requester's own ceiling", () => {
    // 30 s limit, 200 msat reference -> top of band 800, fastest tier 4.5: 108,000 msat.
    expect(reserveMsat({ timeoutMs: 30_000, classRefMsatPerCredit: 200, maxTierWeight: 4.5 })).toBe(108_000);
    expect(reserveMsat({ timeoutMs: 30_000, classRefMsatPerCredit: 200, maxTierWeight: 4.5, bidCeilingMsatPerCredit: 250 })).toBe(33_750);
    // The worst case always covers the actual cost.
    const actual = jobCostMsat(30_000, ratePerSecondMsat(clampToBand(10_000, 200), 4.5));
    expect(actual).toBeLessThanOrEqual(reserveMsat({ timeoutMs: 30_000, classRefMsatPerCredit: 200, maxTierWeight: 4.5 }));
  });

  it("converts between msat and cSats", () => {
    expect(msatToCSats(11_160)).toBe(11.16);
    expect(cSatsToMsat(11.16)).toBe(11_160);
  });
});
