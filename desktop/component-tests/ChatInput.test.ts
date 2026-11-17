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
  it("the send arrow becomes Stop; Enter queues (shown as Queued, removable) and queued messages go out in order when the reply ends", async () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(ChatInput, { onSend, onStop, streaming: true });
    // Working: Stop takes the send arrow's place.
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
    // Typing shows the "Enter to queue" hint, tied to the box.
    const box = screen.getByRole("textbox");
    expect(screen.queryByText("Enter to queue")).toBeNull();
    await fireEvent.input(box, { target: { value: "x" } });
    expect(screen.getByText("Enter to queue")).toBeTruthy();
    expect(box.getAttribute("aria-describedby")).toBe("composer-queue-hint");
    await fireEvent.input(box, { target: { value: "" } });

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
    // Idle again: the normal send arrow.
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
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

  it("co-editing a live session (sendWhileWorking): Send stays next to Stop and sends at once", async () => {
    const onSend = vi.fn();
    render(ChatInput, { onSend, onStop: vi.fn(), streaming: true, queue: [], sendWhileWorking: true });
    const pill = screen.getByTestId("composer-box");
    const order = [...pill.children].map((el) => el.getAttribute("aria-label") ?? el.tagName.toLowerCase());
    expect(order).toEqual(["Message EdgeCoder...", "Stop", "Send message"]);
    await fireEvent.input(screen.getByRole("textbox"), { target: { value: "run the tests" } });
    expect(screen.queryByText("Enter to queue")).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith("run the tests");
  });

  it("streaming without a stop action keeps the send arrow (it queues)", async () => {
    render(ChatInput, { onSend: vi.fn(), streaming: true });
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("not streaming: no Stop, Enter sends", async () => {
    const onSend = vi.fn();
    render(ChatInput, { onSend, onStop: vi.fn(), streaming: false });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    await type("hello");
    expect(onSend).toHaveBeenCalledWith("hello");
  });
});

// jsdom does no layout: give textareas a scrollHeight of 22 px a line plus 10 px of padding.
function fakeLayout() {
  const proto = HTMLTextAreaElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return this.value.split("\n").length * 22 + 10;
    },
  });
  return () => {
    if (original) Object.defineProperty(proto, "scrollHeight", original);
    else delete (proto as unknown as Record<string, unknown>).scrollHeight;
  };
}

describe("ChatInput: a slim box that grows with the text", () => {
  let restore: () => void = () => {};
  afterEach(() => restore());

  const px = (el: HTMLElement) => parseInt(el.style.height, 10);
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  it("starts as one line, grows with each line, and stops at 40% of the window, then scrolls inside", async () => {
    restore = fakeLayout();
    render(ChatInput, { onSend: vi.fn() });
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(px(box)).toBe(32));
    expect(box.getAttribute("rows")).toBe("1");

    await fireEvent.input(box, { target: { value: lines(3) } });
    const three = px(box);
    expect(three).toBe(3 * 22 + 10);
    expect(box.style.overflowY).toBe("hidden");

    await fireEvent.input(box, { target: { value: lines(5) } });
    expect(px(box)).toBeGreaterThan(three);

    const cap = Math.floor(window.innerHeight * 0.4);
    await fireEvent.input(box, { target: { value: lines(60) } });
    expect(px(box)).toBe(cap);
    expect(box.style.overflowY).toBe("auto");
  });

  it("shrinks back to one line after sending, and keeps focus where it was", async () => {
    restore = fakeLayout();
    const onSend = vi.fn();
    render(ChatInput, { onSend });
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    box.focus();
    await fireEvent.input(box, { target: { value: lines(4) } });
    expect(px(box)).toBe(4 * 22 + 10);
    await fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith(lines(4));
    expect(box.value).toBe("");
    await waitFor(() => expect(px(box)).toBe(32));
    expect(document.activeElement).toBe(box);
  });

  it("Enter sends, Shift+Enter does not (it adds a newline), Enter mid-IME-composition does not", async () => {
    const onSend = vi.fn();
    render(ChatInput, { onSend });
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    await fireEvent.input(box, { target: { value: "first line" } });
    const shift = await fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(shift).toBe(true); // not prevented: the browser inserts the newline
    await fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    await fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("first line");
  });

  it("has a labelled textarea, named buttons, + only with an attach action, and the controls row under the box", async () => {
    const { unmount } = render(ChatInput, { onSend: vi.fn(), placeholder: "Message Harry" });
    expect(screen.getByRole("textbox", { name: "Message Harry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a file or folder" })).toBeNull();
    expect(screen.queryByTestId("composer-controls")).toBeNull();
    unmount();

    render(ChatInput, { onSend: vi.fn(), streaming: true, onStop: vi.fn(), mentions: async () => [] });
    const pill = screen.getByTestId("composer-box");
    // + on the left, then the text, then Stop (in the send arrow's place) on the right.
    const order = [...pill.children].map((el) => el.getAttribute("aria-label") ?? el.tagName.toLowerCase());
    expect(order).toEqual(["Add a file or folder", "Message EdgeCoder...", "Stop"]);
    const controls = screen.getByTestId("composer-controls");
    expect(pill.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(controls.textContent).toContain("Working");
  });
});

