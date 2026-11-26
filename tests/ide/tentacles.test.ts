// Tentacles: the lead's delegate / await tools, the runner's isolated workspaces, acceptance,
// escalation, merge back, limits, cancellation and events, on a fake worker backend.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolSchemas } from "../../src/apps/ide/agent-loop.js";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";
import { describeTentacle, parseDelegateArgs, tentacleExecutor, TENTACLE_GUIDANCE, withTentacleGuidance, withTentacleTools } from "../../src/apps/ide/delegate.js";
import { SessionHub, type ClientRef, type SessionEvent } from "../../src/apps/ide/sessions.js";
import type { PermissionMode } from "../../src/apps/ide/permissions.js";
import { acceptanceCommand, runAcceptance } from "../../src/apps/ide/tentacle-workspace.js";
import {
  acceptanceProbe,
  canAutoApply,
  parseFileRef,
  parseWhere,
  pickLocalHelperModel,
  sessionAllowsShell,
  tentacleCallLine,
  tentacleRanOn,
  tentacleComplexity,
  tentacleConfigFromEnv,
  TentacleError,
  TentacleManager,
  tentacleShellDecision,
  tentacleTotals,
  tentacleWorkerModel,
  tentaclePlacement,
  workerHints,
  type TentacleConfig,
} from "../../src/apps/ide/tentacles.js";
import { ToolExecutor } from "../../src/apps/ide/tool-executor.js";
import type { ChatBackend, ChatPiece, ChatRequest } from "../../src/inference-api/types.js";
import type { ServedBy } from "../../src/swarm/served-by.js";
import { scriptedModel, until, type Reply } from "../helpers/sessions.js";

const TERM: ClientRef = { clientId: "term-1", kind: "terminal", label: "Terminal" };

let root: string;
let tmp: string;

