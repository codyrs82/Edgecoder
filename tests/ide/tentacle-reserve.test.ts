// #525: helper call reserves sized from the budgets left, empty attempts retried elsewhere, and
// the patch-return rate, on a fake worker backend.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";
import { SessionHub, type ClientRef, type SessionEvent } from "../../src/apps/ide/sessions.js";
import { emptyAttempt, hintedChat, isProviderTierError, retryAfterEmpty, smallWorkerWarning, TENTACLE_HELPER_MIN_PARAMS_B, tentacleHelperMinParamsB, tentacleSystemPrompt, underFloorWorker } from "../../src/apps/ide/tentacle-chat.js";
import { CallHolds, ceilingRefusal, helperCallCeiling, helperContextWindow, helperMaxTokens, helperReplyTokens, HELPER_FIT_WINDOW, HELPER_MAX_TOKENS, HELPER_MIN_REPLY_TOKENS, MIN_HELPER_CALL_CSATS, paidWorker, promptTokensOf } from "../../src/apps/ide/tentacle-reserve.js";
import { contextNeeded } from "../../src/inference-api/ollama.js";
import { tentacleRanOn, whereServed } from "../../src/apps/ide/tentacle-format.js";
import type { ServedBy } from "../../src/swarm/served-by.js";
import { HELPER_COMPACT_AT_TOKENS, patchReturn, TentacleManager, tentacleTotals, workerHints, type TentacleConfig } from "../../src/apps/ide/tentacles.js";
import { ChatBackendError, type ChatBackend, type ChatPiece, type ChatRequest } from "../../src/inference-api/types.js";

