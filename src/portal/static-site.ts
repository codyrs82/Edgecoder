// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * Static mirror of the public pages (docs/edge-and-redundancy.md).
 *
 * The marketing home, legal and Bluetooth pages render with no request state, so they can be
 * exported as plain HTML and hosted on a static edge (Cloudflare Pages, GitHub Pages, IPFS). A
 * mirror keeps the front door reachable while the portal origin is down; everything that needs
 * the portal (sign-in, wallet, API) is redirected to the canonical portal URL via `_redirects`.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acceptableUseHtml, bluetoothPageHtml, hostAgreementHtml, marketingHomeHtml, privacyPolicyHtml, termsOfServiceHtml } from "./pages/public.js";
import type { PublicPricing } from "./public-pricing.js";
import { THEME_JS, portalTokensCss } from "./assets.js";
import { CSP_NONCE } from "./csp-nonce.js";

export interface StaticSiteOptions {
  /** Canonical portal origin that dynamic paths redirect to, e.g. https://edgecoder.io */
  portalUrl: string;
  /** Pricing snapshot to bake in (default: reference USD prices, no sats). */
  pricing?: PublicPricing;
}

/** Paths that only the live portal can serve; the mirror forwards them (Cloudflare Pages `_redirects`). */
export const MIRROR_REDIRECT_PREFIXES = ["/host", "/portal", "/auth", "/wallet", "/nodes", "/me", "/internal", "/.well-known"];

/**
 * A static host sends one fixed policy, so a per-request nonce is not possible: drop the nonce
 * attribute from the exported page (a fixed nonce is no protection) and return the CSP hash of
 * each <style> block, which pins the policy to exactly the styles this export contains.
 */
export function withStyleHashes(html: string): { html: string; hashes: string[] } {
  const out = html.split(` nonce="${CSP_NONCE}"`).join("");
  const hashes: string[] = [];
  for (const m of out.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    hashes.push(`'sha256-${createHash("sha256").update(m[1]!, "utf8").digest("base64")}'`);
  }
  return { html: out, hashes };
}

export function staticSiteFiles(opts: StaticSiteOptions): Record<string, string> {
  const origin = opts.portalUrl.replace(/\/$/, "");
  const pages = {
    "index.html": withStyleHashes(marketingHomeHtml(opts.pricing)),
    "privacy/index.html": withStyleHashes(privacyPolicyHtml()),
    "terms/index.html": withStyleHashes(termsOfServiceHtml()),
    "acceptable-use/index.html": withStyleHashes(acceptableUseHtml()),
    "host-agreement/index.html": withStyleHashes(hostAgreementHtml()),
    "bluetooth/index.html": withStyleHashes(bluetoothPageHtml()),
  };
  const styleHashes = [...new Set(Object.values(pages).flatMap((p) => p.hashes))];
  const redirects = MIRROR_REDIRECT_PREFIXES.flatMap((p) => [`${p} ${origin}${p} 302`, `${p}/* ${origin}${p}/:splat 302`]).join("\n") + "\n";
  const headers = [
    "/*",
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    "  Referrer-Policy: strict-origin-when-cross-origin",
    "  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload",
    `  Content-Security-Policy: default-src 'self'; style-src 'self' ${styleHashes.join(" ")}; img-src 'self' data: https:; connect-src 'self' ${origin}; frame-ancestors 'none'`,
    "",
  ].join("\n");
  return {
    "index.html": pages["index.html"].html,
    "privacy/index.html": pages["privacy/index.html"].html,
    "terms/index.html": pages["terms/index.html"].html,
    "acceptable-use/index.html": pages["acceptable-use/index.html"].html,
    "host-agreement/index.html": pages["host-agreement/index.html"].html,
    "bluetooth/index.html": pages["bluetooth/index.html"].html,
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
