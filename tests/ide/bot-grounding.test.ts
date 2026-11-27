import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotManager, agentBotRunner, botSystemPrompt, runPrompt, DEFAULT_BOT_COMPUTE, type BotConfig } from "../../src/apps/ide/bots.js";
import type { ChatFn } from "../../src/apps/ide/agent-loop.js";
import { GROUNDING_REMINDER, GroundingGuard, SourceIndex, admitsFabrication, dataFigures, ungroundedFigures } from "../../src/apps/ide/bot-grounding.js";

const dir = () => mkdtempSync(join(tmpdir(), "bot-grounding-"));

describe("the grounding rules are in the bit's prompt", () => {
  const bot = { name: "Trader Boy", role: "Stock Trader", instructions: "Daily market notes.", projectRoot: "/tmp/tb", allowedTools: ["read_file", "write_file", "web_search"], compute: DEFAULT_BOT_COMPUTE } as unknown as BotConfig;
  it("system prompt: sourced facts, unknown otherwise, no estimates or placeholders, search before writing", () => {
    const p = botSystemPrompt(bot, "");
    expect(p).toMatch(/must come from a tool result in this run/);
    expect(p).toMatch(/write "unknown"/);
    expect(p).toMatch(/Never estimate, recall figures from your own knowledge or use placeholder numbers/);
    expect(p).toMatch(/Search or run the script first, then write/);
  });
  it("every run prompt nobody typed repeats it", () => {
    for (const t of ["start", "heartbeat", "follow_up", "schedule", "manual"] as const) expect(runPrompt(t).text).toContain(GROUNDING_REMINDER);
  });
});

describe("data-like figures", () => {
  it("finds decimals, percentages, prices and grouped amounts", () => {
    expect(dataFigures("PCE rose 2.6% y/y; core 0.3 m/m. AAPL $412.30, payrolls 215,000, cap $2.5B, yield -4.21").map((f) => f.raw)).toEqual(["2.6%", "0.3", "$412.30", "215,000", "$2.5B", "4.21"]);
  });
  it("ignores counts, line numbers, years, list markers, versions, dates and times", () => {
    expect(dataFigures("1. Fixed 3 tests in src/a.ts:42 (line 17) on 2026-11-27 at 10:30, node v20.1, release 1.2.3, see file2.5.md")).toEqual([]);
  });
});

describe("ungroundedFigures", () => {
  const sources = new SourceIndex();
  sources.add('{"results":[{"snippet":"PCE price index rose 2.437 percent; AAPL closed at $412.3; payrolls +215,000"}]}');
  it("flags figures in no source", () => {
    expect(ungroundedFigures("PCE 2.6%, core 2.8%", sources)).toEqual(["2.6%", "2.8%"]);
  });
  it("ignores figures a source has (also rounded, or formatted differently)", () => {
    expect(ungroundedFigures("PCE 2.44%, AAPL $412.30, payrolls 215,000 (3 sources)", sources)).toEqual([]);
  });
  it("ignores figures the file already had", () => {
    expect(ungroundedFigures("old 7.5%, new 9.1%", sources, "old 7.5%")).toEqual(["9.1%"]);
  });
});

