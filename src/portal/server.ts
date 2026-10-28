// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import Fastify from "fastify";
import { registerPortalPages } from "./pages/index.js";
import { appendSetCookie } from "./oauth-state-cookie.js";
import { registerWellKnownRoutes } from "./routes/well-known.js";
import { startDnsStaleSweep } from "./dns-sweep.js";
import { createPortalMailer } from "./email.js";
import { registerInternalRoutes } from "./routes/internal.js";
import { registerAccountApiRoutes } from "./routes/account.js";
import { registerPasskeyRoutes } from "./routes/passkey.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCoordinatorOpsRoutes } from "./routes/coordinator-ops.js";
import { registerWalletRoutes } from "./routes/wallet.js";
import { registerChatApiRoutes } from "./routes/chat.js";
import { registerReviewRoutes } from "./routes/reviews.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerEscalationRoutes } from "./routes/escalations.js";
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

export type ProviderName = "google" | "microsoft" | "github";
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

const { sendVerificationEmail, sendWalletSendMfaCodeEmail } = createPortalMailer(
  {
    resendApiKey: RESEND_API_KEY,
    resendFromEmail: RESEND_FROM_EMAIL,
    portalPublicUrl: PORTAL_PUBLIC_URL,
    walletSendMfaTtlMs: WALLET_SEND_MFA_TTL_MS
  },
  { warn: (msg) => app.log.warn(msg) }
);

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
  // #88: append, so a cookie set earlier in the same response (OAuth state clear) survives.
  appendSetCookie(reply, encodeCookie("edgecoder_portal_session", sessionToken, Math.floor(SESSION_TTL_MS / 1000)));
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
registerWellKnownRoutes(app);

const authRouteDeps = { EMAIL_VERIFY_TTL_MS, OAUTH_MICROSOFT_PROMPT, PASSKEY_ALLOWED_ORIGINS, PASSKEY_RP_ID, PORTAL_PUBLIC_URL, claimIsTrue, clearCookies, consumeMobileOauthSessionToken, createSessionForUser, decodeJwtPayload, ensureCreditAccountForUser, ensureStarterWalletForUser, getCurrentUser, hashPassword, issueMobileOauthSessionToken, normalizeEmail, normalizeNativeOauthRedirect, oauthNativeRedirectByState, oauthProviders, parseCookies, readCookie, sendVerificationEmail, sha256Hex, store, verifyPassword };
export type AuthRoutesDeps = typeof authRouteDeps;
registerAuthRoutes(app, authRouteDeps);

const passkeyRouteDeps = { PASSKEY_ALLOWED_ORIGINS, PASSKEY_CHALLENGE_TTL_MS, PASSKEY_RP_ID, PASSKEY_RP_NAME, base64UrlFromBuffer, createSessionForUser, deriveCredentialIdFromVerifyBody, generateAuthenticationOptions, generateRegistrationOptions, getCurrentUser, normalizeEmail, normalizePasskeyResponsePayload, store, uint8ArrayFromBase64Url, verifyAuthenticationResponse, verifyRegistrationResponse };
export type PasskeyRoutesDeps = typeof passkeyRouteDeps;
registerPasskeyRoutes(app, passkeyRouteDeps);

const walletRouteDeps = { PASSKEY_ALLOWED_ORIGINS, PASSKEY_RP_ID, RESEND_API_KEY, RESEND_FROM_EMAIL, WALLET_SEND_MFA_TTL_MS, ensureCreditAccountForUser, generateAuthenticationOptions, generateSixDigitCode, getCurrentUser, secureCompare, sendWalletSendMfaCodeEmail, setupWalletSeedForUser, sha256Hex, store, uint8ArrayFromBase64Url, verifyAuthenticationResponse };
export type WalletRoutesDeps = typeof walletRouteDeps;
registerWalletRoutes(app, walletRouteDeps);

const accountRouteDeps = { CONTROL_PLANE_ADMIN_TOKEN, CONTROL_PLANE_URL, EXTERNAL_HTTP_TIMEOUT_MS, buildAccessContext, controlPlaneHeaders, deleteDnsRecord, deriveIosDeviceIdFromNodeId, ensureCreditAccountForUser, getCoordinatorHostname, getCurrentUser, loadIosAgentContributionForUser, loadIosNetworkSummary, loadNetworkInsightsForUser, loadWalletSnapshotForUser, sha256Hex, store };
export type AccountApiRoutesDeps = typeof accountRouteDeps;
registerAccountApiRoutes(app, accountRouteDeps);

const coordinatorOpsRouteDeps = { CONTROL_PLANE_ADMIN_TOKEN, CONTROL_PLANE_URL, EXTERNAL_HTTP_TIMEOUT_MS, PORTAL_SERVICE_TOKEN, controlPlaneHeaders, discoverCoordinatorUrlsForPortal, fetchCoordinatorFederatedSummary, requireCoordinatorOperationsUser, store };
export type CoordinatorOpsRoutesDeps = typeof coordinatorOpsRouteDeps;
registerCoordinatorOpsRoutes(app, coordinatorOpsRouteDeps);

// ---------------------------------------------------------------------------
// Chat API — conversations CRUD + streaming chat
// ---------------------------------------------------------------------------

registerConversationRoutes(app, { store, getCurrentUser });

const chatRouteDeps = { PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal, getCurrentUser, store };
export type ChatApiRoutesDeps = typeof chatRouteDeps;
registerChatApiRoutes(app, chatRouteDeps);

// ---------------------------------------------------------------------------
// Reviews API — Cloud Review Diff UI for handshake escalations
// ---------------------------------------------------------------------------

const reviewsRouteDeps = { EXTERNAL_HTTP_TIMEOUT_MS, PORTAL_SERVICE_TOKEN, discoverCoordinatorUrlsForPortal, getCurrentUser, store };
export type ReviewRoutesDeps = typeof reviewsRouteDeps;
registerReviewRoutes(app, reviewsRouteDeps);


// #16: HTML pages live in src/portal/pages/.
registerPortalPages(app);

// #40: every /internal/* route lives in this plugin, so new internal routes inherit the token check.
const internalRouteDeps = { deleteDnsRecord, deriveIosDeviceIdFromNodeId, getCoordinatorHostname, isDnsConfigured, requireInternalToken, resolveIpIntelligence, secureCompare, sha256Hex, store, syncCoordinatorDns };
export type InternalRoutesDeps = typeof internalRouteDeps;
await app.register(async (internal) => {
  registerInternalRoutes(internal, internalRouteDeps);
}); // end /internal plugin (#40)

registerEscalationRoutes(app, { getCurrentUser });

// DNS staleness sweep (src/portal/dns-sweep.ts).
startDnsStaleSweep(store);

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

