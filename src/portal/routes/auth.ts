// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { desktopOriginOf } from "../../common/desktop-origins.js";
import type { FastifyInstance } from "fastify";
import { randomUUID, timingSafeEqual } from "node:crypto";
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
import { OAUTH_PROVIDER_LABEL, decideUnlinkedOauthLogin, microsoftUpnOnVerifiedDomain, oauthErrorMessage, oauthErrorPage, oauthProfileFrom, type GithubEmail } from "../oauth-identity.js";
import {
  LINK_BROWSER_COOKIE,
  LINK_MAX_PER_ACCOUNT,
  LINK_MAX_PER_IP,
  LINK_RATE_WINDOW_MS,
  LINK_TOKEN_TTL_MS,
  linkBrowserClearCookie,
  linkBrowserSetCookie,
  linkCheckEmailPage,
  linkConfirmPage,
  maskLinkEmail,
  newLinkSecret
} from "../oauth-pending-link.js";
import { PASSWORD_MAX_LENGTH, passwordSchema, registerPasswordResetRoutes } from "./password-reset.js";
import { verifyEmailPage } from "../pages/verify-email.js";
import { APP_CHALLENGE_RE, APP_VERIFIER_RE, appVerifierMatches } from "../native-app-auth.js";
import { inviteCodeHash, inviteCodeUsable, redeemInviteForNewAccount } from "../invites.js";
import { TERMS_VERSION } from "../../common/legal-notices.js";

/** Shown when an OAuth sign-in would create an account and the soft launch needs an invite. */
const OAUTH_INVITE_REQUIRED = "EdgeCoder is in early access: creating an account needs an invite code. Enter yours under Create account, then continue with single sign-on.";
const OAUTH_INVITE_INVALID = "That invite code is not valid: it may be mistyped, expired, revoked or used up.";
const OAUTH_LINK_INVALID = "This link has expired or was already used. Sign in again to get a new one, or sign in with your password instead.";
/** Graph: the signed-in user's tenant with its verified domains (proves a Microsoft UPN's domain). */
export const MICROSOFT_GRAPH_ORGANIZATION_URL = "https://graph.microsoft.com/v1.0/organization?$select=id,verifiedDomains";

