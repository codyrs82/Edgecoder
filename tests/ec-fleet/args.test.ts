// Unit tests for ec-fleet's argument parsing and task preamble (scripts/ec-fleet/args.mjs).
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { DEFAULT_LEAD, UsageError, buildPrompt, parseCli, slugAndBranch } from "../../scripts/ec-fleet/args.mjs";

describe("parseCli", () => {
  it("start: defaults to the owner's frontier lead, auto worker, auto-edits", () => {
    const o = parseCli(["start", "--task", "fix it", "--branch", "ec/fix-fee"]);
    expect(o).toMatchObject({ command: "start", slug: "fix-fee", branch: "ec/fix-fee", task: "fix it", lead: DEFAULT_LEAD, worker: "auto", mode: "auto-edits", base: "origin/main", maxConcurrent: 2, dryRun: false, trailers: [] });
    expect(DEFAULT_LEAD).toBe("frontier/anthropic/claude-opus-5-5");
  });

  it("start: options", () => {
    const o = parseCli(["start", "--task", "t.md", "--branch", "ec/a-1", "--lead", "auto", "--worker", "network/qwen3-coder:30b", "--mode", "auto", "--trailer", "A: b", "--trailer", "C: d", "--max-concurrent", "1", "--dry-run", "--repo", "/r"]);
    expect(o).toMatchObject({ lead: "auto", worker: "network/qwen3-coder:30b", mode: "auto", trailers: ["A: b", "C: d"], maxConcurrent: 1, dryRun: true, repo: "/r" });
  });

  it.each([
    [["start", "--branch", "ec/x"], /--task/],
    [["start", "--task", "x"], /branch/],
    [["start", "--task", "x", "--branch", "feature/x"], /ec\/<slug>|valid slug/],
    [["start", "--task", "x", "--branch", "x"], /ec\/<slug>/],
    [["start", "--task", "x", "--branch", "ec/Bad_Slug"], /valid slug/],
    [["start", "--task", "x", "--branch", "ec/x", "--mode", "yolo"], /--mode/],
    [["start", "--task", "x", "--branch", "ec/x", "--worker", "frontier/anthropic/claude-opus-5-5"], /frontier/],
    [["start", "--task", "x", "--branch", "ec/x", "--max-concurrent", "0"], /max-concurrent/],
    [["start", "--task", "x", "--branch", "ec/x", "--bogus"], /bogus/],
    [["start", "--task", "x", "--branch", "ec/x", "extra"], /positional/],
    [["deploy"], /Unknown command/],
    [["watch"], /needs a slug/],
    [["send", "x"], /notes/],
    [["approve", "x", "--deny"], /--call/],
    [["approve", "x", "--call", "c1", "--all-safe"], /not both/],
    [["watch", "x", "--timeout", "0"], /timeout/],
  ])("%j is a usage error", (argv, msg) => {
    expect(() => parseCli(argv)).toThrow(UsageError);
    expect(() => parseCli(argv)).toThrow(msg);
  });

  it("watch / approve / send / status / stop", () => {
    expect(parseCli(["watch", "fix-fee", "--approve", "--since", "12"])).toMatchObject({ command: "watch", slug: "fix-fee", branch: "ec/fix-fee", approve: true, since: 12, timeoutMin: 60 });
    expect(parseCli(["watch", "ec/fix-fee"])).toMatchObject({ slug: "fix-fee", approve: false, since: undefined });
    expect(parseCli(["approve", "fix-fee", "--all-safe"])).toMatchObject({ allSafe: true, call: undefined, deny: false });
    expect(parseCli(["approve", "fix-fee", "--call", "c1", "--deny"])).toMatchObject({ call: "c1", deny: true });
    expect(parseCli(["send", "fix-fee", "also", "add", "a", "test"])).toMatchObject({ text: "also add a test" });
    expect(parseCli(["status"])).toMatchObject({ command: "status", json: false });
    expect(parseCli(["status", "fix-fee", "--json"])).toMatchObject({ slug: "fix-fee", json: true });
    expect(parseCli(["stop", "fix-fee", "--cleanup"])).toMatchObject({ cleanup: true });
    expect(parseCli([])).toEqual({ command: "help" });
    expect(parseCli(["watch", "--help"])).toEqual({ command: "help" });
  });

  it("slugAndBranch", () => {
    expect(slugAndBranch("ec/x-1")).toEqual({ slug: "x-1", branch: "ec/x-1" });
    expect(() => slugAndBranch("")).toThrow(UsageError);
    expect(() => slugAndBranch("ec/../x")).toThrow(UsageError);
  });
});

describe("buildPrompt", () => {
  const p = buildPrompt({ task: "Fix the fee check.", branch: "ec/fix-fee", worktree: "/r/.claude/worktrees/ec-fix-fee", trailers: ["Co-Authored-By: A <a@b>", "Claude-Session: https://x"] });
  it("carries the repo rules, the branch, the trailers and the task", () => {
    expect(p).toContain("ec/fix-fee");
    expect(p).toContain("/r/.claude/worktrees/ec-fix-fee");
    expect(p).toContain("gh pr create --draft --base main --head ec/fix-fee");
    expect(p).toContain("Never push to main");
    expect(p).toContain(".github/workflows/**");
    expect(p).toContain("--maxWorkers=2");
    expect(p).toContain("    Co-Authored-By: A <a@b>\n    Claude-Session: https://x");
    expect(p.trim().endsWith("Fix the fee check.")).toBe(true);
  });
  it("falls back to a default trailer", () => {
    expect(buildPrompt({ task: "x", branch: "ec/x", worktree: "/w", trailers: [] })).toContain("Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>");
  });
});
