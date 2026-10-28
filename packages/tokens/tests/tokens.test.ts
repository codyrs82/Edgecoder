import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCss, buildTheme } from "../build.mjs";

const root = join(__dirname, "..");
const tokens = JSON.parse(readFileSync(join(root, "src/tokens.json"), "utf8"));
const norm = (s: string) => s.replace(/\r\n/g, "\n");

function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe("@edgecoder/tokens (#23)", () => {
  it("every color token has both a light and a dark value", () => {
    for (const [name, v] of Object.entries<Record<string, string>>(tokens.color)) {
      expect(v.light, `${name}.light`).toBeTruthy();
      expect(v.dark, `${name}.dark`).toBeTruthy();
    }
  });

  it("keeps the existing desktop variable names and dark values", () => {
    expect(tokens.color["bg-base"].dark).toBe("#2f2f2d");
    expect(tokens.color.accent.dark).toBe("#c17850");
    expect(tokens.color["text-primary"].dark).toBe("#f7f5f0");
    for (const alias of ["bg", "bg-soft", "card-border", "text", "muted", "brand", "brand-2", "ok", "warn", "danger"]) {
      expect(tokens.aliases[alias], alias).toBeTruthy();
    }
  });

  it("generated CSS covers light, explicit dark and prefers-color-scheme", () => {
    const css = buildCss(tokens);
    expect(css).toContain("[data-theme=dark]");
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(":root:not([data-theme=light])");
    for (const name of Object.keys(tokens.color)) expect(css).toContain(`--${name}:`);
  });

  it("committed dist/tokens.css and src/theme.css are up to date", () => {
    expect(norm(readFileSync(join(root, "dist/tokens.css"), "utf8"))).toBe(buildCss(tokens));
    expect(norm(readFileSync(join(root, "src/theme.css"), "utf8"))).toBe(buildTheme(tokens));
  });

  it("theme.css has no self-referencing variables", () => {
    for (const m of buildTheme(tokens).matchAll(/--([\w-]+):\s*var\(--([\w-]+)\)/g)) {
      expect(m[1]).not.toBe(m[2]);
    }
  });

  for (const mode of ["light", "dark"] as const) {
    it(`WCAG AA: text-primary on bg-base and bg-surface ≥ 4.5 (${mode})`, () => {
      const fg = tokens.color["text-primary"][mode];
      expect(contrast(fg, tokens.color["bg-base"][mode])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(fg, tokens.color["bg-surface"][mode])).toBeGreaterThanOrEqual(4.5);
    });
    it(`WCAG AA: text-secondary on bg-base ≥ 4.5 (${mode})`, () => {
      expect(contrast(tokens.color["text-secondary"][mode], tokens.color["bg-base"][mode])).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("light-mode accent is usable as text on light surfaces (≥ 4.5)", () => {
    expect(contrast(tokens.color.accent.light, tokens.color["bg-surface"].light)).toBeGreaterThanOrEqual(4.5);
  });
});
