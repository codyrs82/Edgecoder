import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANTHROPIC_MODELS } from "../../src/inference-api/frontier-models";
import { applyAgentEvent } from "../src/lib/agent-events";
import {
  FRONTIER_PRICES, costCheckArgs, frontierCostHint, markPremiumHintSeen, networkCostHint, premiumHintSeen, premiumModelHint, replyAskCSatsSetting, replyAskUsdSetting, setReplyAskCSats, setReplyAskUsd,
} from "../src/lib/cost-check";

// The app's side of the per-reply cost check and the cost hints (cost-check.ts).

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

// cSats per million tokens at a BTC price (glm-5.3 and deepseek-v4.1-flash, cloud).
const glm = { model: "glm-5.3", classes: ["cloud"], cloudHint: "premium", cSatsPerMTokens: { input: 1034, output: 3250, cachedInput: 192 } };
const flash = { model: "deepseek-v4.1-flash", classes: ["cloud"], cloudHint: "recommended", cSatsPerMTokens: { input: 222, output: 886, cachedInput: 4.4 } };
const qwen = { model: "qwen3-coder:30b", classes: ["gpu"], cSatsPerMTokens: { input: 322.7, output: 939.8 } };

describe("Settings → General → Ask before a reply spends more than …", () => {
  it("defaults to 150 cSats and $0.50, keeps clamped values, and forgets the default", () => {
    expect(replyAskCSatsSetting()).toBe(150);
    expect(replyAskUsdSetting()).toBe(0.5);
    expect(setReplyAskCSats(400)).toBe(400);
    expect(replyAskCSatsSetting()).toBe(400);
    expect(setReplyAskCSats(1)).toBe(10);
    expect(setReplyAskUsd(1.239)).toBe(1.24);
    expect(replyAskUsdSetting()).toBe(1.24);
    setReplyAskCSats(150);
    expect(store.has("edgecoder-reply-ask-csats")).toBe(false);
  });
});

describe("cost hints in the picker", () => {
  it("network models: their long reply in cSats; none without a price", () => {
    expect(networkCostHint(glm)).toBe("~140 cSats per long reply");
    expect(networkCostHint(flash)).toBe("~27 cSats per long reply");
    expect(networkCostHint({ model: "x" })).toBeNull();
  });

  it("Claude on your key: in dollars, from the same prices the provider uses", () => {
    for (const m of ANTHROPIC_MODELS) expect(FRONTIER_PRICES[m.id]).toEqual({ input: m.price.input, output: m.price.output, cachedInput: m.price.cacheRead });
    expect(frontierCostHint("frontier/anthropic/claude-opus-5-5")).toBe("~$0.52 per long reply");
    expect(frontierCostHint("frontier/anthropic/claude-haiku-5-5")).toBe("~$0.01 per long reply");
    expect(frontierCostHint("frontier/openai/gpt-x")).toBeNull();
  });
});

describe("the composer hint for a premium model", () => {
  it("GLM-5.3: how many times Flash, and Claude when you have a key", () => {
    expect(premiumModelHint("network/glm-5.3", [glm, flash], ["frontier/anthropic/claude-opus-5-5"])).toBe("GLM-5.3 costs ~5× Flash for exploring; Flash or Claude (your key) may fit better.");
    expect(premiumModelHint("network/glm-5.3@cloud", [glm, flash])).toBe("GLM-5.3 costs ~5× Flash for exploring; Flash may fit better.");
  });

  it("not for Flash itself, cheap models, free models, or without prices", () => {
    expect(premiumModelHint("network/deepseek-v4.1-flash", [glm, flash])).toBeNull();
    expect(premiumModelHint("network/qwen3-coder:30b@gpu", [qwen, flash])).toBeNull();
    expect(premiumModelHint("qwen3:8b", [glm, flash])).toBeNull();
    expect(premiumModelHint("frontier/anthropic/claude-opus-5-5", [glm, flash])).toBeNull();
    expect(premiumModelHint("network/glm-5.3", [glm])).toBeNull();
  });

  it("once per chat", () => {
    expect(premiumHintSeen("chat-1")).toBe(false);
    markPremiumHintSeen("chat-1");
    markPremiumHintSeen("chat-1");
    expect(premiumHintSeen("chat-1")).toBe(true);
    expect(premiumHintSeen("chat-2")).toBe(false);
    expect(JSON.parse(store.get("edgecoder-premium-hint-seen")!)).toEqual(["chat-1"]);
  });
});

describe("the stream", () => {
  it("cost notes collect on the turn", () => {
    let turn = applyAgentEvent({ text: "", toolEvents: [] }, { type: "cost_note", kind: "saved", message: "Skipped re-reading 3 unchanged files · ~90K tokens saved" }).turn;
    turn = applyAgentEvent(turn, { type: "cost_note", kind: "suggest", message: "Try Flash." }).turn;
    expect(turn.costNotes).toEqual(["Skipped re-reading 3 unchanged files · ~90K tokens saved", "Try Flash."]);
  });

  it("a cost check's card arguments", () => {
    expect(costCheckArgs({ question: "Q", suggest: { id: "network/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", factor: 5 }, switchLabel: "Switch to DeepSeek V4.1 Flash (~5× cheaper)" })).toEqual({
      question: "Q",
      suggest: { id: "network/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", factor: 5 },
      switchLabel: "Switch to DeepSeek V4.1 Flash (~5× cheaper)",
    });
    expect(costCheckArgs({ suggest: { id: 1 } })).toEqual({ question: "This reply has spent more than your limit." });
  });
});
