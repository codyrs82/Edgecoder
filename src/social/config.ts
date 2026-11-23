// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envInt, envUrl, loadConfig } from "../common/config.js";

/*
 * Brand-account posting (src/social): the X and Nostr credentials and the env-level send switch.
 * The portal spreads these into its schema (src/portal/config.ts). Documented in
 * site-docs/reference/environment-variables.md ("Brand-account posting").
 *
 * Nothing is sent anywhere unless SOCIAL_POSTING_ENABLED is exactly "1" AND the admin switch on
 * Settings > Social posts is on (it starts paused).
 */
export const socialEnv = {
  /** Exactly "1" lets approved posts leave the portal (X, Nostr). Anything else: drafts only. */
  SOCIAL_POSTING_ENABLED: z.string().optional(),
  /** X API v2 OAuth 1.0a user-context credentials of the brand account. */
  X_API_KEY: z.string().optional(),
  X_API_SECRET: z.string().optional(),
  X_ACCESS_TOKEN: z.string().optional(),
  X_ACCESS_TOKEN_SECRET: z.string().optional(),
  /** The brand account's Nostr secret key (64 hex or nsec1...). Unset: Nostr is skipped, X still posts. */
  NOSTR_BRAND_NSEC: z.string().optional(),
  /** Comma-separated wss:// relays for the Nostr cross-post. */
  SOCIAL_NOSTR_RELAYS: z.string().optional(),
  /** How often the drafting job runs (due posts are checked every minute regardless, src/portal/social.ts). */
  SOCIAL_TICK_MINUTES: envInt(15, { min: 1, max: 1_440 }),
  /** The docs sitemap new guides are detected from; default: the public docs site's /sitemap.xml. */
  SOCIAL_DOCS_SITEMAP_URL: envUrl()
};

export const DEFAULT_SOCIAL_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

const schema = z.object(socialEnv);

export interface XCredentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

export interface SocialConfig {
  /** SOCIAL_POSTING_ENABLED === "1". */
  sendEnabled: boolean;
  x: XCredentials | null;
  /** Raw NOSTR_BRAND_NSEC (hex or nsec); null when unset. Never logged or returned. */
  nostrSecret: string | null;
  relays: string[];
  tickMs: number;
  /** SOCIAL_DOCS_SITEMAP_URL; null: the portal fills in the public docs site's sitemap. */
  docsSitemapUrl: string | null;
  /** Where the weekly report links (the portal passes its public origin); null: no link. */
  siteUrl: string | null;
}

export function socialConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SocialConfig {
  const raw = loadConfig("social", schema, env);
  const s = (v: string | undefined) => (v ?? "").trim();
  const x = [s(raw.X_API_KEY), s(raw.X_API_SECRET), s(raw.X_ACCESS_TOKEN), s(raw.X_ACCESS_TOKEN_SECRET)];
  const relayList = s(raw.SOCIAL_NOSTR_RELAYS)
    ? s(raw.SOCIAL_NOSTR_RELAYS)
        .split(",")
        .map((r) => r.trim())
        .filter((r) => /^wss:\/\//i.test(r))
    : DEFAULT_SOCIAL_RELAYS;
  return {
    sendEnabled: s(raw.SOCIAL_POSTING_ENABLED) === "1",
    x: x.every(Boolean) ? { consumerKey: x[0]!, consumerSecret: x[1]!, token: x[2]!, tokenSecret: x[3]! } : null,
    nostrSecret: s(raw.NOSTR_BRAND_NSEC) || null,
    relays: [...new Set(relayList)],
    tickMs: raw.SOCIAL_TICK_MINUTES * 60_000,
    docsSitemapUrl: raw.SOCIAL_DOCS_SITEMAP_URL ?? null,
    siteUrl: null
  };
}
