// Run 9: the whole-pool run spent 147.5 cSats on --budget 80: only settled charges counted, and
// cloud calls already in flight when the budget ran out were charged after. The budget is now a hard
// cap that holds every call in flight at its worst-case charge (scripts/loadgen/planner.mjs SpendCap).
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { DEFAULT_HOLD_CLOUD_CSATS, DEFAULT_HOLD_CSATS, HOLD_LEARN_MIN, HOLD_MARGIN, SpendCap } from "../../scripts/loadgen/planner.mjs";

const CLOUD = ["glm-", "deepseek-v", "cloud"];

describe("the budget is a hard cap", () => {
  it("never lets charges plus calls in flight pass the cap (run 9: 4 machines x 20 cSats, cloud calls up to 18.6)", () => {
    const cap = new SpendCap({ cap: 80 / 4, cloudPatterns: CLOUD });
    // A burst of cloud and auto calls arrives at once: only what fits at the worst case starts.
    const started: Array<(c: number) => void> = [];
    for (const id of ["network/glm-5.3", "auto", "network/deepseek-v4.1-flash", "network/glm-5.3"]) {
      const settle = cap.tryHold(id, cap.worstCase(id, { promptTokens: 2_000, maxTokens: 1_024 }));
      if (settle) started.push(settle);
    }
    expect(started).toHaveLength(1);
    expect(cap.held).toBe(DEFAULT_HOLD_CLOUD_CSATS);
    started[0](18.571);
    // 1.429 left: no cloud call fits; a named CPU call held at the prior (2 cSats) does not either.
    expect(cap.tryHold("network/glm-5.3", cap.worstCase("network/glm-5.3"))).toBeNull();
    expect(cap.tryHold("network/qwen2.5-coder:1.5b", cap.worstCase("network/qwen2.5-coder:1.5b"))).toBeNull();
    expect(cap.settled + cap.held).toBeLessThanOrEqual(20);
  });

  it("counts every hold in flight, not only settled spend", () => {
    const cap = new SpendCap({ cap: 10, hold: 3 });
    const a = cap.tryHold("network/qwen3-coder:30b", 3);
    const b = cap.tryHold("network/qwen3-coder:30b", 3);
    const c = cap.tryHold("network/qwen3-coder:30b", 3);
    expect([a, b, c].every(Boolean)).toBe(true);
    expect(cap.tryHold("network/qwen3-coder:30b", 3)).toBeNull(); // 9 held + 3 > 10, though nothing settled
    a!(0.2);
    expect(cap).toMatchObject({ settled: 0.2, held: 6, inflight: 2 });
    expect(cap.tryHold("network/qwen3-coder:30b", 3)).not.toBeNull();
    // Settling twice does nothing more.
    a!(5);
    expect(cap.settled).toBe(0.2);
  });

  it("holds a named model at the prior until it has been charged a few times, then at the worst seen scaled to the call", () => {
    const cap = new SpendCap({ cap: 20, cloudPatterns: CLOUD });
    const id = "network/qwen2.5-coder:1.5b";
    expect(cap.worstCase(id)).toBe(DEFAULT_HOLD_CSATS);
    for (let i = 0; i < HOLD_LEARN_MIN; i++) cap.tryHold(id, cap.worstCase(id))!(0.07, { promptTokens: 200, outputTokens: 16 });
    // 0.07 over 216 tokens; a call of 2,000 + 160 tokens is held at 1.5x that rate.
    expect(cap.worstCase(id, { promptTokens: 2_000, maxTokens: 160 })).toBeCloseTo((0.07 / 216) * 2_160 * HOLD_MARGIN, 6);
    expect(cap.worstCase(id, { promptTokens: 10, maxTokens: 6 })).toBeCloseTo(0.07 * HOLD_MARGIN, 6);
    // So a 20 cSat share runs many cheap calls at once.
    let n = 0;
    while (cap.tryHold(id, cap.worstCase(id, { promptTokens: 30, maxTokens: 16 }))) n++;
    expect(n).toBeGreaterThan(100);
  });

  it("a call that may run on a cloud host never holds less than the cloud prior, and learns a larger charge", () => {
    const cap = new SpendCap({ cap: 1_000, cloudPatterns: CLOUD });
    for (const id of ["auto", "network/glm-5.3", "network/qwen3.5:9b@cloud"]) expect(cap.mayRunOnCloud(id)).toBe(true);
    expect(cap.mayRunOnCloud("network/qwen2.5-coder:1.5b@cpu")).toBe(false);
    for (let i = 0; i < 5; i++) cap.tryHold("auto", cap.worstCase("auto"))!(0.01, { promptTokens: 50, outputTokens: 10 });
    expect(cap.worstCase("auto")).toBe(DEFAULT_HOLD_CLOUD_CSATS);
    cap.tryHold("network/glm-5.3", cap.worstCase("network/glm-5.3"))!(24, { promptTokens: 3_000, outputTokens: 1_024 });
    expect(cap.worstCase("network/glm-5.3")).toBeCloseTo(24 * HOLD_MARGIN, 6);
  });

  it("no cap (budget not a number) lets everything through", () => {
    const cap = new SpendCap({ cap: Number.NaN });
    expect(cap.tryHold("auto", 1e6)).not.toBeNull();
  });
});
