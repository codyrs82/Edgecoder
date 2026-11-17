// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";

/*
 * Portal action assertions (docs/security/rotation.md, "Portal action signing key").
 *
 * The coordinators' money routes that move or redirect an account's funds (withdraw, payout
 * destination, callback confirmation) act for whatever accountId the caller names. The portal
 * service token alone proves only "a holder of the token": it is shared by several apps. So the
 * portal also signs, per request, what the logged-in user asked for:
 *
 *   { v: 1, accountId, action, digest: sha256(canonical action parameters), nonce, iat, exp }
 *
 * with an Ed25519 key only the portal holds (PORTAL_ACTION_SIGNING_KEY). Coordinators hold only
 * the public key(s) (PORTAL_ACTION_VERIFY_KEYS), so a coordinator's secrets cannot forge one.
 * The assertion travels in the `x-portal-action` header as base64url(payload JSON) "." base64url(sig).
 * It expires within MAX_ASSERTION_LIFETIME_MS and its nonce is accepted once (shared nonce store).
 */

export const PORTAL_ACTION_HEADER = "x-portal-action";
export const MAX_ASSERTION_LIFETIME_MS = 2 * 60_000;
export const DEFAULT_ASSERTION_TTL_MS = 60_000;
/** Clock skew tolerated on iat (a portal clock slightly ahead). */
export const ASSERTION_SKEW_MS = 30_000;

export type PortalAction = "payout.withdraw" | "payout.lightning_address" | "payout.onchain_address" | "payout.callback_confirm";

export interface PortalActionPayload {
  v: 1;
  accountId: string;
  action: PortalAction;
  digest: string;
  nonce: string;
  iat: number;
  exp: number;
}

/**
 * The parameters each action is bound to, normalized the same way on both sides (trimmed; an
 * empty destination is null). A different invoice (so a different amount) or a different
 * destination gives a different digest.
 */
export function actionParams(action: PortalAction, body: Record<string, unknown>): Record<string, string | null> {
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  switch (action) {
    case "payout.withdraw":
      return { bolt11: s(body.bolt11) };
    case "payout.lightning_address":
      return { lightningAddress: s(body.lightningAddress) };
    case "payout.onchain_address":
      return { address: s(body.address) };
    case "payout.callback_confirm":
      return { destination: s(body.destination), newOrigin: s(body.newOrigin) };
  }
}

export function actionDigest(action: PortalAction, body: Record<string, unknown>): string {
  const p = actionParams(action, body);
  const canonical = JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]));
  return createHash("sha256").update(`${action}\n${canonical}`).digest("hex");
}

const b64u = (b: Buffer) => b.toString("base64url");

// DER prefixes for raw 32-byte Ed25519 keys (PKCS#8 private, SPKI public).
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

function decodeKeyMaterial(raw: string): Buffer | string {
  const v = raw.trim();
  if (v.includes("-----BEGIN")) return v.replace(/\\n/g, "\n");
  return Buffer.from(v, /^[0-9a-f]{64}$/i.test(v) ? "hex" : "base64");
}

