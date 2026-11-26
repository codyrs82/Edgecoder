// Network run 14: helper patches land without the lead's help.
// (a) t482bda9 stopped at the session's budget with its file written; its patch was not merged and
//     the lead applied it by hand. (b) On an account with ~88 cSats, 5 of 8 helpers failed on 402
//     insufficient_credits ("it sets aside up to 25.978 cSats") instead of waiting for the others'
//     reserves. (c) delegate's note was cut off in the terminal before its coverage sentence.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";
import { budgetCoverage, describeTentacle, tentacleExecutor } from "../../src/apps/ide/delegate.js";
import { hostedErrorInfo } from "../../src/apps/ide/hosted-backend.js";
import { SessionHub, type ClientRef } from "../../src/apps/ide/sessions.js";
import { balanceRefusal } from "../../src/apps/ide/tentacle-reserve.js";
import { TentacleManager, type TentacleConfig, type TentacleDeps } from "../../src/apps/ide/tentacles.js";
import { ChatBackendError, type ChatBackend, type ChatPiece, type ChatRequest } from "../../src/inference-api/types.js";

const TERM: ClientRef = { clientId: "term-1", kind: "terminal", label: "Terminal" };
const RUN14_402 = "Not enough cSats for this request (it sets aside up to 25.978 cSats; unused cSats come back).";
let root: string;
let tmp: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t14-proj-"));
  tmp = mkdtempSync(join(tmpdir(), "t14-ws-"));
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

type Step = { tool?: [string, Record<string, unknown>]; text?: string; cSats?: number; err?: Error; waitMs?: number };
type Script = (ctx: { task: string; call: number; req: ChatRequest; heldByOthers: number }) => Step;

function setup(script: Script, config: Partial<TentacleConfig> = {}, deps: Partial<TentacleDeps> = {}) {
  const hub = new SessionHub({ chat: () => async () => ({ content: "", toolCalls: [] }), systemPrompt: async () => "s", checkpoints: new CheckpointStore(), branch: () => "main" } as never, { dir: null, permissionsFile: null });
  const running = new Map<number, number>();
  let n = 0;
  const backend: ChatBackend = async function* (req): AsyncGenerator<ChatPiece> {
    const k = ++n;
    const heldByOthers = [...running.values()].reduce((a, b) => a + b, 0);
    running.set(k, req.hints?.maxCSats ?? 0);
    try {
      const task = /# Task\n(.*)/.exec(req.messages.find((m) => m.role === "user")?.content ?? "")?.[1] ?? "";
      const step = script({ task, call: req.messages.filter((m) => m.role === "assistant").length, req, heldByOthers });
      if (step.err) throw step.err;
      if (step.waitMs) await new Promise((r) => setTimeout(r, step.waitMs));
      if (step.text) yield { delta: step.text };
      if (step.tool) yield { toolCalls: [{ function: { name: step.tool[0], arguments: step.tool[1] } }] };
      yield { done: true, cSatsSpent: step.cSats ?? 0.5 };
    } finally {
      running.delete(k);
    }
  };
  const tentacles = new TentacleManager({
    host: { session: (id) => hub.peek(id), publishEvent: (id, ev) => hub.publishEvent(id, ev), recordNote: (id, note) => hub.recordNote(id, note) },
    workerBackend: () => backend,
    checkpoints: new CheckpointStore(),
    tmpRoot: tmp,
    ...deps,
    config: { enabled: true, maxParallel: 4, budgetCSats: 100, perTentacleCSats: 25, workerModel: "network/deepseek-v4.1-flash", maxContextChars: 20_000, localFirst: false, ...config },
  });
  const s = hub.create({ projectRoot: root, client: TERM, autoApprove: "edits" });
  return { tentacles, s };
}

describe("(a) a helper stopped at its budget with a patch", { timeout: 60_000 }, () => {
  // t482bda9: wrote test/sumArray.test.js, then the session's budget ran out before its summary.
  const sumArray: Script = ({ call }) => (call === 0 ? { tool: ["write_file", { path: "sumArray.test.js", content: "import 'node:test';\n" }], cSats: 6.68 } : { text: "done" });

  it("merges its patch when its check passes, like a finished helper", async () => {
    const { tentacles, s } = setup(sumArray, { budgetCSats: 6.68 });
    const v = tentacles.delegate(s.id, { task: "sumArray tests", kind: "tests", files: [], instructions: "", acceptance: { kind: "grep", args: { pattern: "node:test", paths: ["sumArray.test.js"] } } });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    // Before: "error", merge not_applied, and the lead applied the patch by hand.
    expect(t.status).toBe("passed");
    expect(t.merge?.state).toBe("applied");
    expect(t.result?.partial).toMatch(/budget/);
    expect(readFileSync(join(root, "sumArray.test.js"), "utf8")).toContain("node:test");
    expect(String(describeTentacle(t).note)).toMatch(/Stopped at its budget.*merged.*Don't apply it again/);
  });

  it("offers it for approval when its check fails, never drops it", async () => {
    const { tentacles, s } = setup(sumArray, { budgetCSats: 6.68 });
    const v = tentacles.delegate(s.id, { task: "sumArray tests", kind: "tests", files: [], instructions: "", acceptance: { kind: "grep", args: { pattern: "assert", paths: ["sumArray.test.js"] } } });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.status).toBe("error");
    expect(t.merge?.state).toBe("awaiting_approval");
    expect(String(describeTentacle(t).note)).toMatch(/waiting for the user to approve/);
    tentacles.decide(s.id, v.id, true);
    expect(existsSync(join(root, "sumArray.test.js"))).toBe(true);
  });

  it("with no patch, stops as before", async () => {
    const { tentacles, s } = setup(() => ({ tool: ["list_directory", { path: "." }], cSats: 3 }), { budgetCSats: 5, perTentacleCSats: 5 });
    const v = tentacles.delegate(s.id, { task: "loop", kind: "code_edit", files: [], instructions: "" });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, v.id)!.merge?.state).toBe("not_applied");
  });
});

