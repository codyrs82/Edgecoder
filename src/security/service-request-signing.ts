// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createHash, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { tryPublicKeyFingerprint } from "./key-fingerprint.js";

/*
 * Signed requests between the portal and coordinators, so neither side needs a shared secret.
 *
 * Portal -> coordinator (portalRequest*): the portal signs every call it makes to a coordinator
 * with its Ed25519 key (PORTAL_ACTION_SIGNING_KEY; coordinators hold the public key in
 * PORTAL_ACTION_VERIFY_KEYS). The signature covers:
 *   - the audience: the origin of the coordinator URL the portal called. Each coordinator accepts
 *     only its own origin(s), so a request one coordinator receives cannot be replayed to another;
 *   - the timestamp and a single-use nonce;
 *   - the method, the path with its query string, and the SHA-256 of the body bytes;
 *   - the account the call acts for (x-edgecoder-account, "" when none). Accounts named in the
 *     query string or the body are covered by the path and the body hash.
 *
 * Coordinator -> portal (coordinatorPortalRequest*): a coordinator signs its calls to the portal's
 * /internal routes with its own identity key (COORDINATOR_PRIVATE_KEY_PEM). The public key travels
 * with the request; the portal decides whether it trusts that key for that coordinator
 * (src/portal/coordinator-credentials.ts).
 *
 * The payloads start with distinct domain strings, and neither matches the peer request payload
 * (src/mesh/peer-trust.ts) or the portal action assertion (src/security/portal-action.ts), so a
 * signature made for one purpose is never valid for another, even where a key is shared.
 */

export const SERVICE_REQUEST_MAX_SKEW_MS = 2 * 60_000;

export const PORTAL_REQUEST_HEADERS = {
  aud: "x-portal-aud",
  ts: "x-portal-ts",
  nonce: "x-portal-nonce",
  body: "x-portal-body-sha256",
  sig: "x-portal-signature"
} as const;

/** Whose view or account a portal call is for; covered by the portal's signature. */
export const PORTAL_ACCOUNT_HEADER = "x-edgecoder-account";

export const COORDINATOR_PORTAL_HEADERS = {
  id: "x-coord-id",
  ts: "x-coord-ts",
  nonce: "x-coord-nonce",
  body: "x-coord-body-sha256",
  key: "x-coord-key",
  sig: "x-coord-signature"
} as const;

export type SignedRequestRefusal = { ok: false; code: 401 | 403 | 409; error: string };

function headerString(headers: Record<string, unknown>, k: string): string | undefined {
  const v = headers[k];
  return typeof v === "string" ? v : Array.isArray(v) && v.length > 0 ? String(v[0]) : undefined;
}

export function sha256Hex(body: string | Buffer | null | undefined): string {
  return createHash("sha256").update(body ?? "").digest("hex");
}

/** The request target that is signed: path plus query string (what the receiver sees as req.url). */
export function requestTarget(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** The audience form of a URL: its origin (scheme, host, non-default port), lowercase. Null when not a URL. */
export function audienceOf(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin.toLowerCase();
  } catch {
    return null;
  }
}

// ---- portal -> coordinator ----

export function portalRequestPayload(p: { audience: string; issuedAtMs: number; nonce: string; method: string; path: string; bodySha256: string; account: string }): string {
  return ["edgecoder-portal-request-v1", p.audience, p.issuedAtMs, p.nonce, p.method.toUpperCase(), p.path, p.bodySha256.toLowerCase(), p.account].join("\n");
}

/** Headers that sign one portal call to a coordinator. Sign each attempt anew: the nonce is single-use. */
export function signPortalRequest(input: {
  key: KeyObject;
  /** The full coordinator URL called (its origin is the audience). */
  url: string;
  method: string;
  body?: string | Buffer | null;
  account?: string;
  nowMs?: number;
  nonce?: string;
}): Record<string, string> {
  const audience = audienceOf(input.url);
  if (!audience) throw new Error("signPortalRequest: url must be an absolute http(s) URL");
  const issuedAtMs = input.nowMs ?? Date.now();
  const nonce = input.nonce ?? randomUUID();
  const bodySha256 = sha256Hex(input.body);
  const payload = portalRequestPayload({ audience, issuedAtMs, nonce, method: input.method, path: requestTarget(input.url), bodySha256, account: input.account ?? "" });
  return {
    [PORTAL_REQUEST_HEADERS.aud]: audience,
    [PORTAL_REQUEST_HEADERS.ts]: String(issuedAtMs),
    [PORTAL_REQUEST_HEADERS.nonce]: nonce,
    [PORTAL_REQUEST_HEADERS.body]: bodySha256,
    [PORTAL_REQUEST_HEADERS.sig]: sign(null, Buffer.from(payload, "utf8"), input.key).toString("base64")
  };
}

