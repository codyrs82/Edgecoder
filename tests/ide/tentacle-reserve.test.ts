// #525: helper call reserves sized from the budgets left, empty attempts retried elsewhere, and
// the patch-return rate, on a fake worker backend.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";
import { SessionHub, type ClientRef, type SessionEvent } from "../../src/apps/ide/sessions.js";
import { emptyAttempt, hintedChat, retryAfterEmpty, smallWorkerWarning, tentacleSystemPrompt } from "../../src/apps/ide/tentacle-chat.js";
import { CallHolds, ceilingRefusal, helperCallCeiling, helperContextWindow, helperMaxTokens, helperReplyTokens, HELPER_FIT_WINDOW, HELPER_MAX_TOKENS, HELPER_MIN_REPLY_TOKENS, MIN_HELPER_CALL_CSATS, paidWorker, promptTokensOf } from "../../src/apps/ide/tentacle-reserve.js";
import { contextNeeded } from "../../src/inference-api/ollama.js";
import { tentacleRanOn, whereServed } from "../../src/apps/ide/tentacle-format.js";
import type { ServedBy } from "../../src/swarm/served-by.js";
import { patchReturn, TentacleManager, tentacleTotals, type TentacleConfig } from "../../src/apps/ide/tentacles.js";
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

type Step = { tool?: [string, Record<string, unknown>]; text?: string; cSats?: number; fail?: string; wait?: number; served?: ServedBy };
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
    expect(smallWorkerWarning("network/qwen2.5-coder:1.5b@gpu", 7)).toMatch(/under 7B/);
    expect(smallWorkerWarning("network/qwen3-coder:30b", 7)).toBeNull();
    expect(smallWorkerWarning("auto", 7)).toBeNull();
    expect(tentacleSystemPrompt(false)).toMatch(/only by calling edit_file/);
    expect(tentacleSystemPrompt(true)).not.toMatch(/edit_file/);
  });

  it("a 1.5B worker's empty_reply retries on auto, with a warning at the start, and the patch comes back", async () => {
    const { tentacles, s, requests, events } = setup(({ model, call }) => (model !== "auto" ? { fail: "The machine running qwen2.5-coder:1.5b reported: empty_reply" } : call === 0 ? { tool: ["write_file", { path: "d.txt", content: "d\n" }] } : { text: "wrote d" }), { workerModel: "network/qwen2.5-coder:1.5b" });
    const v = tentacles.delegate(s.id, { task: "add d", kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.status).toBe("passed");
    expect(t.result!.patch).toContain("d.txt");
    // The agent loop's own transient retries stay on the 1.5B model; the tentacle's retry moves to auto.
    const firstAuto = requests.findIndex((r) => r.model === "auto");
    expect(requests.slice(0, firstAuto).every((r) => r.model === "network/qwen2.5-coder:1.5b")).toBe(true);
    expect(requests.slice(firstAuto).map((r) => r.model)).toEqual(["auto", "auto"]);
    expect(requests[firstAuto].req.hints).toMatchObject({ quality: "best", sessionId: `tentacle:${v.id}:retry` });
    const progress = events.filter((e) => e.type === "tentacle_progress").map((e) => String(e.progress));
    expect(progress.some((p) => /under 7B/.test(p))).toBe(true);
    expect(progress.some((p) => /empty reply; retrying on auto/.test(p))).toBe(true);
    expect(tentacles.list(s.id).patches).toEqual({ asked: 1, returned: 1, rate: 1 });
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
    const { tentacles, s, requests } = setup(({ req }) => (req.hints?.quality === "best" ? { text: "it is in a.txt line 1" } : { text: "" }));
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
    const { tentacles, s, events } = setup(({ call }) => (call === 0 ? { tool: ["write_file", { path: "h.txt", content: "x\n" }], served: SERVED } : { text: "done", served: SERVED }), { workerModel: "network/qwen2.5-coder:1.5b" });
    const v = tentacles.delegate(s.id, { task: "host", kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.result!.class).toBe("apple");
    expect(tentacleRanOn(t.result!)).toBe("network/qwen2.5-coder:1.5b on apple · mac-•••30e5 Frankfurt");
    const notes = JSON.stringify(events);
    expect(notes).not.toMatch(/on unknown/);
  });
});
