import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";

async function chatPage(): Promise<string> {
  const app = Fastify();
  registerPortalPages(app);
  const res = await app.inject({ url: "/portal/chat" });
  await app.close();
  expect(res.statusCode).toBe(200);
  return res.body;
}

describe("the web chat's Web toggle and sources (docs/web-tool.md)", () => {
  it("has a Web toggle in the composer, hidden until the status says web search is set up", async () => {
    const html = await chatPage();
    expect(html).toMatch(/<button type="button" class="web-toggle hidden" id="webToggle" aria-pressed="false"/);
    expect(html).toContain('fetch("/portal/api/chat"');
    expect(html).toContain('api("/portal/api/web/status?" + webStatusQuery())');
    // Sent only when on and available; kept per chat.
    expect(html).toContain("if (webOn && webState && webState.available) chatBody.web = true;");
    expect(html).toContain('var WEB_KEY = "edgecoder.chat.web.";');
    // Disabled with a reason: a model that can't call tools, or no cSats.
    expect(html).toContain("Web needs a model that can use tools. Pick another model.");
    expect(html).toContain('"needs cSats"');
    for (const m of html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)) expect(() => new Function(m[1])).not.toThrow();
  });

  it("renders numbered sources as links and the web footer under the answer", async () => {
    const html = await chatPage();
    expect(html).toContain("function renderWebSources(bubble, w)");
    expect(html).toContain('a.rel = "noopener noreferrer";');
    expect(html).toContain("line.textContent = w.footer;");
  });

  it("the page's Markdown turns [title](https://…) into a link (stored sources) and nothing else", async () => {
    const html = await chatPage();
    const script = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((s) => s.includes("function renderMarkdown(text)"))!;
    const fn = /function renderMarkdown\(text\) \{[\s\S]*?\n    \}/.exec(script)![0];
    const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const render = new Function("escapeHtml", `${fn}; return renderMarkdown;`)(escapeHtml) as (t: string) => string;
    expect(render("1. [Docs](https://example.com/a?b=1&c=2)")).toBe('1. <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">Docs</a>');
    expect(render("[x](javascript:alert(1))")).not.toContain("<a ");
    expect(render('[x](https://e.com/"onmouseover="y)')).not.toContain('"onmouseover');
  });
});
