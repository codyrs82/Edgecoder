import { describe, expect, it } from "vitest";
import { nextFocusIndex, rovingIndex } from "../src/lib/focus-trap";

describe("focus trap helpers (#26)", () => {
  it("Tab wraps forward and Shift+Tab wraps back", () => {
    expect(nextFocusIndex(0, 3, false)).toBe(1);
    expect(nextFocusIndex(2, 3, false)).toBe(0);
    expect(nextFocusIndex(0, 3, true)).toBe(2);
    expect(nextFocusIndex(-1, 3, false)).toBe(0); // focus outside the trap -> first
    expect(nextFocusIndex(-1, 3, true)).toBe(2);
    expect(nextFocusIndex(0, 0, false)).toBe(-1);
  });

  it("arrow keys rove a vertical tablist with Home/End", () => {
    expect(rovingIndex("ArrowDown", 0, 4)).toBe(1);
    expect(rovingIndex("ArrowDown", 3, 4)).toBe(0);
    expect(rovingIndex("ArrowUp", 0, 4)).toBe(3);
    expect(rovingIndex("Home", 2, 4)).toBe(0);
    expect(rovingIndex("End", 0, 4)).toBe(3);
    expect(rovingIndex("ArrowRight", 0, 4)).toBeNull();
    expect(rovingIndex("ArrowRight", 0, 4, "horizontal")).toBe(1);
    expect(rovingIndex("a", 0, 4)).toBeNull();
  });
});

import { escapeClosesDialog, tabStops } from "../src/lib/focus-trap";

const el = (tabIndex: number, rects = 1) => ({ tabIndex, getClientRects: () => ({ length: rects }) });

describe("focus trap stops and Escape (#130 review)", () => {
  it("skips roving tabindex=-1 tabs and unrendered elements, keeps fixed-position ones", () => {
    const activeTab = el(0), inactiveTab = el(-1), hidden = el(0, 0), fixedBtn = el(0, 1), panel = el(0);
    expect(tabStops([activeTab, inactiveTab, inactiveTab, hidden, fixedBtn, panel])).toEqual([activeTab, fixedBtn, panel]);
    expect(tabStops([hidden], hidden)).toEqual([hidden]); // the focused element always counts
  });

  it("Escape closes only when nothing inside handled it", () => {
    const t = (tagName: string, attrs: Record<string, string> = {}) => ({ tagName, getAttribute: (n: string) => attrs[n] ?? null });
    expect(escapeClosesDialog({ defaultPrevented: false, target: t("BUTTON") })).toBe(true);
    expect(escapeClosesDialog({ defaultPrevented: true, target: t("BUTTON") })).toBe(false);
    expect(escapeClosesDialog({ defaultPrevented: false, target: t("SELECT") })).toBe(false);
    expect(escapeClosesDialog({ defaultPrevented: false, target: t("INPUT") })).toBe(false);
    expect(escapeClosesDialog({ defaultPrevented: false, target: t("DIV", { role: "combobox" }) })).toBe(false);
    expect(escapeClosesDialog({ defaultPrevented: false, target: t("BUTTON", { "aria-expanded": "true" }) })).toBe(false);
    expect(escapeClosesDialog({ defaultPrevented: false, target: null })).toBe(true);
  });
});
