// Network run 15:
// 1. Helper td0bcfe6 failed on "Every machine that runs qwen3.5:9b is busy" (503 no_capacity): its
//    price cap left only a Mac that was not pulling. A busy refusal is now retried after 2 s, 4 s, 8 s,
//    the ceiling sized again each time, and only then fails, saying so.
// 2. With --tentacle-budget 30 ("Budget covers ~1 of 8 helpers") 4 helpers still ran at once and 4
//    failed call by call (no_capacity, then the price ceiling). Helpers now start only within the
//    budget the running ones leave; when nothing is left, the queued ones stop with one message.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";
import { SessionHub, type ClientRef } from "../../src/apps/ide/sessions.js";
import { busyRefusal, HELPER_BUSY_BACKOFF_MS } from "../../src/apps/ide/tentacle-reserve.js";
import { hintedChat } from "../../src/apps/ide/tentacle-chat.js";
import { TentacleManager, type TentacleConfig } from "../../src/apps/ide/tentacles.js";
import { ChatBackendError, type ChatBackend, type ChatPiece, type ChatRequest } from "../../src/inference-api/types.js";

const TERM: ClientRef = { clientId: "term-1", kind: "terminal", label: "Terminal" };
const BUSY = "Every machine that runs qwen3.5:9b is busy and none is free right now. Try again shortly.";
let root: string;
let tmp: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t15-proj-"));
  tmp = mkdtempSync(join(tmpdir(), "t15-ws-"));
  const git = (...a: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a]);
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "alpha\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

type Step = { text?: string; tool?: [string, Record<string, unknown>]; cSats?: number; err?: Error; waitMs?: number };

function setup(script: (ctx: { task: string; call: number; req: ChatRequest }) => Step, config: Partial<TentacleConfig> = {}) {
  const hub = new SessionHub({ chat: () => async () => ({ content: "", toolCalls: [] }), systemPrompt: async () => "s", checkpoints: new CheckpointStore(), branch: () => "main" } as never, { dir: null, permissionsFile: null });
  let running = 0;
  let maxRunning = 0;
  const backend: ChatBackend = async function* (req): AsyncGenerator<ChatPiece> {
    const task = /# Task\n(.*)/.exec(req.messages.find((m) => m.role === "user")?.content ?? "")?.[1] ?? "";
    const step = script({ task, call: req.messages.filter((m) => m.role === "assistant").length, req });
    if (step.err) throw step.err;
    running++;
    maxRunning = Math.max(maxRunning, running);
    try {
      if (step.waitMs) await new Promise((r) => setTimeout(r, step.waitMs));
      if (step.text) yield { delta: step.text };
      if (step.tool) yield { toolCalls: [{ function: { name: step.tool[0], arguments: step.tool[1] } }] };
      yield { done: true, cSatsSpent: step.cSats ?? 0.5 };
    } finally {
      running--;
    }
  };
  const tentacles = new TentacleManager({
    host: { session: (id) => hub.peek(id), publishEvent: (id, ev) => hub.publishEvent(id, ev), recordNote: (id, note) => hub.recordNote(id, note) },
    workerBackend: () => backend,
    checkpoints: new CheckpointStore(),
    tmpRoot: tmp,
    config: { enabled: true, maxParallel: 4, budgetCSats: 100, perTentacleCSats: 25, workerModel: "auto", maxContextChars: 20_000, localFirst: false, ...config },
  });
  const s = hub.create({ projectRoot: root, client: TERM, autoApprove: "edits" });
  return { tentacles, s, maxRunning: () => maxRunning };
}