describe("(b) a balance refusal (402) waits for the other helpers' reserves", { timeout: 60_000 }, () => {
  it("reads the run-14 402 as a balance refusal", () => {
    const info = hostedErrorInfo(undefined, RUN14_402);
    expect(info).toEqual({ code: "insufficient_credits", neededCSats: 25.978 });
    expect(balanceRefusal(new ChatBackendError(RUN14_402, 402, undefined, info))).toEqual({ neededCSats: 25.978 });
    expect(balanceRefusal(new ChatBackendError("x", 402))).toEqual({});
    expect(balanceRefusal(new ChatBackendError("x", 404, undefined, { code: "no_route_fits", reason: "price" }))).toBeNull();
  });

  it("8 helpers on ~88 cSats: all pass, fewer running at once", async () => {
    const BALANCE = 88;
    const { tentacles, s } = setup(({ task, call, req, heldByOthers }) => {
      // The account refuses a reserve its balance can't cover next to the others in flight.
      if (heldByOthers + (req.hints?.maxCSats ?? 0) > BALANCE) return { err: new ChatBackendError(RUN14_402, 402, undefined, { code: "insufficient_credits", neededCSats: 25.978 }) };
      return call === 0 ? { tool: ["list_directory", { path: "." }], waitMs: 30, cSats: 2 } : { text: `found ${task}`, cSats: 1 };
    }, { budgetCSats: 200 });
    // Read-only helpers: no workspace or git work per helper (slow on Windows); the reserves are what matter here.
    const ids = ["add", "sub", "mul", "clamp", "isEven", "reverseStr", "capitalize", "sumArray"].map((f) => tentacles.delegate(s.id, { task: f, kind: "search", files: [], instructions: "" }).id);
    await tentacles.idle(s.id);
    const views = ids.map((id) => tentacles.get(s.id, id)!);
    // Before: 5 of 8 errored with "Not enough cSats for this request".
    expect(views.map((v) => [v.task, v.status, v.result?.error ?? ""])).toEqual(views.map((v) => [v.task, "passed", ""]));
  });

  it("alone, halves the ceiling until the reserve fits; when nothing does, says why", async () => {
    let ok = 0;
    const fits = setup(({ call, req }) => {
      if ((req.hints?.maxCSats ?? 0) > 10) return { err: new ChatBackendError(RUN14_402, 402, undefined, { code: "insufficient_credits" }) };
      ok++;
      return call === 0 ? { tool: ["write_file", { path: "h.txt", content: "x\n" }] } : { text: "ok" };
    });
    const a = fits.tentacles.delegate(fits.s.id, { task: "one", kind: "code_edit", files: [], instructions: "" });
    await fits.tentacles.idle(fits.s.id);
    expect(fits.tentacles.get(fits.s.id, a.id)!.status).toBe("passed");
    expect(ok).toBeGreaterThan(0);

    const broke = setup(() => ({ err: new ChatBackendError(RUN14_402, 402, undefined, { code: "insufficient_credits" }) }));
    const b = broke.tentacles.delegate(broke.s.id, { task: "two", kind: "code_edit", files: [], instructions: "" });
    await broke.tentacles.idle(broke.s.id);
    const t = broke.tentacles.get(broke.s.id, b.id)!;
    expect(t.status).toBe("error");
    expect(t.result?.error).toMatch(/account's balance can't cover one helper call.*add cSats/);
  });
});

describe("(c) delegate's note: the coverage sentence first and short, the balance counted", { timeout: 60_000 }, () => {
  it("budgetCoverage takes the lower of the session's budget left and the balance", () => {
    // Run 14 attempt 1: ~88 cSats balance, 100 session budget, 8 helpers at up to 25 each.
    expect(budgetCoverage({ left: 100, open: 8, perTentacle: 25, balance: 88 })).toMatchObject({ short: "Balance covers ~3 of 8 helpers." });
    expect(budgetCoverage({ left: 100, open: 8, perTentacle: 25, balance: 500 })).toMatchObject({ short: "Budget covers ~4 of 8 helpers." });
    expect(budgetCoverage({ left: 100, open: 2, perTentacle: 25, balance: 500 })).toBeNull();
    // Not even one helper: said up front.
    const none = budgetCoverage({ left: 100, open: 1, perTentacle: 25, balance: 2 })!;
    expect(none.short).toBe("Balance 2.0 cSats: can't run a helper.");
    expect(none.detail).toMatch(/add cSats/);
  });

  it("the note starts with it, within what the terminal shows", async () => {
    // Read-only helpers (no workspace, no git work: this timed out at 15 s on windows-latest with five writing helpers).
    const { tentacles, s } = setup(() => ({ text: "found it", waitMs: 20 }), { maxParallel: 1 }, { balance: async () => 88 });
    const exec = tentacleExecutor(tentacles, s.id, async () => ({ result: "" }));
    const notes: string[] = [];
    for (let i = 0; i < 5; i++) notes.push(JSON.parse((await exec("delegate", { task: `t${i}`, kind: "search", instructions: "x" }, { approved: false })).result!).note);
    await tentacles.idle(s.id);
    expect(notes[0]).toMatch(/^Started; 100 cSats budget left\./);
    expect(notes[4].startsWith("Balance covers ~3 of 5 helpers.")).toBe(true);
    expect("Balance covers ~3 of 5 helpers.".length).toBeLessThanOrEqual(36);
  });
});