function git(...args: string[]) {
  return execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tent-proj-"));
  tmp = mkdtempSync(join(tmpdir(), "tent-ws-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "alpha\nbeta\ngamma\n");
  writeFileSync(join(root, "lib.ts"), "export const x = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
});

/** One worker step: a tool call or a final text, what it cost and where it ran. */
interface Step {
  tool?: [string, Record<string, unknown>];
  text?: string;
  cSats?: number;
  where?: string;
  wait?: Promise<void>;
  served?: ServedBy;
  promptTokens?: number;
  outputTokens?: number;
}
type Script = (ctx: { task: string; call: number; escalated: boolean; req: ChatRequest }) => Step;

/** A fake worker: the task comes from the tentacle's prompt; `call` counts model calls in this attempt. */
function fakeWorker(script: Script) {
  const requests: ChatRequest[] = [];
  let running = 0;
  let maxRunning = 0;
  const backend: ChatBackend = async function* (req, signal): AsyncGenerator<ChatPiece> {
    requests.push(structuredClone(req));
    running++;
    maxRunning = Math.max(maxRunning, running);
    try {
      const first = req.messages.find((m) => m.role === "user")?.content ?? "";
      const task = /# Task\n(.*)/.exec(first)?.[1] ?? "";
      const call = req.messages.filter((m) => m.role === "assistant").length;
      const step = script({ task, call, escalated: req.hints?.quality === "best", req });
      if (step.wait) {
        await Promise.race([
          step.wait,
          new Promise<never>((_, reject) => {
            if (signal?.aborted) reject(new Error("aborted"));
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
        ]);
      }
      if (step.text) yield { delta: step.text };
      if (step.tool) yield { toolCalls: [{ function: { name: step.tool[0], arguments: step.tool[1] } }] };
      yield { done: true, cSatsSpent: step.cSats ?? 0.5, where: step.where ?? "routed to qwen3-coder:30b on gpu because cheapest fit", ...(step.served ? { served: step.served } : {}), ...(step.promptTokens !== undefined ? { promptTokens: step.promptTokens } : {}), ...(step.outputTokens !== undefined ? { outputTokens: step.outputTokens } : {}) };
    } finally {
      running--;
    }
  };
  return { backend, requests, stats: () => ({ maxRunning }) };
}

function setup(o: { leadReplies?: Reply[]; script: Script; config?: Partial<TentacleConfig>; autoApprove?: "none" | "edits"; mode?: PermissionMode; model?: string; workerModel?: string; ownerAccount?: string; worker?: ReturnType<typeof fakeWorker>; deps?: Partial<ConstructorParameters<typeof TentacleManager>[0]> }) {
  const checkpoints = new CheckpointStore();
  const lead = scriptedModel(o.leadReplies ?? []);
  const worker = o.worker ?? fakeWorker(o.script);
  const backendCalls: Array<{ model: string; ctx: { role: "worker" } }> = [];
  // eslint-disable-next-line prefer-const
  let tentacles: TentacleManager;
  const hub: SessionHub = new SessionHub(
    {
      chat: () => lead.chat,
      systemPrompt: async (s) => withTentacleGuidance(() => "system", tentacles.enabled(s.id), tentacles.unreported(s.id)),
      executor: (s) => {
        const ex = new ToolExecutor(s.projectRoot);
        return { execute: tentacleExecutor(tentacles, s.id, (t, a, op) => ex.execute(t, a, op)) };
      },
      tools: (s) => withTentacleTools(toolSchemas(), tentacles.enabled(s.id)),
      checkpoints,
      branch: () => "main",
      onSessionStop: (id) => void tentacles.cancelAll(id),
    },
    { dir: null, permissionsFile: null },
  );
  tentacles = new TentacleManager({
    host: { session: (id) => hub.peek(id), publishEvent: (id, ev) => hub.publishEvent(id, ev), recordNote: (id, n) => hub.recordNote(id, n) },
    workerBackend: (model, _sid, ctx) => {
      backendCalls.push({ model, ctx });
      return worker.backend;
    },
    checkpoints,
    tmpRoot: tmp,
    ...(o.deps ?? {}),
    config: { enabled: true, maxParallel: 4, budgetCSats: 100, perTentacleCSats: 25, workerModel: "auto", maxContextChars: 20_000, ...(o.config ?? {}) },
  });
  const s = hub.create({ projectRoot: root, client: TERM, ...(o.mode ? { mode: o.mode } : { autoApprove: o.autoApprove ?? "edits" }), ...(o.model ? { model: o.model } : {}), ...(o.workerModel ? { workerModel: o.workerModel } : {}), ...(o.ownerAccount ? { ownerAccount: o.ownerAccount } : {}) });
  const events: SessionEvent[] = [];
  hub.subscribe(s.id, TERM, 0, (e) => events.push(e));
  return { hub, tentacles, s, worker, lead, events, checkpoints, backendCalls };
}

/** A worker that writes `file` with `content`, then summarizes. */
const writer = (file: string, content: string): Script => ({ call }) =>
  call === 0 ? { tool: ["write_file", { path: file, content }] } : { text: `Wrote ${file}.` };

describe("delegate arguments", () => {
  it("parses a spec, tolerating lists sent as strings", () => {
    const spec = parseDelegateArgs({ task: "Write tests", kind: "tests", files: '["lib.ts","a.txt#L1-L2"]', instructions: "cover x", acceptance: '{"kind":"vitest","args":["t.test.ts"]}', complexity: "high", budgetCSats: "5" });
    expect(spec).toMatchObject({ task: "Write tests", kind: "tests", files: ["lib.ts", "a.txt#L1-L2"], acceptance: { kind: "vitest", args: ["t.test.ts"] }, complexity: "high", budgetCSats: 5 });
  });
  it("refuses bad kinds, absolute paths and unknown checks", () => {
    expect(() => parseDelegateArgs({ task: "x", kind: "deploy", instructions: "" })).toThrow(/kind/);
    expect(() => parseDelegateArgs({ task: "x", kind: "tests", files: ["/etc/passwd"], instructions: "" })).toThrow(/project-relative/);
    expect(() => parseDelegateArgs({ task: "x", kind: "tests", files: ["../up"], instructions: "" })).toThrow(/project-relative/);
    expect(() => parseDelegateArgs({ task: "x", kind: "tests", instructions: "", acceptance: { kind: "make" } })).toThrow(/acceptance/);
  });
  it("file refs, where, hints and the shell allowlist", () => {
    expect(parseFileRef("src/a.ts#L10-L20")).toEqual({ path: "src/a.ts", start: 10, end: 20 });
    expect(parseFileRef("src/a.ts")).toEqual({ path: "src/a.ts" });
    expect(parseWhere("routed to qwen3-coder:30b on gpu because cheapest", "auto")).toMatchObject({ model: "qwen3-coder:30b", class: "gpu" });
    expect(workerHints({ kind: "tests" })).toMatchObject({ job: "tests", complexity: 0.4, quality: "balanced", latency: "batch", needsTools: true });
    expect(workerHints({ kind: "tests", complexity: "high" }, { escalate: true })).toMatchObject({ complexity: 0.9, quality: "best" });
    expect(workerHints({ kind: "summarize" })).toMatchObject({ job: "summarize", quality: "fast", minContext: 8192 });
    expect(tentacleShellDecision("npx vitest run tests/a.test.ts", root, () => true)).toMatchObject({ ok: true });
    expect(tentacleShellDecision("npx some-package", root).ok).toBe(false);
    expect(tentacleShellDecision("npm test && rm -rf /", root).ok).toBe(false);
    expect(tentacleShellDecision("cat /etc/passwd", root).ok).toBe(false);
    expect(tentacleShellDecision("curl http://x", root).ok).toBe(false);
  });
  it("adds the tools and guidance only when tentacles are on", () => {
    expect(withTentacleTools(toolSchemas(), false)!.some((t) => t.function.name === "delegate")).toBe(false);
    expect(withTentacleTools(toolSchemas(), true)!.map((t) => t.function.name)).toEqual(expect.arrayContaining(["delegate", "await_tentacles", "cancel_tentacle"]));
    expect(withTentacleGuidance(() => "S", true)("native")).toContain(TENTACLE_GUIDANCE);
    expect(withTentacleGuidance(() => "S", false)("native")).toBe("S");
  });
});

describe("acceptance checks", () => {
  it("builds niced argv and refuses arguments outside the project", () => {
    expect(acceptanceCommand({ kind: "vitest", args: ["tests/a.test.ts"] }, "darwin")).toEqual({ argv: ["nice", "-n", "10", "npx", "--no-install", "vitest", "run", "tests/a.test.ts", "--maxWorkers=2"] });
    expect(acceptanceCommand({ kind: "tsc" }, "linux")).toEqual({ argv: ["nice", "-n", "10", "npx", "--no-install", "tsc", "--noEmit", "-p", "tsconfig.json"] });
    expect(acceptanceCommand({ kind: "vitest", args: ["../x.test.ts"] })).toHaveProperty("error");
    expect(acceptanceCommand({ kind: "vitest", args: ["--config=/tmp/evil"] })).toHaveProperty("error");
    expect(acceptanceCommand({ kind: "grep", args: { pattern: "x", paths: ["/etc"] } })).toHaveProperty("error");
  });
  it("runs grep (present and absent) in a folder", async () => {
    expect((await runAcceptance({ kind: "grep", args: { pattern: "beta", paths: ["a.txt"] } }, root)).passed).toBe(true);
    expect((await runAcceptance({ kind: "grep", args: { pattern: "delta", paths: ["a.txt"] } }, root)).passed).toBe(false);
    expect((await runAcceptance({ kind: "grep", args: { pattern: "delta", absent: true } }, root)).passed).toBe(true);
    expect((await runAcceptance({ kind: "none" }, root)).passed).toBe(true);
  });
});

describe("tentacle runner", () => {
  it("delegate returns an id at once; await_tentacles returns the result; a clean pass is applied as an undoable checkpoint", async () => {
    const { hub, tentacles, s, worker } = setup({ script: writer("b.ts", "export const b = 2;\n") });
    const exec = tentacleExecutor(tentacles, s.id, async () => ({ error: "inner" }));
    const started = await exec("delegate", { task: "Add b.ts", kind: "code_edit", files: ["lib.ts"], instructions: "export b = 2", acceptance: { kind: "grep", args: { pattern: "b = 2", paths: ["b.ts"] } } }, { approved: false });
    const { id } = JSON.parse(started.result!) as { id: string };
    expect(id).toMatch(/^t[0-9a-f]{7}$/);
    const awaited = await exec("await_tentacles", { ids: [id], timeoutS: 10 }, { approved: false });
    const r = JSON.parse(awaited.result!) as { finished: Array<Record<string, unknown>> };
    expect(r.finished[0]).toMatchObject({ id, status: "passed", merge: "applied", filesTouched: ["b.ts"], ranOn: "qwen3-coder:30b on gpu" });
    expect(readFileSync(join(root, "b.ts"), "utf8")).toBe("export const b = 2;\n");
    // Hints derived from the kind ride on the worker's calls.
    expect(worker.requests[0].hints).toMatchObject({ job: "code_edit", latency: "batch", needsTools: true, sessionId: `tentacle:${id}` });
    // The prompt carried the given file only.
    expect(worker.requests[0].messages.find((m) => m.role === "user")!.content).toContain("export const x = 1;");
    // The transcript note, undoable like a turn.
    const note = hub.snapshot(s.id).session.transcript.find((t) => t.role === "note")!;
    expect(note.content).toMatch(/^Tentacle: Add b\.ts · qwen3-coder:30b on gpu · passed \(applied\) · 1\.0 cSats$/);
    expect(note.changedFiles).toEqual(["b.ts"]);
    hub.undo(s.id, TERM);
    expect(existsSync(join(root, "b.ts"))).toBe(false);
    // The workspace is gone.
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("is isolated: it can't touch the lead's files, and its own edits stay in its worktree until merged", async () => {
    const leadFile = join(root, "a.txt");
    const { tentacles, s } = setup({
      autoApprove: "none",
      script: ({ call }) =>
        call === 0
          ? { tool: ["write_file", { path: leadFile, content: "pwned\n" }] }
          : call === 1
            ? { tool: ["write_file", { path: "../../a.txt", content: "pwned\n" }] }
            : call === 2
              ? { tool: ["edit_file", { path: "a.txt", old_string: "beta", new_string: "BETA" }] }
              : { text: "done" },
    });
    const v = tentacles.delegate(s.id, { task: "Edit a", kind: "code_edit", files: ["a.txt"], instructions: "" });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.status).toBe("passed");
    expect(t.merge?.state).toBe("awaiting_approval");
    expect(readFileSync(leadFile, "utf8")).toBe("alpha\nbeta\ngamma\n");
    expect(t.result!.filesTouched).toEqual(["a.txt"]);
    expect(t.result!.patch).toContain("+BETA");
    // The user approves: applied then.
    tentacles.decide(s.id, v.id, true);
    expect(readFileSync(leadFile, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("read-only tentacles get no workspace and read tools only", async () => {
    const { tentacles, s, worker } = setup({
      script: ({ call }) => (call === 0 ? { tool: ["write_file", { path: "x.txt", content: "no" }] } : { text: "found it in lib.ts:1" }),
    });
    const v = tentacles.delegate(s.id, { task: "Find x", kind: "search", files: [], instructions: "" });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.readOnly).toBe(true);
    expect(t).toMatchObject({ status: "passed", merge: { state: "no_changes" } });
    expect(t.result!.summary).toBe("found it in lib.ts:1");
    expect(existsSync(join(root, "x.txt"))).toBe(false);
    expect(worker.requests[0].tools!.map((x) => x.function.name).sort()).toEqual(["list_directory", "read_file", "search_files"]);
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("escalates once to a stronger tier when the check fails, with the failure in the prompt", async () => {
    const { tentacles, s, worker } = setup({
      script: ({ call, escalated }) =>
        call === 0 ? { tool: ["write_file", { path: "c.ts", content: escalated ? "export const c = 3;\n" : "export const c = 0;\n" }] } : { text: "ok" },
    });
    const v = tentacles.delegate(s.id, { task: "Add c", kind: "code_edit", files: [], instructions: "c = 3", complexity: "low", acceptance: { kind: "grep", args: { pattern: "c = 3", paths: ["c.ts"] } } });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t).toMatchObject({ status: "passed", merge: { state: "applied" } });
    expect(t.result!.attempts).toBe(2);
    const retry = worker.requests.find((r) => r.hints?.quality === "best")!;
    expect(retry.hints).toMatchObject({ complexity: 0.4, quality: "best" });
    expect(retry.messages.find((m) => m.role === "user")!.content).toMatch(/A previous attempt failed[\s\S]*grep/);
    expect(readFileSync(join(root, "c.ts"), "utf8")).toBe("export const c = 3;\n");
  });

  it("reports a failed check (after the retry) to the lead with the patch and errors, applying nothing", async () => {
    const { tentacles, s } = setup({ script: writer("d.ts", "wrong\n") });
    const exec = tentacleExecutor(tentacles, s.id, async () => ({}));
    const { id } = JSON.parse((await exec("delegate", { task: "Add d", kind: "code_edit", instructions: "x", acceptance: { kind: "grep", args: { pattern: "right", paths: ["d.ts"] } } }, { approved: false })).result!);
    const r = JSON.parse((await exec("await_tentacles", { timeoutS: 10 }, { approved: false })).result!);
    expect(r.finished[0]).toMatchObject({ id, status: "failed", merge: "not_applied", attempts: 2 });
    expect(r.finished[0].patch).toContain("+wrong");
    expect(r.finished[0].checks[0]).toMatchObject({ passed: false });
    expect(r.finished[0].note).toMatch(/re-delegate/);
    expect(existsSync(join(root, "d.ts"))).toBe(false);
  });

  it("a passed patch that no longer applies is a conflict for the lead", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { tentacles, s } = setup({
      script: ({ call }) => (call === 0 ? { tool: ["edit_file", { path: "a.txt", old_string: "beta", new_string: "BETA" }] } : { text: "done", wait: gate }),
    });
    const v = tentacles.delegate(s.id, { task: "Edit a", kind: "code_edit", files: ["a.txt"], instructions: "" });
    await until(() => tentacles.get(s.id, v.id)!.progress.startsWith("edit_file"), 5000, "the edit");
    // Meanwhile the lead changes the same line.
    writeFileSync(join(root, "a.txt"), "alpha\nbeta-lead\ngamma\n");
    release();
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.status).toBe("passed");
    expect(t.merge?.state).toBe("conflict");
    expect(describeTentacle(t)).toMatchObject({ merge: "conflict", patch: expect.stringContaining("+BETA") });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("alpha\nbeta-lead\ngamma\n");
  });

  it("starts from the lead's uncommitted state", async () => {
    writeFileSync(join(root, "a.txt"), "alpha\nbeta2\ngamma\n");
    writeFileSync(join(root, "new.txt"), "untracked\n");
    const { tentacles, s } = setup({ script: ({ call }) => (call === 0 ? { tool: ["edit_file", { path: "new.txt", old_string: "untracked", new_string: "edited" }] } : { text: "ok" }) });
    const v = tentacles.delegate(s.id, { task: "Edit new", kind: "code_edit", files: ["new.txt"], instructions: "" });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, v.id)!.merge?.state).toBe("applied");
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("edited\n");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("alpha\nbeta2\ngamma\n");
  });

  it("caps parallel tentacles and queues the rest", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { tentacles, s, worker } = setup({ config: { maxParallel: 2 }, script: ({ task, call }) => (call === 0 ? { tool: ["write_file", { path: `${task}.txt`, content: task }], wait: gate } : { text: "ok" }) });
    // Three pieces (two run, one waits) show the cap; each runs a real git worktree, check and merge,
    // which is several seconds on Windows runners, so this one gets more than the 15 s default.
    const ids = ["p1", "p2", "p3"].map((task) => tentacles.delegate(s.id, { task, kind: "code_edit", files: [], instructions: "" }).id);
    await until(() => worker.requests.length >= 2, 5000, "two running");
    expect(ids.map((i) => tentacles.get(s.id, i)!.status)).toEqual(["running", "running", "queued"]);
    release();
    await tentacles.idle(s.id);
    expect(worker.stats().maxRunning).toBe(2);
    expect(ids.map((i) => tentacles.get(s.id, i)!.merge?.state)).toEqual(["applied", "applied", "applied"]);
  }, 45_000);

  it("stops a tentacle at its budget and refuses new ones when the session's budget is spent", async () => {
    const { tentacles, s } = setup({
      config: { budgetCSats: 5, perTentacleCSats: 3 },
      script: ({ call }) => (call < 10 ? { tool: ["list_directory", { path: "." }], cSats: 2 } : { text: "never" }),
    });
    const a = tentacles.delegate(s.id, { task: "Loop", kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, a.id)!;
    expect(t.status).toBe("error");
    expect(t.result!.error).toMatch(/budget ran out/);
    expect(t.cSats).toBe(4); // two calls, then the guard stops the third
    // 1 cSat left: less than a helper starts with (run 15), so no new helper is taken.
    expect(() => tentacles.delegate(s.id, { task: "Loop2", kind: "code_edit", files: [], instructions: "", budgetCSats: 50 })).toThrow(/budget .*is spent/);
  });

  it("stopping the session cancels its tentacles and removes their workspaces", async () => {
    const never = new Promise<void>(() => undefined);
    const { hub, tentacles, s } = setup({ script: () => ({ text: "x", wait: never }) });
    const v = tentacles.delegate(s.id, { task: "Slow", kind: "code_edit", files: [], instructions: "" });
    const q = tentacles.delegate(s.id, { task: "Slow2", kind: "search", files: [], instructions: "" });
    await until(() => tentacles.get(s.id, v.id)!.status === "running" && tentacles.get(s.id, q.id)!.status === "running", 5000, "running");
    hub.cancel(s.id, TERM);
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, v.id)!.status).toBe("cancelled");
    expect(tentacles.get(s.id, q.id)!.status).toBe("cancelled");
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);
  });

  it("emits tentacle_started / _progress / _finished and a note through the session's events", async () => {
    const { tentacles, s, events } = setup({ script: writer("e.ts", "e\n") });
    tentacles.delegate(s.id, { task: "Add e", kind: "docs", files: [], instructions: "" });
    await tentacles.idle(s.id);
    const types = events.map((e) => e.type);
    expect(types).toContain("tentacle_started");
    expect(types).toContain("tentacle_progress");
    expect(types).toContain("tentacle_finished");
    expect(types).toContain("note");
    expect(types.indexOf("tentacle_started")).toBeLessThan(types.indexOf("tentacle_finished"));
    const fin = events.find((e) => e.type === "tentacle_finished")!.tentacle as { status: string; merge: { state: string } };
    expect(fin).toMatchObject({ status: "passed", merge: { state: "applied" } });
  });
});

describe("cancellation", () => {
  it("cancel_tentacle stops a running one; the abort reaches the worker", async () => {
    const { tentacles, s } = setup({ script: () => ({ tool: ["list_directory", { path: "." }], wait: new Promise<void>((r) => setTimeout(r, 20)) }) });
    const v = tentacles.delegate(s.id, { task: "Spin", kind: "code_edit", files: [], instructions: "" });
    await until(() => tentacles.get(s.id, v.id)!.progress.startsWith("list_directory"), 5000, "working");
    expect(tentacles.cancel(s.id, v.id)).toBe(true);
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, v.id)!.status).toBe("cancelled");
    expect(git("worktree", "list").trim().split("\n")).toHaveLength(1);
  });
});