describe("1. a busy refusal (503 no_capacity) is retried with backoff", () => {
  it("recognises the run-15 refusals", () => {
    expect(busyRefusal(new ChatBackendError(BUSY, 503))).toBe(true);
    expect(busyRefusal(new ChatBackendError("Network request failed: no_capacity", 503))).toBe(true);
    expect(busyRefusal(new ChatBackendError("EdgeCoder is restarting and could not finish this request; send it again.", 503))).toBe(false);
    expect(busyRefusal(new ChatBackendError("No model on the network fits this request", 404, undefined, { code: "no_route_fits", reason: "price" }))).toBe(false);
    expect([...HELPER_BUSY_BACKOFF_MS]).toEqual([2_000, 4_000, 8_000]);
  });

  it("after 2 s, 4 s, 8 s with the ceiling sized again each time, then fails saying it was tried", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let hintsAsked = 0;
    const backend: ChatBackend = async function* () {
      calls++;
      throw new ChatBackendError(BUSY, 503);
    };
    const waits: number[] = [];
    const chat = hintedChat(backend, () => ({ maxCSats: 1 + hintsAsked++ }), new AbortController().signal, () => undefined, undefined, { onBusyRefusal: (ms) => (waits.push(ms), true) });
    const p = chat({ messages: [{ role: "user", content: "x" }] }).catch((e: Error) => e);
    await vi.runAllTimersAsync();
    const err = (await p) as Error;
    expect(waits).toEqual([2_000, 4_000, 8_000]);
    expect(calls).toBe(4);
    expect(hintsAsked).toBe(4);
    expect(err.message).toMatch(/is busy.*\(tried 4 times over 14 s: every machine that fits this helper's price ceiling stayed busy\)/);
  });

  it("td0bcfe6: busy twice, then served: the helper passes instead of failing", { timeout: 60_000 }, async () => {
    let refusals = 0;
    const { tentacles, s } = setup(({ call }) => {
      if (refusals < 2) {
        refusals++;
        return { err: new ChatBackendError(BUSY, 503) };
      }
      return call === 0 ? { text: "found it" } : { text: "done" };
    });
    const v = tentacles.delegate(s.id, { task: "sumArray", kind: "search", files: [], instructions: "" });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.status, t.result?.error).toBe("passed");
    expect(refusals).toBe(2);
  });
});

describe("2. the session's budget limits how many helpers run at once", { timeout: 60_000 }, () => {
  it("--tentacle-budget 30, 8 helpers at up to 25: one at a time, each giving back what it doesn't spend; then one message", async () => {
    // Each helper spends 6 cSats over two calls (run 15's helpers spent ~4.6-7.8).
    const { tentacles, s, maxRunning } = setup(({ task, call }) => (call === 0 ? { tool: ["list_directory", { path: "." }], cSats: 3, waitMs: 20 } : { text: `found ${task}`, cSats: 3 }), { budgetCSats: 30 });
    const fns = ["add", "sub", "mul", "clamp", "isEven", "reverseStr", "capitalize", "sumArray"];
    const ids = fns.map((f) => tentacles.delegate(s.id, { task: f, kind: "search", files: [], instructions: "" }).id);
    // Before: 4 running at once, 4 queued.
    expect(ids.map((id) => tentacles.get(s.id, id)!.status).filter((x) => x === "running")).toHaveLength(1);
    await tentacles.idle(s.id);
    expect(maxRunning()).toBe(1);
    const views = ids.map((id) => tentacles.get(s.id, id)!);
    const passed = views.filter((v) => v.status === "passed");
    const stopped = views.filter((v) => v.status === "error");
    // 30 cSats at 6 a helper: 4 run in full (24), the 5th starts on the 6 left; then less than one start is left.
    expect(passed.length).toBe(5);
    expect(stopped.length).toBe(3);
    // One clear message, not per-call ceiling or no_capacity errors.
    for (const v of stopped) {
      expect(v.result?.error).toMatch(/^The session's tentacle budget is spent \(30 cSats of 30 cSats\) after 5 of 8 helpers; this one did not start\. Raise --tentacle-budget/);
      expect(v.result?.cSats).toBe(0);
    }
    expect(tentacles.list(s.id).spentCSats).toBe(30);
  });

  it("budget 100 at up to 25 each: 4 at once, as before", async () => {
    const { tentacles, s, maxRunning } = setup(({ call }) => (call === 0 ? { tool: ["list_directory", { path: "." }], cSats: 1, waitMs: 50 } : { text: "ok", cSats: 1 }));
    for (let i = 0; i < 8; i++) tentacles.delegate(s.id, { task: `t${i}`, kind: "search", files: [], instructions: "" });
    await tentacles.idle(s.id);
    expect(maxRunning()).toBe(4);
    expect(tentacles.list(s.id).tentacles.every((t) => t.status === "passed")).toBe(true);
  });
});
