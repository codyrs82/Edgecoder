// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AccountSecurity, type SecondFactorCheck } from "../account-security.js";
import { portalCardPageHtml } from "../pages/layout.js";
import { textQrSvg } from "../invoice-qr.js";
import { parseCookies, readCookie, sha256Hex } from "../portal-utils.js";

/*
 * Routes for src/portal/account-security.ts.
 *
 * Signed in (Settings > Profile > Two-factor authentication):
 *   GET  /portal/api/security/2fa                       status (methods, recovery codes left, admin requirement)
 *   POST /portal/api/security/2fa/totp/setup            new secret + otpauth:// URI (needs the second factor if 2FA is already on)
 *   POST /portal/api/security/2fa/totp/enable           { code } -> recovery codes, shown once
 *   POST /portal/api/security/2fa/totp/disable          { code }
 *   POST /portal/api/security/2fa/recovery-codes        { code } -> a new set of recovery codes
 *   POST /portal/api/security/2fa/verify                { code } -> step-up for this session
 *   POST /portal/api/security/2fa/passkey/options       passkey step-up: WebAuthn options
 *   POST /portal/api/security/2fa/passkey/verify        passkey step-up: the assertion
 * Emailed links (no session needed; GET only shows a page, the page POSTs the token):
 *   /auth/account-security/confirm-destination         confirm a payout destination (starts the cooling-off)
 *   /auth/account-security/cancel-destination          cancel it and sign out every session
 *   /auth/account-security/lock                        lock the account (withdrawal receipts)
 * System admins:
 *   GET  /portal/api/admin/security/locked              locked accounts
 *   POST /portal/api/admin/security/:userId/unlock      unlock one
 *
 * Protected actions take the second factor as a step-up made here, or inline as the
 * `x-edgecoder-2fa-code` header (or a `twoFactorCode` body field).
 */

export const TWO_FACTOR_HEADER = "x-edgecoder-2fa-code";

type User = { userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean };

export interface PasskeyStepUpDeps {
  rpId: string;
  allowedOrigins: string[];
  challengeTtlMs: number;
  generateAuthenticationOptions: (opts: any) => Promise<{ challenge: string }>;
  verifyAuthenticationResponse: (opts: any) => Promise<{ verified: boolean; authenticationInfo: { newCounter?: number } }>;
  uint8ArrayFromBase64Url: (v: string) => Uint8Array<ArrayBuffer>;
  normalizePasskeyResponsePayload: (v: unknown) => unknown;
  deriveCredentialIdFromVerifyBody: (b: { credentialId?: string; response: unknown }) => string | null | undefined;
}

export interface AccountSecurityStoreDeps {
  listPasskeysByUserId(userId: string): Promise<Array<{ credentialId: string; transports?: unknown }>>;
  deleteSessionsForUser(userId: string): Promise<void>;
  getUserById(userId: string): Promise<User | null>;
  createPasskeyChallenge?(input: { challengeId: string; userId?: string; email?: string; challenge: string; flowType: "registration" | "authentication"; expiresAtMs: number }): Promise<void>;
  consumePasskeyChallenge?(challengeId: string): Promise<{ userId?: string; challenge: string; flowType: string } | null>;
  findPasskeyByCredentialId?(credentialId: string): Promise<{ credentialId: string; userId: string; publicKeyB64Url: string; counter: number; transports?: unknown } | null>;
  updatePasskeyCounter?(credentialId: string, counter: number): Promise<void>;
  appendAdminAudit?(e: { actorUserId: string; actorEmail: string; action: string; targetUserId: string | null; targetEmailHint: string | null; detail: Record<string, unknown> }): Promise<string>;
}

