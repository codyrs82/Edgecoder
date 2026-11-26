// Network run 19 (st6, session budget 80): 6/8 merged.
// - isEven (t84c8ad9): both attempts ended in a repetition stop on qwen2.5-coder:7b on a new Mac; the
//   lead re-delegated it, and that helper found the session's budget spent.
// - sumArray (tb2c8d2a): its 7B attempts printed the test instead of writing the file; the check failed.
// Now a helper's retry moves up to a ≥14B model (and takes room from the session for it), a repetition
// stop counts as a reason to move up, and a re-delegated piece spends what is left of one helper's budget.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";
import { SessionHub, type ClientRef } from "../../src/apps/ide/sessions.js";
import { isDegenerateStop, TENTACLE_RETRY_MIN_PARAMS_B } from "../../src/apps/ide/tentacle-chat.js";
import { TentacleManager, type TentacleConfig } from "../../src/apps/ide/tentacles.js";
import { ChatBackendError, type ChatBackend, type ChatPiece, type ChatRequest } from "../../src/inference-api/types.js";

const TERM: ClientRef = { clientId: "term-1", kind: "terminal", label: "Terminal" };
const REPEAT = "The machine running qwen2.5-coder:7b reported: degenerate_output (repeated_ngram): token-repeat limit";
let root: string;
let tmp: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t19-proj-"));
  tmp = mkdtempSync(join(tmpdir(), "t19-ws-"));
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

type Step = { text?: string; tool?: [string, Record<string, unknown>]; cSats?: number; err?: Error };
/** `big`: the call asked for a ≥14B model (the retry's floor); small: the 7B floor (the new Mac's qwen2.5-coder:7b). */
type Script = (ctx: { task: string; call: number; big: boolean; req: ChatRequest }) => Step;

function setup(script: Script, config: Partial<TentacleConfig> = {}) {
  const hub = new SessionHub({ chat: () => async () => ({ content: "", toolCalls: [] }), systemPrompt: async () => "s", checkpoints: new CheckpointStore(), branch: () => "main" } as never, { dir: null, permissionsFile: null });
  const floors: Record<string, number[]> = {};
  const backend: ChatBackend = async function* (req): AsyncGenerator<ChatPiece> {
    const task = /# Task\n(.*)/.exec(req.messages.find((m) => m.role === "user")?.content ?? "")?.[1] ?? "";
    const floor = req.hints?.minParamsB ?? 0;
    (floors[task] ??= []).push(floor);
    const step = script({ task, call: req.messages.filter((m) => m.role === "assistant").length, big: floor >= TENTACLE_RETRY_MIN_PARAMS_B, req });
    if (step.err) throw step.err;
    if (step.text) yield { delta: step.text };
    if (step.tool) yield { toolCalls: [{ function: { name: step.tool[0], arguments: step.tool[1] } }] };
    yield { done: true, cSatsSpent: step.cSats ?? 0.5 };
  };
  const tentacles = new TentacleManager({
    host: { session: (id) => hub.peek(id), publishEvent: (id, ev) => hub.publishEvent(id, ev), recordNote: (id, note) => hub.recordNote(id, note) },
    workerBackend: () => backend,
    checkpoints: new CheckpointStore(),
    tmpRoot: tmp,
    config: { enabled: true, maxParallel: 4, budgetCSats: 80, perTentacleCSats: 25, workerModel: "auto", maxContextChars: 20_000, localFirst: false, ...config },
  });
  const s = hub.create({ projectRoot: root, client: TERM, autoApprove: "edits" });
  return { tentacles, s, floors };
}

const grepCheck = (file: string) => ({ kind: "grep" as const, args: { pattern: "node:test", paths: [file] } });

