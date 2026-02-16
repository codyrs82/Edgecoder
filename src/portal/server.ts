import Fastify from "fastify";
import { randomUUID, createHash, randomBytes, timingSafeEqual, scryptSync } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import { PortalStore } from "./store.js";

const app = Fastify({ logger: true });
const store = PortalStore.fromEnv();

const PORTAL_SERVICE_TOKEN = process.env.PORTAL_SERVICE_TOKEN ?? "";
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL ?? "";
const PORTAL_PUBLIC_URL = process.env.PORTAL_PUBLIC_URL ?? "http://127.0.0.1:4310";
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? "";
const CONTROL_PLANE_ADMIN_TOKEN = process.env.CONTROL_PLANE_ADMIN_TOKEN ?? "";
const SESSION_TTL_MS = Number(process.env.PORTAL_SESSION_TTL_MS ?? `${1000 * 60 * 60 * 24 * 7}`);
const EMAIL_VERIFY_TTL_MS = Number(process.env.PORTAL_EMAIL_VERIFY_TTL_MS ?? `${1000 * 60 * 60 * 24}`);

type ProviderName = "google" | "apple" | "microsoft";

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
  apple: {
    clientId: process.env.OAUTH_APPLE_CLIENT_ID ?? "",
    clientSecret: process.env.OAUTH_APPLE_CLIENT_SECRET ?? "",
    authorizeUrl: process.env.OAUTH_APPLE_AUTHORIZE_URL ?? "https://appleid.apple.com/auth/authorize",
    tokenUrl: process.env.OAUTH_APPLE_TOKEN_URL ?? "https://appleid.apple.com/auth/token",
    scopes: "name email"
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

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const segment of cookieHeader.split(";")) {
    const [rawKey, ...rest] = segment.trim().split("=");
    if (!rawKey || rest.length === 0) continue;
    out[rawKey] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function secureCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function encodeCookie(name: string, value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? "Secure; " : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; ${secure}Max-Age=${maxAgeSeconds}`;
}

function clearCookie(name: string): string {
  const secure = process.env.NODE_ENV === "production" ? "Secure; " : "";
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; ${secure}Max-Age=0`;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [algo, salt, hashHex] = encoded.split("$");
  if (algo !== "scrypt" || !salt || !hashHex) return false;
  const derived = scryptSync(password, salt, 64).toString("hex");
  return secureCompare(derived, hashHex);
}

function decodeJwtPayload<T extends Record<string, unknown>>(token: string): T | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    return JSON.parse(payloadJson) as T;
  } catch {
    return null;
  }
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

async function loadWalletSnapshotForUser(userId: string): Promise<unknown> {
  if (!CONTROL_PLANE_URL || !CONTROL_PLANE_ADMIN_TOKEN) {
    return { credits: null, creditHistory: [], wallets: [], paymentIntents: [] };
  }
  const accountId = `acct-${userId}`;
  try {
    const [creditRes, historyRes, walletRes] = await Promise.all([
      request(`${CONTROL_PLANE_URL}/credits/${accountId}/balance`, {
        method: "GET",
        headers: { authorization: `Bearer ${CONTROL_PLANE_ADMIN_TOKEN}` }
      }),
      request(`${CONTROL_PLANE_URL}/credits/${accountId}/history`, {
        method: "GET",
        headers: { authorization: `Bearer ${CONTROL_PLANE_ADMIN_TOKEN}` }
      }),
      request(`${CONTROL_PLANE_URL}/wallets/${accountId}`, {
        method: "GET",
        headers: { authorization: `Bearer ${CONTROL_PLANE_ADMIN_TOKEN}` }
      })
    ]);
    const credits = creditRes.statusCode >= 200 && creditRes.statusCode < 300 ? await creditRes.body.json() : null;
    const historyPayload = historyRes.statusCode >= 200 && historyRes.statusCode < 300
      ? ((await historyRes.body.json()) as { history?: unknown[] })
      : { history: [] };
    const walletPayload = walletRes.statusCode >= 200 && walletRes.statusCode < 300
      ? ((await walletRes.body.json()) as { wallets?: unknown[]; paymentIntents?: unknown[] })
      : { wallets: [], paymentIntents: [] };
    return {
      credits,
      creditHistory: historyPayload.history ?? [],
      wallets: walletPayload.wallets ?? [],
      paymentIntents: walletPayload.paymentIntents ?? []
    };
  } catch {
    return { credits: null, creditHistory: [], wallets: [], paymentIntents: [] };
  }
}

app.get("/health", async () => ({ ok: true, portalDb: Boolean(store) }));

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

  return reply.send({ ok: true, userId: user.userId, emailVerification: "sent" });
});

