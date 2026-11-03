import { describe, expect, it } from "vitest";
import { parallelInferenceFor } from "../../src/swarm/parallelism.js";

const GB = 1024 ** 3;
describe("parallel model calls", () => {
  it("sizes by memory, with an override", () => {
    expect(parallelInferenceFor(8 * GB)).toBe(1);
    expect(parallelInferenceFor(16 * GB)).toBe(2);
    expect(parallelInferenceFor(32 * GB)).toBe(4);
    expect(parallelInferenceFor(64 * GB, "6")).toBe(6);
    expect(parallelInferenceFor(64 * GB, "nope")).toBe(4);
  });
});
