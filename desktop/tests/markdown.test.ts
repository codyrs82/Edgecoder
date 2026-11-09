import { describe, expect, it } from "vitest";
import { renderMarkdown, safeLinkUrl } from "../src/lib/markdown";

/** Tag names that appear as real markup (not escaped text) in the output. */
const tags = (html: string) => [...html.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => m[1].toLowerCase());

describe("chat markdown from model output", () => {
  it("shows raw HTML as text, never as markup", () => {
    const evil = [
      "<style>.approval-bar{display:none}</style>",
      '<a href="https://attacker.example" style="position:fixed;inset:0">Sign in again</a>',
      '<form action="https://attacker.example"><input name=p></form>',
      '<iframe src="http://127.0.0.1:4306/x"></iframe>',
      '<meta http-equiv="refresh" content="0;url=https://attacker.example">',
      '<base href="https://attacker.example/">',
      '<img src=x onerror="alert(1)">',
      "<object data=x></object><script>alert(1)</script>",
    ];
    for (const src of [...evil, evil.join("\n\n"), `text ${evil[1]} inline`]) {
      const html = renderMarkdown(src);
      for (const t of ["style", "form", "input", "iframe", "meta", "base", "img", "object", "script"]) expect(tags(html), src).not.toContain(t);
      expect(html).not.toMatch(/<a [^>]*style=/);
    }
    expect(renderMarkdown("<b>hi</b>")).toContain("&lt;b&gt;hi&lt;/b&gt;");
  });

  it("keeps only http, https and mailto links", () => {
    expect(renderMarkdown("[docs](https://example.com/a?b=1&c=2)")).toContain('<a href="https://example.com/a?b=1&amp;c=2" data-external-link');
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "/settings", "tauri://localhost/x", "file:///etc/passwd"]) {
      const html = renderMarkdown(`[click](${bad})`);
      expect(tags(html), bad).not.toContain("a");
      expect(html).toContain("click");
    }
    expect(tags(renderMarkdown("<https://example.com>"))).toContain("a");
    expect(safeLinkUrl("  https://x.example ")).toBe("https://x.example/");
    expect(safeLinkUrl("JaVaScRiPt:alert(1)")).toBeNull();
  });

  it("does not load images, and escapes link titles", () => {
    const html = renderMarkdown('![pic](https://tracker.example/p.png) [t](https://x.example "a\\" onmouseover=\\"x")');
    expect(tags(html)).not.toContain("img");
    expect(html).not.toMatch(/" onmouseover=/);
  });

  it("escapes the code fence language and the code", () => {
    const html = renderMarkdown('```js" onclick="x"><style>\n<b>&amp;</b>\n```');
    expect(tags(html)).not.toContain("style");
    expect(tags(html)).not.toContain("b");
    expect(html).not.toContain('onclick="x"');
    expect(html).toContain("&lt;b&gt;&amp;amp;&lt;/b&gt;");
    expect(renderMarkdown("```ts\nconst a = 1;\n```")).toContain('data-lang="ts"');
  });

  it("still renders ordinary markdown and plans", () => {
    const html = renderMarkdown("# Title\n\n**bold** and `code`\n\n- one\n- two");
    expect(tags(html)).toEqual(expect.arrayContaining(["h1", "strong", "code", "ul", "li"]));
    expect(renderMarkdown('```plan\n[{"description":"<b>step</b>","status":"completed"}]\n```')).toContain("&lt;b&gt;step");
  });
});
