import Fastify from "fastify";
import { randomUUID, createHash } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
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
  clearCookie,
  hashPassword,
  verifyPassword,
  decodeJwtPayload,
  claimIsTrue,
  base64UrlFromBuffer,
  bufferFromBase64Url,
  normalizeBase64UrlString,
  deriveWalletSecretRef,
  generateSixDigitCode,
  deriveIosDeviceIdFromNodeId,
  normalizePasskeyResponsePayload,
  deriveCredentialIdFromVerifyBody
} from "./portal-utils.js";

const app = Fastify({ logger: true });
const store = PortalStore.fromEnv();

const PORTAL_SERVICE_TOKEN = process.env.PORTAL_SERVICE_TOKEN ?? "";
const EXTERNAL_HTTP_TIMEOUT_MS = Number(process.env.PORTAL_EXTERNAL_HTTP_TIMEOUT_MS ?? 7000);
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "";
const PORTAL_PUBLIC_URL = process.env.PORTAL_PUBLIC_URL ?? "http://127.0.0.1:4310";
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? "";
const CONTROL_PLANE_ADMIN_TOKEN = process.env.CONTROL_PLANE_ADMIN_TOKEN ?? "";
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
const GITHUB_REPO_URL = process.env.GITHUB_REPO_URL ?? "https://github.com/your-org/Edgecoder";
const DOCS_SITE_URL = process.env.DOCS_SITE_URL ?? "http://127.0.0.1:5173";
const WALLET_DEFAULT_NETWORK = (process.env.WALLET_DEFAULT_NETWORK ?? "signet") as "bitcoin" | "testnet" | "signet";
const NODE_ENV = process.env.NODE_ENV ?? "development";
const WALLET_SECRET_PEPPER = process.env.WALLET_SECRET_PEPPER ?? "";
const COORDINATOR_OPERATIONS_OWNER_EMAILS = new Set(
  (process.env.COORDINATOR_OPERATIONS_OWNER_EMAILS ?? "admin@example.com")
    .split(",")
    .map((value) => normalizeEmail(value))
    .filter(Boolean)
);
const SYSTEM_ADMIN_EMAILS = new Set(
  (process.env.SYSTEM_ADMIN_EMAILS ?? "admin@example.com")
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

type ProviderName = "google" | "microsoft";
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
  }
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
  if (!CONTROL_PLANE_URL) missing.push("CONTROL_PLANE_URL");
  if (!CONTROL_PLANE_ADMIN_TOKEN) missing.push("CONTROL_PLANE_ADMIN_TOKEN");
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
  const sessionToken = cookies.edgecoder_portal_session;
  if (!sessionToken) return null;
  const session = await store.getSessionByTokenHash(sha256Hex(sessionToken));
  if (!session) return null;
  const user = await store.getUserById(session.userId);
  if (!user) return null;
  return user;
}

