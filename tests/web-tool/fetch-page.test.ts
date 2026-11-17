import { describe, expect, it, vi } from "vitest";
import { deflateSync } from "node:zlib";
import { fetchPage, PageFetchError, WEB_TOOL_USER_AGENT, type PageTransport } from "../../src/web-tool/fetch-page.js";

const DNS: Record<string, string> = { "example.com": "93.184.216.34", "news.example": "93.184.216.35", "evil.example": "10.0.0.7", "meta.example": "169.254.169.254" };
const resolver = vi.fn(async (host: string) => {
  const a = DNS[host];
  if (!a) throw new Error("ENOTFOUND");
  return [{ address: a, family: 4 }];
});

function body(text: string | Buffer): AsyncIterable<Uint8Array> {
  const buf = typeof text === "string" ? Buffer.from(text) : text;
  return (async function* () {
    for (let i = 0; i < buf.length; i += 64 * 1024) yield buf.subarray(i, i + 64 * 1024);
  })();
}

type Reply = { status: number; headers?: Record<string, string>; body?: string | Buffer };
function transport(pages: Record<string, Reply>): PageTransport & { calls: Array<{ url: string; address: string; ua: string }> } {
  const calls: Array<{ url: string; address: string; ua: string }> = [];
  const t = (async (url, pin, opts) => {
    calls.push({ url: url.toString(), address: pin.address, ua: opts.headers["user-agent"] });
    const r = pages[url.toString()] ?? { status: 404, body: "nope" };
    return { status: r.status, headers: r.headers ?? {}, body: body(r.body ?? ""), close: async () => {} };
  }) as PageTransport & { calls: typeof calls };
  t.calls = calls;
  return t;
}

const HTML = "<html><head><title>Example &amp; Co</title><style>p{}</style></head><body><nav>Home | About</nav><h1>Hello</h1><p>World of <b>text</b>.</p><script>steal()</script></body></html>";

