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

/**
 * `MESH_PEER_ALLOWLIST=coord-a:<sha256hex>@https://a.example,coord-b:<sha256hex>`
 * The optional `@url` pins the peer's endpoint (#118 review). Without a pin the endpoint can only
 * come from bootstrap discovery (the URL we fetched the identity from); gossip never sets one.
 */
export type PeerUrlPins = Map<string, string>;

const ALLOWLIST_ENTRY_RE = /^([^:@]+):([^:@]+)(?:@(\S+))?$/;

function parseEntries(raw: string | undefined): Array<{ peerId: string; fp: string; url?: string }> {
  const out: Array<{ peerId: string; fp: string; url?: string }> = [];
  const seen = new Set<string>();
  for (const item of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = ALLOWLIST_ENTRY_RE.exec(item);
    if (!m) throw new Error(`MESH_PEER_ALLOWLIST: bad entry "${item}" (want peerId:sha256hex[@url])`);
    const [, peerId, fpRaw, urlRaw] = m;
    const fp = fpRaw.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fp)) throw new Error(`MESH_PEER_ALLOWLIST: bad fingerprint for "${peerId}"`);
    // #118 review: a later entry silently winning would hide a typo or a swapped key.
    if (seen.has(peerId)) throw new Error(`MESH_PEER_ALLOWLIST: duplicate peer id "${peerId}"`);
    seen.add(peerId);
    let url: string | undefined;
    if (urlRaw !== undefined) {
      const c = canonicalPeerUrl(urlRaw);
      if (!c) throw new Error(`MESH_PEER_ALLOWLIST: bad url for "${peerId}"`);
      url = c;
    }
    out.push({ peerId, fp, url });
  }
  return out;
}

export function parsePeerAllowlist(raw: string | undefined): PeerAllowlist {
  return new Map(parseEntries(raw).map((e) => [e.peerId, e.fp]));
}

export function parsePeerUrlPins(raw: string | undefined): PeerUrlPins {
  return new Map(parseEntries(raw).filter((e) => e.url).map((e) => [e.peerId, e.url!]));
}

/** http(s) origin + path without trailing slash, or null. */
export function canonicalPeerUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password || u.search || u.hash) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
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

export interface RegistrationFields {
  peerId: string;
  publicKeyPem: string;
  coordinatorUrl: string;
  networkMode?: string;
  role?: string;
}

export function registrationPayload(p: RegistrationFields & { issuedAtMs: number }): string {
  return [
    "edgecoder-peer-register-v2",
    p.peerId,
    p.coordinatorUrl,
    p.networkMode ?? "",
    p.role ?? "",
    p.issuedAtMs,
    createHash("sha256").update(p.publicKeyPem).digest("hex")
  ].join("\n");
}

export function signRegistration(
  p: RegistrationFields,
  privateKeyPem: string,
  nowMs = Date.now()
): { issuedAtMs: number; signature: string } {
  const issuedAtMs = nowMs;
  return { issuedAtMs, signature: signPayload(registrationPayload({ ...p, issuedAtMs }), privateKeyPem) };
}

export type TrustDecision = { ok: true; mode: "allowlist" | "legacy_token" } | { ok: false; code: 401 | 403 | 409; error: string };

/**
 * Decide whether a mesh-token registration is accepted.
 * - Allowlist configured: peerId + key must be allowlisted and the signature fresh and valid.
 * - No allowlist: rejected in production; accepted in dev (legacy shared-token behaviour).
 */
export function checkPeerRegistration(input: {
  body: RegistrationFields & { issuedAtMs?: number; signature?: string };
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

/** #118 review: allowlist enforcement is on whenever an allowlist is set, and always in production. */
export function allowlistEnforced(allowlist: PeerAllowlist, production: boolean): boolean {
  return allowlist.size > 0 || production;
}

export type PeerSource = "register" | "bootstrap" | "gossip";

/**
 * #118 review: the single admission rule for the peer table, used by every path that adds a
 * peer (registration, bootstrap discovery, peer_exchange gossip). Returns the peer to store,
 * with its endpoint resolved, or null when refused.
 *
 * Enforced (allowlist set, or production):
 * - Only an allowlisted (peerId, key) pair is admitted.
 * - The endpoint is pinned. It comes from the allowlist `@url` if set; otherwise from bootstrap
 *   (the URL we reached the peer on). Registration must match a pin when one exists. Gossip never
 *   sets an endpoint: it can only (re)admit a peer whose endpoint is pinned or already known.
 * - An existing entry is replaced only if it is a squatter (not allowlisted) or `authoritative`.
 * Not enforced (dev, no allowlist): legacy behaviour, first entry for an id wins.
 */
export function admitPeer<P extends { peerId: string; publicKeyPem: string; coordinatorUrl: string }>(input: {
  allowlist: PeerAllowlist;
  pins?: PeerUrlPins;
  production: boolean;
  peer: P;
  existing?: P;
  authoritative?: boolean;
  source?: PeerSource;
}): P | null {
  const { allowlist, peer, existing } = input;
  const source = input.source ?? (input.authoritative ? "register" : "gossip");
  if (!allowlistEnforced(allowlist, input.production)) return !existing || input.authoritative === true ? peer : null;
  if (!isAllowlistedKey(allowlist, peer.peerId, peer.publicKeyPem)) return null;
  const existingTrusted = !!existing && isAllowlistedKey(allowlist, existing.peerId, existing.publicKeyPem);
  if (existingTrusted && !input.authoritative) return null;
  const pin = input.pins?.get(peer.peerId);
  const claimed = canonicalPeerUrl(peer.coordinatorUrl);
  let url: string | null;
  if (pin) {
    // Registration/bootstrap that disagrees with the pin is refused; gossip just gets the pin.
    if (source !== "gossip" && claimed !== pin) return null;
    url = pin;
  } else if (source === "bootstrap") {
    url = claimed;
  } else if (source === "register") {
    // Unpinned: a registering peer may only confirm the endpoint bootstrap already found.
    url = existingTrusted && claimed === canonicalPeerUrl(existing!.coordinatorUrl) ? claimed : null;
  } else {
    url = null; // gossip never introduces an endpoint
  }
  if (!url) return null;
  return { ...peer, coordinatorUrl: url };
}

/** Seen-signature cache for forwarded results; entries expire with the signature skew window. */
export class ReplayCache {
  private seen = new Map<string, number>();
  constructor(private readonly ttlMs = 2 * PEER_SIGNATURE_MAX_SKEW_MS) {}
  /** True the first time `key` is seen within the TTL. */
  firstSeen(key: string, nowMs = Date.now()): boolean {
    for (const [k, exp] of this.seen) if (exp <= nowMs) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, nowMs + this.ttlMs);
    return true;
  }
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
  /** #118 review: rejects a captured forwarded result replayed within the skew window. */
  replay?: ReplayCache;
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
  if (input.replay && !input.replay.firstSeen(`${fromPeerId}:${ts}:${sig}`, input.nowMs)) {
    return { ok: false, code: 409, error: "peer_signature_replayed" };
  }
  return { ok: true, mode: "allowlist", fromPeerId };
}