app.post("/auth/login", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const user = await store.getUserByEmail(normalizeEmail(body.email));
  if (!user || !user.passwordHash || !verifyPassword(body.password, user.passwordHash)) {
    return reply.code(401).send({ error: "invalid_credentials" });
  }

  const sessionToken = randomUUID();
  await store.createSession({
    sessionId: randomUUID(),
    userId: user.userId,
    tokenHash: sha256Hex(sessionToken),
    expiresAtMs: Date.now() + SESSION_TTL_MS
  });
  reply.header("set-cookie", encodeCookie("edgecoder_portal_session", sessionToken, Math.floor(SESSION_TTL_MS / 1000)));
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

app.get("/auth/oauth/:provider/start", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const params = z.object({ provider: z.enum(["google", "apple", "microsoft"]) }).parse(req.params);
  const provider = oauthProviders[params.provider];
  if (!provider.clientId || !provider.clientSecret) {
    return reply.code(503).send({ error: `${params.provider}_oauth_not_configured` });
  }
  const state = randomUUID();
  const callbackUrl = `${PORTAL_PUBLIC_URL}/auth/oauth/${params.provider}/callback`;
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
  if (params.provider === "apple") {
    authorize.searchParams.set("response_mode", "form_post");
  }
  return reply.redirect(authorize.toString());
});

