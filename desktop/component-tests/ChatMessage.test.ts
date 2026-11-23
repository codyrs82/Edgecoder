import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";

vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn().mockResolvedValue(undefined) }));

import ChatMessage from "../src/components/ChatMessage.svelte";
import { MAX_MARKDOWN, TRIMMED_TEXT } from "../src/lib/markdown";

afterEach(cleanup);

describe("ChatMessage with a huge assistant reply", () => {
  // A small model writing whole files as text: markdown parsing of this is quadratic, and
  // rendered whole it pinned the app for tens of seconds.
  const huge = "Here is the plan." + " self._cache".repeat(25_000) + "\n\nAll done.";

  it("renders a 300 KB message quickly: its start and latest part, with the trim marker", () => {
    expect(huge.length).toBeGreaterThan(300_000);
    const t = performance.now();
    const { container } = render(ChatMessage, { role: "assistant", content: huge });
    expect(performance.now() - t).toBeLessThan(2_000);
    const text = container.querySelector(".markdown")?.textContent ?? "";
    expect(text).toMatch(/^Here is the plan\./);
    expect(text).toContain(TRIMMED_TEXT);
    expect(text.trim()).toMatch(/All done\.$/);
    expect(text.length).toBeLessThan(MAX_MARKDOWN + 100);
  });

  it("re-renders while streaming without slowing down", () => {
    const { rerender } = render(ChatMessage, { role: "assistant", content: "", streaming: true });
    const t = performance.now();
    for (let n = 1; n <= 40; n++) rerender({ role: "assistant", content: huge.slice(0, n * 7_500), streaming: true });
    expect(performance.now() - t).toBeLessThan(4_000);
  });
});

describe("ChatMessage: a failed reply", () => {
  it("out of cSats: one compact notice with Buy cSats, not a raw error bubble", async () => {
    const { get } = await import("svelte/store");
    const { buyRequest, openWalletRequest } = await import("../src/lib/buy-csats");
    const { fireEvent, screen } = await import("@testing-library/svelte");
    const err = "Not enough cSats: your balance is 0.01 cSats. This step needs about 0.4 cSats on the network.";
    render(ChatMessage, { role: "assistant", content: `Error: ${err}` });
    const note = screen.getByTestId("reply-failure");
    expect(note.textContent).toMatch(/^Couldn't run: out of cSats · your balance is 0\.01 cSats\./);
    expect(document.body.textContent).not.toMatch(/Error:/);
    expect(document.body.textContent!.split("your balance is 0.01 cSats").length - 1).toBe(1);
    const before = get(openWalletRequest);
    await fireEvent.click(screen.getByRole("button", { name: "Buy cSats" }));
    expect(get(openWalletRequest)).toBe(before + 1);
    expect(get(buyRequest)).toMatchObject({ returnTo: "the chat", amountSats: 5_000 });
    buyRequest.set(null);
  });

  it("keeps the reply's text above the notice; other failures have no Buy button", async () => {
    const { screen } = await import("@testing-library/svelte");
    render(ChatMessage, { role: "assistant", content: "I read the file.\n\nError contacting model: No GPU machines online. Available now: CPU (9)." });
    expect(document.body.textContent).toMatch(/I read the file\./);
    expect(screen.getByTestId("reply-failure").textContent).toMatch(/Couldn't run: no machines of that class online · No GPU machines online/);
    expect(screen.queryByRole("button", { name: "Buy cSats" })).toBeNull();
  });

  it("shows the error's own words on an unclassified failure, so it is never a bare \"Couldn't run\"", async () => {
    const { screen } = await import("@testing-library/svelte");
    render(ChatMessage, { role: "assistant", content: "Error contacting model: Anthropic returned 401: invalid x-api-key" });
    const note = screen.getByTestId("reply-failure");
    expect(note.textContent).toMatch(/^Couldn't run · Anthropic returned 401: invalid x-api-key/);
    expect(note.getAttribute("title")).toBe("Anthropic returned 401: invalid x-api-key");
  });
});
