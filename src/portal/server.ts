// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import Fastify from "fastify";
import { registerPortalPages } from "./pages/index.js";
// Kept for existing importers (tests/portal/download-page.test.ts).
export { detectOS } from "./pages/account.js";
import cors from "@fastify/cors";
import { randomUUID, createHash } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import { checkInternalServiceToken, LISTEN_HOST, portalAllowOpenInternal } from "../common/env-guard.js";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} from "@simplewebauthn/server";
import { PortalStore } from "./store.js";
import { generateMnemonic } from "bip39";
import {
  sha256Hex,
  normalizeEmail,
  parseCookies,
  secureCompare,
  encodeCookie,
  clearCookies,
  readCookie,
  hashPassword,
  verifyPassword,
  decodeJwtPayload,
  claimIsTrue,
  base64UrlFromBuffer,
  bufferFromBase64Url,
  normalizeBase64UrlString,
  deriveWalletSecretRef,
  deriveBitcoinAddress,
  generateSixDigitCode,
  deriveIosDeviceIdFromNodeId,
  normalizePasskeyResponsePayload,
  deriveCredentialIdFromVerifyBody
} from "./portal-utils.js";
import { parseOriginList, registerPortalSecurity, trustProxyHops } from "./security.js";
import { createCoordinatorPicker, discoveryConfigured, parseDiscoveryUrls } from "./coordinator-discovery.js";
import { getCoordinatorHostname, isDnsConfigured, deleteDnsRecord, syncCoordinatorDns } from "./dns-manager.js";

// #10: behind Fly's proxy, trust exactly one hop so req.ip is the client (rate limits).
const app = Fastify({ logger: true, trustProxy: trustProxyHops(process.env.PORTAL_TRUST_PROXY_HOPS) });

const DESKTOP_ORIGINS = ["tauri://localhost", "https://tauri.localhost", "http://localhost:1420"];
await app.register(cors, {
  origin: DESKTOP_ORIGINS,
  credentials: true,
});

// #10: helmet (CSP report-only for the first release), CSRF origin check, rate limits.
// Registered before any route so per-route rate limits attach.
await registerPortalSecurity(app, {
  publicOrigin: (() => {
    try {
      return new URL(process.env.PORTAL_PUBLIC_URL ?? "http://127.0.0.1:4310").origin;
    } catch {
      return "http://127.0.0.1:4310";
    }
  })(),
  trustedOrigins: [...DESKTOP_ORIGINS, ...parseOriginList(process.env.PORTAL_TRUSTED_ORIGINS)],
  connectOrigins: parseOriginList(process.env.PORTAL_CONNECT_ORIGINS),
  enforceCsp: process.env.PORTAL_CSP_ENFORCE === "1",
});

const store = PortalStore.fromEnv();

const PORTAL_SERVICE_TOKEN = process.env.PORTAL_SERVICE_TOKEN ?? "";
const EXTERNAL_HTTP_TIMEOUT_MS = Number(process.env.PORTAL_EXTERNAL_HTTP_TIMEOUT_MS ?? 7000);
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "";
const PORTAL_PUBLIC_URL = process.env.PORTAL_PUBLIC_URL ?? "http://127.0.0.1:4310";
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? "";
const CONTROL_PLANE_ADMIN_TOKEN = process.env.CONTROL_PLANE_ADMIN_TOKEN ?? "";
// #35: ordered coordinator list (COORDINATOR_DISCOVERY_URLS, legacy COORDINATOR_DISCOVERY_URL),
// falling back to the EU seed; the first healthy one is cached for 60 s.
const COORDINATOR_DISCOVERY_URLS = parseDiscoveryUrls();
const pickDiscoveryCoordinator = createCoordinatorPicker({
  urls: COORDINATOR_DISCOVERY_URLS,
  probe: async (url) => {
    const res = await request(`${url}/health/runtime`, {
      method: "GET",
      headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
      bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
    });
    await res.body.dump();
    return res.statusCode >= 200 && res.statusCode < 300;
  }
});
const SESSION_TTL_MS = Number(process.env.PORTAL_SESSION_TTL_MS ?? `${1000 * 60 * 60 * 24 * 7}`);
const EMAIL_VERIFY_TTL_MS = Number(process.env.PORTAL_EMAIL_VERIFY_TTL_MS ?? `${1000 * 60 * 60 * 24}`);
const PASSKEY_CHALLENGE_TTL_MS = Number(process.env.PASSKEY_CHALLENGE_TTL_MS ?? "300000");
const WALLET_SEND_MFA_TTL_MS = Number(process.env.WALLET_SEND_MFA_TTL_MS ?? "600000");
const OAUTH_MICROSOFT_PROMPT = process.env.OAUTH_MICROSOFT_PROMPT ?? "select_account";
const DEFAULT_PORTAL_HOST = (() => {
  try {
    return new URL(PORTAL_PUBLIC_URL).hostname || "localhost";
  } catch {
    return "localhost";
  }
})();
const PASSKEY_RP_ID = process.env.PASSKEY_RP_ID ?? DEFAULT_PORTAL_HOST;
const PASSKEY_RP_NAME = process.env.PASSKEY_RP_NAME ?? "EdgeCoder Portal";
const PASSKEY_ORIGIN = process.env.PASSKEY_ORIGIN ?? (() => {
  try {
    return new URL(PORTAL_PUBLIC_URL).origin;
  } catch {
    return PORTAL_PUBLIC_URL;
  }
})();
const PASSKEY_ALLOWED_ORIGINS = (() => {
  const configured = (process.env.PASSKEY_ALLOWED_ORIGINS ?? PASSKEY_ORIGIN)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const normalized = new Set<string>();
  for (const value of configured) {
    try {
      normalized.add(new URL(value).origin);
    } catch {
      // ignore malformed origin entries
    }
  }
  try {
    normalized.add(new URL(PORTAL_PUBLIC_URL).origin);
  } catch {
    // ignore malformed portal public URL
  }
  if (normalized.size === 0) normalized.add(PASSKEY_ORIGIN);
  return [...normalized];
})();
import { DOCS_SITE_URL, GITHUB_REPO_URL } from "./pages/urls.js";
const WALLET_DEFAULT_NETWORK = (process.env.WALLET_DEFAULT_NETWORK ?? "signet") as "bitcoin" | "testnet" | "signet";
const NODE_ENV = process.env.NODE_ENV ?? "development";
const WALLET_SECRET_PEPPER = process.env.WALLET_SECRET_PEPPER ?? "";
const COORDINATOR_OPERATIONS_OWNER_EMAILS = new Set(
  (process.env.COORDINATOR_OPERATIONS_OWNER_EMAILS ?? "")
    .split(",")
    .map((value) => normalizeEmail(value))
    .filter(Boolean)
);
const SYSTEM_ADMIN_EMAILS = new Set(
  (process.env.SYSTEM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => normalizeEmail(value))
    .filter(Boolean)
);
const COORDINATOR_ADMIN_EMAILS = new Set(
  (process.env.COORDINATOR_ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => normalizeEmail(value))
    .filter(Boolean)
);

type ProviderName = "google" | "microsoft" | "github";
const IOS_OAUTH_CALLBACK_PREFIX = process.env.IOS_OAUTH_CALLBACK_PREFIX ?? "edgecoder://oauth-callback";
const MOBILE_OAUTH_TOKEN_TTL_MS = Number(process.env.MOBILE_OAUTH_TOKEN_TTL_MS ?? "300000");
const oauthNativeRedirectByState = new Map<string, string>();
const mobileOauthSessionTokens = new Map<string, { userId: string; expiresAtMs: number }>();

type OauthProviderConfig = {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl?: string;
  scopes: string;
};

const oauthProviders: Record<ProviderName, OauthProviderConfig> = {
  google: {
    clientId: process.env.OAUTH_GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.OAUTH_GOOGLE_CLIENT_SECRET ?? "",
    authorizeUrl: process.env.OAUTH_GOOGLE_AUTHORIZE_URL ?? "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: process.env.OAUTH_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
    userinfoUrl: process.env.OAUTH_GOOGLE_USERINFO_URL ?? "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: "openid email profile"
  },
  microsoft: {
    clientId: process.env.OAUTH_MICROSOFT_CLIENT_ID ?? "",
    clientSecret: process.env.OAUTH_MICROSOFT_CLIENT_SECRET ?? "",
    authorizeUrl:
      process.env.OAUTH_MICROSOFT_AUTHORIZE_URL ??
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl:
      process.env.OAUTH_MICROSOFT_TOKEN_URL ??
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userinfoUrl: process.env.OAUTH_MICROSOFT_USERINFO_URL ?? "https://graph.microsoft.com/oidc/userinfo",
    scopes: "openid email profile"
  },
  github: {
    clientId: process.env.OAUTH_GITHUB_CLIENT_ID ?? "",
    clientSecret: process.env.OAUTH_GITHUB_CLIENT_SECRET ?? "",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userinfoUrl: "https://api.github.com/user",
    scopes: "repo user",
  },
};

function validatePortalSecurityConfig(): void {
  if (!Number.isFinite(PASSKEY_CHALLENGE_TTL_MS) || PASSKEY_CHALLENGE_TTL_MS <= 0) {
    throw new Error("PASSKEY_CHALLENGE_TTL_MS must be a positive number.");
  }

  // No default pepper is allowed; wallet onboarding requires an explicit secret.
  if (!WALLET_SECRET_PEPPER) {
    throw new Error("WALLET_SECRET_PEPPER is required for wallet onboarding.");
  }

  if (NODE_ENV !== "production") return;

  const missing: string[] = [];
  if (!PORTAL_SERVICE_TOKEN) missing.push("PORTAL_SERVICE_TOKEN");
  if (!WALLET_SECRET_PEPPER) missing.push("WALLET_SECRET_PEPPER");
  if (!RESEND_API_KEY) missing.push("RESEND_API_KEY");
  if (!CONTROL_PLANE_URL && !discoveryConfigured()) missing.push("CONTROL_PLANE_URL or COORDINATOR_DISCOVERY_URLS");
  if (CONTROL_PLANE_URL && !CONTROL_PLANE_ADMIN_TOKEN) missing.push("CONTROL_PLANE_ADMIN_TOKEN");
  if (!PASSKEY_RP_ID) missing.push("PASSKEY_RP_ID");
  if (!PASSKEY_RP_NAME) missing.push("PASSKEY_RP_NAME");
  if (!PASSKEY_ORIGIN) missing.push("PASSKEY_ORIGIN");
  if (!PORTAL_PUBLIC_URL) missing.push("PORTAL_PUBLIC_URL");
  if (missing.length > 0) {
    throw new Error(`Missing required production environment variables: ${missing.join(", ")}`);
  }

  if (PASSKEY_ALLOWED_ORIGINS.some((origin) => !/^https:\/\//i.test(origin))) {
    throw new Error("PASSKEY_ALLOWED_ORIGINS must use https in production.");
  }
  if (!/^https:\/\//i.test(PORTAL_PUBLIC_URL)) {
    throw new Error("PORTAL_PUBLIC_URL must use https in production.");
  }
}

function normalizeNativeOauthRedirect(value: string | undefined): string | null {
  if (!value) return null;
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    if (!parsed.protocol || parsed.protocol === "http:" || parsed.protocol === "https:") return null;
    const prefix = IOS_OAUTH_CALLBACK_PREFIX.endsWith("/")
      ? IOS_OAUTH_CALLBACK_PREFIX.slice(0, -1)
      : IOS_OAUTH_CALLBACK_PREFIX;
    return candidate.startsWith(prefix) ? candidate : null;
  } catch {
    return null;
  }
}

function issueMobileOauthSessionToken(userId: string): string {
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  mobileOauthSessionTokens.set(token, {
    userId,
    expiresAtMs: Date.now() + MOBILE_OAUTH_TOKEN_TTL_MS
  });
  return token;
}

function consumeMobileOauthSessionToken(token: string): { userId: string } | null {
  const record = mobileOauthSessionTokens.get(token);
  if (!record) return null;
  mobileOauthSessionTokens.delete(token);
  if (record.expiresAtMs <= Date.now()) return null;
  return { userId: record.userId };
}

function uint8ArrayFromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const buffer = Buffer.from(value, "base64url");
  return new Uint8Array(Array.from(buffer.values())) as Uint8Array<ArrayBuffer>;
}

async function sendVerificationEmail(email: string, verifyToken: string): Promise<void> {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    app.log.warn("RESEND_API_KEY/RESEND_FROM_EMAIL not set; skipping email verification send.");
    return;
  }
  const verifyLink = `${PORTAL_PUBLIC_URL}/auth/verify-email?token=${encodeURIComponent(verifyToken)}`;
  const html = `
    <p>Welcome to EdgeCoder.</p>
    <p>Verify your email to activate your account and enrolled nodes:</p>
    <p><a href="${verifyLink}">${verifyLink}</a></p>
    <p>This link expires in 24 hours.</p>
  `;

  const res = await request("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: email,
      subject: "Verify your EdgeCoder account",
      html
    })
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const body = await res.body.text();
    throw new Error(`resend_email_failed:${res.statusCode}:${body}`);
  }
}

async function sendWalletSendMfaCodeEmail(input: {
  email: string;
  code: string;
  amountSats: number;
  destination: string;
}): Promise<void> {
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    throw new Error("email_mfa_not_configured");
  }
  const html = `
    <p>EdgeCoder Wallet send verification</p>
    <p>Your one-time send code is:</p>
    <p><strong style="font-size:22px;letter-spacing:0.18em;">${input.code}</strong></p>
    <p>Requested transfer:</p>
    <ul>
      <li>Amount (sats): ${input.amountSats}</li>
      <li>Destination: ${input.destination}</li>
    </ul>
    <p>This code expires in ${Math.floor(WALLET_SEND_MFA_TTL_MS / 60000)} minutes.</p>
    <p>If you did not request this, do not share the code and review account access immediately.</p>
  `;
  const res = await request("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: RESEND_FROM_EMAIL,
      to: input.email,
      subject: "EdgeCoder wallet send verification code",
      html
    })
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    const body = await res.body.text();
    throw new Error(`wallet_send_mfa_email_failed:${res.statusCode}:${body}`);
  }
}

