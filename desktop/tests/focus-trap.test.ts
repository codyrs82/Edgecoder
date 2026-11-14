import { describe, expect, it } from "vitest";
import { rovingIndex } from "../src/lib/focus-trap";

describe("roving focus (#26)", () => {
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

import { escapeClosesDialog } from "../src/lib/focus-trap";

describe("dialog Escape (#130 review)", () => {
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
