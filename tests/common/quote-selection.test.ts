import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Q from "../../src/common/quote-selection.js";
import { QUOTE_SELECTION_BROWSER_LIB } from "../../src/portal/pages/quote-selection.js";

describe("quote-selection (shared by the desktop app and the portal)", () => {
  it("is byte-identical in src/common and desktop/src/lib", () => {
    const shared = readFileSync(new URL("../../src/common/quote-selection.ts", import.meta.url), "utf8");
    const desktop = readFileSync(new URL("../../desktop/src/lib/quote-selection.ts", import.meta.url), "utf8");
    expect(desktop).toBe(shared);
  });

  it("quotes prose as > lines, trimmed, with blank lines kept as bare >", () => {
    expect(Q.quoteMarkdown("  one line  ", null)).toBe("> one line");
    expect(Q.quoteMarkdown("first\r\nsecond\n\n\n\nthird\n", null)).toBe("> first\n> second\n>\n> third");
  });

  it("fences code in its language, outgrowing backtick runs inside", () => {
    expect(Q.quoteMarkdown("\n  const x = 1;\n", { lang: "ts" })).toBe("```ts\n  const x = 1;\n```");
    expect(Q.quoteMarkdown("a ``` b", { lang: "" })).toBe("````\na ``` b\n````");
    expect(Q.quoteMarkdown("x", { lang: "c<script>" })).toBe("```cscript\nx\n```");
  });

  it("cuts long selections at about 4,000 characters with … and a (truncated) line", () => {
    const long = "word ".repeat(2000);
    const q = Q.quoteMarkdown(long, null);
    expect(q.endsWith("…\n(truncated)")).toBe(true);
    expect(q.length).toBeLessThan(4_100);
    const c = Q.quoteMarkdown("x".repeat(5000), { lang: "py" });
    expect(c).toBe("```py\n" + "x".repeat(4000) + "…\n```\n(truncated)");
    expect(Q.quoteMarkdown("short", null)).not.toContain("truncated");
  });

  it("inserts into the composer without losing text, caret ready for the reply", () => {
    expect(Q.insertQuoteText("", 0, "> a")).toEqual({ value: "> a\n\n", caret: 5 });
    // Quotes append.
    const one = Q.insertQuoteText("", 0, "> a");
    expect(Q.insertQuoteText(one.value, one.caret, "> b")).toEqual({ value: "> a\n\n> b\n\n", caret: 10 });
    // A line with text is never split: the quote goes after it.
    expect(Q.insertQuoteText("I think", 3, "> a")).toEqual({ value: "I think\n\n> a\n\n", caret: 14 });
    // Text below the caret stays below, a blank line apart.
    const r = Q.insertQuoteText("top\n\nbottom", 4, "> a");
    expect(r.value).toBe("top\n\n> a\n\n\n\nbottom");
    expect(r.value.slice(0, r.caret)).toBe("top\n\n> a\n\n");
  });

  it("places the button above the selection, inside the pane, below it when there is no room", () => {
    const pane = { left: 100, top: 50, right: 600, bottom: 800 };
    expect(Q.quoteButtonPosition({ left: 200, top: 300, right: 400, bottom: 320 }, pane, 120, 28)).toEqual({ left: 200, top: 266 });
    expect(Q.quoteButtonPosition({ left: 580, top: 300, right: 590, bottom: 320 }, pane, 120, 28)).toEqual({ left: 476, top: 266 });
    expect(Q.quoteButtonPosition({ left: 20, top: 55, right: 90, bottom: 75 }, pane, 120, 28)).toEqual({ left: 104, top: 81 });
  });

  it("ships to the browser as plain functions", () => {
    const lib = new Function(`${QUOTE_SELECTION_BROWSER_LIB}; return { quoteMarkdown, insertQuoteText, quotableSelection, quoteButtonPosition };`)() as typeof Q;
    expect(lib.quoteMarkdown("a\nb", null)).toBe("> a\n> b");
    expect(lib.insertQuoteText("x", 1, "> a").value).toBe("x\n\n> a\n\n");
    expect(lib.quotableSelection(null, null)).toBeNull();
  });
});
