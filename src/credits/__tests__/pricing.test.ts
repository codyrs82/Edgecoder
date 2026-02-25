import { describe, it, expect } from "vitest";
import { modelCostCredits } from "../pricing.js";

describe("modelCostCredits", () => {
  it("returns paramSizeB for models >= 0.5B", () => {
    expect(modelCostCredits(7)).toBe(7);
    expect(modelCostCredits(3)).toBe(3);
    expect(modelCostCredits(1.5)).toBe(1.5);
    expect(modelCostCredits(0.5)).toBe(0.5);
  });

  it("enforces minimum of 0.5 credits", () => {
    expect(modelCostCredits(0.1)).toBe(0.5);
    expect(modelCostCredits(0)).toBe(0.5);
  });

  it("handles large models", () => {
    expect(modelCostCredits(70)).toBe(70);
  });
});
