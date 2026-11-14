// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * #89: the portal's static assets.
 *
 * - /assets/tokens.css: the shared design tokens (@edgecoder/tokens, packages/tokens/dist/tokens.css),
 *   the same file the desktop app uses. `npm run build` copies it to dist/portal/assets/ (see
 *   scripts/copy-portal-assets.mjs); running from src/ (tsx, vitest) reads it from packages/.
 * - /assets/theme.js: the light/dark/system toggle. External, so it needs no 'unsafe-inline' and no
 *   nonce, and it also works on the static mirror (static-site.ts), whose CSP has no nonces.
 *
 * Both are linked with a content hash in the query string and served with a one-year immutable
 * cache, so a deploy that changes either file changes its URL.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

/** localStorage key and values shared with the desktop app (desktop/src/lib/theme.ts). */
export const THEME_STORAGE_KEY = "edgecoder-theme";
/** Dark until light mode has had a visual check (#89); `<html data-theme>` is rendered with it. */
export const DEFAULT_THEME = "dark";

const TOKENS_CANDIDATES = [
  // Built server: dist/portal/assets/tokens.css, copied there by scripts/copy-portal-assets.mjs.
  new URL("./assets/tokens.css", import.meta.url),
  // From source (tsx / vitest): src/portal -> packages/tokens/dist.
  new URL("../../packages/tokens/dist/tokens.css", import.meta.url),
];

let tokensCache: string | null = null;

/** The shared tokens stylesheet. Throws if neither the built copy nor the package file exists. */
export function portalTokensCss(): string {
  if (tokensCache !== null) return tokensCache;
  for (const url of TOKENS_CANDIDATES) {
    const path = fileURLToPath(url);
    if (existsSync(path)) {
      tokensCache = readFileSync(path, "utf8");
      return tokensCache;
    }
  }
  throw new Error(
    `portal: tokens.css not found (looked in ${TOKENS_CANDIDATES.map((u) => fileURLToPath(u)).join(", ")}); run npm run build`,
  );
}

/**
 * Theme toggle. Runs synchronously from <head> (before first paint) to set <html data-theme>, then
 * wires every `[data-theme-toggle]` button (cycles system -> light -> dark) and
 * `select[data-theme-select]` once the DOM is ready. "system" follows prefers-color-scheme.
 */
export const THEME_JS = `(function () {
  "use strict";
  var KEY = ${JSON.stringify(THEME_STORAGE_KEY)};
  var DEFAULT = ${JSON.stringify(DEFAULT_THEME)};
  var ORDER = ["system", "light", "dark"];
  var LABELS = { system: "System", light: "Light", dark: "Dark" };
  var root = document.documentElement;
  var mql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function isPref(v) { return v === "system" || v === "light" || v === "dark"; }
  function read() { try { var v = localStorage.getItem(KEY); return isPref(v) ? v : DEFAULT; } catch (e) { return DEFAULT; } }
  var pref = read();
  function resolved() { return pref === "system" ? (mql && mql.matches ? "dark" : "light") : pref; }
  function sync() {
    var buttons = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      b.setAttribute("data-theme-pref", pref);
      b.setAttribute("aria-label", "Theme: " + LABELS[pref] + ". Change theme");
      b.title = "Theme: " + LABELS[pref];
      var label = b.querySelector("[data-theme-label]");
      if (label) label.textContent = LABELS[pref];
    }
    var selects = document.querySelectorAll("select[data-theme-select]");
    for (var j = 0; j < selects.length; j++) selects[j].value = pref;
  }
  function apply() { root.setAttribute("data-theme", resolved()); sync(); }
  function set(p) {
    if (!isPref(p)) return;
    pref = p;
    try { localStorage.setItem(KEY, p); } catch (e) {}
    apply();
  }
  apply();
  if (mql) {
    var onChange = function () { if (pref === "system") apply(); };
    if (mql.addEventListener) mql.addEventListener("change", onChange); else if (mql.addListener) mql.addListener(onChange);
  }
  window.addEventListener("storage", function (e) { if (e.key === KEY) { pref = read(); apply(); } });
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-theme-toggle]") : null;
    if (!t) return;
    set(ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]);
  });
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t && t.matches && t.matches("select[data-theme-select]")) set(t.value);
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync); else sync();
  window.edgecoderTheme = { get: function () { return pref; }, resolved: resolved, set: set };
})();
`;

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export function tokensCssHref(): string {
  return `/assets/tokens.css?v=${hash(portalTokensCss())}`;
}

export function themeJsHref(): string {
  return `/assets/theme.js?v=${hash(THEME_JS)}`;
}

/** `<head>` tags every portal page includes: the tokens stylesheet, then the theme script. */
export function themeHeadTags(): string {
  return `<link rel="stylesheet" href="${tokensCssHref()}" />
      <script src="${themeJsHref()}"></script>`;
}

/** Opening `<html>` tag with the default theme, so the first paint matches before theme.js runs. */
export function htmlOpenTag(lang = "en"): string {
  return `<html lang="${lang}" data-theme="${DEFAULT_THEME}">`;
}

/** The toggle button (theme.js fills in its label and handles clicks). */
export function themeToggleButton(className = "ghost sm"): string {
  return `<button type="button" class="theme-toggle ${className}" data-theme-toggle aria-label="Change theme" title="Theme">`
    + `<svg class="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>`
    + `<span data-theme-label>Theme</span></button>`;
}

/** A minimal themed page for one-line results (email verification, OAuth errors). `bodyHtml` must be escaped. */
export function messagePage(title: string, bodyHtml: string): string {
  return `<!doctype html>${htmlOpenTag()}<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
      ${themeHeadTags()}
      <style>body { margin: 0; padding: 32px 20px; max-width: 640px; font-family: var(--font-sans); font-size: 14px; line-height: 1.5; background: var(--bg); color: var(--text); } a { color: var(--brand); }</style>
    </head><body>${bodyHtml}</body></html>`;
}

const LONG_CACHE ="public, max-age=31536000, immutable";

export function registerPortalAssets(app: FastifyInstance): void {
  const css = portalTokensCss();
  app.get("/assets/tokens.css", async (_req, reply) => {
    reply.header("cache-control", LONG_CACHE).type("text/css; charset=utf-8");
    return css;
  });
  app.get("/assets/theme.js", async (_req, reply) => {
    reply.header("cache-control", LONG_CACHE).type("text/javascript; charset=utf-8");
    return THEME_JS;
  });
}
