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

  it("with the model: as many calls as fit next to it, at most 2 below 31 GB", () => {
    // A 4 GB CPU agent (the live shared-cpu-4x machines report ~3.8 GB) with a 1.5B model: 2.
    expect(parallelInferenceFor(3.8 * GB, undefined, { modelParamsB: 1.5 })).toBe(2);
    expect(parallelInferenceFor(4 * GB, undefined, { modelParamsB: 1.5 })).toBe(2);
    // Too little room for a second context: 1.
    expect(parallelInferenceFor(8 * GB, undefined, { modelParamsB: 7 })).toBe(1);
    expect(parallelInferenceFor(4 * GB, undefined, { modelParamsB: 7 })).toBe(1);
    expect(parallelInferenceFor(16 * GB, undefined, { modelParamsB: 7 })).toBe(2);
    expect(parallelInferenceFor(16 * GB, undefined, { modelParamsB: 14 })).toBe(1);
    expect(parallelInferenceFor(64 * GB, undefined, { modelParamsB: 7 })).toBe(4);
    // A GPU's VRAM is usable almost whole.
    expect(parallelInferenceFor(48 * GB, undefined, { modelParamsB: 30, gpu: true })).toBe(4);
    // The override still wins.
    expect(parallelInferenceFor(4 * GB, "3", { modelParamsB: 7 })).toBe(3);
  });

  it("never more than the machine's Ollama serves (OLLAMA_NUM_PARALLEL)", () => {
    expect(parallelInferenceFor(4 * GB, undefined, { modelParamsB: 1.5, ollamaNumParallel: "1" })).toBe(1);
    expect(parallelInferenceFor(64 * GB, undefined, { ollamaNumParallel: "2" })).toBe(2);
    expect(parallelInferenceFor(64 * GB, undefined, { ollamaNumParallel: "x" })).toBe(4);
  });
});
