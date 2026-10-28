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
  oauthStateSetCookie
} from "../oauth-state-cookie.js";
import type { AuthRoutesDeps, ProviderName } from "../server.js";

/** #16: Email/password and OAuth sign-in, GitHub link (/auth/*, /portal/api/github/*). Moved unchanged from server.ts; server.ts passes in what it needs. */
export function registerAuthRoutes(app: FastifyInstance, { EMAIL_VERIFY_TTL_MS, OAUTH_MICROSOFT_PROMPT, PASSKEY_ALLOWED_ORIGINS, PASSKEY_RP_ID, PORTAL_PUBLIC_URL, claimIsTrue, clearCookies, consumeMobileOauthSessionToken, createSessionForUser, decodeJwtPayload, ensureCreditAccountForUser, ensureStarterWalletForUser, getCurrentUser, hashPassword, issueMobileOauthSessionToken, normalizeEmail, normalizeNativeOauthRedirect, oauthNativeRedirectByState, oauthProviders, parseCookies, readCookie, sendVerificationEmail, sha256Hex, store, verifyPassword }: AuthRoutesDeps): void {
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
    appendSetCookie(reply, oauthStateSetCookie(oauthStateHmacKey, params.provider, state));
    return reply.redirect(authorize.toString());
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
      oauthNativeRedirectByState.delete(stateId);
      return reply.code(403).send({ error: "oauth_state_invalid" });
    }
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
}
