// Network run 17: helper tbe07b4a (reverseStr, st8, session budget 80) ran one call on the GPU 30b
// (1.63 cSats); its next call was refused "No model on the network fits this request: every fitting
// model costs more than the … cSats ceiling" (the cheapest fitting model for its grown prompt cost more
// than was left of its own 25 cSat share), and the helper failed on that per-call error.
// Now: a price refusal grows the helper's budget from the session's (waiting for other helpers to give
// back what they don't spend); only when the session can't cover it does the helper stop, with the
// session's one "budget is spent" message. A "no host right now" refusal is retried like busy.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../../src/apps/ide/checkpoints.js";
import { SessionHub, type ClientRef } from "../../src/apps/ide/sessions.js";
import { busyRefusal } from "../../src/apps/ide/tentacle-reserve.js";
import { TentacleManager, type TentacleConfig } from "../../src/apps/ide/tentacles.js";
import { ChatBackendError, type ChatBackend, type ChatPiece, type ChatRequest } from "../../src/inference-api/types.js";

const TERM: ClientRef = { clientId: "term-1", kind: "terminal", label: "Terminal" };
let root: string;
let tmp: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t17-proj-"));
  tmp = mkdtempSync(join(tmpdir(), "t17-ws-"));
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

type Step = { text?: string; tool?: [string, Record<string, unknown>]; cSats?: number; err?: Error; waitMs?: number };

function setup(script: (ctx: { task: string; call: number; req: ChatRequest }) => Step, config: Partial<TentacleConfig> = {}) {
  const hub = new SessionHub({ chat: () => async () => ({ content: "", toolCalls: [] }), systemPrompt: async () => "s", checkpoints: new CheckpointStore(), branch: () => "main" } as never, { dir: null, permissionsFile: null });
  const ceilings: Record<string, number[]> = {};
  const backend: ChatBackend = async function* (req): AsyncGenerator<ChatPiece> {
    const task = /# Task\n(.*)/.exec(req.messages.find((m) => m.role === "user")?.content ?? "")?.[1] ?? "";
    (ceilings[task] ??= []).push(req.hints?.maxCSats ?? 0);
    const step = script({ task, call: req.messages.filter((m) => m.role === "assistant").length, req });
    if (step.err) throw step.err;
    if (step.waitMs) await new Promise((r) => setTimeout(r, step.waitMs));
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
  return { tentacles, s, ceilings };
}

/** The coordinator's no_route_fits for a price ceiling: the cheapest fitting model costs `need`. */
const priceRefusal = (ceiling: number, need: number) =>
  new ChatBackendError(`No model on the network fits this request: every fitting model costs more than the ${ceiling} cSats ceiling (the cheapest, deepseek-v4.1-flash on cloud, is about ${need} cSats).`, 404, undefined, { code: "no_route_fits", reason: "price", neededCSats: need });

/** tbe07b4a: first call on the GPU 30b (1.63 cSats); from the second, the cheapest fitting model costs 27.7 (its prompt grew). */
const reverseStr = (need = 27.7) => ({ task, call, req }: { task: string; call: number; req: ChatRequest }): Step => {
  if (task !== "reverseStr") return call === 0 ? { tool: ["list_directory", { path: "." }], cSats: 4, waitMs: 150 } : { text: `found ${task}`, cSats: 1 };
  if (call === 0) return { tool: ["list_directory", { path: "." }], cSats: 1.63 };
  const ceiling = req.hints?.maxCSats ?? 0;
  if (ceiling < need) return { err: priceRefusal(ceiling, need) };
  return { text: "found reverseStr", cSats: 6 };
};

describe("run 17: a price refusal widens the helper's ceiling from the session's budget", { timeout: 60_000 }, () => {
  it("tbe07b4a replayed: budget 80, the cheapest fitting model costs more than its share: it grows and passes", async () => {
    const { tentacles, s, ceilings } = setup(reverseStr());
    const ids = ["add", "sub", "reverseStr"].map((f) => tentacles.delegate(s.id, { task: f, kind: "search", files: [], instructions: "" }).id);
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, ids[2])!;
    // Before: error "No model on the network fits this request: every …".
    expect(t.status, t.result?.error).toBe("passed");
    expect(ceilings.reverseStr[1]).toBeLessThan(27.7);
    expect(ceilings.reverseStr.at(-1)).toBeGreaterThanOrEqual(27.7);
  });

  it("with the rest of the session set aside by running helpers, it waits for what they give back", async () => {
    // Budget 50: add and reverseStr hold 25 each; reverseStr grows once add finishes (4 + 1 spent, 20 back).
    const { tentacles, s, ceilings } = setup(reverseStr(), { budgetCSats: 50 });
    const ids = ["add", "reverseStr"].map((f) => tentacles.delegate(s.id, { task: f, kind: "search", files: [], instructions: "" }).id);
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, ids[0])!.status).toBe("passed");
    const t = tentacles.get(s.id, ids[1])!;
    expect(t.status, t.result?.error).toBe("passed");
    expect(ceilings.reverseStr.at(-1)).toBeGreaterThanOrEqual(27.7);
  });

  it("when the session can't cover the cheapest fitting model, it stops with the session's one message", async () => {
    const { tentacles, s } = setup(reverseStr(60), { budgetCSats: 30 });
    const v = tentacles.delegate(s.id, { task: "reverseStr", kind: "search", files: [], instructions: "" });
    await tentacles.idle(s.id);
    const t = tentacles.get(s.id, v.id)!;
    expect(t.status).toBe("error");
    expect(t.result?.error).toMatch(/^The session's tentacle budget is spent \(1\.6 cSats of 30 cSats\) after 0 of 1 helpers; what is left can't cover the cheapest model that fits this helper's call \(about 63 cSats\)\. Raise --tentacle-budget/);
    expect(t.result?.error).not.toMatch(/No model on the network fits/);
  });
});

describe("run 17: a refusal for no host right now is retried like busy", { timeout: 60_000 }, () => {
  it("no_route_fits reason none (#605 leaves out a stale Mac) counts as busy; price does not", () => {
    expect(busyRefusal(new ChatBackendError("No machine on the network can run this job right now (needs a model ≥ 7B with tools; online: …)", 404, undefined, { code: "no_route_fits", reason: "none" }))).toBe(true);
    expect(busyRefusal(new ChatBackendError("No machine on the network can run this job right now (needs …)", 404))).toBe(true);
    expect(busyRefusal(priceRefusal(3, 3.9))).toBe(false);
  });

  it("refused once for no host, then served: the helper passes", async () => {
    let refused = 0;
    const { tentacles, s } = setup(({ call }) => {
      if (refused === 0) {
        refused++;
        return { err: new ChatBackendError("No machine on the network can run this job right now", 404, undefined, { code: "no_route_fits", reason: "none" }) };
      }
      return call === 0 ? { text: "found it" } : { text: "done" };
    });
    const v = tentacles.delegate(s.id, { task: "x", kind: "search", files: [], instructions: "" });
    await tentacles.idle(s.id);
    expect(tentacles.get(s.id, v.id)!.status).toBe("passed");
  });
});
