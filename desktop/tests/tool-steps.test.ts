import { describe, expect, it } from "vitest";
import { applyAgentEvent } from "../src/lib/agent-events";
import { servedLine } from "../src/lib/served";
import { editDiff, failureReason, stepLabel, summarizeSteps, toolStepStatus } from "../src/lib/tool-steps";
import type { ToolEvent } from "../src/lib/types";

const call = (tool: string, args: Record<string, unknown>): ToolEvent => ({ type: "tool_call", tool, args, result: "ok" });

describe("tool steps", () => {
  it("labels each step in plain words", () => {
    expect(stepLabel("read_file", { path: "index.html" })).toEqual({ verb: "Read", target: "index.html" });
    expect(stepLabel("run_shell", { command: "npm test\necho hi" }, false)).toEqual({ verb: "Running", target: "npm test" });
    expect(stepLabel("git_status", {})).toEqual({ verb: "Checked", target: "git status" });
    expect(stepLabel("brand_new_tool", {})).toEqual({ verb: "Brand new tool", target: "" });
  });

  it("summarizes a turn", () => {
    expect(summarizeSteps([
      call("read_file", { path: "a" }), call("read_file", { path: "a" }), call("read_file", { path: "b" }),
      call("edit_file", { path: "a" }), call("run_shell", { command: "ls" }), call("git_status", {}),
      { type: "shell_output", command: "ls" },
    ])).toBe("Read 2 files, edited 1 file, ran 1 command, 1 git step");
    expect(summarizeSteps([])).toBe("No steps");
  });

  it("shows the lines an edit changes", () => {
    expect(editDiff("edit_file", { path: "a", old_string: "a\nb\nc", new_string: "a\nB\nc\nd" })).toEqual([
      { kind: "ctx", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "B" }, { kind: "ctx", text: "c" }, { kind: "add", text: "d" },
    ]);
    expect(editDiff("write_file", { path: "x", content: "one\ntwo\n" })).toEqual([{ kind: "add", text: "one" }, { kind: "add", text: "two" }]);
    expect(editDiff("read_file", { path: "x" })).toBeNull();
    expect(editDiff("edit_file", { path: "x" })).toBeNull();
  });
});

describe("failed steps", () => {
  const err = "GitHub token from your GitHub CLI sign-in (gh) lacks the repo scope (HTTP 403).\nThe token has scopes: read:user.";

  it("a call that returned an error is failed (✗), not completed (✓)", () => {
    expect(toolStepStatus({ error: err })).toBe("failed");
    expect(toolStepStatus({ result: "#12 [open] Fix" })).toBe("completed");
    expect(toolStepStatus({ error: "Tool call run_shell was rejected by the user." })).toBe("rejected");
    expect(toolStepStatus({ approval_status: "rejected" })).toBe("rejected");
    expect(toolStepStatus({ approval_status: "pending" })).toBe("pending");
    expect(toolStepStatus({})).toBe("executing");
  });

  it("labels a failed step as failed, with the reason's first line", () => {
    expect(stepLabel("github_list_prs", {}, true, true)).toEqual({ verb: "Listing failed", target: "" });
    expect(failureReason(err)).toBe("GitHub token from your GitHub CLI sign-in (gh) lacks the repo scope (HTTP 403).");
    expect(failureReason("x".repeat(300)).length).toBe(140);
  });

  it("counts failures in a turn's summary", () => {
    expect(summarizeSteps([
      { type: "tool_call", tool: "github_list_prs", args: {}, error: err },
      call("read_file", { path: "a" }),
    ])).toBe("Read 1 file, 1 git step, 1 failed");
  });
});

describe("reply footer", () => {
  it("names the model for a local Auto run", () => {
    const served = { label: "This computer", own: true, computeClass: "local", tier: null, hardware: "This computer (Apple M5 Max)", region: null, country: null, promptTokens: 6200, outputTokens: 49 };
    let turn = { text: "", toolEvents: [] as ToolEvent[] };
    for (let i = 0; i < 2; i++) turn = applyAgentEvent(turn, { type: "usage", cSats: 0, where: "This computer", model: "qwen3.5:9b", served }).turn as typeof turn;
    expect(servedLine((turn as { usage?: { calls?: never[] } }).usage?.calls)).toBe("qwen3.5:9b · This computer (Apple M5 Max) · read 12.4k tok · wrote 98 tok · 2 calls · free");
  });
});
