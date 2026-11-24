import { describe, expect, it } from "vitest";
import { applyCompaction, compactPaidTokensSetting, compactionNoteText, contextLabel, contextTokens, historyForModel, isCompactCommand, isPaidChoice } from "../src/lib/compaction";
import type { Conversation } from "../src/lib/types";

const chat = (n: number): Conversation => ({
  id: "c", title: "t", createdAt: 0, updatedAt: 0,
  messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 2 ? "assistant" : "user", content: `message ${i}`, timestamp: i })) as Conversation["messages"],
});

describe("desktop compaction", () => {
  it("only paid choices (your frontier key, network and cloud models) compact on a budget", () => {
    expect(isPaidChoice("frontier/anthropic/claude-opus-5-5")).toBe(true);
    expect(isPaidChoice("network/deepseek-v4.1-flash@cloud")).toBe(true);
    expect(isPaidChoice("deepseek-r1:14b")).toBe(false);
    expect(isPaidChoice("mine/qwen3.5:9b")).toBe(false);
    expect(isPaidChoice(undefined)).toBe(false);
    expect(isPaidChoice("auto")).toBe(false);
  });

  it("the budget defaults to 80,000 tokens", () => {
    expect(compactPaidTokensSetting()).toBe(80_000);
  });

  it("a kept summary replaces the messages it covers; a mismatched result is ignored", () => {
    const c = chat(8);
    const sent = historyForModel(c);
    expect(sent.messages).toHaveLength(8);
    expect(applyCompaction(c, { compacted: true, note: "SUMMARY", covered: 9, savedTokens: 1 }, sent, true)).toBe(false);
    c.contextTokens = 50_000;
    expect(applyCompaction(c, { compacted: true, note: "SUMMARY", covered: 4, savedTokens: 1_500 }, sent, true)).toBe(true);
    expect(c.summary).toMatchObject({ throughId: "m3", savedTokens: 1_500, manual: true });
    expect(c.contextTokens).toBeUndefined();
    const h = historyForModel(c);
    expect(h.messages.map((m) => m.content)).toEqual(["SUMMARY", "message 4", "message 5", "message 6", "message 7"]);
    expect(h.ids).toEqual(["m3", "m4", "m5", "m6", "m7"]);
    // A second compaction covering the summary keeps pointing at a real message.
    expect(applyCompaction(c, { compacted: true, note: "SUMMARY 2", covered: 3, savedTokens: 10 }, h, false)).toBe(true);
    expect(c.summary?.throughId).toBe("m5");
    expect(contextTokens(c)).toBeGreaterThan(0);
  });

  it("labels", () => {
    expect(contextLabel(42_300)).toBe("context ~42K tokens");
    expect(contextLabel(1_250_000)).toBe("context ~1.3M tokens");
    expect(compactionNoteText(12_345)).toBe("Earlier messages summarized to save tokens · ~12,345 tokens saved");
    expect(isCompactCommand(" /compact ")).toBe(true);
    expect(isCompactCommand("/compact now")).toBe(false);
  });
});
