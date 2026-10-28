import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #29: WCAG AA contrast for the colour tokens, both themes: 4.5:1 for every text colour on
// every background, and for on-accent text on accent fills (buttons, selected rows).
const here = dirname(fileURLToPath(import.meta.url));
const { color } = JSON.parse(readFileSync(join(here, "../src/tokens.json"), "utf8")) as {
  color: Record<string, { dark: string; light: string }>;
};

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`expected an opaque #rrggbb colour, got ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const BACKGROUNDS = ["bg-base", "bg-surface", "bg-elevated", "bg-input", "bg-deep"];
const TEXT = ["text-primary", "text-secondary", "text-muted", "accent", "accent-hover", "accent-secondary", "green", "red", "yellow"];
const cases = (["dark", "light"] as const).flatMap((mode) => [
  ...TEXT.flatMap((fg) => BACKGROUNDS.map((bg) => [mode, fg, bg] as const)),
  [mode, "on-accent", "accent"] as const,
  [mode, "on-accent", "accent-hover"] as const,
]);

// WCAG 1.4.11 non-text contrast: control edges (inputs, buttons, toggles), focus rings and
// accent fills need 3:1 against every surface they sit on. `border` and `border-strong` are
// translucent decorative dividers and are exempt; controls must use `border-control`.
const UI = ["border-control", "focus-ring", "accent", "accent-hover"];
const uiCases = (["dark", "light"] as const).flatMap((mode) =>
  UI.flatMap((fg) => BACKGROUNDS.map((bg) => [mode, fg, bg] as const)),
);
const DECORATIVE = new Set(["border", "border-strong", "card"]);

describe("token contrast meets WCAG AA (#29)", () => {
  it("contrast() matches known values", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it.each(cases)("%s: %s on %s is at least 4.5:1", (mode, fg, bg) => {
    expect(contrast(color[fg][mode], color[bg][mode])).toBeGreaterThanOrEqual(4.5);
  });

  it.each(uiCases)("%s: %s on %s is at least 3:1 (UI component)", (mode, fg, bg) => {
    expect(contrast(color[fg][mode], color[bg][mode])).toBeGreaterThanOrEqual(3);
  });

  it("every colour token is either checked or listed as decorative", () => {
    const checked = new Set([...BACKGROUNDS, ...TEXT, ...UI, "on-accent"]);
    expect(Object.keys(color).filter((k) => !checked.has(k) && !DECORATIVE.has(k))).toEqual([]);
  });
});
