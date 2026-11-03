import { describe, expect, it } from "vitest";
import { applyAgentEvent, markApproval, type AgentTurn } from "../src/lib/agent-events";
import { detectLanguage, joinPath, parentDir } from "../src/lib/editor-store";

const empty: AgentTurn = { text: "", toolEvents: [] };

describe("applyAgentEvent", () => {
  it("accumulates text and pairs tool results with their calls", () => {
    let t = applyAgentEvent(empty, { type: "text", content: "Reading " }).turn;
    t = applyAgentEvent(t, { type: "tool_call", id: "1", tool: "read_file", args: { path: "a.ts" }, requires_approval: false }).turn;
    const r = applyAgentEvent(t, { type: "tool_result", id: "1", result: "x" });
    expect(r.turn.text).toBe("Reading ");
    expect(r.turn.toolEvents).toHaveLength(1);
    expect(r.turn.toolEvents[0]).toMatchObject({ tool: "read_file", result: "x", approval_status: "approved" });
    expect(r.filesChanged).toBe(false);
  });

  it("reports changed files only when a write tool succeeds", () => {
    const call = applyAgentEvent(empty, { type: "tool_call", id: "w", tool: "write_file", args: {}, requires_approval: true }).turn;
    expect(call.toolEvents[0].approval_status).toBe("pending");
    expect(applyAgentEvent(call, { type: "tool_result", id: "w", result: "ok" }).filesChanged).toBe(true);
    expect(applyAgentEvent(call, { type: "tool_result", id: "w", error: "rejected" }).filesChanged).toBe(false);
  });

  it("ignores results for unknown calls and leaves the turn untouched for status events", () => {
    expect(applyAgentEvent(empty, { type: "tool_result", id: "nope" }).turn).toBe(empty);
    expect(applyAgentEvent(empty, { type: "status", message: "thinking" }).turn).toBe(empty);
  });

  it("records the turn id and each file the turn wrote, once", () => {
    let t = applyAgentEvent(empty, { type: "turn", id: "turn-1" }).turn;
    const a = applyAgentEvent(t, { type: "file_change", turnId: "turn-1", path: "src/a.ts" });
    expect(a.filesChanged).toBe(true);
    t = applyAgentEvent(a.turn, { type: "file_change", turnId: "turn-1", path: "src/a.ts" }).turn;
    t = applyAgentEvent(t, { type: "file_change", turnId: "turn-1", path: "b.md" }).turn;
    expect(t.turnId).toBe("turn-1");
    expect(t.changedFiles).toEqual(["src/a.ts", "b.md"]);
  });

  it("treats shell output as a possible file change", () => {
    expect(applyAgentEvent(empty, { type: "shell_output", id: "s", stdout: "", stderr: "", exit_code: 0 }).filesChanged).toBe(true);
  });

  it("marks approvals", () => {
    const t = applyAgentEvent(empty, { type: "tool_call", id: "s", tool: "run_shell", args: {}, requires_approval: true }).turn;
    expect(markApproval(t.toolEvents, "s", false)[0].approval_status).toBe("rejected");
  });
});

describe("editor-store paths", () => {
  it("detects languages by extension and well-known names", () => {
    expect(detectLanguage("src/App.tsx")).toBe("typescript");
    expect(detectLanguage("Dockerfile")).toBe("dockerfile");
    expect(detectLanguage("deploy/Dockerfile.agent")).toBe("dockerfile");
    expect(detectLanguage("fly.toml")).toBe("ini");
    expect(detectLanguage("LICENSE")).toBe("plaintext");
  });

  it("joins and splits project-relative paths", () => {
    expect(joinPath("", "a.ts")).toBe("a.ts");
    expect(joinPath("src/lib", "a.ts")).toBe("src/lib/a.ts");
    expect(parentDir("src/lib/a.ts")).toBe("src/lib");
    expect(parentDir("a.ts")).toBe("");
  });
});

describe("reply usage", () => {
  it("adds up cost across a turn's model calls and keeps where Auto ran", async () => {
    const { applyAgentEvent } = await import("../src/lib/agent-events");
    let turn = { text: "", toolEvents: [] } as Parameters<typeof applyAgentEvent>[0];
    turn = applyAgentEvent(turn, { type: "status", message: "Auto: network gpu (0.043 cSats/s, cheapest for this job) · qwen2.5-coder:14b" }).turn;
    turn = applyAgentEvent(turn, { type: "usage", cSats: 0.25, where: "network gpu · qwen2.5-coder:14b" }).turn;
    turn = applyAgentEvent(turn, { type: "usage", cSats: 0.125 }).turn;
    expect(turn.usage).toEqual({ cSats: 0.375, where: "network gpu · qwen2.5-coder:14b" });
    expect(applyAgentEvent(turn, { type: "status", message: "Thinking" }).turn.usage).toEqual(turn.usage);
  });
});
