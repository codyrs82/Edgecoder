// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash, createPublicKey } from "node:crypto";

/*
 * One public-key fingerprint for the whole system (pentest LOW: three divergent functions).
 *
 * Canonical form: sha256 hex of the key's SPKI DER encoding. It identifies the key, not its text,
 * so CRLF line endings, surrounding whitespace or a re-wrapped PEM all give the same value.
 * Used by the mesh peer allowlist (MESH_PEER_ALLOWLIST), agent coordinator pins
 * (TRUSTED_COORDINATOR_KEYS / trust file) and discovery pins (EDGECODER_COORDINATOR_PINS).
 *
 * Older builds pinned sha256 of the PEM text (two slightly different normalizations). Those pins
 * are still accepted by fingerprintMatches, so existing trust files and operator lists keep
 * working; anything newly pinned is written in the canonical form.
 */

function normalizePem(publicKeyPem: string): string {
  return publicKeyPem.replace(/\r\n?/g, "\n").trim();
}

/** sha256 hex of the SPKI DER encoding. Throws on a PEM that is not a public key. */
export function publicKeyFingerprint(publicKeyPem: string): string {
  const der = createPublicKey(normalizePem(publicKeyPem)).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

/** Canonical fingerprint, or null when the PEM does not parse. */
export function tryPublicKeyFingerprint(publicKeyPem: string): string | null {
  try {
    return publicKeyFingerprint(publicKeyPem);
  } catch {
    return null;
  }
}

/** Pre-unification PEM-text fingerprints (discovery: trimmed; trust file: trimmed + "\n"). */
export function legacyPemFingerprints(publicKeyPem: string): string[] {
  const normalized = normalizePem(publicKeyPem);
  return [normalized, `${normalized}\n`].map((text) => createHash("sha256").update(text).digest("hex"));
}

/** True when `fp` (hex, any case) is this key's canonical or a legacy fingerprint. */
export function fingerprintMatches(fp: string, publicKeyPem: string): boolean {
  const want = fp.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) return false;
  if (tryPublicKeyFingerprint(publicKeyPem) === want) return true;
  return legacyPemFingerprints(publicKeyPem).includes(want);
}