export interface AccountSecurityRouteDeps {
  security: AccountSecurity | null;
  store: AccountSecurityStoreDeps | null | undefined;
  getCurrentUser: (req: any) => Promise<User | null>;
  buildAccessContext: (user: User) => Promise<{ isSystemAdmin: boolean; canManageCoordinatorOps?: boolean }>;
  passkey?: PasskeyStepUpDeps;
  /** A destination confirmed by link: notify the owner (cancel link). */
  sendDestinationAdded: (input: { email: string; destination: string; activatesAtMs: number; cancelToken: string }) => Promise<unknown>;
  sendAccountLocked: (input: { email: string }) => Promise<unknown>;
  sendTwoFactorChanged: (input: { email: string; enabled: boolean }) => Promise<unknown>;
  /** Stop automatic payouts (lock): clear the account's destination at the coordinator. */
  pausePayouts: (userId: string) => Promise<unknown>;
  /** Unlock: register the account's saved destination again. */
  resumePayouts: (userId: string) => Promise<unknown>;
  /** A change whose cooling-off is over: save and register it. */
  activateDueDestination?: (userId: string) => Promise<unknown>;
}

/** sha256 of the request's session token (cookie, else Bearer), or null. Step-ups are bound to it. */
export function sessionHashOf(req: { headers: Record<string, unknown> }): string | null {
  const cookies = parseCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
  let token = readCookie(cookies, "edgecoder_portal_session");
  if (!token) {
    const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    if (auth.startsWith("Bearer ")) token = auth.slice(7);
  }
  return token ? sha256Hex(token) : null;
}

function inlineCode(req: FastifyRequest): string | null {
  const h = req.headers[TWO_FACTOR_HEADER];
  if (typeof h === "string" && h.trim()) return h.trim().slice(0, 32);
  const b = req.body as { twoFactorCode?: unknown } | undefined;
  return b && typeof b.twoFactorCode === "string" && b.twoFactorCode.trim() ? b.twoFactorCode.trim().slice(0, 32) : null;
}

export type SecondFactorGate = (req: FastifyRequest, user: { userId: string }) => Promise<SecondFactorCheck>;

/** The check protected routes call: passes without 2FA, with a recent step-up in this session, or with a right inline code. */
export function createSecondFactorGate(security: AccountSecurity | null, store: Pick<AccountSecurityStoreDeps, "listPasskeysByUserId"> | null | undefined): SecondFactorGate {
  return async (req, user) => {
    if (!security || !store) return { ok: true, via: "not_enabled" };
    const passkeys = await store.listPasskeysByUserId(user.userId);
    return security.requireSecondFactor(user.userId, { passkeyCount: passkeys.length, sessionHash: sessionHashOf(req), code: inlineCode(req) });
  };
}

/** Admin mutations: the routes under these prefixes (POST/PUT/PATCH/DELETE). */
const ADMIN_ACTION_PREFIXES = ["/portal/api/admin/", "/coordinator/ops/", "/admin/network/registry/"];
export const isAdminActionRoute = (method: string, url: string | undefined) =>
  Boolean(url) && ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase()) && ADMIN_ACTION_PREFIXES.some((p) => url!.startsWith(p));

/**
 * Admin actions need the second factor when the admin has 2FA, and system admins must have it:
 * after the grace period, a system admin without 2FA gets 403 two_factor_enrollment_required.
 * Non-admins pass through untouched (the route itself refuses them).
 */
export function registerAdminTwoFactorHook(app: FastifyInstance, d: Pick<AccountSecurityRouteDeps, "security" | "store" | "getCurrentUser" | "buildAccessContext">): void {
  const gate = createSecondFactorGate(d.security, d.store);
  app.addHook("preHandler", async (req, reply) => {
    if (!d.security || !d.store || !isAdminActionRoute(req.method, req.routeOptions?.url)) return;
    const user = await d.getCurrentUser(req);
    if (!user) return;
    const access = await d.buildAccessContext(user);
    if (!access.isSystemAdmin && !access.canManageCoordinatorOps) return;
    const check = await gate(req, user);
    if (!check.ok) return reply.code(check.status).send(check.body);
    if (check.via !== "not_enabled" || !access.isSystemAdmin) return;
    const req2 = await d.security.adminRequirement(user.userId, false);
    if (req2.enforced) {
      return reply.code(403).send({
        error: "two_factor_enrollment_required",
        detail: "Admins must turn on two-factor authentication (Settings > Profile) before making admin changes.",
        graceEndedAtMs: req2.graceEndsAtMs
      });
    }
  });
}

