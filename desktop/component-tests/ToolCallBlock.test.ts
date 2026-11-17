import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/svelte";
import ToolCallBlock from "../src/components/ToolCallBlock.svelte";

afterEach(cleanup);

const longCommand = "npm test --silent --reporter=dot --workspaces --if-present    ; rm -rf ~/projects/important-work";

describe("ToolCallBlock approval", () => {
  it("shows the full command before Allow, not a shortened one", () => {
    render(ToolCallBlock, { id: "c1", tool: "run_shell", args: { command: longCommand }, requiresApproval: true, status: "pending", onApprove: vi.fn(), onReject: vi.fn() });
    const details = screen.getByTestId("approval-details");
    expect(details.textContent).toContain(longCommand);
    expect(document.body.textContent).not.toContain("...");
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
  });

  it("shows the content a file write will put on disk", () => {
    const content = "export const x = 1;\n".repeat(50);
    render(ToolCallBlock, { id: "c2", tool: "write_file", args: { path: "src/x.ts", content }, requiresApproval: true, status: "pending" });
    const pre = screen.getByTestId("approval-details").querySelector("pre")!;
    expect(pre.textContent).toBe(content);
    expect(screen.getByTestId("approval-details").textContent).toContain("src/x.ts");
  });

  it("shows commit arguments that the one-line summary never had", () => {
    render(ToolCallBlock, { id: "c3", tool: "git_commit", args: { message: "Fix bug", files: ["a.ts", "b.ts"] }, requiresApproval: true, status: "pending" });
    const text = screen.getByTestId("approval-details").textContent!;
    expect(text).toContain("Fix bug");
    expect(text).toContain("b.ts");
  });

  it("does not show the approval details once the call is decided", () => {
    render(ToolCallBlock, { id: "c4", tool: "run_shell", args: { command: "ls" }, requiresApproval: true, status: "completed", result: "ok" });
    expect(screen.queryByTestId("approval-details")).toBeNull();
  });

  it("offers Always allow for the call's rule, and answers with it", async () => {
    const onAlways = vi.fn();
    const onApprove = vi.fn();
    render(ToolCallBlock, { id: "c5", tool: "run_shell", args: { command: "npm test src/swarm/worker-runner.ts" }, requiresApproval: true, status: "pending", onApprove, onReject: vi.fn(), allowRule: "npm test:*", onAlways });
    const always = screen.getByRole("button", { name: /Always allow npm test … in this project/ });
    await fireEvent.click(always);
    expect(onAlways).toHaveBeenCalledWith("c5");
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("has no Always allow when the call offers no rule (a command that must always ask)", () => {
    render(ToolCallBlock, { id: "c6", tool: "run_shell", args: { command: "git push" }, requiresApproval: true, status: "pending", onApprove: vi.fn(), onReject: vi.fn(), onAlways: vi.fn() });
    expect(screen.queryByRole("button", { name: /Always allow/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });
});
