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

describe("the web chat's Web indicator and sources (docs/web-tool.md)", () => {
  it("has a quiet Web indicator with an Auto / Off for this chat menu, hidden until web search is set up", async () => {
    const html = await chatPage();
    expect(html).toMatch(/<button type="button" class="web-toggle hidden" id="webToggle" aria-haspopup="menu" aria-expanded="false"/);
    expect(html).toContain('id="webMenu" role="menu"');
    expect(html).toContain('data-web-mode="auto"');
    expect(html).toContain('data-web-mode="off"');
    expect(html).toContain(">Off for this chat<");
    expect(html).toContain('fetch("/portal/api/chat"');
    expect(html).toContain('api("/portal/api/web/status?" + webStatusQuery())');
    // Automatic: offered when the chat is on Auto and the status says it can be used; kept per chat.
    expect(html).toContain('var webMode = "auto";');
    expect(html).toContain("if (webWanted()) chatBody.web = true;");
    expect(html).toContain('return webMode === "auto" && !!webState && webState.available === true;');
    expect(html).toContain('var WEB_KEY = "edgecoder.chat.web.";');
    // The Settings default, and the old toggle's "1" still reads as on.
    expect(html).toContain('var WEB_AUTO_KEY = "edgecoder.web.auto";');
    expect(html).toContain('saved === "auto" || saved === "1"');
    // Unavailable with a model that can't call tools; "needs cSats" noted, once per chat under a reply.
    expect(html).toContain("Web: unavailable with this model");
    expect(html).toContain('"needs cSats"');
    expect(html).toContain("function noteWebOffOnce(bubble, message)");
    expect(html).toContain("if (parsed.webOff) { webOff = parsed.webOff; refreshWebStatus(); }");
    expect(html).not.toContain("aria-pressed");
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
