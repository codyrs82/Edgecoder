// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createHash, randomUUID } from "node:crypto";
import { fingerprintMatches } from "../security/key-fingerprint.js";
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

/** peerId -> allowlisted key fingerprints (one, or two while a key is being rotated). */
export type PeerAllowlist = Map<string, string[]>;

/** Most fingerprints one allowlist entry may list: the current key and the one replacing it. */
export const MAX_KEYS_PER_PEER = 2;

export const PEER_SIGNATURE_MAX_SKEW_MS = 5 * 60_000;

// The one fingerprint function (sha256 of SPKI DER), shared with agent pins and discovery.
export { publicKeyFingerprint } from "../security/key-fingerprint.js";

/**
 * `MESH_PEER_ALLOWLIST=coord-a:<sha256hex>@https://a.example,coord-b:<sha256hex>`
 * Key rotation: `coord-a:<new>+<old>@https://a.example` trusts both keys during the overlap.
 * The optional `@url` pins the peer's endpoint (#118 review). Without a pin the endpoint can only
 * come from bootstrap discovery (the URL we fetched the identity from); gossip never sets one.
 */
export type PeerUrlPins = Map<string, string>;

const ALLOWLIST_ENTRY_RE = /^([^:@]+):([^:@]+)(?:@(\S+))?$/;

function parseEntries(raw: string | undefined): Array<{ peerId: string; fps: string[]; url?: string }> {
  const out: Array<{ peerId: string; fps: string[]; url?: string }> = [];
  const seen = new Set<string>();
  for (const item of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = ALLOWLIST_ENTRY_RE.exec(item);
    if (!m) throw new Error(`MESH_PEER_ALLOWLIST: bad entry "${item}" (want peerId:sha256hex[+sha256hex][@url])`);
    const [, peerId, fpRaw, urlRaw] = m;
    const fps = fpRaw.toLowerCase().split("+");
    if (fps.some((fp) => !/^[0-9a-f]{64}$/.test(fp))) throw new Error(`MESH_PEER_ALLOWLIST: bad fingerprint for "${peerId}"`);
    if (fps.length > MAX_KEYS_PER_PEER) throw new Error(`MESH_PEER_ALLOWLIST: at most ${MAX_KEYS_PER_PEER} keys for "${peerId}"`);
    if (new Set(fps).size !== fps.length) throw new Error(`MESH_PEER_ALLOWLIST: repeated fingerprint for "${peerId}"`);
    // #118 review: a later entry silently winning would hide a typo or a swapped key.
    if (seen.has(peerId)) throw new Error(`MESH_PEER_ALLOWLIST: duplicate peer id "${peerId}"`);
    seen.add(peerId);
    let url: string | undefined;
    if (urlRaw !== undefined) {
      const c = canonicalPeerUrl(urlRaw);
      if (!c) throw new Error(`MESH_PEER_ALLOWLIST: bad url for "${peerId}"`);
      url = c;
    }
    out.push({ peerId, fps, url });
  }
  return out;
}

export function parsePeerAllowlist(raw: string | undefined): PeerAllowlist {
  return new Map(parseEntries(raw).map((e) => [e.peerId, e.fps]));
}

export function parsePeerUrlPins(raw: string | undefined): PeerUrlPins {
  return new Map(parseEntries(raw).filter((e) => e.url).map((e) => [e.peerId, e.url!]));
}

/**
 * #118 review (Edward): in production every allowlist entry must pin its URL (`@url`), so no peer
 * endpoint ever comes from discovery. Throws, listing the unpinned peer ids.
 */
export function assertUrlPinsForProduction(raw: string | undefined, production: boolean): void {
  if (!production) return;
  const missing = parseEntries(raw).filter((e) => !e.url).map((e) => e.peerId);
  if (missing.length) {
    throw new Error(`MESH_PEER_ALLOWLIST: production requires @url on every entry; missing for ${missing.join(", ")}`);
  }
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
  return want.some((fp) => fingerprintMatches(fp, publicKeyPem));
}

/**
 * Whether `publicKeyPem` is a key this coordinator trusts for coordinator `peerId`. Today that is
 * the static MESH_PEER_ALLOWLIST; `extra` is the hook for a second source (the signed coordinator
 * registry), so a peer is trusted if either source names its key.
 */
export type PeerKeyTrust = (peerId: string, publicKeyPem: string) => boolean;

