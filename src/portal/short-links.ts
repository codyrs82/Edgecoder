// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Short links for posts on X: edgecoder.io/x/<campaign> redirects to a public page with the
 * campaign's UTM tags, so a post shows a clean link and visits stay attributable.
 *
 *   /x/web-chat       → /?utm_source=x&utm_medium=social&utm_campaign=web-chat
 *   /x/reserves       → /reserves?…&utm_campaign=reserves
 *   /x/reserves-sats  → /reserves?…&utm_campaign=reserves-sats
 *
 * The campaign's first word picks the page when it names one (SHORT_LINK_PAGES); anything else
 * lands on the homepage. Only lower-case letters, digits and dashes; anything else is a 404.
 */

/** Public pages a short link may land on, by the campaign's first word. */
export const SHORT_LINK_PAGES: Readonly<Record<string, string>> = {
  reserves: "/reserves",
  bluetooth: "/bluetooth",
};

const CAMPAIGN_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Where /x/<campaign> goes, or null when the campaign isn't a valid short-link name. */
export function shortLinkTarget(campaign: string, medium: "social" | "paid" = "social"): string | null {
  if (!CAMPAIGN_RE.test(campaign)) return null;
  const page = SHORT_LINK_PAGES[campaign.split("-")[0]!] ?? "/";
  const q = new URLSearchParams({ utm_source: "x", utm_medium: medium, utm_campaign: campaign });
  return `${page}?${q.toString()}`;
}
