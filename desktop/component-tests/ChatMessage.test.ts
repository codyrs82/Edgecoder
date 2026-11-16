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