function requireInternalToken(req: { headers: Record<string, unknown> }, reply: any): boolean {
  if (!PORTAL_SERVICE_TOKEN) return true;
  const token = req.headers["x-portal-service-token"];
  if (typeof token === "string" && token === PORTAL_SERVICE_TOKEN) return true;
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
  await store?.createWalletOnboarding({
    userId: user.userId,
    accountId,
    network: WALLET_DEFAULT_NETWORK,
    seedPhraseHash: sha256Hex(seedPhrase),
    encryptedPrivateKeyRef
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
        encryptedSecretRef: encryptedPrivateKeyRef
      })
    }).catch(() => undefined);
  }

  return {
    created: true,
    accountId,
    network: WALLET_DEFAULT_NETWORK,
    seedPhrase,
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
  guidance: { title: string; steps: string[] };
}> {
  const existing = await store?.getWalletOnboardingByUserId(user.userId);
  const accountId = existing?.accountId ?? `acct-${user.userId}`;
  const network = (existing?.network as "bitcoin" | "testnet" | "signet" | undefined) ?? WALLET_DEFAULT_NETWORK;
  const seedPhrase = generateMnemonic(128);
  const encryptedPrivateKeyRef = deriveWalletSecretRef(seedPhrase, accountId, WALLET_SECRET_PEPPER);

  await store?.upsertWalletOnboardingSeed({
    userId: user.userId,
    accountId,
    network,
    seedPhraseHash: sha256Hex(seedPhrase),
    encryptedPrivateKeyRef
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
        encryptedSecretRef: encryptedPrivateKeyRef
      })
    }).catch(() => undefined);
  }

  return {
    accountId,
    network,
    seedPhrase,
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

async function createSessionForUser(userId: string, reply: any): Promise<void> {
  const sessionToken = randomUUID();
  await store?.createSession({
    sessionId: randomUUID(),
    userId,
    tokenHash: sha256Hex(sessionToken),
    expiresAtMs: Date.now() + SESSION_TTL_MS
  });
  reply.header("set-cookie", encodeCookie("edgecoder_portal_session", sessionToken, Math.floor(SESSION_TTL_MS / 1000)));
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

async function buildAccessContext(user: { userId: string; email: string }): Promise<PortalAccessContext> {
  const normalizedEmail = normalizeEmail(user.email);
  const isSystemAdmin = SYSTEM_ADMIN_EMAILS.has(normalizedEmail);
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
  try {
    const [creditRes, historyRes, walletRes, quoteRes] = await Promise.all([
      request(`${CONTROL_PLANE_URL}/credits/${accountId}/balance`, {
        method: "GET",
        headers: controlPlaneHeaders()
      }),
      request(`${CONTROL_PLANE_URL}/credits/${accountId}/history`, {
        method: "GET",
        headers: controlPlaneHeaders()
      }),
      request(`${CONTROL_PLANE_URL}/wallets/${accountId}`, {
        method: "GET",
        headers: controlPlaneHeaders()
      }),
      request(`${CONTROL_PLANE_URL}/economy/credits/${accountId}/quote`, {
        method: "GET",
        headers: controlPlaneHeaders()
      })
    ]);
    const credits = creditRes.statusCode >= 200 && creditRes.statusCode < 300 ? await creditRes.body.json() : null;
    const historyPayload = historyRes.statusCode >= 200 && historyRes.statusCode < 300
      ? ((await historyRes.body.json()) as { history?: unknown[] })
      : { history: [] };
    const walletPayload = walletRes.statusCode >= 200 && walletRes.statusCode < 300
      ? ((await walletRes.body.json()) as { wallets?: unknown[]; paymentIntents?: unknown[] })
      : { wallets: [], paymentIntents: [] };
    const quote = quoteRes.statusCode >= 200 && quoteRes.statusCode < 300 ? await quoteRes.body.json() : null;
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
  if (!CONTROL_PLANE_URL) return [];
  try {
    const res = await request(`${CONTROL_PLANE_URL}/network/coordinators`, {
      method: "GET",
      headers: controlPlaneHeaders(),
      headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
      bodyTimeout: EXTERNAL_HTTP_TIMEOUT_MS
    });
    if (res.statusCode < 200 || res.statusCode >= 300) return [];
    const payload = (await res.body.json()) as {
      coordinators?: Array<{ coordinatorUrl?: string }>;
    };
    return (payload.coordinators ?? [])
      .map((item) => String(item.coordinatorUrl ?? "").trim())
      .filter(Boolean)
      .filter((value, index, arr) => arr.indexOf(value) === index);
  } catch {
    return [];
  }
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

function marketingHomeHtml(): string {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>EdgeCoder | Private AI Coding on Your Infrastructure</title>
      <meta
        name="description"
        content="EdgeCoder is a privacy-first coding platform that runs on your machines, keeps sensitive code in your environment, and scales with trusted compute when needed."
      />
      <style>
        :root {
          --bg: #f4f7fc;
          --surface: rgba(255, 255, 255, 0.96);
          --surface-strong: rgba(248, 251, 255, 0.98);
          --text: #0f172a;
          --muted: #475569;
          --brand: #2563eb;
          --brand-2: #0ea5e9;
          --ok: #22c55e;
          --border: rgba(148, 163, 184, 0.28);
        }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; }
        body {
          font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          color: var(--text);
          background:
            radial-gradient(1000px 500px at 0% -20%, rgba(37, 99, 235, 0.12), transparent 60%),
            radial-gradient(900px 500px at 100% 0%, rgba(14, 165, 233, 0.1), transparent 60%),
            var(--bg);
        }
        a { color: inherit; text-decoration: none; }
        .shell {
          width: min(1080px, calc(100% - 32px));
          margin: 0 auto;
          padding: 24px 0 60px;
        }
        .nav {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 24px;
        }
        .brand {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          font-weight: 700;
          letter-spacing: -0.01em;
        }
        .mark {
          width: 34px;
          height: 34px;
          border-radius: 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, var(--brand), var(--brand-2));
          box-shadow: 0 10px 28px rgba(34, 211, 238, 0.24);
        }
        .nav-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .btn {
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 9px 13px;
          font-size: 14px;
          background: rgba(255, 255, 255, 0.9);
          transition: transform 0.08s ease, border-color 0.12s ease;
        }
        .btn:hover { transform: translateY(-1px); border-color: #cbd5e1; }
        .btn.primary {
          background: linear-gradient(135deg, #2563eb, #1d4ed8);
          border-color: rgba(37, 99, 235, 0.72);
          color: #fff;
        }
        .hero {
          border: 1px solid var(--border);
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 251, 255, 0.95));
          border-radius: 18px;
          padding: 34px;
          box-shadow: 0 12px 26px rgba(15, 23, 42, 0.08);
        }
        .eyebrow {
          color: #1d4ed8;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-size: 11px;
          font-weight: 700;
          margin-bottom: 12px;
        }
        h1 {
          margin: 0 0 10px;
          line-height: 1.1;
          font-size: clamp(32px, 6vw, 50px);
          letter-spacing: -0.02em;
        }
        .lead {
          margin: 0;
          color: #334155;
          max-width: 760px;
          font-size: 18px;
          line-height: 1.55;
        }
        .hero-cta {
          margin-top: 18px;
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
        }
        .stat-row {
          margin-top: 20px;
          display: grid;
          grid-template-columns: repeat(3, minmax(160px, 1fr));
          gap: 10px;
        }
        .stat {
          border: 1px solid var(--border);
          background: rgba(255, 255, 255, 0.95);
          border-radius: 12px;
          padding: 12px;
        }
        .stat b { display: block; font-size: 20px; margin-bottom: 4px; }
        .stat span { color: var(--muted); font-size: 13px; }
        .section {
          margin-top: 16px;
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 24px;
          background: var(--surface);
        }
        .section h2 { margin: 0 0 8px; font-size: 24px; letter-spacing: -0.01em; }
        .section p { margin: 0; color: #334155; line-height: 1.6; }
        .grid {
          margin-top: 14px;
          display: grid;
          grid-template-columns: repeat(2, minmax(240px, 1fr));
          gap: 12px;
        }
        .card {
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 14px;
          background: rgba(255, 255, 255, 0.94);
        }
        .card h3 { margin: 0 0 6px; font-size: 17px; }
        .card p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
        .steps {
          margin: 12px 0 0;
          padding-left: 18px;
          color: #334155;
          line-height: 1.65;
        }
        .steps b { color: #0f172a; }
        .footer {
          margin-top: 20px;
          border: 1px solid var(--border);
          border-radius: 14px;
          background: var(--surface-strong);
          padding: 18px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .footer-note { color: var(--muted); font-size: 13px; }
        .ok { color: var(--ok); font-weight: 600; }
        @media (max-width: 900px) {
          .hero { padding: 24px; }
          .stat-row { grid-template-columns: 1fr; }
          .grid { grid-template-columns: 1fr; }
        }
      </style>
    </head>
    <body>
      <main class="shell">
        <nav class="nav">
          <div class="brand">
            <span class="mark">E</span>
            <span>EdgeCoder</span>
          </div>
          <div class="nav-actions">
            <a class="btn" href="/portal">Portal</a>
            <a class="btn" href="${DOCS_SITE_URL}" target="_blank" rel="noreferrer">Docs</a>
            <a class="btn" href="${GITHUB_REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>
            <a class="btn primary" href="/portal">Get Started</a>
          </div>
        </nav>

        <section class="hero">
          <div class="eyebrow">Decentralized Global Shared Compute</div>
          <h1>What is EdgeCoder?</h1>
          <p class="lead">
            EdgeCoder is a decentralized global shared compute network for AI coding workloads, using bitcoin as the incentive framework.
            You can contribute idle compute and earn rewards, or purchase additional compute by providing bitcoin to the network.
            Those funds are distributed to agents and coordinators based on verified effort actually expended.
          </p>
          <div class="hero-cta">
            <a class="btn primary" href="/portal">Open EdgeCoder Portal</a>
            <a class="btn" href="/portal">Explore Features</a>
          </div>
          <div class="stat-row">
            <div class="stat"><b>Private + public crossover</b><span>Route sensitive workloads privately and overflow to approved public capacity.</span></div>
            <div class="stat"><b>Bitcoin incentive framework</b><span>Compute buyers pay in bitcoin; contributors are rewarded from real network demand.</span></div>
            <div class="stat"><b>Effort-based payouts</b><span>Agents and coordinators are rewarded according to verifiable compute effort.</span></div>
          </div>
        </section>

        <section class="section">
          <h2>How the compute economy works</h2>
          <p>
            EdgeCoder matches demand to decentralized global supply, then prices and distributes rewards
            using transparent network participation signals.
          </p>
          <ol class="steps">
            <li><b>Offer compute:</b> operators contribute CPU/GPU capacity from idle machines.</li>
            <li><b>Buy compute with bitcoin:</b> subscribers and agents provide bitcoin when they need additional workload capacity.</li>
            <li><b>Reward actual effort:</b> payouts flow to agents/coordinators based on measurable work completed.</li>
            <li><b>Govern safely:</b> policy, approvals, and auditable controls remain enforced across private and public paths.</li>
          </ol>
        </section>

        <section class="section">
          <h2>Rolling 24-hour token issuance (non-cumulative)</h2>
          <p>
            Token issuance is recalculated continuously from the last 24 hours of effective contribution and network load.
            It is not a cumulative lifetime allowance. If capacity disappears, issuance share decays as that prior contribution
            rolls out of the 24-hour window.
          </p>
          <ol class="steps">
            <li><b>Daily-based, continuously recalculated:</b> every hour, the system refreshes allocation using the most recent rolling 24 hours.</li>
            <li><b>Performance-weighted share:</b> higher available and reliable compute can earn a larger portion of daily issuance.</li>
            <li><b>Automatic roll-off:</b> if a large GPU provider turns off, their share drops hour by hour as historical contribution expires.</li>
            <li><b>Automatic reallocation:</b> active contributors still offering compute gain relative share as inactive capacity rolls off.</li>
          </ol>
        </section>

        <section class="section">
          <h2>Enterprise controls and trust</h2>
          <div class="grid">
            <article class="card">
              <h3>Private policy boundaries</h3>
              <p>Define what stays private, what can cross into public capacity, and which nodes are eligible.</p>
            </article>
            <article class="card">
              <h3>Contributor incentive alignment</h3>
              <p>Idle compute providers are rewarded from real workload demand, denominated via bitcoin-linked settlement flows.</p>
            </article>
            <article class="card">
              <h3>Auditable issuance logic</h3>
              <p>Rolling 24-hour allocation makes rewards responsive to current supply, reliability, and demand conditions.</p>
            </article>
            <article class="card">
              <h3>Operational-grade access control</h3>
              <p>Passkeys, approvals, and service-level governance support professional teams and managed network operations.</p>
            </article>
          </div>
        </section>

        <section class="section">
          <h2>Agent types in the global compute mesh</h2>
          <p>
            EdgeCoder can coordinate many classes of agents as one decentralized execution fabric. The goal is to turn available
            compute worldwide into a single AI CPU/GPU cluster that can serve real workload demand securely.
            Agents can also run local models and make that model capacity available to other nodes in the mesh for truly decentralized inference.
          </p>
          <div class="grid">
            <article class="card">
              <h3>Mobile and edge devices</h3>
              <p>iOS phones and Android devices can contribute idle cycles for lightweight and burstable inference workloads.</p>
            </article>
            <article class="card">
              <h3>Vehicle compute systems</h3>
              <p>Vehicle onboard compute can participate when policy, connectivity, and power constraints allow safe execution.</p>
            </article>
            <article class="card">
              <h3>Servers and GPU clusters</h3>
              <p>Dedicated servers and high-throughput GPU fleets provide the backbone capacity for heavier tasks and queue stability.</p>
            </article>
            <article class="card">
              <h3>Datacenter-scale facilities</h3>
              <p>Entire datacenter facilities can be enrolled as coordinated capacity domains with governance, approval, and audit controls.</p>
            </article>
            <article class="card">
              <h3>Locally hosted model agents</h3>
              <p>Any approved node can run local models and expose that model throughput to other network participants, reducing central dependency.</p>
            </article>
          </div>
        </section>

        <footer class="footer">
          <div>
            <div><strong>EdgeCoder</strong> <span class="ok">online</span></div>
            <div class="footer-note">Private/public compute crossover with rolling 24-hour issuance and bitcoin-linked contributor rewards.</div>
          </div>
          <a class="btn primary" href="/portal">Launch Portal</a>
        </footer>
      </main>
    </body>
  </html>`;
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

  await createSessionForUser(user.userId, reply);
  return reply.send({ ok: true, user: { userId: user.userId, email: user.email, emailVerified: user.emailVerified } });
});

app.post("/auth/logout", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const cookies = parseCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
  const sessionToken = cookies.edgecoder_portal_session;
  if (sessionToken) {
    await store.deleteSessionByTokenHash(sha256Hex(sessionToken));
  }
  reply.header("set-cookie", clearCookie("edgecoder_portal_session"));
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
  const params = z.object({ provider: z.enum(["google", "microsoft"]) }).parse(req.params);
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
  const params = z.object({ provider: z.enum(["google", "microsoft"]) }).parse(req.params);
  const query = z.object({ code: z.string(), state: z.string() }).parse(req.query);
  return handleOauthCallback(params.provider, query.code, query.state, reply);
});

app.post("/auth/oauth/:provider/callback", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const params = z.object({ provider: z.enum(["google", "microsoft"]) }).parse(req.params);
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

  const tokenRes = await request(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
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

  if (provider.userinfoUrl && tokenPayload.access_token) {
    const userRes = await request(provider.userinfoUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${tokenPayload.access_token}` }
    });
    if (userRes.statusCode >= 200 && userRes.statusCode < 300) {
      const userInfo = (await userRes.body.json()) as { sub?: string; email?: string; email_verified?: boolean | string | number };
      subject = subject ?? userInfo.sub;
      email = email ?? userInfo.email;
      emailVerified = emailVerified || claimIsTrue(userInfo.email_verified);
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

app.post("/auth/oauth/mobile/complete", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const body = z.object({ token: z.string().min(24) }).parse(req.body);
  const resolved = consumeMobileOauthSessionToken(body.token);
  if (!resolved) return reply.code(400).send({ error: "oauth_mobile_token_invalid" });
  await createSessionForUser(resolved.userId, reply);
  const user = await store.getUserById(resolved.userId);
  return reply.send({
    ok: true,
    user: user ? { userId: user.userId, email: user.email, emailVerified: user.emailVerified } : null
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
    seedPhrase: setup.seedPhrase,
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
  return reply.send({
    ok: true,
    nodeId: record.nodeId,
    deviceId: record.deviceId,
    nodeKind: record.nodeKind,
    emailVerified: record.emailVerified,
    nodeApproved: record.nodeApproved,
    active: record.active,
    registrationToken
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
  const ok = await store.deleteNodeEnrollment(params.nodeId);
  if (!ok) return reply.code(404).send({ error: "node_not_found" });
  return reply.send({ ok: true, deletedNodeId: params.nodeId });
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
      model: z.string().default("qwen2.5-coder:latest"),
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
      model: z.string().default("qwen2.5-coder:latest"),
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

app.post("/portal/api/chat", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });

  const body = z.object({ conversationId: z.string().min(1), message: z.string().min(1) }).parse(req.body);

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

  // Discover a coordinator
  const coordinatorUrls = await discoverCoordinatorUrlsForPortal();
  if (coordinatorUrls.length === 0) {
    return reply.code(502).send({ error: "no_coordinators_available" });
  }
  const coordinatorUrl = coordinatorUrls[0].replace(/\/$/, "");

  // Submit task to coordinator
  const taskId = randomUUID();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (PORTAL_SERVICE_TOKEN) headers["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;

  let coordinatorRes;
  try {
    coordinatorRes = await request(`${coordinatorUrl}/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        taskId,
        submitterAccountId: user.userId,
        payload: { messages, stream: true },
        priority: "normal",
        resourceClass: "gpu"
      }),
      headersTimeout: EXTERNAL_HTTP_TIMEOUT_MS,
      bodyTimeout: 0 // no body timeout for streaming
    });
  } catch (err) {
    return reply.code(502).send({ error: "coordinator_request_failed", detail: String(err) });
  }

  if (coordinatorRes.statusCode < 200 || coordinatorRes.statusCode >= 300) {
    const errBody = await coordinatorRes.body.text();
    return reply.code(502).send({ error: "coordinator_error", detail: errBody });
  }

  // Stream SSE response
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  let fullContent = "";
  try {
    for await (const chunk of coordinatorRes.body) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const lines = text.split("\n").filter((l: string) => l.trim().length > 0);
      for (const line of lines) {
        const trimmed = line.replace(/^data:\s*/, "").trim();
        if (!trimmed || trimmed === "[DONE]") continue;
        try {
          const parsed = JSON.parse(trimmed) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            reply.raw.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
          }
        } catch {
          // Not valid JSON — skip
        }
      }
    }
  } catch (streamErr) {
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

app.get("/", async (_req, reply) => reply.type("text/html").send(marketingHomeHtml()));

app.get("/portal-legacy", async (_req, reply) => {
  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>EdgeCoder Portal</title>
      <style>
        :root {
          --bg: #070b18;
          --bg-soft: #0f172a;
          --card: rgba(15, 23, 42, 0.72);
          --card-border: rgba(148, 163, 184, 0.25);
          --text: #e2e8f0;
          --muted: #94a3b8;
          --brand: #7c3aed;
          --brand-2: #22d3ee;
          --ok: #22c55e;
          --warn: #f59e0b;
          --danger: #ef4444;
        }
        * { box-sizing: border-box; }
        body {
          font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          margin: 0;
          color: var(--text);
          background:
            radial-gradient(1200px 500px at -20% -20%, rgba(124, 58, 237, 0.35), transparent 60%),
            radial-gradient(800px 400px at 110% 10%, rgba(34, 211, 238, 0.24), transparent 60%),
            var(--bg);
          min-height: 100vh;
        }
        .shell { max-width: 1180px; margin: 24px auto 48px; padding: 0 16px; }
        h1, h2, h3 { margin: 8px 0; letter-spacing: -0.01em; }
        .hidden { display: none; }
        .hero {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 14px;
          margin-bottom: 16px;
        }
        .brand-mark {
          width: 40px;
          height: 40px;
          border-radius: 12px;
          background: linear-gradient(140deg, var(--brand), var(--brand-2));
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 18px;
          box-shadow: 0 0 0 1px rgba(255,255,255,0.1) inset, 0 12px 24px rgba(14, 116, 144, 0.25);
        }
        .hero-left { display: flex; gap: 12px; align-items: center; }
        .hero h1 { font-size: 26px; margin: 0; }
        .muted { color: var(--muted); font-size: 13px; }
        .pill-row { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
        .pill {
          border: 1px solid var(--card-border);
          border-radius: 999px;
          padding: 5px 10px;
          font-size: 12px;
          color: #cbd5e1;
          background: rgba(15, 23, 42, 0.45);
          backdrop-filter: blur(8px);
        }
        .grid { display: grid; grid-template-columns: repeat(2, minmax(320px, 1fr)); gap: 14px; }
        .card {
          background: var(--card);
          border: 1px solid var(--card-border);
          border-radius: 14px;
          padding: 16px;
          margin-bottom: 12px;
          backdrop-filter: blur(10px);
          box-shadow: 0 10px 30px rgba(2, 6, 23, 0.45);
        }
        .card h2, .card h3 { margin-top: 0; }
        .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .kpis { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 10px; margin-top: 12px; }
        .kpi {
          border: 1px solid var(--card-border);
          border-radius: 10px;
          padding: 10px;
          background: rgba(2, 6, 23, 0.35);
        }
        .kpi .label { color: var(--muted); font-size: 12px; }
        .kpi .value { font-size: 18px; font-weight: 700; margin-top: 2px; }
        label { display: block; margin: 8px 0 4px; font-size: 13px; color: #cbd5e1; }
        input, select {
          width: 100%;
          padding: 10px 11px;
          border: 1px solid rgba(148, 163, 184, 0.35);
          border-radius: 10px;
          background: rgba(2, 6, 23, 0.7);
          color: var(--text);
        }
        input::placeholder { color: #64748b; }
        button {
          padding: 9px 12px;
          border-radius: 10px;
          border: 1px solid rgba(148, 163, 184, 0.4);
          background: rgba(15, 23, 42, 0.7);
          color: var(--text);
          cursor: pointer;
          transition: transform .08s ease, border-color .12s ease, background .12s ease;
        }
        button:hover { border-color: #cbd5e1; transform: translateY(-1px); }
        button.primary {
          background: linear-gradient(140deg, var(--brand), #6d28d9);
          border-color: rgba(167, 139, 250, 0.9);
          color: white;
        }
        button.primary:hover { background: linear-gradient(140deg, #8b5cf6, #7c3aed); }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td {
          border-bottom: 1px solid rgba(148, 163, 184, 0.2);
          text-align: left;
          padding: 8px 6px;
          vertical-align: top;
        }
        th { color: #cbd5e1; font-weight: 600; }
        code {
          background: rgba(59, 130, 246, 0.18);
          border: 1px solid rgba(147, 197, 253, 0.35);
          padding: 2px 5px;
          border-radius: 6px;
        }
        .token-box {
          border: 1px dashed rgba(125, 211, 252, 0.55);
          border-radius: 10px;
          padding: 10px;
          background: rgba(6, 78, 59, 0.28);
          word-break: break-all;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          line-height: 1.45;
        }
        #toast {
          position: fixed;
          top: 20px;
          right: 20px;
          width: min(420px, calc(100vw - 32px));
          z-index: 100;
          margin: 0;
        }
        @media (max-width: 920px) {
          .grid { grid-template-columns: 1fr; }
          .hero { flex-direction: column; align-items: flex-start; }
          .pill-row { justify-content: flex-start; }
          .kpis { grid-template-columns: 1fr; }
        }
      </style>
    </head>
    <body>
      <div class="shell">
        <div class="hero">
          <div class="hero-left">
            <div class="brand-mark">E</div>
            <div>
              <h1>EdgeCoder Portal</h1>
              <div class="muted">Manage identity, node activation, credits, and wallets in one place.</div>
            </div>
          </div>
          <div class="pill-row">
            <span class="pill">Privacy-first</span>
            <span class="pill">SSO + Passkeys</span>
            <span class="pill">BTC/LN credits</span>
          </div>
        </div>

        <div id="authView" class="grid">
          <div class="card">
            <h2>Get started</h2>
            <p class="muted">Create your account to enroll agents and coordinators. Accounts remain dormant until email is verified.</p>
            <label>Email</label><input id="signupEmail" type="email" placeholder="you@company.com" />
            <label>Password</label><input id="signupPassword" type="password" placeholder="At least 8 characters" />
            <label>Display name (optional)</label><input id="signupDisplayName" type="text" placeholder="Team or your name" />
            <div class="row" style="margin-top:10px;">
              <button class="primary" id="signupBtn">Create account</button>
            </div>
          </div>
          <div class="card">
            <h2>Sign in</h2>
            <label>Email</label><input id="loginEmail" type="email" placeholder="you@company.com" />
            <label>Password</label><input id="loginPassword" type="password" placeholder="Your password" />
            <div class="row" style="margin-top:10px;">
              <button class="primary" id="loginBtn">Log in</button>
              <button id="resendBtn">Resend verification</button>
            </div>
            <div class="row" style="margin-top:10px;">
              <button id="passkeyLoginBtn">Log in with passkey</button>
              <button id="passkeyEnrollBtn">Enroll passkey</button>
            </div>
            <h3 style="margin-top:16px;">Single sign-on</h3>
            <div class="row">
              <a href="/auth/oauth/google/start"><button>Google</button></a>
              <a href="/auth/oauth/microsoft/start"><button>Microsoft 365</button></a>
            </div>
          </div>
        </div>

        <div id="dashboardView" class="hidden">
          <div class="card">
            <div class="row" style="justify-content:space-between;">
              <div>
                <h2>Account Overview</h2>
                <div id="accountMeta" class="muted"></div>
              </div>
              <div class="row">
                <select id="themeSelect" style="min-width: 140px;">
                  <option value="warm">Warm</option>
                  <option value="midnight">Midnight</option>
                  <option value="emerald">Emerald</option>
                </select>
                <button id="refreshBtn">Refresh</button>
                <button id="logoutBtn">Log out</button>
              </div>
            </div>
            <div class="kpis">
              <div class="kpi"><div class="label">Current credits</div><div class="value" id="creditsValue">-</div></div>
              <div class="kpi"><div class="label">Estimated sats</div><div class="value" id="creditsSatsValue">n/a</div></div>
              <div class="kpi"><div class="label">Account ID</div><div class="value" style="font-size:13px;font-family:ui-monospace,monospace;" id="accountIdLabel"></div></div>
            </div>
          </div>

          <div class="card">
            <h3>Wallet Security Checklist</h3>
            <p class="muted">Your seed phrase is shown only once at signup. Confirm you have safely backed it up offline.</p>
            <div id="walletOnboardingMeta" class="muted">Loading wallet onboarding status...</div>
            <div class="row" style="margin-top:8px;">
              <button id="walletAckBtn">I backed up my seed phrase</button>
            </div>
          </div>

          <div class="grid">
            <div class="card">
              <h3>Enroll node</h3>
              <label>Node ID</label><input id="nodeId" type="text" placeholder="mac-worker-001" />
              <label>Node type</label>
              <select id="nodeKind">
                <option value="agent">Agent</option>
                <option value="coordinator">Coordinator</option>
              </select>
              <div class="row" style="margin-top:10px;">
                <button class="primary" id="enrollBtn">Generate node token</button>
              </div>
              <p class="muted">Install this token as <code>AGENT_REGISTRATION_TOKEN</code> or coordinator registration token.</p>
              <div id="newTokenWrap" class="hidden">
                <p class="muted">Registration token (save now; it will not be shown again):</p>
                <div id="newToken" class="token-box"></div>
              </div>
            </div>

            <div class="card">
              <h3>Node activation</h3>
              <p class="muted">A node is active only when email is verified and coordinator admin approval is complete.</p>
              <table>
                <thead><tr><th>Node</th><th>Type</th><th>Email verified</th><th>Approved</th><th>Active</th><th>Last seen</th></tr></thead>
                <tbody id="nodesBody"></tbody>
              </table>
            </div>
          </div>

          <div class="grid">
            <div class="card">
              <h3>Credit ledger</h3>
              <table>
                <thead><tr><th>Time</th><th>Type</th><th>Credits</th><th>Reason</th></tr></thead>
                <tbody id="creditHistoryBody"></tbody>
              </table>
            </div>

            <div class="card">
              <h3>Wallets and BTC/LN intents</h3>
              <table>
                <thead><tr><th>Wallet type</th><th>Network</th><th>Payout</th><th>Node/Xpub</th></tr></thead>
                <tbody id="walletsBody"></tbody>
              </table>
              <h3 style="margin-top:14px;">Payment intents</h3>
              <table>
                <thead><tr><th>Intent</th><th>Status</th><th>Sats</th><th>Credits</th><th>Created</th></tr></thead>
                <tbody id="paymentIntentsBody"></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <div id="toast" class="card hidden"></div>

      <script>
        const authView = document.getElementById("authView");
        const dashboardView = document.getElementById("dashboardView");
        const toast = document.getElementById("toast");
        const themeSelect = document.getElementById("themeSelect");
        const themePalettes = {
          warm: {
            "--bg": "#2f2f2d",
            "--bg-soft": "#353533",
            "--card": "rgba(58, 58, 55, 0.96)",
            "--card-border": "rgba(214, 204, 194, 0.12)",
            "--text": "#f7f5f0",
            "--muted": "#8a8478",
            "--brand": "#c17850",
            "--brand-2": "#d4895f"
          },
          midnight: {
            "--bg": "#1a1a2e",
            "--bg-soft": "#202038",
            "--card": "rgba(37, 37, 64, 0.96)",
            "--card-border": "rgba(99, 102, 241, 0.18)",
            "--text": "#e8e8f0",
            "--muted": "#8888a0",
            "--brand": "#6366f1",
            "--brand-2": "#818cf8"
          },
          emerald: {
            "--bg": "#1a2e1a",
            "--bg-soft": "#203520",
            "--card": "rgba(37, 48, 37, 0.96)",
            "--card-border": "rgba(34, 197, 94, 0.18)",
            "--text": "#e8f0e8",
            "--muted": "#88a088",
            "--brand": "#22c55e",
            "--brand-2": "#4ade80"
          }
        };

        function applyTheme(theme) {
          const palette = themePalettes[theme] || themePalettes.warm;
          for (const [key, value] of Object.entries(palette)) {
            document.documentElement.style.setProperty(key, value);
          }
          if (themeSelect) themeSelect.value = theme;
        }

        function showToast(message, isError = false) {
          toast.textContent = message;
          toast.classList.remove("hidden");
          toast.style.borderColor = isError ? "#ef4444" : "#22c55e";
          setTimeout(() => toast.classList.add("hidden"), 5000);
        }

        function fmtTime(ms) {
          if (!ms) return "n/a";
          return new Date(ms).toISOString();
        }

        function b64urlToArrayBuffer(base64url) {
          const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
          const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
          const binary = atob(padded);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          return bytes.buffer;
        }

        function arrayBufferToB64url(buffer) {
          const bytes = new Uint8Array(buffer);
          let binary = "";
          for (const b of bytes) binary += String.fromCharCode(b);
          return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
        }

        async function api(path, options = {}) {
          const res = await fetch(path, {
            credentials: "include",
            headers: { "content-type": "application/json", ...(options.headers || {}) },
            ...options
          });
          let payload = null;
          try { payload = await res.json(); } catch {}
          if (!res.ok) throw new Error(payload && payload.error ? payload.error : String(res.status));
          return payload;
        }

        function renderRows(targetId, rowsHtml, colspan, emptyText) {
          const el = document.getElementById(targetId);
          el.innerHTML = rowsHtml.length > 0 ? rowsHtml.join("") : '<tr><td colspan="' + colspan + '">' + emptyText + '</td></tr>';
        }

        async function loadDashboard() {
          const summary = await api("/dashboard/summary", { method: "GET", headers: {} });
          authView.classList.add("hidden");
          dashboardView.classList.remove("hidden");

          const user = summary.user || {};
          applyTheme(user.uiTheme || "warm");
          document.getElementById("accountMeta").textContent =
            user.email + " | email verified: " + String(Boolean(user.emailVerified));
          document.getElementById("accountIdLabel").textContent = "acct-" + (user.userId || "unknown");

          const nodeRows = (summary.nodes || []).map((n) =>
            "<tr><td>" + n.nodeId + "</td><td>" + n.nodeKind + "</td><td>" + String(Boolean(n.emailVerified)) + "</td><td>" +
            String(Boolean(n.nodeApproved)) + "</td><td>" + String(Boolean(n.active)) + "</td><td>" + fmtTime(n.lastSeenMs) + "</td></tr>"
          );
          renderRows("nodesBody", nodeRows, 6, "No nodes enrolled.");

          const walletSnapshot = summary.walletSnapshot || {};
          const credits = walletSnapshot.credits;
          document.getElementById("creditsValue").textContent =
            credits && typeof credits.balance !== "undefined" ? String(credits.balance) : "n/a";
          const quote = walletSnapshot.quote;
          document.getElementById("creditsSatsValue").textContent =
            quote && typeof quote.estimatedSats !== "undefined"
              ? "Estimated sats: " + String(quote.estimatedSats) + " @ " + String(quote.satsPerCredit) + " sats/credit"
              : "Estimated sats: n/a";

          const creditHistoryRows = (walletSnapshot.creditHistory || []).map((tx) =>
            "<tr><td>" + fmtTime(tx.timestampMs) + "</td><td>" + tx.type + "</td><td>" + tx.credits + "</td><td>" + tx.reason + "</td></tr>"
          );
          renderRows("creditHistoryBody", creditHistoryRows, 4, "No credit transactions yet.");

          const walletRows = (walletSnapshot.wallets || []).map((w) =>
            "<tr><td>" + (w.walletType || "") + "</td><td>" + (w.network || "") + "</td><td>" + (w.payoutAddress || "n/a") +
            "</td><td>" + (w.lnNodePubkey || w.xpub || "n/a") + "</td></tr>"
          );
          renderRows("walletsBody", walletRows, 4, "No wallets linked.");

          const intentRows = (walletSnapshot.paymentIntents || []).map((p) =>
            "<tr><td>" + p.intentId + "</td><td>" + p.status + "</td><td>" + p.amountSats + "</td><td>" + p.quotedCredits +
            "</td><td>" + fmtTime(p.createdAtMs) + "</td></tr>"
          );
          renderRows("paymentIntentsBody", intentRows, 5, "No payment intents.");

          try {
            const onboarding = await api("/wallet/onboarding", { method: "GET", headers: {} });
            const status = onboarding.acknowledgedAtMs
              ? "Seed backup confirmed on " + fmtTime(onboarding.acknowledgedAtMs)
              : "Backup not yet confirmed. Please secure your seed phrase offline.";
            document.getElementById("walletOnboardingMeta").textContent =
              "Network: " + onboarding.network + " | Account: " + onboarding.accountId + " | " + status;
          } catch {
            document.getElementById("walletOnboardingMeta").textContent = "Wallet onboarding status unavailable.";
          }
        }

        async function bootstrap() {
          try {
            await api("/me", { method: "GET", headers: {} });
            await loadDashboard();
          } catch {
            authView.classList.remove("hidden");
            dashboardView.classList.add("hidden");
          }
        }

        document.getElementById("signupBtn").addEventListener("click", async () => {
          try {
            const signup = await api("/auth/signup", {
              method: "POST",
              body: JSON.stringify({
                email: document.getElementById("signupEmail").value,
                password: document.getElementById("signupPassword").value,
                displayName: document.getElementById("signupDisplayName").value || undefined
              })
            });
            const onboarding = signup.walletOnboarding;
            if (onboarding && onboarding.seedPhrase) {
              showToast(
                "Signup complete. Save this seed phrase now: " + onboarding.seedPhrase + " | " +
                (onboarding.guidance && onboarding.guidance.steps ? onboarding.guidance.steps.join(" ") : ""),
                false
              );
            } else {
              showToast("Signup complete. Check your email for verification.");
            }
          } catch (err) {
            showToast("Signup failed: " + String(err.message || err), true);
          }
        });

        document.getElementById("loginBtn").addEventListener("click", async () => {
          try {
            await api("/auth/login", {
              method: "POST",
              body: JSON.stringify({
                email: document.getElementById("loginEmail").value,
                password: document.getElementById("loginPassword").value
              })
            });
            showToast("Logged in.");
            await loadDashboard();
          } catch (err) {
            showToast("Login failed: " + String(err.message || err), true);
          }
        });

        document.getElementById("resendBtn").addEventListener("click", async () => {
          try {
            const payload = await api("/auth/resend-verification", {
              method: "POST",
              body: JSON.stringify({ email: document.getElementById("loginEmail").value })
            });
            if (payload && payload.alreadyVerified) {
              showToast("This account is already verified. No email was sent.");
            } else {
              showToast("If the account exists, a verification email was sent.");
            }
          } catch (err) {
            showToast("Resend failed: " + String(err.message || err), true);
          }
        });

        document.getElementById("walletAckBtn").addEventListener("click", async () => {
          try {
            await api("/wallet/onboarding/acknowledge", { method: "POST", body: JSON.stringify({}) });
            await loadDashboard();
            showToast("Seed backup acknowledgement saved.");
          } catch (err) {
            showToast("Could not save acknowledgement: " + String(err.message || err), true);
          }
        });

        document.getElementById("passkeyEnrollBtn").addEventListener("click", async () => {
          if (!window.PublicKeyCredential) {
            showToast("Passkeys are not supported in this browser.", true);
            return;
          }
          try {
            const { challengeId, options } = await api("/auth/passkey/register/options", { method: "POST", body: JSON.stringify({}) });
            options.challenge = b64urlToArrayBuffer(options.challenge);
            options.user.id = b64urlToArrayBuffer(options.user.id);
            options.excludeCredentials = (options.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToArrayBuffer(c.id) }));
            const credential = await navigator.credentials.create({ publicKey: options });
            const response = credential.response;
            await api("/auth/passkey/register/verify", {
              method: "POST",
              body: JSON.stringify({
                challengeId,
                response: {
                  id: credential.id,
                  rawId: arrayBufferToB64url(credential.rawId),
                  type: credential.type,
                  response: {
                    clientDataJSON: arrayBufferToB64url(response.clientDataJSON),
                    attestationObject: arrayBufferToB64url(response.attestationObject),
                    transports: response.getTransports ? response.getTransports() : []
                  }
                }
              })
            });
            showToast("Passkey enrolled successfully.");
          } catch (err) {
            showToast("Passkey enrollment failed: " + String(err.message || err), true);
          }
        });

        document.getElementById("passkeyLoginBtn").addEventListener("click", async () => {
          if (!window.PublicKeyCredential) {
            showToast("Passkeys are not supported in this browser.", true);
            return;
          }
          try {
            const email = document.getElementById("loginEmail").value;
            const { challengeId, options } = await api("/auth/passkey/login/options", {
              method: "POST",
              body: JSON.stringify({ email })
            });
            options.challenge = b64urlToArrayBuffer(options.challenge);
            options.allowCredentials = (options.allowCredentials || []).map((c) => ({ ...c, id: b64urlToArrayBuffer(c.id) }));
            const assertion = await navigator.credentials.get({ publicKey: options });
            const response = assertion.response;
            await api("/auth/passkey/login/verify", {
              method: "POST",
              body: JSON.stringify({
                challengeId,
                credentialId: assertion.id,
                response: {
                  id: assertion.id,
                  rawId: arrayBufferToB64url(assertion.rawId),
                  type: assertion.type,
                  response: {
                    clientDataJSON: arrayBufferToB64url(response.clientDataJSON),
                    authenticatorData: arrayBufferToB64url(response.authenticatorData),
                    signature: arrayBufferToB64url(response.signature),
                    userHandle: response.userHandle ? arrayBufferToB64url(response.userHandle) : null
                  }
                }
              })
            });
            await loadDashboard();
            showToast("Logged in with passkey.");
          } catch (err) {
            showToast("Passkey login failed: " + String(err.message || err), true);
          }
        });

        document.getElementById("logoutBtn").addEventListener("click", async () => {
          await api("/auth/logout", { method: "POST", body: JSON.stringify({}) });
          showToast("Logged out.");
          authView.classList.remove("hidden");
          dashboardView.classList.add("hidden");
        });

        document.getElementById("refreshBtn").addEventListener("click", () => {
          loadDashboard().catch((err) => showToast("Refresh failed: " + String(err.message || err), true));
        });

        themeSelect.addEventListener("change", async () => {
          const theme = themeSelect.value;
          applyTheme(theme);
          try {
            await api("/me/theme", {
              method: "POST",
              body: JSON.stringify({ theme })
            });
            showToast("Theme updated.");
          } catch (err) {
            showToast("Could not save theme: " + String(err.message || err), true);
          }
        });

        document.getElementById("enrollBtn").addEventListener("click", async () => {
          try {
            const payload = await api("/nodes/enroll", {
              method: "POST",
              body: JSON.stringify({
                nodeId: document.getElementById("nodeId").value,
                nodeKind: document.getElementById("nodeKind").value
              })
            });
            document.getElementById("newTokenWrap").classList.remove("hidden");
            document.getElementById("newToken").textContent = payload.registrationToken;
            await loadDashboard();
            showToast("Node enrollment token generated.");
          } catch (err) {
            showToast("Enroll failed: " + String(err.message || err), true);
          }
        });

        applyTheme("warm");
        bootstrap();
      </script>
    </body>
  </html>`;
  return reply.type("text/html").send(html);
});

function portalAuthedPageHtml(input: {
  title: string;
  activeTab: "chat" | "dashboard" | "wallet" | "settings" | "download";
  heading: string;
  subtitle: string;
  content: string;
  script: string;
}): string {
  const navLink = (
    tab: "chat" | "dashboard" | "wallet" | "settings" | "download",
    label: string,
    href: string
  ) => {
    const activeClass = input.activeTab === tab ? "tab active" : "tab";
    return `<a class="${activeClass}" href="${href}">${label}</a>`;
  };

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>${input.title}</title>
      <style>
        :root {
          --bg: #2f2f2d;
          --bg-soft: #353533;
          --card: rgba(58, 58, 55, 0.96);
          --card-border: rgba(214, 204, 194, 0.12);
          --text: #f7f5f0;
          --muted: #8a8478;
          --brand: #c17850;
          --brand-2: #d4895f;
          --ok: #4ade80;
          --danger: #f87171;
        }
        * { box-sizing: border-box; }
        body {
          font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          margin: 0;
          color: var(--text);
          background: var(--bg);
          min-height: 100vh;
        }
        .shell { max-width: 1360px; margin: 18px auto 26px; padding: 0 14px; }
        .workspace {
          display: grid;
          grid-template-columns: 232px 1fr;
          gap: 10px;
        }
        .sidebar {
          background: var(--bg-soft);
          border: 0.5px solid var(--card-border);
          border-radius: 8px;
          padding: 12px 8px;
          min-height: calc(100vh - 32px);
          position: sticky;
          top: 10px;
        }
        .main { min-width: 0; }
        .sidebar-brand { display: flex; align-items: center; gap: 8px; padding: 0 6px 8px; }
        .sidebar-title { font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
        .sidebar-subtitle { color: var(--muted); font-size: 11px; margin-top: 1px; }
        .sidebar-section-label {
          color: var(--muted);
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          margin: 10px 6px 6px;
        }
        .sidebar-foot {
          margin: 10px 6px 0;
          padding-top: 8px;
          border-top: 0.5px solid var(--card-border);
          font-size: 11px;
        }
        .topbar {
          display: flex;
          justify-content: space-between;
          gap: 8px;
          align-items: center;
          margin-bottom: 8px;
          padding: 10px 12px;
          border: 0.5px solid var(--card-border);
          border-radius: 8px;
          background: var(--card);
        }
        .ticker-row {
          display: grid;
          grid-template-columns: repeat(4, minmax(120px, 1fr));
          gap: 8px;
          margin-bottom: 8px;
        }
        .ticker {
          border: 1px solid var(--card-border);
          border-radius: 6px;
          padding: 7px;
          background: var(--card);
        }
        .ticker .label {
          color: var(--muted);
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .ticker .value {
          margin-top: 3px;
          font-size: 14px;
          font-weight: 700;
          font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .brand { display: inline-flex; align-items: center; gap: 10px; }
        .mark {
          width: 28px;
          height: 28px;
          border-radius: 7px;
          background: linear-gradient(140deg, var(--brand), var(--brand-2));
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 0 0 1px rgba(255,255,255,0.12) inset, 0 8px 18px rgba(16, 97, 143, 0.22);
          font-size: 12px;
        }
        .title { font-size: 17px; margin: 0; font-weight: 700; letter-spacing: 0.01em; }
        .muted { color: var(--muted); font-size: 11px; }
        .nav-row { display: flex; flex-direction: column; gap: 4px; }
        .tab {
          border: 1px solid var(--card-border);
          border-radius: 6px;
          padding: 7px 8px;
          font-size: 11px;
          color: var(--text);
          background: var(--bg-soft);
          text-decoration: none;
        }
        .tab.active {
          border-color: rgba(193, 120, 80, 0.45);
          background: rgba(193, 120, 80, 0.1);
          color: var(--brand-2);
          box-shadow: inset 2px 0 0 rgba(193, 120, 80, 0.7);
        }
        .card {
          background: var(--card);
          border: 1px solid var(--card-border);
          border-radius: 8px;
          padding: 11px;
          margin-bottom: 8px;
          backdrop-filter: blur(10px);
          box-shadow: 0 4px 14px rgba(15, 23, 42, 0.08);
        }
        .content-stack { margin-top: 0; }
        .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
        button {
          padding: 6px 9px;
          border-radius: 6px;
          border: 1px solid var(--card-border);
          background: var(--bg-soft);
          color: var(--text);
          cursor: pointer;
          font-size: 12px;
        }
        button.primary {
          background: linear-gradient(140deg, var(--brand), var(--brand-2));
          border-color: rgba(193, 120, 80, 0.75);
          color: white;
        }
        input, select {
          width: 100%;
          padding: 7px 8px;
          border: 1px solid var(--card-border);
          border-radius: 6px;
          background: var(--bg);
          color: var(--text);
          font-size: 12px;
        }
        label {
          display: block;
          margin: 6px 0 3px;
          font-size: 10px;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td {
          border-bottom: 1px solid var(--card-border);
          text-align: left;
          padding: 6px 5px;
          vertical-align: top;
          font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        th {
          color: var(--muted);
          font-weight: 600;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .grid2 { display: grid; grid-template-columns: repeat(2, minmax(260px, 1fr)); gap: 8px; }
        .kpis { display: grid; grid-template-columns: repeat(3, minmax(110px, 1fr)); gap: 8px; margin-top: 8px; }
        .kpi { border: 1px solid var(--card-border); border-radius: 6px; padding: 7px; background: var(--card); }
        .kpi .label {
          color: var(--muted);
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .kpi .value {
          font-size: 15px;
          font-weight: 700;
          margin-top: 2px;
          font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .status-badge {
          display: inline-flex;
          align-items: center;
          padding: 2px 7px;
          border-radius: 999px;
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          border: 1px solid var(--card-border);
          background: var(--bg-soft);
          color: var(--text);
        }
        .status-badge.ok {
          border-color: rgba(34, 197, 94, 0.6);
          color: #86efac;
          background: rgba(20, 83, 45, 0.35);
        }
        .status-badge.warn {
          border-color: rgba(245, 158, 11, 0.62);
          color: #fcd34d;
          background: rgba(120, 53, 15, 0.32);
        }
        .status-badge.danger {
          border-color: rgba(239, 68, 68, 0.62);
          color: #fca5a5;
          background: rgba(127, 29, 29, 0.32);
        }
        .table-controls {
          display: flex;
          gap: 6px;
          align-items: center;
          flex-wrap: wrap;
          margin: 0 0 8px;
        }
        .table-controls input, .table-controls select {
          width: auto;
          min-width: 150px;
        }
        .token-box {
          border: 1px dashed rgba(193, 120, 80, 0.42);
          border-radius: 6px;
          padding: 8px;
          background: var(--bg-soft);
          word-break: break-all;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12px;
        }
        #toast {
          position: fixed;
          top: 12px;
          right: 12px;
          width: min(420px, calc(100vw - 32px));
          z-index: 100;
          margin: 0;
        }
        .hidden { display: none; }
        @media (max-width: 920px) {
          .workspace { grid-template-columns: 1fr; }
          .sidebar {
            min-height: auto;
            position: static;
          }
          .nav-row { flex-direction: row; flex-wrap: wrap; }
          .tab {
            border-radius: 999px;
            padding: 6px 10px;
            text-transform: none;
            letter-spacing: 0;
          }
          .grid2 { grid-template-columns: 1fr; }
          .kpis { grid-template-columns: 1fr; }
          .ticker-row { grid-template-columns: repeat(2, minmax(120px, 1fr)); }
        }
      </style>
    </head>
    <body>
      <div class="shell">
        <div class="workspace">
          <aside class="sidebar">
            <div class="sidebar-brand">
              <div class="mark">E</div>
              <div>
                <div class="sidebar-title">EdgeCoder Portal</div>
                <div class="sidebar-subtitle">AI Network</div>
              </div>
            </div>
            <div class="sidebar-section-label">Navigation</div>
            <div class="nav-row">
              ${navLink("chat", "Chat", "/portal/chat")}
              ${navLink("dashboard", "Dashboard", "/portal/dashboard")}
              ${navLink("wallet", "Wallet", "/portal/wallet")}
              ${navLink("download", "Get EdgeCoder", "/portal/download")}
              ${navLink("settings", "Settings", "/portal/settings")}
              <a class="tab" href="${DOCS_SITE_URL}" target="_blank" rel="noreferrer">Docs</a>
              <a class="tab" href="${GITHUB_REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>
            </div>
            <div class="sidebar-foot muted">Auditable actions and secure operations</div>
          </aside>
          <main class="main">
            <div class="topbar">
              <div class="brand">
                <div>
                  <h1 class="title">${input.heading}</h1>
                  <div class="muted">${input.subtitle}</div>
                </div>
              </div>
              <div class="row">
                <a class="btn" href="${DOCS_SITE_URL}" target="_blank" rel="noreferrer">Docs</a>
                <a class="btn" href="${GITHUB_REPO_URL}" target="_blank" rel="noreferrer">GitHub</a>
                <button id="switchUserBtn">Switch user</button>
                <button id="logoutBtn">Sign out</button>
              </div>
            </div>
            <div class="ticker-row">
              <div class="ticker"><div class="label">Credits</div><div class="value" id="topTickerCredits">-</div></div>
              <div class="ticker"><div class="label">Nodes</div><div class="value" id="topTickerNodes">-</div></div>
              <div class="ticker"><div class="label">Pending Sends</div><div class="value" id="topTickerSends">-</div></div>
              <div class="ticker"><div class="label">Wallet</div><div class="value" id="topTickerWallet">-</div></div>
            </div>
            <div class="content-stack">
              ${input.content}
            </div>
          </main>
        </div>
      </div>
      <div id="toast" class="card hidden"></div>
      <script>
        const toast = document.getElementById("toast");
        const themePalettes = {
          warm: { "--bg": "#2f2f2d", "--bg-soft": "#353533", "--card": "rgba(58, 58, 55, 0.96)", "--card-border": "rgba(214, 204, 194, 0.12)", "--text": "#f7f5f0", "--muted": "#8a8478", "--brand": "#c17850", "--brand-2": "#d4895f" },
          midnight: { "--bg": "#1a1a2e", "--bg-soft": "#202038", "--card": "rgba(37, 37, 64, 0.96)", "--card-border": "rgba(99, 102, 241, 0.18)", "--text": "#e8e8f0", "--muted": "#8888a0", "--brand": "#6366f1", "--brand-2": "#818cf8" },
          emerald: { "--bg": "#1a2e1a", "--bg-soft": "#203520", "--card": "rgba(37, 48, 37, 0.96)", "--card-border": "rgba(34, 197, 94, 0.18)", "--text": "#e8f0e8", "--muted": "#88a088", "--brand": "#22c55e", "--brand-2": "#4ade80" }
        };
        function applyTheme(theme) {
          const palette = themePalettes[theme] || themePalettes.warm;
          for (const [key, value] of Object.entries(palette)) document.documentElement.style.setProperty(key, value);
        }
        function showToast(message, isError = false) {
          toast.textContent = message;
          toast.classList.remove("hidden");
          toast.style.borderColor = isError ? "#ef4444" : "#22c55e";
          setTimeout(() => toast.classList.add("hidden"), 5000);
        }
        async function api(path, options = {}) {
          const res = await fetch(path, {
            credentials: "include",
            headers: { "content-type": "application/json", ...(options.headers || {}) },
            ...options
          });
          let payload = null;
          try { payload = await res.json(); } catch {}
          if (!res.ok) throw new Error(payload && payload.error ? payload.error : String(res.status));
          return payload;
        }
        async function requireAuth() {
          try {
            const me = await api("/me", { method: "GET", headers: {} });
            applyTheme((me.user || {}).uiTheme || "warm");
            return me;
          } catch {
            window.location.href = "/portal";
            throw new Error("not_authenticated");
          }
        }
        function statusBadge(text, tone = "neutral") {
          const toneClass = tone === "ok" ? "ok" : tone === "warn" ? "warn" : tone === "danger" ? "danger" : "";
          return "<span class='status-badge " + toneClass + "'>" + String(text) + "</span>";
        }
        function boolBadge(value, trueLabel = "YES", falseLabel = "NO") {
          return value ? statusBadge(trueLabel, "ok") : statusBadge(falseLabel, "warn");
        }
        async function loadTopTicker() {
          try {
            await requireAuth();
            const summary = await api("/dashboard/summary", { method: "GET", headers: {} });
            const credits = (summary.walletSnapshot || {}).credits;
            const creditVal = credits && typeof credits.balance !== "undefined" ? String(credits.balance) : "n/a";
            const nodeCount = String((summary.nodes || []).length);
            const walletCount = String(((summary.walletSnapshot || {}).wallets || []).length);
            const sendReq = await api("/wallet/send/requests", { method: "GET", headers: {} }).catch(() => ({ requests: [] }));
            const pendingSends = ((sendReq.requests || []).filter((r) => String(r.status) === "pending_manual_review")).length;
            document.getElementById("topTickerCredits").textContent = creditVal;
            document.getElementById("topTickerNodes").textContent = nodeCount;
            document.getElementById("topTickerWallet").textContent = walletCount;
            document.getElementById("topTickerSends").textContent = String(pendingSends);
          } catch {
            // noop on pages that redirect unauthenticated users
          }
        }
        document.getElementById("logoutBtn").addEventListener("click", async () => {
          try {
            await api("/auth/logout", { method: "POST", body: JSON.stringify({}) });
          } finally {
            window.location.href = "/";
          }
        });
        document.getElementById("switchUserBtn").addEventListener("click", async () => {
          try {
            await api("/auth/logout", { method: "POST", body: JSON.stringify({}) });
          } finally {
            window.location.href = "/portal?switch=1";
          }
        });
        loadTopTicker();
      </script>
      <script>
        ${input.script}
      </script>
    </body>
  </html>`;
}

app.get("/portal", async (_req, reply) => {
  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>EdgeCoder Portal | Sign in</title>
      <style>
        :root {
          --bg: #2f2f2d;
          --bg-soft: #353533;
          --card: rgba(58, 58, 55, 0.96);
          --card-border: rgba(214, 204, 194, 0.12);
          --text: #f7f5f0;
          --muted: #8a8478;
          --brand: #c17850;
          --brand-2: #d4895f;
        }
        * { box-sizing: border-box; }
        body {
          font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          margin: 0;
          color: var(--text);
          background: var(--bg);
          min-height: 100vh;
        }
        .shell { max-width: 980px; margin: 28px auto 42px; padding: 0 16px; }
        .hero { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
        .brand { display: inline-flex; align-items: center; gap: 10px; }
        .mark {
          width: 36px;
          height: 36px;
          border-radius: 11px;
          background: linear-gradient(140deg, var(--brand), var(--brand-2));
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .muted { color: var(--muted); font-size: 13px; }
        .layout { display: grid; grid-template-columns: 1fr; gap: 12px; }
        .auth-stack { display: grid; gap: 12px; grid-template-columns: repeat(2, minmax(260px, 1fr)); }
        .card {
          background: var(--card);
          border: 1px solid var(--card-border);
          border-radius: 12px;
          padding: 16px;
          backdrop-filter: blur(10px);
          box-shadow: 0 6px 20px rgba(15, 23, 42, 0.08);
        }
        .simple-intro { background: var(--bg-soft); }
        .simple-intro h2 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.02em; }
        .simple-intro p { margin: 0; color: var(--muted); line-height: 1.6; max-width: 760px; }
        label { display: block; margin: 8px 0 4px; font-size: 13px; color: var(--muted); }
        input {
          width: 100%;
          padding: 10px 11px;
          border: 1px solid var(--card-border);
          border-radius: 10px;
          background: var(--bg);
          color: var(--text);
        }
        .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
        button {
          padding: 9px 12px;
          border-radius: 10px;
          border: 1px solid var(--card-border);
          background: var(--bg-soft);
          color: var(--text);
          cursor: pointer;
        }
        button.primary {
          background: linear-gradient(140deg, var(--brand), var(--brand-2));
          border-color: rgba(193, 120, 80, 0.75);
          color: white;
        }
        a { color: inherit; }
        #toast {
          position: fixed;
          top: 20px;
          right: 20px;
          width: min(420px, calc(100vw - 32px));
          z-index: 100;
          margin: 0;
        }
        .hidden { display: none; }
        .session-banner {
          border: 1px solid rgba(193, 120, 80, 0.34);
          background: rgba(58, 58, 55, 0.8);
        }
        @media (max-width: 920px) {
          .auth-stack { grid-template-columns: 1fr; }
        }
      </style>
    </head>
    <body>
      <div class="shell">
        <div class="hero">
          <div class="brand">
            <div class="mark">E</div>
            <div>
              <h1 style="margin:0;">EdgeCoder Portal</h1>
              <div class="muted">Sign in to access dashboard, nodes, wallet, and settings pages.</div>
            </div>
          </div>
          <a href="/">Back to edgecoder.io</a>
        </div>
        <div class="layout">
          <div class="card simple-intro">
            <h2>Simple, secure sign-in</h2>
            <p>
              Access your EdgeCoder workspace with enterprise authentication controls,
              passkeys, and policy-driven operations in one place.
            </p>
          </div>
          <div class="auth-stack">
            <div class="card">
            <h2 style="margin-top:0;">Get started</h2>
            <p class="muted">Create your account to enroll nodes and manage compute access.</p>
            <label>Email</label><input id="signupEmail" type="email" placeholder="you@company.com" />
            <label>Password</label><input id="signupPassword" type="password" placeholder="At least 8 characters" />
            <label>Display name (optional)</label><input id="signupDisplayName" type="text" placeholder="Team or your name" />
            <div class="row">
              <button class="primary" id="signupBtn">Create account</button>
            </div>
            </div>
            <div class="card">
            <h2 style="margin-top:0;">Sign in</h2>
            <label>Email</label><input id="loginEmail" type="email" placeholder="you@company.com" />
            <label>Password</label><input id="loginPassword" type="password" placeholder="Your password" />
            <div class="row">
              <button class="primary" id="loginBtn">Log in</button>
              <button id="resendBtn">Resend verification</button>
            </div>
            <div class="row">
              <button id="passkeyLoginBtn">Log in with passkey</button>
            </div>
            <h3>Single sign-on</h3>
            <div class="row">
              <a href="/auth/oauth/google/start"><button>Google</button></a>
              <a href="/auth/oauth/microsoft/start"><button>Microsoft 365</button></a>
            </div>
            </div>
          </div>
        </div>
        <div id="sessionBanner" class="card session-banner hidden">
          <h3 style="margin-top:0;">Already signed in</h3>
          <div id="sessionUserLine" class="muted">You already have an active session.</div>
          <div class="row">
            <button class="primary" id="continueSessionBtn">Continue to dashboard</button>
            <button id="switchUserBtn">Switch user</button>
          </div>
        </div>
      </div>
      <div id="toast" class="card hidden"></div>
      <script>
        const toast = document.getElementById("toast");
        const sessionBanner = document.getElementById("sessionBanner");
        const sessionUserLine = document.getElementById("sessionUserLine");
        const continueSessionBtn = document.getElementById("continueSessionBtn");
        const switchUserBtn = document.getElementById("switchUserBtn");
        function showToast(message, isError = false) {
          toast.textContent = message;
          toast.classList.remove("hidden");
          toast.style.borderColor = isError ? "#ef4444" : "#22c55e";
          setTimeout(() => toast.classList.add("hidden"), 5000);
        }
        function b64urlToArrayBuffer(base64url) {
          const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
          const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
          const binary = atob(padded);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
          return bytes.buffer;
        }
        function arrayBufferToB64url(buffer) {
          const bytes = new Uint8Array(buffer);
          let binary = "";
          for (const b of bytes) binary += String.fromCharCode(b);
          return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
        }
        async function api(path, options = {}) {
          const res = await fetch(path, {
            credentials: "include",
            headers: { "content-type": "application/json", ...(options.headers || {}) },
            ...options
          });
          let payload = null;
          try { payload = await res.json(); } catch {}
          if (!res.ok) throw new Error(payload && payload.error ? payload.error : String(res.status));
          return payload;
        }
        async function checkExistingSession() {
          try {
            const me = await api("/me", { method: "GET", headers: {} });
            const user = me.user || {};
            sessionUserLine.textContent = (user.email || "unknown") + " is currently signed in on this browser.";
            sessionBanner.classList.remove("hidden");
          } catch {
            sessionBanner.classList.add("hidden");
          }
        }
        document.getElementById("signupBtn").addEventListener("click", async () => {
          try {
            await api("/auth/signup", {
              method: "POST",
              body: JSON.stringify({
                email: document.getElementById("signupEmail").value,
                password: document.getElementById("signupPassword").value,
                displayName: document.getElementById("signupDisplayName").value || undefined
              })
            });
            showToast("Signup complete. Verify your email, then sign in.");
          } catch (err) {
            showToast("Signup failed: " + String(err.message || err), true);
          }
        });
        document.getElementById("loginBtn").addEventListener("click", async () => {
          try {
            await api("/auth/login", {
              method: "POST",
              body: JSON.stringify({
                email: document.getElementById("loginEmail").value,
                password: document.getElementById("loginPassword").value
              })
            });
            window.location.href = "/portal/dashboard";
          } catch (err) {
            showToast("Login failed: " + String(err.message || err), true);
          }
        });
        document.getElementById("resendBtn").addEventListener("click", async () => {
          try {
            const payload = await api("/auth/resend-verification", {
              method: "POST",
              body: JSON.stringify({ email: document.getElementById("loginEmail").value })
            });
            if (payload && payload.alreadyVerified) {
              showToast("This account is already verified. No email was sent.");
            } else {
              showToast("If the account exists, a verification email was sent.");
            }
          } catch (err) {
            showToast("Resend failed: " + String(err.message || err), true);
          }
        });
        document.getElementById("passkeyLoginBtn").addEventListener("click", async () => {
          if (!window.PublicKeyCredential) {
            showToast("Passkeys are not supported in this browser.", true);
            return;
          }
          try {
            const email = document.getElementById("loginEmail").value;
            const authOptions = await api("/auth/passkey/login/options", {
              method: "POST",
              body: JSON.stringify({ email })
            });
            const challengeId = authOptions.challengeId;
            const options = authOptions.options;
            options.challenge = b64urlToArrayBuffer(options.challenge);
            options.allowCredentials = (options.allowCredentials || []).map((c) => ({ ...c, id: b64urlToArrayBuffer(c.id) }));
            const assertion = await navigator.credentials.get({ publicKey: options });
            const response = assertion.response;
            await api("/auth/passkey/login/verify", {
              method: "POST",
              body: JSON.stringify({
                challengeId,
                credentialId: assertion.id,
                response: {
                  id: assertion.id,
                  rawId: arrayBufferToB64url(assertion.rawId),
                  type: assertion.type,
                  response: {
                    clientDataJSON: arrayBufferToB64url(response.clientDataJSON),
                    authenticatorData: arrayBufferToB64url(response.authenticatorData),
                    signature: arrayBufferToB64url(response.signature),
                    userHandle: response.userHandle ? arrayBufferToB64url(response.userHandle) : null
                  }
                }
              })
            });
            window.location.href = "/portal/dashboard";
          } catch (err) {
            showToast("Passkey login failed: " + String(err.message || err), true);
          }
        });
        continueSessionBtn.addEventListener("click", () => {
          window.location.href = "/portal/dashboard";
        });
        switchUserBtn.addEventListener("click", async () => {
          try {
            await api("/auth/logout", { method: "POST", body: JSON.stringify({}) });
            showToast("Signed out. You can now use a different account.");
            sessionBanner.classList.add("hidden");
          } catch (err) {
            showToast("Could not switch user: " + String(err.message || err), true);
          }
        });
        checkExistingSession();
      </script>
    </body>
  </html>`;
  return reply.type("text/html").send(html);
});

app.get("/portal/dashboard", async (_req, reply) => {
  const content = `
    <div class="card">
      <h2 style="margin-top:0;">Account overview</h2>
      <div id="accountMeta" class="muted">Loading account...</div>
      <div class="kpis">
        <div class="kpi"><div class="label">Current credits</div><div class="value" id="creditsValue">-</div></div>
        <div class="kpi"><div class="label">Estimated sats</div><div class="value" id="creditsSatsValue">-</div></div>
        <div class="kpi"><div class="label">Enrolled nodes</div><div class="value" id="nodeCountValue">-</div></div>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0;">Coordinator Operations</h2>
      <div id="opsAccountLine" class="muted">Loading operator session...</div>
      <div id="opsFinalityLine" class="muted">Loading finality state...</div>
      <div class="kpis">
        <div class="kpi"><div class="label">Connected agents</div><div class="value" id="opsAgentsValue">-</div></div>
        <div class="kpi"><div class="label">Queue depth</div><div class="value" id="opsQueueValue">-</div></div>
        <div class="kpi"><div class="label">Results</div><div class="value" id="opsResultsValue">-</div></div>
      </div>
    </div>
    <div id="emailVerifyCard" class="card hidden" style="border-color: rgba(245, 158, 11, 0.55); background: rgba(120, 53, 15, 0.22);">
      <h3 style="margin-top:0;">Email verification required</h3>
      <div class="muted">Your account email is not verified yet. Verify it to fully activate enrolled nodes.</div>
      <div class="row" style="margin-top:10px;">
        <button class="primary" id="emailVerifyNowBtn">Send verification email</button>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Quick actions</h3>
      <div class="row">
        <a href="/portal/chat"><button class="primary">Open Chat</button></a>
        <a href="/portal/wallet"><button>Open wallet</button></a>
        <a href="/portal/settings"><button>Account settings</button></a>
      </div>
    </div>
    <div class="grid2">
      <div class="card">
        <h2 style="margin-top:0;">Enroll node</h2>
        <label>Node ID</label><input id="nodeId" type="text" placeholder="mac-worker-001" />
        <label>Node type</label>
        <select id="nodeKind">
          <option value="agent">Agent</option>
          <option value="coordinator">Coordinator</option>
        </select>
        <div class="row">
          <button class="primary" id="enrollBtn">Generate node token</button>
        </div>
        <p class="muted">Save this token now. It is shown only once.</p>
        <div id="newTokenWrap" class="hidden">
          <div id="newToken" class="token-box"></div>
        </div>
      </div>
      <div class="card">
        <h2 style="margin-top:0;">Node activation states</h2>
        <p class="muted">Nodes become active after email verification and coordinator approval.</p>
        <div class="table-controls">
          <input id="nodesFilterInput" type="text" placeholder="Filter by node id or type" />
          <select id="nodesStatusFilter">
            <option value="all">All states</option>
            <option value="active">Active only</option>
            <option value="pending">Pending activation</option>
          </select>
          <select id="nodesSortOrder">
            <option value="asc">Node A-Z</option>
            <option value="desc">Node Z-A</option>
          </select>
        </div>
        <table>
          <thead><tr><th>Node</th><th>Type</th><th>Email verified</th><th>Approved</th><th>Active</th><th>Last seen</th><th>Actions</th></tr></thead>
          <tbody id="nodesBody"></tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Coordinator enrollment requests</h3>
      <div class="row">
        <button class="primary" id="filterAllBtn">All pending</button>
        <button id="filterCoordinatorBtn">Coordinator enrollment requests</button>
        <button id="filterAgentBtn">Agent enrollment requests</button>
      </div>
      <table>
        <thead><tr><th>Node</th><th>Kind</th><th>Owner email</th><th>Email verified</th><th>IP</th><th>Country</th><th>VPN</th><th>Last seen</th><th>Actions</th></tr></thead>
        <tbody id="opsPendingBody"></tbody>
      </table>
      <div id="opsPendingNote" class="muted"></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Approved nodes</h3>
      <div class="row">
        <button class="primary" id="approvedFilterAllBtn">All approved</button>
        <button id="approvedFilterCoordinatorBtn">Coordinators</button>
        <button id="approvedFilterAgentBtn">Agents</button>
        <button id="approvedFilterActiveBtn">Active only</button>
      </div>
      <table>
        <thead><tr><th>Node</th><th>Kind</th><th>Owner email</th><th>Email verified</th><th>Active</th><th>IP</th><th>Country</th><th>VPN</th><th>Last seen</th><th>Updated</th></tr></thead>
        <tbody id="opsApprovedBody"></tbody>
      </table>
      <div id="opsApprovedNote" class="muted"></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Live issuance (rolling 24h)</h3>
      <div class="kpis">
        <div class="kpi"><div class="label">Daily pool</div><div class="value" id="issuancePoolValue">-</div></div>
        <div class="kpi"><div class="label">Load index</div><div class="value" id="issuanceLoadValue">-</div></div>
        <div class="kpi"><div class="label">Contributors</div><div class="value" id="issuanceContribValue">-</div></div>
      </div>
      <table>
        <thead><tr><th>Account</th><th>Share</th><th>Hourly tokens</th><th>Weighted contribution</th></tr></thead>
        <tbody id="issuanceAllocBody"></tbody>
      </table>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Decentralized local model mesh</h3>
      <div id="modelMeshMeta" class="muted">Loading model-serving agents...</div>
      <table>
        <thead><tr><th>Agent</th><th>Provider</th><th>Model catalog</th><th>Capacity</th></tr></thead>
        <tbody id="modelMeshBody"></tbody>
      </table>
    </div>
  `;
  const script = `
    function fmtFixed(v, digits) {
      const n = Number(v);
      return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
    }
    function fmtTime(ms) { return ms ? new Date(ms).toISOString() : "n/a"; }
    function encodeAttr(v) { return encodeURIComponent(String(v || "")); }
    function escapeHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    function renderRows(targetId, rowsHtml, colspan, emptyText) {
      const body = document.getElementById(targetId);
      body.innerHTML = rowsHtml.length > 0 ? rowsHtml.join("") : "<tr><td colspan='" + colspan + "'>" + emptyText + "</td></tr>";
    }

    /* ── Nodes ── */
    let allNodes = [];
    function renderNodes(nodes) {
      const body = document.getElementById("nodesBody");
      const rows = (nodes || []).map((n) =>
        "<tr><td>" + n.nodeId + "</td><td>" + n.nodeKind + "</td><td>" + boolBadge(Boolean(n.emailVerified), "VERIFIED", "UNVERIFIED") + "</td><td>" +
        boolBadge(Boolean(n.nodeApproved), "APPROVED", "PENDING") + "</td><td>" + (n.active ? statusBadge("ACTIVE", "ok") : statusBadge("DORMANT", "warn")) +
        "</td><td>" + fmtTime(n.lastSeenMs) + "</td><td><button class='deleteNodeBtn' data-node-id='" + encodeAttr(n.nodeId) + "'>Delete</button></td></tr>"
      );
      body.innerHTML = rows.length > 0 ? rows.join("") : "<tr><td colspan='7'>No nodes enrolled.</td></tr>";
    }
    function applyNodeTableView() {
      const text = (document.getElementById("nodesFilterInput").value || "").trim().toLowerCase();
      const statusFilter = document.getElementById("nodesStatusFilter").value;
      const sortOrder = document.getElementById("nodesSortOrder").value;
      const filtered = (allNodes || []).filter((n) => {
        const matchesText = !text || String(n.nodeId).toLowerCase().includes(text) || String(n.nodeKind).toLowerCase().includes(text);
        const active = Boolean(n.active);
        const matchesStatus = statusFilter === "all" || (statusFilter === "active" ? active : !active);
        return matchesText && matchesStatus;
      });
      filtered.sort((a, b) => {
        const aa = String(a.nodeId || "").toLowerCase();
        const bb = String(b.nodeId || "").toLowerCase();
        if (sortOrder === "desc") return bb.localeCompare(aa);
        return aa.localeCompare(bb);
      });
      renderNodes(filtered);
    }
    async function loadNodes() {
      await requireAuth();
      const summary = await api("/dashboard/summary", { method: "GET", headers: {} });
      allNodes = summary.nodes || [];
      applyNodeTableView();
    }
    document.getElementById("nodesFilterInput").addEventListener("input", applyNodeTableView);
    document.getElementById("nodesStatusFilter").addEventListener("change", applyNodeTableView);
    document.getElementById("nodesSortOrder").addEventListener("change", applyNodeTableView);
    document.getElementById("nodesBody").addEventListener("click", async (event) => {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains("deleteNodeBtn")) return;
      const nodeIdRaw = target.getAttribute("data-node-id");
      if (!nodeIdRaw) return;
      const nodeId = decodeURIComponent(nodeIdRaw);
      if (!window.confirm("Delete node '" + nodeId + "'? This removes enrollment from your portal account.")) return;
      try {
        await api("/nodes/" + encodeURIComponent(nodeId), { method: "DELETE", headers: {} });
        showToast("Deleted node " + nodeId);
        await loadNodes();
      } catch (err) {
        showToast("Delete failed: " + String(err.message || err), true);
      }
    });
    document.getElementById("enrollBtn").addEventListener("click", async () => {
      try {
        await requireAuth();
        const payload = await api("/nodes/enroll", {
          method: "POST",
          body: JSON.stringify({
            nodeId: document.getElementById("nodeId").value,
            nodeKind: document.getElementById("nodeKind").value
          })
        });
        document.getElementById("newTokenWrap").classList.remove("hidden");
        document.getElementById("newToken").textContent = payload.registrationToken;
        await loadNodes();
        showToast("Node enrollment token generated.");
      } catch (err) {
        showToast("Enroll failed: " + String(err.message || err), true);
      }
    });

    /* ── Coordinator Ops ── */
    function filterPending(nodes, mode) {
      if (mode === "all") return nodes;
      return (nodes || []).filter((n) => String(n.nodeKind) === mode);
    }
    function filterApproved(nodes, mode, activeOnly) {
      let values = nodes || [];
      if (mode !== "all") values = values.filter((n) => String(n.nodeKind) === mode);
      if (activeOnly) values = values.filter((n) => n.active === true);
      return values;
    }
    let pendingFilter = "all";
    let approvedFilter = "all";
    let approvedActiveOnly = false;
    let cachedPending = [];
    let cachedApproved = [];
    let canManageApprovals = false;

    function renderPending() {
      const body = document.getElementById("opsPendingBody");
      const rows = filterPending(cachedPending, pendingFilter).map((n) =>
        "<tr><td>" + n.nodeId + "</td><td>" + n.nodeKind + "</td><td>" + (n.ownerEmail || "unknown") + "</td><td>" +
        String(Boolean(n.emailVerified)) + "</td><td>" + (n.sourceIp || "unknown") + "</td><td>" + (n.countryCode || "unknown") +
        "</td><td>" + (n.vpnDetected === true ? "yes" : "no") + "</td><td>" + fmtTime(n.lastSeenMs) + "</td><td>" +
        (canManageApprovals
          ? "<button class='approveBtn' data-node-id='" + encodeAttr(n.nodeId) + "' data-node-kind='" + encodeAttr(n.nodeKind) + "' data-approved='true'>Approve</button> <button class='approveBtn' data-node-id='" + encodeAttr(n.nodeId) + "' data-node-kind='" + encodeAttr(n.nodeKind) + "' data-approved='false'>Reject</button>"
          : "<span class='muted'>Read-only</span>") +
        "</td></tr>"
      );
      body.innerHTML = rows.length > 0 ? rows.join("") : "<tr><td colspan='9'>No pending nodes for this filter.</td></tr>";
      const counts = {
        all: cachedPending.length,
        coordinator: cachedPending.filter((n) => n.nodeKind === "coordinator").length,
        agent: cachedPending.filter((n) => n.nodeKind === "agent").length
      };
      document.getElementById("opsPendingNote").textContent = "Filter: " + pendingFilter + " | all=" + counts.all + " coordinator=" + counts.coordinator + " agent=" + counts.agent;
      document.getElementById("filterAllBtn").className = pendingFilter === "all" ? "primary" : "";
      document.getElementById("filterCoordinatorBtn").className = pendingFilter === "coordinator" ? "primary" : "";
      document.getElementById("filterAgentBtn").className = pendingFilter === "agent" ? "primary" : "";
    }

    function renderApproved() {
      const body = document.getElementById("opsApprovedBody");
      const rows = filterApproved(cachedApproved, approvedFilter, approvedActiveOnly).map((n) => {
        return "<tr><td>" + escapeHtml(n.nodeId) + "</td><td>" + n.nodeKind + "</td><td>" + (n.ownerEmail || "unknown") + "</td><td>" +
          String(Boolean(n.emailVerified)) + "</td><td>" + (n.active === true ? "yes" : "no") + "</td><td>" + (n.sourceIp || "unknown") +
          "</td><td>" + (n.countryCode || "unknown") + "</td><td>" + (n.vpnDetected === true ? "yes" : "no") + "</td><td>" +
          fmtTime(n.lastSeenMs) + "</td><td>" + fmtTime(n.updatedAtMs) + "</td></tr>";
      });
      body.innerHTML = rows.length > 0 ? rows.join("") : "<tr><td colspan='10'>No approved nodes for this filter.</td></tr>";
      const counts = {
        all: cachedApproved.length,
        coordinator: cachedApproved.filter((n) => n.nodeKind === "coordinator").length,
        agent: cachedApproved.filter((n) => n.nodeKind === "agent").length,
        active: cachedApproved.filter((n) => n.active === true).length
      };
      document.getElementById("opsApprovedNote").textContent =
        "Filter: " + approvedFilter + (approvedActiveOnly ? " + active-only" : "") +
        " | all=" + counts.all + " coordinator=" + counts.coordinator + " agent=" + counts.agent + " active=" + counts.active;
      document.getElementById("approvedFilterAllBtn").className = approvedFilter === "all" ? "primary" : "";
      document.getElementById("approvedFilterCoordinatorBtn").className = approvedFilter === "coordinator" ? "primary" : "";
      document.getElementById("approvedFilterAgentBtn").className = approvedFilter === "agent" ? "primary" : "";
      document.getElementById("approvedFilterActiveBtn").className = approvedActiveOnly ? "primary" : "";
    }

    async function refreshOps() {
      const me = await requireAuth();
      const user = me.user || {};
      const data = await api("/coordinator/ops/summary", { method: "GET", headers: {} });
      document.getElementById("opsAgentsValue").textContent = String((data.status && data.status.agents) || 0);
      document.getElementById("opsQueueValue").textContent = String((data.status && data.status.queued) || 0);
      document.getElementById("opsResultsValue").textContent = String((data.status && data.status.results) || 0);
      cachedPending = data.pendingNodes || [];
      cachedApproved = data.approvedNodes || [];
      canManageApprovals = Boolean(data.access && data.access.canManageApprovals);
      const scopeText = data.access && data.access.isSystemAdmin ? "global scope" : "owner scope";
      const federationState = data.federation && data.federation.stale ? "stale federation" : "federation healthy";
      const finalityRaw = String((data.federation && data.federation.finalityState) || "unknown");
      const finalityLabel =
        finalityRaw === "anchored_confirmed"
          ? "hard finalized (Bitcoin anchor confirmed)"
          : finalityRaw === "anchored_pending"
            ? "soft finalized (anchor pending)"
            : finalityRaw === "soft_finalized"
              ? "soft finalized (quorum commit)"
              : finalityRaw === "no_checkpoint"
                ? "no checkpoint yet"
                : finalityRaw === "stale_federation"
                  ? "stale federation (checkpoint disagreement)"
                  : "finality unknown";
      const anchorTxRef = data.federation && data.federation.anchorTxRef ? String(data.federation.anchorTxRef) : "n/a";
      document.getElementById("opsAccountLine").textContent =
        (user.email || "unknown") + " | coordinator operations access | " + scopeText + " | " + federationState;
      document.getElementById("opsFinalityLine").textContent =
        "Stats ledger finality: " + finalityLabel + " | anchor tx: " + anchorTxRef;
      renderPending();
      renderApproved();
    }

    document.getElementById("filterAllBtn").addEventListener("click", () => { pendingFilter = "all"; renderPending(); });
    document.getElementById("filterCoordinatorBtn").addEventListener("click", () => { pendingFilter = "coordinator"; renderPending(); });
    document.getElementById("filterAgentBtn").addEventListener("click", () => { pendingFilter = "agent"; renderPending(); });
    document.getElementById("approvedFilterAllBtn").addEventListener("click", () => { approvedFilter = "all"; renderApproved(); });
    document.getElementById("approvedFilterCoordinatorBtn").addEventListener("click", () => { approvedFilter = "coordinator"; renderApproved(); });
    document.getElementById("approvedFilterAgentBtn").addEventListener("click", () => { approvedFilter = "agent"; renderApproved(); });
    document.getElementById("approvedFilterActiveBtn").addEventListener("click", () => { approvedActiveOnly = !approvedActiveOnly; renderApproved(); });

    document.getElementById("opsPendingBody").addEventListener("click", async (event) => {
      const target = event.target;
      if (!target || !target.classList || !target.classList.contains("approveBtn")) return;
      const coordinatorIdRaw = target.getAttribute("data-node-id");
      const nodeKindRaw = target.getAttribute("data-node-kind");
      if (!coordinatorIdRaw || !nodeKindRaw) return;
      const nodeId = decodeURIComponent(coordinatorIdRaw);
      const nodeKind = decodeURIComponent(nodeKindRaw);
      const approved = target.getAttribute("data-approved") === "true";
      try {
        await api("/coordinator/ops/node-approval", {
          method: "POST",
          body: JSON.stringify({ nodeId, nodeKind, approved })
        });
        showToast("Updated " + nodeKind + " " + nodeId + " to " + (approved ? "approved" : "rejected"));
        await refreshOps();
      } catch (err) {
        showToast("Approval failed: " + String(err.message || err), true);
      }
    });

    /* ── Dashboard main load ── */
    (async () => {
      const me = await requireAuth();
      const summary = await api("/dashboard/summary", { method: "GET", headers: {} });
      const insights = await api("/dashboard/network-insights", { method: "GET", headers: {} });
      const user = me.user || {};
      const emailVerified = Boolean(user.emailVerified);
      document.getElementById("accountMeta").textContent =
        (user.email || "unknown") + " | email verified: " + String(emailVerified);
      const credits = (summary.walletSnapshot || {}).credits;
      document.getElementById("creditsValue").textContent =
        credits && typeof credits.balance !== "undefined" ? String(credits.balance) : "n/a";
      const quote = (summary.walletSnapshot || {}).quote;
      document.getElementById("creditsSatsValue").textContent =
        quote && typeof quote.estimatedSats !== "undefined" ? String(quote.estimatedSats) : "n/a";
      document.getElementById("nodeCountValue").textContent = String((summary.nodes || []).length);

      /* populate nodes table from the same summary */
      allNodes = summary.nodes || [];
      applyNodeTableView();

      const issuance = insights.issuance || {};
      const epoch = issuance.epoch || null;
      document.getElementById("issuancePoolValue").textContent = epoch ? fmtFixed(epoch.dailyPoolTokens, 3) : "n/a";
      document.getElementById("issuanceLoadValue").textContent = epoch ? fmtFixed(epoch.loadIndex, 4) : "n/a";
      document.getElementById("issuanceContribValue").textContent = epoch ? String(epoch.contributionCount || 0) : "0";
      const allocRows = ((issuance.allocations || []).slice(0, 8)).map((row) =>
        "<tr><td>" + String(row.accountId || "-") + "</td><td>" + fmtFixed((Number(row.allocationShare || 0) * 100), 2) + "%</td><td>" +
        fmtFixed(row.issuedTokens, 6) + "</td><td>" + fmtFixed(row.weightedContribution, 4) + "</td></tr>"
      );
      renderRows("issuanceAllocBody", allocRows, 4, "No issuance allocations available yet.");

      const modelMesh = insights.modelMesh || {};
      const models = modelMesh.models || [];
      document.getElementById("modelMeshMeta").textContent =
        "Model-serving agents online: " + String(models.length) +
        (modelMesh.generatedAtMs ? " | updated " + new Date(modelMesh.generatedAtMs).toISOString() : "");
      const modelRows = models.slice(0, 12).map((m) =>
        "<tr><td>" + String(m.agentId || "-") + "</td><td>" + String(m.provider || "-") + "</td><td>" +
        String((m.modelCatalog || []).join(", ") || "-") + "</td><td>" + String(m.maxConcurrentTasks || 0) + "</td></tr>"
      );
      renderRows("modelMeshBody", modelRows, 4, "No model-serving agents advertising yet.");

      const emailVerifyCard = document.getElementById("emailVerifyCard");
      const emailVerifyNowBtn = document.getElementById("emailVerifyNowBtn");
      if (!emailVerified) {
        emailVerifyCard.classList.remove("hidden");
        emailVerifyNowBtn.addEventListener("click", async () => {
          try {
            const payload = await api("/auth/resend-verification", {
              method: "POST",
              body: JSON.stringify({ email: user.email || "" })
            });
            if (payload && payload.alreadyVerified) {
              showToast("Your email is already verified.");
            } else {
              showToast("Verification email sent. Check your inbox.");
            }
          } catch (err) {
            showToast("Could not send verification email: " + String(err.message || err), true);
          }
        });
      } else {
        emailVerifyCard.classList.add("hidden");
      }
    })().catch((err) => {
      showToast("Could not load dashboard: " + String(err.message || err), true);
    });

    /* ── Coordinator Ops load + refresh ── */
    async function refreshOpsSafe() {
      try {
        await refreshOps();
      } catch (err) {
        const message = "Could not load coordinator operations: " + String(err.message || err);
        document.getElementById("opsAccountLine").textContent = message + " (auto-retrying)";
        document.getElementById("opsFinalityLine").textContent = "Stats ledger finality: unavailable";
        document.getElementById("opsAgentsValue").textContent = "-";
        document.getElementById("opsQueueValue").textContent = "-";
        document.getElementById("opsResultsValue").textContent = "-";
        showToast(message, true);
      }
    }
    refreshOpsSafe();
    setInterval(refreshOpsSafe, 15000);
  `;
  return reply.type("text/html").send(portalAuthedPageHtml({
    title: "EdgeCoder Portal | Dashboard",
    activeTab: "dashboard",
    heading: "Dashboard",
    subtitle: "High-level account and network view.",
    content,
    script
  }));
});

app.get("/portal/nodes", async (_req, reply) => {
  return reply.redirect("/portal/dashboard");
});

app.get("/portal/coordinator-ops", async (_req, reply) => {
  return reply.redirect("/portal/dashboard");
});

app.get("/portal/wallet", async (_req, reply) => {
  const content = `
    <div class="card">
      <h2 style="margin-top:0;">Wallet security checklist</h2>
      <div id="walletOnboardingMeta" class="muted">Loading wallet onboarding status...</div>
      <div class="row">
        <button class="primary" id="setupSeedBtn">Set up recovery seed phrase</button>
        <button id="walletAckBtn">I backed up my seed phrase</button>
      </div>
      <div id="seedPhraseWrap" class="hidden" style="margin-top:10px;">
        <p class="muted">
          Record this seed phrase now. It is shown only for this setup action and cannot be recovered later.
        </p>
        <div id="seedPhraseValue" class="token-box"></div>
        <div id="seedGuidance" class="muted" style="margin-top:8px;"></div>
      </div>
    </div>
    <div class="grid2">
      <div class="card">
        <h3 style="margin-top:0;">Deposit details</h3>
        <div class="muted">Use these public wallet details to send BTC into EdgeCoder credits.</div>
        <table>
          <tbody>
            <tr><th style="width:34%;">Account</th><td id="depositAccountValue">-</td></tr>
            <tr><th>Network</th><td id="depositNetworkValue">-</td></tr>
            <tr><th>Lightning node pubkey</th><td id="depositLnPubkeyValue">Not configured</td></tr>
            <tr><th>XPUB</th><td id="depositXpubValue">Not configured</td></tr>
            <tr><th>Payout/deposit address</th><td id="depositAddressValue">Not configured</td></tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <h3 style="margin-top:0;">Send bitcoin (MFA required)</h3>
        <div class="muted">
          Every send request requires email code + passkey verification. Requests are queued for secure processing.
        </div>
        <label>Destination address</label><input id="sendDestination" type="text" placeholder="bc1... or invoice reference" />
        <label>Amount (sats)</label><input id="sendAmountSats" type="number" min="1" step="1" placeholder="10000" />
        <label>Note (optional)</label><input id="sendNote" type="text" placeholder="Reason for transfer" />
        <div class="row">
          <button class="primary" id="startSendMfaBtn">Start secure send</button>
        </div>
        <div id="sendMfaWrap" class="hidden" style="margin-top:10px;">
          <div class="muted">Step 2: Enter email code and approve passkey challenge.</div>
          <label>Email code</label><input id="sendEmailCode" type="text" placeholder="6-digit code" />
          <div class="row">
            <button id="confirmSendMfaBtn">Confirm send request</button>
          </div>
        </div>
      </div>
    </div>
    <div class="grid2">
      <div class="card">
        <h3 style="margin-top:0;">Credit ledger</h3>
        <table>
          <thead><tr><th>Time</th><th>Type</th><th>Credits</th><th>Reason</th></tr></thead>
          <tbody id="creditHistoryBody"></tbody>
        </table>
      </div>
      <div class="card">
        <h3 style="margin-top:0;">Wallets and payment intents</h3>
        <table>
          <thead><tr><th>Wallet type</th><th>Network</th><th>Payout</th><th>Node/Xpub</th></tr></thead>
          <tbody id="walletsBody"></tbody>
        </table>
        <h3>Payment intents</h3>
        <div class="table-controls">
          <select id="intentStatusFilter">
            <option value="all">All statuses</option>
            <option value="created">Created</option>
            <option value="settled">Settled</option>
            <option value="expired">Expired</option>
          </select>
          <select id="intentSortOrder">
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </div>
        <table>
          <thead><tr><th>Intent</th><th>Status</th><th>Sats</th><th>Credits</th><th>Created</th></tr></thead>
          <tbody id="paymentIntentsBody"></tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Send request history</h3>
      <div class="table-controls">
        <select id="sendRequestStatusFilter">
          <option value="all">All statuses</option>
          <option value="pending_manual_review">Pending review</option>
          <option value="sent">Sent</option>
          <option value="rejected">Rejected</option>
        </select>
        <select id="sendRequestSortOrder">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>
      </div>
      <table>
        <thead><tr><th>Created</th><th>Destination</th><th>Sats</th><th>Status</th><th>Request ID</th></tr></thead>
        <tbody id="sendRequestsBody"></tbody>
      </table>
    </div>
  `;
  const script = `
    function fmtTime(ms) { return ms ? new Date(ms).toISOString() : "n/a"; }
    function b64urlToArrayBuffer(base64url) {
      const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    function arrayBufferToB64url(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
    }
    function renderRows(targetId, rowsHtml, colspan, emptyText) {
      const el = document.getElementById(targetId);
      el.innerHTML = rowsHtml.length > 0 ? rowsHtml.join("") : "<tr><td colspan='" + colspan + "'>" + emptyText + "</td></tr>";
    }
    function renderSeedGuidance(guidance) {
      const target = document.getElementById("seedGuidance");
      if (!guidance || !Array.isArray(guidance.steps) || guidance.steps.length === 0) {
        target.textContent = "";
        return;
      }
      target.innerHTML = "<strong>" + (guidance.title || "Seed phrase safety guidance") + "</strong><br/>" +
        guidance.steps.map((step, idx) => (idx + 1) + ". " + step).join("<br/>");
    }
    let pendingSendMfa = null;
    let allPaymentIntents = [];
    let allSendRequests = [];
    function renderDepositDetails(accountId, wallet) {
      document.getElementById("depositAccountValue").textContent = accountId || "n/a";
      document.getElementById("depositNetworkValue").textContent = wallet && wallet.network ? wallet.network : "n/a";
      document.getElementById("depositLnPubkeyValue").textContent = wallet && wallet.lnNodePubkey ? wallet.lnNodePubkey : "Not configured";
      document.getElementById("depositXpubValue").textContent = wallet && wallet.xpub ? wallet.xpub : "Not configured";
      document.getElementById("depositAddressValue").textContent = wallet && wallet.payoutAddress ? wallet.payoutAddress : "Not configured";
    }
    function renderPaymentIntents(intents) {
      const rows = (intents || []).map((p) => {
        const tone = p.status === "settled" ? "ok" : p.status === "expired" ? "danger" : "warn";
        return "<tr><td>" + p.intentId + "</td><td>" + statusBadge(p.status, tone) + "</td><td>" + p.amountSats + "</td><td>" + p.quotedCredits +
          "</td><td>" + fmtTime(p.createdAtMs) + "</td></tr>";
      });
      renderRows("paymentIntentsBody", rows, 5, "No payment intents.");
    }
    function applyPaymentIntentView() {
      const statusFilter = document.getElementById("intentStatusFilter").value;
      const sortOrder = document.getElementById("intentSortOrder").value;
      const filtered = (allPaymentIntents || []).filter((p) => statusFilter === "all" || String(p.status) === statusFilter);
      filtered.sort((a, b) => sortOrder === "oldest" ? Number(a.createdAtMs || 0) - Number(b.createdAtMs || 0) : Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
      renderPaymentIntents(filtered);
    }
    function renderSendRequests(requests) {
      const rows = (requests || []).map((req) => {
        const tone = req.status === "sent" ? "ok" : req.status === "rejected" ? "danger" : "warn";
        return "<tr><td>" + fmtTime(req.createdAtMs) + "</td><td>" + req.destination + "</td><td>" + req.amountSats +
          "</td><td>" + statusBadge(req.status, tone) + "</td><td>" + req.requestId + "</td></tr>";
      });
      renderRows("sendRequestsBody", rows, 5, "No send requests yet.");
    }
    function applySendRequestView() {
      const statusFilter = document.getElementById("sendRequestStatusFilter").value;
      const sortOrder = document.getElementById("sendRequestSortOrder").value;
      const filtered = (allSendRequests || []).filter((r) => statusFilter === "all" || String(r.status) === statusFilter);
      filtered.sort((a, b) => sortOrder === "oldest" ? Number(a.createdAtMs || 0) - Number(b.createdAtMs || 0) : Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
      renderSendRequests(filtered);
    }
    async function loadSendRequests() {
      const payload = await api("/wallet/send/requests", { method: "GET", headers: {} });
      allSendRequests = payload.requests || [];
      applySendRequestView();
    }
    async function loadWalletView() {
      await requireAuth();
      const summary = await api("/dashboard/summary", { method: "GET", headers: {} });
      const walletSnapshot = summary.walletSnapshot || {};
      const accountId = (summary.user && summary.user.userId) ? ("acct-" + summary.user.userId) : "n/a";
      const creditHistoryRows = (walletSnapshot.creditHistory || []).map((tx) =>
        "<tr><td>" + fmtTime(tx.timestampMs) + "</td><td>" + tx.type + "</td><td>" + tx.credits + "</td><td>" + tx.reason + "</td></tr>"
      );
      renderRows("creditHistoryBody", creditHistoryRows, 4, "No credit transactions yet.");
      const wallets = walletSnapshot.wallets || [];
      const walletRows = wallets.map((w) =>
        "<tr><td>" + (w.walletType || "") + "</td><td>" + (w.network || "") + "</td><td>" + (w.payoutAddress || "n/a") +
        "</td><td>" + (w.lnNodePubkey || w.xpub || "n/a") + "</td></tr>"
      );
      renderRows("walletsBody", walletRows, 4, "No wallets linked.");
      renderDepositDetails(accountId, wallets[0] || null);
      allPaymentIntents = walletSnapshot.paymentIntents || [];
      applyPaymentIntentView();
      try {
        const onboarding = await api("/wallet/onboarding", { method: "GET", headers: {} });
        const status = onboarding.acknowledgedAtMs
          ? "Seed backup confirmed on " + fmtTime(onboarding.acknowledgedAtMs)
          : "Backup not yet confirmed. Generate and record your seed phrase now.";
        document.getElementById("walletOnboardingMeta").textContent =
          "Network: " + onboarding.network + " | Account: " + onboarding.accountId + " | " + status;
      } catch {
        document.getElementById("walletOnboardingMeta").textContent = "Wallet onboarding status unavailable.";
      }
      await loadSendRequests();
    }
    document.getElementById("intentStatusFilter").addEventListener("change", applyPaymentIntentView);
    document.getElementById("intentSortOrder").addEventListener("change", applyPaymentIntentView);
    document.getElementById("sendRequestStatusFilter").addEventListener("change", applySendRequestView);
    document.getElementById("sendRequestSortOrder").addEventListener("change", applySendRequestView);
    document.getElementById("setupSeedBtn").addEventListener("click", async () => {
      try {
        await requireAuth();
        const setup = await api("/wallet/onboarding/setup-seed", { method: "POST", body: JSON.stringify({}) });
        document.getElementById("seedPhraseWrap").classList.remove("hidden");
        document.getElementById("seedPhraseValue").textContent = setup.seedPhrase;
        renderSeedGuidance(setup.guidance);
        await loadWalletView();
        showToast("New recovery seed phrase generated. Record it before leaving this page.");
      } catch (err) {
        showToast("Could not set up seed phrase: " + String(err.message || err), true);
      }
    });
    document.getElementById("startSendMfaBtn").addEventListener("click", async () => {
      try {
        await requireAuth();
        const destination = document.getElementById("sendDestination").value.trim();
        const amountSats = Number(document.getElementById("sendAmountSats").value);
        const note = document.getElementById("sendNote").value.trim();
        if (!destination) throw new Error("destination_required");
        if (!Number.isFinite(amountSats) || amountSats <= 0) throw new Error("amount_sats_invalid");
        const start = await api("/wallet/send/mfa/start", {
          method: "POST",
          body: JSON.stringify({ destination, amountSats, note: note || undefined })
        });
        pendingSendMfa = start;
        document.getElementById("sendMfaWrap").classList.remove("hidden");
        showToast("Verification code sent to your email. Complete passkey confirmation.");
      } catch (err) {
        showToast("Could not start secure send: " + String(err.message || err), true);
      }
    });
    document.getElementById("confirmSendMfaBtn").addEventListener("click", async () => {
      if (!window.PublicKeyCredential) {
        showToast("Passkeys are not supported in this browser.", true);
        return;
      }
      if (!pendingSendMfa || !pendingSendMfa.passkeyOptions) {
        showToast("Start secure send first.", true);
        return;
      }
      try {
        await requireAuth();
        const emailCode = document.getElementById("sendEmailCode").value.trim();
        if (!emailCode) throw new Error("email_code_required");
        const options = pendingSendMfa.passkeyOptions;
        options.challenge = b64urlToArrayBuffer(options.challenge);
        options.allowCredentials = (options.allowCredentials || []).map((c) => ({ ...c, id: b64urlToArrayBuffer(c.id) }));
        const assertion = await navigator.credentials.get({ publicKey: options });
        const response = assertion.response;
        await api("/wallet/send/mfa/confirm", {
          method: "POST",
          body: JSON.stringify({
            challengeId: pendingSendMfa.challengeId,
            emailCode,
            credentialId: assertion.id,
            response: {
              id: assertion.id,
              rawId: arrayBufferToB64url(assertion.rawId),
              type: assertion.type,
              response: {
                clientDataJSON: arrayBufferToB64url(response.clientDataJSON),
                authenticatorData: arrayBufferToB64url(response.authenticatorData),
                signature: arrayBufferToB64url(response.signature),
                userHandle: response.userHandle ? arrayBufferToB64url(response.userHandle) : null
              }
            }
          })
        });
        pendingSendMfa = null;
        document.getElementById("sendMfaWrap").classList.add("hidden");
        document.getElementById("sendEmailCode").value = "";
        showToast("Send request submitted. Status: pending manual review.");
        await loadSendRequests();
      } catch (err) {
        showToast("Could not confirm secure send: " + String(err.message || err), true);
      }
    });
    document.getElementById("walletAckBtn").addEventListener("click", async () => {
      try {
        await requireAuth();
        await api("/wallet/onboarding/acknowledge", { method: "POST", body: JSON.stringify({}) });
        await loadWalletView();
        showToast("Seed backup acknowledgement saved.");
      } catch (err) {
        showToast("Could not save acknowledgement: " + String(err.message || err), true);
      }
    });
    loadWalletView().catch((err) => showToast("Could not load wallet data: " + String(err.message || err), true));
  `;
  return reply.type("text/html").send(portalAuthedPageHtml({
    title: "EdgeCoder Portal | Wallet",
    activeTab: "wallet",
    heading: "Wallet & Credits",
    subtitle: "Credits, payment intents, and wallet onboarding status.",
    content,
    script
  }));
});

app.get("/portal/settings", async (_req, reply) => {
  const content = `
    <div class="grid2">
      <div class="card">
        <h2 style="margin-top:0;">Account settings</h2>
        <div id="accountLine" class="muted">Loading account...</div>
        <label>Theme</label>
        <select id="themeSelect" style="max-width:220px;">
          <option value="warm">Warm</option>
          <option value="midnight">Midnight</option>
          <option value="emerald">Emerald</option>
        </select>
        <div class="row">
          <button class="primary" id="saveThemeBtn">Save theme</button>
        </div>
      </div>
      <div class="card">
        <h2 style="margin-top:0;">Passkey</h2>
        <p class="muted">Enroll a passkey while logged in for passwordless sign-in.</p>
        <div class="row">
          <button id="passkeyEnrollBtn">Enroll passkey</button>
        </div>
      </div>
    </div>
  `;
  const script = `
    function b64urlToArrayBuffer(base64url) {
      const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
      const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }
    function arrayBufferToB64url(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
    }
    let currentUserTheme = "warm";
    async function bootstrapSettings() {
      const me = await requireAuth();
      const user = me.user || {};
      currentUserTheme = user.uiTheme || "warm";
      document.getElementById("accountLine").textContent = (user.email || "unknown") + " | user ID: " + (user.userId || "n/a");
      document.getElementById("themeSelect").value = currentUserTheme;
    }
    document.getElementById("saveThemeBtn").addEventListener("click", async () => {
      try {
        await requireAuth();
        const theme = document.getElementById("themeSelect").value;
        await api("/me/theme", { method: "POST", body: JSON.stringify({ theme }) });
        applyTheme(theme);
        showToast("Theme updated.");
      } catch (err) {
        showToast("Could not save theme: " + String(err.message || err), true);
      }
    });
    document.getElementById("passkeyEnrollBtn").addEventListener("click", async () => {
      if (!window.PublicKeyCredential) {
        showToast("Passkeys are not supported in this browser.", true);
        return;
      }
      try {
        await requireAuth();
        const payload = await api("/auth/passkey/register/options", { method: "POST", body: JSON.stringify({}) });
        const challengeId = payload.challengeId;
        const options = payload.options;
        options.challenge = b64urlToArrayBuffer(options.challenge);
        options.user.id = b64urlToArrayBuffer(options.user.id);
        options.excludeCredentials = (options.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToArrayBuffer(c.id) }));
        const credential = await navigator.credentials.create({ publicKey: options });
        const response = credential.response;
        await api("/auth/passkey/register/verify", {
          method: "POST",
          body: JSON.stringify({
            challengeId,
            response: {
              id: credential.id,
              rawId: arrayBufferToB64url(credential.rawId),
              type: credential.type,
              response: {
                clientDataJSON: arrayBufferToB64url(response.clientDataJSON),
                attestationObject: arrayBufferToB64url(response.attestationObject),
                transports: response.getTransports ? response.getTransports() : []
              }
            }
          })
        });
        showToast("Passkey enrolled successfully.");
      } catch (err) {
        showToast("Passkey enrollment failed: " + String(err.message || err), true);
      }
    });
    bootstrapSettings().catch((err) => showToast("Could not load settings: " + String(err.message || err), true));
  `;
  return reply.type("text/html").send(portalAuthedPageHtml({
    title: "EdgeCoder Portal | Settings",
    activeTab: "settings",
    heading: "Settings",
    subtitle: "Account preferences and authentication options.",
    content,
    script
  }));
});

export function detectOS(userAgent: string): "macos" | "windows" | "linux" | "ios" | "unknown" {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return "ios";
  if (/macintosh|mac os x/.test(ua)) return "macos";
  if (/windows/.test(ua)) return "windows";
  if (/linux|ubuntu|debian/.test(ua)) return "linux";
  return "unknown";
}

app.get("/portal/download", async (req, reply) => {
  const GH_RELEASE_BASE = "https://github.com/edgecoder-io/edgecoder/releases/latest/download";
  const GH_RELEASES_PAGE = "https://github.com/edgecoder-io/edgecoder/releases/latest";
  const userAgent = req.headers["user-agent"] || "";
  const detectedOS = detectOS(userAgent);
  const queryToken = ((req.query as Record<string, string>)?.token || "").trim();
  const tokenDisplay = queryToken || "YOUR_TOKEN";

  const osLabels: Record<string, string> = {
    macos: "macOS", windows: "Windows", linux: "Linux", ios: "iOS", unknown: "your OS"
  };

  /* ── helper: build a wizard card ─────────────────────────────────── */
  function wizardCard(
    id: string,
    icon: string,
    title: string,
    steps: string[],
    isPrimary: boolean
  ): string {
    const cls = isPrimary ? "wizard-card" : "wizard-card secondary";
    const badge = isPrimary
      ? `<span class="rec-badge">Recommended for you</span>`
      : "";
    const stepsHtml = steps
      .map(
        (s, i) =>
          `<div class="step"><span class="step-num">${i + 1}</span><div class="step-content">${s}</div></div>`
      )
      .join("");
    return `<div class="${cls}" id="card-${id}">${badge}<h3 style="margin:0 0 14px;font-size:15px;">${icon}&nbsp; ${title}</h3>${stepsHtml}</div>`;
  }

  /* ── platform card builders ──────────────────────────────────────── */
  const macCard = wizardCard("macos", "&#127822;", "macOS", [
    `<a class="dl-btn" href="${GH_RELEASE_BASE}/EdgeCoder-1.0.0-macos-installer.pkg">Download .pkg installer</a>
     <a href="${GH_RELEASES_PAGE}" target="_blank" style="font-size:11px;color:var(--brand);margin-left:8px;">All releases</a>`,
    `Double-click the <strong>.pkg</strong> file and follow the prompts.`,
    `<div class="code-block" id="mac-cmd"><code>sudo edgecoder --token ${tokenDisplay}</code><button class="copy-btn" onclick="copyCmd('mac-cmd')">Copy</button></div>`
  ], detectedOS === "macos");

  const winCard = wizardCard("windows", "&#128187;", "Windows", [
    `<a class="dl-btn" href="${GH_RELEASE_BASE}/EdgeCoder-1.0.0-windows-x64.msi">Download .msi installer</a>
     <a href="${GH_RELEASES_PAGE}" target="_blank" style="font-size:11px;color:var(--brand);margin-left:8px;">All releases</a>`,
    `Run the <strong>.msi</strong> file. Click Next. Allow admin access.`,
    `<div class="code-block" id="win-cmd"><code>edgecoder --token ${tokenDisplay}</code><button class="copy-btn" onclick="copyCmd('win-cmd')">Copy</button></div>
     <span style="font-size:10px;color:var(--muted);">Run in PowerShell as Administrator</span>`
  ], detectedOS === "windows");

  const linuxCard = wizardCard("linux", "&#128039;", "Linux (Debian / Ubuntu)", [
    `<a class="dl-btn" href="${GH_RELEASE_BASE}/EdgeCoder-1.0.0-linux-amd64.deb">Download .deb package</a>
     <a href="${GH_RELEASES_PAGE}" target="_blank" style="font-size:11px;color:var(--brand);margin-left:8px;">All releases</a>`,
    `<div class="code-block" id="linux-install"><code>sudo dpkg -i EdgeCoder-1.0.0-linux-amd64.deb</code><button class="copy-btn" onclick="copyCmd('linux-install')">Copy</button></div>`,
    `<div class="code-block" id="linux-cmd"><code>sudo edgecoder --token ${tokenDisplay}</code><button class="copy-btn" onclick="copyCmd('linux-cmd')">Copy</button></div>`
  ], detectedOS === "linux");

  const iosCard = wizardCard("ios", "&#128241;", "iOS (iPhone / iPad)", [
    `<a class="dl-btn" href="#">Download from App Store</a>
     <span style="font-size:10px;color:var(--muted);margin-left:8px;">TestFlight available now</span>`,
    `Sign in with your <strong>EdgeCoder account</strong>.`,
    `Go to <strong>Settings</strong> and paste your token: <div class="code-block" id="ios-token" style="margin-top:6px;"><code>${tokenDisplay}</code><button class="copy-btn" onclick="copyCmd('ios-token')">Copy</button></div>`
  ], detectedOS === "ios");

  const vscodeCard = wizardCard("vscode", "&#9881;&#65039;", "VS Code Extension", [
    `<div class="code-block" id="vscode-cmd"><code>ext install edgecoder.edgecoder</code><button class="copy-btn" onclick="copyCmd('vscode-cmd')">Copy</button></div>
     <span style="font-size:10px;color:var(--muted);">Run in the VS Code command line, or search "EdgeCoder" in the Extensions panel.</span>`,
    `Open the Command Palette (<kbd>Ctrl+Shift+P</kbd> / <kbd>Cmd+Shift+P</kbd>) &rarr; <strong>EdgeCoder: Configure</strong>.`
  ], false);

  const dockerCard = wizardCard("docker", "&#128051;", "Docker", [
    `<div class="code-block" id="docker-cmd"><code>docker run -d --restart unless-stopped \\
  --name edgecoder \\
  -e EDGE_RUNTIME_MODE=worker \\
  -e AGENT_REGISTRATION_TOKEN=${tokenDisplay} \\
  ghcr.io/edgecoder-io/edgecoder:latest</code><button class="copy-btn" onclick="copyCmd('docker-cmd')">Copy</button></div>`
  ], false);

  /* ── pick primary vs secondary cards ─────────────────────────────── */
  const allCards: Record<string, string> = {
    macos: macCard, windows: winCard, linux: linuxCard, ios: iosCard, vscode: vscodeCard, docker: dockerCard
  };
  const primaryKey = (detectedOS === "unknown") ? "macos" : detectedOS;
  const primaryCard = allCards[primaryKey];
  const secondaryCards = Object.entries(allCards)
    .filter(([k]) => k !== primaryKey)
    .map(([, v]) => v)
    .join("");

  const content = `
    <style>
      .hero-dl{text-align:center;padding:28px 0 18px;}
      .hero-dl h1{font-size:28px;font-weight:700;margin:0 0 6px;color:var(--text);}
      .hero-dl p{font-size:14px;color:var(--muted);margin:0 0 10px;}
      .hero-dl .os-badge{display:inline-block;background:#dcfce7;color:#166534;font-size:11px;padding:3px 10px;border-radius:999px;font-weight:600;}
      .feature-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 24px;}
      @media(max-width:720px){.feature-row{grid-template-columns:repeat(2,1fr);}}
      .feature-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center;}
      .feature-card .fc-icon{font-size:22px;margin-bottom:6px;}
      .feature-card .fc-title{font-size:12px;font-weight:700;margin-bottom:4px;color:var(--text);}
      .feature-card .fc-desc{font-size:11px;color:var(--muted);line-height:1.45;}
      .wizard-card{position:relative;background:var(--card);border:2px solid #2563eb;border-radius:12px;padding:22px 20px;margin-bottom:18px;}
      .wizard-card.secondary{border:1px solid var(--border);}
      .rec-badge{position:absolute;top:-10px;left:16px;background:#dcfce7;color:#166534;font-size:10px;font-weight:700;padding:3px 10px;border-radius:999px;}
      .step{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;}
      .step:last-child{margin-bottom:0;}
      .step-num{flex-shrink:0;width:28px;height:28px;border-radius:50%;background:linear-gradient(140deg,#2563eb,#1d4ed8);color:#fff;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;margin-top:1px;}
      .step-content{font-size:13px;color:var(--text);line-height:1.55;flex:1;}
      .step-content strong{font-weight:600;}
      .dl-btn{display:inline-block;padding:8px 18px;border-radius:8px;background:linear-gradient(140deg,#2563eb,#1d4ed8);color:#fff;text-decoration:none;font-size:13px;font-weight:600;border:none;cursor:pointer;transition:opacity .15s;}
      .dl-btn:hover{opacity:.88;}
      .code-block{position:relative;background:rgba(239,246,255,0.85);border:1px dashed rgba(37,99,235,0.42);border-radius:8px;padding:9px 60px 9px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text);word-break:break-all;line-height:1.55;}
      .code-block code{background:none;padding:0;font-size:inherit;color:inherit;}
      .copy-btn{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:rgba(37,99,235,0.1);color:#2563eb;border:1px solid rgba(37,99,235,0.25);border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;font-weight:600;transition:background .15s;}
      .copy-btn:hover{background:rgba(37,99,235,0.18);}
      .toggle-link{background:none;border:none;color:#2563eb;cursor:pointer;font-size:13px;font-weight:600;padding:0;margin:10px 0 16px;display:inline-block;}
      .toggle-link:hover{text-decoration:underline;}
      .other-platforms{display:none;}
      .other-platforms.show{display:block;}
      .other-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;}
      @media(max-width:720px){.other-grid{grid-template-columns:1fr;}}
    </style>

    <!-- ── Hero ──────────────────────────────────────────────────────── -->
    <div class="hero-dl">
      <h1>Get EdgeCoder</h1>
      <p>Install the agent. Join the mesh. Earn credits.</p>
      <span class="os-badge">Detected: ${osLabels[detectedOS] || "Unknown"}</span>
    </div>

    <!-- ── Feature cards ─────────────────────────────────────────────── -->
    <div class="feature-row">
      <div class="feature-card">
        <div class="fc-icon">&#127760;</div>
        <div class="fc-title">P2P Mesh Network</div>
        <div class="fc-desc">Your device joins a global peer-to-peer mesh for distributed AI inference.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">&#9889;</div>
        <div class="fc-title">Earn Credits</div>
        <div class="fc-desc">Contribute idle compute and earn EdgeCoder credits automatically.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">&#128274;</div>
        <div class="fc-title">Private &amp; Local-First</div>
        <div class="fc-desc">Code and prompts stay on your machine. Inference runs locally when possible.</div>
      </div>
      <div class="feature-card">
        <div class="fc-icon">&#128421;</div>
        <div class="fc-title">Multi-Platform</div>
        <div class="fc-desc">macOS, Windows, Linux, iOS, Docker, and VS Code — one mesh everywhere.</div>
      </div>
    </div>

    <!-- ── Primary platform card ─────────────────────────────────────── -->
    ${primaryCard}

    <!-- ── Other platforms toggle ─────────────────────────────────────── -->
    <button class="toggle-link" id="toggle-others" onclick="toggleOthers()">Show other platforms</button>
    <div class="other-platforms" id="other-platforms">
      <div class="other-grid">
        ${secondaryCards}
      </div>
    </div>
  `;

  const script = `
    requireAuth().catch(() => {});

    function copyCmd(id) {
      var el = document.getElementById(id);
      if (!el) return;
      var text = el.textContent.replace(/Copy$/, '').replace(/Copied!$/, '').trim();
      navigator.clipboard.writeText(text).then(function() {
        var btn = el.querySelector('.copy-btn');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(function() { btn.textContent = 'Copy'; }, 2000); }
      });
    }

    function toggleOthers() {
      var el = document.getElementById('other-platforms');
      var btn = document.getElementById('toggle-others');
      if (!el || !btn) return;
      el.classList.toggle('show');
      btn.textContent = el.classList.contains('show') ? 'Hide other platforms' : 'Show other platforms';
    }
    ${queryToken ? `
    (function() {
      document.querySelectorAll('.code-block code').forEach(function(el) {
        el.innerHTML = el.innerHTML.replace(/YOUR_TOKEN/g, '${queryToken}');
      });
    })();
    ` : ""}
  `;

  return reply.type("text/html").send(portalAuthedPageHtml({
    title: "EdgeCoder Portal | Get EdgeCoder",
    activeTab: "download",
    heading: "Get EdgeCoder",
    subtitle: "Install the agent, join the mesh, start contributing.",
    content,
    script
  }));
});

app.post("/internal/nodes/validate", async (req, reply) => {
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

app.post("/internal/nodes/:nodeId/approval", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  if (!requireInternalToken(req as any, reply)) return;
  const params = z.object({ nodeId: z.string() }).parse(req.params);
  const body = z.object({ approved: z.boolean() }).parse(req.body);
  const updated = await store.setNodeApproval(params.nodeId, body.approved);
  if (!updated) return reply.code(404).send({ error: "node_not_found" });
  return reply.send({ ok: true, node: updated });
});

app.post("/internal/nodes/lookup", async (req, reply) => {
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

app.get("/internal/nodes/pending", async (req, reply) => {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.resolve()
    .then(async () => {
      validatePortalSecurityConfig();
      if (!store) throw new Error("PORTAL_DATABASE_URL is required for portal service.");
      await store.migrate();
    })
    .then(() => app.listen({ port: 4310, host: "0.0.0.0" }))
    .catch((error) => {
      app.log.error(error);
      process.exit(1);
    });
}

export { app as portalServer };