const codeBody = z.object({ code: z.string().trim().min(6).max(32) });
const tokenBody = z.object({ token: z.string().min(20).max(400) });

function linkPage(input: { title: string; heading: string; sub: string; button: string; action: string; danger?: boolean }): string {
  return portalCardPageHtml({
    title: `EdgeCoder Portal | ${input.title}`,
    message: "",
    content: `<h2>${input.heading}</h2>
          <div class="sub">${input.sub}</div>
          <button class="${input.danger ? "danger" : "primary"}" id="linkAction" type="button">${input.button}</button>`,
    script: `
        const token = new URLSearchParams(location.search).get("token") || "";
        if (token) history.replaceState(null, "", location.pathname);
        const btn = document.getElementById("linkAction");
        if (!token) { btn.disabled = true; show("This link is incomplete. Open it from the email again.", "danger"); }
        btn.addEventListener("click", async () => {
          btn.disabled = true;
          let payload = {};
          let res;
          try {
            res = await fetch(${JSON.stringify(input.action)}, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
            try { payload = (await res.json()) || {}; } catch {}
          } catch { show("Could not reach EdgeCoder. Try again.", "danger"); btn.disabled = false; return; }
          if (res.status === 429) { show("Too many attempts. Wait a minute and try again.", "warn"); btn.disabled = false; return; }
          show(payload.message || payload.detail || (res.ok ? "Done." : "This link has expired or was already used."), res.ok ? "ok" : "danger");
        });
    `
  });
}

