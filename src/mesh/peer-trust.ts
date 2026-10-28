// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash, createPublicKey } from "node:crypto";
import { signPayload, verifyPayload } from "./peer.js";

/*
 * #52: coordinator-to-coordinator trust.
 *
 * The shared MESH_AUTH_TOKEN alone no longer makes a caller a trusted coordinator. Each
 * coordinator has an Ed25519 key (COORDINATOR_PRIVATE_KEY_PEM); operators list the peers they
 * trust in MESH_PEER_ALLOWLIST as `peerId:fingerprint` pairs, where fingerprint is the SHA-256
 * of the peer's SPKI public key (hex). A peer must prove it holds the key when it registers, and
 * results it forwards are signed with that key and checked at the origin.
 */

export type PeerAllowlist = Map<string, string>;

export const PEER_SIGNATURE_MAX_SKEW_MS = 5 * 60_000;

export function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

/** `MESH_PEER_ALLOWLIST=coord-a:<sha256hex>,coord-b:<sha256hex>` */
export function parsePeerAllowlist(raw: string | undefined): PeerAllowlist {
  const out: PeerAllowlist = new Map();
  for (const item of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = item.lastIndexOf(":");
    if (idx <= 0) throw new Error(`MESH_PEER_ALLOWLIST: bad entry "${item}" (want peerId:sha256hex)`);
    const peerId = item.slice(0, idx);
    const fp = item.slice(idx + 1).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fp)) throw new Error(`MESH_PEER_ALLOWLIST: bad fingerprint for "${peerId}"`);
    out.set(peerId, fp);
  }
  return out;
}

export function isAllowlistedKey(allowlist: PeerAllowlist, peerId: string, publicKeyPem: string): boolean {
  const want = allowlist.get(peerId);
  if (!want) return false;
  try {
    return publicKeyFingerprint(publicKeyPem) === want;
  } catch {
    return false;
  }
}

// ---- registration proof of possession ----

export function registrationPayload(p: { peerId: string; publicKeyPem: string; coordinatorUrl: string; issuedAtMs: number }): string {
  return ["edgecoder-peer-register-v1", p.peerId, p.coordinatorUrl, p.issuedAtMs, createHash("sha256").update(p.publicKeyPem).digest("hex")].join("\n");
}

export function signRegistration(
  p: { peerId: string; publicKeyPem: string; coordinatorUrl: string },
  privateKeyPem: string,
  nowMs = Date.now()
): { issuedAtMs: number; signature: string } {
  const issuedAtMs = nowMs;
  return { issuedAtMs, signature: signPayload(registrationPayload({ ...p, issuedAtMs }), privateKeyPem) };
}

export type TrustDecision = { ok: true; mode: "allowlist" | "legacy_token" } | { ok: false; code: 401 | 403; error: string };

/**
 * Decide whether a mesh-token registration is accepted.
 * - Allowlist configured: peerId + key must be allowlisted and the signature fresh and valid.
 * - No allowlist: rejected in production; accepted in dev (legacy shared-token behaviour).
 */
export function checkPeerRegistration(input: {
  body: { peerId: string; publicKeyPem: string; coordinatorUrl: string; issuedAtMs?: number; signature?: string };
  allowlist: PeerAllowlist;
  production: boolean;
  nowMs?: number;
}): TrustDecision {
  const { body, allowlist } = input;
  if (allowlist.size === 0) {
    return input.production ? { ok: false, code: 403, error: "peer_allowlist_required" } : { ok: true, mode: "legacy_token" };
  }
  if (!isAllowlistedKey(allowlist, body.peerId, body.publicKeyPem)) return { ok: false, code: 403, error: "peer_not_allowlisted" };
  const now = input.nowMs ?? Date.now();
  if (typeof body.issuedAtMs !== "number" || typeof body.signature !== "string") return { ok: false, code: 401, error: "peer_signature_required" };
  if (Math.abs(now - body.issuedAtMs) > PEER_SIGNATURE_MAX_SKEW_MS) return { ok: false, code: 401, error: "peer_signature_stale" };
  const payload = registrationPayload({ ...body, issuedAtMs: body.issuedAtMs });
  if (!verifyPayload(payload, body.signature, body.publicKeyPem)) return { ok: false, code: 401, error: "peer_signature_invalid" };
  return { ok: true, mode: "allowlist" };
}

// ---- forwarded results ----

export const FORWARD_HEADERS = { id: "x-coordinator-id", ts: "x-coordinator-ts", sig: "x-coordinator-signature" } as const;

export function forwardedResultPayload(fromPeerId: string, issuedAtMs: number, bodyJson: string): string {
  return ["edgecoder-forwarded-result-v1", fromPeerId, issuedAtMs, createHash("sha256").update(bodyJson).digest("hex")].join("\n");
}

export function signForwardedResult(fromPeerId: string, privateKeyPem: string, bodyJson: string, nowMs = Date.now()): Record<string, string> {
  return {
    [FORWARD_HEADERS.id]: fromPeerId,
    [FORWARD_HEADERS.ts]: String(nowMs),
    [FORWARD_HEADERS.sig]: signPayload(forwardedResultPayload(fromPeerId, nowMs, bodyJson), privateKeyPem)
  };
}

/**
 * Verify a peer-forwarded /result. `bodyJson` must be JSON.stringify of the parsed body (the
 * sender signs JSON.stringify of the same object, so key order matches). The sender's key must
 * be allowlisted. With no allowlist outside production the legacy token-only path is kept.
 */
export function verifyForwardedResult(input: {
  headers: Record<string, unknown>;
  bodyJson: string;
  allowlist: PeerAllowlist;
  production: boolean;
  publicKeyFor: (peerId: string) => string | null;
  nowMs?: number;
}): TrustDecision & { fromPeerId?: string } {
  const h = (k: string) => {
    const v = input.headers[k];
    return typeof v === "string" ? v : Array.isArray(v) ? String(v[0]) : undefined;
  };
  const fromPeerId = h(FORWARD_HEADERS.id);
  const ts = Number(h(FORWARD_HEADERS.ts));
  const sig = h(FORWARD_HEADERS.sig);
  if (input.allowlist.size === 0 && !input.production) return { ok: true, mode: "legacy_token" };
  if (input.allowlist.size === 0) return { ok: false, code: 403, error: "peer_allowlist_required" };
  if (!fromPeerId || !sig || !Number.isFinite(ts)) return { ok: false, code: 401, error: "peer_signature_required" };
  const key = input.publicKeyFor(fromPeerId);
  if (!key || !isAllowlistedKey(input.allowlist, fromPeerId, key)) return { ok: false, code: 403, error: "peer_not_allowlisted" };
  if (Math.abs((input.nowMs ?? Date.now()) - ts) > PEER_SIGNATURE_MAX_SKEW_MS) return { ok: false, code: 401, error: "peer_signature_stale" };
  if (!verifyPayload(forwardedResultPayload(fromPeerId, ts, input.bodyJson), sig, key)) {
    return { ok: false, code: 401, error: "peer_signature_invalid" };
  }
  return { ok: true, mode: "allowlist", fromPeerId };
}
