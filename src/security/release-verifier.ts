// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { verify as cryptoVerify } from "node:crypto";
import { type ReleaseManifest, type ReleaseManifestSigned } from "./release-integrity.js";
import { getActiveReleaseKeys } from "./release-keys.js";

export type VerificationStatus =
  | "verified"
  | "unverified"
  | "signature_mismatch"
  | "hash_mismatch";

export interface BinaryIntegrityPayload {
  distHash: string;
  releaseVersion: string;
  releaseSignature: string;
  distributionChannel: string;
}

export interface VerificationResult {
  status: VerificationStatus;
  details?: string;
}

/**
 * Verify an agent's binary integrity claim.
 *
 * Advisory only: the release signature and distTreeHash are public (published with the release),
 * so any client can present a valid pair without running that build. The format carries no
 * per-session challenge, so a presented claim cannot be bound to the agent (no replay protection);
 * "verified" means "claims a release signed by a trusted key", not attestation.
 */
export function verifyBinaryIntegrity(
  payload: BinaryIntegrityPayload,
  cachedManifests: Map<string, ReleaseManifest>,
  nowMs: number = Date.now()
): VerificationResult {
  // No signature provided → unverified
  if (!payload.releaseSignature) {
    return { status: "unverified", details: "no_signature_provided" };
  }

  // Verify signature over manifest
  const manifest = cachedManifests.get(payload.releaseVersion);
  if (!manifest) {
    return { status: "unverified", details: "manifest_not_cached" };
  }

  const fields = {
    version: manifest.version,
    artifacts: manifest.artifacts,
    distTreeHash: manifest.distTreeHash,
    timestamp: manifest.timestamp,
  };
  // The signer (scripts/sign-release.sh) signs jq's output, which is indented by 2 spaces; the
  // compact form is accepted too.
  const signedForms = [JSON.stringify(fields), JSON.stringify(fields, null, 2)].map((s) => Buffer.from(s));
  const signature = Buffer.from(payload.releaseSignature, "base64");

  const activeKeys = getActiveReleaseKeys(nowMs);
  if (activeKeys.length === 0) {
    return { status: "unverified", details: "no_active_release_keys" };
  }

  let signatureValid = false;
  // Ed25519 has no separate digest: crypto.verify with a null algorithm (createVerify("Ed25519")
  // throws "Invalid digest", so no signature could ever verify).
  for (const key of activeKeys) {
    try {
      if (signedForms.some((data) => cryptoVerify(null, data, key.publicKeyPem, signature))) {
        signatureValid = true;
        break;
      }
    } catch {
      // Try next key
    }
  }

  if (!signatureValid) {
    return { status: "signature_mismatch", details: "signature_verification_failed" };
  }

  // Compare dist hash
  if (payload.distHash !== manifest.distTreeHash) {
    return { status: "hash_mismatch", details: `expected=${manifest.distTreeHash} actual=${payload.distHash}` };
  }

  return { status: "verified" };
}
