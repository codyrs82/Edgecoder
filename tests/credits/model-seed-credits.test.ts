import { describe, it, expect } from "vitest";
import { modelSeedCredits } from "../../src/credits/pricing.js";

describe("modelSeedCredits", () => {
  it("awards credits proportional to file size", () => {
    const small = modelSeedCredits(1_000_000_000, 5);
    const large = modelSeedCredits(5_000_000_000, 5);
    expect(large).toBeGreaterThan(small);
  });

  it("awards more credits when fewer seeders exist (rarity bonus)", () => {
    const manySeeders = modelSeedCredits(3_000_000_000, 10);
    const fewSeeders = modelSeedCredits(3_000_000_000, 1);
    expect(fewSeeders).toBeGreaterThan(manySeeders);
  });

  it("returns positive credits for any valid input", () => {
    const credits = modelSeedCredits(500_000_000, 3);
    expect(credits).toBeGreaterThan(0);
  });

  it("handles single seeder (maximum rarity)", () => {
    const credits = modelSeedCredits(1_000_000_000, 1);
    expect(credits).toBeGreaterThan(0);
  });
});