describe("end to end", () => {
  it("a lead delegates three pieces that run in parallel and merge back", async () => {
    let gateOpen!: () => void;
    const gate = new Promise<void>((r) => (gateOpen = r));
    let arrived = 0;
    const leadReplies: Reply[] = [
      {
        content: "Splitting this into three pieces.",
        toolCalls: ["one", "two", "three"].map((n) => ({ name: "delegate", arguments: { task: `piece-${n}`, kind: "code_edit", files: ["lib.ts"], instructions: `create ${n}.ts`, acceptance: { kind: "grep", args: { pattern: n, paths: [`${n}.ts`] } } } })),
      },
      { content: "", toolCalls: [{ name: "await_tentacles", arguments: { timeoutS: 20 } }] },
      (req) => {
        const last = req.messages.at(-1)!.content;
        const r = JSON.parse(last) as { finished: unknown[]; stillRunning: unknown[] };
        return r.stillRunning.length ? { content: "", toolCalls: [{ name: "await_tentacles", arguments: { timeoutS: 20 } }] } : { content: "All three merged.", toolCalls: [] };
      },
      (req) => {
        const r = JSON.parse(req.messages.at(-1)!.content) as { stillRunning: unknown[] };
        return r.stillRunning.length ? { content: "", toolCalls: [{ name: "await_tentacles", arguments: { timeoutS: 20 } }] } : { content: "All three merged.", toolCalls: [] };
      },
      { content: "All three merged.", toolCalls: [] },
    ];
    const { hub, tentacles, s, worker, lead } = setup({
      leadReplies,
      script: ({ task, call }) => {
        const n = task.replace("piece-", "");
        if (call === 0) {
          arrived++;
          if (arrived === 3) gateOpen();
          // Each waits until all three are running: proves they run in parallel.
          return { tool: ["write_file", { path: `${n}.ts`, content: `export const ${n} = "${n}";\n` }], wait: gate };
        }
        return { text: `wrote ${n}.ts` };
      },
    });
    hub.send(s.id, "build three things", TERM);
    await hub.idle(s.id);
    await tentacles.idle(s.id);
    expect(worker.stats().maxRunning).toBe(3);
    for (const n of ["one", "two", "three"]) expect(readFileSync(join(root, `${n}.ts`), "utf8")).toBe(`export const ${n} = "${n}";\n`);
    const snap = hub.snapshot(s.id);
    expect(snap.session.transcript.filter((t) => t.role === "note")).toHaveLength(3);
    expect(snap.session.transcript.at(-1)!.content).toContain("All three merged.");
    // The lead got the tools and the guidance.
    expect(lead.requests[0].tools!.map((t) => t.function.name)).toContain("delegate");
    expect(lead.requests[0].messages[0].content).toContain("Tentacles (helper agents)");
    // Notes stay out of the lead's context.
    expect(lead.requests.at(-1)!.messages.some((m) => m.content.startsWith("Tentacle:"))).toBe(false);
    expect(snap.session.cSats).toBeGreaterThan(0);
  });
});

