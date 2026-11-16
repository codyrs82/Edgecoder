import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The slim composer: every place a message is typed uses the one shared ChatInput, and its
// controls (compute picker, Auto-apply edits) sit in the row under the box, not around it.
const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const VIEWS = ["App.svelte", "components/EditorChatPanel.svelte", "pages/BotView.svelte", "components/LiveSessionPanel.svelte"];

describe("one shared composer", () => {
  for (const f of VIEWS) {
    it(`${f} types messages in ChatInput, not its own textarea`, () => {
      const src = read(f);
      expect(src).toMatch(/import ChatInput from "\.\.?\/(components\/)?ChatInput\.svelte"/);
      expect(src).toContain("<ChatInput");
      expect(src).not.toContain("<textarea");
    });
  }

  it("the Chat view (App.svelte) and the Code view put their controls in the row under the box", () => {
    for (const f of ["App.svelte", "components/EditorChatPanel.svelte"]) {
      const src = read(f);
      const block = src.slice(src.indexOf("<ChatInput"), src.indexOf("</ChatInput>"));
      expect(block).toContain("{#snippet controls()}");
      expect(block).toContain("<ComputePicker");
    }
    const editor = read("components/EditorChatPanel.svelte");
    const block = editor.slice(editor.indexOf("<ChatInput"), editor.indexOf("</ChatInput>"));
    expect(block).toContain("Auto-apply edits");
    expect(editor).not.toContain('class="run-on"');
  });

  it("the box starts at one line, grows to 40% of the window, and has a token focus ring", () => {
    const src = read("components/ChatInput.svelte");
    expect(src).toContain('rows="1"');
    expect(src).toContain("window.innerHeight * 0.4");
    expect(src).toMatch(/\.composer-box:has\(textarea:focus-visible\) \{\n\s+outline: 2px solid var\(--focus-ring\);/);
  });
});
