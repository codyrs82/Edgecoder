// #89: the portal uses the shared @edgecoder/tokens stylesheet and the desktop's light/dark/system
// theme toggle, without inline palettes and without new inline scripts.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { THEME_JS, THEME_STORAGE_KEY, messagePage, portalTokensCss } from "../../src/portal/assets.js";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { registerPortalSecurity } from "../../src/portal/security.js";
import { staticSiteFiles } from "../../src/portal/static-site.js";
import { oauthErrorPage } from "../../src/portal/oauth-identity.js";

const ROOT = new URL("../../", import.meta.url);
const PACKAGE_TOKENS = readFileSync(new URL("packages/tokens/dist/tokens.css", ROOT), "utf8");

const PAGES = [
  "/",
  "/privacy",
  "/terms",
  "/portal-legacy",
  "/portal",
  "/portal/reset-password",
  "/portal/chat",
  "/portal/dashboard",
  "/portal/settings",
  "/portal/settings/plan",
  "/portal/settings/compute",
  "/portal/settings/install",
  "/portal/settings/nodes",
  "/portal/settings/admin",
  "/portal/reviews",
];
const SHELL_PAGES = PAGES.filter((p) => p.startsWith("/portal/") && p !== "/portal/reset-password");

async function pagesApp(withSecurity = false) {
  const app = Fastify();
  if (withSecurity) await registerPortalSecurity(app, { publicOrigin: "https://edgecoder.io", trustedOrigins: [] });
  registerPortalPages(app);
  await app.ready();
  return app;
}

function expectThemed(html: string, where: string) {
  const head = html.slice(0, html.indexOf("</head>"));
  expect(html, where).toMatch(/<html lang="en" data-theme="dark">/);
  const link = head.indexOf('<link rel="stylesheet" href="/assets/tokens.css?v=');
  const script = head.indexOf('<script src="/assets/theme.js?v=');
  expect(link, `${where}: links tokens.css`).toBeGreaterThan(-1);
  expect(script, `${where}: loads theme.js`).toBeGreaterThan(-1);
  const firstStyle = head.indexOf("<style");
  if (firstStyle > -1) expect(link, `${where}: tokens.css comes before page styles`).toBeLessThan(firstStyle);
}

