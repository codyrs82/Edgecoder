// #27 audit follow-up: the review diff's highlighter used to chain regex replaces over its own
// output, so the keyword rule matched the "class" of an earlier span and the diff showed markup
// as text. These run the function the page actually ships (cut from the rendered script).
import vm from "node:vm";
import Fastify from "fastify";
import { beforeAll, describe, expect, it } from "vitest";
import { registerReviewsPage } from "../../src/portal/pages/reviews.js";

let highlight: (text: unknown) => string;

beforeAll(async () => {
  const app = Fastify();
  registerReviewsPage(app);
  const html = (await app.inject({ url: "/portal/reviews" })).body;
  await app.close();
  const from = html.indexOf("function escapeCodeText");
  const to = html.indexOf("function computeDiff");
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  const ctx: { syntaxHighlight?: (text: unknown) => string } = {};
  vm.runInNewContext(`${html.slice(from, to)}\nthis.syntaxHighlight = syntaxHighlight;`, ctx);
  highlight = ctx.syntaxHighlight!;
});

/** What the reader sees: the markup with every highlighter span removed, entities decoded. */
function visibleText(markup: string): string {
  const stripped = markup.replace(/<span class="syntax-(?:comment|string|number|keyword|builtin|function)">|<\/span>/g, "");
  expect(stripped, markup).not.toMatch(/[<>]/); // nothing but those spans is markup
  return stripped.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

describe("review diff syntax highlighting", () => {
  const samples = [
    "  # old",
    "// TODO: return 1 if class is new",
    "return x+1",
    "const total = parseInt(input, 10) + 2.5;",
    "if (a < b && c > d) { print(\"<b>&amp;</b>\") }",
    "s = 'it\\'s # not a comment' # but this is",
    "class Foo: def bar(self): return None",
    "<span class=\"syntax-keyword\">x</span>",
    "</span><script>alert(1)</script>",
    "",
  ];

  it("shows the line unchanged: spans only wrap text, they never add or lose any", () => {
    for (const line of samples) expect(visibleText(highlight(line)), line).toBe(line);
  });

  it("spans are balanced and never nested", () => {
    for (const line of samples) {
      const tags = highlight(line).match(/<span class="syntax-[a-z]+">|<\/span>/g) ?? [];
      tags.forEach((tag, i) => expect(tag.startsWith("<span") ? "open" : "close", `${line} #${i}`).toBe(i % 2 === 0 ? "open" : "close"));
      expect(tags.length % 2, line).toBe(0);
    }
  });

  it("a comment is one span, keywords and numbers inside it are left alone", () => {
    expect(highlight("  # old")).toBe('  <span class="syntax-comment"># old</span>');
    expect(highlight("x = 1 // return 2")).toBe('x = <span class="syntax-number">1</span> <span class="syntax-comment">// return 2</span>');
  });

  it("classifies keywords, built-ins, numbers, calls and strings", () => {
    expect(highlight("return x+1")).toBe('<span class="syntax-keyword">return</span> x+<span class="syntax-number">1</span>');
    expect(highlight("len(items)")).toBe('<span class="syntax-builtin">len</span>(items)');
    expect(highlight("doWork (x)")).toBe('<span class="syntax-function">doWork</span> (x)');
    expect(highlight('say("hi") + \'#1\'')).toBe('<span class="syntax-function">say</span>(<span class="syntax-string">"hi"</span>) + <span class="syntax-string">\'#1\'</span>');
    expect(highlight("x1 = returned")).toBe("x1 = returned"); // whole words only
  });

  it("escapes code that looks like markup, inside and outside tokens", () => {
    expect(highlight("a<b>c")).toBe("a&lt;b&gt;c");
    expect(highlight('"<img src=x>"')).toBe('<span class="syntax-string">"&lt;img src=x&gt;"</span>');
    expect(highlight("# <script>&")).toBe('<span class="syntax-comment"># &lt;script&gt;&amp;</span>');
  });

  it("tolerates missing code", () => {
    expect(highlight(null)).toBe("");
    expect(highlight(undefined)).toBe("");
  });
});
