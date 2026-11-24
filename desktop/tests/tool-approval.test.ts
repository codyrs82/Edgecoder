import { describe, expect, it } from "vitest";
import { approvalFields, showInvisible } from "../src/lib/tool-approval";
import { askCards } from "../src/lib/bots";

describe("tool approval fields", () => {
  it("keeps a long shell command whole", () => {
    const command = "npm test --silent --reporter=dot --workspaces --if-present    ; rm -rf ~/projects/important-work";
    const [f] = approvalFields("run_shell", { command });
    expect(f).toMatchObject({ key: "command", label: "Command", value: command, block: true });
  });

  it("shows the content a write or edit puts on disk", () => {
    const content = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const fields = approvalFields("write_file", { path: "a.ts", content });
    expect(fields.map((f) => f.key)).toEqual(["path", "content"]);
    expect(fields[1].value).toBe(content);
    expect(fields[1].size).toMatch(/^40 lines/);
    const edit = approvalFields("edit_file", { path: "a.ts", old_string: "x", new_string: "y" });
    expect(edit.map((f) => [f.label, f.value])).toEqual([["File", "a.ts"], ["Replace this", "x"], ["With this", "y"]]);
  });

  it("shows commit, push and pull request arguments, and arguments it does not know", () => {
    expect(approvalFields("git_commit", { message: "m", files: ["a", "b"] }).map((f) => f.key)).toEqual(["message", "files"]);
    expect(approvalFields("git_commit", { message: "m", files: ["a", "b"] })[1].value).toContain('"b"');
    expect(approvalFields("github_create_pr", { title: "t", body: "b", head: "h", base: "main" }).map((f) => f.value)).toEqual(["t", "b", "h", "main"]);
    expect(approvalFields("git_push", { remote: "origin", branch: "main", extra: 1 }).map((f) => f.key)).toEqual(["remote", "branch", "extra"]);
    expect(approvalFields("some_new_tool", { a: "x", b: { c: 1 } }).map((f) => f.key)).toEqual(["a", "b"]);
  });

  it("writes out invisible and direction-changing characters", () => {
    expect(showInvisible("ls‮ txt.exe")).toBe("ls\\u{202E} txt.exe");
    expect(showInvisible("a​b\r\nc\td")).toBe("a\\u{200B}b\nc\td");
    expect(approvalFields("run_shell", { command: "echo hi\u0008\u0008rm -rf ~" })[0].value).toBe("echo hi\\u{0008}\\u{0008}rm -rf ~");
  });
});

describe("bot ask cards", () => {
  it("a waiting card carries the whole call; an answered one does not", () => {
    const args = { path: "x.ts", content: "secret payload" };
    const [waiting] = askCards([{ type: "tool_call", id: "c1", tool: "write_file", args, requires_approval: true }], "Harry");
    expect(waiting.call).toEqual({ tool: "write_file", args });
    const [done] = askCards([{ type: "tool_call", id: "c1", tool: "write_file", args, requires_approval: true, approval_status: "approved" }], "Harry");
    expect(done.call).toBeUndefined();
  });

  it("a waiting card offers Allow for this run with what it covers, never on a web-page guard ask", () => {
    const call = { type: "tool_call", id: "c2", tool: "run_shell", args: { command: "npm test" }, requires_approval: true, allow_session: "npm test commands" };
    expect(askCards([call], "Harry")[0].allowSession).toBe("npm test commands");
    expect(askCards([{ ...call, approval_status: "approved" }], "Harry")[0].allowSession).toBeUndefined();
    const [guarded] = askCards([{ ...call, web_guard: true }], "Harry");
    expect(guarded.webGuard).toBe(true);
    expect(guarded.allowSession).toBeUndefined();
  });
});
