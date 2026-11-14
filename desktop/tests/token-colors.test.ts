import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// #23/#28: every surface takes its colours from the shared tokens, so light and dark both work.
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const TOKENS_CSS = fileURLToPath(new URL("../../packages/tokens/dist/tokens.css", import.meta.url));

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
  // The avatar illustration's eyes and highlights sit on the bot's own colour, not on a theme surface.
  "components/BotAvatar.svelte": [/#fff\b/, /#1d1d1f\b/, /#ffffff\b/],
  // The HTML preview is a browser canvas: pages without a background expect white in either theme.
  "pages/EditorView.svelte": [/#fff\b/]
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

  it("no stale fallbacks inside var() for a token", () => {
    const offenders = FILES.flatMap((f) => (f.text.match(/var\(--[a-z0-9-]+,\s*(?:#|rgb|hsl)[^)]*\)/g) ?? []).map((c) => `${f.rel}: ${c}`));
    expect(offenders).toEqual([]);
  });
});
