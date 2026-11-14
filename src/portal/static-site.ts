// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * Static mirror of the public pages (docs/edge-and-redundancy.md).
 *
 * The marketing home, privacy and terms pages render with no request state, so they can be
 * exported as plain HTML and hosted on a static edge (Cloudflare Pages, GitHub Pages, IPFS). A
 * mirror keeps the front door reachable while the portal origin is down; everything that needs
 * the portal (sign-in, wallet, API) is redirected to the canonical portal URL via `_redirects`.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { marketingHomeHtml, privacyPolicyHtml, termsOfServiceHtml } from "./pages/public.js";
import type { PublicPricing } from "./public-pricing.js";
import { THEME_JS, portalTokensCss } from "./assets.js";

export interface StaticSiteOptions {
  /** Canonical portal origin that dynamic paths redirect to, e.g. https://edgecoder.io */
  portalUrl: string;
  /** Pricing snapshot to bake in (default: reference USD prices, no sats). */
  pricing?: PublicPricing;
}

/** Paths that only the live portal can serve; the mirror forwards them (Cloudflare Pages `_redirects`). */
export const MIRROR_REDIRECT_PREFIXES = ["/portal", "/auth", "/wallet", "/nodes", "/me", "/internal", "/.well-known"];

export function staticSiteFiles(opts: StaticSiteOptions): Record<string, string> {
  const origin = opts.portalUrl.replace(/\/$/, "");
  const redirects = MIRROR_REDIRECT_PREFIXES.flatMap((p) => [`${p} ${origin}${p} 302`, `${p}/* ${origin}${p}/:splat 302`]).join("\n") + "\n";
  const headers = [
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload",
    `  Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ${origin}; frame-ancestors 'none'`,
    "",
  ].join("\n");
  return {
    "index.html": marketingHomeHtml(opts.pricing),
    "privacy/index.html": privacyPolicyHtml(),
    "terms/index.html": termsOfServiceHtml(),
    // #89: the pages link these (with a ?v= hash, which static hosts ignore).
    "assets/tokens.css": portalTokensCss(),
    "assets/theme.js": THEME_JS,
    "healthz": "ok\n",
    _redirects: redirects,
    _headers: headers,
  };
}

export async function exportStaticSite(outDir: string, opts: StaticSiteOptions): Promise<string[]> {
  const files = staticSiteFiles(opts);
  const written: string[] = [];
  for (const [rel, body] of Object.entries(files)) {
    const full = join(outDir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body, "utf8");
    written.push(full);
  }
  return written;
}
