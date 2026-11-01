import { describe, expect, it } from "vitest";
import { areaPath, clampPercent, counterDeltas, describeSeries, linePoints, pushSample } from "../src/lib/charts";

describe("dashboard chart math (#26)", () => {
  it("keeps the newest samples and drops non-finite ones", () => {
    expect(pushSample([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
    expect(pushSample([1], Number.NaN, 3)).toEqual([1]);
    expect(pushSample([], 5, 0)).toEqual([5]);
  });

  it("turns a counter into per-interval deltas, treating resets as 0", () => {
    expect(counterDeltas([10, 12, 12, 3, 5])).toEqual([2, 0, 0, 2]);
    expect(counterDeltas([7])).toEqual([]);
  });

  it("scales points into the box, clamping to yMax", () => {
    expect(linePoints([], { width: 100, height: 50 })).toBe("");
    expect(linePoints([0, 50, 100], { width: 100, height: 50, pad: 0, yMax: 100 })).toBe("0,50 50,25 100,0");
    expect(linePoints([150, -5], { width: 100, height: 50, pad: 0, yMax: 100 })).toBe("0,0 100,50");
    expect(linePoints([5], { width: 100, height: 50, pad: 0 })).toBe("0,0");
  });

  it("closes the area path at the baseline", () => {
    expect(areaPath([1], { width: 10, height: 10 })).toBe("");
    expect(areaPath([0, 10], { width: 10, height: 10, pad: 0 })).toBe("M0,10 L10,0 L10,10 L0,10 Z");
  });

  it("describes a series for screen readers", () => {
    expect(describeSeries("CPU usage", [], "%")).toBe("CPU usage: no data yet");
    expect(describeSeries("CPU usage", [10, 42.25, 5], "%")).toBe("CPU usage: latest 5%, min 5%, max 42.3% over 3 samples");
  });

  it("clamps percentages for aria-valuenow", () => {
    expect(clampPercent(120)).toBe(100);
    expect(clampPercent(-3)).toBe(0);
    expect(clampPercent(33.6)).toBe(34);
    expect(clampPercent(Number.NaN)).toBe(0);
  });
});