export function registerAccountSecurityRoutes(app: FastifyInstance, d: AccountSecurityRouteDeps): void {
  const gate = createSecondFactorGate(d.security, d.store);

  async function signedIn(req: FastifyRequest, reply: FastifyReply) {
    if (!d.store || !d.security) {
      reply.code(503).send({ error: "portal_database_not_configured" });
      return null;
    }
    const user = await d.getCurrentUser(req);
    if (!user) {
      reply.code(401).send({ error: "not_authenticated" });
      return null;
    }
    return { user, store: d.store, security: d.security };
  }

  app.get("/portal/api/security/2fa", async (req, reply) => {
    const a = await signedIn(req, reply);
    if (!a) return reply;
    const [state, passkeys, access] = await Promise.all([a.security.load(a.user.userId), a.store.listPasskeysByUserId(a.user.userId), d.buildAccessContext(a.user)]);
    const status = a.security.status(state, passkeys.length, sessionHashOf(req));
    const admin = access.isSystemAdmin ? await a.security.adminRequirement(a.user.userId, status.enabled) : null;
    const pending = state.payout ? { destination: state.payout.destination, confirmed: Boolean(state.payout.confirmedAtMs), activatesAtMs: state.payout.activatesAtMs ?? null } : null;
    return reply.send({ ...status, admin, locked: state.lock ? { lockedAtMs: state.lock.lockedAtMs } : null, pendingDestination: pending });
  });

  app.post("/portal/api/security/2fa/totp/setup", async (req, reply) => {
    const a = await signedIn(req, reply);
    if (!a) return reply;
    if (a.user.emailVerified === false) return reply.code(403).send({ error: "email_not_verified" });
    // With a passkey already on, adding an authenticator needs it (or the session could add its own factor).
    const check = await gate(req, a.user);
    if (!check.ok) return reply.code(check.status).send(check.body);
    const r = await a.security.startTotp(a.user.userId, a.user.email);
    if (!r.ok) return reply.code(r.error === "two_factor_key_not_configured" ? 503 : 409).send({ error: r.error });
    let qrSvg: string | null = null;
    try {
      qrSvg = textQrSvg(r.otpauthUri);
    } catch {
      qrSvg = null;
    }
    return reply.header("cache-control", "no-store").send({ ...r, qrSvg });
  });

  app.post("/portal/api/security/2fa/totp/enable", async (req, reply) => {
    const a = await signedIn(req, reply);
    if (!a) return reply;
    const parsed = codeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: "Send { code }." });
    const r = await a.security.enableTotp(a.user.userId, parsed.data.code);
    if (!r.ok) return reply.code(r.error === "totp_code_invalid" ? 401 : 409).send({ error: r.error });
    await d.sendTwoFactorChanged({ email: a.user.email, enabled: true }).catch((e) => req.log.warn({ error: String(e) }, "two_factor_email_failed"));
    req.log.info({ userId: a.user.userId }, "two_factor_enabled");
    return reply.header("cache-control", "no-store").send({ ok: true, recoveryCodes: r.recoveryCodes });
  });

  const codeError = (reply: FastifyReply, error: string) =>
    reply.code(error === "two_factor_rate_limited" ? 429 : error === "two_factor_not_enabled" ? 409 : 401).send({ error });

  app.post("/portal/api/security/2fa/totp/disable", async (req, reply) => {
    const a = await signedIn(req, reply);
    if (!a) return reply;
    const parsed = codeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: "Send { code }." });
    const r = await a.security.disableTotp(a.user.userId, parsed.data.code, sessionHashOf(req));
    if (!r.ok) return codeError(reply, r.error);
    await d.sendTwoFactorChanged({ email: a.user.email, enabled: false }).catch((e) => req.log.warn({ error: String(e) }, "two_factor_email_failed"));
    req.log.info({ userId: a.user.userId }, "two_factor_disabled");
    return reply.send({ ok: true });
  });

  app.post("/portal/api/security/2fa/recovery-codes", async (req, reply) => {
    const a = await signedIn(req, reply);
    if (!a) return reply;
    const parsed = codeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: "Send { code }." });
    const r = await a.security.regenerateRecoveryCodes(a.user.userId, parsed.data.code, sessionHashOf(req));
    if (!r.ok) return codeError(reply, r.error);
    return reply.header("cache-control", "no-store").send({ ok: true, recoveryCodes: r.recoveryCodes });
  });

  app.post("/portal/api/security/2fa/verify", async (req, reply) => {
    const a = await signedIn(req, reply);
    if (!a) return reply;
    const parsed = codeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", detail: "Send { code }." });
    const sessionHash = sessionHashOf(req);
    const r = await a.security.verifyCode(a.user.userId, parsed.data.code, sessionHash);
    if (!r.ok) return codeError(reply, r.error);
    const status = a.security.status(await a.security.load(a.user.userId), 0, sessionHash ?? undefined);
    return reply.send({ ok: true, via: r.via, stepUpActiveUntilMs: status.stepUpActiveUntilMs });
  });

  app.post("/portal/api/security/2fa/passkey/options", async (req, reply) => {
    const a = await signedIn(req, reply);
    if (!a) return reply;
    const pk = d.passkey;
    if (!pk || !a.store.createPasskeyChallenge) return reply.code(503).send({ error: "passkeys_not_configured" });
    const passkeys = await a.store.listPasskeysByUserId(a.user.userId);
    if (!passkeys.length) return reply.code(409).send({ error: "passkey_not_registered" });
    const options = await pk.generateAuthenticationOptions({
      rpID: pk.rpId,
      timeout: 60000,
      userVerification: "required",
      allowCredentials: passkeys.map((p) => ({ id: p.credentialId, transports: p.transports as any }))
    });
    const challengeId = randomUUID();
    await a.store.createPasskeyChallenge({ challengeId, userId: a.user.userId, email: a.user.email, challenge: options.challenge, flowType: "authentication", expiresAtMs: Date.now() + pk.challengeTtlMs });
    return reply.send({ challengeId, options });
  });

  app.post("/portal/api/security/2fa/passkey/verify", async (req, reply) => {
    const a = await signedIn(req, reply);
    if (!a) return reply;
    const pk = d.passkey;
    const s = a.store;
    if (!pk || !s.consumePasskeyChallenge || !s.findPasskeyByCredentialId) return reply.code(503).send({ error: "passkeys_not_configured" });
    const parsed = z.object({ challengeId: z.string().min(10).max(64), credentialId: z.string().min(10).max(1024).optional(), response: z.unknown() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const challenge = await s.consumePasskeyChallenge(parsed.data.challengeId);
    if (!challenge || challenge.flowType !== "authentication" || challenge.userId !== a.user.userId) return reply.code(400).send({ error: "passkey_challenge_invalid" });
    const credentialId = pk.deriveCredentialIdFromVerifyBody(parsed.data as { credentialId?: string; response: unknown });
    const credential = credentialId ? await s.findPasskeyByCredentialId(credentialId) : null;
    if (!credential || credential.userId !== a.user.userId) return reply.code(404).send({ error: "passkey_credential_not_found" });
    const verification = await pk
      .verifyAuthenticationResponse({
        response: pk.normalizePasskeyResponsePayload(parsed.data.response) as any,
        expectedChallenge: challenge.challenge,
        expectedOrigin: pk.allowedOrigins,
        expectedRPID: pk.rpId,
        requireUserVerification: true,
        credential: { id: credential.credentialId, publicKey: pk.uint8ArrayFromBase64Url(credential.publicKeyB64Url), counter: Number(credential.counter), transports: credential.transports as any }
      })
      .catch(() => null);
    if (!verification?.verified) return reply.code(401).send({ error: "passkey_verification_failed" });
    await s.updatePasskeyCounter?.(credential.credentialId, Number(verification.authenticationInfo.newCounter ?? credential.counter));
    const sessionHash = sessionHashOf(req);
    if (sessionHash) await a.security.grantStepUp(a.user.userId, sessionHash);
    return reply.send({ ok: true, via: "passkey" });
  });

  // ── Emailed links ──

  app.get("/auth/account-security/confirm-destination", async (_req, reply) =>
    reply.header("cache-control", "no-store").type("text/html").send(
      linkPage({ title: "Confirm payout address", heading: "Confirm your new payout address", sub: "Payouts start going to it after the cooling-off period. We'll email you a link to cancel in case this wasn't you.", button: "Confirm payout address", action: "/auth/account-security/confirm-destination" })
    )
  );

  app.post("/auth/account-security/confirm-destination", async (req, reply) => {
    if (!d.store || !d.security) return reply.code(503).send({ error: "portal_database_not_configured" });
    const parsed = tokenBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "link_invalid" });
    const r = await d.security.confirmDestinationByToken(parsed.data.token);
    if (!r) return reply.code(400).send({ error: "link_invalid", detail: "This link has expired or was already used. Save the address again to get a new one." });
    const user = await d.store.getUserById(r.userId);
    if (user) await d.sendDestinationAdded({ email: user.email, destination: r.pending.destination, activatesAtMs: r.pending.activatesAtMs!, cancelToken: r.cancelToken }).catch((e) => req.log.warn({ error: String(e) }, "payout_destination_notice_failed"));
    req.log.info({ userId: r.userId, activatesAtMs: r.pending.activatesAtMs }, "payout_destination_confirmed");
    return reply.send({ ok: true, activatesAtMs: r.pending.activatesAtMs, message: `Confirmed. Payouts go to this address from ${new Date(r.pending.activatesAtMs!).toUTCString()}.` });
  });

  app.get("/auth/account-security/cancel-destination", async (_req, reply) =>
    reply.header("cache-control", "no-store").type("text/html").send(
      linkPage({ title: "Cancel payout address", heading: "Cancel the new payout address", sub: "This cancels the change and signs out every session on your account. Then reset your password and turn on two-factor authentication.", button: "Cancel the change and sign out everywhere", action: "/auth/account-security/cancel-destination", danger: true })
    )
  );

  app.post("/auth/account-security/cancel-destination", async (req, reply) => {
    if (!d.store || !d.security) return reply.code(503).send({ error: "portal_database_not_configured" });
    const parsed = tokenBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "link_invalid" });
    const r = await d.security.cancelDestinationByToken(parsed.data.token);
    if (!r) return reply.code(400).send({ error: "link_invalid", detail: "Nothing to cancel: the change was already cancelled, or replaced by a newer one." });
    await d.store.deleteSessionsForUser(r.userId);
    req.log.warn({ userId: r.userId }, "payout_destination_cancelled_by_link");
    return reply.send({ ok: true, message: "Cancelled. The new address will not be paid, and every session was signed out. Reset your password now (Forgot password on the sign-in page)." });
  });

  app.get("/auth/account-security/lock", async (_req, reply) =>
    reply.header("cache-control", "no-store").type("text/html").send(
      linkPage({ title: "Lock account", heading: "Lock your EdgeCoder account", sub: "Payouts are paused and every session is signed out. An EdgeCoder admin unlocks it after checking with you.", button: "Lock my account", action: "/auth/account-security/lock", danger: true })
    )
  );

  app.post("/auth/account-security/lock", async (req, reply) => {
    if (!d.store || !d.security) return reply.code(503).send({ error: "portal_database_not_configured" });
    const parsed = tokenBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "link_invalid" });
    const userId = await d.security.lockByToken(parsed.data.token);
    if (!userId) return reply.code(400).send({ error: "link_invalid", detail: "This link has expired. Sign in and change your password, or contact support." });
    await d.store.deleteSessionsForUser(userId);
    await Promise.resolve(d.pausePayouts(userId)).catch((e) => req.log.error({ error: String(e), userId }, "account_lock_pause_payouts_failed"));
    const user = await d.store.getUserById(userId);
    if (user) await d.sendAccountLocked({ email: user.email }).catch(() => undefined);
    req.log.warn({ userId }, "account_locked_by_link");
    return reply.send({ ok: true, message: "Your account is locked: payouts are paused and every session was signed out. Reset your password, then contact support to unlock it." });
  });

  // ── Admin: locked accounts ──

  async function systemAdmin(req: FastifyRequest, reply: FastifyReply) {
    const a = await signedIn(req, reply);
    if (!a) return null;
    if (!(await d.buildAccessContext(a.user)).isSystemAdmin) {
      reply.code(403).send({ error: "admin_only" });
      return null;
    }
    return a;
  }

  app.get("/portal/api/admin/security/locked", async (req, reply) => {
    const a = await systemAdmin(req, reply);
    if (!a) return reply;
    const locked = await a.security.listLocked();
    const users = await Promise.all(locked.map((l) => a.store.getUserById(l.userId).catch(() => null)));
    return reply.send({ accounts: locked.map((l, i) => ({ ...l, email: users[i]?.email ?? null })) });
  });

  app.post("/portal/api/admin/security/:userId/unlock", async (req, reply) => {
    const a = await systemAdmin(req, reply);
    if (!a) return reply;
    const { userId } = z.object({ userId: z.string().min(1).max(128) }).parse(req.params);
    if (!(await a.security.unlock(userId, a.user.email))) return reply.code(409).send({ error: "account_not_locked" });
    await Promise.resolve(d.resumePayouts(userId)).catch((e) => req.log.error({ error: String(e), userId }, "account_unlock_resume_payouts_failed"));
    await a.store.appendAdminAudit?.({ actorUserId: a.user.userId, actorEmail: a.user.email, action: "account.unlock", targetUserId: userId, targetEmailHint: null, detail: {} }).catch(() => undefined);
    req.log.warn({ userId, by: a.user.userId }, "account_unlocked");
    return reply.send({ ok: true, userId });
  });
}
