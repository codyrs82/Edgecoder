import { describe, expect, it } from "vitest";
import { editDiff, stepLabel, summarizeSteps } from "../src/lib/tool-steps";
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