async function getCurrentUser(req: { headers: Record<string, unknown> }) {
  if (!store) return null;
  const cookies = parseCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
  let sessionToken = readCookie(cookies, "edgecoder_portal_session");
  // Fall back to Bearer token (for desktop app persistence)
  if (!sessionToken) {
    const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    if (auth.startsWith("Bearer ")) sessionToken = auth.slice(7);
  }
  if (!sessionToken) return null;
  const session = await store.getSessionByTokenHash(sha256Hex(sessionToken));
  if (!session) return null;
  const user = await store.getUserById(session.userId);
  if (!user) return null;
  return user;
}

const PORTAL_ALLOW_OPEN_INTERNAL = portalAllowOpenInternal();

function requireInternalToken(req: { headers: Record<string, unknown> }, reply: any): boolean {
  // #40: empty token -> 503 (open only with PORTAL_ALLOW_OPEN_INTERNAL=1 outside production);
  // constant-time compare.
  const result = checkInternalServiceToken(PORTAL_SERVICE_TOKEN, req.headers["x-portal-service-token"], {
    allowOpenWhenUnset: PORTAL_ALLOW_OPEN_INTERNAL
  });
  if (result === "ok") return true;
  if (result === "not_configured") {
    reply.code(503).send({ error: "internal_auth_not_configured" });
    return false;
  }
  reply.code(401).send({ error: "portal_service_token_required" });
  return false;
}

async function resolveIpIntelligence(sourceIp?: string): Promise<{ countryCode?: string; vpnDetected?: boolean }> {
  const ip = sourceIp?.trim();
  if (!ip) return {};
  const url = `https://api.ipapi.is/?q=${encodeURIComponent(ip)}`;
  try {
    const res = await request(url, { method: "GET" });
    if (res.statusCode < 200 || res.statusCode >= 300) return {};
    const payload = (await res.body.json()) as { country_code?: string; is_vpn?: boolean; is_proxy?: boolean };
    return {
      countryCode: payload.country_code,
      vpnDetected: payload.is_vpn === true || payload.is_proxy === true
    };
  } catch {
    return {};
  }
}

async function ensureCreditAccountForUser(user: { userId: string; email: string }) {
  if (!CONTROL_PLANE_URL || !CONTROL_PLANE_ADMIN_TOKEN) return;
  const accountId = `acct-${user.userId}`;
  await request(`${CONTROL_PLANE_URL}/credits/accounts`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${CONTROL_PLANE_ADMIN_TOKEN}`
    },
    body: JSON.stringify({
      accountId,
      displayName: user.email,
      ownerUserId: user.userId
    })
  }).catch(() => undefined);
}

async function ensureStarterWalletForUser(user: { userId: string; email: string }): Promise<{
  created: boolean;
  accountId: string;
  network: "bitcoin" | "testnet" | "signet";
  derivedAddress?: string;
  seedPhrase?: string;
  guidance?: { title: string; steps: string[] };
}> {
  const accountId = `acct-${user.userId}`;
  const existing = await store?.getWalletOnboardingByUserId(user.userId);
  if (existing) {
    return { created: false, accountId: existing.accountId, network: existing.network as any };
  }

  const seedPhrase = generateMnemonic(128);
  const encryptedPrivateKeyRef = deriveWalletSecretRef(seedPhrase, accountId, WALLET_SECRET_PEPPER);
  const derivedAddress = deriveBitcoinAddress(seedPhrase, WALLET_DEFAULT_NETWORK);
  await store?.createWalletOnboarding({
    userId: user.userId,
    accountId,
    network: WALLET_DEFAULT_NETWORK,
    seedPhraseHash: sha256Hex(seedPhrase),
    encryptedPrivateKeyRef,
    derivedAddress
  });

  if (CONTROL_PLANE_URL && CONTROL_PLANE_ADMIN_TOKEN) {
    await request(`${CONTROL_PLANE_URL}/economy/wallets/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CONTROL_PLANE_ADMIN_TOKEN}`
      },
      body: JSON.stringify({
        accountId,
        walletType: "lightning",
        network: WALLET_DEFAULT_NETWORK,
        encryptedSecretRef: encryptedPrivateKeyRef,
        payoutAddress: derivedAddress
      })
    }).catch(() => undefined);
  }

  return {
    created: true,
    accountId,
    network: WALLET_DEFAULT_NETWORK,
    seedPhrase,
    derivedAddress,
    guidance: {
      title: "Protect your recovery seed and private key",
      steps: [
        "Write the seed phrase on paper and store it offline in two separate secure locations.",
        "Never screenshot or send the seed phrase over email, chat, or cloud notes.",
        "Enable device passcode/biometric lock and keep iOS updated.",
        "Treat the private key as high-risk secret material; export only with explicit intent.",
        "Confirm backup by re-entering the seed phrase in-app before moving funds."
      ]
    }
  };
}

async function setupWalletSeedForUser(user: { userId: string; email: string }): Promise<{
  accountId: string;
  network: "bitcoin" | "testnet" | "signet";
  seedPhrase: string;
  derivedAddress: string;
  guidance: { title: string; steps: string[] };
}> {
  const existing = await store?.getWalletOnboardingByUserId(user.userId);
  const accountId = existing?.accountId ?? `acct-${user.userId}`;
  const network = (existing?.network as "bitcoin" | "testnet" | "signet" | undefined) ?? WALLET_DEFAULT_NETWORK;
  const seedPhrase = generateMnemonic(128);
  const encryptedPrivateKeyRef = deriveWalletSecretRef(seedPhrase, accountId, WALLET_SECRET_PEPPER);
  const derivedAddress = deriveBitcoinAddress(seedPhrase, network);

  await store?.upsertWalletOnboardingSeed({
    userId: user.userId,
    accountId,
    network,
    seedPhraseHash: sha256Hex(seedPhrase),
    encryptedPrivateKeyRef,
    derivedAddress
  });

  if (CONTROL_PLANE_URL && CONTROL_PLANE_ADMIN_TOKEN) {
    await request(`${CONTROL_PLANE_URL}/economy/wallets/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CONTROL_PLANE_ADMIN_TOKEN}`
      },
      body: JSON.stringify({
        accountId,
        walletType: "lightning",
        network,
        encryptedSecretRef: encryptedPrivateKeyRef,
        payoutAddress: derivedAddress
      })
    }).catch(() => undefined);
  }

  return {
    accountId,
    network,
    seedPhrase,
    derivedAddress,
    guidance: {
      title: "Protect your recovery seed and private key",
      steps: [
        "Write the seed phrase on paper and store it offline in two separate secure locations.",
        "Never screenshot or send the seed phrase over email, chat, or cloud notes.",
        "Enable device passcode/biometric lock and keep iOS updated.",
        "Treat the private key as high-risk secret material; export only with explicit intent.",
        "Confirm backup by re-entering the seed phrase in-app before moving funds."
      ]
    }
  };
}

async function createSessionForUser(userId: string, reply: any): Promise<string> {
  const sessionToken = randomUUID();
  await store?.createSession({
    sessionId: randomUUID(),
    userId,
    tokenHash: sha256Hex(sessionToken),
    expiresAtMs: Date.now() + SESSION_TTL_MS
  });
  reply.header("set-cookie", encodeCookie("edgecoder_portal_session", sessionToken, Math.floor(SESSION_TTL_MS / 1000)));
  return sessionToken;
}

async function loadIosNetworkSummary(): Promise<unknown> {
  if (!CONTROL_PLANE_URL || !CONTROL_PLANE_ADMIN_TOKEN) return null;
  try {
    const res = await request(`${CONTROL_PLANE_URL}/network/summary`, {
      method: "GET",
      headers: controlPlaneHeaders()
    });
    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    return await res.body.json();
  } catch {
    return null;
  }
}

function controlPlaneHeaders(contentType = false): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${CONTROL_PLANE_ADMIN_TOKEN}`
  };
  if (PORTAL_SERVICE_TOKEN) headers["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;
  if (contentType) headers["content-type"] = "application/json";
  return headers;
}

type PortalAccessContext = {
  isSystemAdmin: boolean;
  isCoordinatorAdmin: boolean;
  ownsCoordinatorNode: boolean;
  canViewCoordinatorOps: boolean;
  canManageCoordinatorOps: boolean;
};

async function buildAccessContext(user: { userId: string; email: string; role?: "user" | "admin" }): Promise<PortalAccessContext> {
  const normalizedEmail = normalizeEmail(user.email);
  const dbAdmin = user.role === "admin";
  const isSystemAdmin = dbAdmin || SYSTEM_ADMIN_EMAILS.has(normalizedEmail);
  const isCoordinatorAdmin = isSystemAdmin || COORDINATOR_ADMIN_EMAILS.has(normalizedEmail);
  const nodes = await store?.listNodesByOwner(user.userId);
  const ownsCoordinatorNode = Boolean(nodes?.some((node) => node.nodeKind === "coordinator"));
  const canViewCoordinatorOps =
    isSystemAdmin ||
    isCoordinatorAdmin ||
    ownsCoordinatorNode ||
    COORDINATOR_OPERATIONS_OWNER_EMAILS.has(normalizedEmail);
  const canManageCoordinatorOps = isSystemAdmin || isCoordinatorAdmin;
  return {
    isSystemAdmin,
    isCoordinatorAdmin,
    ownsCoordinatorNode,
    canViewCoordinatorOps,
    canManageCoordinatorOps
  };
}

async function requireCoordinatorOperationsUser(req: any, reply: any) {
  if (!store) {
    reply.code(503).send({ error: "portal_database_not_configured" });
    return null;
  }
  const user = await getCurrentUser(req);
  if (!user) {
    reply.code(401).send({ error: "not_authenticated" });
    return null;
  }
  const access = await buildAccessContext(user);
  if (!access.canViewCoordinatorOps) {
    reply.code(403).send({ error: "coordinator_operations_forbidden" });
    return null;
  }
  return { user, access };
}

async function loadWalletSnapshotForUser(userId: string): Promise<unknown> {
  if (!CONTROL_PLANE_URL || !CONTROL_PLANE_ADMIN_TOKEN) {
    return { credits: null, creditHistory: [], wallets: [], paymentIntents: [] };
  }
  const accountId = `acct-${userId}`;
  const cpTimeout = { headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS, bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS };
  try {
    const [creditResult, historyResult, walletResult, quoteResult] = await Promise.allSettled([
      request(`${CONTROL_PLANE_URL}/credits/${accountId}/balance`, {
        method: "GET",
        headers: controlPlaneHeaders(),
        ...cpTimeout
      }),
      request(`${CONTROL_PLANE_URL}/credits/${accountId}/history`, {
        method: "GET",
        headers: controlPlaneHeaders(),
        ...cpTimeout
      }),
      request(`${CONTROL_PLANE_URL}/wallets/${accountId}`, {
        method: "GET",
        headers: controlPlaneHeaders(),
        ...cpTimeout
      }),
      request(`${CONTROL_PLANE_URL}/economy/credits/${accountId}/quote`, {
        method: "GET",
        headers: controlPlaneHeaders(),
        ...cpTimeout
      })
    ]);
    const creditRes = creditResult.status === "fulfilled" ? creditResult.value : null;
    const historyRes = historyResult.status === "fulfilled" ? historyResult.value : null;
    const walletRes = walletResult.status === "fulfilled" ? walletResult.value : null;
    const quoteRes = quoteResult.status === "fulfilled" ? quoteResult.value : null;
    const credits = creditRes && creditRes.statusCode >= 200 && creditRes.statusCode < 300 ? await creditRes.body.json() : null;
    const historyPayload = historyRes && historyRes.statusCode >= 200 && historyRes.statusCode < 300
      ? ((await historyRes.body.json()) as { history?: unknown[] })
      : { history: [] };
    const walletPayload = walletRes && walletRes.statusCode >= 200 && walletRes.statusCode < 300
      ? ((await walletRes.body.json()) as { wallets?: unknown[]; paymentIntents?: unknown[] })
      : { wallets: [], paymentIntents: [] };
    const quote = quoteRes && quoteRes.statusCode >= 200 && quoteRes.statusCode < 300 ? await quoteRes.body.json() : null;
    return {
      credits,
      quote,
      creditHistory: historyPayload.history ?? [],
      wallets: walletPayload.wallets ?? [],
      paymentIntents: walletPayload.paymentIntents ?? []
    };
  } catch {
    return { credits: null, quote: null, creditHistory: [], wallets: [], paymentIntents: [] };
  }
}