const GPU_ORD: ServedBy = { label: "lin-•••3f2a", own: false, computeClass: "gpu", tier: "gpu.dc40", hardware: "Datacenter GPU (gpu.dc40)", gpu: "2× NVIDIA A16", region: "ord", city: "Chicago", country: "US", promptTokens: 1200, outputTokens: 80 };

describe("tentacles with BYOK: helpers never run on a frontier model (1)", () => {
  it("the worker model is the session's worker (or the tentacle setting), never a frontier id", () => {
    expect(tentacleWorkerModel({ workerModel: "network/qwen3-coder:30b@gpu" }, { workerModel: "auto" })).toBe("network/qwen3-coder:30b@gpu");
    expect(tentacleWorkerModel({ workerModel: "auto" }, { workerModel: "network/small:7b" })).toBe("network/small:7b");
    expect(tentacleWorkerModel({ workerModel: "frontier/anthropic/claude-opus-5-5" }, { workerModel: "auto" })).toBe("auto");
    expect(tentacleWorkerModel({ workerModel: "auto" }, { workerModel: "frontier/openai/gpt-x" })).toBe("auto");
  });

  it("refuses a frontier worker in the tentacle settings", () => {
    const { tentacles, s } = setup({ script: () => ({ text: "x" }) });
    expect(() => tentacles.configure(s.id, { workerModel: "frontier/anthropic/claude-opus-5-5" })).toThrow(TentacleError);
    expect(tentacles.config(s.id).workerModel).toBe("auto");
  });

  it("a frontier lead's helpers run on the worker model with the worker role, even when a hook asks for a frontier one", async () => {
    const { tentacles, s, backendCalls, worker } = setup({
      model: "frontier/anthropic/claude-opus-5-5",
      ownerAccount: "acct-owner",
      script: writer("f.ts", "export const f = 1;\n"),
      deps: { workerModelFor: () => "frontier/anthropic/claude-opus-5-5" },
    });
    expect(s.compute.target).toBe("frontier");
    const v = tentacles.delegate(s.id, { task: "Add f", kind: "code_edit", files: [], instructions: "f" });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, v.id)!.status).toBe("passed");
    expect(backendCalls.length).toBeGreaterThan(0);
    for (const c of backendCalls) expect(c).toEqual({ model: "auto", ctx: { role: "worker" } });
    // The helper's requests carry routing hints for the network, nothing that names a frontier model.
    for (const r of worker.requests) expect(JSON.stringify(r)).not.toMatch(/frontier|claude/);
  });

  it("uses the session's network worker model when it has one", async () => {
    const { tentacles, s, backendCalls } = setup({ model: "frontier/anthropic/claude-opus-5-5", workerModel: "network/qwen3-coder:30b@gpu", script: writer("g.ts", "g\n") });
    tentacles.delegate(s.id, { task: "Add g", kind: "code_edit", files: [], instructions: "g" });
    await tentacles.idle(s.id);
    expect(backendCalls.every((c) => c.model === "network/qwen3-coder:30b@gpu")).toBe(true);
  });

  it("stops a helper whose call was answered by a frontier model, without a retry", async () => {
    const { tentacles, s, worker } = setup({
      script: () => ({ text: "done", served: { ...GPU_ORD, computeClass: "frontier", hardware: "Anthropic · your key" } }),
    });
    const v = tentacles.delegate(s.id, { task: "Summarize", kind: "summarize", files: [], instructions: "x" });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.status).toBe("error");
    expect(t.result!.error).toMatch(/frontier model/);
    expect(worker.requests).toHaveLength(1);
  });
});