describe("GroundingGuard", () => {
  it("warns about a notes file's unsourced figures, not code, not when sourced, never blocking", () => {
    const g = new GroundingGuard({ checkFigures: true, seed: ["Watch AAPL, target 400.5"] });
    g.before();
    expect(g.after("web_search", { query: "pce" }, "PCE rose 2.3%")).toBe("PCE rose 2.3%");
    g.before();
    expect(g.after("write_file", { path: "notes/today.md", content: "PCE 2.3%, core 2.9%, AAPL target 400.5" }, "Wrote notes/today.md")).toBe("Wrote notes/today.md");
    g.before();
    g.after("write_file", { path: "scripts/watch.py", content: "THRESHOLD = 0.75" }, "ok");
    const w = g.finish();
    expect(w).toEqual([{ message: expect.stringMatching(/^Unverified figures in notes\/today\.md: 2\.9% \(figures not found in any source this run\)/) }]);
  });
  it("is off when the bit had no web or data tool", () => {
    const g = new GroundingGuard({ checkFigures: false });
    g.before();
    g.after("write_file", { path: "a.md", content: "GDP 9.9%" }, "ok");
    g.text("GDP grew 9.9%.");
    expect(g.finish()).toEqual([]);
  });
  it("checks the final reply too", () => {
    const g = new GroundingGuard({ checkFigures: true });
    g.text("Earlier text 1.5%");
    g.before();
    g.after("web_search", { query: "x" }, "rate 4.25");
    g.text("Rate is 4.25 and inflation 3.7%.");
    expect(g.finish()).toEqual([{ message: expect.stringContaining("Unverified figures in the reply: 3.7%") }]);
  });

  describe("self-admitted fabrication", () => {
    const ADMIT = "I made up some of the PCE figures in that snapshot — I shouldn't do that. Let me search for the actual news before finalizing.";
    it("recognises admissions, not denials", () => {
      expect(admitsFabrication(ADMIT)).toBe(true);
      expect(admitsFabrication("Those numbers were placeholders.")).toBe(true);
      expect(admitsFabrication("I didn't make up anything; every figure is cited.")).toBe(false);
      expect(admitsFabrication("I made the update to notes.md.")).toBe(false);
    });
    it("nudges once to correct the file; left as it was, the run needs review", () => {
      const g = new GroundingGuard({ checkFigures: true });
      g.before();
      g.after("write_file", { path: "snapshot.md", content: "PCE 2.6%" }, "ok");
      g.text(ADMIT);
      g.before();
      expect(g.after("web_search", { query: "pce october" }, "PCE 2.3%")).toMatch(/\[Note\]: You said you made something up\. Before you finish, correct snapshot\.md/);
      g.before();
      expect(g.after("read_file", { path: "x" }, "y")).toBe("y");
      g.text("Done.");
      const w = g.finish();
      expect(w).toEqual([{ review: true, message: expect.stringContaining("didn't correct snapshot.md") }]);
    });
    it("corrected in the same run: no review", () => {
      const g = new GroundingGuard({ checkFigures: true });
      g.before();
      g.after("write_file", { path: "snapshot.md", content: "PCE 2.6%" }, "ok");
      g.text(ADMIT);
      g.before();
      g.after("web_search", { query: "pce" }, "PCE 2.3%");
      g.before();
      g.after("write_file", { path: "snapshot.md", content: "PCE 2.3%" }, "ok");
      expect(g.finish()).toEqual([]);
    });
  });
});

describe("a bit's run: grounding warnings in the run log", () => {
  let managers: BotManager[] = [];
  afterEach(async () => {
    for (const m of managers) await m.shutdown();
    managers = [];
  });

  function setup(correct: boolean) {
    const requests: string[] = [];
    const steps: Array<Awaited<ReturnType<ChatFn>>> = [
      { content: "", toolCalls: [{ name: "write_file", arguments: { path: "snapshot.md", content: "PCE rose 2.6% in October." } }] },
      { content: "I made up some of the PCE figures in that snapshot. Let me read the data first.", toolCalls: [{ name: "read_file", arguments: { path: "data.txt" } }] },
      ...(correct ? [{ content: "", toolCalls: [{ name: "write_file", arguments: { path: "snapshot.md", content: "PCE rose 2.3% in October." } }] }] : []),
      { content: "Wrote the snapshot.", toolCalls: [] },
    ];
    const runner = agentBotRunner({
      chat: () => async (req, onDelta) => {
        requests.push(req.messages.map((m) => m.content).join("\n"));
        const r = steps.shift() ?? { content: "done", toolCalls: [] };
        if (r.content) onDelta?.(r.content);
        return r;
      },
      execute: () => async (tool) => ({ result: tool === "read_file" ? "PCE 2.3% (BEA, October)" : "ok" }),
      systemPrompt: async () => () => "BASE",
    });
    const m = new BotManager({ runner, file: join(dir(), "bots.json") });
    managers.push(m);
    const root = dir();
    writeFileSync(join(root, "data.txt"), "PCE 2.3%");
    const bot = m.create({ name: "Trader Boy", projectRoot: root, allowedTools: ["read_file", "write_file", "web_search"], mode: "auto" });
    return { m, id: bot.id, requests };
  }

  it("left uncorrected: the run is marked for review and the log says so", async () => {
    const s = setup(false);
    s.m.runNow(s.id);
    await s.m.idle(s.id);
    const [run] = s.m.history(s.id);
    expect(run.status).toBe("done");
    expect(run.needsReview).toBe(true);
    expect(run.note).toMatch(/^Needs review: .*snapshot\.md/);
    expect(run.summary).toBe("Wrote the snapshot.");
    expect(s.m.messages(s.id).at(-1)!.content).toMatch(/_Needs review: the bit said it made something up and didn't correct snapshot\.md in this run\._$/);
    // The bit was told to correct it in the run.
    expect(s.requests.some((r) => r.includes("correct snapshot.md in this run"))).toBe(true);
  });

  it("corrected in the run from a source: nothing to flag", async () => {
    const s = setup(true);
    s.m.runNow(s.id);
    await s.m.idle(s.id);
    const [run] = s.m.history(s.id);
    expect(run.needsReview).toBeUndefined();
    expect(run.warnings).toBeUndefined();
  });
});