async function loadIosAgentContributionForUser(agentId: string): Promise<{
  contribution: {
    earnedCredits: number;
    contributedTaskCount: number;
  };
  wallet: {
    accountId: string;
    balance: number;
    estimatedSats: number;
    satsPerCredit: number;
  };
  runtime: {
    connected: boolean;
    health?: string;
    mode?: string;
    localModelProvider?: string;
    maxConcurrentTasks?: number;
    swarmEnabled?: boolean;
    ideEnabled?: boolean;
  } | null;
  recentTaskIds: string[];
}> {
  if (!CONTROL_PLANE_URL || !CONTROL_PLANE_ADMIN_TOKEN) {
    return {
      contribution: { earnedCredits: 0, contributedTaskCount: 0 },
      wallet: { accountId: agentId, balance: 0, estimatedSats: 0, satsPerCredit: 0 },
      runtime: null,
      recentTaskIds: []
    };
  }

  try {
    const [creditRes, historyRes, quoteRes, catalogRes] = await Promise.all([
      request(`${CONTROL_PLANE_URL}/credits/${agentId}/balance`, {
        method: "GET",
        headers: controlPlaneHeaders()
      }),
      request(`${CONTROL_PLANE_URL}/credits/${agentId}/history`, {
        method: "GET",
        headers: controlPlaneHeaders()
      }),
      request(`${CONTROL_PLANE_URL}/economy/credits/${agentId}/quote`, {
        method: "GET",
        headers: controlPlaneHeaders()
      }),
      request(`${CONTROL_PLANE_URL}/agents/catalog`, {
        method: "GET",
        headers: controlPlaneHeaders()
      })
    ]);

    const credits = creditRes.statusCode >= 200 && creditRes.statusCode < 300
      ? ((await creditRes.body.json()) as { balance?: number })
      : { balance: 0 };
    const historyPayload = historyRes.statusCode >= 200 && historyRes.statusCode < 300
      ? ((await historyRes.body.json()) as { history?: Array<{ reason?: string; type?: string; credits?: number; relatedTaskId?: string }> })
      : { history: [] };
    const quote = quoteRes.statusCode >= 200 && quoteRes.statusCode < 300
      ? ((await quoteRes.body.json()) as { estimatedSats?: number; satsPerCredit?: number })
      : { estimatedSats: 0, satsPerCredit: 0 };
    const catalog = catalogRes.statusCode >= 200 && catalogRes.statusCode < 300
      ? ((await catalogRes.body.json()) as { agents?: Array<Record<string, unknown>> })
      : { agents: [] };

    const history = historyPayload.history ?? [];
    const earned = history
      .filter((tx) => tx?.reason === "compute_contribution" && tx?.type === "earn")
      .reduce((sum, tx) => sum + Number(tx?.credits ?? 0), 0);
    const contributedTaskIds = Array.from(
      new Set(
        history
          .filter((tx) => tx?.reason === "compute_contribution" && tx?.relatedTaskId)
          .map((tx) => String(tx.relatedTaskId))
      )
    );

    const runtimeAgent = (catalog.agents ?? []).find((item) => String(item?.agentId ?? "") === agentId) ?? null;

    return {
      contribution: {
        earnedCredits: Number(earned.toFixed(3)),
        contributedTaskCount: contributedTaskIds.length
      },
      wallet: {
        accountId: agentId,
        balance: Number(Number(credits.balance ?? 0).toFixed(3)),
        estimatedSats: Number(quote.estimatedSats ?? 0),
        satsPerCredit: Number(quote.satsPerCredit ?? 0)
      },
      runtime: runtimeAgent
        ? {
            connected: true,
            health: typeof runtimeAgent.health === "string" ? runtimeAgent.health : undefined,
            mode: typeof runtimeAgent.mode === "string" ? runtimeAgent.mode : undefined,
            localModelProvider:
              typeof runtimeAgent.localModelProvider === "string" ? runtimeAgent.localModelProvider : undefined,
            maxConcurrentTasks:
              typeof runtimeAgent.maxConcurrentTasks === "number" ? runtimeAgent.maxConcurrentTasks : undefined,
            swarmEnabled: typeof runtimeAgent.swarmEnabled === "boolean" ? runtimeAgent.swarmEnabled : undefined,
            ideEnabled: typeof runtimeAgent.ideEnabled === "boolean" ? runtimeAgent.ideEnabled : undefined
          }
        : { connected: false },
      recentTaskIds: contributedTaskIds.slice(-5).reverse()
    };
  } catch {
    return {
      contribution: { earnedCredits: 0, contributedTaskCount: 0 },
      wallet: { accountId: agentId, balance: 0, estimatedSats: 0, satsPerCredit: 0 },
      runtime: null,
      recentTaskIds: []
    };
  }
}

async function discoverCoordinatorUrlsForPortal(): Promise<string[]> {
  // Try control plane API first
  if (CONTROL_PLANE_URL) {
    try {
      const res = await request(`${CONTROL_PLANE_URL}/network/coordinators`, {
        method: "GET",
        headers: controlPlaneHeaders(),
        headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
        bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
      });
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const payload = (await res.body.json()) as {
          coordinators?: Array<{ coordinatorUrl?: string }>;
        };
        const urls = (payload.coordinators ?? [])
          .map((item) => String(item.coordinatorUrl ?? "").trim())
          .filter(Boolean)
          .filter((value, index, arr) => arr.indexOf(value) === index);
        if (urls.length > 0) return urls;
      }
    } catch {
      // fall through
    }
  }

  // Fall back to the configured discovery list (#35): first healthy URL, else the first entry.
  const healthy = await pickDiscoveryCoordinator();
  if (healthy) return [healthy];
  return COORDINATOR_DISCOVERY_URLS.slice(0, 1);
}

async function fetchCoordinatorFederatedSummary(input: {
  ownerEmail?: string;
}): Promise<{
  nodes: Array<{
    nodeId: string;
    nodeKind: "agent" | "coordinator";
    ownerEmail?: string;
    emailVerified?: boolean;
    nodeApproved?: boolean;
    active?: boolean;
    sourceIp?: string;
    countryCode?: string;
    vpnDetected?: boolean;
    lastSeenMs?: number;
    updatedAtMs?: number;
  }>;
  checkpointHashes: string[];
  finalityStates: string[];
  anchorTxRefs: string[];
  reachedCoordinators: number;
  stale: boolean;
}> {
  const coordinatorUrls = await discoverCoordinatorUrlsForPortal();
  if (coordinatorUrls.length === 0) {
    return { nodes: [], checkpointHashes: [], finalityStates: [], anchorTxRefs: [], reachedCoordinators: 0, stale: true };
  }
  const headers: Record<string, string> = {};
  if (PORTAL_SERVICE_TOKEN) headers["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;
  const ownerEmailQuery = input.ownerEmail ? `?ownerEmail=${encodeURIComponent(input.ownerEmail)}` : "";
  const responses = await Promise.all(
    coordinatorUrls.map(async (baseUrl) => {
      try {
        const res = await request(`${baseUrl.replace(/\/$/, "")}/stats/projections/summary${ownerEmailQuery}`, {
          method: "GET",
          headers,
          headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
          bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
        });
        if (res.statusCode < 200 || res.statusCode >= 300) return null;
        return (await res.body.json()) as {
          latestCheckpoint?: { hash?: string };
          finality?: {
            finalityState?: string;
            anchor?: { txRef?: string };
          };
          nodes?: Array<{
            nodeId: string;
            nodeKind: "agent" | "coordinator";
            ownerEmail?: string;
            emailVerified?: boolean;
            nodeApproved?: boolean;
            active?: boolean;
            sourceIp?: string;
            countryCode?: string;
            vpnDetected?: boolean;
            lastSeenMs?: number;
            updatedAtMs?: number;
          }>;
        };
      } catch {
        return null;
      }
    })
  );
  const reached = responses.filter((r) => Boolean(r));
  const checkpointHashes = reached
    .map((r) => String(r?.latestCheckpoint?.hash ?? "").trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index);
  const finalityStates = reached
    .map((r) => String(r?.finality?.finalityState ?? "").trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index);
  const anchorTxRefs = reached
    .map((r) => String(r?.finality?.anchor?.txRef ?? "").trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index);
  const mergedByNodeId = new Map<
    string,
    {
      nodeId: string;
      nodeKind: "agent" | "coordinator";
      ownerEmail?: string;
      emailVerified?: boolean;
      nodeApproved?: boolean;
      active?: boolean;
      sourceIp?: string;
      countryCode?: string;
      vpnDetected?: boolean;
      lastSeenMs?: number;
      updatedAtMs?: number;
    }
  >();
  for (const result of reached) {
    for (const node of result?.nodes ?? []) {
      const existing = mergedByNodeId.get(node.nodeId);
      if (!existing || Number(node.updatedAtMs ?? 0) >= Number(existing.updatedAtMs ?? 0)) {
        mergedByNodeId.set(node.nodeId, node);
      }
    }
  }
  return {
    nodes: [...mergedByNodeId.values()],
    checkpointHashes,
    finalityStates,
    anchorTxRefs,
    reachedCoordinators: reached.length,
    stale: reached.length === 0 || checkpointHashes.length > 1 || finalityStates.length > 1
  };
}

async function loadNetworkInsightsForUser(): Promise<{
  issuance: { epoch: Record<string, unknown> | null; allocations: Array<Record<string, unknown>> };
  modelMesh: { models: Array<Record<string, unknown>>; generatedAtMs?: number };
}> {
  if (!CONTROL_PLANE_URL || !CONTROL_PLANE_ADMIN_TOKEN) {
    return { issuance: { epoch: null, allocations: [] }, modelMesh: { models: [] } };
  }
  try {
    const [issuanceRes, modelsRes] = await Promise.all([
      request(`${CONTROL_PLANE_URL}/economy/issuance/current`, {
        method: "GET",
        headers: controlPlaneHeaders()
      }),
      request(`${CONTROL_PLANE_URL}/agent-mesh/models/available`, {
        method: "GET",
        headers: controlPlaneHeaders()
      })
    ]);
    const issuancePayload =
      issuanceRes.statusCode >= 200 && issuanceRes.statusCode < 300
        ? ((await issuanceRes.body.json()) as { epoch?: Record<string, unknown> | null; allocations?: Array<Record<string, unknown>> })
        : { epoch: null, allocations: [] };
    const modelsPayload =
      modelsRes.statusCode >= 200 && modelsRes.statusCode < 300
        ? ((await modelsRes.body.json()) as { models?: Array<Record<string, unknown>>; generatedAtMs?: number })
        : { models: [] };
    return {
      issuance: {
        epoch: issuancePayload.epoch ?? null,
        allocations: issuancePayload.allocations ?? []
      },
      modelMesh: {
        models: modelsPayload.models ?? [],
        generatedAtMs: modelsPayload.generatedAtMs
      }
    };
  } catch {
    return { issuance: { epoch: null, allocations: [] }, modelMesh: { models: [] } };
  }
}

app.get("/health", async () => ({ ok: true, portalDb: Boolean(store) }));

// Apple App Site Association for passkey webcredentials (iOS app ↔ domain link)
const IOS_APP_TEAM_ID = process.env.IOS_APP_TEAM_ID ?? "63CL88WY7G";
const IOS_APP_BUNDLE_ID = process.env.IOS_APP_BUNDLE_ID ?? "io.edgecoder.ios";
app.get("/.well-known/apple-app-site-association", async (_req, reply) => {
  const aasa = {
    webcredentials: {
      apps: [`${IOS_APP_TEAM_ID}.${IOS_APP_BUNDLE_ID}`]
    }
  };
  return reply.type("application/json").send(aasa);
});

app.get("/auth/capabilities", async () => {
  const oauthGoogleConfigured = Boolean(oauthProviders.google.clientId && oauthProviders.google.clientSecret);
  const oauthMicrosoftConfigured = Boolean(oauthProviders.microsoft.clientId && oauthProviders.microsoft.clientSecret);
  return {
    password: true,
    passkey: {
      enabled: Boolean(PASSKEY_RP_ID && PASSKEY_ALLOWED_ORIGINS.length > 0),
      rpId: PASSKEY_RP_ID,
      allowedOrigins: PASSKEY_ALLOWED_ORIGINS
    },
    oauth: {
      google: oauthGoogleConfigured,
      microsoft: oauthMicrosoftConfigured,
      apple: false
    }
  };
});

app.post("/auth/signup", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const body = z
    .object({
      email: z.string().email(),
      password: z.string().min(8).max(256),
      displayName: z.string().min(2).max(100).optional()
    })
    .parse(req.body);
  const email = normalizeEmail(body.email);
  const existing = await store.getUserByEmail(email);
  if (existing) return reply.code(409).send({ error: "email_already_registered" });

  const user = await store.createUser({
    userId: randomUUID(),
    email,
    displayName: body.displayName,
    passwordHash: hashPassword(body.password),
    emailVerified: false
  });

  const verifyToken = randomUUID();
  await store.createEmailVerification({
    tokenId: randomUUID(),
    userId: user.userId,
    tokenHash: sha256Hex(verifyToken),
    expiresAtMs: Date.now() + EMAIL_VERIFY_TTL_MS
  });
  await sendVerificationEmail(user.email, verifyToken);
  await ensureCreditAccountForUser(user);
  const walletOnboarding = await ensureStarterWalletForUser(user);
  return reply.send({
    ok: true,
    userId: user.userId,
    emailVerification: "sent",
    walletOnboarding
  });
});

app.post("/auth/login", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const user = await store.getUserByEmail(normalizeEmail(body.email));
  if (!user || !user.passwordHash || !verifyPassword(body.password, user.passwordHash)) {
    return reply.code(401).send({ error: "invalid_credentials" });
  }

  const sessionToken = await createSessionForUser(user.userId, reply);
  return reply.send({ ok: true, sessionToken, user: { userId: user.userId, email: user.email, displayName: user.displayName ?? null, emailVerified: user.emailVerified } });
});

app.post("/auth/logout", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const cookies = parseCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
  const sessionToken = readCookie(cookies, "edgecoder_portal_session");
  if (sessionToken) {
    await store.deleteSessionByTokenHash(sha256Hex(sessionToken));
  }
  reply.header("set-cookie", clearCookies("edgecoder_portal_session"));
  return reply.send({ ok: true });
});

app.get("/auth/verify-email", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const query = z.object({ token: z.string().min(10) }).parse(req.query);
  const consumed = await store.consumeEmailVerification(sha256Hex(query.token));
  if (!consumed) {
    return reply
      .code(400)
      .type("text/html")
      .send(`<!doctype html><html><body><p>Invalid or expired verification token.</p><p><a href="/portal">Return to portal</a></p></body></html>`);
  }
  await store.markUserEmailVerified(consumed.userId);
  const user = await store.getUserById(consumed.userId);
  if (user) await ensureCreditAccountForUser(user);
  return reply
    .type("text/html")
    .send(
      `<!doctype html><html><body><p>Email verified. Your account and enrolled nodes can now be activated.</p><p><a href="/portal">Open portal dashboard</a></p></body></html>`
    );
});

app.post("/auth/resend-verification", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const body = z.object({ email: z.string().email() }).parse(req.body);
  const user = await store.getUserByEmail(normalizeEmail(body.email));
  if (!user) return reply.send({ ok: true });
  if (user.emailVerified) return reply.send({ ok: true, alreadyVerified: true });
  const verifyToken = randomUUID();
  await store.createEmailVerification({
    tokenId: randomUUID(),
    userId: user.userId,
    tokenHash: sha256Hex(verifyToken),
    expiresAtMs: Date.now() + EMAIL_VERIFY_TTL_MS
  });
  await sendVerificationEmail(user.email, verifyToken);
  return reply.send({ ok: true });
});

app.get("/auth/oauth/apple/start", async (_req, reply) => {
  return reply.code(404).send({ error: "oauth_provider_disabled" });
});

app.get("/auth/oauth/apple/callback", async (_req, reply) => {
  return reply.code(404).send({ error: "oauth_provider_disabled" });
});

app.post("/auth/oauth/apple/callback", async (_req, reply) => {
  return reply.code(404).send({ error: "oauth_provider_disabled" });
});