describe("tentacles and permission modes (3)", () => {
  it("canAutoApply: the lead's own edit rule (mode lets edits apply, no protected path)", () => {
    expect(canAutoApply({ mode: "ask", autoApprove: "none" }, ["a.ts"])).toBe(false);
    expect(canAutoApply({ mode: "auto-edits", autoApprove: "edits" }, ["a.ts"])).toBe(true);
    expect(canAutoApply({ mode: "auto", autoApprove: "edits" }, ["a.ts", ".husky/pre-commit"])).toBe(false);
  });

  it("the helper shell follows the shared classifier and never goes past the session's mode", () => {
    const ask = { mode: "ask" as const, autoApprove: "none" as const, alwaysShell: [] as string[] };
    const allowed = (m: typeof ask) => (probe: string) => sessionAllowsShell(m, probe, root);
    // Read-only: in any mode.
    expect(tentacleShellDecision("cat a.txt", root, allowed(ask)).ok).toBe(true);
    expect(tentacleShellDecision("git diff", root, allowed(ask)).ok).toBe(true);
    // Tests: only when the session would run them without asking.
    expect(tentacleShellDecision("npm test", root, allowed(ask))).toMatchObject({ ok: false, reason: expect.stringMatching(/permission mode/) });
    expect(tentacleShellDecision("npm test", root, allowed({ ...ask, alwaysShell: ["npm"] })).ok).toBe(true);
    expect(tentacleShellDecision("npm test", root, allowed({ ...ask, mode: "auto" })).ok).toBe(true);
    expect(tentacleShellDecision("npx vitest run t.test.ts", root, allowed({ ...ask, mode: "auto" }))).toMatchObject({ ok: true, command: expect.stringContaining("npx --no-install vitest run t.test.ts") });
    // Risky: never, even in mode auto.
    expect(tentacleShellDecision("rm -rf build", root, () => true)).toMatchObject({ ok: false, reason: expect.stringMatching(/risky/) });
    expect(tentacleShellDecision("git push", root, () => true).ok).toBe(false);
    expect(acceptanceProbe({ kind: "vitest", args: ["t.test.ts"] })).toBe("vitest run t.test.ts --maxWorkers=2");
  });

  it("mode ask: a passed patch waits for approval instead of applying", async () => {
    const { tentacles, s } = setup({ mode: "ask", script: writer("h.ts", "h\n") });
    const v = tentacles.delegate(s.id, { task: "Add h", kind: "code_edit", files: [], instructions: "h" });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, v.id)!.merge).toEqual({ state: "awaiting_approval" });
    expect(existsSync(join(root, "h.ts"))).toBe(false);
    tentacles.decide(s.id, v.id, true);
    expect(readFileSync(join(root, "h.ts"), "utf8")).toBe("h\n");
  });

  // PR #600: this timed out at 15 s on windows-latest. It awaited idle() (no polling), but its time was
  // git work, which the manager does synchronously per helper: a workspace for the plain helper, then
  // one for the protected helper, whose only write the executor refuses, so its attempt changed
  // nothing and it ran a second attempt (workspace reset, patch, merge again). One helper in one
  // attempt now covers both: its clean file applies on its own in mode auto-edits, and its protected
  // write is refused and never lands. The merge gate's own rule (a patch with a protected path waits
  // for approval) is canAutoApply, tested above.
  it("mode auto-edits applies a clean patch, but a protected path never lands on its own", async () => {
    const { tentacles, s, worker } = setup({
      mode: "auto-edits",
      script: ({ call }) =>
        call === 0 ? { tool: ["write_file", { path: ".husky/pre-commit", content: "i\n" }] } : call === 1 ? { tool: ["write_file", { path: "i.ts", content: "i\n" }] } : { text: "ok" },
    });
    const v = tentacles.delegate(s.id, { task: "plain and hook", kind: "code_edit", files: [], instructions: "i" });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    // The executor refuses the protected write: a helper never has explicit approval.
    expect(worker.requests[1].messages.find((m) => m.role === "tool")?.content).toMatch(/Refusing to modify \.husky[\\/]pre-commit without explicit approval/);
    // The clean change applies on its own, in one attempt, and nothing protected lands.
    expect(t.result?.attempts).toBe(1);
    expect(t.merge?.state).toBe("applied");
    expect(readFileSync(join(root, "i.ts"), "utf8")).toBe("i\n");
    expect(existsSync(join(root, ".husky/pre-commit"))).toBe(false);
  });

  it("a test check runs only when the session's mode would run it; otherwise the patch comes back unverified and waits", async () => {
    let ran = 0;
    const runCheck = async () => {
      ran++;
      return { kind: "vitest" as const, command: "vitest", passed: true, exitCode: 0, output: "", durationMs: 1 };
    };
    const edits = setup({ mode: "auto-edits", script: writer("j.ts", "j\n"), deps: { runCheck } });
    const v = edits.tentacles.delegate(edits.s.id, { task: "Add j", kind: "code_edit", files: [], instructions: "j", acceptance: { kind: "vitest", args: ["j.test.ts"] } });
    await edits.tentacles.idle(edits.s.id);
    const t = edits.tentacles.get(edits.s.id, v.id)!;
    expect(ran).toBe(0);
    expect(t.result!.unverified).toMatch(/auto-edits/);
    expect(t.merge?.state).toBe("awaiting_approval");
    rmSync(join(root, "j.ts"), { force: true });

    const auto = setup({ mode: "auto", script: writer("k.ts", "k\n"), deps: { runCheck } });
    const w = auto.tentacles.delegate(auto.s.id, { task: "Add k", kind: "code_edit", files: [], instructions: "k", acceptance: { kind: "vitest", args: ["k.test.ts"] } });
    await auto.tentacles.idle(auto.s.id);
    expect(ran).toBe(1);
    expect(auto.tentacles.get(auto.s.id, w.id)!.merge?.state).toBe("applied");
  });

  it("a helper's run_shell in mode ask is refused for anything that would ask", async () => {
    const { tentacles, s, worker } = setup({
      mode: "ask",
      script: ({ call }) => (call === 0 ? { tool: ["run_shell", { command: "npm test" }] } : call === 1 ? { tool: ["write_file", { path: "l.ts", content: "l\n" }] } : { text: "ok" }),
    });
    tentacles.delegate(s.id, { task: "Add l", kind: "code_edit", files: [], instructions: "l" });
    await tentacles.idle(s.id);
    const toolMsg = worker.requests[1].messages.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toMatch(/run_shell rejected: .*permission mode/);
  });
});