const hexEqual = (a: string, b: string) => {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Verification emails per account per window (signup's own email counts); on top of the per-IP route limit. */
export const EMAIL_VERIFY_MAX_PER_WINDOW = 4;
export const EMAIL_VERIFY_WINDOW_MS = 60 * 60 * 1000;
/** The only answer /auth/resend-verification gives, whatever the state of the address. */
export const RESEND_VERIFICATION_RESPONSE = {
  ok: true,
  message: "If an unverified account exists for that email, we sent it a verification link."
} as const;

/** #16: Email/password and OAuth sign-in, GitHub link (/auth/*, /portal/api/github/*). Moved unchanged from server.ts; server.ts passes in what it needs. */
export function registerAuthRoutes(app: FastifyInstance, { LAUNCH_MODE, EMAIL_VERIFY_TTL_MS, OAUTH_MICROSOFT_PROMPT, PASSKEY_ALLOWED_ORIGINS, PASSKEY_RP_ID, PORTAL_PUBLIC_URL, claimIsTrue, clearCookies, consumeMobileOauthSessionToken, createSessionForUser, decodeJwtPayload, ensureCreditAccountForUser, getCurrentUser, hashPassword, issueMobileOauthSessionToken, normalizeEmail, normalizeNativeOauthRedirect, oauthProviders, parseCookies, readCookie, sendPasswordResetEmail, sendPasswordResetSsoNoticeEmail, sendVerificationEmail, sendOauthLinkConfirmEmail, sendOauthConnectedEmail, sendOauthLinkClaimNoticeEmail, sha256Hex, store, verifyPassword, clientIp }: AuthRoutesDeps): void {
  registerPasswordResetRoutes(app, { store, hashPassword, normalizeEmail, sha256Hex, sendPasswordResetEmail, sendPasswordResetSsoNoticeEmail });
  // #88: HMAC key for the browser-bound OAuth state cookie (OAUTH_STATE_SECRET, or per process).
  const oauthStateHmacKey = oauthStateKey();
  // Login checks a password against this when the account is missing or has no password, so the
  // response takes as long as a real check and does not reveal which accounts exist.
  let dummyPasswordHash: string | undefined;
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
      },
      // Soft launch (LAUNCH_MODE=invite): new accounts need an invite code; sign-in does not.
      launch: { mode: LAUNCH_MODE, inviteRequired: LAUNCH_MODE === "invite" }
    };
  });

  const authUserJson = (u: { userId: string; email: string; displayName?: string | null; emailVerified: boolean }) => ({
    userId: u.userId,
    email: u.email,
    displayName: u.displayName ?? null,
    emailVerified: u.emailVerified
  });

  app.post("/auth/signup", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const body = z
      .object({
        email: z.string().email(),
        password: passwordSchema,
        displayName: z.string().min(2).max(100).optional(),
        inviteCode: z.string().max(64).optional(),
        // Required: the "I agree to the Terms, Privacy Policy and Acceptable Use Policy" checkbox.
        acceptTerms: z.boolean().optional()
      })
      .parse(req.body);
    // Checked before anything else (no invite use, no account): the version accepted is stored.
    if (body.acceptTerms !== true) return reply.code(400).send({ error: "terms_not_accepted", detail: "To create an account, agree to the Terms, Privacy Policy and Acceptable Use Policy." });
    const email = normalizeEmail(body.email);
    if (isAgentPlaceholderEmail(email)) return reply.code(400).send({ error: "email_not_allowed" });
    const existing = await store.getUserByEmail(email);
    if (existing) {
      // This browser (or app) is already signed in to that very account, e.g. a second click on
      // Create account just after the first one succeeded: go straight in. Anyone else is told
      // the account exists, as before, and is offered Sign in / Forgot password.
      const current = await getCurrentUser(req as any);
      if (current && current.userId === existing.userId) {
        return reply.send({ ok: true, alreadySignedIn: true, userId: existing.userId, user: authUserJson(existing) });
      }
      return reply.code(409).send({ error: "email_already_registered" });
    }

    // Soft launch: a new account takes one use of an invite code (no-op in open mode).
    const userId = randomUUID();
    const invite = await redeemInviteForNewAccount({ mode: LAUNCH_MODE, store, code: body.inviteCode, userId });
    if (!invite.ok) return reply.code(invite.status).send({ error: invite.error, detail: invite.detail });

    const user = await store.createUser({
      userId,
      email,
      displayName: body.displayName,
      passwordHash: hashPassword(body.password),
      emailVerified: false,
      termsVersion: TERMS_VERSION,
      termsAcceptedAtMs: Date.now()
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
    // Signed in straight away, exactly as /auth/login would (same session row and cookie; the
    // CSRF origin check and the auth rate limit cover this route too, see security.ts). Until the
    // address is verified the account keeps every unverified-account restriction, and verifying
    // it later revokes this session along with every other pre-verification credential.
    const sessionToken = await createSessionForUser(user.userId, reply);
    return reply.send({
      ok: true,
      userId: user.userId,
      sessionToken,
      user: authUserJson(user),
      emailVerification: "sent",
      termsVersion: TERMS_VERSION
    });
  });

  app.post("/auth/login", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const user = await store.getUserByEmail(normalizeEmail(body.email));
    if (!user || !user.passwordHash) {
      dummyPasswordHash ??= hashPassword(randomUUID());
      verifyPassword(body.password, dummyPasswordHash);
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    if (!verifyPassword(body.password, user.passwordHash)) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const sessionToken = await createSessionForUser(user.userId, reply);
    return reply.send({ ok: true, sessionToken, user: authUserJson(user) });
  });

  app.post("/auth/logout", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const cookies = parseCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
    // Both ways a session is presented (getCurrentUser): the browser cookie and the desktop
    // app's Authorization: Bearer token. Each one sent is ended.
    const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    const tokens = new Set([readCookie(cookies, "edgecoder_portal_session"), auth.startsWith("Bearer ") ? auth.slice(7) : undefined]);
    for (const sessionToken of tokens) {
      if (sessionToken) await store.deleteSessionByTokenHash(sha256Hex(sessionToken));
    }
    reply.header("set-cookie", clearCookies("edgecoder_portal_session"));
    return reply.send({ ok: true });
  });

  // The emailed link only opens a confirmation page: a GET (or a mail scanner prefetching it)
  // changes nothing. The page POSTs the token back, and the address is marked verified only for
  // someone who already holds the account: its session in this browser, or its password. Someone
  // who registered another person's address therefore cannot have it verified by that person
  // clicking the link; the real owner instead uses "Forgot password", which revokes every other
  // way in (routes/password-reset.ts).
  app.get("/auth/verify-email", async (_req, reply) => {
    return reply.header("cache-control", "no-store").type("text/html").send(verifyEmailPage());
  });

  app.post("/auth/verify-email", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const parsed = z.object({ token: z.string().min(10).max(200), password: z.string().max(PASSWORD_MAX_LENGTH).optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "verify_link_invalid" });
    const tokenHash = sha256Hex(parsed.data.token);
    const pending = await store.findEmailVerification(tokenHash);
    const user = pending ? await store.getUserById(pending.userId) : null;
    if (!pending || !user) return reply.code(400).send({ error: "verify_link_invalid" });
    const current = await getCurrentUser(req as any);
    const password = parsed.data.password;
    const proven =
      current?.userId === user.userId ||
      Boolean(password && user.passwordHash && verifyPassword(password, user.passwordHash));
    if (!proven) {
      return reply.code(401).send({ error: user.passwordHash ? "verify_password_required" : "verify_sign_in_required" });
    }
    if (!(await store.consumeEmailVerification(tokenHash))) return reply.code(400).send({ error: "verify_link_invalid" });
    if (!user.emailVerified) {
      // Nothing set up before the address was proven survives: sessions, API keys and passkeys are
      // revoked, and on a password account linked sign-in providers and the GitHub token too. A
      // passwordless account keeps its provider link, since that is how the confirmer signed in.
      await store.deleteSessionsForUser(user.userId);
      await store.revokeAllApiKeys(user.userId);
      await store.deletePasskeysForUser(user.userId);
      if (user.passwordHash) {
        await store.deleteOauthLinksForUser(user.userId);
        await store.deleteGitHubToken(user.userId);
      }
      await store.markUserEmailVerified(user.userId);
      await ensureCreditAccountForUser(user);
    }
    const sessionToken = await createSessionForUser(user.userId, reply);
    return reply.send({ ok: true, sessionToken });
  });

  async function handleResend(email: string): Promise<void> {
    const user = await store!.getUserByEmail(email);
    // Agent accounts have no deliverable email.
    if (!user || user.emailVerified || isAgentPlaceholderEmail(user.email)) return;
    if ((await store!.countRecentEmailVerifications(user.userId, Date.now() - EMAIL_VERIFY_WINDOW_MS)) >= EMAIL_VERIFY_MAX_PER_WINDOW) return;
    const verifyToken = randomUUID();
    await store!.createEmailVerification({
      tokenId: randomUUID(),
      userId: user.userId,
      tokenHash: sha256Hex(verifyToken),
      expiresAtMs: Date.now() + EMAIL_VERIFY_TTL_MS
    });
    await sendVerificationEmail(user.email, verifyToken);
  }

  app.post("/auth/resend-verification", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const body = z.object({ email: z.string().email() }).parse(req.body);
    // Same answer, and same timing (not awaited), whether the address has an account, is already
    // verified or has reached its per-account limit.
    handleResend(normalizeEmail(body.email)).catch((err) => req.log.error({ err }, "verification resend failed"));
    return reply.send(RESEND_VERIFICATION_RESPONSE);
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
  async function beginOauth(providerName: ProviderName, reply: any, opts: { nativeRedirect?: string | null; linkUserId?: string; appChallenge?: string; inviteCodeHash?: string; termsVersion?: string; pendingLinkHash?: string }) {
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
      ...(opts.inviteCodeHash ? { inviteCodeHash: opts.inviteCodeHash } : {}),
      ...(opts.termsVersion ? { termsVersion: opts.termsVersion } : {}),
      ...(opts.pendingLinkHash ? { pendingLinkHash: opts.pendingLinkHash } : {}),
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
    // Connect (Settings) and confirming an emailed link are started with fetch(); the page navigates itself.
    if (opts.linkUserId) return reply.send({ ok: true, authorizeUrl: authorize.toString() });
    if (opts.pendingLinkHash) {
      return reply.send({ ok: true, status: "reauth_required", provider: providerName, providerLabel: OAUTH_PROVIDER_LABEL[providerName], authorizeUrl: authorize.toString() });
    }
    return reply.redirect(authorize.toString());
  }

  app.get("/auth/oauth/:provider/start", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const params = z.object({ provider: z.enum(["google", "microsoft", "github"]) }).parse(req.params);
    // A native app's redirect is a short fixed deep link; the length cap keeps state rows small.
    const query = z.object({ appRedirect: z.string().max(512).optional(), appChallenge: z.string().regex(APP_CHALLENGE_RE).optional(), invite: z.string().max(64).optional(), terms: z.string().max(64).optional() }).parse(req.query);
    // Soft launch: an invite for a possible new account is checked now and redeemed only if the
    // callback creates the account (an existing account signs in without using it).
    let invite: string | undefined;
    if (LAUNCH_MODE === "invite" && query.invite) {
      const usable = await inviteCodeUsable(store, query.invite);
      if (!usable) return reply.code(403).type("text/html").send(oauthErrorPage(OAUTH_INVITE_INVALID));
      invite = inviteCodeHash(usable);
    }
    // The Create account form passes the Terms version its checkbox accepted (?terms=); recorded
    // only if the callback creates a new account. Accounts created without it (sign-in from an app)
    // are asked to accept on the dashboard (GET /portal/api/legal).
    const termsVersion = query.terms === TERMS_VERSION ? TERMS_VERSION : undefined;
    return beginOauth(params.provider, reply, { nativeRedirect: normalizeNativeOauthRedirect(query.appRedirect), appChallenge: query.appChallenge, inviteCodeHash: invite, termsVersion });
  });

  /** Connect a provider to the signed-in account, from Settings. A POST (origin-checked), so other sites can't start it. */
  app.post("/auth/oauth/:provider/connect", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const params = z.object({ provider: z.enum(["google", "microsoft", "github"]) }).parse(req.params);
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    return beginOauth(params.provider, reply, { linkUserId: user.userId });
  });

  /**
   * Completes an emailed link (oauth-pending-link.ts): uses the token up, links the provider
   * identity stored on it to the account, sends the security notice and signs in. The caller has
   * already proven the browser (cookie) or the provider identity (callback subject check).
   */
  async function completePendingLink(tokenHash: string, reply: any): Promise<{ ok: true; userId: string; provider: ProviderName } | { ok: false; status: number; error: string }> {
    const portalStore = store!;
    const pending = await portalStore.consumeOauthPendingLink(tokenHash);
    if (!pending) return { ok: false, status: 400, error: "oauth_link_invalid" };
    const provider = pending.provider as ProviderName;
    const user = await portalStore.getUserById(pending.userId);
    // The account must still hold the address the link was sent to, verified.
    if (!user || !user.emailVerified || normalizeEmail(user.email) !== normalizeEmail(pending.email)) return { ok: false, status: 400, error: "oauth_link_invalid" };
    const existing = await portalStore.findOauthIdentity(provider, pending.providerSubject);
    if (existing && existing.userId !== user.userId) return { ok: false, status: 409, error: "oauth_identity_linked_elsewhere" };
    if (!existing) {
      await portalStore.linkOauthIdentity({ provider, providerSubject: pending.providerSubject, userId: user.userId, emailSnapshot: pending.email, ...(pending.tenantId ? { tenantId: pending.tenantId } : {}) });
      await notifyConnected(user.email, provider);
    }
    appendSetCookie(reply, linkBrowserClearCookie());
    await createSessionForUser(user.userId, reply);
    return { ok: true, userId: user.userId, provider };
  }

  async function notifyConnected(email: string, provider: ProviderName): Promise<void> {
    try {
      await sendOauthConnectedEmail({ email, providerLabel: OAUTH_PROVIDER_LABEL[provider] });
    } catch (err) {
      app.log.error({ err }, "oauth connected notice failed");
    }
  }

  // The emailed link only opens a page: a GET (or a mail scanner prefetching it) changes nothing.
  app.get("/auth/oauth-link/confirm", async (_req, reply) => {
    return reply.header("cache-control", "no-store").type("text/html").send(linkConfirmPage());
  });

  app.post("/auth/oauth-link/confirm", async (req, reply) => {
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const parsed = z.object({ token: z.string().min(20).max(200) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "oauth_link_invalid" });
    const tokenHash = sha256Hex(parsed.data.token);
    const pending = await store.findOauthPendingLink(tokenHash);
    if (!pending) return reply.code(400).send({ error: "oauth_link_invalid" });
    const provider = pending.provider as ProviderName;
    const cookies = parseCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
    // Exact __Host- name only.
    const nonce = cookies[LINK_BROWSER_COOKIE];
    const sameBrowser = Boolean(nonce && pending.browserHash && hexEqual(sha256Hex(nonce), pending.browserHash));
    // Another browser or device: prove the provider identity again; the callback checks the subject.
    if (!sameBrowser) return beginOauth(provider, reply, { pendingLinkHash: tokenHash });
    const done = await completePendingLink(tokenHash, reply);
    if (!done.ok) return reply.code(done.status).send({ error: done.error });
    return reply.send({ ok: true, status: "linked", provider: done.provider, next: `/portal/dashboard?sso_connected=${done.provider}` });
  });

  // --- Connected sign-ins (Settings) ---
  const linkIdOf = (provider: string, subject: string) => sha256Hex(`${provider}|${subject}`).slice(0, 32);

  app.get("/portal/api/sign-ins", async (req, reply) => {
    const current = await getCurrentUser(req as any);
    if (!current) return reply.code(401).send({ error: "not_authenticated" });
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const user = await store.getUserById(current.userId);
    const links = await store.listOauthLinksForUser(current.userId);
    const passkeys = (await store.listPasskeysByUserId(current.userId)).length;
    return reply.header("cache-control", "no-store").send({
      password: Boolean(user?.passwordHash),
      passkeys,
      providers: links.map((l) => ({
        provider: l.provider,
        label: OAUTH_PROVIDER_LABEL[l.provider as ProviderName] ?? l.provider,
        linkId: linkIdOf(l.provider, l.providerSubject),
        email: l.emailSnapshot ?? null,
        createdAtMs: l.createdAtMs
      }))
    });
  });

  app.delete("/portal/api/sign-ins/:provider/:linkId", async (req, reply) => {
    const current = await getCurrentUser(req as any);
    if (!current) return reply.code(401).send({ error: "not_authenticated" });
    if (!store) return reply.code(503).send({ error: "portal_database_not_configured" });
    const params = z.object({ provider: z.string().max(32), linkId: z.string().max(64) }).parse(req.params);
    const user = await store.getUserById(current.userId);
    const links = await store.listOauthLinksForUser(current.userId);
    const target = links.find((l) => l.provider === params.provider && linkIdOf(l.provider, l.providerSubject) === params.linkId);
    if (!target) return reply.code(404).send({ error: "sign_in_not_found" });
    const passkeys = (await store.listPasskeysByUserId(current.userId)).length;
    const methods = (user?.passwordHash ? 1 : 0) + passkeys + links.length;
    // Never leave the account without a way in.
    if (methods <= 1) {
      return reply.code(409).send({ error: "last_sign_in_method", detail: "This is your only way to sign in. Set a password (Forgot password) or add a passkey or another provider first." });
    }
    await store.deleteOauthLink(current.userId, target.provider, target.providerSubject);
    return reply.send({ ok: true });
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
    req: { headers: Record<string, unknown>; ip?: string },
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

    // Re-authentication that completes an emailed link: only the identity the link was made for.
    if (state.pendingLinkHash) {
      const pending = await portalStore.findOauthPendingLink(state.pendingLinkHash);
      if (!pending) return refuse(400, "oauth_link_invalid", OAUTH_LINK_INVALID);
      if (pending.provider !== providerName || pending.providerSubject !== subject) {
        return refuse(403, "oauth_link_wrong_identity", oauthErrorMessage("link_wrong_identity", providerName));
      }
      const done = await completePendingLink(state.pendingLinkHash, reply);
      if (!done.ok) return refuse(done.status, done.error, done.error === "oauth_identity_linked_elsewhere" ? oauthErrorMessage("already_linked", providerName) : OAUTH_LINK_INVALID);
      return reply.redirect(`/portal/dashboard?sso_connected=${providerName}`);
    }

    let linked = await portalStore.findOauthIdentity(providerName, subject);
    // Microsoft links made before (tid, oid) keying used the per-app `sub`; they are re-keyed below.
    if (!linked && profile.legacySubject && profile.legacySubject !== subject) {
      linked = await portalStore.findOauthIdentity(providerName, profile.legacySubject);
    }
    // Microsoft work/school account without `xms_edov`: its UPN is proven when the UPN's domain is
    // a verified domain of the token's tenant (Graph /organization). Not determinable (no answer,
    // no permission) means not proven. Only needed for an identity that is not linked yet.
    if (!linked && providerName === "microsoft" && !profile.emailVerified && profile.microsoftDomainCandidate && profile.tenantId && accessToken && normalizeEmail(profile.microsoftDomainCandidate) === email) {
      const organization = await fetchProviderJson(MICROSOFT_GRAPH_ORGANIZATION_URL, accessToken).catch(() => null);
      if (microsoftUpnOnVerifiedDomain(profile.microsoftDomainCandidate, profile.tenantId, organization)) profile.emailVerified = true;
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
      // An unverified account gains no sign-in method, except one that proves its address.
      if (!current.emailVerified && !provesEmailOf(current)) return refuse(403, "email_not_verified", oauthErrorMessage("connect_unverified", providerName));
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
    let autoLinked = false;
    if (!user) {
      const existing = await portalStore.getUserByEmail(email);
      const decision = decideUnlinkedOauthLogin(profile, existing);
      if ((decision.kind === "confirm_by_email" || decision.kind === "account_unclaimed") && existing) {
        return startEmailConfirmation(decision.kind, existing, providerName, subject, profile.tenantId, req, reply, refuse, nativeRedirect);
      }
      if (decision.kind === "use_existing") {
        user = existing;
        autoLinked = true;
      } else {
        const newUserId = randomUUID();
        if (LAUNCH_MODE === "invite") {
          if (!state.inviteCodeHash) return refuse(403, "invite_required", OAUTH_INVITE_REQUIRED);
          if (!(await portalStore.redeemInviteCode(state.inviteCodeHash, newUserId, Date.now()))) return refuse(403, "invite_invalid", OAUTH_INVITE_INVALID);
        }
        user = await portalStore.createUser({ userId: newUserId, email, emailVerified: profile.emailVerified, displayName: undefined, ...(state.termsVersion ? { termsVersion: state.termsVersion, termsAcceptedAtMs: Date.now() } : {}) });
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
    // Both sides verified the same address: linked automatically, and the account is told.
    if (autoLinked) await notifyConnected(user.email, providerName);

    await createSessionForUser(user.userId, reply);
    if (nativeRedirect) {
      const mobileToken = await issueMobileOauthSessionToken(user.userId, state.appChallenge);
      const redirect = new URL(nativeRedirect);
      redirect.searchParams.set("status", "ok");
      redirect.searchParams.set("provider", providerName);
      redirect.searchParams.set("mobile_token", mobileToken);
      if (autoLinked) redirect.searchParams.set("linked", "1");
      return reply.redirect(redirect.toString());
    }
    return reply.redirect(autoLinked ? `/portal/dashboard?sso_connected=${providerName}` : "/portal/dashboard");
  }

  /**
   * The OAuth identity matched an existing account by email, without proof that may sign in to it.
   * Nothing is signed in. A verified account gets a confirmation link (oauth-pending-link.ts); an
   * account whose address was never verified gets a notice on how to claim it (Forgot password),
   * since linking would share it with whoever registered it. Both show the same "check your
   * email" state, so the screen reveals no more than the old "account exists" error did.
   */
  async function startEmailConfirmation(
    kind: "confirm_by_email" | "account_unclaimed",
    account: { userId: string; email: string },
    providerName: ProviderName,
    subject: string,
    tenantId: string | undefined,
    req: { headers: Record<string, unknown>; ip?: string },
    reply: any,
    refuse: (status: number, error: string, message: string) => unknown,
    nativeRedirect: string | undefined
  ) {
    const portalStore = store!;
    const masked = maskLinkEmail(account.email);
    const ip = clientIp ? clientIp(req as any) : (req.ip ?? "unknown");
    const ipHash = sha256Hex(`oauth-link-ip:${ip}`);
    const since = Date.now() - LINK_RATE_WINDOW_MS;
    if (
      (await portalStore.countRecentOauthPendingLinksForUser(account.userId, since)) >= LINK_MAX_PER_ACCOUNT ||
      (await portalStore.countRecentOauthPendingLinksFromIp(ipHash, since)) >= LINK_MAX_PER_IP
    ) {
      return refuse(429, "oauth_link_rate_limited", oauthErrorMessage("link_rate_limited", providerName));
    }
    const token = newLinkSecret();
    const nonce = newLinkSecret();
    await portalStore.createOauthPendingLink({
      tokenHash: sha256Hex(token),
      kind: kind === "confirm_by_email" ? "link" : "claim_notice",
      userId: account.userId,
      provider: providerName,
      providerSubject: subject,
      ...(tenantId ? { tenantId } : {}),
      email: normalizeEmail(account.email),
      browserHash: sha256Hex(nonce),
      ipHash,
      expiresAtMs: Date.now() + LINK_TOKEN_TTL_MS
    });
    const providerLabel = OAUTH_PROVIDER_LABEL[providerName];
    let sent = false;
    try {
      sent =
        kind === "confirm_by_email"
          ? await sendOauthLinkConfirmEmail({ email: account.email, providerLabel, token, ttlMinutes: Math.round(LINK_TOKEN_TTL_MS / 60000) })
          : await sendOauthLinkClaimNoticeEmail({ email: account.email, providerLabel });
    } catch (err) {
      app.log.error({ err }, "oauth link email failed");
    }
    if (!sent) return refuse(503, "oauth_link_email_failed", oauthErrorMessage("link_email_failed", providerName));
    appendSetCookie(reply, linkBrowserSetCookie(nonce));
    if (nativeRedirect) {
      const redirect = new URL(nativeRedirect);
      redirect.searchParams.set("status", "link_pending");
      redirect.searchParams.set("provider", providerName);
      redirect.searchParams.set("email_hint", masked);
      return reply.redirect(redirect.toString());
    }
    return reply.code(200).header("cache-control", "no-store").type("text/html").send(linkCheckEmailPage(providerName, masked));
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
  // The app's origin differs per OS (desktop-origins.ts), so echo it when it is one of ours.
  const allowDesktopOrigin = (req: { headers: Record<string, unknown> }, reply: { header(k: string, v: string): unknown }) => {
    reply.header("Vary", "Origin");
    const origin = desktopOriginOf(req.headers.origin as string | undefined);
    if (origin) reply.header("Access-Control-Allow-Origin", origin);
  };
  app.options("/auth/oauth/mobile/complete", async (req, reply) => {
    allowDesktopOrigin(req as any, reply);
    reply.header("Access-Control-Allow-Credentials", "true");
    reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "content-type");
    reply.header("Access-Control-Max-Age", "86400");
    return reply.code(204).send();
  });

  app.post("/auth/oauth/mobile/complete", async (req, reply) => {
    allowDesktopOrigin(req as any, reply);
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
