import { describe, expect, it, vi } from "vitest";
import { runAgentLoop, type ChatFn, type ChatResult } from "../../src/apps/ide/agent-loop.js";
import {
  COST_CHECK_TOOL, ReplyCostMeter, costChoiceOf, firstCostAnswer, makeCostCheck, pickCheaperModel, replyAskCSats, replyAskUsd, type CostChoice,
} from "../../src/apps/ide/cost-guard.js";
import type { IdeStreamEvent } from "../../src/apps/ide/tool-types.js";
import { referenceReplyCost } from "../../src/common/reply-cost.js";

/*
 * The per-reply cost check on a paid lead (cost-guard.ts): the owner's glm-5.3 reply read 296K
 * tokens over 20 calls for 481 cSats without being asked. Now it pauses at the threshold and asks:
 * Keep going, Switch to a cheaper model (the same reply carries on), or Stop.
 */

const usage = (cSats: number, extra: Partial<Extract<IdeStreamEvent, { type: "usage" }>> = {}): IdeStreamEvent => ({ type: "usage", cSats, where: "Network", ...extra });

describe("thresholds", () => {
  it("cSats: the client's setting, else the env, else 150; nonsense ignored", () => {
    expect(replyAskCSats(undefined, {})).toBe(150);
    expect(replyAskCSats(undefined, { EDGECODER_REPLY_COST_ASK_CSATS: "300" })).toBe(300);
    expect(replyAskCSats(80, { EDGECODER_REPLY_COST_ASK_CSATS: "300" })).toBe(80);
    expect(replyAskCSats(-5, { EDGECODER_REPLY_COST_ASK_CSATS: "abc" })).toBe(150);
    expect(replyAskCSats(1, {})).toBe(150); // under the minimum (10)
  });

  it("USD on a frontier key: the client's setting, else the env, else $0.50", () => {
    expect(replyAskUsd(undefined, {})).toBe(0.5);
    expect(replyAskUsd(undefined, { EDGECODER_REPLY_COST_ASK_USD: "2" })).toBe(2);
    expect(replyAskUsd(1.234, {})).toBe(1.23);
    expect(replyAskUsd(0, { EDGECODER_REPLY_COST_ASK_USD: "nope" })).toBe(0.5);
  });
});

describe("ReplyCostMeter", () => {
  it("adds up cSats from usage events, with the tokens the calls reported", () => {
    const m = new ReplyCostMeter("cSats", 150);
    m.observe(usage(60, { served: { label: "x", own: false, computeClass: "cloud", tier: null, hardware: "", region: null, country: null, promptTokens: 80_000, outputTokens: 1_000 } }));
    m.observe({ type: "text", content: "hi" });
    m.observe(usage(50));
    expect(m.spent).toBe(110);
    expect(m.inputTokens).toBe(80_000);
    expect(m.outputTokens).toBe(1_000);
    expect(m.due()).toBe(false);
    m.observe(usage(45));
    expect(m.due()).toBe(true);
    // Keep going: the next ask after another threshold's worth.
    m.ack();
    expect(m.due()).toBe(false);
    m.observe(usage(149));
    expect(m.due()).toBe(false);
    m.observe(usage(1));
    expect(m.due()).toBe(true);
  });

  it("counts USD on a frontier key (usd, or the served line's usd), never cSats", () => {
    const m = new ReplyCostMeter("usd", 0.5);
    m.observe(usage(0, { usd: 0.3 }));
    m.observe(usage(999, { served: { label: "x", own: true, computeClass: "frontier", tier: null, hardware: "", region: null, country: null, usd: 0.25 } }));
    expect(m.spent).toBeCloseTo(0.55);
    expect(m.due()).toBe(true);
  });
});

