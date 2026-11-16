// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envEnum, envEnumCi, envFlag, envInt, envNumber, envUrl } from "../common/config.js";
import { computeClassEnv, discoveryEnv, launchEnv, observabilityEnv, onchainEnv, postgresPoolEnv, serviceUrlsEnv } from "../config/shared.js";

/*
 * #15: portal (port 4310) configuration, validated once at startup. Field-level checks
 * (integers, URLs, enums) fail the process on import with every problem listed. Production-only
 * requirements are in portalProductionProblems(), run from validatePortalSecurityConfig() at
 * listen time. Documented in site-docs/reference/environment-variables.md.
 *
 * The lower block is validate-only: those variables are read by portal modules that take `env`
 * as a parameter (discovery, registry, DNS, OAuth state), which keep their own defaults.
 */

const optStr = z.string().optional();
const ttl = (def: number) => envInt(def, { min: 1_000, max: 31 * 24 * 60 * 60 * 1000 });

export const portalConfigSchema = z.object({
  ...observabilityEnv,
  ...serviceUrlsEnv,
  ...discoveryEnv,
  ...computeClassEnv,
  ...launchEnv,
  NODE_ENV: z.string().default("development"),
  PORTAL_PUBLIC_URL: envUrl("http://127.0.0.1:4310"),
  PORTAL_SERVICE_TOKEN: optStr,
  /** Read/validate-only token coordinators present to /internal/* (src/portal/internal-auth.ts). */
  PORTAL_COORDINATOR_TOKEN: optStr,
  /** Hosts the portal may send credentials to (src/portal/coordinator-url-policy.ts); default: COORDINATOR_DISCOVERY_URLS hosts. */
  PORTAL_COORDINATOR_HOSTS: optStr,
  PORTAL_EXTERNAL_HTTP_TIMEOUT_MS: envInt(7000, { min: 100, max: 120_000 }),
  RESEND_API_KEY: optStr,
  RESEND_FROM_EMAIL: optStr,
  CONTROL_PLANE_URL: envUrl(),
  CONTROL_PLANE_ADMIN_TOKEN: optStr,
  /**
   * The coordinators' ADMIN_API_TOKEN, for the system-admin revenue page (routes/revenue.ts: the fee
   * pool report and withdrawing it). Sent only server-side, only to allowlisted coordinators.
   * Unset: the page says it is not configured.
   */
  COORDINATOR_ADMIN_TOKEN: optStr,
  PORTAL_SESSION_TTL_MS: ttl(1000 * 60 * 60 * 24 * 7),
  PORTAL_EMAIL_VERIFY_TTL_MS: ttl(1000 * 60 * 60 * 24),
  PASSKEY_CHALLENGE_TTL_MS: ttl(300_000),
  WALLET_SEND_MFA_TTL_MS: ttl(600_000),
  /** Most sats one account can withdraw to invoices per rolling 24 h through the portal; 0 = no portal cap. */
  PORTAL_WITHDRAW_DAILY_CAP_SATS: envInt(500_000, { min: 0, max: 2_100_000_000_000_000 }),
  MOBILE_OAUTH_TOKEN_TTL_MS: ttl(300_000),
  /**
   * Daily deletion of unverified accounts older than this many days with no machines, API keys,
   * balance, pending payouts or activity (src/portal/account-admin.ts). Unset: off.
   */
  PORTAL_PURGE_UNVERIFIED_AFTER_DAYS: envInt(undefined, { min: 1, max: 3650 }),
  // #39: read by chatCapacityOptionsFromEnv (src/portal/chat-capacity.ts); declared here so a bad value stops startup.
  PORTAL_CHAT_CAPACITY_TIMEOUT_MS: envInt(2_000, { min: 100, max: 30_000 }),
  PORTAL_CHAT_CAPACITY_TTL_MS: envInt(15_000, { min: 0, max: 600_000 }),
  /** Agents one account may enrol (read by maxAgentsPerAccount in routes/account.ts). */
  PORTAL_MAX_AGENTS_PER_ACCOUNT: envInt(25, { min: 1 }),
  OAUTH_MICROSOFT_PROMPT: z.string().default("select_account"),
  PASSKEY_RP_ID: optStr,
  PASSKEY_RP_NAME: z.string().default("EdgeCoder Portal"),
  PASSKEY_ORIGIN: envUrl(),
  PASSKEY_ALLOWED_ORIGINS: optStr,
  GITHUB_REPO_URL: envUrl("https://github.com/codyrs82/Edgecoder"),
  /** Required in production (no localhost fallback there). */
  DOCS_SITE_URL: envUrl(),
  WALLET_DEFAULT_NETWORK: z.enum(["bitcoin", "testnet", "signet", "regtest"], { message: "must be bitcoin, testnet, signet or regtest" }).default("signet"),
  /** Bitcoin on-chain payout addresses can be saved (set it with the coordinator's ONCHAIN_ENABLED). */
  ONCHAIN_ENABLED: onchainEnv.ONCHAIN_ENABLED,
  // Unused since the server stopped generating wallet seeds; still accepted so old env files parse.
  WALLET_SECRET_PEPPER: optStr,
  COORDINATOR_OPERATIONS_OWNER_EMAILS: optStr,
  SYSTEM_ADMIN_EMAILS: optStr,
  /**
   * Hosting by request (src/portal/host-requests.ts; read by hostApprovalPolicyFromEnv). On unless
   * 0 or false: only approved hosts' machines take other accounts' work.
   */
  HOST_APPROVAL_REQUIRED: envFlag({ off: ["0", "false"] }),
  /** Comma-separated emails always treated as approved hosts (besides SYSTEM_ADMIN_EMAILS). */
  HOST_APPROVED_EMAILS: optStr,
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
  OAUTH_GITHUB_CLIENT_SECRET: optStr,

  // ---- request security (src/portal/security.ts) ----
  /** Comma-separated extra origins allowed to make state-changing requests / to appear in the CSP connect-src. */
  PORTAL_TRUSTED_ORIGINS: optStr,
  PORTAL_CONNECT_ORIGINS: optStr,
  /** 0 or false switches the CSP to report-only. */
  PORTAL_CSP_ENFORCE: envFlag({ off: ["0", "false"] }),
  PORTAL_EDGE: envEnum(["cloudflare", "none"]).default("none"),
  PORTAL_ORIGIN_LOCK_TOKEN: optStr,
  PORTAL_COOKIE_SECURE: envFlag({ on: ["1"] }),
  PORTAL_TRUST_FLY_CLIENT_IP: envFlag({ on: ["true"] }),
  /** Development only (ignored in production): serve /internal/* without a service token. */
  PORTAL_ALLOW_OPEN_INTERNAL: envFlag({ on: ["1"] }),
  /** HMAC key for the OAuth state cookie; required in production (assertOauthStateSecret). */
  OAUTH_STATE_SECRET: optStr,
  PORTAL_DATABASE_URL: optStr,
  ...postgresPoolEnv,
  AGENT_SIGNUPS_PER_HOUR: envNumber(undefined, { min: 0 }),
  SUPPORT_EMAIL: optStr,
  IOS_APP_TEAM_ID: optStr,
  IOS_APP_BUNDLE_ID: optStr,

  // ---- coordinator picker and registry (coordinator-discovery.ts, coordinator-registry.ts) ----
  PORTAL_DISCOVERY: envEnumCi(["selector", "ordered"]),
  PORTAL_DISCOVERY_SOURCES: optStr,
  REGISTRY_TTL_MS: envNumber(undefined, { min: 0 }),
  REGISTRY_HEALTH_INTERVAL_MS: envNumber(undefined, { min: 0 }),
  REGISTRY_FALLBACK_URLS: optStr,
  REGISTRY_SEEDS: optStr,
  REGISTRY_POOL_FILE: optStr,
  REGISTRY_SIGNING_KEY_PEM: optStr,

  // ---- coordinator DNS records (dns-manager.ts) ----
  GODADDY_API_KEY: optStr,
  GODADDY_API_SECRET: optStr,
  GODADDY_API_BASE: envUrl(),
  DNS_BASE_DOMAIN: optStr,
  DNS_COORDINATOR_PREFIX: optStr,
  DNS_RECORD_TTL: envInt(undefined, { min: 0 })
});

