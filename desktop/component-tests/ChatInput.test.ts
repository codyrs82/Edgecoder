import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import ChatInput from "../src/components/ChatInput.svelte";

afterEach(() => cleanup());

async function type(text: string) {
  const box = screen.getByRole("textbox") as HTMLTextAreaElement;
  await fireEvent.input(box, { target: { value: text } });
  await fireEvent.keyDown(box, { key: "Enter" });
}

describe("ChatInput while a reply runs", () => {
  it("keeps Send next to a separate Stop; Enter queues (shown as Queued, removable) and queued messages go out in order when the reply ends", async () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(ChatInput, { onSend, onStop, streaming: true });
    // Both controls: Stop never replaces Send.
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();

    await type("ping your default gateway");
    await type("then traceroute it");
    await type("never mind this one");
    expect(onSend).not.toHaveBeenCalled();
    const items = screen.getAllByText(/^Queued/);
    expect(items).toHaveLength(3);
    await fireEvent.click(screen.getByRole("button", { name: "Remove queued message: never mind this one" }));
    expect(screen.queryByText("never mind this one")).toBeNull();

    // Esc stops, like the Stop button.
    await fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onStop).toHaveBeenCalledTimes(1);
    await fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(2);

    // The reply ends: the first queued message goes out; the next waits for that reply.
    await rerender({ onSend, onStop, streaming: false });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("ping your default gateway"));
    await rerender({ onSend, onStop, streaming: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    await rerender({ onSend, onStop, streaming: false });
    await waitFor(() => expect(onSend).toHaveBeenLastCalledWith("then traceroute it"));
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/^Queued/)).toBeNull();
  });

  it("with an external queue (a shared session) sends at once and shows the session's queue", async () => {
    const onSend = vi.fn();
    const onUnqueue = vi.fn();
    render(ChatInput, { onSend, onStop: vi.fn(), streaming: true, queue: [{ id: "q1", text: "run the tests", from: "the terminal" }], onUnqueue });
    await type("from the app");
    expect(onSend).toHaveBeenCalledWith("from the app");
    expect(screen.getByText("run the tests")).toBeTruthy();
    expect(screen.getByText("from the terminal")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Remove queued message: run the tests" }));
    expect(onUnqueue).toHaveBeenCalledWith("q1");
  });

  it("not streaming: no Stop, Enter sends", async () => {
    const onSend = vi.fn();
    render(ChatInput, { onSend, onStop: vi.fn(), streaming: false });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    await type("hello");
    expect(onSend).toHaveBeenCalledWith("hello");
  });
});
