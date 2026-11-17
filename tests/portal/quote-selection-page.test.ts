import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";

async function page(url: string): Promise<string> {
  const app = Fastify();
  registerPortalPages(app);
  const res = await app.inject({ url });
  await app.close();
  expect(res.statusCode, url).toBe(200);
  return res.body;
}

describe("Add to chat on the portal's Chat and Bots pages", () => {
  for (const [url, scroll, input] of [["/portal/chat", "chatScroll", "chatInput"], ["/portal/bots", "bpScroll", "bpInput"]]) {
    it(`${url}: message bodies are quotable and the chip is wired to the pane and composer`, async () => {
      const html = await page(url);
      expect(html).toContain("data-quotable");
      expect(html).toContain("function quotableSelection(");
      expect(html).toContain("function quoteMarkdown(");
      expect(html).toContain(`document.getElementById("${scroll}")`);
      expect(html).toContain(`document.getElementById("${input}")`);
      expect(html).toContain('"Add selection to chat"');
      expect(html).toContain(".quote-chip {");
      // Every inline script still parses.
      for (const m of html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)) expect(() => new Function(m[1])).not.toThrow();
    });
  }
});