export function hasPortalRequestSignature(headers: Record<string, unknown>): boolean {
  return headerString(headers, PORTAL_REQUEST_HEADERS.sig) !== undefined || headerString(headers, PORTAL_REQUEST_HEADERS.aud) !== undefined;
}

export type PortalRequestDecision = { ok: true; audience: string; nonce: string; issuedAtMs: number; account: string } | SignedRequestRefusal;

/**
 * Verify a portal-signed request. `audiences`: the origins this coordinator answers on (null: any,
 * for development without a public URL). Without `rawBody` only the headers are checked (the
 * transport gate, before the body is read); with it the declared body hash must match the bytes
 * received. `replay` is consulted last, after the signature verified, so a forged request cannot
 * burn a nonce.
 */
export async function verifyPortalRequest(input: {
  headers: Record<string, unknown>;
  method: string;
  /** Path plus query string, as received (req.url). */
  path: string;
  rawBody?: string | Buffer | null;
  keys: readonly KeyObject[];
  audiences: ReadonlySet<string> | null;
  replay?: (nonce: string, issuedAtMs: number) => boolean | Promise<boolean>;
  nowMs?: number;
}): Promise<PortalRequestDecision> {
  const h = (k: string) => headerString(input.headers, k);
  const audience = h(PORTAL_REQUEST_HEADERS.aud);
  const issuedAtMs = Number(h(PORTAL_REQUEST_HEADERS.ts));
  const nonce = h(PORTAL_REQUEST_HEADERS.nonce);
  const bodySha256 = h(PORTAL_REQUEST_HEADERS.body);
  const sig = h(PORTAL_REQUEST_HEADERS.sig);
  if (!audience || !nonce || !bodySha256 || !sig || !Number.isFinite(issuedAtMs)) return { ok: false, code: 401, error: "portal_signature_required" };
  if (input.keys.length === 0) return { ok: false, code: 401, error: "portal_keys_not_configured" };
  if (input.audiences && !input.audiences.has(audience.toLowerCase())) return { ok: false, code: 401, error: "portal_audience_mismatch" };
  if (Math.abs((input.nowMs ?? Date.now()) - issuedAtMs) > SERVICE_REQUEST_MAX_SKEW_MS) return { ok: false, code: 401, error: "portal_signature_stale" };
  const account = h(PORTAL_ACCOUNT_HEADER) ?? "";
  const payload = Buffer.from(portalRequestPayload({ audience, issuedAtMs, nonce, method: input.method, path: input.path, bodySha256, account }), "utf8");
  const signature = Buffer.from(sig, "base64");
  const good = input.keys.some((k) => {
    try {
      return verify(null, payload, k, signature);
    } catch {
      return false;
    }
  });
  if (!good) return { ok: false, code: 401, error: "portal_signature_invalid" };
  if (input.rawBody !== undefined && sha256Hex(input.rawBody) !== bodySha256.toLowerCase()) return { ok: false, code: 401, error: "portal_body_mismatch" };
  if (input.replay && !(await input.replay(nonce, issuedAtMs))) return { ok: false, code: 409, error: "portal_signature_replayed" };
  return { ok: true, audience, nonce, issuedAtMs, account };
}

// ---- coordinator -> portal ----

export function coordinatorPortalPayload(p: { coordinatorId: string; issuedAtMs: number; nonce: string; method: string; path: string; bodySha256: string }): string {
  return ["edgecoder-coordinator-portal-request-v1", p.coordinatorId, p.issuedAtMs, p.nonce, p.method.toUpperCase(), p.path, p.bodySha256.toLowerCase()].join("\n");
}

