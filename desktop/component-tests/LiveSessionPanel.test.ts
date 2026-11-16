import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";

const DESK = { clientId: "desk-me", kind: "desktop", label: "EdgeCoder app" };
const TERM = { clientId: "term-1", kind: "terminal", label: "Terminal on mbp" };
const api = vi.hoisted(() => ({
  DESKTOP_CLIENT: { clientId: "desk-me", kind: "desktop", label: "EdgeCoder app" },
  getSession: vi.fn(),
  followSession: vi.fn(),
  sessionSend: vi.fn(async () => ({ turnId: "t2" })),
  sessionApprove: vi.fn(async () => ({ ok: true, applied: true })),
  sessionUnqueue: vi.fn(async () => ({ removed: true })),
  sessionCancel: vi.fn(async () => ({})),
  fsFind: vi.fn(async () => []),
  checkpointChanges: vi.fn(async () => ({ changes: [] })),
  sessionTentacles: vi.fn(async () => ({ config: { enabled: false }, spentCSats: 0, tentacles: [] })),
  tentacleCancel: vi.fn(async () => ({ cancelled: true })),
  tentacleMerge: vi.fn(async () => ({})),
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
    seq: 5, controller: null, clients: [TERM, DESK], running: null, pending: [], queue: [],
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
  it("co-edits with the terminal: no take control, sends at once, approves, and an answer from the terminal closes the card", async () => {
    render(LiveSessionPanel, { sessionId: "s1" });
    expect(await screen.findByText("Added it.")).toBeTruthy();
    expect(screen.getByText("from the terminal")).toBeTruthy();
    expect(screen.getByText(/Terminal and EdgeCoder app connected/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    expect(screen.queryByText(/in control/)).toBeNull();

    const input = screen.getByPlaceholderText(/Message this session/) as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    // The shared slim composer.
    expect(screen.getByTestId("composer-box").contains(input)).toBe(true);
    await fireEvent.input(input, { target: { value: "add a header too" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.sessionSend).toHaveBeenCalledWith("s1", "add a header too"));

    // The turn streams in; the write asks, and the app answers.
    emit({ seq: 7, type: "message", entry: { id: "u2", role: "user", content: "add a header too", at: 3, by: "desktop" } });
    emit({ seq: 8, type: "agent", turnId: "t2", event: { type: "turn", id: "t2" } });
    emit({ seq: 9, type: "agent", turnId: "t2", event: { type: "text", content: "Writing the header." } });
    emit({ seq: 10, type: "agent", turnId: "t2", event: { type: "tool_call", id: "c9", tool: "write_file", args: { path: "header.html", content: "<h1>Hi</h1>" }, requires_approval: true } });
    expect(await screen.findByText("Writing the header.")).toBeTruthy();
    await fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(api.sessionApprove).toHaveBeenCalledWith("s1", "c9", true);

    // A second write: the terminal answers first; the card here closes and says so.
    emit({ seq: 11, type: "agent", turnId: "t2", event: { type: "tool_call", id: "c10", tool: "write_file", args: { path: "footer.html", content: "f" }, requires_approval: true } });
    expect(await screen.findByRole("button", { name: "Allow" })).toBeTruthy();
    emit({ seq: 12, type: "approval", id: "c10", approved: true, by: "terminal", label: "Terminal on mbp" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Allow" })).toBeNull());
    expect(await screen.findByText("Approved in the terminal.")).toBeTruthy();

    // While it runs: typing queues (Send stays, Stop sits beside it), the queue is shown and removable.
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
    api.sessionSend.mockResolvedValueOnce({ turnId: null, queued: { id: "q5", text: "ping your default gateway", by: "desktop", at: 5 } } as never);
    await fireEvent.input(input, { target: { value: "ping your default gateway" } });
    await fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(api.sessionSend).toHaveBeenLastCalledWith("s1", "ping your default gateway"));
    emit({ seq: 13, type: "queued", entry: { id: "q5", text: "ping your default gateway", by: "desktop", label: "EdgeCoder app", at: 5 }, queue: [] });
    expect(await screen.findByText("ping your default gateway")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Remove queued message: ping your default gateway" }));
    expect(api.sessionUnqueue).toHaveBeenCalledWith("s1", "q5");
    await fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(api.sessionCancel).toHaveBeenCalledWith("s1");

    emit({ seq: 14, type: "settings", model: "network/qwen2.5-coder:32b", mode: "auto", changed: ["model", "mode"], by: "terminal" });
    expect(await screen.findByText("The terminal changed the model to network/qwen2.5-coder:32b and mode to auto.")).toBeTruthy();
    emit({ seq: 15, type: "turn_end", entry: { id: "a2", role: "assistant", content: "Writing the header. Done.", at: 4, events: [] } });
    expect(await screen.findByText("Writing the header. Done.")).toBeTruthy();
  });
});
