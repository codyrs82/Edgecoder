// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { randomBytes } from "node:crypto";
import { signPayload, verifyPayload } from "../mesh/peer.js";

/*
 * Coordinator proof of key possession. `GET /identity` is public, so anyone can replay it; before
 * trusting a coordinator URL the agent sends a fresh nonce to `POST /identity/challenge` and the
 * coordinator signs the nonce, the URL the agent used, its own public URL and its peerId with its
 * Ed25519 identity key. The agent checks the signature against the key it pins, and that the
 * coordinator's own public URL is the URL it addressed: otherwise a host that merely relays the
 * challenge to a real coordinator would pass as that coordinator.
 */

export const IDENTITY_CHALLENGE_PATH = "/identity/challenge";
const DOMAIN = "edgecoder-identity-challenge:v1";
const NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/;

export interface IdentityChallengeRequest {
  nonce: string;
  /** The coordinator URL as the agent addressed it. */
  url: string;
}

export interface IdentityChallengeResponse {
  peerId: string;
  publicKeyPem: string;
  nonce: string;
  /** Echo of the URL the agent addressed. */
  requestedUrl: string;
  /** The coordinator's own public URL (COORDINATOR_PUBLIC_URL). */
  coordinatorUrl: string;
  issuedAtMs: number;
  signature: string;
}

export function newChallengeNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function normalizeChallengeUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host.endsWith(".localhost");
}

/**
 * Canonical form of a coordinator URL for comparison: lower-case scheme and host, default port
 * dropped, no trailing slash, no query or fragment. Null when it is not an http(s) URL.
 */
export function canonicalCoordinatorUrl(url: string): string | null {
  try {
    const u = new URL(normalizeChallengeUrl(url));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * Whether the URL the coordinator says it serves (`coordinatorUrl`, signed) is the URL the agent
 * addressed. A loopback address is exempt: an agent talking to 127.0.0.1/localhost reaches a
 * coordinator on its own machine (the embedded all-in-one worker), whose public URL differs.
 */
export function coordinatorUrlMatches(coordinatorUrl: string, addressedUrl: string): boolean {
  const addressed = canonicalCoordinatorUrl(addressedUrl);
  if (!addressed) return false;
  if (isLoopbackHost(new URL(addressed).hostname)) return true;
  return canonicalCoordinatorUrl(coordinatorUrl) === addressed;
}

/** The exact bytes the coordinator signs. */
export function identityChallengePayload(r: Omit<IdentityChallengeResponse, "signature" | "publicKeyPem">): string {
  return [DOMAIN, r.nonce, normalizeChallengeUrl(r.requestedUrl), normalizeChallengeUrl(r.coordinatorUrl), r.peerId, String(r.issuedAtMs)].join("\n");
}

/** Coordinator side: validate the request body and sign the answer. Returns null for a bad request. */
export function answerIdentityChallenge(
  body: unknown,
  self: { peerId: string; publicKeyPem: string; privateKeyPem: string; publicUrl: string },
  now: () => number = Date.now
): IdentityChallengeResponse | null {
  const b = (body ?? {}) as Partial<IdentityChallengeRequest>;
  if (typeof b.nonce !== "string" || !NONCE_RE.test(b.nonce)) return null;
  if (typeof b.url !== "string" || b.url.length === 0 || b.url.length > 2048) return null;
  const unsigned = {
    peerId: self.peerId,
    nonce: b.nonce,
    requestedUrl: normalizeChallengeUrl(b.url),
    coordinatorUrl: normalizeChallengeUrl(self.publicUrl),
    issuedAtMs: now()
  };
  return { ...unsigned, publicKeyPem: self.publicKeyPem, signature: signPayload(identityChallengePayload(unsigned), self.privateKeyPem) };
}

export type ChallengeVerifyError =
  | "challenge_malformed"
  | "challenge_nonce_mismatch"
  | "challenge_url_mismatch"
  | "challenge_coordinator_url_mismatch"
  | "challenge_peer_mismatch"
  | "challenge_bad_signature";

/**
 * Agent side: the answer must echo our nonce and URL, state the URL we addressed as the
 * coordinator's own public URL, name the expected peerId and key, and carry a valid signature by
 * that key. `expected` is the identity being trusted (its key is what gets pinned).
 */
export function verifyIdentityChallenge(
  answer: unknown,
  sent: IdentityChallengeRequest,
  expected: { peerId: string; publicKeyPem: string }
): { ok: true } | { ok: false; error: ChallengeVerifyError } {
  const a = (answer ?? {}) as Partial<IdentityChallengeResponse>;
  if (
    typeof a.peerId !== "string" || typeof a.nonce !== "string" || typeof a.requestedUrl !== "string" ||
    typeof a.coordinatorUrl !== "string" || typeof a.issuedAtMs !== "number" || typeof a.signature !== "string"
  ) {
    return { ok: false, error: "challenge_malformed" };
  }
  if (a.nonce !== sent.nonce) return { ok: false, error: "challenge_nonce_mismatch" };
  if (normalizeChallengeUrl(a.requestedUrl) !== normalizeChallengeUrl(sent.url)) return { ok: false, error: "challenge_url_mismatch" };
  if (!coordinatorUrlMatches(a.coordinatorUrl, sent.url)) return { ok: false, error: "challenge_coordinator_url_mismatch" };
  if (a.peerId !== expected.peerId || (typeof a.publicKeyPem === "string" && a.publicKeyPem.trim() !== expected.publicKeyPem.trim())) {
    return { ok: false, error: "challenge_peer_mismatch" };
  }
  const payload = identityChallengePayload({ peerId: a.peerId, nonce: a.nonce, requestedUrl: a.requestedUrl, coordinatorUrl: a.coordinatorUrl, issuedAtMs: a.issuedAtMs });
  if (!verifyPayload(payload, a.signature, expected.publicKeyPem)) return { ok: false, error: "challenge_bad_signature" };
  return { ok: true };
}