function checkWith(o: { threshold?: number; answer?: CostChoice; cheaper?: boolean; canSwitch?: boolean }) {
  const events: IdeStreamEvent[] = [];
  const meter = new ReplyCostMeter("cSats", o.threshold ?? 150);
  const asked: Array<Record<string, unknown>> = [];
  const cheapChat: ChatFn = async () => ({ content: "cheap", toolCalls: [] });
  const check = makeCostCheck({
    meter,
    sendEvent: (e) => {
      meter.observe(e);
      events.push(e);
    },
    ask: async (_id, args) => {
      asked.push(args);
      return o.answer ?? "continue";
    },
    cheaper: () => (o.cheaper === false ? null : { id: "network/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", factor: 5 }),
    switchTo: () => cheapChat,
    canSwitch: o.canSwitch,
  });
  return { check, events, meter, asked, cheapChat };
}

describe("makeCostCheck", () => {
  const ctx = { inputTokens: 210_000, outputTokens: 3_000, waste: null };

  it("under the threshold: goes on without asking", async () => {
    const { check, events, meter, asked } = checkWith({});
    meter.observe(usage(100));
    expect(await check(ctx)).toEqual({ action: "continue" });
    expect(asked).toEqual([]);
    expect(events).toEqual([]);
  });

  it("past it: asks once as an approval-style item; Keep going waits another threshold's worth", async () => {
    const { check, events, meter, asked } = checkWith({ answer: "continue" });
    meter.observe(usage(160));
    expect(await check(ctx)).toEqual({ action: "continue" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ question: "This reply has used 160 cSats (read 210K tokens, wrote 3K).", switchLabel: "Switch to DeepSeek V4.1 Flash (~5× cheaper)", suggest: { id: "network/deepseek-v4.1-flash" } });
    const call = events.find((e) => e.type === "tool_call") as Extract<IdeStreamEvent, { type: "tool_call" }>;
    expect(call).toMatchObject({ tool: COST_CHECK_TOOL, requires_approval: true });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ id: call.id, result: "Kept going" });
    meter.observe(usage(100));
    expect(await check(ctx)).toEqual({ action: "continue" });
    expect(asked).toHaveLength(1);
    meter.observe(usage(60));
    await check(ctx);
    expect(asked).toHaveLength(2);
  });

  it("Switch: hands back the cheaper model's calls, and doesn't offer a switch again", async () => {
    const { check, meter, asked, cheapChat, events } = checkWith({ answer: "switch" });
    meter.observe(usage(200));
    const v = await check(ctx);
    expect(v).toEqual({ action: "switch", chat: cheapChat, name: "DeepSeek V4.1 Flash" });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ result: "Switched to DeepSeek V4.1 Flash" });
    meter.observe(usage(200));
    expect(await check(ctx)).toEqual({ action: "continue" });
    expect(asked[1].suggest).toBeUndefined();
  });

  it("Stop: ends the turn with a note", async () => {
    const { check, meter, events } = checkWith({ answer: "stop" });
    meter.observe(usage(151));
    const v = await check(ctx);
    expect(v.action).toBe("stop");
    expect((v as { note: string }).note).toMatch(/Stopped to save cost after 151 cSats/);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ result: "Stopped" });
  });

  it("no Switch where the asker can't carry it (a phone-started session turn), or without a cheaper model", async () => {
    for (const o of [{ canSwitch: false }, { cheaper: false }]) {
      const { check, meter, asked } = checkWith(o);
      meter.observe(usage(200));
      await check(ctx);
      expect(asked[0].suggest).toBeUndefined();
      expect(asked[0].switchLabel).toBeUndefined();
    }
  });

  it("waste that persists under the threshold: one inline suggestion, not an ask", async () => {
    const { check, events, asked } = checkWith({});
    await check({ ...ctx, waste: "re-read 4 files it had already read" });
    await check({ ...ctx, waste: "re-read 5 files it had already read" });
    expect(asked).toEqual([]);
    const notes = events.filter((e) => e.type === "cost_note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "suggest", suggest: { id: "network/deepseek-v4.1-flash" } });
    expect((notes[0] as { message: string }).message).toMatch(/re-read 4 files .*Switch to DeepSeek V4\.1 Flash/);
  });

  it("waste past the threshold rides on the card", async () => {
    const { check, meter, asked } = checkWith({});
    meter.observe(usage(170));
    await check({ ...ctx, waste: "re-read 4 files it had already read" });
    expect(asked[0].waste).toBe("This reply re-read 4 files it had already read.");
  });
});

