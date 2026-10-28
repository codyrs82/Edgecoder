import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #29: iOS Theme.swift must match the shared design tokens (dark and light).
const here = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(readFileSync(join(here, "../src/tokens.json"), "utf8")) as {
  color: Record<string, { dark: string; light: string }>;
};
const swift = readFileSync(join(here, "../../../ios/EdgeCoderIOS/EdgeCoderIOS/Core/Theme.swift"), "utf8").replace(/\r\n/g, "\n");

type Rgba = { hex: string; alpha: number };
function parseCss(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) return { hex: hex[1].toLowerCase(), alpha: 1 };
  const m = /^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)$/.exec(value.trim());
  if (!m) throw new Error(`unparsed token value ${value}`);
  const h = [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  return { hex: h, alpha: Number(m[4]) };
}

const camel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const SWIFT_RE =
  /static let (\w+) = Color\.adaptive\(dark: 0x([0-9a-f]{6}), light: 0x([0-9a-f]{6})(?:, darkOpacity: ([\d.]+), lightOpacity: ([\d.]+))?\)/gi;
const ios = new Map<string, { dark: Rgba; light: Rgba }>();
for (const m of swift.matchAll(SWIFT_RE)) {
  ios.set(m[1], {
    dark: { hex: m[2].toLowerCase(), alpha: m[4] ? Number(m[4]) : 1 },
    light: { hex: m[3].toLowerCase(), alpha: m[5] ? Number(m[5]) : 1 }
  });
}

describe("iOS Theme.swift matches packages/tokens (#29)", () => {
  it.each(Object.keys(tokens.color))("%s", (key) => {
    const swiftColor = ios.get(camel(key));
    expect(swiftColor, `Theme.${camel(key)} missing in Theme.swift`).toBeDefined();
    expect(swiftColor!.dark).toEqual(parseCss(tokens.color[key].dark));
    expect(swiftColor!.light).toEqual(parseCss(tokens.color[key].light));
  });

  it("every colour in enum Theme goes through Color.adaptive (#151 review)", () => {
    const body = /enum Theme \{([\s\S]*?)\n\}/.exec(swift)?.[1] ?? "";
    const lets = [...body.matchAll(/static let (\w+)\s*=\s*([^\n]+)/g)];
    expect(lets.length).toBeGreaterThan(0);
    expect(lets.filter(([, , rhs]) => !rhs.trim().startsWith("Color.adaptive(")).map(([, n]) => n)).toEqual([]);
  });

  it("appearance setting matches the desktop: same key, same options, Dark by default (#151)", () => {
    const desktop = readFileSync(join(here, "../../../desktop/src/lib/theme.ts"), "utf8");
    const key = /THEME_STORAGE_KEY = "([^"]+)"/.exec(desktop)?.[1];
    const def = /DEFAULT_THEME: ThemePreference = "([^"]+)"/.exec(desktop)?.[1];
    expect(swift).toContain(`static let storageKey = "${key}"`);
    expect(def).toBe("dark");
    expect(swift).toContain("static let defaultValue: AppearancePreference = .dark");
    expect(swift).toMatch(/case system, light, dark/);
  });

  it("Theme.swift has no colours that aren't tokens", () => {
    const known = new Set(Object.keys(tokens.color).map(camel));
    expect([...ios.keys()].filter((k) => !known.has(k))).toEqual([]);
  });
});
