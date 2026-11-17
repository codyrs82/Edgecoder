// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createHash, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { parseQueueDataKey, QueueDataCodec } from "../db/queue-data-codec.js";
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, otpauthUri, verifyTotp, base32Encode } from "./totp.js";

/*
 * Account security for the portal: what keeps a taken-over session (or a stolen password) from
 * turning into stolen sats. docs/security/account-security.md has the user-facing description.
 *
 * - Two-factor authentication: TOTP (authenticator app) with single-use recovery codes, or a
 *   passkey. With 2FA on, withdrawals, payout destination changes, API key creation and admin
 *   actions need a second factor: a code with the request, or a step-up made in this session in
 *   the last few minutes. System admins must enable it (a grace period, then admin actions stop).
 * - Payout destinations: adding or changing one needs a link sent to the account's email (or the
 *   code in that email), then waits out a cooling-off period before payouts go there. During the
 *   cooling-off a notice with a one-click cancel link is sent, manual withdrawals are refused, and
 *   the old destination keeps receiving automatic payouts.
 * - Lock: every withdrawal receipt carries a "not you? lock your account" link. A lock pauses
 *   payouts for the account and signs out every session; only an admin can unlock.
 *
 * Storage needs no migration: one JSON row per account in portal_onboarding, keyed
 * `acctsec:<userId>`, written with an optimistic version check. TOTP secrets are encrypted at
 * rest (AES-256-GCM, the queue-data codec) with PORTAL_2FA_KEY, or a key derived from
 * OAUTH_STATE_SECRET (HKDF, its own label) when that is not set.
 */

export const SECURITY_KEY_PREFIX = "acctsec:";
export const securityKey = (userId: string) => `${SECURITY_KEY_PREFIX}${userId}`;

export interface AccountSecurityStore {
  getKeyedRow(key: string): Promise<{ state: unknown; version: number } | null>;
  compareAndSetKeyedRow(key: string, expectedVersion: number | null, state: unknown, nowMs: number): Promise<number | null>;
  listKeyedRows(prefix: string, limit?: number): Promise<Array<{ key: string; state: unknown; version: number }>>;
}

export type PendingDestination = {
  id: string;
  kind: string;
  destination: string;
  network: string;
  /** The account had no destination before: the shorter first cooling-off applies. */
  first: boolean;
  createdAtMs: number;
  confirmTokenHash: string;
  codeHash: string;
  confirmExpiresAtMs: number;
  confirmedAtMs?: number;
  activatesAtMs?: number;
  cancelTokenHash?: string;
};

export type AccountSecurityState = {
  v: 1;
  twoFactor: {
    totp?: { secretEnc: string; enabledAtMs: number; lastUsedStep?: number };
    pendingTotp?: { secretEnc: string; createdAtMs: number };
    recovery?: Array<{ hash: string; usedAtMs?: number }>;
    stepUps?: Array<{ sessionHash: string; expiresAtMs: number }>;
    failures?: { count: number; sinceMs: number };
    /** First time this account was seen as a system admin without 2FA (the grace period starts here). */
    adminGraceStartedAtMs?: number;
  };
  payout?: PendingDestination;
  /** The cancel link of a destination change stays valid after it activates (for the cooling-off it covered). */
  cancelled?: Array<{ id: string; atMs: number }>;
  lock?: { lockedAtMs: number; source: "receipt_link" | "admin" };
  lastUnlock?: { atMs: number; by: string };
  lockTokens?: Array<{ hash: string; expiresAtMs: number }>;
};

export type SecondFactorMethod = "totp" | "recovery_code" | "passkey";