/** Headers that sign one coordinator call to the portal. Sign each attempt anew: the nonce is single-use. */
export function signCoordinatorPortalRequest(input: {
  coordinatorId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  method: string;
  url: string;
  body?: string | Buffer | null;
  nowMs?: number;
  nonce?: string;
}): Record<string, string> {
  const issuedAtMs = input.nowMs ?? Date.now();
  const nonce = input.nonce ?? randomUUID();
  const bodySha256 = sha256Hex(input.body);
  const payload = coordinatorPortalPayload({ coordinatorId: input.coordinatorId, issuedAtMs, nonce, method: input.method, path: requestTarget(input.url), bodySha256 });
  return {
    [COORDINATOR_PORTAL_HEADERS.id]: input.coordinatorId,
    [COORDINATOR_PORTAL_HEADERS.ts]: String(issuedAtMs),
    [COORDINATOR_PORTAL_HEADERS.nonce]: nonce,
    [COORDINATOR_PORTAL_HEADERS.body]: bodySha256,
    [COORDINATOR_PORTAL_HEADERS.key]: Buffer.from(input.publicKeyPem, "utf8").toString("base64"),
    [COORDINATOR_PORTAL_HEADERS.sig]: sign(null, Buffer.from(payload, "utf8"), input.privateKeyPem).toString("base64")
  };
}

export function hasCoordinatorPortalSignature(headers: Record<string, unknown>): boolean {
  return headerString(headers, COORDINATOR_PORTAL_HEADERS.sig) !== undefined || headerString(headers, COORDINATOR_PORTAL_HEADERS.id) !== undefined;
}

export type CoordinatorSignatureDecision =
  | { ok: true; coordinatorId: string; publicKeyPem: string; fingerprint: string; nonce: string; issuedAtMs: number }
  | SignedRequestRefusal;

/**
 * Check a coordinator's signature on its own terms: the presented key signed this request, inside
 * the skew window, and (with `rawBody`) over the bytes received. Whether that key is trusted for that
 * coordinator, and the nonce, are the caller's decision.
 */
export function verifyCoordinatorPortalSignature(input: {
  headers: Record<string, unknown>;
  method: string;
  path: string;
  rawBody?: string | Buffer | null;
  nowMs?: number;
}): CoordinatorSignatureDecision {
  const h = (k: string) => headerString(input.headers, k);
  const coordinatorId = h(COORDINATOR_PORTAL_HEADERS.id)?.trim();
  const issuedAtMs = Number(h(COORDINATOR_PORTAL_HEADERS.ts));
  const nonce = h(COORDINATOR_PORTAL_HEADERS.nonce);
  const bodySha256 = h(COORDINATOR_PORTAL_HEADERS.body);
  const keyB64 = h(COORDINATOR_PORTAL_HEADERS.key);
  const sig = h(COORDINATOR_PORTAL_HEADERS.sig);
  if (!coordinatorId || !nonce || !bodySha256 || !keyB64 || !sig || !Number.isFinite(issuedAtMs)) return { ok: false, code: 401, error: "coordinator_signature_required" };
  if (Math.abs((input.nowMs ?? Date.now()) - issuedAtMs) > SERVICE_REQUEST_MAX_SKEW_MS) return { ok: false, code: 401, error: "coordinator_signature_stale" };
  const publicKeyPem = Buffer.from(keyB64, "base64").toString("utf8");
  const fingerprint = tryPublicKeyFingerprint(publicKeyPem);
  if (!fingerprint) return { ok: false, code: 401, error: "coordinator_signature_invalid" };
  let good = false;
  try {
    good = verify(null, Buffer.from(coordinatorPortalPayload({ coordinatorId, issuedAtMs, nonce, method: input.method, path: input.path, bodySha256 }), "utf8"), publicKeyPem, Buffer.from(sig, "base64"));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, code: 401, error: "coordinator_signature_invalid" };
  if (input.rawBody !== undefined && sha256Hex(input.rawBody) !== bodySha256.toLowerCase()) return { ok: false, code: 401, error: "coordinator_body_mismatch" };
  return { ok: true, coordinatorId, publicKeyPem, fingerprint, nonce, issuedAtMs };
}