app.get("/auth/oauth/:provider/start", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const params = z.object({ provider: z.enum(["google", "microsoft", "github"]) }).parse(req.params);
  const query = z.object({ appRedirect: z.string().optional() }).parse(req.query);
  const provider = oauthProviders[params.provider];
  if (!provider.clientId || !provider.clientSecret) {
    return reply.code(503).send({ error: `${params.provider}_oauth_not_configured` });
  }
  const nativeRedirect = normalizeNativeOauthRedirect(query.appRedirect);
  const state = randomUUID();
  const callbackUrl = `${PORTAL_PUBLIC_URL}/auth/oauth/${params.provider}/callback`;
  if (nativeRedirect) {
    oauthNativeRedirectByState.set(state, nativeRedirect);
  }
  await store.createOauthState({
    stateId: state,
    provider: params.provider,
    redirectUri: callbackUrl,
    expiresAtMs: Date.now() + 10 * 60 * 1000
  });
  const authorize = new URL(provider.authorizeUrl);
  authorize.searchParams.set("client_id", provider.clientId);
  authorize.searchParams.set("redirect_uri", callbackUrl);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", provider.scopes);
  authorize.searchParams.set("state", state);
  if (params.provider === "microsoft" && OAUTH_MICROSOFT_PROMPT) {
    authorize.searchParams.set("prompt", OAUTH_MICROSOFT_PROMPT);
  }
  return reply.redirect(authorize.toString());
});

app.get("/auth/oauth/:provider/callback", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const params = z.object({ provider: z.enum(["google", "microsoft", "github"]) }).parse(req.params);
  const query = z.object({ code: z.string(), state: z.string() }).parse(req.query);
  return handleOauthCallback(params.provider, query.code, query.state, reply);
});

app.post("/auth/oauth/:provider/callback", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const params = z.object({ provider: z.enum(["google", "microsoft", "github"]) }).parse(req.params);
  const body = z.object({ code: z.string(), state: z.string() }).parse(req.body);
  return handleOauthCallback(params.provider, body.code, body.state, reply);
});

async function handleOauthCallback(providerName: ProviderName, code: string, stateId: string, reply: any) {
  const portalStore = store;
  if (!portalStore) return reply.code(503).send({ error: "portal_database_not_configured" });
  const provider = oauthProviders[providerName];
  const state = await portalStore.consumeOauthState(stateId);
  if (!state || state.provider !== providerName) return reply.code(400).send({ error: "oauth_state_invalid" });
  const nativeRedirect = oauthNativeRedirectByState.get(stateId);
  if (nativeRedirect) oauthNativeRedirectByState.delete(stateId);

  const tokenExchangeHeaders: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  // GitHub requires Accept: application/json to return JSON instead of form-encoded
  if (providerName === "github") {
    tokenExchangeHeaders["accept"] = "application/json";
  }
  const tokenRes = await request(provider.tokenUrl, {
    method: "POST",
    headers: tokenExchangeHeaders,
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      redirect_uri: state.redirectUri
    }).toString()
  });
  if (tokenRes.statusCode < 200 || tokenRes.statusCode >= 300) {
    return reply.code(502).send({ error: "oauth_token_exchange_failed" });
  }
  const tokenPayload = (await tokenRes.body.json()) as { access_token?: string; id_token?: string };
  const claimsFromIdToken = tokenPayload.id_token
    ? decodeJwtPayload<{ sub?: string; email?: string; email_verified?: boolean | string | number }>(tokenPayload.id_token)
    : null;

  let subject = claimsFromIdToken?.sub;
  let email = claimsFromIdToken?.email;
  let emailVerified = claimIsTrue(claimsFromIdToken?.email_verified);
  let ghLogin: string | undefined;
  let ghAvatarUrl: string | undefined;

  if (provider.userinfoUrl && tokenPayload.access_token) {
    const userRes = await request(provider.userinfoUrl, {
      method: "GET",
      headers: {
        authorization: `Bearer ${tokenPayload.access_token}`,
        accept: "application/json",
        "user-agent": "EdgeCoder-Portal",
      },
    });
    if (userRes.statusCode >= 200 && userRes.statusCode < 300) {
      const userInfo = (await userRes.body.json()) as {
        sub?: string; email?: string; email_verified?: boolean | string | number;
        id?: number; login?: string; avatar_url?: string;
      };

      if (providerName === "github") {
        // GitHub returns { id, login, email, avatar_url } — not OIDC format
        subject = subject ?? (userInfo.id != null ? String(userInfo.id) : undefined);
        ghLogin = userInfo.login;
        ghAvatarUrl = userInfo.avatar_url;
        email = email ?? userInfo.email ?? undefined;
        // If email is null, fetch from /user/emails and pick primary verified
        if (!email && tokenPayload.access_token) {
          const emailsRes = await request("https://api.github.com/user/emails", {
            method: "GET",
            headers: {
              authorization: `Bearer ${tokenPayload.access_token}`,
              accept: "application/json",
              "user-agent": "EdgeCoder-Portal",
            },
          });
          if (emailsRes.statusCode >= 200 && emailsRes.statusCode < 300) {
            const emails = (await emailsRes.body.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
            const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
            if (primary) {
              email = primary.email;
              emailVerified = true;
            }
          }
        }
        if (email) emailVerified = true;
      } else {
        subject = subject ?? userInfo.sub;
        email = email ?? userInfo.email;
        emailVerified = emailVerified || claimIsTrue(userInfo.email_verified);
      }
    }
  }

  if (!subject) return reply.code(400).send({ error: "oauth_subject_missing" });
  if (!email) return reply.code(400).send({ error: "oauth_email_missing" });

  email = normalizeEmail(email);
  const linked = await portalStore.findOauthIdentity(providerName, subject);
  let user = linked ? await portalStore.getUserById(linked.userId) : null;
  if (!user) {
    user = (await portalStore.getUserByEmail(email)) ?? null;
  }
  if (!user) {
    user = await portalStore.createUser({
      userId: randomUUID(),
      email,
      emailVerified,
      displayName: undefined
    });
    await ensureCreditAccountForUser(user);
    await ensureStarterWalletForUser(user);
  } else if (emailVerified && !user.emailVerified) {
    await portalStore.markUserEmailVerified(user.userId);
    user = await portalStore.getUserById(user.userId);
  }
  if (!user) return reply.code(500).send({ error: "oauth_user_resolution_failed" });
  await portalStore.linkOauthIdentity({
    provider: providerName,
    providerSubject: subject,
    userId: user.userId,
    emailSnapshot: email
  });
  if (providerName === "github" && tokenPayload.access_token) {
    await portalStore.saveGitHubToken({
      userId: user.userId,
      accessToken: tokenPayload.access_token,
      githubLogin: ghLogin,
      githubAvatarUrl: ghAvatarUrl,
      scopes: provider.scopes,
    });
  }
  if (user.emailVerified) await ensureCreditAccountForUser(user);

  await createSessionForUser(user.userId, reply);
  if (nativeRedirect) {
    const mobileToken = issueMobileOauthSessionToken(user.userId);
    const redirect = new URL(nativeRedirect);
    redirect.searchParams.set("status", "ok");
    redirect.searchParams.set("provider", providerName);
    redirect.searchParams.set("mobile_token", mobileToken);
    return reply.redirect(redirect.toString());
  }
  return reply.redirect("/portal/dashboard");
}

// --- GitHub integration API endpoints ---

app.get("/portal/api/github/status", async (req, reply) => {
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const token = await store.getGitHubToken(user.userId);
  if (!token) return reply.send({ connected: false });
  return reply.send({ connected: true, login: token.githubLogin, avatarUrl: token.githubAvatarUrl });
});

app.get("/portal/api/github/token", async (req, reply) => {
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const token = await store.getGitHubToken(user.userId);
  if (!token) return reply.code(404).send({ error: "github_not_connected" });
  return reply.send({ accessToken: token.accessToken });
});

app.delete("/portal/api/github/disconnect", async (req, reply) => {
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  await store.deleteGitHubToken(user.userId);
  return reply.send({ ok: true });
});

// CORS preflight for native app token exchange
app.options("/auth/oauth/mobile/complete", async (_req, reply) => {
  reply.header("Access-Control-Allow-Origin", "tauri://localhost");
  reply.header("Access-Control-Allow-Credentials", "true");
  reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "content-type");
  reply.header("Access-Control-Max-Age", "86400");
  return reply.code(204).send();
});

app.post("/auth/oauth/mobile/complete", async (req, reply) => {
  reply.header("Access-Control-Allow-Origin", "tauri://localhost");
  reply.header("Access-Control-Allow-Credentials", "true");
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const body = z.object({ token: z.string().min(24) }).parse(req.body);
  const resolved = consumeMobileOauthSessionToken(body.token);
  if (!resolved) return reply.code(400).send({ error: "oauth_mobile_token_invalid" });
  const user = await store.getUserById(resolved.userId);
  if (!user) return reply.code(400).send({ error: "user_not_found" });
  // Create a session so subsequent portal API calls are authenticated
  const sessionToken = await createSessionForUser(user.userId, reply);
  return reply.send({
    ok: true,
    sessionToken,
    user: { userId: user.userId, email: user.email, emailVerified: user.emailVerified, displayName: user.displayName ?? null, role: user.role }
  });
});

app.post("/auth/passkey/register/options", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const existing = await store.listPasskeysByUserId(user.userId);
  const webauthnUserId = createHash("sha256").update(user.userId).digest().subarray(0, 16);
  const options = await generateRegistrationOptions({
    rpName: PASSKEY_RP_NAME,
    rpID: PASSKEY_RP_ID,
    userName: user.email,
    userID: webauthnUserId,
    attestationType: "none",
    timeout: 60000,
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred"
    },
    excludeCredentials: existing.map((item) => ({
      id: item.credentialId,
      transports: item.transports as any
    }))
  });
  const challengeId = randomUUID();
  await store.createPasskeyChallenge({
    challengeId,
    userId: user.userId,
    email: user.email,
    challenge: options.challenge,
    flowType: "registration",
    expiresAtMs: Date.now() + PASSKEY_CHALLENGE_TTL_MS
  });
  return reply.send({ challengeId, options });
});

app.post("/auth/passkey/register/verify", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const body = z
    .object({
      challengeId: z.string().min(10),
      response: z.unknown()
    })
    .parse(req.body);
  const challenge = await store.consumePasskeyChallenge(body.challengeId);
  if (!challenge || challenge.flowType !== "registration" || challenge.userId !== user.userId) {
    return reply.code(400).send({ error: "passkey_challenge_invalid" });
  }
  const normalizedResponse = normalizePasskeyResponsePayload(body.response);
  const verification = await verifyRegistrationResponse({
    response: normalizedResponse as any,
    expectedChallenge: challenge.challenge,
    expectedOrigin: PASSKEY_ALLOWED_ORIGINS,
    expectedRPID: PASSKEY_RP_ID,
    requireUserVerification: false
  }).catch(() => null);
  if (!verification?.verified || !verification.registrationInfo) {
    return reply.code(400).send({ error: "passkey_registration_failed" });
  }
  const reg = verification.registrationInfo;
  const webauthnUserId = base64UrlFromBuffer(createHash("sha256").update(user.userId).digest().subarray(0, 16));
  await store.upsertPasskeyCredential({
    credentialId: reg.credential.id,
    userId: user.userId,
    webauthnUserId,
    publicKeyB64Url: base64UrlFromBuffer(reg.credential.publicKey),
    counter: Number(reg.credential.counter ?? 0),
    deviceType: reg.credentialDeviceType,
    backedUp: reg.credentialBackedUp === true,
    transports: reg.credential.transports as string[] | undefined
  });
  return reply.send({ ok: true });
});

app.post("/auth/passkey/login/options", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const body = z.object({ email: z.string().email().optional() }).parse(req.body);
  const normalizedEmail = body.email ? normalizeEmail(body.email) : undefined;
  const user = normalizedEmail ? await store.getUserByEmail(normalizedEmail) : null;
  const credentials = user ? await store.listPasskeysByUserId(user.userId) : [];
  if (normalizedEmail && !user) return reply.code(404).send({ error: "user_not_found" });
  if (normalizedEmail && credentials.length === 0) return reply.code(404).send({ error: "passkey_not_registered" });
  const options = await generateAuthenticationOptions(
    credentials.length > 0
      ? {
          rpID: PASSKEY_RP_ID,
          timeout: 60000,
          userVerification: "preferred",
          allowCredentials: credentials.map((item) => ({
            id: item.credentialId,
            transports: item.transports as any
          }))
        }
      : {
          // Discoverable/passkey-first login when email is not provided.
          rpID: PASSKEY_RP_ID,
          timeout: 60000,
          userVerification: "preferred"
        }
  );
  const challengeId = randomUUID();
  await store.createPasskeyChallenge({
    challengeId,
    userId: user?.userId,
    email: user?.email,
    challenge: options.challenge,
    flowType: "authentication",
    expiresAtMs: Date.now() + PASSKEY_CHALLENGE_TTL_MS
  });
  return reply.send({ challengeId, options });
});

app.post("/auth/passkey/login/verify", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const body = z
    .object({
      challengeId: z.string().min(10),
      credentialId: z.string().min(10).optional(),
      response: z.unknown()
    })
    .parse(req.body);
  const challenge = await store.consumePasskeyChallenge(body.challengeId);
  if (!challenge || challenge.flowType !== "authentication") {
    return reply.code(400).send({ error: "passkey_challenge_invalid" });
  }
  const credentialId = deriveCredentialIdFromVerifyBody(body);
  if (!credentialId) return reply.code(400).send({ error: "passkey_credential_id_missing" });
  const credential = await store.findPasskeyByCredentialId(credentialId);
  if (!credential) return reply.code(404).send({ error: "passkey_credential_not_found" });
  const normalizedResponse = normalizePasskeyResponsePayload(body.response);
  const verification = await verifyAuthenticationResponse({
    response: normalizedResponse as any,
    expectedChallenge: challenge.challenge,
    expectedOrigin: PASSKEY_ALLOWED_ORIGINS,
    expectedRPID: PASSKEY_RP_ID,
    requireUserVerification: false,
    credential: {
      id: credential.credentialId,
      publicKey: uint8ArrayFromBase64Url(credential.publicKeyB64Url),
      counter: Number(credential.counter),
      transports: credential.transports as any
    }
  }).catch(() => null);
  if (!verification?.verified) return reply.code(401).send({ error: "passkey_login_failed" });
  await store.updatePasskeyCounter(credential.credentialId, Number(verification.authenticationInfo.newCounter ?? credential.counter));
  await createSessionForUser(credential.userId, reply);
  const user = await store.getUserById(credential.userId);
  return reply.send({ ok: true, user: user ? { userId: user.userId, email: user.email, emailVerified: user.emailVerified } : null });
});