export interface AccountSecurityConfig {
  store: AccountSecurityStore;
  codec: QueueDataCodec;
  now?: () => number;
  /** Cooling-off after a confirmed change of an existing destination (PAYOUT_DEST_COOLDOWN_HOURS). */
  cooldownMs: number;
  /** Cooling-off for an account's first destination (PAYOUT_DEST_FIRST_COOLDOWN_HOURS). */
  firstCooldownMs: number;
  /** How long the emailed confirmation link and code work (PAYOUT_DEST_CONFIRM_TTL_MINUTES). */
  confirmTtlMs: number;
  /** How long a step-up (a second factor given in this session) covers protected actions. */
  stepUpTtlMs: number;
  /** System admins without 2FA: how long admin actions keep working (ADMIN_2FA_GRACE_DAYS). */
  adminGraceMs: number;
  /** Lock links in withdrawal receipts work this long. */
  lockLinkTtlMs?: number;
  issuer?: string;
}

/** Failed second-factor attempts allowed per window before verification pauses. */
export const MAX_2FA_FAILURES = 5;
export const TWO_FACTOR_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_STEP_UPS = 10;
const MAX_LOCK_TOKENS = 25;
const DEFAULT_LOCK_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Link tokens carry the account so the row can be found without an index: `<base64url userId>.<random>`. */
function newLinkToken(userId: string): string {
  return `${Buffer.from(userId, "utf8").toString("base64url")}.${randomBytes(32).toString("base64url")}`;
}
export function userIdFromLinkToken(token: string): string | null {
  const m = /^([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{40,60})$/.exec(token.trim());
  if (!m) return null;
  const userId = Buffer.from(m[1], "base64url").toString("utf8");
  return userId && /^[\x21-\x7e]{1,128}$/.test(userId) ? userId : null;
}
const tokenHash = (token: string) => sha256(`edgecoder-link:${token.trim()}`);

/** The 2FA encryption key: PORTAL_2FA_KEY, else derived from OAUTH_STATE_SECRET; both decrypt. None: 2FA cannot be enrolled. */
export function twoFactorCodecFromEnv(env: { PORTAL_2FA_KEY?: string; OAUTH_STATE_SECRET?: string }): QueueDataCodec {
  const keys: Buffer[] = [];
  if (env.PORTAL_2FA_KEY) keys.push(parseQueueDataKey(env.PORTAL_2FA_KEY));
  if (env.OAUTH_STATE_SECRET) keys.push(Buffer.from(hkdfSync("sha256", Buffer.from(env.OAUTH_STATE_SECRET, "utf8"), "edgecoder-portal-2fa", "edgecoder-portal-2fa/v1", 32)));
  return new QueueDataCodec(keys);
}

export const emptySecurityState = (): AccountSecurityState => ({ v: 1, twoFactor: {} });

function normalize(raw: unknown): AccountSecurityState {
  if (!raw || typeof raw !== "object" || (raw as { v?: unknown }).v !== 1) return emptySecurityState();
  const s = raw as AccountSecurityState;
  return { ...s, twoFactor: s.twoFactor && typeof s.twoFactor === "object" ? s.twoFactor : {} };
}

export type SecondFactorCheck =
  | { ok: true; via: "not_enabled" | "step_up" | SecondFactorMethod }
  | { ok: false; status: 401 | 403 | 429; body: { error: string; detail: string; methods?: SecondFactorMethod[] } };

export type DestinationRequest = { id: string; token: string; code: string; expiresAtMs: number };

export class AccountSecurity {
  readonly now: () => number;
  private readonly lockTtlMs: number;
  constructor(readonly cfg: AccountSecurityConfig) {
    this.now = cfg.now ?? Date.now;
    this.lockTtlMs = cfg.lockLinkTtlMs ?? DEFAULT_LOCK_LINK_TTL_MS;
  }

  get encryptionConfigured(): boolean {
    return this.cfg.codec.enabled;
  }

  async load(userId: string): Promise<AccountSecurityState> {
    const row = await this.cfg.store.getKeyedRow(securityKey(userId));
    return normalize(row?.state);
  }

  /**
   * Read-modify-write with the optimistic version check, retried on a conflict. `fn` returns the
   * result and whether to write; it may run more than once, so it must not have side effects.
   */
  async update<T>(userId: string, fn: (s: AccountSecurityState) => { write: boolean; result: T }): Promise<T> {
    const key = securityKey(userId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await this.cfg.store.getKeyedRow(key);
      const state = normalize(row ? structuredClone(row.state) : null);
      const { write, result } = fn(state);
      if (!write) return result;
      const v = await this.cfg.store.compareAndSetKeyedRow(key, row ? row.version : null, state, this.now());
      if (v !== null) return result;
    }
    throw new Error("account_security_write_conflict");
  }

  // ── Two-factor authentication ──

  /** 2FA is on when TOTP is enabled or the account has a passkey (a passkey counts as a second factor). */
  methods(state: AccountSecurityState, passkeyCount: number): SecondFactorMethod[] {
    const m: SecondFactorMethod[] = [];
    if (state.twoFactor.totp) m.push("totp");
    if (state.twoFactor.totp && (state.twoFactor.recovery ?? []).some((c) => !c.usedAtMs)) m.push("recovery_code");
    if (passkeyCount > 0) m.push("passkey");
    return m;
  }

  status(state: AccountSecurityState, passkeyCount: number, sessionHash?: string | null) {
    const now = this.now();
    const methods = this.methods(state, passkeyCount);
    const stepUp = sessionHash ? (state.twoFactor.stepUps ?? []).find((s) => s.sessionHash === sessionHash && s.expiresAtMs > now) : undefined;
    return {
      enabled: methods.length > 0,
      totpEnabled: Boolean(state.twoFactor.totp),
      totpEnabledAtMs: state.twoFactor.totp?.enabledAtMs ?? null,
      passkeys: passkeyCount,
      recoveryCodesRemaining: (state.twoFactor.recovery ?? []).filter((c) => !c.usedAtMs).length,
      methods,
      stepUpActiveUntilMs: stepUp?.expiresAtMs ?? null,
      encryptionConfigured: this.encryptionConfigured
    };
  }

  /** Starts TOTP enrolment: a new secret, kept encrypted until a code from it confirms. */
  async startTotp(userId: string, accountLabel: string): Promise<{ ok: true; secret: string; otpauthUri: string } | { ok: false; error: string }> {
    if (!this.encryptionConfigured) return { ok: false, error: "two_factor_key_not_configured" };
    const secret = generateTotpSecret();
    const secretEnc = this.cfg.codec.encodeText(secret.toString("base64"), `totp:${userId}`);
    const r = await this.update(userId, (s) => {
      if (s.twoFactor.totp) return { write: false, result: "already" as const };
      s.twoFactor.pendingTotp = { secretEnc, createdAtMs: this.now() };
      return { write: true, result: "ok" as const };
    });
    if (r === "already") return { ok: false, error: "totp_already_enabled" };
    return { ok: true, secret: base32Encode(secret), otpauthUri: otpauthUri({ secret, account: accountLabel, issuer: this.cfg.issuer ?? "EdgeCoder" }) };
  }

  private secretOf(userId: string, enc: string): Buffer {
    return Buffer.from(this.cfg.codec.decodeText(enc, `totp:${userId}`), "base64");
  }

  /** Confirms enrolment with a code from the new secret; returns the recovery codes (shown once). */
  async enableTotp(userId: string, code: string): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; error: string }> {
    const codes = generateRecoveryCodes();
    const now = this.now();
    type R = { ok: true; recoveryCodes: string[] } | { ok: false; error: string };
    return this.update<R>(userId, (s) => {
      if (s.twoFactor.totp) return { write: false, result: { ok: false as const, error: "totp_already_enabled" } };
      const pending = s.twoFactor.pendingTotp;
      if (!pending || now - pending.createdAtMs > 30 * 60 * 1000) return { write: false, result: { ok: false as const, error: "totp_setup_expired" } };
      const step = verifyTotp(this.secretOf(userId, pending.secretEnc), code, now, { window: 1 });
      if (step === null) return { write: false, result: { ok: false as const, error: "totp_code_invalid" } };
      s.twoFactor.totp = { secretEnc: pending.secretEnc, enabledAtMs: now, lastUsedStep: step };
      delete s.twoFactor.pendingTotp;
      s.twoFactor.recovery = codes.map((c) => ({ hash: hashRecoveryCode(c) }));
      s.twoFactor.failures = undefined;
      return { write: true, result: { ok: true as const, recoveryCodes: codes } };
    });
  }

  /**
   * Checks a TOTP or recovery code and, when it is right, uses it up (a TOTP step or recovery code
   * works once) and grants this session a step-up. Failures count; after MAX_2FA_FAILURES in the
   * window, verification pauses (429) so codes cannot be guessed.
   */
  async verifyCode(userId: string, code: string, sessionHash: string | null): Promise<{ ok: true; via: "totp" | "recovery_code" } | { ok: false; error: "two_factor_code_invalid" | "two_factor_rate_limited" | "two_factor_not_enabled" }> {
    const now = this.now();
    type R = { ok: true; via: "totp" | "recovery_code" } | { ok: false; error: "two_factor_code_invalid" | "two_factor_rate_limited" | "two_factor_not_enabled" };
    return this.update<R>(userId, (s) => {
      const tf = s.twoFactor;
      if (!tf.totp) return { write: false, result: { ok: false as const, error: "two_factor_not_enabled" as const } };
      const failures = tf.failures && now - tf.failures.sinceMs < TWO_FACTOR_FAILURE_WINDOW_MS ? tf.failures : { count: 0, sinceMs: now };
      if (failures.count >= MAX_2FA_FAILURES) return { write: false, result: { ok: false as const, error: "two_factor_rate_limited" as const } };
      const trimmed = code.trim();
      let via: "totp" | "recovery_code" | null = null;
      if (/^\d{6}$/.test(trimmed.replace(/\s/g, ""))) {
        const step = verifyTotp(this.secretOf(userId, tf.totp.secretEnc), trimmed, now, { window: 1, lastUsedStep: tf.totp.lastUsedStep });
        if (step !== null) {
          tf.totp.lastUsedStep = step;
          via = "totp";
        }
      } else {
        const h = hashRecoveryCode(trimmed);
        const rc = (tf.recovery ?? []).find((c) => !c.usedAtMs && eq(c.hash, h));
        if (rc) {
          rc.usedAtMs = now;
          via = "recovery_code";
        }
      }
      if (!via) {
        tf.failures = { count: failures.count + 1, sinceMs: failures.sinceMs };
        return { write: true, result: { ok: false as const, error: "two_factor_code_invalid" as const } };
      }
      tf.failures = undefined;
      if (sessionHash) this.addStepUp(s, sessionHash, now);
      return { write: true, result: { ok: true as const, via } };
    });
  }

  private addStepUp(s: AccountSecurityState, sessionHash: string, now: number): void {
    const live = (s.twoFactor.stepUps ?? []).filter((x) => x.expiresAtMs > now && x.sessionHash !== sessionHash);
    live.push({ sessionHash, expiresAtMs: now + this.cfg.stepUpTtlMs });
    s.twoFactor.stepUps = live.slice(-MAX_STEP_UPS);
  }

  /** A passkey assertion was verified for this account in this session (routes/account-security.ts). */
  async grantStepUp(userId: string, sessionHash: string): Promise<void> {
    const now = this.now();
    await this.update(userId, (s) => {
      this.addStepUp(s, sessionHash, now);
      return { write: true, result: undefined };
    });
  }

  /** Turning TOTP off needs a valid code (or recovery code); the codes go with it. */
  async disableTotp(userId: string, code: string, sessionHash: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
    const v = await this.verifyCode(userId, code, sessionHash);
    if (!v.ok) return v;
    await this.update(userId, (s) => {
      delete s.twoFactor.totp;
      delete s.twoFactor.pendingTotp;
      delete s.twoFactor.recovery;
      return { write: true, result: undefined };
    });
    return { ok: true };
  }

  async regenerateRecoveryCodes(userId: string, code: string, sessionHash: string | null): Promise<{ ok: true; recoveryCodes: string[] } | { ok: false; error: string }> {
    const v = await this.verifyCode(userId, code, sessionHash);
    if (!v.ok) return v;
    const codes = generateRecoveryCodes();
    await this.update(userId, (s) => {
      s.twoFactor.recovery = codes.map((c) => ({ hash: hashRecoveryCode(c) }));
      return { write: true, result: undefined };
    });
    return { ok: true, recoveryCodes: codes };
  }

  /**
   * The gate in front of a protected action. Passes when the account has no second factor, when
   * this session stepped up recently, or when `code` (TOTP or recovery code) is right.
   */
  async requireSecondFactor(userId: string, input: { passkeyCount: number; sessionHash: string | null; code?: string | null }): Promise<SecondFactorCheck> {
    const state = await this.load(userId);
    const methods = this.methods(state, input.passkeyCount);
    if (methods.length === 0) return { ok: true, via: "not_enabled" };
    const now = this.now();
    if (input.sessionHash && (state.twoFactor.stepUps ?? []).some((x) => x.sessionHash === input.sessionHash && x.expiresAtMs > now)) return { ok: true, via: "step_up" };
    if (input.code && state.twoFactor.totp) {
      const v = await this.verifyCode(userId, input.code, input.sessionHash);
      if (v.ok) return { ok: true, via: v.via };
      if (v.error === "two_factor_rate_limited") return { ok: false, status: 429, body: { error: v.error, detail: "Too many wrong codes. Wait 15 minutes and try again.", methods } };
      return { ok: false, status: 401, body: { error: "two_factor_code_invalid", detail: "That code is not right. Use the current code from your authenticator app, or a recovery code.", methods } };
    }
    return {
      ok: false,
      status: 403,
      body: {
        error: "two_factor_required",
        detail: methods.includes("totp") ? "Enter the code from your authenticator app (or a recovery code) to continue." : "Confirm with your passkey to continue.",
        methods
      }
    };
  }

  /**
   * System admins must have 2FA. Without it they get ADMIN_2FA_GRACE_DAYS from the first time
   * they are seen (recorded here), then admin actions are refused until they enable it.
   */
  async adminRequirement(userId: string, enabled: boolean): Promise<{ required: true; enabled: boolean; graceEndsAtMs: number | null; enforced: boolean }> {
    if (enabled) return { required: true, enabled: true, graceEndsAtMs: null, enforced: false };
    const now = this.now();
    const started = await this.update(userId, (s) => {
      if (s.twoFactor.adminGraceStartedAtMs) return { write: false, result: s.twoFactor.adminGraceStartedAtMs };
      s.twoFactor.adminGraceStartedAtMs = now;
      return { write: true, result: now };
    }).catch(() => now);
    const graceEndsAtMs = (started || now) + this.cfg.adminGraceMs;
    return { required: true, enabled: false, graceEndsAtMs, enforced: now >= graceEndsAtMs };
  }

  // ── Payout destinations ──

  /** A confirmed change that has not activated yet: manual withdrawals wait for it. */
  coolingOff(state: AccountSecurityState): PendingDestination | null {
    const p = state.payout;
    return p && p.confirmedAtMs && p.activatesAtMs && p.activatesAtMs > this.now() ? p : null;
  }

  /** Records a requested destination (replacing any earlier request) and returns the emailed link token and code. */
  async requestDestination(userId: string, input: { kind: string; destination: string; network: string; first: boolean }): Promise<DestinationRequest> {
    const now = this.now();
    const token = newLinkToken(userId);
    const code = String(100000 + (randomBytes(4).readUInt32BE() % 900000));
    const id = randomUUID();
    const expiresAtMs = now + this.cfg.confirmTtlMs;
    await this.update(userId, (s) => {
      s.payout = { id, kind: input.kind, destination: input.destination, network: input.network, first: input.first, createdAtMs: now, confirmTokenHash: tokenHash(token), codeHash: sha256(`${id}:${code}`), confirmExpiresAtMs: expiresAtMs };
      return { write: true, result: undefined };
    });
    return { id, token, code, expiresAtMs };
  }

  private confirmIn(s: AccountSecurityState, check: (p: PendingDestination) => boolean, now: number, cancelToken: string) {
    const p = s.payout;
    if (!p || p.confirmedAtMs || p.confirmExpiresAtMs <= now || !check(p)) return null;
    p.confirmedAtMs = now;
    p.activatesAtMs = now + (p.first ? this.cfg.firstCooldownMs : this.cfg.cooldownMs);
    p.cancelTokenHash = tokenHash(cancelToken);
    // The token and code are used up.
    p.confirmTokenHash = "";
    p.codeHash = "";
    return { ...p };
  }

  /** The emailed link (single use, expires after confirmTtlMs). Starts the cooling-off; returns the cancel token for the notice. */
  async confirmDestinationByToken(token: string): Promise<{ userId: string; pending: PendingDestination; cancelToken: string } | null> {
    const userId = userIdFromLinkToken(token);
    if (!userId) return null;
    const now = this.now();
    const cancelToken = newLinkToken(userId);
    const h = tokenHash(token);
    const pending = await this.update(userId, (s) => {
      const r = this.confirmIn(s, (p) => Boolean(p.confirmTokenHash) && eq(p.confirmTokenHash, h), now, cancelToken);
      return { write: r !== null, result: r };
    });
    return pending ? { userId, pending, cancelToken } : null;
  }

  /** The code in the same email, typed in the signed-in session (older desktop and iOS builds). */
  async confirmDestinationByCode(userId: string, id: string, code: string, destination: string): Promise<{ pending: PendingDestination; cancelToken: string } | null> {
    const now = this.now();
    const cancelToken = newLinkToken(userId);
    const h = sha256(`${id}:${code.trim()}`);
    const pending = await this.update(userId, (s) => {
      const p = s.payout;
      if (p && !p.confirmedAtMs && p.id === id && p.destination !== destination) return { write: false, result: null };
      // A wrong code uses the request up, like the withdrawal codes.
      const r = this.confirmIn(s, (x) => x.id === id && Boolean(x.codeHash) && eq(x.codeHash, h), now, cancelToken);
      if (!r && p && p.id === id && !p.confirmedAtMs) {
        delete s.payout;
        return { write: true, result: null };
      }
      return { write: r !== null, result: r };
    });
    return pending ? { pending, cancelToken } : null;
  }

  /** The cancel link in the notice: drops the pending change (confirmed or not). Returns the account, or null when nothing was cancelled. */
  async cancelDestinationByToken(token: string): Promise<{ userId: string; pending: PendingDestination } | null> {
    const userId = userIdFromLinkToken(token);
    if (!userId) return null;
    const h = tokenHash(token);
    const now = this.now();
    const pending = await this.update(userId, (s) => {
      const p = s.payout;
      if (!p || !p.cancelTokenHash || !eq(p.cancelTokenHash, h)) return { write: false, result: null };
      delete s.payout;
      s.cancelled = [...(s.cancelled ?? []), { id: p.id, atMs: now }].slice(-10);
      return { write: true, result: p };
    });
    return pending ? { userId, pending } : null;
  }

  /** Signed-in cancel (Wallet page) of a pending or cooling-off change. */
  async cancelDestination(userId: string): Promise<PendingDestination | null> {
    const now = this.now();
    return this.update(userId, (s) => {
      const p = s.payout;
      if (!p) return { write: false, result: null };
      delete s.payout;
      s.cancelled = [...(s.cancelled ?? []), { id: p.id, atMs: now }].slice(-10);
      return { write: true, result: p };
    });
  }

  /**
   * Takes a change whose cooling-off is over (and the account is not locked) off the pending slot,
   * for the caller to save and register. Null when nothing is due.
   */
  async takeDueDestination(userId: string): Promise<PendingDestination | null> {
    const now = this.now();
    return this.update(userId, (s) => {
      const p = s.payout;
      if (!p || !p.confirmedAtMs || !p.activatesAtMs || p.activatesAtMs > now || s.lock) return { write: false, result: null };
      delete s.payout;
      return { write: true, result: p };
    });
  }

  /** Accounts with a pending destination change (the activation sweep). */
  async listPendingUserIds(): Promise<string[]> {
    const rows = await this.cfg.store.listKeyedRows(SECURITY_KEY_PREFIX);
    return rows.filter((r) => normalize(r.state).payout?.confirmedAtMs).map((r) => r.key.slice(SECURITY_KEY_PREFIX.length));
  }

  // ── Lock ──

  /** A lock link for a withdrawal receipt. */
  async issueLockToken(userId: string): Promise<string> {
    const token = newLinkToken(userId);
    const now = this.now();
    await this.update(userId, (s) => {
      s.lockTokens = [...(s.lockTokens ?? []).filter((t) => t.expiresAtMs > now), { hash: tokenHash(token), expiresAtMs: now + this.lockTtlMs }].slice(-MAX_LOCK_TOKENS);
      return { write: true, result: undefined };
    });
    return token;
  }

  /** The receipt's lock link. Returns the account when the token is valid (locking an already locked account is fine). */
  async lockByToken(token: string): Promise<string | null> {
    const userId = userIdFromLinkToken(token);
    if (!userId) return null;
    const h = tokenHash(token);
    const now = this.now();
    const ok = await this.update(userId, (s) => {
      if (!(s.lockTokens ?? []).some((t) => t.expiresAtMs > now && eq(t.hash, h))) return { write: false, result: false };
      s.lock = s.lock ?? { lockedAtMs: now, source: "receipt_link" };
      return { write: true, result: true };
    });
    return ok ? userId : null;
  }

  async lock(userId: string, source: "receipt_link" | "admin"): Promise<void> {
    const now = this.now();
    await this.update(userId, (s) => {
      s.lock = s.lock ?? { lockedAtMs: now, source };
      return { write: true, result: undefined };
    });
  }

  /** Admin unlock. Returns false when the account was not locked. */
  async unlock(userId: string, by: string): Promise<boolean> {
    const now = this.now();
    return this.update(userId, (s) => {
      if (!s.lock) return { write: false, result: false };
      delete s.lock;
      s.lastUnlock = { atMs: now, by };
      return { write: true, result: true };
    });
  }

  async listLocked(): Promise<Array<{ userId: string; lockedAtMs: number; source: string }>> {
    const rows = await this.cfg.store.listKeyedRows(SECURITY_KEY_PREFIX);
    return rows
      .map((r) => ({ userId: r.key.slice(SECURITY_KEY_PREFIX.length), lock: normalize(r.state).lock }))
      .filter((r) => r.lock)
      .map((r) => ({ userId: r.userId, lockedAtMs: r.lock!.lockedAtMs, source: r.lock!.source }));
  }
}

/** `lnbc25u1pj…q8x0` / `al…@getalby.com` / `bc1q…9k2f`: enough to recognise, not to copy. */
export function maskDestination(dest: string): string {
  const d = dest.trim();
  const at = d.indexOf("@");
  if (at > 0) return `${d.slice(0, Math.min(2, at))}…${d.slice(at)}`;
  if (d.length <= 14) return d;
  return `${d.slice(0, 10)}…${d.slice(-4)}`;
}
