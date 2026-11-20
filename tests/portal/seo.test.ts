import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerPortalPages } from "../../src/portal/pages/index.js";
import { faviconIco, llmsTxt, publicDocsUrl, robotsTxt, siteOrigin, sitemapXml } from "../../src/portal/pages/seo.js";
import { marketingHomeHtml } from "../../src/portal/pages/public.js";
import { staticSiteFiles } from "../../src/portal/static-site.js";

describe("technical SEO", () => {
  it("serves robots.txt, sitemap.xml, llms.txt and favicon.ico", async () => {
    const app = Fastify();
    registerPortalPages(app);
    const robots = await app.inject({ url: "/robots.txt" });
    expect(robots.statusCode).toBe(200);
    expect(robots.headers["content-type"]).toContain("text/plain");
    expect(robots.body).toContain("User-agent: *");
    expect(robots.body).toContain("Disallow: /portal");
    expect(robots.body).toMatch(/^Sitemap: https?:\/\/[^\s]+\/sitemap\.xml$/m);

    const sitemap = await app.inject({ url: "/sitemap.xml" });
    expect(sitemap.statusCode).toBe(200);
    expect(sitemap.headers["content-type"]).toContain("application/xml");
    for (const path of ["/", "/host", "/reserves", "/bluetooth", "/terms", "/privacy", "/acceptable-use", "/host-agreement"]) {
      expect(sitemap.body).toContain(`<loc>${siteOrigin()}${path}</loc>`);
    }
    // Every sitemap URL is a page the portal actually serves.
    for (const m of sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const path = new URL(m[1]!).pathname;
      const res = await app.inject({ url: path });
      expect(res.statusCode, path).toBe(200);
    }

    const llms = await app.inject({ url: "/llms.txt" });
    expect(llms.statusCode).toBe(200);
    expect(llms.body).toMatch(/^# EdgeCoder/);
    expect(llms.body).toContain("BUSL-1.1");
    expect(llms.body.toLowerCase()).not.toContain("open source");
    expect(llms.body).toContain("plaintext");

    const ico = await app.inject({ url: "/favicon.ico" });
    expect(ico.statusCode).toBe(200);
    expect(ico.headers["content-type"]).toBe("image/x-icon");
    expect(ico.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
  });

  it("builds a valid PNG-in-ICO file", () => {
    const ico = faviconIco();
    expect(ico.readUInt16LE(4)).toBe(2);
    for (let i = 0; i < 2; i++) {
      const size = ico.readUInt32LE(6 + 16 * i + 8);
      const offset = ico.readUInt32LE(6 + 16 * i + 12);
      expect(ico.subarray(offset, offset + 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(offset + size).toBeLessThanOrEqual(ico.length);
    }
  });

  it("adds canonical, Open Graph, Twitter and JSON-LD tags without changing the title", () => {
    const html = marketingHomeHtml(undefined, "https://edgecoder.io");
    expect(html).toContain("<title>EdgeCoder | Private AI Coding on Your Infrastructure</title>");
    expect(html).toContain('<link rel="canonical" href="https://edgecoder.io/" />');
    expect(html).toContain('<meta property="og:url" content="https://edgecoder.io/" />');
    expect(html).toContain('<meta property="og:title" content="EdgeCoder | Private AI Coding on Your Infrastructure" />');
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
    const ld = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
    expect(ld).not.toBeNull();
    const data = JSON.parse(ld![1]!);
    const types = data["@graph"].map((n: { "@type": string }) => n["@type"]);
    expect(types).toEqual(["Organization", "SoftwareApplication"]);
    expect(JSON.stringify(data)).not.toMatch(/aggregateRating|offers/);
  });

  it("uses the configured origin and skips a non-https docs URL", () => {
    expect(siteOrigin("https://example.test/some/path")).toBe("https://example.test");
    expect(siteOrigin("not a url")).toBe("https://edgecoder.io");
    expect(publicDocsUrl("http://127.0.0.1:5173")).toBeUndefined();
    expect(publicDocsUrl("https://docs.edgecoder.io")).toBe("https://docs.edgecoder.io/");
    expect(robotsTxt("https://example.test", undefined)).not.toContain("docs");
    expect(robotsTxt("https://example.test", "https://docs.example.test/")).toContain("Sitemap: https://docs.example.test/sitemap.xml");
    expect(sitemapXml("https://example.test")).toContain("<loc>https://example.test/</loc>");
    expect(llmsTxt("https://example.test", "https://docs.example.test/")).toContain("https://docs.example.test/guide/getting-started");
  });

  it("exports robots, sitemap and llms.txt to the static mirror", () => {
    const files = staticSiteFiles({ portalUrl: "https://edgecoder.io/" });
    expect(files["robots.txt"]).toContain("Sitemap: https://edgecoder.io/sitemap.xml");
    expect(files["sitemap.xml"]).toContain("<loc>https://edgecoder.io/reserves</loc>");
    expect(files["llms.txt"]).toContain("https://edgecoder.io/reserves");
    expect(files["index.html"]).toContain('<link rel="canonical" href="https://edgecoder.io/" />');
  });
});
