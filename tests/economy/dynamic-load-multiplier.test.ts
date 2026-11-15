import { describe, expect, it } from "vitest";
import { dynamicLoadMultiplier } from "../../src/economy/pricing.js";

describe("dynamicLoadMultiplier", () => {
  // Define the inputs type to match the interface
  const baseInputs = {
    cpuCapacity: 10,
    gpuCapacity: 10,
    queuedTasks: 5,
    activeAgents: 5
  };

  it("should return 1.0 when demand equals capacity", () => {
    // When demand (queued + active) equals capacity, multiplier should be 1.0
    const inputs = { ...baseInputs, cpuCapacity: 10, gpuCapacity: 10, queuedTasks: 5, activeAgents: 5 };
    expect(dynamicLoadMultiplier("cpu", inputs)).toBe(1.0);
    expect(dynamicLoadMultiplier("gpu", inputs)).toBe(1.0);
  });

  it("should return floor value (0.685) when network is idle (demand = 1, capacity = 10)", () => {
    // When demand is minimal (1) and capacity is high (10), multiplier should approach floor
    const inputs = { ...baseInputs, cpuCapacity: 10, gpuCapacity: 10, queuedTasks: 0, activeAgents: 1 };
    expect(dynamicLoadMultiplier("cpu", inputs)).toBeCloseTo(0.685);
    expect(dynamicLoadMultiplier("gpu", inputs)).toBeCloseTo(0.685);
  });

  it("should cap at 4.0 for extreme demand", () => {
    // When demand is much higher than capacity, multiplier should be capped at 4.0
    const inputs = { ...baseInputs, cpuCapacity: 1, gpuCapacity: 1, queuedTasks: 100, activeAgents: 100 };
    expect(dynamicLoadMultiplier("cpu", inputs)).toBe(4.0);
    expect(dynamicLoadMultiplier("gpu", inputs)).toBe(4.0);
  });

  it("should use cpu capacity for cpu resource class", () => {
    // CPU resource should use cpuCapacity
    const inputs = { ...baseInputs, cpuCapacity: 5, gpuCapacity: 20, queuedTasks: 10, activeAgents: 10 };
    // demand = 20, capacity = 5, scarcity = 4.0, result = 0.65 + 4.0 * 0.35 = 0.65 + 1.4 = 2.05
    expect(dynamicLoadMultiplier("cpu", inputs)).toBeCloseTo(2.05);
  });

  it("should use gpu capacity for gpu resource class", () => {
    // GPU resource should use gpuCapacity
    const inputs = { ...baseInputs, cpuCapacity: 20, gpuCapacity: 5, queuedTasks: 10, activeAgents: 10 };
    // demand = 20, capacity = 5, scarcity = 4.0, result = 0.65 + 4.0 * 0.35 = 0.65 + 1.4 = 2.05
    expect(dynamicLoadMultiplier("gpu", inputs)).toBeCloseTo(2.05);
  });

  it("should treat capacity of 0 as 1", () => {
    // When capacity is 0, it should be treated as 1 due to Math.max(1, inputs.cpuCapacity)
    const inputs = { ...baseInputs, cpuCapacity: 0, gpuCapacity: 0, queuedTasks: 5, activeAgents: 5 };
    // demand = 10, capacity = 1 (because of Math.max(1, 0)), scarcity = 10.0, result = 0.65 + 10.0 * 0.35 = 0.65 + 3.5 = 4.15 -> clamped to 4.0
    expect(dynamicLoadMultiplier("cpu", inputs)).toBe(4.0);
    expect(dynamicLoadMultiplier("gpu", inputs)).toBe(4.0);
  });

  it("should handle different combinations of demand and capacity correctly", () => {
    // Test case: demand = 2, capacity = 10, multiplier should be (2/10) * 0.35 + 0.65 = 0.07 + 0.65 = 0.72
    const inputs = { ...baseInputs, cpuCapacity: 10, gpuCapacity: 10, queuedTasks: 1, activeAgents: 1 };
    expect(dynamicLoadMultiplier("cpu", inputs)).toBeCloseTo(0.72, 2);
    
    // Test case: demand = 15, capacity = 5, multiplier should be (15/5) * 0.35 + 0.65 = 3 * 0.35 + 0.65 = 1.05 + 0.65 = 1.7
    const inputs2 = { ...baseInputs, cpuCapacity: 5, gpuCapacity: 5, queuedTasks: 10, activeAgents: 5 };
    expect(dynamicLoadMultiplier("cpu", inputs2)).toBeCloseTo(1.7, 2);
  });
});