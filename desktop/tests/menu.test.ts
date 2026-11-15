// #161: arrow-key index math for role="menu" popups.
import { describe, it, expect } from "vitest";
import { menuKeyIndex } from "../src/lib/menu";

describe("menuKeyIndex", () => {
  it("moves and wraps with the arrow keys", () => {
    expect(menuKeyIndex("ArrowDown", 0, 3)).toBe(1);
    expect(menuKeyIndex("ArrowDown", 2, 3)).toBe(0);
    expect(menuKeyIndex("ArrowUp", 0, 3)).toBe(2);
    expect(menuKeyIndex("ArrowUp", 2, 3)).toBe(1);
  });

  it("jumps with Home and End", () => {
    expect(menuKeyIndex("Home", 2, 3)).toBe(0);
    expect(menuKeyIndex("End", 0, 3)).toBe(2);
  });

  it("starts at the first or last item when focus is outside the items", () => {
    expect(menuKeyIndex("ArrowDown", -1, 3)).toBe(0);
    expect(menuKeyIndex("ArrowUp", -1, 3)).toBe(2);
  });

  it("ignores other keys and empty menus", () => {
    expect(menuKeyIndex("ArrowLeft", 0, 3)).toBeNull();
    expect(menuKeyIndex("a", 0, 3)).toBeNull();
    expect(menuKeyIndex("ArrowDown", 0, 0)).toBeNull();
  });
});
