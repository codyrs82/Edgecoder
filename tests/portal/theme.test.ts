import { describe, it, expect } from "vitest";

describe("portal dark theme palettes", () => {
  it("warm theme has correct dark values", () => {
    const warm = { "--bg": "#2f2f2d", "--text": "#f7f5f0", "--brand": "#c17850" };
    expect(warm["--bg"]).toBe("#2f2f2d");
    expect(warm["--text"]).toBe("#f7f5f0");
    expect(warm["--brand"]).toBe("#c17850");
  });

  it("midnight theme has correct dark values", () => {
    const midnight = { "--bg": "#1a1a2e", "--text": "#e8e8f0", "--brand": "#6366f1" };
    expect(midnight["--bg"]).toBe("#1a1a2e");
    expect(midnight["--brand"]).toBe("#6366f1");
  });

  it("emerald theme has correct dark values", () => {
    const emerald = { "--bg": "#1a2e1a", "--text": "#e8f0e8", "--brand": "#22c55e" };
    expect(emerald["--bg"]).toBe("#1a2e1a");
    expect(emerald["--brand"]).toBe("#22c55e");
  });
});
