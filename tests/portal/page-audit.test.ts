// #27: the portal stays server-rendered (docs/adrs/0002-portal-stays-server-rendered.md). Instead
// of a fixed list of URLs, these tests walk every GET route the page modules register, so a page
// added later is held to the same rules: shared tokens and theme, shared base styles, a theme
// toggle, token colors only, and text that stays readable on tinted backgrounds in both themes.
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { messagePage } from "../../src/portal/assets.js";
import { oauthErrorPage } from "../../src/portal/oauth-identity.js";
import { BASE_CSS, TOKENS_CSS } from "../../src/portal/pages/design-system.js";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { verifyEmailPage } from "../../src/portal/pages/verify-email.js";

const ROOT = new URL("../../", import.meta.url);
const PAGES_DIR = new URL("src/portal/pages/", ROOT);

/** Every page the portal serves: [where, html]. Routes come from the app, not from a list. */
async function renderEveryPage(): Promise<{ pages: Array<[string, string]>; redirects: Array<[string, string]>; routes: string[] }> {
  const app = Fastify();
  const routes: string[] = [];
  app.addHook("onRoute", (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    if (methods.includes("GET")) routes.push(r.url);
  });
  registerPortalPages(app);
  await app.ready();
  const pages: Array<[string, string]> = [];
  const redirects: Array<[string, string]> = [];
  for (const url of routes) {
    if (url.includes(":") || url.includes("*")) continue; // parameterised file downloads, not pages
    const res = await app.inject({ url });
    if (res.statusCode >= 300 && res.statusCode < 400) redirects.push([url, String(res.headers.location)]);
    else if (String(res.headers["content-type"] ?? "").includes("text/html")) {
      expect(res.statusCode, url).toBe(200);
      pages.push([url, res.body]);
    }
  }
  await app.close();
  // Pages served from outside pages/index.ts (routes/auth.ts) and the one-line result pages.
  pages.push(["verifyEmailPage()", verifyEmailPage()]);
  return { pages, redirects, routes };
}

const MINIMAL: Array<[string, string]> = [
  ["messagePage()", messagePage("t", "<p>x</p>")],
  ["oauthErrorPage()", oauthErrorPage("nope")],
];

function head(html: string): string {
  return html.slice(0, html.indexOf("</head>"));
}

