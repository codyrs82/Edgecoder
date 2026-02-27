// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createVerify } from "node:crypto";
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

  const manifestJson = JSON.stringify({
    version: manifest.version,
    artifacts: manifest.artifacts,
    distTreeHash: manifest.distTreeHash,
    timestamp: manifest.timestamp,
  });

  const activeKeys = getActiveReleaseKeys(nowMs);
  if (activeKeys.length === 0) {
    return { status: "unverified", details: "no_active_release_keys" };
  }

  let signatureValid = false;
  for (const key of activeKeys) {
    try {
      const verifier = createVerify("Ed25519");
      verifier.update(manifestJson);
      if (verifier.verify(key.publicKeyPem, payload.releaseSignature, "base64")) {
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
