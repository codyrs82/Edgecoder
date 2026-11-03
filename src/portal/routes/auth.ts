// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import {
  appendSetCookie,
  oauthStateClearCookie,
  oauthStateCookieMatches,
  oauthStateCookieName,
  oauthStateKey,
  oauthStateSetCookie,
  pkceChallenge,
  pkceVerifier
} from "../oauth-state-cookie.js";
import type { AuthRoutesDeps, ProviderName } from "../server.js";
import { isAgentPlaceholderEmail } from "../store.js";
import { decideUnlinkedOauthLogin, oauthErrorMessage, oauthErrorPage, oauthProfileFrom, type GithubEmail } from "../oauth-identity.js";
import { passwordSchema, registerPasswordResetRoutes } from "./password-reset.js";
import { APP_CHALLENGE_RE, APP_VERIFIER_RE, appVerifierMatches } from "../native-app-auth.js";

/** #16: Email/password and OAuth sign-in, GitHub link (/auth/*, /portal/api/github/*). Moved unchanged from server.ts; server.ts passes in what it needs. */
export function registerAuthRoutes(app: FastifyInstance, { EMAIL_VERIFY_TTL_MS, OAUTH_MICROSOFT_PROMPT, PASSKEY_ALLOWED_ORIGINS, PASSKEY_RP_ID, PORTAL_PUBLIC_URL, claimIsTrue, clearCookies, consumeMobileOauthSessionToken, createSessionForUser, decodeJwtPayload, ensureCreditAccountForUser, getCurrentUser, hashPassword, issueMobileOauthSessionToken, normalizeEmail, normalizeNativeOauthRedirect, oauthProviders, parseCookies, readCookie, sendPasswordResetEmail, sendPasswordResetSsoNoticeEmail, sendVerificationEmail, sha256Hex, store, verifyPassword }: AuthRoutesDeps): void {
  registerPasswordResetRoutes(app, { store, hashPassword, normalizeEmail, sha256Hex, sendPasswordResetEmail, sendPasswordResetSsoNoticeEmail });
  // #88: HMAC key for the browser-bound OAuth state cookie (OAUTH_STATE_SECRET, or per process).
  const oauthStateHmacKey = oauthStateKey();
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
        password: passwordSchema,
        displayName: z.string().min(2).max(100).optional()
      })
      .parse(req.body);
    const email = normalizeEmail(body.email);
    if (isAgentPlaceholderEmail(email)) return reply.code(400).send({ error: "email_not_allowed" });
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
    // No wallet is created here: the user sets a payout destination from their own wallet
    // (routes/payout-destination.ts). The server never generates wallet keys.
    return reply.send({
      ok: true,
      userId: user.userId,
      emailVerification: "sent"
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
    // Agent accounts have no deliverable email.
    if (!user || isAgentPlaceholderEmail(user.email)) return reply.send({ ok: true });
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

  // Shared by sign-in (/start) and connect-from-Settings (/connect): for a connect the state row
  // carries the signed-in user, and the callback checks that the same session finishes it.
  async function beginOauth(providerName: ProviderName, reply: any, opts: { nativeRedirect?: string | null; linkUserId?: string; appChallenge?: string }) {
    const portalStore = store!;
    const provider = oauthProviders[providerName];
    if (!provider.clientId || !provider.clientSecret) {
      return reply.code(503).send({ error: `${providerName}_oauth_not_configured` });
    }
    const state = randomUUID();
    const callbackUrl = `${PORTAL_PUBLIC_URL}/auth/oauth/${providerName}/callback`;
    await portalStore.createOauthState({
      stateId: state,
      provider: providerName,
      redirectUri: callbackUrl,
      expiresAtMs: Date.now() + 10 * 60 * 1000,
      ...(opts.nativeRedirect ? { nativeRedirect: opts.nativeRedirect } : {}),
      ...(opts.linkUserId ? { linkUserId: opts.linkUserId } : {}),
      // Only meaningful for a hand-off to a native app.
      ...(opts.nativeRedirect && opts.appChallenge ? { appChallenge: opts.appChallenge } : {})
    });
    const authorize = new URL(provider.authorizeUrl);
    authorize.searchParams.set("client_id", provider.clientId);
    authorize.searchParams.set("redirect_uri", callbackUrl);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", provider.scopes);
    authorize.searchParams.set("state", state);
    // #137: PKCE S256 for every provider (the verifier goes only to the token endpoint).
    authorize.searchParams.set("code_challenge", pkceChallenge(pkceVerifier(oauthStateHmacKey, providerName, state)));
    authorize.searchParams.set("code_challenge_method", "S256");
    if (providerName === "microsoft" && OAUTH_MICROSOFT_PROMPT) {
      authorize.searchParams.set("prompt", OAUTH_MICROSOFT_PROMPT);
    }
    appendSetCookie(reply, oauthStateSetCookie(oauthStateHmacKey, providerName, state));
    // Connect is started by the Settings page with fetch(); it navigates to the URL itself.
    if (opts.linkUserId) return reply.send({ ok: true, authorizeUrl: authorize.toString() });
    return reply.redirect(authorize.toString());
  }

  app.get("/auth/oauth/:provider/start", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const params = z.object({ provider: z.enum(["google", "microsoft", "github"]) }).parse(req.params);
    const query = z.object({ appRedirect: z.string().optional(), appChallenge: z.string().regex(APP_CHALLENGE_RE).optional() }).parse(req.query);
    return beginOauth(params.provider, reply, { nativeRedirect: normalizeNativeOauthRedirect(query.appRedirect), appChallenge: query.appChallenge });
  });

  /** Connect a provider to the signed-in account, from Settings. A POST (origin-checked), so other sites can't start it. */
  app.post("/auth/oauth/:provider/connect", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const params = z.object({ provider: z.enum(["google", "microsoft", "github"]) }).parse(req.params);
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    return beginOauth(params.provider, reply, { linkUserId: user.userId });
  });

  app.get("/auth/oauth/:provider/callback", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const params = z.object({ provider: z.enum(["google", "microsoft", "github"]) }).parse(req.params);
    const query = z.object({ code: z.string(), state: z.string() }).parse(req.query);
    return handleOauthCallback(params.provider, query.code, query.state, req, reply);
  });

  app.post("/auth/oauth/:provider/callback", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const params = z.object({ provider: z.enum(["google", "microsoft", "github"]) }).parse(req.params);
    const body = z.object({ code: z.string(), state: z.string() }).parse(req.body);
    return handleOauthCallback(params.provider, body.code, body.state, req, reply);
  });

  async function fetchProviderJson(url: string, accessToken: string): Promise<unknown> {
    const res = await request(url, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", "user-agent": "EdgeCoder-Portal" }
    });
    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    return res.body.json();
  }

  async function handleOauthCallback(
    providerName: ProviderName,
    code: string,
    stateId: string,
    req: { headers: Record<string, unknown> },
    reply: any
  ) {
    const portalStore = store;
    if (!portalStore) return reply.code(503).send({ error: "portal_database_not_configured" });
    const provider = oauthProviders[providerName];
    // #88: consume first, so the state is single-use even when the checks below fail;
    // always clear the browser's state cookie.
    const state = await portalStore.consumeOauthState(stateId);
    appendSetCookie(reply, oauthStateClearCookie(providerName));
    const cookies = parseCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
    // exact __Host- name only (readCookie would also accept an unprefixed, spoofable cookie)
    const stateCookie = cookies[oauthStateCookieName(providerName)];
    if (!state || state.provider !== providerName || !oauthStateCookieMatches(oauthStateHmacKey, stateCookie, providerName, stateId)) {
      return reply.code(403).send({ error: "oauth_state_invalid" });
    }
    const nativeRedirect = state.nativeRedirect;
    const refuse = (status: number, error: string, message: string) => {
      if (nativeRedirect) {
        const redirect = new URL(nativeRedirect);
        redirect.searchParams.set("status", "error");
        redirect.searchParams.set("provider", providerName);
        redirect.searchParams.set("error", error);
        return reply.redirect(redirect.toString());
      }
      return reply.code(status).type("text/html").send(oauthErrorPage(message));
    };

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
        redirect_uri: state.redirectUri,
        code_verifier: pkceVerifier(oauthStateHmacKey, providerName, stateId)
      }).toString()
    });
    if (tokenRes.statusCode < 200 || tokenRes.statusCode >= 300) {
      return reply.code(502).send({ error: "oauth_token_exchange_failed" });
    }
    const tokenPayload = (await tokenRes.body.json()) as { access_token?: string; id_token?: string };
    const accessToken = tokenPayload.access_token;
    const idClaims = tokenPayload.id_token ? decodeJwtPayload<Record<string, unknown>>(tokenPayload.id_token) : null;
    const userInfo = provider.userinfoUrl && accessToken ? ((await fetchProviderJson(provider.userinfoUrl, accessToken)) as Record<string, unknown> | null) : null;
    // GitHub: the address used is the primary one, and only if GitHub marks it verified.
    const githubEmails = providerName === "github" && accessToken ? await fetchProviderJson("https://api.github.com/user/emails", accessToken) : null;
    const profile = oauthProfileFrom(providerName, idClaims, userInfo, Array.isArray(githubEmails) ? (githubEmails as GithubEmail[]) : null);
    const subject = profile.subject;

    if (!subject) return reply.code(400).send({ error: "oauth_subject_missing" });
    if (!profile.email || isAgentPlaceholderEmail(profile.email)) return reply.code(400).send({ error: "oauth_email_missing" });
    const email = normalizeEmail(profile.email);

    let linked = await portalStore.findOauthIdentity(providerName, subject);
    // Microsoft links made before (tid, oid) keying used the per-app `sub`; they are re-keyed below.
    if (!linked && profile.legacySubject && profile.legacySubject !== subject) {
      linked = await portalStore.findOauthIdentity(providerName, profile.legacySubject);
    }
    const linkTo = (userId: string) =>
      portalStore.linkOauthIdentity({
        provider: providerName,
        providerSubject: subject,
        userId,
        emailSnapshot: email,
        ...(profile.tenantId ? { tenantId: profile.tenantId } : {})
      });
    const saveGithubToken = async (userId: string) => {
      if (providerName !== "github" || !accessToken) return;
      await portalStore.saveGitHubToken({ userId, accessToken, githubLogin: profile.githubLogin, githubAvatarUrl: profile.githubAvatarUrl, scopes: provider.scopes });
    };
    // An address counts as proven only when the provider verified it and it is the account's own address.
    const provesEmailOf = (u: { email: string }) => profile.emailVerified && normalizeEmail(u.email) === email;

    if (state.linkUserId) {
      // Connect from Settings: the same signed-in session must finish the flow it started.
      const current = await getCurrentUser(req as any);
      if (!current || current.userId !== state.linkUserId) return refuse(403, "oauth_connect_session_mismatch", oauthErrorMessage("connect_session", providerName));
      if (linked && linked.userId !== current.userId) return refuse(409, "oauth_identity_linked_elsewhere", oauthErrorMessage("already_linked", providerName));
      await linkTo(current.userId);
      await saveGithubToken(current.userId);
      if (!current.emailVerified && provesEmailOf(current)) {
        await portalStore.markUserEmailVerified(current.userId);
        const refreshed = await portalStore.getUserById(current.userId);
        if (refreshed) await ensureCreditAccountForUser(refreshed);
      }
      return reply.redirect(`/portal/settings?connected=${providerName}`);
    }

    let user = linked ? await portalStore.getUserById(linked.userId) : null;
    if (!user) {
      const existing = await portalStore.getUserByEmail(email);
      const decision = decideUnlinkedOauthLogin(profile, existing);
      if (decision.kind === "account_exists") return refuse(409, "oauth_account_exists", oauthErrorMessage("account_exists", providerName));
      if (decision.kind === "account_unclaimed") return refuse(409, "oauth_account_unverified", oauthErrorMessage("account_unclaimed", providerName));
      if (decision.kind === "use_existing") {
        user = existing;
      } else {
        user = await portalStore.createUser({ userId: randomUUID(), email, emailVerified: profile.emailVerified, displayName: undefined });
        await ensureCreditAccountForUser(user);
      }
    } else if (!user.emailVerified && provesEmailOf(user)) {
      await portalStore.markUserEmailVerified(user.userId);
      user = await portalStore.getUserById(user.userId);
    }
    if (!user) return reply.code(500).send({ error: "oauth_user_resolution_failed" });
    await linkTo(user.userId);
    await saveGithubToken(user.userId);
    if (user.emailVerified) await ensureCreditAccountForUser(user);

    await createSessionForUser(user.userId, reply);
    if (nativeRedirect) {
      const mobileToken = await issueMobileOauthSessionToken(user.userId, state.appChallenge);
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
    const body = z.object({ token: z.string().min(24), verifier: z.string().regex(APP_VERIFIER_RE).optional() }).parse(req.body);
    const resolved = await consumeMobileOauthSessionToken(body.token);
    if (!resolved) return reply.code(400).send({ error: "oauth_mobile_token_invalid" });
    // A token from a sign-in the app started is bound to its verifier. An app that sends a verifier
    // only accepts a token bound to it, so a token from someone else's sign-in is refused.
    if (!appVerifierMatches(resolved.appChallenge, body.verifier)) return reply.code(400).send({ error: "oauth_mobile_token_invalid" });
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
}