describe("run 19: a failed attempt retries on a stronger model", { timeout: 60_000 }, () => {
  it("recognises a repetition stop", () => {
    expect(isDegenerateStop(REPEAT)).toBe(true);
    expect(isDegenerateStop("The machine running x reported: empty_reply")).toBe(false);
  });

  it("sumArray (tb2c8d2a): the 7B prints the test instead of writing it; the retry runs on ≥14B and writes it", async () => {
    const { tentacles, s, floors } = setup(({ call, big }) =>
      !big
        ? call === 0 ? { text: "Here is the test:\n```js\nimport test from 'node:test';\n```", cSats: 0.2 } : { text: "done" }
        : call === 0 ? { tool: ["write_file", { path: "sumArray.test.js", content: "import test from 'node:test';\n" }], cSats: 2 } : { text: "wrote it", cSats: 1 },
    );
    const v = tentacles.delegate(s.id, { task: "sumArray", kind: "tests", files: [], instructions: "", acceptance: grepCheck("sumArray.test.js") });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.status, t.result?.error).toBe("passed");
    expect(t.merge?.state).toBe("applied");
    expect(readFileSync(join(root, "sumArray.test.js"), "utf8")).toContain("node:test");
    expect(floors.sumArray[0]).toBe(7);
    expect(floors.sumArray.at(-1)).toBe(TENTACLE_RETRY_MIN_PARAMS_B);
  });

  it("isEven (t84c8ad9): a repetition stop on the 7B; the retry moves up a size, not to another 7B", async () => {
    const { tentacles, s, floors } = setup(({ call, big }) =>
      !big ? { err: new ChatBackendError(REPEAT, 502) } : call === 0 ? { tool: ["write_file", { path: "isEven.test.js", content: "import test from 'node:test';\n" }] } : { text: "ok" },
    );
    const v = tentacles.delegate(s.id, { task: "isEven", kind: "tests", files: [], instructions: "", acceptance: grepCheck("isEven.test.js") });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.status, t.result?.error).toBe("passed");
    expect(floors.isEven.filter((f) => f >= TENTACLE_RETRY_MIN_PARAMS_B).length).toBeGreaterThan(0);
  });

  it("the retry takes room from the session when the helper's own budget is spent", async () => {
    // The first attempt spends all of a 5 cSat share; the session has 80.
    const { tentacles, s } = setup(({ call, big }) =>
      !big ? (call === 0 ? { text: "printed it", cSats: 5 } : { text: "x" }) : call === 0 ? { tool: ["write_file", { path: "c.test.js", content: "node:test\n" }], cSats: 1 } : { text: "ok", cSats: 0.5 },
    );
    const v = tentacles.delegate(s.id, { task: "c", kind: "tests", files: [], instructions: "", acceptance: grepCheck("c.test.js"), budgetCSats: 5 });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.status, t.result?.error).toBe("passed");
    expect(t.cSats).toBeGreaterThan(5);
  });

  it("with nothing left in the session, it says the retry had no budget", async () => {
    const { tentacles, s } = setup(({ call }) => (call === 0 ? { text: "printed it", cSats: 5 } : { text: "x" }), { budgetCSats: 5 });
    const v = tentacles.delegate(s.id, { task: "d", kind: "tests", files: [], instructions: "", acceptance: grepCheck("d.test.js") });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, v.id)!.result?.error).toMatch(/No budget was left in the session to retry it on a stronger model/);
  });
});

describe("run 19: a re-delegation spends what is left of one helper's budget for the piece", { timeout: 60_000 }, () => {
  it("the second helper for the same files gets the rest of the first's budget, and a third is refused", async () => {
    // Every attempt fails its check and spends 9 (two attempts: 18 of 25).
    const { tentacles, s } = setup(({ call }) => (call === 0 ? { text: "printed it", cSats: 9 } : { text: "x" }));
    const spec = { task: "Write node:test unit tests for src/isEven.js", kind: "tests" as const, files: ["src/isEven.js"], instructions: "", acceptance: grepCheck("test/isEven.test.js") };
    const a = tentacles.delegate(s.id, spec);
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, a.id)!.cSats).toBe(18);
    const b = tentacles.delegate(s.id, { ...spec, instructions: "tighter" });
    await tentacles.idle(s.id);
    // Its budget was 25 - 18 = 7, not a fresh 25 of the session's: one call (9), and no retry past the piece's 25.
    expect(tentacles.get(s.id, b.id)!.cSats).toBe(9);
    expect(tentacles.get(s.id, b.id)!.result?.error).toMatch(/No budget was left/);
    expect(() => tentacles.delegate(s.id, spec)).toThrow(/This piece already spent .* of its 25 cSats helper budget/);
    // Another piece still gets its own full share.
    const c = tentacles.delegate(s.id, { ...spec, files: ["src/sub.js"], task: "sub" });
    expect(c.id).toBeTruthy();
    await tentacles.idle(s.id);
  });
});
