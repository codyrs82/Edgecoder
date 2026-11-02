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
