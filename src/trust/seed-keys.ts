// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The edgecoder.io seeds' identity keys (`peerId:sha256 of the SPKI DER`, as GET /identity reports
 * `trustEntry`). Same list as EDGECODER_SEED_KEYS in desktop/src-tauri/src/network_enrollment.rs
 * (tests/trust/seed-keys.test.ts fails if they drift). Rotation: add the new entry, release, rotate
 * the seed, then drop the old entry (docs/going-to-mainnet.md, "Switching agents to strict").
 */
export const EDGECODER_SEED_KEYS: readonly string[] = [
  "coord-25bacdd7b3f3:ef50370733f0c02751c1617e6e66eca1bcb641542c82098a3479eac7ef59b3a8",
  "coord-b17fb990ea6b:df0500ee7020c4f3ea0676762b8dbe66a4ac7f4820707b00ee17b1cf36637ed9"
];

/** The network the seed keys belong to; they never apply to coordinators on other domains. */
export const EDGECODER_NETWORK_DOMAIN = "edgecoder.io";

/** True for https URLs on the edgecoder.io network (the domain or a subdomain). */
export function isEdgecoderNetworkUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && (host === EDGECODER_NETWORK_DOMAIN || host.endsWith(`.${EDGECODER_NETWORK_DOMAIN}`));
  } catch {
    return false;
  }
}

/**
 * Agents pointed at the edgecoder.io network trust only the seeds' published keys (strict), as the
 * desktop app does, unless EDGECODER_TRUST_MODE or TRUSTED_COORDINATOR_KEYS is set explicitly
 * (EDGECODER_TRUST_MODE=tofu keeps first-use pinning). Returns the env to build trust from.
 */
export function withNetworkTrustDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if ((env.EDGECODER_TRUST_MODE ?? "").trim() || (env.TRUSTED_COORDINATOR_KEYS ?? "").trim()) return env;
  if (!isEdgecoderNetworkUrl(env.COORDINATOR_URL)) return env;
  return { ...env, EDGECODER_TRUST_MODE: "strict", TRUSTED_COORDINATOR_KEYS: EDGECODER_SEED_KEYS.join(",") };
}
