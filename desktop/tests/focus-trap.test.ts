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
