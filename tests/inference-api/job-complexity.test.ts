import { describe, expect, it } from "vitest";
import { COMPLEX_FLOOR, DEFAULT_COMPLEXITY_WEIGHTS, complexityWeightsFromEnv, describeComplexity, estimateComplexity, hintScore, levelOf, measureSignals } from "../../src/inference-api/job-complexity.js";
import { AGENTIC_LOOP, LONG_LOG_SUMMARY, MULTI_FILE_REFACTOR, ONE_LINE_FIX, SIMPLE_QA } from "../helpers/job-fixtures.js";

const signal = (c: ReturnType<typeof estimateComplexity>, name: string) => c.signals.find((s) => s.name === name);

describe("job complexity: fixtures", () => {
  it("a simple question is low", () => {
    const c = estimateComplexity(SIMPLE_QA);
    expect(c.level).toBe("low");
    expect(c.score).toBeLessThan(0.1);
    expect(c.floor).toBe(0);
    // "What is ..." reads as a lookup: a simplicity cue, subtracted.
    expect(signal(c, "simple")?.contribution).toBeLessThan(0);
  });

  it("a one-line fix is low", () => {
    const c = estimateComplexity(ONE_LINE_FIX);
    expect(c.level).toBe("low");
    expect(signal(c, "simple")?.detail).toContain("typo");
  });

  it("a multi-file refactor is high, and the signals say why", () => {
    const c = estimateComplexity(MULTI_FILE_REFACTOR);
    expect(["high", "very_high"]).toContain(c.level);
    expect(c.score).toBeGreaterThanOrEqual(COMPLEX_FLOOR);
    expect(signal(c, "files")?.detail).toBe("4 files");
    expect(signal(c, "reasoning")?.detail).toMatch(/plan/);
    expect(signal(c, "reasoning")?.detail).toMatch(/refactor/);
    expect(signal(c, "code")?.value).toBeGreaterThan(0.5);
    expect(signal(c, "output")?.value).toBeGreaterThan(0);
    // Four files are clearly complex: a floor no hint goes below.
    expect(c.floor).toBe(COMPLEX_FLOOR);
  });

  it("a long log to summarize is long but not hard", () => {
    const c = estimateComplexity(LONG_LOG_SUMMARY);
    expect(["low", "medium"]).toContain(c.level);
    expect(signal(c, "length")?.value).toBeGreaterThan(0.7);
    expect(c.score).toBeLessThan(estimateComplexity(MULTI_FILE_REFACTOR).score);
    // A pasted log is not searched for reasoning cues.
    expect(signal(c, "reasoning")).toBeUndefined();
  });

  it("an agentic coding loop several steps in is high", () => {
    const c = estimateComplexity(AGENTIC_LOOP);
    expect(c.score).toBeGreaterThanOrEqual(COMPLEX_FLOOR);
    expect(["high", "very_high"]).toContain(c.level);
    expect(signal(c, "agentSteps")?.detail).toBe("6 agent steps");
    expect(signal(c, "tools")?.detail).toBe("3 tools");
    expect(signal(c, "trace")).toBeDefined();
    expect(c.floor).toBe(COMPLEX_FLOOR);
  });

  it("orders the fixtures sensibly", () => {
    const s = (r: Parameters<typeof estimateComplexity>[0]) => estimateComplexity(r).score;
    expect(s(SIMPLE_QA)).toBeLessThanOrEqual(s(LONG_LOG_SUMMARY));
    expect(s(ONE_LINE_FIX)).toBeLessThan(s(MULTI_FILE_REFACTOR));
    expect(s(LONG_LOG_SUMMARY)).toBeLessThan(s(AGENTIC_LOOP));
  });
});

