import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { PUBLIC_DOCUMENTS, PUBLIC_DOCUMENT_SOURCES } from "../../src/portal/legal/documents.js";
import { renderMarkdown } from "../../src/portal/legal/markdown.js";
import { LEGAL_PAGES } from "../../src/portal/pages/public.js";

const LEGAL = ["terms", "privacy", "acceptable-use", "host-agreement"] as const;

describe("legal documents (docs/legal/*.md, DRAFT pending legal review)", () => {
  it("the portal's compiled copy matches the Markdown sources (run: node scripts/sync-legal-docs.mjs)", () => {
    for (const [key, path] of Object.entries(PUBLIC_DOCUMENT_SOURCES)) {
      expect(PUBLIC_DOCUMENTS[key as keyof typeof PUBLIC_DOCUMENTS], path).toBe(readFileSync(path, "utf8"));
    }
  });

  it("each starts with the DRAFT banner and keeps placeholders for counsel", () => {
    for (const key of LEGAL) {
      const md = PUBLIC_DOCUMENTS[key];
      expect(md.split("\n")[2], key).toMatch(/^> \*\*DRAFT — pending legal review\.\*\*/);
      expect(md, key).toContain("[CONTACT EMAIL]");
    }
    expect(PUBLIC_DOCUMENTS.terms).toContain("[GOVERNING LAW");
    expect(PUBLIC_DOCUMENTS.terms).toContain("[VENUE]");
  });
});

describe("legal and Bluetooth pages", () => {
  async function get(url: string) {
    const app = Fastify();
    registerPortalPages(app);
    const res = await app.inject({ url });
    await app.close();
    return res;
  }

  it("serves each legal page with its title, a visible draft banner, highlighted placeholders and links to the others", async () => {
    for (const key of LEGAL) {
      const page = LEGAL_PAGES[key];
      const res = await get(page.path);
      expect(res.statusCode, page.path).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.body.match(/<title>([^<]*)<\/title>/)?.[1]).toBe(`${page.title} | EdgeCoder`);
      expect(res.body).toContain('class="draft-banner"');
      expect(res.body).toContain("<strong>DRAFT — pending legal review.</strong>");
      expect(res.body).toContain('<mark class="placeholder">[CONTACT EMAIL]</mark>');
      for (const other of LEGAL) expect(res.body).toContain(`href="${LEGAL_PAGES[other].path}"`);
      expect(res.body).toContain('aria-current="page"');
    }
  });

  it("serves /bluetooth, and the footer links every document", async () => {
    const bt = await get("/bluetooth");
    expect(bt.statusCode).toBe(200);
    expect(bt.body).toContain("<title>Bluetooth mesh | EdgeCoder</title>");
    expect(bt.body).toContain("Why it exists");
    expect(bt.body).toContain("Current status and limits");
    const home = await get("/");
    for (const href of ["/terms", "/privacy", "/acceptable-use", "/host-agreement", "/bluetooth"]) expect(home.body).toContain(`href="${href}"`);
  });

  it("the admin Network page explains Bluetooth mesh, which it can't show live", async () => {
    const res = await get("/portal/settings/network");
    expect(res.body).toContain('id="netBle"');
    expect(res.body).toContain("POST /credits/ble-sync");
    expect(res.body).toContain("MESH_AUTH_TOKEN");
    expect(res.body).toContain('href="/bluetooth"');
  });

  it("the sign-up form has the required agreement checkbox", async () => {
    const res = await get("/portal");
    expect(res.body).toContain('id="signupAcceptTerms"');
    expect(res.body).toContain("I agree to the <a href=\"/terms\"");
    expect(res.body).toMatch(/id="signupBtn" disabled/);
    expect(res.body).toContain("acceptTerms: acceptTerms.checked");
  });

  it("the Install agent page asks for the Host Agreement before the install steps", async () => {
    const res = await get("/portal/settings/install");
    expect(res.body).toContain('id="hostAckBox"');
    expect(res.body).toContain('href="/host-agreement"');
    expect(res.body).toContain('class="needs-host-ack"');
  });
});

describe("renderMarkdown", () => {
  it("escapes HTML and drops unsafe links", () => {
    const html = renderMarkdown("Hi <script>alert(1)</script> [x](javascript:alert(1)) [ok](/terms) [ext](https://example.com)");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('<a href="/terms">ok</a>');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noreferrer">ext</a>');
  });

  it("renders headings, lists, quotes and emphasis", () => {
    const html = renderMarkdown("# T\n\n> **Note** here\n\n- a\n- b `c`\n\n1. one\n2. two\n\nText _it_ [12] [SOME LAW].");
    expect(html).toContain('<h1 id="t">T</h1>');
    expect(html).toContain("<blockquote><p><strong>Note</strong> here</p></blockquote>");
    expect(html).toContain("<ul><li>a</li><li>b <code>c</code></li></ul>");
    expect(html).toContain("<ol><li>one</li><li>two</li></ol>");
    expect(html).toContain("<em>it</em>");
    expect(html).toContain('<mark class="placeholder">[SOME LAW]</mark>');
  });
});