describe("portal tokens and theme (#89)", () => {
  it("every page links /assets/tokens.css and /assets/theme.js and renders data-theme=dark", async () => {
    const app = await pagesApp();
    for (const url of PAGES) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expectThemed(res.body, url);
    }
    await app.close();
    expectThemed(messagePage("t", "<p>x</p>"), "messagePage");
    expectThemed(oauthErrorPage("nope"), "oauthErrorPage");
  });

  it("the shell and the public pages include the theme toggle; Settings has a system/light/dark select", async () => {
    const app = await pagesApp();
    for (const url of [...SHELL_PAGES, "/", "/privacy", "/terms", "/portal"]) {
      expect((await app.inject({ url })).body, url).toContain("data-theme-toggle");
    }
    const settings = (await app.inject({ url: "/portal/settings" })).body;
    const select = settings.match(/<select id="themeSelect"[^>]*>([\s\S]*?)<\/select>/);
    expect(select?.[0]).toContain("data-theme-select");
    expect([...(select?.[1] ?? "").matchAll(/value="([a-z]+)"/g)].map((m) => m[1])).toEqual(["system", "light", "dark"]);
    await app.close();
  });

  it("drops the inline warm/midnight/emerald palettes", async () => {
    const app = await pagesApp();
    for (const url of PAGES) {
      const html = (await app.inject({ url })).body;
      expect(html, url).not.toMatch(/themePalettes|THEME_PALETTES|applyTheme\(/);
      expect(html, url).not.toMatch(/value="(warm|midnight|emerald)"/);
      // old palette backgrounds, set as custom properties
      expect(html, url).not.toMatch(/--bg:\s*#|--text:\s*#|--brand:\s*#/);
    }
    await app.close();
  });

  it("page CSS uses token vars, not hard-coded colors", () => {
    const dir = new URL("src/portal/pages/", ROOT);
    // Allowed: Google / Microsoft logo fills, the <select> chevron data URI, and black shadows/scrims.
    const allowed = /fill="#|%23[0-9a-f]{6}|rgba\(0, ?0, ?0, ?0?\.\d+\)/i;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const lines = readFileSync(new URL(f, dir), "utf8").split("\n");
      const bad = lines
        .filter((l) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(l.replace(new RegExp(allowed, "gi"), "")))
        // not colors: HTML entities (&#039;), and market.ts building rgba() from a token's hex for its chart
        .filter((l) => !/&#0?39;|#x[0-9a-f]+;/i.test(l) && !/"rgba\(" \+/.test(l));
      expect(bad.map((l) => `${f}: ${l.trim().slice(0, 120)}`)).toEqual([]);
    }
  });

  it("serves tokens.css (the package file) and theme.js with long-cache headers", async () => {
    const app = await pagesApp();
    const css = await app.inject({ url: "/assets/tokens.css" });
    expect(css.statusCode).toBe(200);
    expect(css.headers["content-type"]).toMatch(/^text\/css/);
    expect(css.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(css.body).toBe(PACKAGE_TOKENS);
    expect(css.body).toContain("[data-theme=dark]");
    const js = await app.inject({ url: "/assets/theme.js" });
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(js.body).toBe(THEME_JS);
    // the version in the links changes with the content
    const page = (await app.inject({ url: "/" })).body;
    expect(page).toMatch(/\/assets\/tokens\.css\?v=[0-9a-f]{12}"/);
    await app.close();
  });

  it("the CSP still allows no inline scripts: script-src is 'self' plus a nonce, and every inline <script> carries it", async () => {
    const app = await pagesApp(true);
    for (const url of PAGES) {
      const res = await app.inject({ url });
      const csp = String(res.headers["content-security-policy"] ?? res.headers["content-security-policy-report-only"]);
      const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src "));
      expect(scriptSrc, url).toMatch(/^script-src 'self' 'nonce-[A-Za-z0-9+/=]+'$/);
      expect(csp, url).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      const nonce = scriptSrc!.match(/'nonce-([^']+)'/)![1];
      for (const tag of res.body.match(/<script\b[^>]*>/g) ?? []) {
        // external scripts are same-origin; inline ones need this response's nonce
        if (/\bsrc="\/assets\//.test(tag) || /\bsrc="\/portal\/vendor\//.test(tag)) continue;
        expect(tag, url).toContain(`nonce="${nonce}"`);
      }
      // no inline event handlers either
      expect(res.body, url).not.toMatch(/\son(click|change|load|submit|input)=/i);
    }
    await app.close();
  });

  it("the static mirror ships the assets its pages link", () => {
    const files = staticSiteFiles({ portalUrl: "https://edgecoder.io" });
    expect(files["assets/tokens.css"]).toBe(PACKAGE_TOKENS);
    expect(files["assets/theme.js"]).toBe(THEME_JS);
    expectThemed(files["index.html"], "mirror index");
    expect(files._headers).not.toContain("unsafe-inline'; script");
  });

  it("npm run build's copy step puts tokens.css where the built server reads it", () => {
    const out = mkdtempSync(join(tmpdir(), "portal-assets-"));
    try {
      execFileSync(process.execPath, [new URL("scripts/copy-portal-assets.mjs", ROOT).pathname, out]);
      expect(readFileSync(join(out, "tokens.css"), "utf8")).toBe(PACKAGE_TOKENS);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    expect(portalTokensCss()).toBe(PACKAGE_TOKENS);
    const pkg = JSON.parse(readFileSync(new URL("package.json", ROOT), "utf8"));
    expect(pkg.scripts.build).toContain("scripts/copy-portal-assets.mjs");
    for (const f of ["Dockerfile.server", "Dockerfile.agent"]) {
      const docker = readFileSync(new URL(`deploy/docker/${f}`, ROOT), "utf8");
      expect(docker, f).toContain("COPY packages/tokens/dist/tokens.css");
      expect(docker, f).toContain("COPY scripts/copy-portal-assets.mjs");
    }
  });
});

/** Run theme.js against a minimal fake DOM. */
function runTheme(opts: { stored?: string | null; systemDark?: boolean; throwStorage?: boolean } = {}) {
  const attrs: Record<string, string> = { "data-theme": "dark" };
  const store = new Map<string, string>();
  if (opts.stored != null) store.set(THEME_STORAGE_KEY, opts.stored);
  const mqlListeners: Array<() => void> = [];
  const docListeners: Record<string, Array<(e: unknown) => void>> = {};
  const mql = { matches: !!opts.systemDark, addEventListener: (_: string, fn: () => void) => mqlListeners.push(fn) };
  const button = {
    attrs: {} as Record<string, string>,
    title: "",
    label: { textContent: "" },
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    querySelector() { return this.label; },
    closest(sel: string) { return sel === "[data-theme-toggle]" ? this : null; },
  };
  const select = { value: "", matches: (sel: string) => sel === "select[data-theme-select]" };
  const sandbox: Record<string, unknown> = {
    localStorage: {
      getItem: (k: string) => { if (opts.throwStorage) throw new Error("denied"); return store.get(k) ?? null; },
      setItem: (k: string, v: string) => { if (opts.throwStorage) throw new Error("denied"); store.set(k, v); },
    },
    document: {
      readyState: "complete",
      documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } },
      querySelectorAll: (sel: string) => (sel === "[data-theme-toggle]" ? [button] : sel === "select[data-theme-select]" ? [select] : []),
      addEventListener: (type: string, fn: (e: unknown) => void) => { (docListeners[type] ??= []).push(fn); },
    },
  };
  sandbox.window = {
    matchMedia: () => mql,
    addEventListener: () => {},
  };
  vm.runInNewContext(THEME_JS, sandbox);
  const api = (sandbox.window as { edgecoderTheme: { get(): string; set(p: string): void } }).edgecoderTheme;
  return {
    theme: () => attrs["data-theme"],
    store,
    api,
    button,
    select,
    click: () => docListeners.click.forEach((fn) => fn({ target: button })),
    change: (value: string) => { select.value = value; docListeners.change.forEach((fn) => fn({ target: select })); },
    systemChange: (dark: boolean) => { mql.matches = dark; mqlListeners.forEach((fn) => fn()); },
  };
}

describe("theme.js (#89)", () => {
  it("defaults to dark when nothing is stored, and when storage is blocked", () => {
    expect(runTheme().theme()).toBe("dark");
    expect(runTheme({ systemDark: false }).api.get()).toBe("dark");
    expect(runTheme({ throwStorage: true }).theme()).toBe("dark");
  });

  it("uses the stored choice under the desktop's key; ignores the old palette names", () => {
    expect(THEME_STORAGE_KEY).toBe("edgecoder-theme");
    expect(runTheme({ stored: "light" }).theme()).toBe("light");
    expect(runTheme({ stored: "midnight" }).theme()).toBe("dark");
  });

  it("system follows prefers-color-scheme, including live changes", () => {
    const t = runTheme({ stored: "system", systemDark: false });
    expect(t.theme()).toBe("light");
    t.systemChange(true);
    expect(t.theme()).toBe("dark");
  });

  it("the toggle cycles system -> light -> dark and persists; the select sets it directly", () => {
    const t = runTheme({ stored: "dark", systemDark: true });
    expect(t.button.attrs["aria-label"]).toBe("Theme: Dark. Change theme");
    t.click();
    expect(t.api.get()).toBe("system");
    expect(t.theme()).toBe("dark");
    t.click();
    expect(t.theme()).toBe("light");
    expect(t.store.get(THEME_STORAGE_KEY)).toBe("light");
    expect(t.button.label.textContent).toBe("Light");
    expect(t.select.value).toBe("light");
    t.change("dark");
    expect(t.theme()).toBe("dark");
    expect(t.store.get(THEME_STORAGE_KEY)).toBe("dark");
    t.change("bogus");
    expect(t.api.get()).toBe("dark");
  });
});