app.get("/wallet/onboarding", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const onboarding = await store.getWalletOnboardingByUserId(user.userId);
  if (!onboarding) return reply.code(404).send({ error: "wallet_onboarding_not_found" });
  return reply.send({
    accountId: onboarding.accountId,
    network: onboarding.network,
    derivedAddress: onboarding.derivedAddress,
    createdAtMs: onboarding.createdAtMs,
    acknowledgedAtMs: onboarding.acknowledgedAtMs
  });
});

app.post("/wallet/onboarding/setup-seed", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  await ensureCreditAccountForUser(user);
  const setup = await setupWalletSeedForUser(user);
  return reply.send({
    ok: true,
    accountId: setup.accountId,
    network: setup.network,
    derivedAddress: setup.derivedAddress,
    guidance: setup.guidance
  });
});

app.post("/wallet/onboarding/acknowledge", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  await store.acknowledgeWalletOnboarding(user.userId);
  return reply.send({ ok: true });
});

app.get("/wallet/send/requests", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const requests = await store.listWalletSendRequestsByUser(user.userId, 25);
  return reply.send({ requests });
});

app.post("/wallet/send/mfa/start", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const body = z
    .object({
      destination: z.string().min(10).max(220),
      amountSats: z.number().int().positive().max(100_000_000),
      note: z.string().max(280).optional()
    })
    .parse(req.body);

  const walletOnboarding = await store.getWalletOnboardingByUserId(user.userId);
  if (!walletOnboarding) return reply.code(409).send({ error: "wallet_onboarding_required" });
  const passkeys = await store.listPasskeysByUserId(user.userId);
  if (passkeys.length === 0) {
    return reply.code(409).send({ error: "passkey_required_for_wallet_send" });
  }
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL) {
    return reply.code(503).send({ error: "email_mfa_not_configured" });
  }

  const passkeyOptions = await generateAuthenticationOptions({
    rpID: PASSKEY_RP_ID,
    timeout: 60000,
    userVerification: "required",
    allowCredentials: passkeys.map((item) => ({
      id: item.credentialId,
      transports: item.transports as any
    }))
  });

  const challengeId = randomUUID();
  const code = generateSixDigitCode();
  await store.createWalletSendMfaChallenge({
    challengeId,
    userId: user.userId,
    accountId: walletOnboarding.accountId,
    destination: body.destination.trim(),
    amountSats: body.amountSats,
    note: body.note?.trim() || undefined,
    emailCodeHash: sha256Hex(`${challengeId}:${code}`),
    passkeyChallenge: passkeyOptions.challenge,
    expiresAtMs: Date.now() + WALLET_SEND_MFA_TTL_MS
  });

  await sendWalletSendMfaCodeEmail({
    email: user.email,
    code,
    amountSats: body.amountSats,
    destination: body.destination.trim()
  });

  return reply.send({
    ok: true,
    challengeId,
    expiresAtMs: Date.now() + WALLET_SEND_MFA_TTL_MS,
    passkeyOptions
  });
});

app.post("/wallet/send/mfa/confirm", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const body = z
    .object({
      challengeId: z.string().min(10),
      emailCode: z.string().min(6).max(8),
      credentialId: z.string().min(10),
      response: z.unknown()
    })
    .parse(req.body);

  const challenge = await store.consumeWalletSendMfaChallenge(body.challengeId);
  if (!challenge || challenge.userId !== user.userId) {
    return reply.code(400).send({ error: "wallet_send_mfa_challenge_invalid" });
  }
  const expectedCodeHash = sha256Hex(`${challenge.challengeId}:${body.emailCode.trim()}`);
  if (!secureCompare(challenge.emailCodeHash, expectedCodeHash)) {
    return reply.code(401).send({ error: "wallet_send_email_code_invalid" });
  }

  const credential = await store.findPasskeyByCredentialId(body.credentialId);
  if (!credential || credential.userId !== user.userId) {
    return reply.code(404).send({ error: "passkey_credential_not_found" });
  }
  const verification = await verifyAuthenticationResponse({
    response: body.response as any,
    expectedChallenge: challenge.passkeyChallenge,
    expectedOrigin: PASSKEY_ALLOWED_ORIGINS,
    expectedRPID: PASSKEY_RP_ID,
    requireUserVerification: true,
    credential: {
      id: credential.credentialId,
      publicKey: uint8ArrayFromBase64Url(credential.publicKeyB64Url),
      counter: Number(credential.counter),
      transports: credential.transports as any
    }
  }).catch(() => null);
  if (!verification?.verified) {
    return reply.code(401).send({ error: "wallet_send_passkey_verification_failed" });
  }
  await store.updatePasskeyCounter(credential.credentialId, Number(verification.authenticationInfo.newCounter ?? credential.counter));

  const requestId = randomUUID();
  await store.createWalletSendRequest({
    requestId,
    userId: user.userId,
    accountId: challenge.accountId,
    destination: challenge.destination,
    amountSats: challenge.amountSats,
    note: challenge.note,
    status: "pending_manual_review",
    mfaChallengeId: challenge.challengeId
  });

  return reply.send({
    ok: true,
    request: {
      requestId,
      accountId: challenge.accountId,
      destination: challenge.destination,
      amountSats: challenge.amountSats,
      note: challenge.note,
      status: "pending_manual_review"
    }
  });
});

app.get("/ios/dashboard", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const [nodes, walletSnapshot, networkSummary] = await Promise.all([
    store.listNodesByOwner(user.userId),
    loadWalletSnapshotForUser(user.userId),
    loadIosNetworkSummary()
  ]);
  const history = (walletSnapshot as any)?.creditHistory ?? [];
  const earned = history
    .filter((tx: any) => tx?.reason === "compute_contribution" && tx?.type === "earn")
    .reduce((sum: number, tx: any) => sum + Number(tx.credits ?? 0), 0);
  const contributedTasks = new Set(
    history
      .filter((tx: any) => tx?.reason === "compute_contribution" && tx?.relatedTaskId)
      .map((tx: any) => String(tx.relatedTaskId))
  );
  return reply.send({
    user: { userId: user.userId, email: user.email, emailVerified: user.emailVerified },
    contribution: {
      earnedCredits: Number(earned.toFixed(3)),
      contributedTaskCount: contributedTasks.size
    },
    nodes: nodes.map((n) => ({
      nodeId: n.nodeId,
      nodeKind: n.nodeKind,
      active: n.active,
      nodeApproved: n.nodeApproved,
      lastSeenMs: n.lastSeenMs
    })),
    walletSnapshot,
    networkSummary
  });
});

app.get("/ios/agents/:agentId/contribution", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const params = z.object({ agentId: z.string().min(3) }).parse(req.params);
  const node = await store.getNodeEnrollment(params.agentId);
  if (!node || node.nodeKind !== "agent") {
    return reply.code(404).send({ error: "agent_not_found" });
  }
  if (node.ownerUserId !== user.userId) {
    return reply.code(403).send({ error: "agent_access_forbidden" });
  }

  const agentSnapshot = await loadIosAgentContributionForUser(params.agentId);
  return reply.send({
    agentId: params.agentId,
    node: {
      active: node.active,
      nodeApproved: node.nodeApproved,
      lastSeenMs: node.lastSeenMs
    },
    ...agentSnapshot
  });
});

app.get("/me", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const access = await buildAccessContext(user);
  const nodes = await store.listNodesByOwner(user.userId);
  return reply.send({
    user: {
      userId: user.userId,
      email: user.email,
      emailVerified: user.emailVerified,
      uiTheme: user.uiTheme,
      displayName: user.displayName,
      role: user.role,
      roles: {
        isSystemAdmin: access.isSystemAdmin,
        isCoordinatorAdmin: access.isCoordinatorAdmin
      }
    },
    nodes: nodes.map((n) => ({
      nodeId: n.nodeId,
      nodeKind: n.nodeKind,
      active: n.active,
      emailVerified: n.emailVerified,
      nodeApproved: n.nodeApproved
    }))
  });
});

app.post("/me/theme", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const body = z.object({ theme: z.enum(["warm", "midnight", "emerald"]) }).parse(req.body);
  await store.setUserTheme(user.userId, body.theme);
  return reply.send({ ok: true, theme: body.theme });
});

app.get("/portal/api/admin/users", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const access = await buildAccessContext(user);
  if (!access.isSystemAdmin) return reply.code(403).send({ error: "admin_only" });
  const users = await store.listAllUsers();
  return reply.send({
    users: users.map((u) => ({
      userId: u.userId,
      email: u.email,
      role: u.role,
      emailVerified: u.emailVerified,
      createdAtMs: u.createdAtMs
    }))
  });
});

app.post("/portal/api/admin/users/:userId/role", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const access = await buildAccessContext(user);
  if (!access.isSystemAdmin) return reply.code(403).send({ error: "admin_only" });
  const { userId } = req.params as { userId: string };
  const body = z.object({ role: z.enum(["user", "admin"]) }).parse(req.body);
  const target = await store.getUserById(userId);
  if (!target) return reply.code(404).send({ error: "user_not_found" });
  await store.setUserRole(userId, body.role);
  return reply.send({ ok: true, userId, role: body.role });
});

app.post("/nodes/enroll", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });

  const body = z
    .object({
      nodeId: z.string().min(3),
      nodeKind: z.enum(["agent", "coordinator"]),
      deviceId: z.string().min(3).max(128).optional()
    })
    .parse(req.body);
  const enrollmentDeviceId =
    body.deviceId?.trim().toLowerCase() || (body.nodeKind === "agent" ? deriveIosDeviceIdFromNodeId(body.nodeId) : undefined);
  const registrationToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  let record = await store.upsertNodeEnrollment({
    nodeId: body.nodeId,
    deviceId: enrollmentDeviceId,
    nodeKind: body.nodeKind,
    ownerUserId: user.userId,
    ownerEmail: user.email,
    registrationTokenHash: sha256Hex(registrationToken),
    emailVerified: user.emailVerified
  });
  if (body.nodeKind === "agent" && user.emailVerified && !record.nodeApproved) {
    const approved = await store.setNodeApproval(record.nodeId, true);
    if (approved) {
      record = approved;
    }
  }
  // Link agent ownership so credits earned by this node flow to the user's account
  if (CONTROL_PLANE_URL && CONTROL_PLANE_ADMIN_TOKEN) {
    const accountId = `acct-${user.userId}`;
    await ensureCreditAccountForUser(user);
    request(`${CONTROL_PLANE_URL}/credits/accounts/${encodeURIComponent(accountId)}/agents/link`, {
      method: "POST",
      headers: controlPlaneHeaders(true),
      headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
      bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
      body: JSON.stringify({
        agentId: body.nodeId,
        ownerUserId: user.userId
      })
    }).catch(() => undefined);
  }
  // Assign DNS hostname for coordinator nodes
  let dnsHostname: string | undefined;
  if (body.nodeKind === "coordinator" && store) {
    dnsHostname = getCoordinatorHostname(body.nodeId);
    await store.updateNodeDns({
      nodeId: record.nodeId,
      dnsHostname,
      dnsStatus: "pending",
      dnsIp: null,
    });
  }

  return reply.send({
    ok: true,
    nodeId: record.nodeId,
    deviceId: record.deviceId,
    nodeKind: record.nodeKind,
    emailVerified: record.emailVerified,
    nodeApproved: record.nodeApproved,
    active: record.active,
    registrationToken,
    ...(dnsHostname ? { dnsHostname } : {}),
  });
});

app.delete("/nodes/:nodeId", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const params = z.object({ nodeId: z.string().min(3) }).parse(req.params);
  const access = await buildAccessContext(user);
  const existing = await store.getNodeEnrollment(params.nodeId);
  if (!existing) return reply.code(404).send({ error: "node_not_found" });
  if (!access.isSystemAdmin && existing.ownerUserId !== user.userId) {
    return reply.code(403).send({ error: "node_delete_forbidden" });
  }
  // Clean up DNS record for coordinator nodes
  if (existing.nodeKind === "coordinator" && existing.dnsHostname) {
    deleteDnsRecord(existing.nodeId).catch((err) =>
      console.error(`[portal] Failed to delete DNS for ${existing.nodeId}:`, err)
    );
  }

  const ok = await store.deleteNodeEnrollment(params.nodeId);
  if (!ok) return reply.code(404).send({ error: "node_not_found" });
  return reply.send({ ok: true, deletedNodeId: params.nodeId });
});

app.get("/nodes/discover-coordinator", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });

  // Authenticate via registration token in Authorization header
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!token) {
    return reply.code(401).send({ error: "registration_token_required" });
  }

  // Token is accepted as proof of enrollment — coordinator will re-validate
  const coordinators = await store.listActiveCoordinators();
  if (coordinators.length === 0) {
    return reply.send({ coordinatorUrl: null, reason: "no_public_coordinators" });
  }

  // Simple selection: first active coordinator (ordered by most recently seen)
  const selected = coordinators[0];
  return reply.send({
    coordinatorUrl: `https://${selected.dnsHostname}`,
    coordinatorNodeId: selected.nodeId,
    dnsStatus: selected.dnsStatus,
  });
});

app.get("/nodes/me", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const nodes = await store.listNodesByOwner(user.userId);
  return reply.send({ nodes });
});