describe("ChatInput attachments", () => {
  const NO = { images: false, pdf: false };
  const YES = { images: true, pdf: true };
  const file = (name: string, type: string, body = "hello") => new File([body], name, { type });

  it("+ attaches picked files as chips with remove, and sends them with the message", async () => {
    const onSend = vi.fn();
    render(ChatInput, { onSend, attach: { vision: YES } });
    const plus = screen.getByRole("button", { name: "Attach files" });
    expect(plus).toBeTruthy();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [file("notes.md", "text/markdown", "# hi"), file("shot.png", "image/png", "PNG")] });
    await fireEvent.change(input);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeTruthy());
    expect(screen.getByRole("list", { name: "Attached files" }).children).toHaveLength(2);
    await fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(screen.queryByText("shot.png")).toBeNull();
    // Attachments alone can be sent.
    expect((screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement).disabled).toBe(false);
    await fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("", [expect.objectContaining({ name: "notes.md", kind: "text", text: "# hi" })]);
    expect(screen.queryByRole("list", { name: "Attached files" })).toBeNull();
  });

  it("pasting an image attaches it; pasting text does not", async () => {
    render(ChatInput, { onSend: vi.fn(), attach: { vision: NO, who: "Cyber SIMP", savedToFolder: true } });
    const box = screen.getByRole("textbox");
    await fireEvent.paste(box, { clipboardData: { files: [], types: ["text/plain"] } });
    expect(screen.queryByRole("list", { name: "Attached files" })).toBeNull();
    await fireEvent.paste(box, { clipboardData: { files: [file("", "image/png", "PNG")], types: ["Files"] } });
    await waitFor(() => expect(screen.getByText("pasted-image.png")).toBeTruthy());
    // The model can't see images: said before sending, not dropped silently.
    expect(screen.getByTestId("attach-note").textContent).toBe("Cyber SIMP can't see images; it gets the file name and the path where it's saved in its folder instead.");
  });

  it("drops files onto the box", async () => {
    render(ChatInput, { onSend: vi.fn(), attach: { vision: YES } });
    const pill = screen.getByTestId("composer-box");
    await fireEvent.drop(pill, { dataTransfer: { files: [file("a.ts", "", "let a = 1")], types: ["Files"] } });
    await waitFor(() => expect(screen.getByText("a.ts")).toBeTruthy());
    expect(screen.queryByTestId("attach-note")).toBeNull();
  });

  it("refuses unsupported and oversized files with a short message", async () => {
    render(ChatInput, { onSend: vi.fn(), attach: { vision: YES } });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [file("app.exe", "application/octet-stream")] });
    await fireEvent.change(input);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/only images .* text or code files and PDFs/));
    Object.defineProperty(input, "files", { configurable: true, value: [file("big.txt", "text/plain", "x".repeat(300 * 1024))] });
    await fireEvent.change(input);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/big.txt is 300 KB/));
  });

  it("with mentions too, + opens a menu: Attach files… and Mention a project file", async () => {
    render(ChatInput, { onSend: vi.fn(), attach: { vision: YES }, mentions: async () => [] });
    const plus = screen.getByRole("button", { name: "Add files" });
    expect(plus.getAttribute("aria-haspopup")).toBe("menu");
    await fireEvent.click(plus);
    expect(screen.getByRole("menuitem", { name: /Attach files/ })).toBeTruthy();
    await fireEvent.click(screen.getByRole("menuitem", { name: /Mention a project file/ }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("@");
  });

  it("a message typed while working is queued with its attachments", async () => {
    const onSend = vi.fn();
    const { rerender } = render(ChatInput, { onSend, onStop: vi.fn(), streaming: true, attach: { vision: YES } });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { configurable: true, value: [file("x.csv", "text/csv", "a,b")] });
    await fireEvent.change(input);
    await waitFor(() => expect(screen.getByText("x.csv")).toBeTruthy());
    await type("look at this");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText(/look at this \(\+1 file\)/)).toBeTruthy();
    await rerender({ onSend, onStop: vi.fn(), streaming: false, attach: { vision: YES } });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("look at this", [expect.objectContaining({ name: "x.csv" })]));
  });
});