describe("firstCostAnswer (the app, the phone through the relay, or a timeout)", () => {
  const mirror = () => {
    let phone: ((ok: boolean) => void) | null = null;
    const answered = vi.fn();
    return { m: { ask: () => new Promise<boolean>((r) => (phone = r)), answered }, phone: (ok: boolean) => phone!(ok), answered };
  };

  it("the app's three-way answer wins and clears the phone's card", async () => {
    const mi = mirror();
    let app!: { resolve: (ok: boolean) => void; choose: (c: CostChoice) => void };
    const unregister = vi.fn();
    const p = firstCostAnswer("cost_1", { question: "q" }, mi.m, (a) => (app = a), unregister, 60_000);
    app.choose("switch");
    expect(await p).toBe("switch");
    expect(unregister).toHaveBeenCalled();
    expect(mi.answered).toHaveBeenCalledWith("cost_1", true);
  });

  it("the phone answers through the relay: approve is Keep going, deny is Stop", async () => {
    for (const [ok, want] of [[true, "continue"], [false, "stop"]] as const) {
      const mi = mirror();
      const p = firstCostAnswer("cost_2", { question: "q" }, mi.m, () => {}, () => {}, 60_000);
      mi.phone(ok);
      expect(await p).toBe(want);
      expect(mi.answered).not.toHaveBeenCalled();
    }
  });

  it("no answer: Stop (nothing more is spent)", async () => {
    vi.useFakeTimers();
    try {
      const p = firstCostAnswer("cost_3", {}, null, () => {}, () => {}, 1_000);
      vi.advanceTimersByTime(1_001);
      expect(await p).toBe("stop");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an approval answer without a choice maps to Keep going / Stop", () => {
    expect(costChoiceOf(true)).toBe("continue");
    expect(costChoiceOf(false)).toBe("stop");
    expect(costChoiceOf(true, "switch")).toBe("switch");
  });
});

describe("pickCheaperModel", () => {
  const flash = { model: "deepseek-v4.1-flash", classes: ["cloud"], cSatsPerMTokens: { input: 222, output: 886, cachedInput: 4.4 } };
  const glm = { model: "glm-5.3", classes: ["cloud"], cSatsPerMTokens: { input: 1034, output: 3250, cachedInput: 192 } };

  it("prefers DeepSeek V4.1 Flash when the network lists it, with how many times cheaper", () => {
    const m = pickCheaperModel({ model: "glm-5.3", target: "network" }, { networkModels: [glm, flash], localModels: ["qwen3:8b"], referenceCost: referenceReplyCost });
    expect(m).toEqual({ id: "network/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", factor: 5 });
  });

  it("from a frontier key: Flash, without a factor (USD vs cSats)", () => {
    expect(pickCheaperModel({ model: "claude-opus-5-5", target: "frontier" }, { networkModels: [flash], referenceCost: referenceReplyCost })).toEqual({ id: "network/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", factor: null });
  });

  it("else the network's best fit, else this computer's model; already on Flash: only a free model", () => {
    expect(pickCheaperModel({ model: "glm-5.3", target: "network" }, { networkModels: [glm], localModels: [] })).toEqual({ id: "auto", name: "Auto (best fit)" });
    expect(pickCheaperModel({ model: "claude-opus-5-5", target: "frontier" }, { networkModels: [], localModels: ["nomic-embed-text", "qwen3:8b"] })).toEqual({ id: "qwen3:8b", name: "qwen3:8b on this computer (free)" });
    expect(pickCheaperModel({ model: "deepseek-v4.1-flash", target: "network" }, { networkModels: [flash], localModels: ["gpt-oss:120b-cloud", "qwen3:8b"] })).toEqual({ id: "qwen3:8b", name: "qwen3:8b on this computer (free)" });
    expect(pickCheaperModel({ model: "deepseek-v4.1-flash", target: "network" }, { networkModels: [flash], localModels: [] })).toBeNull();
  });
});

describe("in the agent loop", () => {
  /** A model that spends `perCall` cSats a call (its usage event) and reads a file each step. */
  function spending(perCall: number, steps: number, emit: (e: IdeStreamEvent) => void, name = "glm") {
    let n = 0;
    const calls: string[] = [];
    const chat: ChatFn = async (_req, onDelta): Promise<ChatResult> => {
      n++;
      calls.push(name);
      emit(usage(perCall));
      if (n >= steps) onDelta?.("Done.");
      return n < steps ? { content: "", toolCalls: [{ name: "read_file", arguments: { path: `f${n}.ts` } }] } : { content: "Done.", toolCalls: [] };
    };
    return { chat, calls };
  }

  function loopWith(answer: CostChoice) {
    const events: IdeStreamEvent[] = [];
    const meter = new ReplyCostMeter("cSats", 150);
    const send = (e: IdeStreamEvent) => {
      meter.observe(e);
      events.push(e);
    };
    const lead = spending(24, 20, send);
    const cheap = spending(3, 3, send, "flash");
    const asked: string[] = [];
    const run = runAgentLoop({
      chat: lead.chat,
      systemPrompt: () => "sys",
      messages: [{ role: "user", content: "explore the repo" }],
      sendEvent: send,
      isCancelled: () => false,
      runTool: async () => "x".repeat(50),
      native: true,
      costCheck: makeCostCheck({
        meter,
        sendEvent: send,
        ask: async (id) => {
          asked.push(id);
          return answer;
        },
        cheaper: () => ({ id: "network/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", factor: 5 }),
        switchTo: () => cheap.chat,
      }),
    });
    return { run, events, lead, cheap, asked, meter };
  }

  it("Stop: the reply ends before the next model call, with the note", async () => {
    const t = loopWith("stop");
    await t.run;
    // 24 cSats a call: the 7th call passes 150; the check before the 8th asks.
    expect(t.lead.calls).toHaveLength(7);
    expect(t.asked).toHaveLength(1);
    const text = t.events.filter((e) => e.type === "text").map((e) => (e as { content: string }).content).join("");
    expect(text).toMatch(/Stopped to save cost after 168 cSats/);
  });

  it("Switch: the same reply carries on with the cheaper model", async () => {
    const t = loopWith("switch");
    await t.run;
    expect(t.lead.calls).toHaveLength(7);
    expect(t.cheap.calls).toHaveLength(3);
    const text = t.events.filter((e) => e.type === "text").map((e) => (e as { content: string }).content).join("");
    expect(text).toContain("Done.");
  });

  it("Keep going: asks again after another 150 cSats", async () => {
    const t = loopWith("continue");
    await t.run;
    expect(t.lead.calls).toHaveLength(20);
    // 480 cSats in all: asked at 168, 336.
    expect(t.asked).toHaveLength(2);
  });

  it("no cost check (a free model): never asks, however much the events say", async () => {
    const events: IdeStreamEvent[] = [];
    const lead = spending(500, 5, (e) => events.push(e));
    await runAgentLoop({ chat: lead.chat, systemPrompt: () => "", messages: [{ role: "user", content: "go" }], sendEvent: (e) => events.push(e), isCancelled: () => false, runTool: async () => "x", native: true });
    expect(events.some((e) => e.type === "tool_call" && e.tool === COST_CHECK_TOOL)).toBe(false);
    expect(lead.calls).toHaveLength(5);
  });
});
