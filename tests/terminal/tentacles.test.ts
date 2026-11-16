// The terminal's tentacle view: flags, one line per event, the /tentacles tree.
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/apps/ide/sessions.js";
import type { TentacleView } from "../../src/apps/ide/tentacles.js";
import { initialModel, parseCodeArgs, tentacleConfigFromArgs } from "../../src/terminal/cli.js";
import { makeStyle } from "../../src/terminal/render.js";
import { TentacleTracker } from "../../src/terminal/tentacles.js";

const view = (over: Partial<TentacleView> = {}): TentacleView => ({ id: "t1234567", sessionId: "s", task: "Write tests for x", kind: "tests", readOnly: false, status: "queued", progress: "queued", createdAt: 1, cSats: 0, ...over });
const ev = (type: string, rest: Record<string, unknown>): SessionEvent => ({ seq: 1, at: 1, type, ...rest });

describe("edgecoder code --lead / --worker / --tentacles", () => {
  it("parses the flags into a session model, worker and tentacle settings", () => {
    const a = parseCodeArgs(["--lead", "network/big:70b@gpu", "--worker", "auto", "--tentacles", "4", "--tentacle-budget", "50"]);
    expect(a).toMatchObject({ lead: "network/big:70b@gpu", worker: "auto", tentacles: 4, tentacleBudget: 50 });
    expect(initialModel(a as never)).toBe("network/big:70b@gpu");
    // --worker is the session's worker model (helpers run on it); the tentacle settings don't carry it.
    expect(tentacleConfigFromArgs(a as never)).toEqual({ enabled: true, maxParallel: 4, budgetCSats: 50 });
    expect(parseCodeArgs(["--worker", "frontier/anthropic/claude-opus-5-5"])).toEqual({ error: expect.stringContaining("frontier") });
    expect(tentacleConfigFromArgs({ tentacles: 0 })).toEqual({ enabled: false });
    expect(tentacleConfigFromArgs({})).toBeNull();
    expect(parseCodeArgs(["--tentacles", "99"])).toEqual({ error: expect.stringContaining("--tentacles") });
    expect(parseCodeArgs(["--lead", "a", "--model", "b"])).toEqual({ error: expect.stringContaining("--lead") });
  });
});

describe("TentacleTracker", () => {
  it("prints a line as each starts, runs and finishes, and keeps the tree", () => {
    const tr = new TentacleTracker(makeStyle(false));
    expect(tr.onEvent(ev("tentacle_started", { tentacle: view() }))).toContain("tentacle t1234567: Write tests for x (tests)");
    expect(tr.onEvent(ev("tentacle_progress", { id: "t1234567", status: "running", progress: "starting", cSats: 0, model: "auto" }))).toContain("running on auto");
    expect(tr.onEvent(ev("tentacle_progress", { id: "t1234567", status: "running", progress: "edit_file x.test.ts", cSats: 0.4 }))).toBeNull();
    expect(tr.tree()).toContain("└ t1234567 running · Write tests for x · auto · 0.400 cSats · edit_file x.test.ts");
    const done = view({ status: "passed", cSats: 1.2, merge: { state: "awaiting_approval" }, result: { status: "passed", patch: "", summary: "", filesTouched: [], checks: [], model: "qwen3-coder:30b", class: "gpu", agentLabel: "", tokens: { prompt: 0, output: 0 }, cSats: 1.2, durationMs: 1, attempts: 1, calls: [] } });
    const l = tr.onEvent(ev("tentacle_finished", { tentacle: done }))!;
    expect(l).toContain("t1234567 passed · waiting for approval · Write tests for x · qwen3-coder:30b on gpu · 1.2 cSats");
    expect(l).toContain("/tentacles apply t1234567");
  });

  it("prints each helper call's served line and the merged totals (5)", () => {
    const tr = new TentacleTracker(makeStyle(false));
    tr.onEvent(ev("tentacle_started", { tentacle: view() }));
    const served = { label: "lin-•••3f2a", own: false, computeClass: "gpu", tier: "gpu.dc40", hardware: "Datacenter GPU", region: "ord", city: "Chicago", country: "US" };
    const call = { cSats: 1.2, model: "qwen3-coder:30b", served, promptTokens: 1200, outputTokens: 80 };
    // The provider's line wins; without one the tracker formats the call itself.
    expect(tr.onEvent(ev("tentacle_usage", { id: "t1234567", call, cSats: 1.2 }))).toBe("    ↳ t1234567 · qwen3-coder:30b · gpu · lin-•••3f2a Chicago · 1.2k in / 80 out tok · 1.2 cSats");
    expect(tr.onEvent(ev("tentacle_usage", { id: "t1234567", call, line: "LINE", cSats: 2.4 }))).toBe("    ↳ t1234567 · LINE");
    const tree = tr.tree();
    expect(tree).toContain("↳ qwen3-coder:30b · gpu · lin-•••3f2a Chicago · 1.2k in / 80 out tok · 1.2 cSats");
    expect(tree).toContain("total: 1 helper · 2 calls · qwen3-coder:30b · 2.4k in / 160 out tok · 2.4 cSats");
    expect(tr.onEvent(ev("tentacle_totals", { totals: { line: "1 helper · 2 calls" }, session: { line: "3 helpers · 5 calls" } }))).toBe("  ⟡ helpers merged: 1 helper · 2 calls (session: 3 helpers · 5 calls)");
  });
});