export type PortalConfig = z.infer<typeof portalConfigSchema>;

/** Production-only requirements; returns the problems (empty when fine). */
export function portalProductionProblems(c: PortalConfig, discoveryConfigured: boolean): string[] {
  if (c.NODE_ENV !== "production") return [];
  const missing: string[] = [];
  if (!c.PORTAL_SERVICE_TOKEN) missing.push("PORTAL_SERVICE_TOKEN");
  if (!c.RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!c.CONTROL_PLANE_URL && !discoveryConfigured) missing.push("CONTROL_PLANE_URL or COORDINATOR_DISCOVERY_URLS");
  if (c.CONTROL_PLANE_URL && !c.CONTROL_PLANE_ADMIN_TOKEN) missing.push("CONTROL_PLANE_ADMIN_TOKEN");
  if (!c.DOCS_SITE_URL) missing.push("DOCS_SITE_URL");
  const problems = missing.length ? [`Missing required production environment variables: ${missing.join(", ")}`] : [];
  if (!/^https:\/\//i.test(c.PORTAL_PUBLIC_URL)) problems.push("PORTAL_PUBLIC_URL must use https in production.");
  if (c.DOCS_SITE_URL && !/^https:\/\//i.test(c.DOCS_SITE_URL)) problems.push("DOCS_SITE_URL must use https in production.");
  return problems;
}
