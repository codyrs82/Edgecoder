// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * Technical SEO for the public site: /robots.txt, /sitemap.xml, /llms.txt, /favicon.ico and the
 * homepage's canonical, Open Graph, Twitter and JSON-LD tags.
 *
 * Cloudflare's managed robots.txt prepends its content-signals comment block to whatever the
 * origin serves, so the rules here end up below that block in production.
 */
import type { FastifyInstance } from "fastify";
import { escapeHtml } from "./escape.js";
import { DOCS_SITE_URL, GITHUB_REPO_URL } from "./urls.js";
import { LEGAL_PAGES } from "./public.js";
import { ICON_128_PNG_BASE64, ICON_32_PNG_BASE64 } from "./favicon-data.js";

export const DEFAULT_SITE_ORIGIN = "https://edgecoder.io";

/** The public site origin (PORTAL_PUBLIC_URL), falling back to edgecoder.io. */
export function siteOrigin(raw: string | undefined = process.env.PORTAL_PUBLIC_URL): string {
  try {
    return raw ? new URL(raw).origin : DEFAULT_SITE_ORIGIN;
  } catch {
    return DEFAULT_SITE_ORIGIN;
  }
}

/** The docs site URL with a trailing slash, or undefined when it is not a public https URL (dev default is localhost). */
export function publicDocsUrl(raw: string = DOCS_SITE_URL): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return undefined;
    return u.href.endsWith("/") ? u.href : `${u.href}/`;
  } catch {
    return undefined;
  }
}

/** Public, indexable pages served by the portal (registerPublicPages and registerHostPage). */
export function sitemapPaths(): string[] {
  return ["/", "/host", "/reserves", "/bluetooth", ...Object.values(LEGAL_PAGES).map((p) => p.path)];
}

/** App, API and account paths that are useless (or private) in search results. */
export const ROBOTS_DISALLOW: readonly string[] = [
  "/portal",
  "/auth/",
  "/wallet/",
  "/nodes/",
  "/me",
  "/internal/",
  "/admin/",
  "/ios/",
  "/dashboard/",
  "/coordinator/",
  "/network/",
  "/v1/",
  "/reserves.json",
];

export function robotsTxt(origin: string = siteOrigin(), docsUrl: string | undefined = publicDocsUrl()): string {
  const lines = [
    "# EdgeCoder robots rules. AI-training content signals are pending the owner's decision.",
    "User-agent: *",
    "Allow: /",
    ...ROBOTS_DISALLOW.map((p) => `Disallow: ${p}`),
    "",
    `Sitemap: ${origin}/sitemap.xml`,
  ];
  if (docsUrl) lines.push(`Sitemap: ${docsUrl}sitemap.xml`);
  return lines.join("\n") + "\n";
}

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export function sitemapXml(origin: string = siteOrigin()): string {
  const urls = sitemapPaths().map((p) => `  <url><loc>${xmlEscape(origin + p)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/** /llms.txt (llmstxt.org): a short factual summary for AI agents, from the README. */
export function llmsTxt(origin: string = siteOrigin(), docsUrl: string | undefined = publicDocsUrl()): string {
  const docs = docsUrl ?? "https://docs.edgecoder.io/";
  return `# EdgeCoder

> AI coding platform built on local LLMs: your own machines first (Ollama or llama.cpp), and a network of approved hosts behind EdgeCoder's coordinators when you need more compute. Network compute is priced and settled in Bitcoin.

- Local work runs on your own machines and does not leave them.
- Work sent to the network goes through a coordinator to agents on approved hosts. The coordinator sees network work in plaintext.
- Compute is priced in cSats (1 cSat = 1 sat), bought with Bitcoin over Lightning. Hosts receive 95% of each compute payment; the network fee is 5%.
- A hosted API at ${origin}/v1 is OpenAI- and Anthropic-compatible and uses \`eck_\` API keys.
- Clients: web portal, desktop app (macOS and Windows), iOS app, VS Code extension, and a terminal agent (\`edgecoder code\`).
- Source-available under the Business Source License 1.1 (BUSL-1.1).
- Hosting is by invitation during early access.

## Docs

- [Getting started](${docs}guide/getting-started): set up machines, models, funds and tools
- [How EdgeCoder works](${docs}guide/how-edgecoder-works)
- [Buy cSats](${docs}guide/buy-csats): pay for network compute
- [IDE integration](${docs}guide/ide-integration): VS Code, Cursor, Windsurf

## Site

- [Pricing](${origin}/#market): live sats-per-hour rate per compute class
- [Proof of reserves](${origin}/reserves) ([JSON](${origin}/reserves.json))
- [Host with us](${origin}/host)
- [Terms of Service](${origin}/terms), [Privacy Policy](${origin}/privacy), [Acceptable Use](${origin}/acceptable-use), [Host Agreement](${origin}/host-agreement)
- [Source code](${GITHUB_REPO_URL})
`;
}

/** /favicon.ico: an ICO file holding the app icon's 32px and 128px PNGs (PNG-in-ICO, Vista+). */
export function faviconIco(): Buffer {
  const images = [
    { size: 32, png: Buffer.from(ICON_32_PNG_BASE64, "base64") },
    { size: 128, png: Buffer.from(ICON_128_PNG_BASE64, "base64") },
  ];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size, 0); // width (<256)
    e.writeUInt8(size, 1); // height
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/** Canonical, Open Graph, Twitter card and JSON-LD tags for the homepage. */
export function homeSeoHeadTags(opts: { title: string; description: string; origin?: string }): string {
  const origin = opts.origin ?? siteOrigin();
  const url = `${origin}/`;
  const t = escapeHtml(opts.title);
  const d = escapeHtml(opts.description);
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", "@id": `${url}#org`, name: "EdgeCoder", url, logo: `${origin}/favicon.ico`, sameAs: [GITHUB_REPO_URL] },
      {
        "@type": "SoftwareApplication",
        name: "EdgeCoder",
        url,
        description: opts.description,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "macOS, Windows, iOS",
        publisher: { "@id": `${url}#org` },
      },
    ],
  };
  // "<" is escaped so the JSON can never close the script element. A JSON-LD block is data the
  // browser never executes, so CSP does not apply to it and it carries no nonce.
  const ld = JSON.stringify(jsonLd).replace(/</g, "\\u003c");
  return `<link rel="canonical" href="${escapeHtml(url)}" />
      <link rel="icon" href="/favicon.ico" sizes="32x32 128x128" />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="EdgeCoder" />
      <meta property="og:title" content="${t}" />
      <meta property="og:description" content="${d}" />
      <meta property="og:url" content="${escapeHtml(url)}" />
      <meta name="twitter:card" content="summary" />
      <meta name="twitter:title" content="${t}" />
      <meta name="twitter:description" content="${d}" />
      <script type="application/ld+json">${ld}</script>`;
}

export function registerSeoRoutes(app: FastifyInstance): void {
  const ico = faviconIco();
  app.get("/robots.txt", async (_req, reply) =>
    reply.type("text/plain; charset=utf-8").header("cache-control", "public, max-age=3600").send(robotsTxt()));
  app.get("/sitemap.xml", async (_req, reply) =>
    reply.type("application/xml; charset=utf-8").header("cache-control", "public, max-age=3600").send(sitemapXml()));
  app.get("/llms.txt", async (_req, reply) =>
    reply.type("text/plain; charset=utf-8").header("cache-control", "public, max-age=3600").send(llmsTxt()));
  app.get("/favicon.ico", async (_req, reply) =>
    reply.type("image/x-icon").header("cache-control", "public, max-age=86400").send(ico));
}