describe("tentacles complexity for best-fit routing (6)", () => {
  it("small, simple helpers score low; bigger ones graduate up", () => {
    const small = tentacleComplexity({ kind: "summarize", files: ["a.ts"] }, { promptChars: 800 });
    const big = tentacleComplexity({ kind: "refactor_piece", files: ["a", "b", "c", "d"], acceptance: { kind: "tsc" } }, { promptChars: 30_000 });
    expect(small.level).toBe("low");
    expect(small.score).toBeLessThan(0.2);
    expect(big.score).toBeGreaterThan(0.55);
    expect(tentacleComplexity({ kind: "summarize", files: [] }, { escalate: true }).score).toBeGreaterThan(small.score);
    expect(workerHints({ kind: "summarize", files: ["a.ts"] }, { promptChars: 800 })).toMatchObject({ job: "summarize", complexity: small.score, quality: "fast" });
  });
});

describe("tentacles served lines and totals (5)", () => {
  it("a call without a route line keeps its own host and never takes an earlier call's model (run 6: a 7b label on the cloud host)", async () => {
    const CPU: ServedBy = { ...GPU_ORD, computeClass: "cpu", label: "mac-•••30e5" };
    const CLOUD: ServedBy = { ...GPU_ORD, computeClass: "cloud", label: "lin-•••85de" };
    const { tentacles, s, events } = setup({
      script: ({ call }) =>
        call === 0
          ? { tool: ["write_file", { path: "m.ts", content: "m\n" }], where: "routed to qwen2.5-coder:7b on cpu because fastest", served: CPU }
          : { text: "wrote m", where: "", served: CLOUD },
    });
    const exec = tentacleExecutor(tentacles, s.id, async () => ({}));
    await exec("delegate", { task: "Add m", kind: "code_edit", instructions: "m" }, { approved: false });
    await exec("await_tentacles", { timeoutS: 10 }, { approved: false });
    await until(() => events.some((e) => e.type === "tentacle_totals"));
    const usage = events.filter((e) => e.type === "tentacle_usage");
    expect(usage).toHaveLength(2);
    expect(usage[0].line).toMatch(/^qwen2\.5-coder:7b · network cpu · mac-•••30e5/);
    expect(usage[1].line).not.toContain("qwen2.5-coder:7b");
    expect(usage[1].line).toContain("network cloud · lin-•••85de");
  });

  it("each helper call has its own served line in the session events, the result, the note and the lead's results, with totals", async () => {
    const { tentacles, s, events, hub } = setup({
      script: ({ call }) =>
        call === 0
          ? { tool: ["write_file", { path: "m.ts", content: "m\n" }], served: GPU_ORD, cSats: 1.2, promptTokens: 1200, outputTokens: 80 }
          : { text: "wrote m", served: { ...GPU_ORD, promptTokens: 900, outputTokens: 20 }, cSats: 0.8, promptTokens: 900, outputTokens: 20 },
    });
    const exec = tentacleExecutor(tentacles, s.id, async () => ({}));
    await exec("delegate", { task: "Add m", kind: "code_edit", instructions: "m" }, { approved: false });
    const r = JSON.parse((await exec("await_tentacles", { timeoutS: 10 }, { approved: false })).result!);
    await until(() => events.some((e) => e.type === "tentacle_totals"));
    const usage = events.filter((e) => e.type === "tentacle_usage");
    expect(usage).toHaveLength(2);
    expect(usage[0].line).toBe("qwen3-coder:30b · network gpu · lin-•••3f2a Chicago · 1.2k in / 80 out tok · 1.2 cSats");
    expect(usage[0].call).toMatchObject({ model: "qwen3-coder:30b", place: "network", served: { region: "ord" } });
    expect(r.finished[0].served).toEqual([usage[0].line, usage[1].line]);
    expect(r.totals).toBe("1 helper · 2 calls · qwen3-coder:30b · 2.1k in / 100 out tok · 2.0 cSats · 1/1 patch back");
    expect(r.sessionTotals).toBe(r.totals);
    const totals = events.find((e) => e.type === "tentacle_totals")!;
    expect(totals).toMatchObject({ totals: { helpers: 1, calls: 2, cSats: 2 } });
    const note = hub.snapshot(s.id).session.transcript.find((t) => t.role === "note")!;
    expect(note.usage!.calls).toHaveLength(2);
    expect(note.usage!.calls![0].served).toMatchObject({ city: "Chicago" });
    expect((note.tentacle as { calls: string[] }).calls).toEqual([usage[0].line, usage[1].line]);
  });

  it("run 8: a cloud call after a Mac attempt never takes the Mac's host or class (deepseek · network apple · mac-…)", async () => {
    const MAC: ServedBy = { ...GPU_ORD, computeClass: "apple", label: "mac-•••0e30" };
    const { tentacles, s, events } = setup({
      script: ({ call }) =>
        call === 0
          ? { tool: ["write_file", { path: "m.ts", content: "m\n" }], where: "routed to qwen2.5-coder:7b on apple because fastest", served: MAC }
          : { text: "wrote m", where: "routed to deepseek-v4.1-flash on cloud because best quality" },
    });
    const exec = tentacleExecutor(tentacles, s.id, async () => ({}));
    await exec("delegate", { task: "Add m", kind: "code_edit", instructions: "m" }, { approved: false });
    const r = JSON.parse((await exec("await_tentacles", { timeoutS: 10 }, { approved: false })).result!);
    await until(() => events.some((e) => e.type === "tentacle_totals"));
    const usage = events.filter((e) => e.type === "tentacle_usage");
    expect(usage).toHaveLength(2);
    expect(usage[0].line).toMatch(/^qwen2\.5-coder:7b · network apple · mac-•••0e30/);
    expect(usage[1].line).toMatch(/^deepseek-v4\.1-flash · network cloud/);
    expect(usage[1].line).not.toMatch(/mac-|apple/);
    expect(usage[1].call.served).toBeUndefined();
    expect(JSON.stringify(r.finished[0])).not.toMatch(/deepseek[^"]*mac-/);
  });

  it("a finished helper's 'ran on' uses its latest call's host only", () => {
    const MAC: ServedBy = { ...GPU_ORD, computeClass: "apple", label: "mac-•••0e30" };
    expect(tentacleRanOn({ model: "deepseek-v4.1-flash", class: "cloud", calls: [{ cSats: 1, model: "qwen2.5-coder:7b", served: MAC }, { cSats: 1, model: "deepseek-v4.1-flash" }] })).toBe("deepseek-v4.1-flash on cloud");
  });

  it("formats one call and the totals", () => {
    expect(tentacleCallLine({ cSats: 0, model: "network/small:7b", where: "routed to small:7b on cpu" })).toBe("small:7b · cpu · 0.0 cSats");
    expect(tentacleCallLine({ cSats: 0, model: "network/small:7b", place: "network", where: "routed to small:7b on cpu" })).toBe("small:7b · network cpu · 0.0 cSats");
    expect(tentacleCallLine({ cSats: 0, model: "qwen3.5:9b", place: "local", promptTokens: 2000, outputTokens: 50 })).toBe("qwen3.5:9b · this computer · 2k in / 50 out tok · 0.0 cSats");
    expect(tentacleTotals([]).line).toBe("0 helpers · 0 calls · 0 in / 0 out tok · 0.0 cSats");
  });
});

describe("tentacles and announce-only replies", () => {
  it("a helper that only announces its work gets one go-ahead, like a bot run", async () => {
    const { tentacles, s, worker } = setup({
      script: ({ call }) =>
        call === 0 ? { text: "I'll start by writing n.ts." } : call === 1 ? { tool: ["write_file", { path: "n.ts", content: "n\n" }] } : { text: "Wrote n.ts." },
    });
    const v = tentacles.delegate(s.id, { task: "Add n", kind: "code_edit", files: [], instructions: "n" });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, v.id)!.status).toBe("passed");
    expect(worker.requests.length).toBe(3);
  });
});

