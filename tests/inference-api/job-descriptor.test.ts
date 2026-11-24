import { describe, expect, it } from "vitest";
import { cleanHints, describeJob, inferJob, routingHintsFrom, sessionKeyOf } from "../../src/inference-api/job-descriptor.js";
import { AGENTIC_LOOP, CLASSIFY, LONG_LOG_SUMMARY, MULTI_FILE_REFACTOR, ONE_LINE_FIX, SIMPLE_QA, SINGLE_EDIT } from "../helpers/job-fixtures.js";

describe("routing hints", () => {
  it("reads the body's edgecoder object over x-edgecoder-* headers", () => {
    const h = routingHintsFrom(
      { edgecoder: { job: "code_review", quality: "best", maxCSats: 3, complexity: "high" }, user: "u-1" },
      { "x-edgecoder-job": "chat", "x-edgecoder-latency": "batch", "x-edgecoder-needs-tools": "true", "x-edgecoder-min-context": "65536", "x-session-id": "sess-9" },
    );
    expect(h).toEqual({ job: "code_review", quality: "best", maxCSats: 3, complexity: "high", latency: "batch", needsTools: true, minContext: 65536, sessionId: "sess-9" });
  });

  it("takes the session from the OpenAI user field, or Anthropic metadata.user_id, when no x-session-id", () => {
    expect(routingHintsFrom({ user: "alice" }).sessionId).toBe("user:alice");
    expect(routingHintsFrom({ metadata: { user_id: "bob" } }).sessionId).toBe("user:bob");
    expect(routingHintsFrom({}, {})).toEqual({});
  });

  it("drops what it does not understand", () => {
    expect(cleanHints({ job: "dance", quality: "ultra", maxCSats: -1, latency: "now", needsTools: "maybe", minContext: "lots", complexity: "hard" })).toEqual({});
    expect(cleanHints({ job: "code-edit", needs_tools: false, max_csats: "2.5" })).toEqual({ job: "code_edit", needsTools: false, maxCSats: 2.5 });
    expect(cleanHints(null)).toEqual({});
  });

  it("takes a hard size floor (minParamsB) from the body or x-edgecoder-min-params-b", () => {
    expect(cleanHints({ minParamsB: 14 })).toEqual({ minParamsB: 14 });
    expect(cleanHints({ min_params_b: "30" })).toEqual({ minParamsB: 30 });
    expect(cleanHints({ minParamsB: 0 })).toEqual({});
    expect(cleanHints({ minParamsB: "big" })).toEqual({});
    expect(routingHintsFrom({}, { "x-edgecoder-min-params-b": "14" })).toEqual({ minParamsB: 14 });
    expect(describeJob(SIMPLE_QA, { minParamsB: 14 }).minParamsB).toBe(14);
    expect(describeJob(SIMPLE_QA).minParamsB).toBeUndefined();
  });
});

describe("job type", () => {
  it("is inferred from tools, cues and size", () => {
    expect(describeJob(AGENTIC_LOOP).job).toBe("agentic");
    expect(describeJob(SIMPLE_QA).job).toBe("chat");
    expect(describeJob(ONE_LINE_FIX).job).toBe("code_edit");
    expect(describeJob(MULTI_FILE_REFACTOR).job).toBe("refactor");
    expect(describeJob(LONG_LOG_SUMMARY).job).toBe("summarize");
    expect(describeJob(CLASSIFY).job).toBe("classify");
    expect(describeJob(SINGLE_EDIT).job).toBe("code_edit");
    expect(inferJob([{ role: "user", content: "Write unit tests for the parser" }], undefined, 50, false)).toBe("tests");
    expect(inferJob([{ role: "user", content: "Please review this change" }], undefined, 50, true)).toBe("code_review");
    expect(inferJob([{ role: "user", content: "Pull out the names as JSON" }], undefined, 50, false)).toBe("extract");
    expect(inferJob([{ role: "user", content: "Here is the whole book. Who is the narrator?" }], undefined, 40_000, false)).toBe("long_context");
    // "fix" in a question without code is chat.
    expect(inferJob([{ role: "user", content: "How do I fix my sleep schedule?" }], undefined, 20, false)).toBe("chat");
    // System prompt cues count.
    expect(inferJob([{ role: "system", content: "You summarize meeting notes." }, { role: "user", content: "notes..." }], undefined, 20, false)).toBe("summarize");
  });

  it("a hint wins over inference", () => {
    const j = describeJob(SIMPLE_QA, { job: "classify" });
    expect(j).toMatchObject({ job: "classify", jobInferred: false });
    expect(describeJob(SIMPLE_QA)).toMatchObject({ jobInferred: true, quality: "balanced", latency: "interactive", needsTools: false });
  });
});

describe("job descriptor", () => {
  it("sizes the prompt, the context it needs and the reply it expects", () => {
    const j = describeJob(MULTI_FILE_REFACTOR);
    expect(j.promptTokens).toBeGreaterThan(400);
    expect(j.contextTokens).toBeGreaterThan(j.promptTokens + 4096);
    // Harder jobs expect longer replies, within max_tokens.
    expect(j.expectedOutputTokens).toBeGreaterThan(describeJob(ONE_LINE_FIX).expectedOutputTokens);
    expect(describeJob(MULTI_FILE_REFACTOR, {}).expectedOutputTokens).toBeLessThanOrEqual(4096);
    expect(describeJob({ ...SIMPLE_QA, maxTokens: 50 }).expectedOutputTokens).toBeLessThanOrEqual(50);
    expect(describeJob(SIMPLE_QA, { minContext: 100_000 }).contextTokens).toBe(100_000);
    expect(describeJob(AGENTIC_LOOP)).toMatchObject({ needsTools: true });
    expect(describeJob(SIMPLE_QA, { maxCSats: 2 }).maxCSats).toBe(2);
  });

  it("counts only the tokens after the last reply as new (what a machine with the prefix cached still reads)", () => {
    const j = describeJob(AGENTIC_LOOP);
    expect(j.newTokens).toBeLessThan(j.promptTokens);
    expect(describeJob(SIMPLE_QA).newTokens).toBe(describeJob(SIMPLE_QA).promptTokens);
  });

  it("keys a session by its id, else by the conversation's first turns", () => {
    const a = sessionKeyOf([{ role: "user", content: "hello" }]);
    const b = sessionKeyOf([{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }, { role: "user", content: "more" }]);
    expect(a).toEqual(b);
    expect(a.from).toBe("hash");
    expect(sessionKeyOf([{ role: "user", content: "other" }]).key).not.toBe(a.key);
    expect(sessionKeyOf([], "s-1")).toMatchObject({ from: "header" });
    expect(sessionKeyOf([], "user:alice")).toMatchObject({ from: "user" });
    expect(sessionKeyOf([], "s-1").key).toHaveLength(32);
  });
});
