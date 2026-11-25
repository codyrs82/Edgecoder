import { describe, expect, it } from "vitest";
import { isReasoningModel, maxTokensFor } from "../../scripts/loadgen/workload.mjs";
import { classifyCall, classifyError, failureCategories } from "../../scripts/loadgen/stats.mjs";

describe("reasoning max_tokens floor", () => {
  const local = { models: { "qwen2.5-coder:7b": { slots: 4 } } };
  const withCloud = { models: { "qwen2.5-coder:7b": { slots: 4 }, "glm-5.3": { slots: 8 } } };

  it("detects the cloud reasoning models", () => {
    expect(isReasoningModel("glm-5.3")).toBe(true);
    expect(isReasoningModel("deepseek-v4.1-flash")).toBe(true);
    expect(isReasoningModel("qwen2.5-coder:7b")).toBe(false);
  });

  it("raises small budgets on reasoning models to the floor and leaves others", () => {
    expect(maxTokensFor("glm-5.3", 40)).toBe(1024);
    expect(maxTokensFor("deepseek-v4.1-flash", 512)).toBe(1024);
    expect(maxTokensFor("glm-5.3", 2048)).toBe(2048);
    expect(maxTokensFor("qwen2.5-coder:7b", 16)).toBe(16);
    expect(maxTokensFor("glm-5.3", 40, { floor: 2000 })).toBe(2000);
    expect(maxTokensFor("glm-5.3", 40, { floor: 0 })).toBe(40);
    expect(maxTokensFor("my-model", 40, { patterns: ["my-"] })).toBe(1024);
  });

  it("floors auto calls when the network holds a reasoning model (or no snapshot)", () => {
    expect(maxTokensFor("auto", 16, { capacity: withCloud })).toBe(1024);
    expect(maxTokensFor("auto", 16, { capacity: null })).toBe(1024);
    expect(maxTokensFor("auto", 16, { capacity: local })).toBe(16);
  });
});

describe("reasoning_only is its own failure", () => {
  it("classifies the 400 and the in-band error", () => {
    const body = JSON.stringify({ error: { message: "The machine running glm-5.3 reported: reasoning_only" } });
    expect(classifyError(400, body)).toBe("reasoning_only");
    expect(classifyCall({ status: 400, errBody: body, gotHeaders: true })).toBe("reasoning_only");
    expect(classifyCall({ status: 200, errBody: body, gotHeaders: true, inband: true })).toBe("reasoning_only");
  });

  it("is counted apart from capacity failures", () => {
    expect(failureCategories({ reasoning_only: 120, no_capacity: 3, over_capacity: 2, stream_truncated: 1 })).toEqual({ reasoningOnly: 120, capacity: 5, other: 1 });
  });
});
