// The submit-time context gate (routes/inference.ts contextTooLong) counts only the agents that
// could take the call: a bigger window on a machine of another class must not let an @cpu call
// through to wait out the claim bound as no_capacity (seen live: 1.5b on the CPU fleet, 8K windows,
// while an apple Mac with 16K held the same model).
import { describe, expect, it } from "vitest";
import { contextTooLong } from "../../src/swarm/coordinator/routes/inference.js";

const fleet = [
  ...Array.from({ length: 7 }, () => ({ contextWindow: 8192, computeClass: "cpu" })),
  { contextWindow: 16_384, computeClass: "apple" },
];

describe("contextTooLong", () => {
  it("refuses an @cpu call no CPU agent can fit, even when another class could", () => {
    expect(contextTooLong(fleet, 10_000, "cpu")).toBe(8192);
  });

  it("lets the same call through for any class (the Mac fits it) or for apple", () => {
    expect(contextTooLong(fleet, 10_000, "any")).toBeNull();
    expect(contextTooLong(fleet, 10_000, "apple")).toBeNull();
  });

  it("refuses for any class when nobody fits, with the largest window", () => {
    expect(contextTooLong(fleet, 20_000, "any")).toBe(16_384);
  });

  it("treats an agent that reports no window as fitting, and no eligible agent as not this gate's case", () => {
    expect(contextTooLong([{ computeClass: "cpu" }, { contextWindow: 4096, computeClass: "cpu" }], 10_000, "cpu")).toBeNull();
    expect(contextTooLong(fleet, 10_000, "gpu.dc")).toBeNull();
    expect(contextTooLong([], 10_000, "any")).toBeNull();
  });
});