const THIS_COMPUTER: ServedBy = { label: "This computer", own: true, computeClass: "local", tier: null, hardware: "This computer", region: null, country: null };

describe("tentacles local first", () => {
  const tools = (m: string) => !/deepseek-r1|embed|tiny/.test(m);
  const ctx = (m: string) => (m.startsWith("short") ? 4_096 : undefined);

  it("picks a tool-capable local model at least the floor big whose window fits, never a frontier id", () => {
    const o = { callsTools: tools, contextTokens: ctx, minParamsB: 7 };
    expect(pickLocalHelperModel(["qwen3.5:9b", "qwen2.5-coder:14b", "deepseek-r1:14b"], { minContext: 8_192 }, o)).toBe("qwen2.5-coder:14b");
    expect(pickLocalHelperModel(["qwen3.5:9b"], { minContext: 8_192 }, o)).toBe("qwen3.5:9b");
    // None capable: too small, no tools, a window that doesn't fit, an embedding model.
    expect(pickLocalHelperModel(["llama3.2:3b", "deepseek-r1:14b", "short-coder:14b", "nomic-embed-text:latest"], { minContext: 8_192 }, o)).toBeNull();
    expect(pickLocalHelperModel([], { minContext: 8_192 }, o)).toBeNull();
    expect(pickLocalHelperModel(["frontier/anthropic/claude-opus-5-5"], { minContext: 8_192 }, { ...o, callsTools: () => true })).toBeNull();
  });

  it("places low pieces on this computer first; the retry, medium and harder pieces and an explicit worker on the worker", () => {
    const base = { workerModel: "auto", level: "low" as const, escalate: false, localFirst: true, localModel: "qwen3.5:9b" as string | null };
    expect(tentaclePlacement(base)).toEqual({ place: "local", model: "qwen3.5:9b" });
    expect(tentaclePlacement({ ...base, localModel: null })).toEqual({ place: "worker", model: "auto" });
    expect(tentaclePlacement({ ...base, escalate: true })).toEqual({ place: "worker", model: "auto" });
    expect(tentaclePlacement({ ...base, level: "medium" })).toEqual({ place: "worker", model: "auto" });
    expect(tentaclePlacement({ ...base, localFirst: false })).toEqual({ place: "worker", model: "auto" });
    expect(tentaclePlacement({ ...base, workerModel: "network/qwen3-coder:30b@gpu" })).toEqual({ place: "worker", model: "network/qwen3-coder:30b@gpu" });
    // Never a frontier model, as the local pick or the worker.
    expect(tentaclePlacement({ ...base, localModel: "frontier/anthropic/claude-opus-5-5" })).toEqual({ place: "worker", model: "auto" });
    expect(tentaclePlacement({ ...base, workerModel: "frontier/anthropic/claude-opus-5-5", localModel: null })).toEqual({ place: "worker", model: "auto" });
  });

  it("is on by default and EDGECODER_TENTACLES_LOCAL=0 turns it off", () => {
    expect(tentacleConfigFromEnv({}).localFirst).toBe(true);
    expect(tentacleConfigFromEnv({ EDGECODER_TENTACLES_LOCAL: "0" }).localFirst).toBe(false);
  });

  function localSetup(o: { local: string | null; localScript: Script; script: Script; model?: string }) {
    const local = fakeWorker(o.localScript);
    const asked: Array<{ minContext: number }> = [];
    const localModels: string[] = [];
    const env = setup({
      script: o.script,
      ...(o.model ? { model: o.model, ownerAccount: "acct-owner" } : {}),
      deps: {
        localModelFor: async (need) => {
          asked.push(need);
          return o.local;
        },
        localBackend: (m) => {
          localModels.push(m);
          return local.backend;
        },
      },
    });
    return { ...env, local, asked, localModels };
  }

  it("runs a low-complexity search on this computer's model, free, and says so in its served line", async () => {
    const { tentacles, s, local, localModels, backendCalls, events, worker } = localSetup({
      local: "qwen3.5:9b",
      localScript: () => ({ text: "found it in lib.ts:1", cSats: 0, where: "", served: THIS_COMPUTER, promptTokens: 900, outputTokens: 30 }),
      script: () => ({ text: "network" }),
    });
    const v = tentacles.delegate(s.id, { task: "Find x", kind: "search", files: [], instructions: "where is x" });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.status).toBe("passed");
    expect(localModels).toEqual(["qwen3.5:9b"]);
    expect(local.requests).toHaveLength(1);
    expect(worker.requests).toHaveLength(0);
    expect(backendCalls).toHaveLength(0);
    expect(t.result).toMatchObject({ place: "local", model: "qwen3.5:9b", class: "this computer", cSats: 0 });
    const usage = events.filter((e) => e.type === "tentacle_usage");
    expect(usage[0].line).toBe("qwen3.5:9b · this computer · 900 in / 30 out tok · 0.0 cSats");
    expect(usage[0].call).toMatchObject({ place: "local" });
  });

  it("goes to the network when no local model can take it", async () => {
    const { tentacles, s, asked, localModels, backendCalls } = localSetup({ local: null, localScript: () => ({ text: "local" }), script: () => ({ text: "found" }) });
    const v = tentacles.delegate(s.id, { task: "Find y", kind: "search", files: [], instructions: "y" });
    await tentacles.idle(s.id);
    expect(asked).toHaveLength(1);
    expect(asked[0].minContext).toBeGreaterThanOrEqual(8_192);
    expect(localModels).toHaveLength(0);
    expect(backendCalls.length).toBeGreaterThan(0);
    expect(backendCalls.every((c) => c.model === "auto")).toBe(true);
    expect(tentacles.get(s.id, v.id)!.result).toMatchObject({ place: "network" });
  });

  it("retries a failed local attempt on the network, one level up", async () => {
    const { tentacles, s, local, worker, events } = localSetup({
      local: "qwen3.5:9b",
      localScript: ({ call }) => (call === 0 ? { tool: ["write_file", { path: "d.md", content: "wrong\n" }], cSats: 0, served: THIS_COMPUTER } : { text: "done", cSats: 0, served: THIS_COMPUTER }),
      script: ({ call }) => (call === 0 ? { tool: ["write_file", { path: "d.md", content: "right\n" }], served: GPU_ORD } : { text: "done", served: GPU_ORD }),
    });
    const v = tentacles.delegate(s.id, { task: "Write d", kind: "docs", files: [], instructions: "d", acceptance: { kind: "grep", args: { pattern: "right", paths: ["d.md"] } } });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t).toMatchObject({ status: "passed", merge: { state: "applied" } });
    expect(t.result).toMatchObject({ attempts: 2, place: "network" });
    expect(local.requests.length).toBeGreaterThan(0);
    expect(worker.requests[0].hints).toMatchObject({ quality: "best" });
    expect(worker.requests[0].messages.find((m) => m.role === "user")!.content).toMatch(/A previous attempt failed/);
    expect(t.result!.calls.map((c) => c.place)).toEqual(["local", "local", "network", "network"]);
    expect(events.some((e) => e.type === "tentacle_progress" && e.progress === "retrying on the network (a stronger tier)")).toBe(true);
    expect(readFileSync(join(root, "d.md"), "utf8")).toBe("right\n");
  });

  it("retries on the network when the local model call fails", async () => {
    const failing: ChatBackend = async function* () {
      throw new Error("ollama is not running");
    };
    const env = setup({
      script: () => ({ text: "found on the network", served: GPU_ORD }),
      deps: { localModelFor: async () => "qwen3.5:9b", localBackend: () => failing },
    });
    const v = env.tentacles.delegate(env.s.id, { task: "Find z", kind: "search", files: [], instructions: "z" });
    await env.tentacles.idle(env.s.id);
    const t = env.tentacles.get(env.s.id, v.id)!;
    expect(t.status).toBe("passed");
    expect(t.result).toMatchObject({ attempts: 2, place: "network", summary: "found on the network" });
    expect(env.worker.requests[0].hints).toMatchObject({ quality: "best" });
  });

  it("sends medium pieces to the network as before, without looking for a local model", async () => {
    const { tentacles, s, asked, localModels } = localSetup({ local: "qwen3.5:9b", localScript: () => ({ text: "local" }), script: writer("e.ts", "e\n") });
    tentacles.delegate(s.id, { task: "Add e", kind: "code_edit", files: [], instructions: "e" });
    await tentacles.idle(s.id);
    expect(asked).toHaveLength(0);
    expect(localModels).toHaveLength(0);
  });

  it("a frontier lead's low helpers run here or on the network, never on the frontier model", async () => {
    const { tentacles, s, localModels, backendCalls, local } = localSetup({
      model: "frontier/anthropic/claude-opus-5-5",
      local: "frontier/anthropic/claude-opus-5-5",
      localScript: () => ({ text: "local" }),
      script: () => ({ text: "found" }),
    });
    tentacles.delegate(s.id, { task: "Find w", kind: "search", files: [], instructions: "w" });
    await tentacles.idle(s.id);
    expect(localModels).toHaveLength(0);
    expect(local.requests).toHaveLength(0);
    expect(backendCalls.length).toBeGreaterThan(0);
    for (const c of backendCalls) expect(c).toEqual({ model: "auto", ctx: { role: "worker" } });
  });

  it("is off when the session's config turns it off", async () => {
    const { tentacles, s, asked } = localSetup({ local: "qwen3.5:9b", localScript: () => ({ text: "local" }), script: () => ({ text: "found" }) });
    tentacles.configure(s.id, { localFirst: false });
    tentacles.delegate(s.id, { task: "Find v", kind: "search", files: [], instructions: "v" });
    await tentacles.idle(s.id);
    expect(asked).toHaveLength(0);
  });
});
