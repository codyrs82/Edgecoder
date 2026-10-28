// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envInt, envUrl } from "../common/config.js";

/*
 * #15: portal (port 4310) configuration, validated once at startup. Field-level checks
 * (integers, URLs, enums) fail the process on import with every problem listed. Production-only
 * requirements are in portalProductionProblems(), run from validatePortalSecurityConfig() at
 * listen time. Documented in site-docs/reference/environment-variables.md.
 *
 * Not yet here: PORTAL_TRUSTED_ORIGINS / PORTAL_CONNECT_ORIGINS / PORTAL_CSP_ENFORCE and the
 * proxy setting, which #125 is changing; they move in once #125 merges.
 */

const optStr = z.string().optional();
const ttl = (def: number) => envInt(def, { min: 1_000, max: 31 * 24 * 60 * 60 * 1000 });

export const portalConfigSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORTAL_PUBLIC_URL: envUrl("http://127.0.0.1:4310"),
  PORTAL_SERVICE_TOKEN: optStr,
  PORTAL_EXTERNAL_HTTP_TIMEOUT_MS: envInt(7000, { min: 100, max: 120_000 }),
  RESEND_API_KEY: optStr,
  RESEND_FROM_EMAIL: optStr,
  CONTROL_PLANE_URL: envUrl(),
  CONTROL_PLANE_ADMIN_TOKEN: optStr,
  PORTAL_SESSION_TTL_MS: ttl(1000 * 60 * 60 * 24 * 7),
  PORTAL_EMAIL_VERIFY_TTL_MS: ttl(1000 * 60 * 60 * 24),
  PASSKEY_CHALLENGE_TTL_MS: ttl(300_000),
  WALLET_SEND_MFA_TTL_MS: ttl(600_000),
  MOBILE_OAUTH_TOKEN_TTL_MS: ttl(300_000),
  OAUTH_MICROSOFT_PROMPT: z.string().default("select_account"),
  PASSKEY_RP_ID: optStr,
  PASSKEY_RP_NAME: z.string().default("EdgeCoder Portal"),
  PASSKEY_ORIGIN: envUrl(),
  PASSKEY_ALLOWED_ORIGINS: optStr,
  GITHUB_REPO_URL: envUrl("https://github.com/codyrs82/Edgecoder"),
  /** Required in production (no localhost fallback there). */
  DOCS_SITE_URL: envUrl(),
  WALLET_DEFAULT_NETWORK: z.enum(["bitcoin", "testnet", "signet"], { message: "must be bitcoin, testnet or signet" }).default("signet"),
  WALLET_SECRET_PEPPER: optStr,
  COORDINATOR_OPERATIONS_OWNER_EMAILS: optStr,
  SYSTEM_ADMIN_EMAILS: optStr,
  COORDINATOR_ADMIN_EMAILS: optStr,
  IOS_OAUTH_CALLBACK_PREFIX: z.string().default("edgecoder://oauth-callback"),
  OAUTH_GOOGLE_CLIENT_ID: optStr,
  OAUTH_GOOGLE_CLIENT_SECRET: optStr,
  OAUTH_GOOGLE_AUTHORIZE_URL: envUrl("https://accounts.google.com/o/oauth2/v2/auth"),
  OAUTH_GOOGLE_TOKEN_URL: envUrl("https://oauth2.googleapis.com/token"),
  OAUTH_GOOGLE_USERINFO_URL: envUrl("https://openidconnect.googleapis.com/v1/userinfo"),
  OAUTH_MICROSOFT_CLIENT_ID: optStr,
  OAUTH_MICROSOFT_CLIENT_SECRET: optStr,
  OAUTH_MICROSOFT_AUTHORIZE_URL: envUrl("https://login.microsoftonline.com/common/oauth2/v2.0/authorize"),
  OAUTH_MICROSOFT_TOKEN_URL: envUrl("https://login.microsoftonline.com/common/oauth2/v2.0/token"),
  OAUTH_MICROSOFT_USERINFO_URL: envUrl("https://graph.microsoft.com/oidc/userinfo"),
  OAUTH_GITHUB_CLIENT_ID: optStr,
  OAUTH_GITHUB_CLIENT_SECRET: optStr
});

export type PortalConfig = z.infer<typeof portalConfigSchema>;

/** Production-only requirements; returns the problems (empty when fine). */
export function portalProductionProblems(c: PortalConfig, discoveryConfigured: boolean): string[] {
  if (c.NODE_ENV !== "production") return [];
  const missing: string[] = [];
  if (!c.PORTAL_SERVICE_TOKEN) missing.push("PORTAL_SERVICE_TOKEN");
  if (!c.WALLET_SECRET_PEPPER) missing.push("WALLET_SECRET_PEPPER");
  if (!c.RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!c.CONTROL_PLANE_URL && !discoveryConfigured) missing.push("CONTROL_PLANE_URL or COORDINATOR_DISCOVERY_URLS");
  if (c.CONTROL_PLANE_URL && !c.CONTROL_PLANE_ADMIN_TOKEN) missing.push("CONTROL_PLANE_ADMIN_TOKEN");
  if (!c.DOCS_SITE_URL) missing.push("DOCS_SITE_URL");
  const problems = missing.length ? [`Missing required production environment variables: ${missing.join(", ")}`] : [];
  if (!/^https:\/\//i.test(c.PORTAL_PUBLIC_URL)) problems.push("PORTAL_PUBLIC_URL must use https in production.");
  if (c.DOCS_SITE_URL && !/^https:\/\//i.test(c.DOCS_SITE_URL)) problems.push("DOCS_SITE_URL must use https in production.");
  return problems;
}
