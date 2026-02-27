// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

export interface TrustedReleaseKey {
  publicKeyPem: string;
  activatedAtMs: number;
  expiresAtMs?: number;
}

/**
 * Trust anchor: Ed25519 public keys used to sign official release manifests.
 * Old keys remain trusted for a 90-day grace period after rotation.
 *
 * To rotate keys:
 * 1. Generate a new Ed25519 keypair
 * 2. Add the new public key to this array with activatedAtMs = Date.now()
 * 3. Set expiresAtMs on the old key = activatedAtMs + 90 days
 * 4. Store the new private key in GitHub Actions secret RELEASE_SIGNING_PRIVATE_KEY
 */
export const TRUSTED_RELEASE_KEYS: TrustedReleaseKey[] = [
  // Placeholder — replace with actual release signing public key after first key ceremony
  // {
  //   publicKeyPem: "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
  //   activatedAtMs: 1700000000000,
  // },
];

export function getActiveReleaseKeys(nowMs: number = Date.now()): TrustedReleaseKey[] {
  return TRUSTED_RELEASE_KEYS.filter(key => {
    if (nowMs < key.activatedAtMs) return false;
    if (key.expiresAtMs && nowMs > key.expiresAtMs) return false;
    return true;
  });
}