describe("fetchPage", () => {
  it("fetches HTML through the pinned address with the EdgeCoder user agent and returns title and text", async () => {
    const t = transport({ "https://example.com/": { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: HTML } });
    const page = await fetchPage("https://example.com/", { resolve: resolver, transport: t });
    expect(page.title).toBe("Example & Co");
    expect(page.text).toContain("# Hello");
    expect(page.text).toContain("World of text.");
    expect(page.text).not.toContain("steal");
    expect(page.text).not.toContain("Home | About");
    expect(t.calls).toEqual([{ url: "https://example.com/", address: "93.184.216.34", ua: WEB_TOOL_USER_AGENT }]);
    expect(WEB_TOOL_USER_AGENT).toBe("EdgeCoderWebTool/1.0 (+https://edgecoder.io)");
    expect(WEB_TOOL_USER_AGENT).not.toMatch(/@/);
  });

  it("follows a redirect to another public host, checking it again", async () => {
    const t = transport({
      "https://example.com/old": { status: 301, headers: { location: "https://news.example/new" } },
      "https://news.example/new": { status: 200, headers: { "content-type": "text/plain" }, body: "fresh" },
    });
    const page = await fetchPage("https://example.com/old", { resolve: resolver, transport: t });
    expect(page.url).toBe("https://news.example/new");
    expect(page.text).toBe("fresh");
    expect(t.calls.map((c) => c.address)).toEqual(["93.184.216.34", "93.184.216.35"]);
  });

  it("refuses a redirect into a private address (by name or literal), and never connects there", async () => {
    for (const location of ["https://evil.example/admin", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://localhost:80/", "https://meta.example/"]) {
      const t = transport({ "https://example.com/r": { status: 302, headers: { location } } });
      await expect(fetchPage("https://example.com/r", { resolve: resolver, transport: t }), location).rejects.toMatchObject({ code: "blocked_url" });
      expect(t.calls.map((c) => c.url)).toEqual(["https://example.com/r"]);
    }
  });

  it("DNS rebinding: the host is resolved once per hop and the request goes to that address, whatever DNS says next", async () => {
    let n = 0;
    const flipping = vi.fn(async () => [{ address: n++ === 0 ? "93.184.216.34" : "127.0.0.1", family: 4 }]);
    const t = transport({ "https://rebind.example/": { status: 200, headers: { "content-type": "text/plain" }, body: "ok" } });
    const page = await fetchPage("https://rebind.example/", { resolve: flipping, transport: t });
    expect(page.text).toBe("ok");
    expect(flipping).toHaveBeenCalledTimes(1);
    expect(t.calls[0].address).toBe("93.184.216.34");
  });

  it("refuses a host that resolves to a private address", async () => {
    const t = transport({});
    await expect(fetchPage("https://evil.example/", { resolve: resolver, transport: t })).rejects.toMatchObject({ code: "blocked_url" });
    expect(t.calls).toEqual([]);
  });

  it("stops after 5 redirects", async () => {
    const pages: Record<string, Reply> = {};
    for (let i = 0; i < 7; i++) pages[`https://example.com/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
    await expect(fetchPage("https://example.com/0", { resolve: resolver, transport: transport(pages) })).rejects.toThrow(/too many times/);
  });

  it("allows only HTML, text, JSON and PDF", async () => {
    const t = transport({
      "https://example.com/img": { status: 200, headers: { "content-type": "image/png" }, body: "x" },
      "https://example.com/j": { status: 200, headers: { "content-type": "application/json" }, body: '{"a":[1,2]}' },
      "https://example.com/zip": { status: 200, headers: { "content-type": "application/zip" }, body: "x" },
    });
    await expect(fetchPage("https://example.com/img", { resolve: resolver, transport: t })).rejects.toMatchObject({ code: "unsupported_type" });
    await expect(fetchPage("https://example.com/zip", { resolve: resolver, transport: t })).rejects.toMatchObject({ code: "unsupported_type" });
    expect((await fetchPage("https://example.com/j", { resolve: resolver, transport: t })).text).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
  });

  it("reads at most 2 MB of a page (the rest is cut) and refuses a PDF larger than that", async () => {
    const big = "a ".repeat(1_500_000); // 3 MB
    const t = transport({
      "https://example.com/big": { status: 200, headers: { "content-type": "text/plain" }, body: big },
      "https://example.com/big.pdf": { status: 200, headers: { "content-type": "application/pdf" }, body: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(3 * 1024 * 1024)]) },
    });
    const page = await fetchPage("https://example.com/big", { resolve: resolver, transport: t });
    expect(page.truncated).toBe(true);
    expect(page.text.length).toBeLessThan(21_000);
    await expect(fetchPage("https://example.com/big.pdf", { resolve: resolver, transport: t })).rejects.toMatchObject({ code: "too_large" });
  });

  it("gives up after the time limit", async () => {
    const slow: PageTransport = (_u, _p, opts) =>
      new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(fetchPage("https://example.com/", { resolve: resolver, transport: slow, timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("reports HTTP errors", async () => {
    await expect(fetchPage("https://example.com/missing", { resolve: resolver, transport: transport({}) })).rejects.toBeInstanceOf(PageFetchError);
  });

  it("reads the text of a simple PDF", async () => {
    const content = Buffer.from("BT /F1 12 Tf 72 712 Td (Quarterly report: revenue grew 12 percent.) Tj 0 -14 Td [(Costs) -300 (fell.)] TJ ET");
    const z = deflateSync(content);
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.4\n1 0 obj << /Title (Q3 Report) >> endobj\n2 0 obj << /Length ${z.length} /Filter /FlateDecode >>\nstream\n`), z, Buffer.from("\nendstream\nendobj\n%%EOF")]);
    const t = transport({ "https://example.com/q3.pdf": { status: 200, headers: { "content-type": "application/pdf" }, body: pdf } });
    const page = await fetchPage("https://example.com/q3.pdf", { resolve: resolver, transport: t });
    expect(page.title).toBe("Q3 Report");
    expect(page.text).toContain("Quarterly report: revenue grew 12 percent.");
    expect(page.text).toContain("Costs fell.");
  });
});