app.get("/auth/oauth/:provider/callback", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const params = z.object({ provider: z.enum(["google", "apple", "microsoft"]) }).parse(req.params);
  const query = z.object({ code: z.string(), state: z.string() }).parse(req.query);
  const provider = oauthProviders[params.provider];
  const state = await store.consumeOauthState(query.state);
  if (!state || state.provider !== params.provider) return reply.code(400).send({ error: "oauth_state_invalid" });

  const tokenRes = await request(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: query.code,
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
    ? decodeJwtPayload<{ sub?: string; email?: string; email_verified?: boolean }>(tokenPayload.id_token)
    : null;

  let subject = claimsFromIdToken?.sub;
  let email = claimsFromIdToken?.email;
  let emailVerified = claimsFromIdToken?.email_verified === true;

  if (provider.userinfoUrl && tokenPayload.access_token) {
    const userRes = await request(provider.userinfoUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${tokenPayload.access_token}` }
    });
    if (userRes.statusCode >= 200 && userRes.statusCode < 300) {
      const userInfo = (await userRes.body.json()) as { sub?: string; email?: string; email_verified?: boolean };
      subject = subject ?? userInfo.sub;
      email = email ?? userInfo.email;
      emailVerified = emailVerified || userInfo.email_verified === true;
    }
  }

  if (!subject) return reply.code(400).send({ error: "oauth_subject_missing" });
  if (!email) return reply.code(400).send({ error: "oauth_email_missing" });

  email = normalizeEmail(email);
  const linked = await store.findOauthIdentity(params.provider, subject);
  let user = linked ? await store.getUserById(linked.userId) : null;
  if (!user) {
    user = (await store.getUserByEmail(email)) ?? null;
  }
  if (!user) {
    user = await store.createUser({
      userId: randomUUID(),
      email,
      emailVerified,
      displayName: undefined
    });
  } else if (emailVerified && !user.emailVerified) {
    await store.markUserEmailVerified(user.userId);
    user = await store.getUserById(user.userId);
  }
  if (!user) return reply.code(500).send({ error: "oauth_user_resolution_failed" });
  await store.linkOauthIdentity({
    provider: params.provider,
    providerSubject: subject,
    userId: user.userId,
    emailSnapshot: email
  });
  if (user.emailVerified) await ensureCreditAccountForUser(user);

  const sessionToken = randomUUID();
  await store.createSession({
    sessionId: randomUUID(),
    userId: user.userId,
    tokenHash: sha256Hex(sessionToken),
    expiresAtMs: Date.now() + SESSION_TTL_MS
  });
  reply.header("set-cookie", encodeCookie("edgecoder_portal_session", sessionToken, Math.floor(SESSION_TTL_MS / 1000)));
  return reply.redirect("/portal");
});

app.get("/me", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });
  const nodes = await store.listNodesByOwner(user.userId);
  return reply.send({
    user: {
      userId: user.userId,
      email: user.email,
      emailVerified: user.emailVerified,
      displayName: user.displayName
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

app.post("/nodes/enroll", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  const user = await getCurrentUser(req as any);
  if (!user) return reply.code(401).send({ error: "not_authenticated" });

  const body = z.object({ nodeId: z.string().min(3), nodeKind: z.enum(["agent", "coordinator"]) }).parse(req.body);
  const registrationToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const record = await store.upsertNodeEnrollment({
    nodeId: body.nodeId,
    nodeKind: body.nodeKind,
    ownerUserId: user.userId,
    ownerEmail: user.email,
    registrationTokenHash: sha256Hex(registrationToken),
    emailVerified: user.emailVerified
  });
  return reply.send({
    ok: true,
    nodeId: record.nodeId,
    nodeKind: record.nodeKind,
    emailVerified: record.emailVerified,
    nodeApproved: record.nodeApproved,
    active: record.active,
    registrationToken
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
  return reply.send({
    user: { userId: user.userId, email: user.email, emailVerified: user.emailVerified },
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

app.get("/", async (_req, reply) => reply.redirect("/portal"));

app.get("/portal", async (_req, reply) => {
  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>EdgeCoder Portal</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 20px; background: #f8fafc; color: #0f172a; }
        h1, h2, h3 { margin: 8px 0; }
        .hidden { display: none; }
        .grid { display: grid; grid-template-columns: repeat(2, minmax(280px, 1fr)); gap: 12px; }
        .card { background: #fff; border: 1px solid #dbe4ee; border-radius: 10px; padding: 14px; margin-bottom: 12px; }
        .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .muted { color: #64748b; font-size: 13px; }
        label { display: block; margin: 8px 0 4px; font-size: 13px; color: #334155; }
        input, select { width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 8px; box-sizing: border-box; }
        button { padding: 8px 10px; border-radius: 8px; border: 1px solid #cbd5e1; background: #f1f5f9; cursor: pointer; }
        button.primary { background: #0f172a; color: white; border-color: #0f172a; }
        table { width: 100%; border-collapse: collapse; font-size: 13px; }
        th, td { border-bottom: 1px solid #e2e8f0; text-align: left; padding: 6px; vertical-align: top; }
        th { background: #f8fafc; color: #334155; }
        code { background: #eef2ff; padding: 2px 4px; border-radius: 4px; }
        .token-box { border: 1px dashed #94a3b8; border-radius: 8px; padding: 8px; background: #f8fafc; word-break: break-all; }
      </style>
    </head>
    <body>
      <h1>EdgeCoder User Portal</h1>
      <p class="muted">Sign up with email/password or SSO, verify your email, enroll nodes, and track credits + wallet activity.</p>

      <div id="authView" class="grid">
        <div class="card">
          <h2>Create account</h2>
          <label>Email</label><input id="signupEmail" type="email" />
          <label>Password</label><input id="signupPassword" type="password" />
          <label>Display name (optional)</label><input id="signupDisplayName" type="text" />
          <div class="row" style="margin-top:10px;">
            <button class="primary" id="signupBtn">Sign up</button>
          </div>
          <p class="muted">Email verification is required before nodes can activate.</p>
        </div>
        <div class="card">
          <h2>Log in</h2>
          <label>Email</label><input id="loginEmail" type="email" />
          <label>Password</label><input id="loginPassword" type="password" />
          <div class="row" style="margin-top:10px;">
            <button class="primary" id="loginBtn">Log in</button>
            <button id="resendBtn">Resend verification email</button>
          </div>
          <h3 style="margin-top:16px;">Single Sign-On</h3>
          <div class="row">
            <a href="/auth/oauth/google/start"><button>Continue with Google</button></a>
            <a href="/auth/oauth/microsoft/start"><button>Continue with Microsoft 365</button></a>
            <a href="/auth/oauth/apple/start"><button>Continue with Apple</button></a>
          </div>
        </div>
      </div>

      <div id="dashboardView" class="hidden">
        <div class="card">
          <div class="row" style="justify-content:space-between;">
            <div>
              <h2>Account</h2>
              <div id="accountMeta" class="muted"></div>
            </div>
            <div class="row">
              <button id="refreshBtn">Refresh</button>
              <button id="logoutBtn">Log out</button>
            </div>
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
            <h3>Activation status</h3>
            <p class="muted">A node is active only when email is verified and coordinator admin approval is complete.</p>
            <table>
              <thead><tr><th>Node</th><th>Type</th><th>Email verified</th><th>Approved</th><th>Active</th><th>Last seen</th></tr></thead>
              <tbody id="nodesBody"></tbody>
            </table>
          </div>
        </div>

        <div class="grid">
          <div class="card">
            <h3>Credits</h3>
            <div id="creditsValue" style="font-size:22px;font-weight:700;">-</div>
            <p class="muted">Account ID: <code id="accountIdLabel"></code></p>
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

      <div id="toast" class="card hidden"></div>

      <script>
        const authView = document.getElementById("authView");
        const dashboardView = document.getElementById("dashboardView");
        const toast = document.getElementById("toast");

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
            await api("/auth/signup", {
              method: "POST",
              body: JSON.stringify({
                email: document.getElementById("signupEmail").value,
                password: document.getElementById("signupPassword").value,
                displayName: document.getElementById("signupDisplayName").value || undefined
              })
            });
            showToast("Signup complete. Check your email for verification.");
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
            await api("/auth/resend-verification", {
              method: "POST",
              body: JSON.stringify({ email: document.getElementById("loginEmail").value })
            });
            showToast("If the account exists, a verification email was sent.");
          } catch (err) {
            showToast("Resend failed: " + String(err.message || err), true);
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

        bootstrap();
      </script>
    </body>
  </html>`;
  return reply.type("text/html").send(html);
});

app.post("/internal/nodes/validate", async (req, reply) => {
  if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
  if (!requireInternalToken(req as any, reply)) return;
  const body = z
    .object({
      nodeId: z.string().min(3),
      nodeKind: z.enum(["agent", "coordinator"]),
      registrationToken: z.string().min(10),
      sourceIp: z.string().optional()
    })
    .parse(req.body);
  const node = await store.getNodeEnrollment(body.nodeId);
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
    nodeId: body.nodeId,
    sourceIp: body.sourceIp,
    countryCode: intelligence.countryCode,
    vpnDetected: intelligence.vpnDetected
  });
  const refreshed = await store.getNodeEnrollment(body.nodeId);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.resolve()
    .then(async () => {
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

