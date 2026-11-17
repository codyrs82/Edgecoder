import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import axe from "axe-core";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn().mockResolvedValue(undefined) }));

import QuoteHarness from "./fixtures/QuoteHarness.svelte";

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});

/** Select `text` inside `el` (the first text node holding it) and let the page see it. */
async function select(el: Element, text: string, endText?: string) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  const start = nodes.find((n) => n.data.includes(text));
  if (!start) throw new Error(`no text node with ${text}`);
  const end = endText ? nodes.find((n) => n.data.includes(endText))! : start;
  const range = document.createRange();
  range.setStart(start, start.data.indexOf(text));
  range.setEnd(end, endText ? end.data.indexOf(endText) + endText.length : start.data.indexOf(text) + text.length);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  await Promise.resolve();
}

const chip = () => screen.getByTestId("quote-selection") as HTMLButtonElement;
const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
const shortcut = isMac ? { metaKey: true } : { ctrlKey: true };

describe("Add to chat (quote a selection)", () => {
  it("shows the chip for a selection in a message, and clicking it adds a quote with the caret after it", async () => {
    render(QuoteHarness);
    expect(chip().hidden).toBe(true);
    await select(screen.getByTestId("pane"), "The lockfile is stale.");
    await waitFor(() => expect(chip().hidden).toBe(false));
    expect(chip().textContent).toMatch(/Add to chat/);
    expect(chip().textContent).toContain(isMac ? "⌘L" : "Ctrl+L");
    await fireEvent.click(chip());
    await waitFor(() => expect(box().value).toBe("> The lockfile is stale.\n\n"));
    expect(box().selectionStart).toBe(box().value.length);
    expect(document.activeElement).toBe(box());
    expect(chip().hidden).toBe(true);
  });

  it("the shortcut adds the selection too; quotes append and keep what is typed", async () => {
    render(QuoteHarness);
    await fireEvent.input(box(), { target: { value: "About this:" } });
    await select(screen.getByTestId("pane"), "The lockfile is stale.");
    await fireEvent.keyDown(window, { key: "l", ...shortcut });
    await waitFor(() => expect(box().value).toBe("About this:\n\n> The lockfile is stale.\n\n"));
    // A second quote appends; a multi-line selection gets "> " on every line.
    await select(screen.getByTestId("pane"), "Why does the build fail?\nIt worked yesterday.");
    await fireEvent.keyDown(window, { key: "l", ...shortcut });
    await waitFor(() => expect(box().value).toBe("About this:\n\n> The lockfile is stale.\n\n> Why does the build fail?\n> It worked yesterday.\n\n"));
  });

  it("Esc hides the chip; selections outside the messages or in the composer show nothing", async () => {
    render(QuoteHarness);
    await select(screen.getByTestId("pane"), "The lockfile is stale.");
    await waitFor(() => expect(chip().hidden).toBe(false));
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(chip().hidden).toBe(true);

    await select(screen.getByTestId("outside"), "Not part");
    expect(chip().hidden).toBe(true);
    await fireEvent.keyDown(window, { key: "l", ...shortcut });
    expect(box().value).toBe("");

    await fireEvent.input(box(), { target: { value: "draft text" } });
    box().focus();
    box().setSelectionRange(0, 5);
    document.dispatchEvent(new Event("selectionchange"));
    expect(chip().hidden).toBe(true);
    await fireEvent.keyDown(box(), { key: "l", ...shortcut });
    expect(box().value).toBe("draft text");
  });

  it("a long selection is cut with … and a visible (truncated) note", async () => {
    render(QuoteHarness, { long: "y".repeat(5000) });
    await select(screen.getByTestId("pane"), "y".repeat(5000));
    await fireEvent.keyDown(window, { key: "l", ...shortcut });
    await waitFor(() => expect(box().value).toBe("> " + "y".repeat(4000) + "…\n(truncated)\n\n"));
  });

  it("a selection inside a code block becomes a fenced block in its language", async () => {
    render(QuoteHarness);
    await select(screen.getByTestId("pane"), "const x = 1;");
    await waitFor(() => expect(chip().hidden).toBe(false));
    await fireEvent.click(chip());
    await waitFor(() => expect(box().value).toBe("```ts\nconst x = 1;\n```\n\n"));
  });

  it("the chip is a labelled, focusable button that keeps the selection and passes axe", async () => {
    render(QuoteHarness);
    await select(screen.getByTestId("pane"), "The lockfile is stale.");
    await waitFor(() => expect(chip().hidden).toBe(false));
    const b = screen.getByRole("button", { name: "Add selection to chat" });
    expect(b).toBe(chip());
    expect(b.getAttribute("aria-keyshortcuts")).toBe(isMac ? "Meta+L" : "Control+L");
    // Pressing it does not take the selection away (so Cmd+C still copies it).
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    b.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(window.getSelection()?.toString()).toBe("The lockfile is stale.");
    b.focus();
    expect(document.activeElement).toBe(b);
    const results = await axe.run(document.body, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id)).toEqual([]);
  });
});