app.get("/dashboard/summary", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const [nodes, walletSnapshot] = await Promise.all([store.listNodesByOwner(user.userId), loadWalletSnapshotForUser(user.userId)]);
  // Self-heal: ensure agent ownership is linked for all enrolled nodes
  if (CONTROL_PLANE_URL && CONTROL_PLANE_ADMIN_TOKEN && nodes.length > 0) {
    const accountId = `acct-${user.userId}`;
    for (const node of nodes) {
      request(`${CONTROL_PLANE_URL}/credits/accounts/${encodeURIComponent(accountId)}/agents/link`, {
        method: "POST",
        headers: controlPlaneHeaders(true),
        headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
        bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
        body: JSON.stringify({ agentId: node.nodeId, ownerUserId: user.userId })
      }).catch(() => undefined);
    }
  }
  return reply.send({
    user: { userId: user.userId, email: user.email, emailVerified: user.emailVerified, uiTheme: user.uiTheme },
    nodes: nodes.map((n) => ({
      nodeId: n.nodeId,
      nodeKind: n.nodeKind,
      active: n.active,
      emailVerified: n.emailVerified,
      nodeApproved: n.nodeApproved,
      lastSeenMs: n.lastSeenMs
    })),
    walletSnapshot
  });
});

app.get("/dashboard/network-insights", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const insights = await loadNetworkInsightsForUser();
  return reply.send(insights);
});

app.get("/coordinator/ops/summary", async (req, reply) => {
  const principal = await requireCoordinatorOperationsUser(req as any, reply);
  if (!principal) return;
  const { user, access } = principal;
  try {
    let status: Record<string, unknown> = {
      agents: 0,
      queued: 0,
      results: 0
    };
    if (access.isSystemAdmin && CONTROL_PLANE_URL && CONTROL_PLANE_ADMIN_TOKEN) {
      const res = await request(`${CONTROL_PLANE_URL}/ops/summary`, {
        method: "GET",
        headers: controlPlaneHeaders(),
        headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
        bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
      });
      const payload = (await res.body.json()) as { status?: Record<string, unknown> };
      if (res.statusCode >= 200 && res.statusCode < 300 && payload.status) {
        status = payload.status;
      }
    } else {
      const ownedNodes = (await store?.listNodesByOwner(user.userId)) ?? [];
      status = {
        agents: ownedNodes.filter((n) => n.nodeKind === "agent" && n.active).length,
        queued: 0,
        results: 0
      };
    }
    const ownerUserId = access.isSystemAdmin ? undefined : user.userId;
    const ownerEmail = access.isSystemAdmin ? undefined : user.email;
    const ownedNodeIds = new Set<string>();
    if (!access.isSystemAdmin) {
      const ownedNodes = (await store?.listNodesByOwner(user.userId)) ?? [];
      for (const n of ownedNodes) ownedNodeIds.add(n.nodeId);
    }
    const federated = await fetchCoordinatorFederatedSummary({ ownerEmail });
    const pendingFromStore = (await store?.listPendingNodes({ limit: 250, ownerUserId })) ?? [];
    const pendingFromFederated = federated.nodes.filter(
      (n) => n.nodeApproved !== true && (access.isSystemAdmin || ownedNodeIds.has(n.nodeId))
    );
    const pendingByNodeId = new Map<string, (typeof pendingFromFederated)[number]>();
    for (const n of pendingFromFederated) pendingByNodeId.set(n.nodeId, n);
    for (const n of pendingFromStore) {
      // Store can momentarily retain historical enrollment rows that were
      // already approved; never show those in pending requests.
      if (n.nodeApproved === true) continue;
      pendingByNodeId.set(n.nodeId, {
        nodeId: n.nodeId,
        nodeKind: n.nodeKind,
        ownerEmail: n.ownerEmail,
        emailVerified: n.emailVerified,
        nodeApproved: n.nodeApproved,
        active: n.active,
        sourceIp: n.lastIp,
        countryCode: n.lastCountryCode,
        vpnDetected: n.lastVpnDetected ?? false,
        lastSeenMs: n.lastSeenMs,
        updatedAtMs: n.updatedAtMs
      });
    }
    const approvedFromFederated = federated.nodes.filter(
      (n) => n.nodeApproved === true && (access.isSystemAdmin || ownedNodeIds.has(n.nodeId))
    );
    const approvedFromStore =
      (await store?.listApprovedNodes({ ownerUserId, limit: 500 }))?.map((n) => ({
        nodeId: n.nodeId,
        nodeKind: n.nodeKind,
        ownerEmail: n.ownerEmail,
        emailVerified: n.emailVerified,
        nodeApproved: n.nodeApproved,
        active: n.active,
        sourceIp: n.lastIp,
        countryCode: n.lastCountryCode,
        vpnDetected: n.lastVpnDetected ?? false,
        lastSeenMs: n.lastSeenMs,
        updatedAtMs: n.updatedAtMs
      })) ?? [];
    // Always include store-approved nodes so approved devices do not disappear
    // when federated summaries are temporarily incomplete.
    const approvedByNodeId = new Map<string, (typeof approvedFromStore)[number]>();
    for (const n of approvedFromStore) approvedByNodeId.set(n.nodeId, n);
    for (const n of approvedFromFederated) {
      const existing = approvedByNodeId.get(n.nodeId) ?? {};
      approvedByNodeId.set(n.nodeId, {
        ...existing,
        ...n,
        ownerEmail: n.ownerEmail ?? (existing as { ownerEmail?: string }).ownerEmail ?? "unknown",
        emailVerified: n.emailVerified ?? (existing as { emailVerified?: boolean }).emailVerified ?? false,
        nodeApproved: n.nodeApproved ?? (existing as { nodeApproved?: boolean }).nodeApproved ?? false,
        active: n.active ?? (existing as { active?: boolean }).active ?? false,
        sourceIp: n.sourceIp ?? (existing as { sourceIp?: string }).sourceIp,
        countryCode: n.countryCode ?? (existing as { countryCode?: string }).countryCode,
        vpnDetected: n.vpnDetected ?? (existing as { vpnDetected?: boolean }).vpnDetected ?? false,
        lastSeenMs: n.lastSeenMs ?? (existing as { lastSeenMs?: number }).lastSeenMs,
        updatedAtMs: n.updatedAtMs ?? (existing as { updatedAtMs?: number }).updatedAtMs ?? Date.now()
      });
    }
    let approvedNodes = [...approvedByNodeId.values()];
    const agentProviderByNodeId: Record<string, string> = {};
    const agentOrchestrationStatusByNodeId: Record<string, { phase: string; message: string; progressPct?: number; updatedAtMs: number }> = {};
    const agentModelRolloutByNodeId: Record<
      string,
      { rolloutId?: string; status: string; error?: string; updatedAtMs: number }
    > = {};
    if (access.isSystemAdmin && CONTROL_PLANE_URL && CONTROL_PLANE_ADMIN_TOKEN) {
      try {
        const catalogRes = await request(`${CONTROL_PLANE_URL}/agents/catalog`, {
          method: "GET",
          headers: controlPlaneHeaders(),
          headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
          bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
        });
        if (catalogRes.statusCode >= 200 && catalogRes.statusCode < 300) {
          const catalog = (await catalogRes.body.json()) as {
            agents?: Array<{
              agentId?: string;
              localModelProvider?: string;
              orchestrationStatus?: { phase: string; message: string; progressPct?: number; updatedAtMs: number };
            }>;
          };
          for (const a of catalog.agents ?? []) {
            const id = a.agentId ?? "";
            if (id && typeof a.localModelProvider === "string") agentProviderByNodeId[id] = a.localModelProvider;
            if (id && a.orchestrationStatus) agentOrchestrationStatusByNodeId[id] = a.orchestrationStatus;
          }
        }
      } catch {
        // best-effort; leave maps empty
      }
      try {
        const rolloutsRes = await request(`${CONTROL_PLANE_URL}/orchestration/rollouts`, {
          method: "GET",
          headers: controlPlaneHeaders(),
          headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
          bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
        });
        if (rolloutsRes.statusCode >= 200 && rolloutsRes.statusCode < 300) {
          const payload = (await rolloutsRes.body.json()) as {
            rollouts?: Array<{
              rolloutId?: string;
              targetType?: string;
              targetId?: string;
              status?: string;
              error?: string;
              updatedAtMs?: number;
              requestedAtMs?: number;
            }>;
          };
          for (const rollout of payload.rollouts ?? []) {
            if (rollout.targetType !== "agent") continue;
            const targetId = rollout.targetId ?? "";
            const status = rollout.status ?? "";
            if (!targetId || !status) continue;
            const updatedAtMs = Number(rollout.updatedAtMs ?? rollout.requestedAtMs ?? 0);
            const existing = agentModelRolloutByNodeId[targetId];
            if (!existing || updatedAtMs >= existing.updatedAtMs) {
              agentModelRolloutByNodeId[targetId] = {
                rolloutId: rollout.rolloutId,
                status,
                error: rollout.error,
                updatedAtMs
              };
            }
          }
        }
      } catch {
        // best-effort; leave rollout map empty
      }
    }
    const canonicalNodeSuffix = (nodeId: string): string => {
      return String(nodeId)
        .toLowerCase()
        .replace(/^iphone-/, "")
        .replace(/^ios-/, "")
        .replace(/[^a-z0-9]/g, "");
    };
    const looksLikeIosAlias = (
      pendingNode: { nodeId: string; nodeKind: "agent" | "coordinator" },
      approvedNode: { nodeId: string; nodeKind: "agent" | "coordinator" }
    ): boolean => {
      if (pendingNode.nodeKind !== approvedNode.nodeKind) return false;
      const p = canonicalNodeSuffix(pendingNode.nodeId);
      const a = canonicalNodeSuffix(approvedNode.nodeId);
      if (!p || !a) return false;
      const pendingIsIosStyle = /^ios-|^iphone-/i.test(pendingNode.nodeId);
      const approvedIsIosStyle = /^ios-|^iphone-/i.test(approvedNode.nodeId);
      if (!pendingIsIosStyle || !approvedIsIosStyle) return false;
      return p.startsWith(a) || a.startsWith(p);
    };
    approvedNodes = approvedNodes.map((n) => {
      const aliasRollout = Object.entries(agentModelRolloutByNodeId)
        .filter(([nodeId]) =>
          looksLikeIosAlias(
            { nodeId, nodeKind: "agent" },
            { nodeId: n.nodeId, nodeKind: n.nodeKind }
          )
        )
        .sort((a, b) => Number(b[1].updatedAtMs ?? 0) - Number(a[1].updatedAtMs ?? 0))[0]?.[1];
      const alias = federated.nodes
        .filter((candidate) =>
          looksLikeIosAlias(
            { nodeId: candidate.nodeId, nodeKind: candidate.nodeKind },
            { nodeId: n.nodeId, nodeKind: n.nodeKind }
          )
        )
        .sort((a, b) => Number(b.lastSeenMs ?? b.updatedAtMs ?? 0) - Number(a.lastSeenMs ?? a.updatedAtMs ?? 0))[0];
      const mergedLastSeenMs = n.lastSeenMs ?? alias?.lastSeenMs;
      const mergedUpdatedAtMs = n.updatedAtMs ?? alias?.updatedAtMs;
      return {
        ...n,
        lastSeenMs: mergedLastSeenMs,
        updatedAtMs: mergedUpdatedAtMs,
        sourceIp: n.sourceIp ?? alias?.sourceIp,
        countryCode: n.countryCode ?? alias?.countryCode,
        vpnDetected: n.vpnDetected ?? alias?.vpnDetected,
        localModelProvider: agentProviderByNodeId[n.nodeId] ?? (n as { localModelProvider?: string }).localModelProvider,
        orchestrationStatus: agentOrchestrationStatusByNodeId[n.nodeId],
        modelRollout: agentModelRolloutByNodeId[n.nodeId] ?? aliasRollout
      };
    });
    const approvedNodeIds = new Set(approvedNodes.map((n) => n.nodeId));
    const pendingNodes = [...pendingByNodeId.values()].filter((pendingNode) => {
      if (approvedNodeIds.has(pendingNode.nodeId)) return false;
      return !approvedNodes.some((approvedNode) =>
        looksLikeIosAlias(
          { nodeId: pendingNode.nodeId, nodeKind: pendingNode.nodeKind },
          { nodeId: approvedNode.nodeId, nodeKind: approvedNode.nodeKind }
        )
      );
    });
    const finalityState =
      federated.finalityStates.length === 1 ? federated.finalityStates[0] : federated.stale ? "stale_federation" : "unknown";
    const anchorTxRef = federated.anchorTxRefs.length === 1 ? federated.anchorTxRefs[0] : undefined;
    return reply.send({
      status,
      pendingNodes,
      approvedNodes: approvedNodes.map((n) => ({
        nodeId: n.nodeId,
        nodeKind: n.nodeKind,
        ownerEmail: n.ownerEmail,
        emailVerified: n.emailVerified,
        nodeApproved: n.nodeApproved,
        active: n.active,
        sourceIp: n.sourceIp,
        countryCode: n.countryCode,
        vpnDetected: n.vpnDetected ?? false,
        lastSeenMs: n.lastSeenMs,
        updatedAtMs: n.updatedAtMs,
        localModelProvider: (n as { localModelProvider?: string }).localModelProvider,
        orchestrationStatus: (n as { orchestrationStatus?: { phase: string; message: string; progressPct?: number; updatedAtMs: number } }).orchestrationStatus,
        modelRollout: (n as { modelRollout?: { rolloutId?: string; status: string; error?: string; updatedAtMs: number } }).modelRollout
      })),
      access: {
        isSystemAdmin: access.isSystemAdmin,
        isCoordinatorAdmin: access.isCoordinatorAdmin,
        canManageApprovals: access.canManageCoordinatorOps
      },
      federation: {
        reachedCoordinators: federated.reachedCoordinators,
        checkpointHashes: federated.checkpointHashes,
        finalityStates: federated.finalityStates,
        finalityState,
        anchorTxRefs: federated.anchorTxRefs,
        anchorTxRef,
        stale: federated.stale
      }
    });
  } catch {
    // Never blank coordinator ops UI; return safe fallback payload.
    return reply.send({
      status: { agents: 0, queued: 0, results: 0 },
      pendingNodes: [],
      approvedNodes: [],
      access: {
        isSystemAdmin: access.isSystemAdmin,
        isCoordinatorAdmin: access.isCoordinatorAdmin,
        canManageApprovals: access.canManageCoordinatorOps
      },
      federation: {
        reachedCoordinators: 0,
        checkpointHashes: [],
        finalityStates: [],
        finalityState: "unknown",
        anchorTxRefs: [],
        anchorTxRef: undefined,
        stale: true
      },
      degraded: true
    });
  }
});

