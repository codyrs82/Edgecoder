import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #23/#28: every surface takes its colours from the shared tokens, so light and dark both work.
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const TOKENS_CSS = fileURLToPath(new URL("../../packages/tokens/dist/tokens.css", import.meta.url));
const TOKENS = JSON.parse(readFileSync(fileURLToPath(new URL("../../packages/tokens/src/tokens.json", import.meta.url)), "utf8")) as {
  color: Record<string, Record<Mode, string>>;
  aliases: Record<string, string>;
  derived: Record<string, { of: string; percent: number; into: string }>;
};
type Mode = "light" | "dark";
type Rgb = [number, number, number];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.(svelte|css|ts)$/.test(e.name) && !e.name.endsWith(".d.ts") ? [join(dir, e.name)] : []
  );
}
const FILES = walk(SRC).map((abs) => ({ rel: relative(SRC, abs).replace(/\\/g, "/"), text: readFileSync(abs, "utf8").replace(/\r\n/g, "\n") }));

/** Raw colours that are not theme colours. Each entry says why. */
const ALLOWED: Record<string, RegExp[]> = {
  // Bot identity colours picked by the user, and the ink chosen to contrast with them.
  "lib/bot-avatar.ts": [/#[0-9a-fA-F]{3,6}\b/],
  // The Bits characters' own flat colours (Bitcoin orange and its complements), the same in both
  // themes: each sits on its own body, not on a theme surface.
  "lib/bit-avatars.ts": [/#[0-9a-fA-F]{3,6}\b/],
  // The avatar illustration's eyes and highlights sit on the bot's own colour, not on a theme surface.
  "components/BotAvatar.svelte": [/#fff\b/, /#1d1d1f\b/, /#ffffff\b/],
  // The HTML preview is a browser canvas: pages without a background expect white in either theme.
  "pages/EditorView.svelte": [/#fff\b/],
  // Invoice QR codes: scanners need black modules on a white ground in either theme.
  "lib/qr.ts": [/#ffffff\b/, /#000000\b/]
};

/** A hex colour in a CSS or attribute position; `#123` issue references in prose do not match. */
const HEX = /(?<=[:"'`(,\s])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?=[;"'`),\s}!]|$)/gm;
const FUNC = /\b(?:rgba?|hsla?)\([^)]*\)/g;

function rawColors(rel: string, text: string): string[] {
  // Comments carry issue numbers (#123); only code can paint.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  const found = [...(code.match(HEX) ?? []), ...(code.match(FUNC) ?? [])];
  const allowed = ALLOWED[rel] ?? [];
  return found.filter((c) => !allowed.some((re) => re.test(c)));
}

const mix = (a: Rgb, percent: number, b: Rgb) => a.map((v, i) => (v * percent + b[i] * (100 - percent)) / 100) as Rgb;
/** A token's opaque colour in one theme; undefined for translucent tokens and unknown names. */
function tokenRgb(name: string, mode: Mode): Rgb | undefined {
  const d = TOKENS.derived[name];
  if (d) {
    const [a, b] = [tokenRgb(d.of, mode), tokenRgb(d.into, mode)];
    return a && b ? mix(a, d.percent, b) : undefined;
  }
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(TOKENS.color[TOKENS.aliases[name] ?? name]?.[mode] ?? "");
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : undefined;
}
function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const SURFACES = ["bg-base", "bg-surface", "bg-elevated", "bg-input", "bg-deep"];
const TINT = /background(?:-color)?:\s*color-mix\(in srgb,\s*var\(--([\w-]+)\)\s*(\d+)%,\s*transparent\)/;
const TEXT = /(?<![-\w])color:\s*var\(--([\w-]+)\)/;

/** Rules that set both a translucent tint and a text colour, where the text falls below 4.5:1 on some surface. */
function lowContrastTints(rel: string, text: string): string[] {
  const out: string[] = [];
  for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [tint, fg] = [TINT.exec(rule[2]), TEXT.exec(rule[2])];
    if (!tint || !fg) continue;
    for (const mode of ["light", "dark"] as const) {
      const [tintRgb, fgRgb] = [tokenRgb(tint[1], mode), tokenRgb(fg[1], mode)];
      if (!tintRgb || !fgRgb) continue;
      const worst = Math.min(...SURFACES.map((s) => contrast(fgRgb, mix(tintRgb, Number(tint[2]), tokenRgb(s, mode)!))));
      if (worst < 4.5) out.push(`${rel}: ${rule[1].trim().split("\n").pop()!.trim()} (${mode}) ${worst.toFixed(2)}`);
    }
  }
  return out;
}

describe("desktop styles use design tokens (#23, #28)", () => {
  it("no hard-coded colours outside the documented exceptions", () => {
    const offenders = FILES.flatMap((f) => rawColors(f.rel, f.text).map((c) => `${f.rel}: ${c}`));
    expect(offenders).toEqual([]);
  });

  it("every custom property that is read is defined", () => {
    const defined = new Set<string>();
    for (const text of [readFileSync(TOKENS_CSS, "utf8"), ...FILES.map((f) => f.text)]) {
      for (const m of text.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
      // Set from script: style="--x: ..." or style:--x={...}
      for (const m of text.matchAll(/style:(--[a-zA-Z0-9-]+)/g)) defined.add(m[1]);
    }
    const missing = new Set<string>();
    for (const f of FILES) {
      for (const m of f.text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
        // bits-ui sets --bits-* on the elements it positions; svelte-sonner sets --width on its list.
        const external = m[1].startsWith("--bits-") || (f.rel === "styles/ui.css" && m[1] === "--width");
        if (!defined.has(m[1]) && !external) missing.add(`${f.rel}: ${m[1]}`);
      }
    }
    expect([...missing]).toEqual([]);
  });

  // #29: a badge or banner that tints its background with a colour and writes in a colour has to stay
  // readable wherever it is placed. Red text on a red tint needs --red-strong; other tints stay light.
  it("text on a tinted background keeps 4.5:1 on every surface in both themes", () => {
    expect(lowContrastTints("x.css", ".bad { background: color-mix(in srgb, var(--red) 12%, transparent); color: var(--red); }")).toHaveLength(2);
    expect(FILES.flatMap((f) => lowContrastTints(f.rel, f.text))).toEqual([]);
  });

  it("no stale fallbacks inside var() for a token", () => {
    const offenders = FILES.flatMap((f) => (f.text.match(/var\(--[a-z0-9-]+,\s*(?:#|rgb|hsl)[^)]*\)/g) ?? []).map((c) => `${f.rel}: ${c}`));
    expect(offenders).toEqual([]);
  });
});
