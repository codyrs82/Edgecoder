import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #25: the chat view and its blocks are styled only from design tokens (packages/tokens),
// so light and dark mode both work. Neutral black shadows/backdrops are the one exception.
const FILES = [
  "components/ChatInput.svelte",
  "components/ChatMessage.svelte",
  "components/MarkdownRenderer.svelte",
  "components/DiffBlock.svelte",
  "components/ToolCallBlock.svelte",
  "components/PlanBlock.svelte",
  "components/ShellBlock.svelte",
  "components/ConversationSidebar.svelte",
  "components/StreamingIndicator.svelte",
  "pages/ChatView.svelte"
];
// Normalize CRLF (Windows checkouts) so the multi-line checks are line-ending agnostic.
const load = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const read = (f: string) => load(`../src/${f}`);
const style = (src: string) => src.slice(src.indexOf("<style"));

describe("chat view on tokens (#25)", () => {
  for (const f of FILES) {
    it(`${f} has no hard-coded colors`, () => {
      const src = read(f);
      const css = style(src);
      expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
      const rgba = (css.match(/rgba?\([^)]*\)/g) ?? []).filter((c) => !/^rgba\(0, 0, 0, /.test(c));
      expect(rgba).toEqual([]);
      // no stale dark-only fallbacks inside var(), in markup or script either
      expect(src.match(/var\(--[a-z-]+, *#[0-9a-fA-F]+\)/g) ?? []).toEqual([]);
    });
  }
});

describe("chat view keyboard access (#25)", () => {
  it("conversation rows are focusable and open on Enter/Space", () => {
    const src = read("components/ConversationSidebar.svelte");
    expect(src).toContain('role="button"');
    expect(src).toContain('tabindex="0"');
    expect(src).toContain("onkeydown={(e) => handleItemKeydown(e, convo.id)}");
    expect(src).toMatch(/e\.key === "Enter" \|\| e\.key === " "/);
    expect(src).toContain('aria-haspopup="menu"');
    expect(src).toContain('role="menuitem"');
    expect(src).not.toContain("a11y_click_events_have_key_events -->\n        <!-- svelte-ignore a11y_no_static_element_interactions -->\n        <div\n          class=\"conversation-item\"");
  });

  it("icon-only controls have names", () => {
    expect(read("components/ChatInput.svelte")).toContain('aria-label="Send message"');
    expect(read("components/ToolCallBlock.svelte")).toContain("aria-expanded={expanded}");
  });

  it("Enter during IME composition does not send", () => {
    expect(read("components/ChatInput.svelte")).toContain("!e.isComposing");
  });

  it("there is one token-based focus ring", () => {
    const css = load("../src/app.css");
    expect(css).toMatch(/:focus-visible \{\n  outline: 2px solid var\(--accent\);/);
  });
});