export function peerKeyTrust(allowlist: PeerAllowlist, extra?: PeerKeyTrust): PeerKeyTrust {
  return (peerId, publicKeyPem) => isAllowlistedKey(allowlist, peerId, publicKeyPem) || (extra?.(peerId, publicKeyPem) ?? false);
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
 * Decide whether a peer registration (mesh token or signed peer request) is accepted.
 * - Allowlist configured: peerId + key must be allowlisted and the signature fresh and valid.
 * - No allowlist: rejected in production; accepted in dev (legacy shared-token behaviour).
 */
export function checkPeerRegistration(input: {
  body: RegistrationFields & { issuedAtMs?: number; signature?: string };
  allowlist: PeerAllowlist;
  production: boolean;
  /** Who is trusted (default: the allowlist alone); the hook for the signed registry. */
  trusted?: PeerKeyTrust;
  nowMs?: number;
}): TrustDecision {
  const { body, allowlist } = input;
  if (allowlist.size === 0) {
    return input.production ? { ok: false, code: 403, error: "peer_allowlist_required" } : { ok: true, mode: "legacy_token" };
  }
  const trusted = input.trusted ?? peerKeyTrust(allowlist);
  if (!trusted(body.peerId, body.publicKeyPem)) return { ok: false, code: 403, error: "peer_not_allowlisted" };
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

/**
 * Stress finding 6: bootstrap logged "peer not allowlisted" for a peer that was already admitted
 * (admitPeer answers null for a non-authoritative refresh of a trusted entry). What bootstrap's
 * addPeer outcome means: "admitted" (added or refreshed), "known" (refused only because the same
 * peer, same key, is already in the table: bootstrap goes on and re-registers with it, which keeps
 * the peer's table in step after it restarts) or "refused" (allowlist, key or URL pin).
 */
export function bootstrapAdmissionOutcome(
  admitted: boolean,
  existing: { peerId: string; publicKeyPem: string } | undefined,
  remote: { peerId: string; publicKeyPem: string }
): "admitted" | "known" | "refused" {
  if (admitted) return "admitted";
  if (existing && existing.peerId === remote.peerId && existing.publicKeyPem === remote.publicKeyPem) return "known";
  return "refused";
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
  const h = (k: string) => headerString(input.headers, k);
  const fromPeerId = h(FORWARD_HEADERS.id);
  const ts = Number(h(FORWARD_HEADERS.ts));
  const sig = h(FORWARD_HEADERS.sig);
  if (input.allowlist.size === 0 && !input.production) return { ok: true, mode: "legacy_token" };
  if (input.allowlist.size === 0) return { ok: false, code: 403, error: "peer_allowlist_required" };
  if (!fromPeerId || !sig || !Number.isFinite(ts)) return { ok: false, code: 401, error: "peer_signature_required" };
  const key = input.publicKeyFor(fromPeerId);
  const checked = checkPeerSignature({
    peerId: fromPeerId,
    publicKeyPem: key,
    issuedAtMs: ts,
    signature: sig,
    payload: forwardedResultPayload(fromPeerId, ts, input.bodyJson),
    trusted: peerKeyTrust(input.allowlist),
    nowMs: input.nowMs
  });
  if (!checked.ok) return checked;
  if (input.replay && !input.replay.firstSeen(`${fromPeerId}:${ts}:${sig}`, input.nowMs)) {
    return { ok: false, code: 409, error: "peer_signature_replayed" };
  }
  return { ok: true, mode: "allowlist", fromPeerId };
}

function headerString(headers: Record<string, unknown>, k: string): string | undefined {
  const v = headers[k];
  return typeof v === "string" ? v : Array.isArray(v) && v.length > 0 ? String(v[0]) : undefined;
}

/**
 * The checks every peer signature shares (forwarded results, signed peer requests): the key is one
 * this coordinator trusts for the peer, the timestamp is inside the skew window, and the Ed25519
 * signature over `payload` verifies with that key.
 */
function checkPeerSignature(input: {
  peerId: string;
  publicKeyPem: string | null | undefined;
  issuedAtMs: number;
  signature: string;
  payload: string;
  trusted: PeerKeyTrust;
  nowMs?: number;
}): { ok: true } | { ok: false; code: 401 | 403; error: string } {
  if (!input.publicKeyPem || !input.trusted(input.peerId, input.publicKeyPem)) return { ok: false, code: 403, error: "peer_not_allowlisted" };
  if (Math.abs((input.nowMs ?? Date.now()) - input.issuedAtMs) > PEER_SIGNATURE_MAX_SKEW_MS) return { ok: false, code: 401, error: "peer_signature_stale" };
  if (!verifyPayload(input.payload, input.signature, input.publicKeyPem)) return { ok: false, code: 401, error: "peer_signature_invalid" };
  return { ok: true };
}

// ---- signed peer requests (coordinator to coordinator, any peer route) ----

/*
 * A peer request is signed by the calling coordinator's own key (COORDINATOR_PRIVATE_KEY_PEM), so a
 * peer can be admitted by key instead of the shared MESH_AUTH_TOKEN. The signature covers the peer
 * id, timestamp, nonce, method, path (with query string) and the SHA-256 of the body bytes. The
 * caller's public key travels with the request (base64 of its PEM), and is trusted only if the
 * receiver's allowlist (or, later, the signed registry) names its fingerprint for that peer id.
 */
export const PEER_REQUEST_HEADERS = {
  id: "x-peer-id",
  ts: "x-peer-ts",
  nonce: "x-peer-nonce",
  body: "x-peer-body-sha256",
  key: "x-peer-key",
  sig: "x-peer-signature"
} as const;

export function peerRequestPayload(p: { peerId: string; issuedAtMs: number; nonce: string; method: string; path: string; bodySha256: string }): string {
  return ["edgecoder-peer-request-v1", p.peerId, p.issuedAtMs, p.nonce, p.method.toUpperCase(), p.path, p.bodySha256.toLowerCase()].join("\n");
}

function sha256Hex(body: string | Buffer | null | undefined): string {
  return createHash("sha256").update(body ?? "").digest("hex");
}

/** The request target a peer request signs: path plus query string, as the receiver sees it in req.url. */
export function peerRequestPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** Headers that sign one request to a peer. Sign each attempt anew: the nonce is single-use. */
export function signPeerRequest(input: {
  peerId: string;
  privateKeyPem: string;
  publicKeyPem: string;
  method: string;
  /** Full URL or path (with query string). */
  url: string;
  body?: string | Buffer | null;
  nowMs?: number;
  nonce?: string;
}): Record<string, string> {
  const issuedAtMs = input.nowMs ?? Date.now();
  const nonce = input.nonce ?? randomUUID();
  const bodySha256 = sha256Hex(input.body);
  const path = peerRequestPath(input.url);
  return {
    [PEER_REQUEST_HEADERS.id]: input.peerId,
    [PEER_REQUEST_HEADERS.ts]: String(issuedAtMs),
    [PEER_REQUEST_HEADERS.nonce]: nonce,
    [PEER_REQUEST_HEADERS.body]: bodySha256,
    [PEER_REQUEST_HEADERS.key]: Buffer.from(input.publicKeyPem, "utf8").toString("base64"),
    [PEER_REQUEST_HEADERS.sig]: signPayload(peerRequestPayload({ peerId: input.peerId, issuedAtMs, nonce, method: input.method, path, bodySha256 }), input.privateKeyPem)
  };
}

/** Whether the request carries a peer signature at all (verified whenever present). */
export function hasPeerRequestSignature(headers: Record<string, unknown>): boolean {
  return headerString(headers, PEER_REQUEST_HEADERS.sig) !== undefined || headerString(headers, PEER_REQUEST_HEADERS.id) !== undefined;
}

export type PeerRequestDecision =
  | { ok: true; peerId: string; nonce: string; issuedAtMs: number }
  | { ok: false; code: 401 | 403 | 409; error: string };

/**
 * Verify a signed peer request. Without `rawBody` only the headers are checked (the transport gate,
 * before the body is read); with it the declared body hash must match the bytes received. `replay`
 * is consulted last, after the signature verified, so a forged request cannot burn a nonce.
 */
export async function verifyPeerRequest(input: {
  headers: Record<string, unknown>;
  method: string;
  /** Path plus query string, as received (req.url). */
  path: string;
  rawBody?: string | Buffer | null;
  trusted: PeerKeyTrust;
  /** True the first time (peerId, nonce) is seen inside the skew window. */
  replay?: (peerId: string, nonce: string, issuedAtMs: number) => boolean | Promise<boolean>;
  nowMs?: number;
}): Promise<PeerRequestDecision> {
  const h = (k: string) => headerString(input.headers, k);
  const peerId = h(PEER_REQUEST_HEADERS.id);
  const issuedAtMs = Number(h(PEER_REQUEST_HEADERS.ts));
  const nonce = h(PEER_REQUEST_HEADERS.nonce);
  const bodySha256 = h(PEER_REQUEST_HEADERS.body);
  const keyB64 = h(PEER_REQUEST_HEADERS.key);
  const sig = h(PEER_REQUEST_HEADERS.sig);
  if (!peerId || !nonce || !bodySha256 || !keyB64 || !sig || !Number.isFinite(issuedAtMs)) {
    return { ok: false, code: 401, error: "peer_signature_required" };
  }
  let publicKeyPem: string;
  try {
    publicKeyPem = Buffer.from(keyB64, "base64").toString("utf8");
  } catch {
    return { ok: false, code: 401, error: "peer_signature_invalid" };
  }
  const checked = checkPeerSignature({
    peerId,
    publicKeyPem,
    issuedAtMs,
    signature: sig,
    payload: peerRequestPayload({ peerId, issuedAtMs, nonce, method: input.method, path: input.path, bodySha256 }),
    trusted: input.trusted,
    nowMs: input.nowMs
  });
  if (!checked.ok) return checked;
  if (input.rawBody !== undefined && sha256Hex(input.rawBody) !== bodySha256.toLowerCase()) {
    return { ok: false, code: 401, error: "peer_body_mismatch" };
  }
  if (input.replay && !(await input.replay(peerId, nonce, issuedAtMs))) return { ok: false, code: 409, error: "peer_signature_replayed" };
  return { ok: true, peerId, nonce, issuedAtMs };
}

/** Log level for a bootstrap /mesh/register-peer answer: info when the peer accepted us, warn otherwise. */
export function bootstrapRegisterLogLevel(statusCode: number): "info" | "warn" {
  return statusCode >= 200 && statusCode < 300 ? "info" : "warn";
}
