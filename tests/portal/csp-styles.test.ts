// #27: style-src has no 'unsafe-inline'. Every <style> block carries the response's nonce, no
// page has a style attribute (in markup or in the HTML its scripts build), the chart library's one
// injected stylesheet is allowed by hash, and the static mirror lists the hash of each block.
// Pages come from the routes the app registers, so a page added later is held to the same rule.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { messagePage } from "../../src/portal/assets.js";
import { chartLibSource, chartLibStyleHashes, inlineStyleHashes } from "../../src/portal/chart-lib.js";
import { CSP_NONCE } from "../../src/portal/csp-nonce.js";
import { oauthErrorPage } from "../../src/portal/oauth-identity.js";
import { brandMark } from "../../src/portal/pages/design-system.js";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { verifyEmailPage } from "../../src/portal/pages/verify-email.js";
import { registerPortalSecurity } from "../../src/portal/security.js";
import { staticSiteFiles, withStyleHashes } from "../../src/portal/static-site.js";

const ROOT = new URL("../../", import.meta.url);

function sha256(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

function directive(csp: string, name: string): string {
  return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith(name + " ")) ?? "";
}

// A style attribute in markup, or in a string a script later hands to innerHTML (\" or ' quoted).
const STYLE_ATTR = /\sstyle\s*=\s*\\?["']/i;

async function securedPages(): Promise<Array<{ url: string; csp: string; body: string }>> {
  const app = Fastify();
  const routes: string[] = [];
  app.addHook("onRoute", (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    if (methods.includes("GET")) routes.push(r.url);
  });
  await registerPortalSecurity(app, { publicOrigin: "https://edgecoder.io", trustedOrigins: [] });
  registerPortalPages(app);
  // The pages served from outside pages/index.ts go through the same hooks.
  app.get("/__verify-email", async (_req, reply) => reply.type("text/html").send(verifyEmailPage()));
  app.get("/__oauth-error", async (_req, reply) => reply.type("text/html").send(oauthErrorPage("nope")));
  app.get("/__message", async (_req, reply) => reply.type("text/html").send(messagePage("t", "<p>x</p>")));
  await app.ready();
  const out: Array<{ url: string; csp: string; body: string }> = [];
  for (const url of routes) {
    if (url.includes(":") || url.includes("*")) continue;
    const res = await app.inject({ url });
    if (!String(res.headers["content-type"] ?? "").includes("text/html")) continue;
    expect(res.statusCode, url).toBe(200);
    out.push({ url, csp: String(res.headers["content-security-policy"]), body: res.body });
  }
  await app.close();
  return out;
}

describe("styles under the enforced CSP (#27)", () => {
  it("style-src is 'self', the request's nonce and the chart library's hash: no 'unsafe-inline' anywhere", async () => {
    const pages = await securedPages();
    const urls = pages.map((p) => p.url);
    for (const u of ["/", "/portal", "/portal/chat", "/portal/settings/compute", "/portal/reset-password", "/__verify-email", "/__oauth-error", "/__message"]) expect(urls).toContain(u);
    expect(pages.length).toBeGreaterThanOrEqual(17);
    for (const { url, csp } of pages) {
      expect(csp, url).not.toContain("unsafe-inline");
      const style = directive(csp, "style-src");
      const script = directive(csp, "script-src");
      const nonce = /'nonce-([A-Za-z0-9+/=]{20,})'/.exec(style)?.[1];
      expect(nonce, url).toBeTruthy();
      expect(style, url).toBe(["style-src 'self'", `'nonce-${nonce}'`, ...chartLibStyleHashes()].join(" "));
      expect(script, url).toBe(`script-src 'self' 'nonce-${nonce}'`);
    }
  });

  it("every <style> block on every page carries the response's nonce", async () => {
    let blocks = 0;
    for (const { url, csp, body } of await securedPages()) {
      const nonce = /'nonce-([^']+)'/.exec(directive(csp, "style-src"))![1];
      const tags = body.match(/<style\b[^>]*>/g) ?? [];
      expect(tags.length, `${url}: has styles`).toBeGreaterThan(0);
      for (const tag of tags) expect(tag, url).toBe(`<style nonce="${nonce}">`);
      blocks += tags.length;
      expect(body, `${url}: marker replaced`).not.toContain(CSP_NONCE);
      // an inline stylesheet link would need 'self'; the only one is tokens.css
      for (const link of body.match(/<link\b[^>]*rel="stylesheet"[^>]*>/g) ?? []) expect(link, url).toContain('href="/assets/tokens.css?v=');
    }
    expect(blocks).toBeGreaterThan(20);
  });

  it("no page has a style attribute, in its markup or in the HTML its scripts build", async () => {
    for (const { url, body } of await securedPages()) {
      const hit = STYLE_ATTR.exec(body);
      expect(hit ? body.slice(Math.max(0, hit.index - 80), hit.index + 80) : null, url).toBeNull();
      // Scripts may set el.style.* (CSSOM, allowed); these two are not.
      expect(body, url).not.toMatch(/setAttribute\(\s*["']style["']/);
      expect(body, url).not.toMatch(/createElement\(\s*["']style["']\s*\)/);
    }
  });

  it("the page sources have none either (covers strings no route renders)", () => {
    const dir = new URL("src/portal/pages/", ROOT);
    const files = [...readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => new URL(f, dir)), new URL("src/portal/assets.ts", ROOT), new URL("src/portal/oauth-identity.ts", ROOT)];
    expect(files.length).toBeGreaterThan(15);
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        const where = `${file.pathname.split("/src/")[1]}:${i + 1}`;
        expect(STYLE_ATTR.test(line) ? line.trim().slice(0, 120) : null, where).toBeNull();
        if (/<style\b/.test(line) && !/^\s*(\*|\/\/)/.test(line)) expect(line, where).toContain('<style nonce="${CSP_NONCE}">');
      });
    }
  });

  it("the brand mark is sized by class", () => {
    expect(brandMark()).toMatch(/^<span class="mark" aria-hidden="true"><svg width="17" height="17"/);
    expect(brandMark(24)).toMatch(/^<span class="mark mark-24" aria-hidden="true"><svg width="14" height="14"/);
    expect(brandMark(30)).toMatch(/^<span class="mark mark-30" aria-hidden="true"><svg width="18" height="18"/);
  });

  it("the Reviews nav badge starts hidden by class and is shown by removing it", async () => {
    const dashboard = (await securedPages()).find((p) => p.url === "/portal/dashboard")!;
    expect(dashboard.body).toContain('<span class="nav-badge hidden" id="reviewsBadge">0</span>');
    expect(dashboard.body).toContain('badge.classList.remove("hidden");');
  });
});

describe("the chart library's injected stylesheet (#27)", () => {
  it("is found in the served library and hashed as the browser hashes it", () => {
    const lib = chartLibSource();
    expect(lib.length, "lightweight-charts is installed").toBeGreaterThan(1000);
    const literal = /"(a#tv-attr-logo\{[^"]*)"/.exec(lib)![1];
    expect(literal).toContain("a#tv-attr-logo[data-dark]");
    expect(chartLibStyleHashes()).toEqual([sha256(literal)]);
    // One injected <style> is covered. A release that adds another must be looked at.
    expect(lib.match(/createElement\(\s*["']style["']\s*\)/g)).toHaveLength(1);
    // The library styles elements through the CSSOM only (allowed); no markup with style attributes.
    expect(lib).not.toMatch(/setAttribute\(\s*["']style["']/);
    expect(lib).not.toMatch(/\sstyle=\\?["']/);
  });

  it("hashes each distinct literal once and yields nothing for a library without one", () => {
    expect(inlineStyleHashes('x.innerText="a#tv-attr-logo{left:1px;}",y.innerText=\'a#tv-attr-logo{left:1px;}\'')).toEqual([sha256("a#tv-attr-logo{left:1px;}")]);
    expect(inlineStyleHashes("var x = 1;")).toEqual([]);
    expect(inlineStyleHashes("")).toEqual([]);
  });
});

describe("the static mirror's style hashes (#27)", () => {
  const files = staticSiteFiles({ portalUrl: "https://edgecoder.io" });
  const csp = /Content-Security-Policy: (.*)/.exec(files._headers)![1];
  const PAGES = ["index.html", "privacy/index.html", "terms/index.html"];

  it("drops the nonce and lists the hash of every <style> block it ships", () => {
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("nonce-");
    const style = directive(csp, "style-src");
    const listed = style.split(" ").slice(2);
    expect(style.startsWith("style-src 'self' 'sha256-")).toBe(true);
    const needed = new Set<string>();
    for (const page of PAGES) {
      const html = files[page];
      expect(html, page).not.toContain(CSP_NONCE);
      expect(html, page).not.toContain("nonce=");
      expect(STYLE_ATTR.test(html), `${page}: style attribute`).toBe(false);
      // no inline scripts: the mirror's default-src 'self' has no nonce for them
      // (JSON-LD is a data block the browser never executes, so CSP does not apply to it)
      for (const tag of html.match(/<script\b[^>]*>/g) ?? []) if (tag !== '<script type="application/ld+json">') expect(tag, page).toMatch(/\bsrc="\/assets\//);
      const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
      expect(blocks.length, page).toBeGreaterThan(0);
      expect((html.match(/<style\b/g) ?? []).length, page).toBe(blocks.length);
      for (const css of blocks) needed.add(sha256(css));
    }
    expect([...listed].sort()).toEqual([...needed].sort());
  });

  it("withStyleHashes leaves the rest of the page alone", () => {
    const page = `<html><head><style nonce="${CSP_NONCE}">a{b:c}</style></head><body><style nonce="${CSP_NONCE}">d{e:f}</style><p>x</p></body></html>`;
    const out = withStyleHashes(page);
    expect(out.html).toBe("<html><head><style>a{b:c}</style></head><body><style>d{e:f}</style><p>x</p></body></html>");
    expect(out.hashes).toEqual([sha256("a{b:c}"), sha256("d{e:f}")]);
  });
});
