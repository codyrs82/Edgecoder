import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as R from "../../src/common/reply-cost.js";
import { ANTHROPIC_MODELS } from "../../src/inference-api/frontier-models.js";

/* What one reply costs on a paid model: the cost check's question and the picker's cost hint. */

describe("reply-cost: one module for the provider and the desktop app", () => {
  it("desktop/src/lib/reply-cost.ts is byte-identical with src/common/reply-cost.ts", () => {
    const shared = readFileSync(new URL("../../src/common/reply-cost.ts", import.meta.url), "utf8");
    const desktop = readFileSync(new URL("../../desktop/src/lib/reply-cost.ts", import.meta.url), "utf8");
    expect(desktop.replace(/\r\n/g, "\n")).toBe(shared.replace(/\r\n/g, "\n"));
  });
});

describe("the reference long reply (200K in, half cached, 5K out)", () => {
  // glm-5.3 and deepseek-v4.1-flash at their provider price + 30% (USD per million tokens).
  const glm = { input: 1.82, cachedInput: 0.338, output: 5.72 };
  const flash = { input: 0.39, cachedInput: 0.0078, output: 1.56 };

  it("prices a model's long reply from its per-million prices", () => {
    expect(R.referenceReplyCost(glm)).toBeCloseTo(0.1 * 1.82 + 0.1 * 0.338 + 0.005 * 5.72, 9);
    expect(R.referenceReplyCost(flash)).toBeCloseTo(0.04758, 6);
    // Without a cached price, cached tokens cost full input.
    expect(R.referenceReplyCost({ input: 1, output: 2 })).toBeCloseTo(0.2 + 0.01, 9);
  });

  it("the picker's lines: cSats rounded, USD in cents; Claude on your key in $", () => {
    expect(R.costHintLine({ input: 1034, cachedInput: 192, output: 3250 }, "cSats")).toBe("~140 cSats per long reply");
    expect(R.costHintLine({ input: 222, cachedInput: 4.4, output: 886 }, "cSats")).toBe("~27 cSats per long reply");
    const opus = ANTHROPIC_MODELS.find((m) => m.id === "claude-opus-5-5")!.price;
    expect(R.costHintLine({ input: opus.input, output: opus.output, cachedInput: opus.cacheRead }, "usd")).toBe("~$0.52 per long reply");
  });

  it("how many times cheaper (null under 2×)", () => {
    expect(R.cheaperFactor(R.referenceReplyCost(glm), R.referenceReplyCost(flash))).toBe(5);
    expect(R.cheaperFactor(1.5, 1)).toBeNull();
    expect(R.cheaperFactor(1, 0)).toBeNull();
  });
});

describe("words", () => {
  it("the cost check's question, with tokens read and written when known", () => {
    expect(R.costAskQuestion({ spent: 160.4, unit: "cSats", inputTokens: 210_000, outputTokens: 3_000 })).toBe("This reply has used 160 cSats (read 210K tokens, wrote 3K).");
    expect(R.costAskQuestion({ spent: 0.613, unit: "usd", inputTokens: 296_400, outputTokens: 4_600 })).toBe("This reply has used $0.61 (read 296K tokens, wrote 4.6K).");
    expect(R.costAskQuestion({ spent: 151, unit: "cSats" })).toBe("This reply has used 151 cSats.");
  });

  it("tokens, spend, switch label and the premium hint", () => {
    expect([800, 4_600, 12_400, 1_250_000].map(R.formatTokensShort)).toEqual(["800", "4.6K", "12K", "1.3M"]);
    expect(R.formatSpend(0.004, "usd")).toBe("<$0.01");
    expect(R.formatSpend(1234.4, "cSats")).toBe("1,234 cSats");
    expect(R.switchLabel("DeepSeek V4.1 Flash", 5)).toBe("Switch to DeepSeek V4.1 Flash (~5× cheaper)");
    expect(R.switchLabel("Auto (best fit)", null)).toBe("Switch to Auto (best fit)");
    expect(R.premiumHint({ name: "GLM-5.3", factor: 5, cheaperName: "Flash", frontierName: "Claude" })).toBe("GLM-5.3 costs ~5× Flash for exploring; Flash or Claude (your key) may fit better.");
    expect(R.premiumHint({ name: "GLM-5.3", factor: 5, cheaperName: "Flash" })).toBe("GLM-5.3 costs ~5× Flash for exploring; Flash may fit better.");
  });

  it("settings outside their range are ignored", () => {
    expect(R.clampReplyAskCSats("200")).toBe(200);
    expect(R.clampReplyAskCSats(5)).toBeNull();
    expect(R.clampReplyAskUsd("0.75")).toBe(0.75);
    expect(R.clampReplyAskUsd(5000)).toBeNull();
  });
});