/** PORTAL_ACTION_SIGNING_KEY: PKCS#8 PEM, or the raw 32-byte seed as base64 / hex. */
export function parseSigningKey(raw: string): KeyObject {
  const m = decodeKeyMaterial(raw);
  const key = typeof m === "string" ? createPrivateKey(m) : m.length === 32 ? createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, m]), format: "der", type: "pkcs8" }) : createPrivateKey({ key: m, format: "der", type: "pkcs8" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("PORTAL_ACTION_SIGNING_KEY must be an Ed25519 key");
  return key;
}

/** One entry of PORTAL_ACTION_VERIFY_KEYS: SPKI PEM, or the raw 32-byte public key as base64 / hex. */
export function parseVerifyKey(raw: string): KeyObject {
  const m = decodeKeyMaterial(raw);
  const key = typeof m === "string" ? createPublicKey(m) : m.length === 32 ? createPublicKey({ key: Buffer.concat([SPKI_ED25519, m]), format: "der", type: "spki" }) : createPublicKey({ key: m, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("PORTAL_ACTION_VERIFY_KEYS entries must be Ed25519 public keys");
  return key;
}

/** Comma- or whitespace-separated list (PEM entries may contain neither commas nor be split on newlines inside). */
export function parseVerifyKeys(raw: string | undefined): KeyObject[] {
  const v = (raw ?? "").trim();
  if (!v) return [];
  const pems = v.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g);
  const entries = pems ?? v.split(/[,\s]+/).filter(Boolean);
  return entries.map(parseVerifyKey);
}

/** The raw public key (base64) for a signing key: what goes into PORTAL_ACTION_VERIFY_KEYS. */
export function publicKeyBase64(signingKey: KeyObject): string {
  const der = createPublicKey(signingKey).export({ format: "der", type: "spki" }) as Buffer;
  return der.subarray(SPKI_ED25519.length).toString("base64");
}

export function signPortalAction(
  key: KeyObject,
  input: { accountId: string; action: PortalAction; body: Record<string, unknown>; nowMs?: number; ttlMs?: number; nonce?: string }
): string {
  const now = input.nowMs ?? Date.now();
  const ttl = Math.min(input.ttlMs ?? DEFAULT_ASSERTION_TTL_MS, MAX_ASSERTION_LIFETIME_MS);
  const payload: PortalActionPayload = {
    v: 1,
    accountId: input.accountId,
    action: input.action,
    digest: actionDigest(input.action, input.body),
    nonce: input.nonce ?? b64u(randomBytes(18)),
    iat: now,
    exp: now + ttl
  };
  const body = Buffer.from(JSON.stringify(payload));
  return `${b64u(body)}.${b64u(sign(null, body, key))}`;
}

export type PortalActionRefusal =
  | "malformed"
  | "bad_signature"
  | "expired"
  | "not_yet_valid"
  | "lifetime_too_long"
  | "wrong_account"
  | "wrong_action"
  | "wrong_parameters"
  | "replayed";

/** Atomic "first use of this nonce" check; true when new. */
export type NonceOnce = (nonce: string, expiresAtMs: number) => Promise<boolean>;

export async function verifyPortalAction(
  header: string,
  expected: { accountId: string; action: PortalAction; body: Record<string, unknown> },
  ctx: { keys: KeyObject[]; nowMs?: number; nonceOnce: NonceOnce }
): Promise<{ ok: true; payload: PortalActionPayload } | { ok: false; reason: PortalActionRefusal }> {
  const now = ctx.nowMs ?? Date.now();
  const parts = header.trim().split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const body = Buffer.from(parts[0], "base64url");
  const sig = Buffer.from(parts[1], "base64url");
  if (sig.length !== 64) return { ok: false, reason: "malformed" };
  if (!ctx.keys.some((k) => {
    try {
      return verify(null, body, k, sig);
    } catch {
      return false;
    }
  })) return { ok: false, reason: "bad_signature" };
  let p: PortalActionPayload;
  try {
    p = JSON.parse(body.toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (p?.v !== 1 || typeof p.accountId !== "string" || typeof p.action !== "string" || typeof p.digest !== "string" || typeof p.nonce !== "string" || p.nonce.length < 16 || p.nonce.length > 128 || !Number.isFinite(p.iat) || !Number.isFinite(p.exp)) {
    return { ok: false, reason: "malformed" };
  }
  if (p.exp - p.iat > MAX_ASSERTION_LIFETIME_MS || p.exp < p.iat) return { ok: false, reason: "lifetime_too_long" };
  if (p.iat > now + ASSERTION_SKEW_MS) return { ok: false, reason: "not_yet_valid" };
  if (now > p.exp) return { ok: false, reason: "expired" };
  if (p.accountId !== expected.accountId) return { ok: false, reason: "wrong_account" };
  if (p.action !== expected.action) return { ok: false, reason: "wrong_action" };
  if (p.digest !== actionDigest(expected.action, expected.body)) return { ok: false, reason: "wrong_parameters" };
  // Last, so a refused assertion does not burn its nonce.
  if (!(await ctx.nonceOnce(`portal-action:${p.nonce}`, p.exp + ASSERTION_SKEW_MS))) return { ok: false, reason: "replayed" };
  return { ok: true, payload: p };
}