describe("every portal page is on the shared design system (#27)", () => {
  it("the walk finds the pages (guards the walk itself)", async () => {
    const { pages, redirects } = await renderEveryPage();
    const urls = pages.map(([u]) => u);
    for (const u of ["/", "/privacy", "/terms", "/portal", "/portal/reset-password", "/portal/chat", "/portal/dashboard", "/portal/settings", "/portal/reviews"]) {
      expect(urls).toContain(u);
    }
    expect(pages.length).toBeGreaterThanOrEqual(15);
    // redirects stay inside the portal and land on a page that exists
    for (const [from, to] of redirects.filter(([, to]) => to.startsWith("/"))) expect(urls, from).toContain(to);
  });

  it("every page opens with the themed <html>, links tokens.css before its own styles and loads theme.js", async () => {
    const { pages } = await renderEveryPage();
    for (const [where, html] of [...pages, ...MINIMAL]) {
      expect(html, where).toMatch(/^<!doctype html>\s*<html lang="en" data-theme="dark">/);
      const h = head(html);
      const link = h.indexOf('<link rel="stylesheet" href="/assets/tokens.css?v=');
      expect(link, `${where}: links tokens.css`).toBeGreaterThan(-1);
      expect(h, `${where}: loads theme.js`).toContain('<script src="/assets/theme.js?v=');
      const firstStyle = h.indexOf("<style");
      if (firstStyle > -1) expect(link, `${where}: tokens.css first`).toBeLessThan(firstStyle);
    }
  });

  it("every full page carries the portal tokens and base styles once, and a theme toggle", async () => {
    const { pages } = await renderEveryPage();
    for (const [where, html] of pages) {
      const h = head(html);
      expect(h.split(TOKENS_CSS).length - 1, `${where}: TOKENS_CSS`).toBe(1);
      expect(h.split(BASE_CSS).length - 1, `${where}: BASE_CSS`).toBe(1);
      expect(html, `${where}: theme toggle`).toContain("data-theme-toggle");
    }
  });

  it("no page defines its own palette or re-declares a shared token", async () => {
    const { pages } = await renderEveryPage();
    const shared = [...readFileSync(new URL("packages/tokens/dist/tokens.css", ROOT), "utf8").matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]);
    const portalOnly = new Set([...TOKENS_CSS.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
    for (const [where, html] of [...pages, ...MINIMAL]) {
      const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n").replace(TOKENS_CSS, "");
      // --font-mono is the one shared token design-system.ts extends (web fallbacks); nothing else may.
      const redeclared = [...new Set(shared)].filter((name) => new RegExp(`(^|[\\s;{])${name}\\s*:`).test(styles));
      expect(redeclared, where).toEqual([]);
      expect(portalOnly.has("--font-mono")).toBe(true);
    }
  });

  it("every inline script parses", async () => {
    const { pages } = await renderEveryPage();
    for (const [where, html] of pages) {
      for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
        if (/\bsrc=/.test(m[1]) || /type="application\/(ld\+)?json"/.test(m[1])) continue;
        expect(() => new vm.Script(m[2]), where).not.toThrow();
      }
    }
  });

  it("page modules contain no color literals; raw colors live in design-system.ts only", () => {
    const files = readdirSync(PAGES_DIR).filter((n) => n.endsWith(".ts") && n !== "design-system.ts");
    expect(files.length).toBeGreaterThan(10);
    const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch)\(/;
    for (const f of files) {
      const bad = readFileSync(new URL(f, PAGES_DIR), "utf8").split("\n")
        // the Google and Microsoft sign-in logos keep their brand fills
        .map((l) => l.replace(/fill="#[0-9A-Fa-f]{3,8}"/g, ""))
        // HTML character references are not colors
        .map((l) => l.replace(/&#x?[0-9a-fA-F]+;/g, ""))
        // market.ts builds rgba() from a token's value for the chart library, which cannot read CSS variables
        .filter((l) => !/"rgba\(" \+/.test(l))
        .filter((l) => literal.test(l));
      expect(bad.map((l) => `${f}: ${l.trim().slice(0, 120)}`)).toEqual([]);
    }
    // the same holds for the minimal pages in assets.ts
    expect(literal.test(messagePage("t", ""))).toBe(false);
  });

  it("every CSS variable a page uses is defined by the shared tokens, the portal tokens or the page", async () => {
    const { pages } = await renderEveryPage();
    const tokens = readFileSync(new URL("packages/tokens/dist/tokens.css", ROOT), "utf8");
    for (const [where, html] of [...pages, ...MINIMAL]) {
      const defined = new Set([...(tokens + html).matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
      const used = new Set([...html.matchAll(/var\((--[a-zA-Z0-9-]+)/g)].map((m) => m[1]));
      expect([...used].filter((v) => !defined.has(v)), where).toEqual([]);
    }
  });
});

// ── Contrast of text on tinted backgrounds (the shared tokens' own pairs are checked in
//    packages/tokens/tests/contrast.test.ts) ──
type Rgb = [number, number, number];
const { color } = JSON.parse(readFileSync(new URL("packages/tokens/src/tokens.json", ROOT), "utf8")) as {
  color: Record<string, { dark: string; light: string }>;
};
function rgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`expected #rrggbb, got ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}
/** color-mix(in srgb, a p%, b) for opaque colors, which is also `a` at p% alpha over `b`. */
function mix(a: Rgb, b: Rgb, p: number): Rgb {
  return [0, 1, 2].map((i) => a[i] * p + b[i] * (1 - p)) as Rgb;
}
function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const BACKGROUNDS = ["bg-base", "bg-surface", "bg-elevated", "bg-input", "bg-deep"];
const MODES = ["dark", "light"] as const;

describe("text on tinted backgrounds keeps 4.5:1 in both themes (#27)", () => {
  const inkShare = Number(/--danger-ink: color-mix\(in srgb, var\(--danger\) (\d+)%, var\(--text\)\)/.exec(TOKENS_CSS)?.[1]) / 100;

  it("design-system.ts defines --danger-ink as a mix of danger and text", () => {
    expect(inkShare).toBeGreaterThan(0.5);
    expect(inkShare).toBeLessThan(1);
  });

  it.each(MODES)("%s: --danger-ink on a 12% danger tint (danger badge, danger and reject buttons, removed diff lines)", (mode) => {
    const red = rgb(color.red[mode]);
    const ink = mix(red, rgb(color["text-primary"][mode]), inkShare);
    for (const bg of BACKGROUNDS) {
      expect(contrast(ink, mix(red, rgb(color[bg][mode]), 0.12)), bg).toBeGreaterThanOrEqual(4.5);
    }
    // plain --danger falls short on at least one surface, which is why the ink token exists
    expect(Math.min(...BACKGROUNDS.map((bg) => contrast(red, mix(red, rgb(color[bg][mode]), 0.12))))).toBeLessThan(4.5);
  });

  it.each(MODES)("%s: ok, warn and info badges on their 10% tints", (mode) => {
    for (const name of ["green", "yellow", "accent-secondary"]) {
      const c = rgb(color[name][mode]);
      for (const bg of BACKGROUNDS) expect(contrast(c, mix(c, rgb(color[bg][mode]), 0.1)), `${name} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(MODES)("%s: diff line numbers and comments (text-secondary) on the 15% added/removed tints", (mode) => {
    const fg = rgb(color["text-secondary"][mode]);
    for (const tint of ["green", "red"]) {
      for (const bg of BACKGROUNDS) expect(contrast(fg, mix(rgb(color[tint][mode]), rgb(color[bg][mode]), 0.15)), `${tint} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the reviews gutter and the chat timestamps use those colors at full opacity", () => {
    const reviews = readFileSync(new URL("reviews.ts", PAGES_DIR), "utf8");
    expect(reviews).toMatch(/\.diff-line-num \{[^}]*color:var\(--muted\)/);
    expect(reviews).toMatch(/\.diff-line\.removed \.diff-line-num \{[^}]*color:var\(--text-secondary\)/);
    expect(reviews).toMatch(/\.diff-line\.added \.diff-line-num \{[^}]*color:var\(--text-secondary\)/);
    expect(readFileSync(new URL("chat.ts", PAGES_DIR), "utf8")).toMatch(/\.msg-time \{ font-size:10px; color:var\(--muted\); \}/);
  });
});