const TERM: ClientRef = { clientId: "term-1", kind: "terminal", label: "Terminal" };
let root: string;
let tmp: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tres-proj-"));
  tmp = mkdtempSync(join(tmpdir(), "tres-ws-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]);
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "alpha\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

type Step = { tool?: [string, Record<string, unknown>]; text?: string; cSats?: number; fail?: string; err?: Error; wait?: number; served?: ServedBy };
type Script = (ctx: { model: string; call: number; req: ChatRequest }) => Step;

function setup(script: Script, config: Partial<TentacleConfig> = {}) {
  const requests: Array<{ model: string; req: ChatRequest; heldNow: number }> = [];
  const hub = new SessionHub({ chat: () => async () => ({ content: "", toolCalls: [] }), systemPrompt: async () => "s", checkpoints: new CheckpointStore(), branch: () => "main" } as never, { dir: null, permissionsFile: null });
  // The ceilings of calls running right now: never more than the session's budget together.
  const running = new Map<number, number>();
  let n = 0;
  let maxHeld = 0;
  const backendFor = (model: string): ChatBackend =>
    async function* (req): AsyncGenerator<ChatPiece> {
      const k = ++n;
      running.set(k, req.hints?.maxCSats ?? 0);
      const held = [...running.values()].reduce((a, b) => a + b, 0);
      maxHeld = Math.max(maxHeld, held);
      requests.push({ model, req: structuredClone(req), heldNow: held });
      try {
        const step = script({ model, call: req.messages.filter((m) => m.role === "assistant").length, req });
        if (step.wait) await new Promise((r) => setTimeout(r, step.wait));
        if (step.err) throw step.err;
        if (step.fail) throw new ChatBackendError(step.fail, 502);
        if (step.text) yield { delta: step.text };
        if (step.tool) yield { toolCalls: [{ function: { name: step.tool[0], arguments: step.tool[1] } }] };
        yield { done: true, cSatsSpent: step.cSats ?? 0.1, ...(step.served ? { served: step.served } : {}) };
      } finally {
        running.delete(k);
      }
    };
  const tentacles = new TentacleManager({
    host: { session: (id) => hub.peek(id), publishEvent: (id, ev) => hub.publishEvent(id, ev), recordNote: (id, note) => hub.recordNote(id, note) },
    workerBackend: (model) => backendFor(model),
    checkpoints: new CheckpointStore(),
    tmpRoot: tmp,
    config: { enabled: true, maxParallel: 4, budgetCSats: 100, perTentacleCSats: 25, workerModel: "network/qwen3-coder:30b", maxContextChars: 20_000, localFirst: false, ...config },
  });
  const s = hub.create({ projectRoot: root, client: TERM, autoApprove: "edits" });
  const events: SessionEvent[] = [];
  hub.subscribe(s.id, TERM, 0, (e) => events.push(e));
  return { tentacles, s, requests, events, maxHeld: () => maxHeld };
}

const write = (file: string): Script => ({ call }) => (call === 0 ? { tool: ["write_file", { path: file, content: "x\n" }] } : { text: `wrote ${file}` });

// Git worktrees per helper are slow on Windows runners.
describe("helper call ceilings (tentacle-reserve.ts)", { timeout: 60_000 }, () => {
  it("sizes a ceiling from the tentacle's and the session's budget left, minus the others' holds", () => {
    expect(helperCallCeiling({ tentacleLeft: 25, sessionLeft: 100, heldByOthers: 50 })).toBe(25);
    expect(helperCallCeiling({ tentacleLeft: 25, sessionLeft: 60, heldByOthers: 50 })).toBe(10);
    expect(helperCallCeiling({ tentacleLeft: 25, sessionLeft: 40, heldByOthers: 50 })).toBe(0);
    expect(ceilingRefusal(10, { tentacleBudget: 25, tentacleLeft: 25 })).toBeNull();
    expect(ceilingRefusal(0.01, { tentacleBudget: 25, tentacleLeft: 0.01 })).toMatch(/0\.01 cSats of the tentacle's 25 cSats is left, less than one call sets aside/);
    expect(ceilingRefusal(0, { tentacleBudget: 25, tentacleLeft: 20 })).toMatch(/session's tentacle budget left/);
    expect(paidWorker("auto")).toBe(true);
    expect(paidWorker("network/qwen2.5-coder:1.5b")).toBe(true);
    expect(paidWorker("mine/qwen3-coder:30b")).toBe(false);
    expect(paidWorker("qwen3.5:9b")).toBe(false);
    expect(helperMaxTokens({})).toBe(HELPER_MAX_TOKENS);
    expect(helperMaxTokens({ EDGECODER_TENTACLE_MAX_TOKENS: "10" })).toBe(256);
  });

  it("holds add up and a release wakes a waiter", async () => {
    const h = new CallHolds();
    const a = h.hold(25);
    const b = h.hold(10);
    expect(h.total()).toBe(35);
    expect(h.total(a)).toBe(10);
    const woke = h.released(5_000);
    h.release(a);
    await woke;
    expect(h.total()).toBe(10);
    h.release(b);
    h.release(b);
    expect(h.total()).toBe(0);
  });

  it("four helpers at once: each call's maxCSats is within the tentacle's budget and together within the session's", async () => {
    const { tentacles, s, requests, maxHeld } = setup(({ call }) => (call === 0 ? { tool: ["write_file", { path: `f${Math.random()}.txt`, content: "x\n" }], wait: 20 } : { text: "done", wait: 20 }), { budgetCSats: 60, perTentacleCSats: 25 });
    for (let i = 0; i < 4; i++) tentacles.delegate(s.id, { task: `piece ${i}`, kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    expect(requests.length).toBeGreaterThanOrEqual(8);
    for (const r of requests) {
      expect(r.req.hints!.maxCSats!).toBeLessThanOrEqual(25);
      expect(r.req.hints!.maxCSats!).toBeGreaterThanOrEqual(MIN_HELPER_CALL_CSATS);
      expect(r.req.maxTokens).toBe(HELPER_MAX_TOKENS);
    }
    // Without the holds, four calls would carry 4 × 25 = 100 on a 60 cSat session budget.
    expect(maxHeld()).toBeLessThanOrEqual(60);
    expect(tentacles.list(s.id).tentacles.every((t) => t.status === "passed")).toBe(true);
  });

  it("a tentacle budget under the smallest reserve stops the helper before any call, saying why", async () => {
    const { tentacles, s, requests } = setup(write("b.txt"), { perTentacleCSats: 0.01 });
    const v = tentacles.delegate(s.id, { task: "tiny", kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(requests).toHaveLength(0);
    expect(t.status).toBe("error");
    expect(t.result!.error).toMatch(/stopped before a call: budget reached: 0\.01 cSats of the tentacle's 0\.01 cSats is left/);
  });

  it("run 12: a call refused for its ceiling (others' holds) waits for room for the cheapest fitting model, then runs", async () => {
    // The network's answer when nothing fits the ceiling (no_route_fits, reason price, neededCSats).
    const priceRefusal = () => new ChatBackendError("No model on the network fits this request: every fitting model costs more than the ceiling", 404, undefined, { code: "no_route_fits", reason: "price", neededCSats: 3.9 });
    const { tentacles, s, requests } = setup(({ req, call }) => {
      const task = /# Task\n(.*)/.exec(req.messages.find((m) => m.role === "user")?.content ?? "")?.[1] ?? "";
      if ((req.hints?.maxCSats ?? 0) < 3.9) return { err: priceRefusal() };
      // The first helper's first call runs a while, holding 25 of the session's 28 cSats.
      return call === 0 ? { tool: ["write_file", { path: `${task}.txt`, content: "x\n" }], wait: task === "slow" ? 300 : 0 } : { text: `wrote ${task}` };
    }, { budgetCSats: 28, perTentacleCSats: 25 });
    const a = tentacles.delegate(s.id, { task: "slow", kind: "code_edit", files: [], instructions: "" });
    await new Promise((r) => setTimeout(r, 50));
    const b = tentacles.delegate(s.id, { task: "second", kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, a.id)!.status).toBe("passed");
    // Before, the second helper failed: "budget ceiling (3 cSats cap vs ~3.9 cSats cheapest model)".
    const t = tentacles.get(s.id, b.id)!;
    expect(t.status, t.result?.error).toBe("passed");
    const second = requests.filter((r) => /# Task\nsecond/.test(r.req.messages.find((m) => m.role === "user")?.content ?? ""));
    expect(second[0].req.hints!.maxCSats!).toBeLessThan(3.9);
    expect(second[1].req.hints!.maxCSats!).toBeGreaterThanOrEqual(3.9 * 1.05 - 1e-9);
  });

  it("run 12: a tentacle budget below what the cheapest fitting model needs stops the helper, saying why", async () => {
    const { tentacles, s } = setup(() => ({ err: new ChatBackendError("No model on the network fits this request", 404, undefined, { code: "no_route_fits", reason: "price", neededCSats: 3.9 }) }), { perTentacleCSats: 2 });
    const v = tentacles.delegate(s.id, { task: "small budget", kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, v.id)!.status).toBe("error");
    expect(ceilingRefusal(2, { tentacleBudget: 2, tentacleLeft: 2, need: 4.2 })).toMatch(/less than the cheapest model that fits this call needs \(4\.20 cSats\)/);
    expect(ceilingRefusal(3, { tentacleBudget: 25, tentacleLeft: 25, need: 4.2 })).toMatch(/session's tentacle budget left \(3\.00 cSats\) is less than the cheapest model/);
  });

  it("free workers hold nothing and are not refused", async () => {
    const { tentacles, s, requests } = setup(write("c.txt"), { perTentacleCSats: 0.01, workerModel: "mine/qwen3-coder:30b" });
    tentacles.delegate(s.id, { task: "free", kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    expect(requests.length).toBeGreaterThan(0);
  });
});

describe("empty helper attempts (#525)", { timeout: 60_000 }, () => {
  it("tells empty attempts apart and picks where the retry goes", () => {
    expect(emptyAttempt({ modelError: "The machine running qwen2.5-coder:1.5b reported: empty_reply", summary: "", changedFiles: 0, writes: true })).toBe("empty_reply");
    expect(emptyAttempt({ summary: "", changedFiles: 0, writes: false })).toBe("empty_reply");
    expect(emptyAttempt({ summary: "I changed it", changedFiles: 0, writes: true })).toBe("no_file");
    expect(emptyAttempt({ summary: "found it", changedFiles: 0, writes: false })).toBeNull();
    expect(emptyAttempt({ modelError: "Not enough cSats", summary: "", changedFiles: 0, writes: true })).toBeNull();
    expect(retryAfterEmpty("network/qwen2.5-coder:1.5b", 7, "empty_reply")).toMatchObject({ model: "auto", freshHost: true, note: expect.stringMatching(/retrying on auto/) });
    expect(retryAfterEmpty("network/qwen3-coder:30b@gpu", 7, "no_file")).toMatchObject({ model: "network/qwen3-coder:30b@gpu", freshHost: true, note: expect.stringMatching(/another machine/) });
    expect(retryAfterEmpty("auto", 7, "empty_reply").model).toBe("auto");
    // D4: an empty reply retries on another machine at the same tier (≥ the floor) before any
    // higher (cloud) tier; a helper that changed no file moves auto up a tier.
    expect(retryAfterEmpty("auto", 7, "empty_reply")).toMatchObject({ nextTier: false, freshHost: true, note: expect.stringMatching(/another machine \(a model of at least 7B\)/) });
    expect(retryAfterEmpty("auto", 7, "no_file")).toMatchObject({ nextTier: true, note: expect.stringMatching(/stronger tier/) });
    expect(retryAfterEmpty("network/qwen2.5-coder:1.5b", 7, "empty_reply")).toMatchObject({ nextTier: false, note: expect.stringMatching(/at least 7B/) });
    expect(retryAfterEmpty("network/qwen3-coder:30b", 7, "empty_reply").nextTier).toBe(false);
    expect(smallWorkerWarning("network/qwen2.5-coder:1.5b@gpu", 7)).toMatch(/under 7B/);
    expect(smallWorkerWarning("network/qwen3-coder:30b", 7)).toBeNull();
    expect(smallWorkerWarning("auto", 7)).toBeNull();
    expect(smallWorkerWarning("network/qwen2.5-coder:1.5b", 0)).toBeNull();
    expect(underFloorWorker("network/qwen2.5-coder:1.5b", 7)).toBe(true);
    expect(underFloorWorker("network/qwen2.5-coder:1.5b", 0)).toBe(false);
    expect(underFloorWorker("network/qwen3-coder:30b", 7)).toBe(false);
    expect(underFloorWorker("auto", 7)).toBe(false);
    expect(underFloorWorker("mine/qwen2.5-coder:1.5b", 7)).toBe(false);
    expect(tentacleSystemPrompt(false)).toMatch(/only by calling edit_file/);
    expect(tentacleSystemPrompt(true)).not.toMatch(/edit_file/);
  });

  it("an explicit worker under the floor runs on auto with the floor, warned once per session", async () => {
    const { tentacles, s, requests, events } = setup(({ model, call, req }) => {
      if (model !== "auto") return { fail: "The machine running qwen2.5-coder:1.5b reported: empty_reply" };
      const task = /# Task\n(.*)/.exec(req.messages.find((m) => m.role === "user")?.content ?? "")?.[1];
      return call === 0 ? { tool: ["write_file", { path: `${task}.txt`, content: "d\n" }] } : { text: `wrote ${task}` };
    }, { workerModel: "network/qwen2.5-coder:1.5b" });
    const v = tentacles.delegate(s.id, { task: "d1", kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.status).toBe("passed");
    expect(t.result!.patch).toContain("d1.txt");
    // Every call, from the first, runs on auto with the helper floor; none on the 1.5B model.
    expect(requests.map((r) => r.model)).toEqual(["auto", "auto"]);
    expect(requests.every((r) => r.req.hints?.minParamsB === 7)).toBe(true);
    expect(requests[0].req.hints!.sessionId).toBe(`tentacle:${v.id}`);
    // A second helper in the session: also on auto, and no second warning.
    const w = tentacles.delegate(s.id, { task: "d2", kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, w.id)!.status).toBe("passed");
    expect(requests.every((r) => r.model === "auto" && r.req.hints?.minParamsB === 7)).toBe(true);
    const progress = events.filter((e) => e.type === "tentacle_progress").map((e) => String(e.progress));
    expect(progress.filter((p) => /qwen2\.5-coder:1\.5b is under 7B.*helpers run on auto/.test(p))).toHaveLength(1);
    expect(tentacles.list(s.id).patches).toEqual({ asked: 2, returned: 2, rate: 1 });
  });

  it("EDGECODER_TENTACLES_MIN_B=0 keeps an explicit small worker (no floor, no warning)", async () => {
    vi.stubEnv("EDGECODER_TENTACLES_MIN_B", "0");
    try {
      const { tentacles, s, requests, events } = setup(({ call }) => (call === 0 ? { tool: ["write_file", { path: "d0.txt", content: "d\n" }] } : { text: "wrote d0" }), { workerModel: "network/qwen2.5-coder:1.5b" });
      const v = tentacles.delegate(s.id, { task: "add d0", kind: "code_edit", files: [], instructions: "" });
      await tentacles.idle(s.id);
      expect(tentacles.get(s.id, v.id)!.status).toBe("passed");
      expect(new Set(requests.map((r) => r.model))).toEqual(new Set(["network/qwen2.5-coder:1.5b"]));
      expect(requests.every((r) => r.req.hints?.minParamsB === undefined)).toBe(true);
      const progress = events.filter((e) => e.type === "tentacle_progress").map((e) => String(e.progress));
      expect(progress.some((p) => /under \d+B/.test(p))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a bigger explicit worker that changed no file retries on the same model, on another machine", async () => {
    const { tentacles, s, requests } = setup(({ call, req }) => (req.hints?.sessionId?.endsWith(":retry") && call === 0 ? { tool: ["write_file", { path: "e.txt", content: "e\n" }] } : { text: "I would change e.txt like this: ..." }), { workerModel: "network/qwen3-coder:30b" });
    const v = tentacles.delegate(s.id, { task: "add e", kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, v.id)!.status).toBe("passed");
    expect(new Set(requests.map((r) => r.model))).toEqual(new Set(["network/qwen3-coder:30b"]));
    expect(requests[0].req.hints!.sessionId).toBe(`tentacle:${v.id}`);
    expect(requests.at(-1)!.req.hints!.sessionId).toBe(`tentacle:${v.id}:retry`);
  });

  it("a read-only helper's empty reply is retried instead of passing with nothing", async () => {
    const { tentacles, s, requests } = setup(({ req }) => (req.hints?.sessionId?.endsWith(":retry") ? { text: "it is in a.txt line 1" } : { text: "" }));
    const v = tentacles.delegate(s.id, { task: "find alpha", kind: "search", files: [], instructions: "" });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(requests).toHaveLength(2);
    expect(t.status).toBe("passed");
    expect(t.result!.summary).toContain("a.txt");
  });

  it("reports the patch-return rate in the totals", () => {
    const done = (patch: string, extra: object = {}) => ({ calls: [], cSats: 0, readOnly: false, kind: "code_edit" as const, status: "passed" as const, result: { patch } as never, ...extra });
    const views = [done("diff --git a/x"), done(""), done("", { status: "failed" }), done("", { readOnly: true }), done("", { status: "running" })];
    expect(patchReturn(views)).toEqual({ asked: 3, returned: 1, rate: 0.333 });
    expect(tentacleTotals(views).line).toMatch(/· 1\/3 patches back$/);
    expect(patchReturn([]).rate).toBeNull();
  });
});

const SERVED: ServedBy = { label: "mac-•••30e5", own: false, computeClass: "apple", tier: null, hardware: "Apple silicon", region: "fra", city: "Frankfurt", country: "DE" };

describe("helper reply size fits the hosts' context windows", { timeout: 60_000 }, () => {
  it("a helper call's prompt and reply fit an 8192-token host (an 8192 reply alone never did)", () => {
    expect(HELPER_MAX_TOKENS).toBeLessThanOrEqual(4096);
    // The netval helper prompts: about 2.6k tokens with tools.
    for (const prompt of [500, 2_600, 4_000, 6_000]) {
      const reply = helperReplyTokens(prompt, HELPER_MAX_TOKENS);
      expect(reply).toBeGreaterThanOrEqual(HELPER_MIN_REPLY_TOKENS);
      expect(reply).toBeLessThanOrEqual(HELPER_MAX_TOKENS);
      expect(prompt + reply + 256).toBeLessThanOrEqual(HELPER_FIT_WINDOW);
      expect(helperContextWindow(prompt)).toBe(8192);
    }
    expect(helperReplyTokens(2_600, HELPER_MAX_TOKENS)).toBe(4096);
    expect(helperReplyTokens(6_000, HELPER_MAX_TOKENS)).toBe(8192 - 6_000 - 256);
    // A prompt too big for 8K moves to 16K, and its reply never pushes it past that.
    expect(helperContextWindow(7_500)).toBe(16_384);
    expect(helperReplyTokens(7_500, HELPER_MAX_TOKENS)).toBe(4096);
    expect(helperReplyTokens(14_000, HELPER_MAX_TOKENS)).toBe(16_384 - 14_000 - 256);
    // A cap under the minimum (EDGECODER_TENTACLE_MAX_TOKENS=512) stays the cap.
    expect(helperReplyTokens(2_600, 512)).toBe(512);
    // The same count as the coordinator's contextNeeded.
    const msgs = [{ role: "user" as const, content: "x".repeat(9_000) }];
    const tools = [{ type: "function", function: { name: "read_file", description: "d", parameters: {} } }];
    expect(promptTokensOf(msgs, tools) + 1000 + 256).toBe(contextNeeded(msgs, tools as never, 1000));
  });

  it("each paid helper call sends a reply cap that fits an 8192 window with its prompt, and minContext 8192", async () => {
    const { tentacles, s, requests } = setup(({ call }) => (call === 0 ? { tool: ["write_file", { path: "fit.txt", content: "x\n" }] } : { text: "done" }));
    writeFileSync(join(root, "big.txt"), "y".repeat(6_000));
    tentacles.delegate(s.id, { task: "fit", kind: "code_edit", files: ["big.txt"], instructions: "" });
    await tentacles.idle(s.id);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const r of requests) {
      expect(r.req.hints!.minContext).toBe(8192);
      expect(contextNeeded(r.req.messages, r.req.tools, r.req.maxTokens)).toBeLessThanOrEqual(8192);
      expect(r.req.hints!.maxCSats!).toBeLessThanOrEqual(25);
    }
  });

  it("a call refused as too long for every host is sent once more with the minimum reply", async () => {
    const sent: number[] = [];
    const backend: ChatBackend = async function* (req) {
      sent.push(req.maxTokens ?? 0);
      if (sent.length === 1) throw new ChatBackendError("Network request failed: context_too_long", 502);
      yield { delta: "ok" };
      yield { done: true, cSatsSpent: 0.1 };
    };
    let after = 0;
    const calls: number[] = [];
    const chat = hintedChat(backend, () => ({}), new AbortController().signal, (u) => calls.push(u.cSats), undefined, { maxTokens: () => 4096, after: () => after++ });
    const r = await chat({ messages: [{ role: "user", content: "hi" }] });
    expect(r.content).toBe("ok");
    expect(sent).toEqual([4096, HELPER_MIN_REPLY_TOKENS]);
    expect(calls).toEqual([0.1]);
    expect(after).toBe(1);
    // Other failures and a second refusal still fail the call.
    const always: ChatBackend = async function* () {
      throw new ChatBackendError("Network request failed: context_too_long", 502);
    };
    const tries: number[] = [];
    const chat2 = hintedChat(async function* (req, sig) {
      tries.push(req.maxTokens ?? 0);
      yield* always(req, sig);
    }, () => ({}), new AbortController().signal, () => {}, undefined, { maxTokens: 4096 });
    await expect(chat2({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/context_too_long/);
    expect(tries).toEqual([4096, HELPER_MIN_REPLY_TOKENS]);
  });
});

describe("where a helper ran (served-by, not \"unknown\")", { timeout: 60_000 }, () => {
  it("takes the class and host from the call's served-by when the backend gave no where", () => {
    expect(whereServed(undefined, "network/qwen2.5-coder:1.5b", undefined).class).toBe("unknown");
    const w = whereServed(undefined, "network/qwen2.5-coder:1.5b", SERVED);
    expect(w).toEqual({ model: "network/qwen2.5-coder:1.5b", class: "apple", agentLabel: "apple · mac-•••30e5 Frankfurt" });
    expect(tentacleRanOn({ model: "network/qwen2.5-coder:1.5b", class: "unknown", calls: [{ cSats: 0.05, model: "qwen2.5-coder:1.5b", served: SERVED }] })).toBe("network/qwen2.5-coder:1.5b on apple · mac-•••30e5 Frankfurt");
    expect(tentacleRanOn({ model: "qwen3-coder:30b", class: "gpu", calls: [] })).toBe("qwen3-coder:30b on gpu");
    expect(tentacleRanOn({ model: "qwen3.5:9b", class: "this computer", place: "local", calls: [] })).toBe("qwen3.5:9b on this computer");
  });

  it("a finished helper's summary names the class and host that served it", async () => {
    const { tentacles, s, events } = setup(({ call }) => (call === 0 ? { tool: ["write_file", { path: "h.txt", content: "x\n" }], served: SERVED } : { text: "done", served: SERVED }), { workerModel: "network/qwen2.5-coder:7b" });
    const v = tentacles.delegate(s.id, { task: "host", kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.result!.class).toBe("apple");
    expect(tentacleRanOn(t.result!)).toBe("network/qwen2.5-coder:7b on apple · mac-•••30e5 Frankfurt");
    const notes = JSON.stringify(events);
    expect(notes).not.toMatch(/on unknown/);
  });
});

describe("helper floor and provider errors (D3, D4, C7)", { timeout: 60_000 }, () => {
  it("auto helper calls carry a ≥7B floor; EDGECODER_TENTACLES_MIN_B overrides it", async () => {
    expect(TENTACLE_HELPER_MIN_PARAMS_B).toBe(7);
    expect(tentacleHelperMinParamsB({})).toBe(7);
    expect(tentacleHelperMinParamsB({ EDGECODER_TENTACLES_MIN_B: "14" })).toBe(14);
    expect(tentacleHelperMinParamsB({ EDGECODER_TENTACLES_MIN_B: "0" })).toBe(0);
    expect(tentacleHelperMinParamsB({ EDGECODER_TENTACLES_MIN_B: "x" })).toBe(7);
    expect(workerHints({ kind: "tests" }, { minParamsB: 7 })).toMatchObject({ minParamsB: 7 });
    expect(workerHints({ kind: "tests" }, { minParamsB: 0 }).minParamsB).toBeUndefined();
    const { tentacles, s, requests } = setup(write("f.txt"), { workerModel: "auto" });
    tentacles.delegate(s.id, { task: "f", kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.req.hints?.minParamsB === 7)).toBe(true);
    vi.stubEnv("EDGECODER_TENTACLES_MIN_B", "14");
    try {
      const b = setup(write("g.txt"), { workerModel: "auto" });
      b.tentacles.delegate(b.s.id, { task: "g", kind: "code_edit", files: [], instructions: "" });
      await b.tentacles.idle(b.s.id);
      expect(b.requests.every((r) => r.req.hints?.minParamsB === 14)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("an empty reply on auto retries on another ≥7B machine at the same tier", async () => {
    const { tentacles, s, requests, events } = setup(({ call, req }) => (!req.hints?.sessionId?.endsWith(":retry") ? { text: "" } : call === 0 ? { tool: ["write_file", { path: "h.txt", content: "h\n" }] } : { text: "wrote h" }), { workerModel: "auto" });
    const v = tentacles.delegate(s.id, { task: "h", kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, v.id)!.status).toBe("passed");
    const retry = requests.find((r) => r.req.hints?.sessionId === `tentacle:${v.id}:retry`)!;
    expect(retry.req.hints).toMatchObject({ minParamsB: 7 });
    expect(retry.req.hints!.quality).not.toBe("best");
    const progress = events.filter((e) => e.type === "tentacle_progress").map((e) => String(e.progress));
    expect(progress.some((p) => /empty reply; retrying on another machine \(a model of at least 7B\)/.test(p))).toBe(true);
  });

  it("tells provider errors apart", () => {
    expect(isProviderTierError("cloud_provider_error: Fireworks HTTP 503: suspended")).toBe(true);
    expect(isProviderTierError("cloud_provider_rate_limited: Fireworks HTTP 429")).toBe(true);
    expect(isProviderTierError("no_capacity: cooling_down")).toBe(true);
    expect(isProviderTierError("HTTP 503 Service Unavailable")).toBe(true);
    expect(isProviderTierError("Not enough cSats")).toBe(false);
    expect(isProviderTierError(undefined)).toBe(false);
  });

  it("after a provider error, the session's retries skip the next tier and go to another machine at this tier", async () => {
    // The first helper's first attempt fails with a provider error; its retry stays at the tier (no quality best).
    const SUSPENDED = { fail: "cloud_provider_error: Fireworks HTTP 503: account suspended" };
    const { tentacles, s, requests, events } = setup(({ call, req }) => {
      const task = /# Task\n(.*)/.exec(req.messages.find((m) => m.role === "user")?.content ?? "")?.[1];
      const retry = !!req.hints?.sessionId?.endsWith(":retry");
      if (req.hints?.quality === "best" || (task === "k" && !retry)) return SUSPENDED;
      return call === 0 ? { tool: ["write_file", { path: `${task}.txt`, content: retry ? "right\n" : "wrong\n" }] } : { text: "wrote k" };
    }, { workerModel: "auto" });
    const v = tentacles.delegate(s.id, { task: "k", kind: "code_edit", files: [], instructions: "", acceptance: { kind: "grep", args: { pattern: "right", paths: ["k.txt"] } } });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, v.id)!.status).toBe("passed");
    expect(requests.some((r) => r.req.hints?.quality === "best")).toBe(false);
    // A second helper in the session whose check fails: its retry skips the next tier too.
    const w = tentacles.delegate(s.id, { task: "m", kind: "code_edit", files: [], instructions: "", acceptance: { kind: "grep", args: { pattern: "right", paths: ["m.txt"] } } });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, w.id)!.status).toBe("passed");
    expect(requests.some((r) => r.req.hints?.quality === "best")).toBe(false);
    const progress = events.filter((e) => e.type === "tentacle_progress").map((e) => String(e.progress));
    expect(progress.filter((p) => /another machine at this tier \(the next tier's provider returned an error lately\)/.test(p)).length).toBeGreaterThanOrEqual(2);
  });

  it("without a provider error, a failed check still moves up a tier", async () => {
    const { tentacles, s, requests } = setup(({ call, req }) => (call === 0 ? { tool: ["write_file", { path: "n.txt", content: req.hints?.quality === "best" ? "right\n" : "wrong\n" }] } : { text: "wrote n" }), { workerModel: "auto" });
    const v = tentacles.delegate(s.id, { task: "n", kind: "code_edit", files: [], instructions: "", acceptance: { kind: "grep", args: { pattern: "right", paths: ["n.txt"] } } });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, v.id)!.status).toBe("passed");
    expect(requests.at(-1)!.req.hints).toMatchObject({ quality: "best", minParamsB: 7 });
  });

  it("keeps a network helper's history short (compacts past HELPER_COMPACT_AT_TOKENS)", async () => {
    writeFileSync(join(root, "big.txt"), "z".repeat(18_000));
    const { tentacles, s, requests } = setup(({ call }) => (call < 6 ? { tool: ["read_file", { path: "big.txt" }] } : { text: "read it" }), { workerModel: "auto" });
    tentacles.delegate(s.id, { task: "read big", kind: "search", files: [], instructions: "" });
    await tentacles.idle(s.id);
    expect(requests.length).toBeGreaterThanOrEqual(4);
    // Six reads of ~6K tokens each would pass 36K tokens; compaction keeps each prompt under the bound.
    const tokens = requests.map((r) => Math.ceil(r.req.messages.reduce((n, m) => n + m.content.length, 0) / 3));
    expect(Math.max(...tokens)).toBeLessThanOrEqual(HELPER_COMPACT_AT_TOKENS);
  });
});