app.get("/coordinator/ops/agent-diagnostics", async (req, reply) => {
  const principal = await requireCoordinatorOperationsUser(req as any, reply);
  if (!principal) return;
  const { user, access } = principal;
  const query = z.object({ agentId: z.string().min(1) }).parse(req.query);
  const agentId = query.agentId.trim();
  if (!agentId) return reply.code(400).send({ error: "agent_id_required" });

  if (!access.isSystemAdmin) {
    const enrollment = await store?.getNodeEnrollment(agentId);
    if (!enrollment || enrollment.ownerUserId !== user.userId) {
      return reply.code(403).send({ error: "agent_diagnostics_forbidden" });
    }
  }

  const coordinatorUrls = await discoverCoordinatorUrlsForPortal();
  if (coordinatorUrls.length === 0) {
    return reply.send({ ok: true, agentId, events: [], reachedCoordinators: 0 });
  }

  const headers: Record<string, string> = {};
  if (PORTAL_SERVICE_TOKEN) headers["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;
  const responses = await Promise.all(
    coordinatorUrls.map(async (baseUrl) => {
      try {
        const res = await request(`${baseUrl.replace(/\/$/, "")}/agent/diagnostics/${encodeURIComponent(agentId)}`, {
          method: "GET",
          headers
        });
        if (res.statusCode < 200 || res.statusCode >= 300) return null;
        return (await res.body.json()) as {
          events?: Array<{ eventAtMs?: number; message?: string }>;
        };
      } catch {
        return null;
      }
    })
  );

  const reached = responses.filter((r) => Boolean(r));
  const seen = new Set<string>();
  const merged = reached
    .flatMap((payload) => payload?.events ?? [])
    .map((event) => ({
      eventAtMs: Number(event?.eventAtMs ?? 0),
      message: String(event?.message ?? "").trim()
    }))
    .filter((event) => event.eventAtMs > 0 && event.message.length > 0)
    .filter((event) => {
      const key = `${event.eventAtMs}:${event.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.eventAtMs - a.eventAtMs)
    .slice(0, 250);

  return reply.send({
    ok: true,
    agentId,
    events: merged,
    reachedCoordinators: reached.length
  });
});

app.post("/coordinator/ops/node-approval", async (req, reply) => {
  const principal = await requireCoordinatorOperationsUser(req as any, reply);
  if (!principal) return;
  const { access } = principal;
  if (!access.canManageCoordinatorOps) {
    return reply.code(403).send({ error: "coordinator_operations_forbidden" });
  }
  if (!CONTROL_PLANE_URL || !CONTROL_PLANE_ADMIN_TOKEN) {
    return reply.code(503).send({ error: "control_plane_not_configured" });
  }
  const body = z
    .object({
      nodeId: z.string().min(3),
      nodeKind: z.enum(["agent", "coordinator"]),
      approved: z.boolean()
    })
    .parse(req.body);
  const pathSegment = body.nodeKind === "agent" ? "agents" : "coordinators";
  try {
    const res = await request(`${CONTROL_PLANE_URL}/${pathSegment}/${body.nodeId}/approval`, {
      method: "POST",
      headers: controlPlaneHeaders(true),
      body: JSON.stringify({ approved: body.approved })
    });
    const payload = await res.body.json();
    if (res.statusCode >= 200 && res.statusCode < 300 && !body.approved && store) {
      const existing = await store.getNodeEnrollment(body.nodeId);
      // "Reject" on a pending request should remove it from enrollment queue.
      if (existing && existing.nodeApproved !== true) {
        await store.deleteNodeEnrollment(body.nodeId);
      }
    }
    return reply.code(res.statusCode).send(payload);
  } catch {
    return reply.code(502).send({ error: "control_plane_unreachable" });
  }
});

app.post("/coordinator/ops/coordinator-ollama", async (req, reply) => {
  const principal = await requireCoordinatorOperationsUser(req as any, reply);
  if (!principal) return;
  const { access } = principal;
  if (!access.canManageCoordinatorOps) {
    return reply.code(403).send({ error: "coordinator_operations_forbidden" });
  }
  if (!CONTROL_PLANE_URL || !CONTROL_PLANE_ADMIN_TOKEN) {
    return reply.code(503).send({ error: "control_plane_not_configured" });
  }
  const body = z
    .object({
      provider: z.enum(["edgecoder-local", "ollama-local"]).default("ollama-local"),
      model: z.string().default("qwen3.5:9b"),
      autoInstall: z.boolean().default(true)
    })
    .parse(req.body);
  try {
    const res = await request(`${CONTROL_PLANE_URL}/ops/coordinator-ollama`, {
      method: "POST",
      headers: controlPlaneHeaders(true),
      body: JSON.stringify(body)
    });
    return reply.code(res.statusCode).send(await res.body.json());
  } catch {
    return reply.code(502).send({ error: "control_plane_unreachable" });
  }
});

app.post("/coordinator/ops/agents-model", async (req, reply) => {
  const principal = await requireCoordinatorOperationsUser(req as any, reply);
  if (!principal) return;
  const { user, access } = principal;
  if (!access.canManageCoordinatorOps) {
    return reply.code(403).send({ error: "coordinator_operations_forbidden" });
  }
  if (!CONTROL_PLANE_URL || !CONTROL_PLANE_ADMIN_TOKEN) {
    return reply.code(503).send({ error: "control_plane_not_configured" });
  }
  const body = z
    .object({
      agentIds: z.array(z.string().min(3)).min(1).max(250),
      provider: z.enum(["edgecoder-local", "ollama-local"]).default("ollama-local"),
      model: z.string().default("qwen3.5:9b"),
      autoInstall: z.boolean().default(true)
    })
    .parse(req.body);
  const uniqueAgentIds = Array.from(new Set(body.agentIds.map((id) => id.trim()).filter(Boolean)));
  if (uniqueAgentIds.length === 0) {
    return reply.code(400).send({ error: "agent_ids_required" });
  }
  if (!access.isSystemAdmin) {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    for (const agentId of uniqueAgentIds) {
      const enrollment = await store.getNodeEnrollment(agentId);
      if (!enrollment || enrollment.nodeKind !== "agent" || enrollment.ownerUserId !== user.userId) {
        return reply.code(403).send({ error: "agent_model_switch_forbidden_for_owner_scope" });
      }
    }
  }
  const results: Array<{ agentId: string; ok: boolean; statusCode?: number; error?: string; rolloutId?: string }> = [];
  for (const agentId of uniqueAgentIds) {
    try {
      const res = await request(`${CONTROL_PLANE_URL}/orchestration/install-model`, {
        method: "POST",
        headers: controlPlaneHeaders(true),
        body: JSON.stringify({
          target: "agent",
          agentId,
          provider: body.provider,
          model: body.model,
          autoInstall: body.autoInstall,
          requestedBy: user.email
        })
      });
      const payload = (await res.body.json()) as { error?: string; rolloutId?: string };
      results.push({
        agentId,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        statusCode: res.statusCode,
        error: payload?.error,
        rolloutId: payload?.rolloutId
      });
    } catch (error) {
      results.push({ agentId, ok: false, error: String(error) });
    }
  }
  const success = results.filter((r) => r.ok).length;
  return reply.send({
    ok: success > 0,
    provider: body.provider,
    model: body.model,
    autoInstall: body.autoInstall,
    requested: uniqueAgentIds.length,
    success,
    failed: uniqueAgentIds.length - success,
    results
  });
});

// ---------------------------------------------------------------------------
// Chat API — conversations CRUD + streaming chat
// ---------------------------------------------------------------------------

app.get("/portal/api/conversations", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const conversations = await store.listConversations(user.userId);
  return reply.send({ conversations });
});

app.post("/portal/api/conversations", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const body = z.object({ title: z.string().optional() }).parse(req.body);
  const conversationId = randomUUID();
  await store.createConversation({ conversationId, userId: user.userId, title: body.title });
  return reply.send({ conversationId });
});

app.get("/portal/api/conversations/:id/messages", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const { id } = req.params as { id: string };
  const messages = await store.getConversationMessages(id);
  return reply.send({ messages });
});

app.patch("/portal/api/conversations/:id", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const { id } = req.params as { id: string };
  const body = z.object({ title: z.string().min(1) }).parse(req.body);
  await store.renameConversation(id, body.title);
  return reply.send({ ok: true });
});

app.delete("/portal/api/conversations/:id", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const { id } = req.params as { id: string };
  await store.deleteConversation(id);
  return reply.send({ ok: true });
});

app.get("/portal/api/models", async (req, reply) => {
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });

  const coordinatorUrls = await discoverCoordinatorUrlsForPortal();
  if (coordinatorUrls.length === 0) {
    return reply.send({ local: [], swarm: [] });
  }
  const coordinatorUrl = coordinatorUrls[0].replace(/\/$/, "");
  const hdrs: Record<string, string> = {};
  if (PORTAL_SERVICE_TOKEN) hdrs["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;

  let local: Array<{ name: string; parameterSize: string; quantization: string; running: boolean }> = [];
  let swarm: Array<{ model: string; paramSize: number; agentCount: number }> = [];

  // Fetch Ollama tags via coordinator proxy
  try {
    const tagsRes = await request(`${coordinatorUrl}/portal/models`, {
      method: "GET",
      headers: hdrs,
      headersTimeout: 5_000,
    });
    if (tagsRes.statusCode >= 200 && tagsRes.statusCode < 300) {
      const data = (await tagsRes.body.json()) as { local?: typeof local; swarm?: typeof swarm };
      local = data.local ?? [];
      swarm = data.swarm ?? [];
    } else {
      await tagsRes.body.text().catch(() => "");
    }
  } catch {
    // coordinator unreachable
  }

  // Fallback: try swarm models directly if coordinator didn't return them
  if (swarm.length === 0) {
    try {
      const swarmRes = await request(`${coordinatorUrl}/models/available`, {
        method: "GET",
        headers: hdrs,
        headersTimeout: 5_000,
      });
      if (swarmRes.statusCode >= 200 && swarmRes.statusCode < 300) {
        swarm = (await swarmRes.body.json()) as typeof swarm;
      } else {
        await swarmRes.body.text().catch(() => "");
      }
    } catch {
      // ignore
    }
  }

  return reply.send({ local, swarm });
});

app.post("/portal/api/chat", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });

  const body = z.object({
    conversationId: z.string().min(1),
    message: z.string().min(1),
    model: z.string().optional(),
  }).parse(req.body);

  // Save user message
  await store.addMessage({
    messageId: randomUUID(),
    conversationId: body.conversationId,
    role: "user",
    content: body.message
  });

  // Build message history from conversation
  const history = await store.getConversationMessages(body.conversationId);
  const messages = history.map((m) => ({ role: m.role, content: m.content }));

  // Discover coordinators
  const coordinatorUrls = await discoverCoordinatorUrlsForPortal();
  if (coordinatorUrls.length === 0) {
    return reply.code(502).send({ error: "no_coordinators_available" });
  }

  // Call coordinator's portal chat endpoint (streams Ollama via SSE)
  const chatHeaders: Record<string, string> = { "content-type": "application/json" };
  if (PORTAL_SERVICE_TOKEN) chatHeaders["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;

  const chatPayload: Record<string, unknown> = { messages };
  if (body.model) chatPayload.model = body.model;

  // Try each coordinator until one responds with 2xx
  let coordinatorRes;
  let lastError = "";
  for (const rawUrl of coordinatorUrls) {
    const coordinatorUrl = rawUrl.replace(/\/$/, "");
    try {
      coordinatorRes = await request(`${coordinatorUrl}/portal/chat`, {
        method: "POST",
        headers: chatHeaders,
        body: JSON.stringify(chatPayload),
        headersTimeout: 120_000, // allow time for cold model loads (~70s)
        bodyTimeout: 0, // no body timeout for streaming
      });
      if (coordinatorRes.statusCode >= 200 && coordinatorRes.statusCode < 300) {
        break; // success — stream this response
      }
      // Non-2xx: consume body, try next coordinator
      lastError = await coordinatorRes.body.text().catch(() => "");
      coordinatorRes = null;
    } catch (err) {
      lastError = String(err);
      coordinatorRes = null;
    }
  }

  if (!coordinatorRes) {
    return reply.code(502).send({
      error: "all_coordinators_failed",
      detail: lastError,
      triedCount: coordinatorUrls.length,
    });
  }

  // Stream SSE response from coordinator to browser
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  let fullContent = "";
  try {
    for await (const chunk of coordinatorRes.body) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const line of text.split("\n")) {
        const trimmed = line.replace(/^data:\s*/, "").trim();
        if (!trimmed) continue;
        if (trimmed === "[DONE]") break;
        try {
          const parsed = JSON.parse(trimmed) as { content?: string; warning?: string };
          if (parsed.warning) {
            reply.raw.write(`data: ${JSON.stringify({ warning: parsed.warning })}\n\n`);
          }
          if (parsed.content) {
            fullContent += parsed.content;
            reply.raw.write(`data: ${JSON.stringify({ content: parsed.content })}\n\n`);
          }
        } catch {
          // skip unparseable lines
        }
      }
    }
  } catch {
    reply.raw.write(`data: ${JSON.stringify({ error: "stream_interrupted" })}\n\n`);
  }

  // Save assistant message
  if (fullContent.length > 0) {
    await store.addMessage({
      messageId: randomUUID(),
      conversationId: body.conversationId,
      role: "assistant",
      content: fullContent
    });
  }

  reply.raw.write("data: [DONE]\n\n");
  reply.raw.end();
});

// ---------------------------------------------------------------------------
// Reviews API — Cloud Review Diff UI for handshake escalations
// ---------------------------------------------------------------------------

app.get("/portal/api/reviews", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });

  const coordinatorUrls = await discoverCoordinatorUrlsForPortal();
  if (coordinatorUrls.length === 0) {
    return reply.send({ reviews: [] });
  }
  const coordinatorUrl = coordinatorUrls[0].replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (PORTAL_SERVICE_TOKEN) headers["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;

  try {
    const res = await request(`${coordinatorUrl}/escalate`, {
      method: "GET",
      headers,
      headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
      bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
    });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const payload = (await res.body.json()) as {
        escalations?: Array<{
          taskId: string;
          status: string;
          request?: { task?: string; language?: string };
          improvedCode?: string;
        }>;
      };
      const reviews = (payload.escalations ?? []).map((e) => ({
        taskId: e.taskId,
        status: e.status,
        task: e.request?.task ?? "",
        language: e.request?.language ?? "",
        createdAtMs: Date.now()
      }));
      return reply.send({ reviews });
    }
    // If the coordinator doesn't support listing, return empty
    await res.body.text();
    return reply.send({ reviews: [] });
  } catch {
    return reply.send({ reviews: [] });
  }
});

app.get("/portal/api/reviews/:taskId", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });

  const { taskId } = req.params as { taskId: string };
  const coordinatorUrls = await discoverCoordinatorUrlsForPortal();
  if (coordinatorUrls.length === 0) {
    return reply.code(502).send({ error: "no_coordinators_available" });
  }
  const coordinatorUrl = coordinatorUrls[0].replace(/\/$/, "");
  const headers: Record<string, string> = {};
  if (PORTAL_SERVICE_TOKEN) headers["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;

  try {
    const res = await request(`${coordinatorUrl}/escalate/${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers,
      headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
      bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
    });
    if (res.statusCode === 404) {
      await res.body.text();
      return reply.code(404).send({ error: "review_not_found" });
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const payload = (await res.body.json()) as {
        taskId: string;
        status: string;
        improvedCode?: string;
        explanation?: string;
        resolvedByModel?: string;
        request?: {
          task?: string;
          failedCode?: string;
          language?: string;
          errorHistory?: string[];
        };
      };
      return reply.send({
        taskId: payload.taskId,
        status: payload.status,
        improvedCode: payload.improvedCode ?? "",
        explanation: payload.explanation ?? "",
        resolvedByModel: payload.resolvedByModel ?? "",
        task: payload.request?.task ?? "",
        failedCode: payload.request?.failedCode ?? "",
        language: payload.request?.language ?? "",
        errorHistory: payload.request?.errorHistory ?? []
      });
    }
    const errBody = await res.body.text();
    return reply.code(502).send({ error: "coordinator_error", detail: errBody });
  } catch (err) {
    return reply.code(502).send({ error: "coordinator_request_failed", detail: String(err) });
  }
});

app.post("/portal/api/reviews/:taskId/decision", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });

  const { taskId } = req.params as { taskId: string };
  const body = z.object({
    decision: z.enum(["accept", "reject", "edit"]),
    editedCode: z.string().optional()
  }).parse(req.body);

  const coordinatorUrls = await discoverCoordinatorUrlsForPortal();
  if (coordinatorUrls.length === 0) {
    return reply.code(502).send({ error: "no_coordinators_available" });
  }
  const coordinatorUrl = coordinatorUrls[0].replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (PORTAL_SERVICE_TOKEN) headers["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;

  const status = body.decision === "reject" ? "failed" : "completed";
  const improvedCode = body.decision === "edit" ? body.editedCode : undefined;

  try {
    const res = await request(`${coordinatorUrl}/escalate/${encodeURIComponent(taskId)}/result`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        taskId,
        status,
        improvedCode,
        explanation: `User decision: ${body.decision}`
      }),
      headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
      bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
    });
    if (res.statusCode >= 200 && res.statusCode < 300) {
      const payload = await res.body.json();
      return reply.send({ ok: true, detail: payload });
    }
    const errBody = await res.body.text();
    return reply.code(502).send({ error: "coordinator_error", detail: errBody });
  } catch (err) {
    return reply.code(502).send({ error: "coordinator_request_failed", detail: String(err) });
  }
});