describe("job complexity: hints, weights and signals", () => {
  it("a hint raises a simple request, and lowers it", () => {
    expect(estimateComplexity(SIMPLE_QA, "very_high").score).toBe(0.9);
    expect(estimateComplexity(SIMPLE_QA, 0.6)).toMatchObject({ score: 0.6, level: "high", hinted: 0.6 });
    const mid = estimateComplexity({ messages: [{ role: "user", content: "Explain how to design a cache and the trade-offs" }] });
    expect(mid.estimated).toBeGreaterThan(0.05);
    expect(estimateComplexity({ messages: [{ role: "user", content: "Explain how to design a cache and the trade-offs" }] }, "low").score).toBe(0.15);
  });

  it("a hint can't take a clearly complex request below the floor", () => {
    expect(estimateComplexity(AGENTIC_LOOP, "low").score).toBe(COMPLEX_FLOOR);
    expect(estimateComplexity(MULTI_FILE_REFACTOR, 0).score).toBe(COMPLEX_FLOOR);
    expect(estimateComplexity(MULTI_FILE_REFACTOR, 0.95).score).toBe(0.95);
  });

  it("reads hints as numbers or levels; anything else is no hint", () => {
    expect(hintScore("high")).toBe(0.65);
    expect(hintScore("very-high")).toBe(0.9);
    expect(hintScore("0.3")).toBe(0.3);
    expect(hintScore(7)).toBe(1);
    expect(hintScore("hard")).toBeUndefined();
    expect(hintScore(undefined)).toBeUndefined();
    expect(estimateComplexity(SIMPLE_QA, "hard").hinted).toBeUndefined();
  });

  it("levels", () => {
    expect([0, 0.25, 0.5, 0.75, 1].map(levelOf)).toEqual(["low", "medium", "high", "very_high", "very_high"]);
  });

  it("weights come from BEST_FIT_COMPLEXITY_WEIGHTS_JSON, partly; bad JSON keeps the defaults", () => {
    expect(complexityWeightsFromEnv({ BEST_FIT_COMPLEXITY_WEIGHTS_JSON: '{"reasoning":0.5,"files":2,"nope":1}' })).toEqual({ ...DEFAULT_COMPLEXITY_WEIGHTS, reasoning: 0.5 });
    expect(complexityWeightsFromEnv({ BEST_FIT_COMPLEXITY_WEIGHTS_JSON: "{" })).toEqual(DEFAULT_COMPLEXITY_WEIGHTS);
    expect(complexityWeightsFromEnv({})).toEqual(DEFAULT_COMPLEXITY_WEIGHTS);
  });

  it("weights change the score: no reasoning weight, a lower refactor estimate", () => {
    const base = estimateComplexity(MULTI_FILE_REFACTOR).estimated;
    expect(estimateComplexity(MULTI_FILE_REFACTOR, undefined, { ...DEFAULT_COMPLEXITY_WEIGHTS, reasoning: 0 }).estimated).toBeLessThan(base);
  });

  it("measures diffs, stack traces, languages and the reply asked for", () => {
    const s = measureSignals({
      messages: [{ role: "user", content: "diff --git a/src/a.py b/src/a.py\n@@ -1,2 +1,2 @@\n-x = 1\n+x = 2\nTraceback (most recent call last):\n  File \"src/a.py\", line 3\nsee also web/app.ts" }],
      maxTokens: 8192,
    });
    expect(s.diff.value).toBe(1);
    expect(s.trace.value).toBe(1);
    expect(s.languages.detail).toBe("2 languages");
    expect(s.output.value).toBe(1);
  });

  it("describes itself for explanations", () => {
    expect(describeComplexity(estimateComplexity(MULTI_FILE_REFACTOR))).toMatch(/^high \(0\.\d\d\): /);
    expect(describeComplexity(estimateComplexity(SIMPLE_QA, "high"))).toContain("client hint");
  });

  it("stays fast on a very long request", () => {
    const big = { messages: [{ role: "user" as const, content: "x = 1;\n".repeat(60_000) }] };
    const t = performance.now();
    estimateComplexity(big);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
