import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText, PAGE_TEXT_MAX_CHARS, pdfToText } from "../../src/web-tool/extract.js";

describe("htmlToText", () => {
  it("keeps the title, headings and paragraphs; drops scripts, styles, navigation and chrome", () => {
    const html = `<!doctype html><html><head><title>Rust 1.80 released</title><script>var x = "<p>not text</p>";</script><style>.a{color:red}</style></head>
      <body>
        <header><a href="/">Logo</a> Sign in</header>
        <nav><ul><li>Home</li><li>Blog</li></ul></nav>
        <!-- a comment -->
        <h1>Announcing Rust 1.80</h1>
        <p>The Rust team is happy to announce a new version.</p>
        <h2>What's in 1.80</h2>
        <ul><li>LazyCell &amp; LazyLock</li><li>Exclusive ranges</li></ul>
        <table><tr><th>Version</th><th>Date</th></tr><tr><td>1.80</td><td>July</td></tr></table>
        <form><input name="q"><button>Search</button></form>
        <aside>Related posts</aside>
        <footer>© 2024</footer>
        <noscript>Enable JS</noscript>
      </body></html>`;
    const r = htmlToText(html);
    expect(r.title).toBe("Rust 1.80 released");
    expect(r.text).toContain("# Announcing Rust 1.80");
    expect(r.text).toContain("## What's in 1.80");
    expect(r.text).toContain("The Rust team is happy to announce a new version.");
    expect(r.text).toContain("- LazyCell & LazyLock");
    expect(r.text).toContain("Version | Date");
    for (const gone of ["not text", "color:red", "Sign in", "Blog", "a comment", "Search", "Related posts", "© 2024", "Enable JS"]) expect(r.text).not.toContain(gone);
    expect(r.truncated).toBe(false);
  });

  it("prefers the page's <main> or <article> when it has real text", () => {
    const main = "Main story. ".repeat(30);
    const r = htmlToText(`<body><div>Cookie banner and sidebar junk</div><main><p>${main}</p></main></body>`);
    expect(r.text).toContain("Main story.");
    expect(r.text).not.toContain("Cookie banner");
  });

  it("falls back to the first heading for a title, decodes entities and caps the text", () => {
    expect(htmlToText("<h1>Only &lt;heading&gt;</h1><p>x</p>").title).toBe("Only <heading>");
    expect(decodeEntities("&#x41;&#66;&nbsp;&mdash;&unknown;")).toBe("AB —&unknown;");
    const long = htmlToText(`<p>${"word ".repeat(10_000)}</p>`);
    expect(long.truncated).toBe(true);
    expect(long.text.length).toBeLessThanOrEqual(PAGE_TEXT_MAX_CHARS + 60);
  });
});

describe("pdfToText", () => {
  it("returns null for something that isn't a PDF or has no readable text", () => {
    expect(pdfToText(Buffer.from("<html></html>"))).toBeNull();
    expect(pdfToText(Buffer.from("%PDF-1.4\n1 0 obj << /Length 3 >>\nstream\nabc\nendstream\n"))).toBeNull();
  });
});