// #16: HTML pages live in src/portal/pages/.
registerPortalPages(app);

// #40: every /internal/* route lives in this plugin, so new internal routes inherit the token check.
await app.register(async (internal) => {
internal.addHook("onRequest", async (req, reply) => {
  if (!requireInternalToken(req as any, reply)) return reply;
});

internal.post("/internal/nodes/validate", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  if (!requireInternalToken(req as any, reply)) return;
  const body = z
    .object({
      nodeId: z.string().min(3),
      nodeKind: z.enum(["agent", "coordinator"]),
      registrationToken: z.string().min(10),
      deviceId: z.string().min(3).max(128).optional(),
      sourceIp: z.string().optional()
    })
    .parse(req.body);
  const requestDeviceId = body.deviceId?.trim().toLowerCase() || deriveIosDeviceIdFromNodeId(body.nodeId);
  let node = await store.getNodeEnrollment(body.nodeId);
  if (!node && requestDeviceId) {
    node = await store.getNodeEnrollmentByDeviceId(requestDeviceId);
  }
  if (!node) {
    return reply.code(404).send({ allowed: false, reason: "node_not_enrolled" });
  }
  if (node.nodeKind !== body.nodeKind) {
    return reply.code(403).send({ allowed: false, reason: "node_kind_mismatch" });
  }
  if (!secureCompare(node.registrationTokenHash, sha256Hex(body.registrationToken))) {
    return reply.code(403).send({ allowed: false, reason: "registration_token_invalid" });
  }
  const intelligence = await resolveIpIntelligence(body.sourceIp);
  await store.touchNodeValidation({
    nodeId: node.nodeId,
    sourceIp: body.sourceIp,
    countryCode: intelligence.countryCode,
    vpnDetected: intelligence.vpnDetected
  });
  const refreshed = await store.getNodeEnrollment(node.nodeId);
  if (!refreshed) return reply.code(404).send({ allowed: false, reason: "node_missing_after_touch" });

  // Sync DNS for coordinator nodes (fire-and-forget)
  if (
    refreshed.nodeKind === "coordinator" &&
    refreshed.active &&
    body.sourceIp &&
    isDnsConfigured() &&
    store
  ) {
    syncCoordinatorDns({
      nodeId: refreshed.nodeId,
      sourceIp: body.sourceIp,
      currentDnsIp: refreshed.dnsIp ?? null,
      dnsLastUpdatedMs: refreshed.dnsLastUpdatedMs ?? null,
    })
      .then(async (result) => {
        const hostname = refreshed.dnsHostname || getCoordinatorHostname(refreshed.nodeId);
        await store.updateNodeDns({
          nodeId: refreshed.nodeId,
          dnsHostname: hostname,
          dnsStatus: result.dnsStatus,
          dnsIp: result.dnsIp,
        });
      })
      .catch((err) =>
        console.error(`[portal] DNS sync failed for ${refreshed.nodeId}:`, err)
      );
  }

  const reason = !refreshed.emailVerified
    ? "email_unverified"
    : !refreshed.nodeApproved
      ? "node_pending_coordinator_approval"
      : refreshed.active
        ? "ok"
        : "node_inactive";

  return reply.send({
    allowed: refreshed.active,
    reason,
    node: {
      nodeId: refreshed.nodeId,
      deviceId: refreshed.deviceId,
      nodeKind: refreshed.nodeKind,
      ownerEmail: refreshed.ownerEmail,
      emailVerified: refreshed.emailVerified,
      nodeApproved: refreshed.nodeApproved,
      active: refreshed.active,
      sourceIp: refreshed.lastIp,
      countryCode: refreshed.lastCountryCode,
      vpnDetected: refreshed.lastVpnDetected ?? false
    }
  });
});

internal.post("/internal/nodes/:nodeId/approval", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  if (!requireInternalToken(req as any, reply)) return;
  const params = z.object({ nodeId: z.string() }).parse(req.params);
  const body = z.object({ approved: z.boolean() }).parse(req.body);
  const updated = await store.setNodeApproval(params.nodeId, body.approved);
  if (!updated) return reply.code(404).send({ error: "node_not_found" });

  // If coordinator is being deactivated, remove DNS record
  if (
    updated &&
    updated.nodeKind === "coordinator" &&
    !body.approved &&
    updated.dnsHostname
  ) {
    deleteDnsRecord(updated.nodeId).catch((err) =>
      console.error(`[portal] DNS delete failed for ${updated.nodeId}:`, err)
    );
    if (store) {
      await store.updateNodeDns({
        nodeId: updated.nodeId,
        dnsHostname: updated.dnsHostname,
        dnsStatus: "pending",
        dnsIp: null,
      });
    }
  }

  return reply.send({ ok: true, node: updated });
});

internal.post("/internal/nodes/lookup", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  if (!requireInternalToken(req as any, reply)) return;
  const body = z.object({ nodeIds: z.array(z.string()).max(200) }).parse(req.body);
  const nodes = await Promise.all(body.nodeIds.map((nodeId) => store.getNodeEnrollment(nodeId)));
  return reply.send({
    nodes: nodes.filter((n): n is NonNullable<typeof n> => Boolean(n)).map((n) => ({
      nodeId: n.nodeId,
      nodeKind: n.nodeKind,
      ownerEmail: n.ownerEmail,
      emailVerified: n.emailVerified,
      nodeApproved: n.nodeApproved,
      active: n.active,
      sourceIp: n.lastIp,
      countryCode: n.lastCountryCode,
      vpnDetected: n.lastVpnDetected ?? false,
      lastSeenMs: n.lastSeenMs
    }))
  });
});

internal.get("/internal/nodes/pending", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  if (!requireInternalToken(req as any, reply)) return;
  const query = z
    .object({
      nodeKind: z.enum(["agent", "coordinator"]).optional(),
      limit: z.coerce.number().int().positive().max(500).default(200)
    })
    .parse(req.query);
  const nodes = await store.listPendingNodes({ nodeKind: query.nodeKind, limit: query.limit });
  return reply.send({
    nodes: nodes.map((n) => ({
      nodeId: n.nodeId,
      nodeKind: n.nodeKind,
      ownerEmail: n.ownerEmail,
      emailVerified: n.emailVerified,
      nodeApproved: n.nodeApproved,
      active: n.active,
      sourceIp: n.lastIp,
      countryCode: n.lastCountryCode,
      vpnDetected: n.lastVpnDetected ?? false,
      lastSeenMs: n.lastSeenMs,
      updatedAtMs: n.updatedAtMs
    }))
  });
});

internal.get("/internal/stats/counts", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  if (!requireInternalToken(req as any, reply)) return;
  const counts = await store.getStatsCounts();
  return reply.send(counts);
});

}); // end /internal plugin (#40)

// ---------------------------------------------------------------------------
// Human Escalation API — surfaces tasks that exhausted all automated
// resolvers and need human operator input.
// ---------------------------------------------------------------------------

import {
  getHumanEscalation,
  listHumanEscalations,
  updateHumanEscalation,
  countPendingHumanEscalations,
} from "../escalation/human-store.js";
import type { HumanEscalationResponse } from "../escalation/types.js";

/**
 * GET /portal/api/escalations — list pending human escalations.
 */
app.get("/portal/api/escalations", async (req, reply) => {
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const pending = listHumanEscalations("pending_human");
  return reply.send({ escalations: pending });
});

/**
 * GET /portal/api/escalations/pending-count — lightweight polling endpoint
 * that returns the number of escalations awaiting human input.
 */
app.get("/portal/api/escalations/pending-count", async (req, reply) => {
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  return reply.send({ count: countPendingHumanEscalations() });
});

/**
 * GET /portal/api/escalations/:id — get full details for a single escalation.
 */
app.get("/portal/api/escalations/:id", async (req, reply) => {
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const { id } = req.params as { id: string };
  const entry = getHumanEscalation(id);
  if (!entry) return reply.code(404).send({ error: "escalation_not_found" });
  return reply.send({ escalation: entry });
});

/**
 * POST /portal/api/escalations/:id/respond — submit a human response.
 *
 * Body: { action: "provide_context" | "edit_code" | "abandon", context?: string, editedCode?: string }
 */
app.post("/portal/api/escalations/:id/respond", async (req, reply) => {
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const { id } = req.params as { id: string };
  const entry = getHumanEscalation(id);
  if (!entry) return reply.code(404).send({ error: "escalation_not_found" });
  if (entry.status !== "pending_human") {
    return reply.code(409).send({ error: "escalation_not_pending" });
  }

  const body = z.object({
    action: z.enum(["provide_context", "edit_code", "abandon"]),
    context: z.string().optional(),
    editedCode: z.string().optional(),
  }).parse(req.body) as HumanEscalationResponse;

  if (body.action === "abandon") {
    updateHumanEscalation(id, {
      status: "abandoned",
      respondedByUserId: user.userId,
    });
    return reply.send({ ok: true, status: "abandoned" });
  }

  if (body.action === "edit_code") {
    if (!body.editedCode) {
      return reply.code(400).send({ error: "editedCode_required_for_edit_code_action" });
    }
    updateHumanEscalation(id, {
      status: "resolved",
      humanEditedCode: body.editedCode,
      respondedByUserId: user.userId,
    });
    return reply.send({ ok: true, status: "resolved", improvedCode: body.editedCode });
  }

  // action === "provide_context"
  if (!body.context) {
    return reply.code(400).send({ error: "context_required_for_provide_context_action" });
  }
  updateHumanEscalation(id, {
    status: "human_responded",
    humanContext: body.context,
    respondedByUserId: user.userId,
  });
  return reply.send({ ok: true, status: "human_responded", humanContext: body.context });
});

// ── DNS staleness sweep ──────────────────────────────────────────
const DNS_STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DNS_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

async function runDnsStaleSweep(): Promise<void> {
  if (!store || !isDnsConfigured()) return;
  try {
    const count = await store.markStaleCoordinatorDns(DNS_STALE_THRESHOLD_MS);
    if (count > 0) {
      console.log(`[portal] DNS stale sweep: marked ${count} coordinator(s) as stale`);
    }
  } catch (err) {
    console.error("[portal] DNS stale sweep failed:", err);
  }
}

if (isDnsConfigured()) {
  setInterval(runDnsStaleSweep, DNS_SWEEP_INTERVAL_MS);
  // Run once at startup after a short delay
  setTimeout(runDnsStaleSweep, 30_000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.resolve()
    .then(async () => {
      validatePortalSecurityConfig();
      if (!store) throw new Error("PORTAL_DATABASE_URL is required for portal service.");
      await store.migrate();
    })
    .then(() => app.listen({ port: 4310, host: LISTEN_HOST }))
    .catch((error) => {
      app.log.error(error);
      process.exit(1);
    });
}

export { app as portalServer };

