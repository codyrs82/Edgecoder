import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";

const DESK = { clientId: "desk-me", kind: "desktop", label: "EdgeCoder app" };
const TERM = { clientId: "term-1", kind: "terminal", label: "Terminal on mbp" };
const api = vi.hoisted(() => ({
  DESKTOP_CLIENT: { clientId: "desk-me", kind: "desktop", label: "EdgeCoder app" },
  getSession: vi.fn(),
  followSession: vi.fn(),
  sessionSend: vi.fn(async () => ({ turnId: "t2" })),
  sessionApprove: vi.fn(async () => ({ ok: true })),
  sessionTakeControl: vi.fn(async () => ({})),
  sessionCancel: vi.fn(async () => ({})),
  fsFind: vi.fn(async () => []),
  checkpointChanges: vi.fn(async () => ({ changes: [] })),
}));
vi.mock("../src/lib/api", () => api);

import LiveSessionPanel from "../src/components/LiveSessionPanel.svelte";

let emit: (e: Record<string, unknown>) => void = () => undefined;

beforeEach(() => {
  api.getSession.mockResolvedValue({
    session: { id: "s1", title: "Add a footer", projectRoot: "/p/site", branch: "main", model: "network/qwen3-coder:30b", compute: { target: "network" }, published: true, cSats: 0, transcript: [
      { id: "u1", role: "user", content: "Add a footer", at: 1, by: "terminal" },
      { id: "a1", role: "assistant", content: "Added it.", at: 2, events: [] },
    ] },
    seq: 5, controller: TERM, clients: [TERM, DESK], running: null, pending: [],
  });
  api.followSession.mockImplementation(async (_id: string, _since: number, onEvent: (e: Record<string, unknown>) => void) => {
    emit = onEvent;
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LiveSessionPanel", () => {
  it("shows the terminal's session, watches until it takes control, then sends and approves", async () => {
    render(LiveSessionPanel, { sessionId: "s1" });
    expect(await screen.findByText("Added it.")).toBeTruthy();
    expect(screen.getByText("from the terminal")).toBeTruthy();
    expect(screen.getByText(/Terminal on mbp is in control/)).toBeTruthy();
    const box = screen.getByPlaceholderText("Take control to send messages") as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);

    await fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(api.sessionTakeControl).toHaveBeenCalledWith("s1");
    emit({ seq: 6, type: "control", controller: DESK });
    await waitFor(() => expect(screen.getByText(/You're in control/)).toBeTruthy());

    const input = screen.getByPlaceholderText(/Message this session/) as HTMLTextAreaElement;
    await fireEvent.input(input, { target: { value: "add a header too" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.sessionSend).toHaveBeenCalledWith("s1", "add a header too"));

    // The turn streams in; the write asks, and the app answers.
    emit({ seq: 7, type: "message", entry: { id: "u2", role: "user", content: "add a header too", at: 3, by: "desktop" } });
    emit({ seq: 8, type: "agent", turnId: "t2", event: { type: "turn", id: "t2" } });
    emit({ seq: 9, type: "agent", turnId: "t2", event: { type: "text", content: "Writing the header." } });
    emit({ seq: 10, type: "agent", turnId: "t2", event: { type: "tool_call", id: "c9", tool: "write_file", args: { path: "header.html", content: "<h1>Hi</h1>" }, requires_approval: true } });
    expect(await screen.findByText("Writing the header.")).toBeTruthy();
    const approveBtn = await screen.findByRole("button", { name: "Allow" });
    await fireEvent.click(approveBtn);
    expect(api.sessionApprove).toHaveBeenCalledWith("s1", "c9", true);
    emit({ seq: 11, type: "turn_end", entry: { id: "a2", role: "assistant", content: "Writing the header. Done.", at: 4, events: [] } });
    expect(await screen.findByText("Writing the header. Done.")).toBeTruthy();
  });
});
