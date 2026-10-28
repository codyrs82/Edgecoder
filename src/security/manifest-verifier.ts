// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash, sign, timingSafeEqual, verify } from "node:crypto";

export const ALLOWED_MODEL_EXTENSIONS = [".gguf", ".bin", ".safetensors"];
export const DEFAULT_DOWNLOAD_DOMAINS = ["models.edgecoder.io", "huggingface.co"];

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/** True for a bare DNS hostname with at least one dot (no scheme, port, path, wildcard or IP). */
export function isDownloadDomain(value: string): boolean {
  if (value.length > 253 || !value.includes(".") || /^[0-9.]+$/.test(value)) return false;
  return value.split(".").every((label) => HOST_LABEL.test(label));
}

/**
 * #22: MODEL_DOWNLOAD_DOMAINS (comma list of exact hostnames) replaces the defaults when set.
 * Every entry must be a bare hostname; anything else (a URL, a port, `*.`, an IP) throws, so a
 * typo fails at startup instead of silently widening or emptying the allowlist.
 */
export function allowedDownloadDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.MODEL_DOWNLOAD_DOMAINS?.trim();
  if (!raw) return DEFAULT_DOWNLOAD_DOMAINS;
  const entries = raw.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const bad = entries.filter((d) => !isDownloadDomain(d));
  if (bad.length > 0) {
    throw new Error(`MODEL_DOWNLOAD_DOMAINS has invalid entries (bare hostnames only): ${bad.map((d) => JSON.stringify(d)).join(", ")}`);
  }
  if (entries.length === 0) throw new Error("MODEL_DOWNLOAD_DOMAINS is set but lists no hostnames");
  return [...new Set(entries)];
}

export const ALLOWED_DOWNLOAD_DOMAINS = allowedDownloadDomains();

export interface ModelManifest {
  modelId: string;
  version: string;
  source: string;
  sha256: string;
}

/**
 * #144: v2 signs every field a client acts on, including `source`. v1 (modelId, version and
 * sha256 only) let anyone swap the download URL on a validly signed manifest, so it is rejected.
 */
export const MANIFEST_VERSION = 2;

export interface SignedModelManifest extends ModelManifest {
  manifestVersion: number;
  signature: string;
  signerPeerId: string;
}

export interface TrustConfig {
  trustedPeerIds: string[];
  trustedPublicKeys: Record<string, string>;
}

export interface ManifestVerifyResult {
  valid: boolean;
  reason?: string;
}

function canonicalize(m: ModelManifest): string {
  // Versioned, newline-separated; a field containing a newline is rejected before signing.
  return [`edgecoder-model-manifest-v${MANIFEST_VERSION}`, m.modelId, m.version, m.sha256, m.source].join("\n");
}

function hasNewline(m: ModelManifest): boolean {
  return [m.modelId, m.version, m.sha256, m.source].some((v) => /[\r\n]/.test(v));
}

/** Why `source` is not an acceptable download URL, or null. https only, no tricks. */
export function sourceProblem(source: string, domains: string[] = allowedDownloadDomains()): string | null {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return "invalid_source_url";
  }
  if (url.protocol !== "https:") return "source_not_https";
  if (url.username || url.password) return "source_has_credentials";
  if (url.port) return "source_has_port";
  if (url.hash) return "source_has_fragment";
  if (!domains.includes(url.hostname)) return "source_not_allowlisted";
  // Extension from the decoded path only, so ?x=.gguf or #.gguf can't satisfy it.
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return "invalid_source_url";
  }
  const dot = path.lastIndexOf(".");
  if (dot < 0 || path.lastIndexOf("/") > dot) return "disallowed_file_extension";
  if (!ALLOWED_MODEL_EXTENSIONS.includes(path.slice(dot).toLowerCase())) return "disallowed_file_extension";
  return null;
}

export function signModelManifest(
  manifest: ModelManifest,
  privateKeyPem: string,
  peerId: string
): SignedModelManifest {
  if (hasNewline(manifest)) throw new Error("manifest_field_has_newline");
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256)) throw new Error("manifest_sha256_must_be_64_lowercase_hex");
  const payload = canonicalize(manifest);
  const signature = sign(null, Buffer.from(payload, "utf8"), privateKeyPem).toString("base64");
  return { ...manifest, manifestVersion: MANIFEST_VERSION, signature, signerPeerId: peerId };
}

export function verifyModelManifest(
  signed: SignedModelManifest,
  trust: TrustConfig
): ManifestVerifyResult {
  if (!trust.trustedPeerIds.includes(signed.signerPeerId)) {
    return { valid: false, reason: "untrusted_peer" };
  }

  if (signed.manifestVersion !== MANIFEST_VERSION) {
    return { valid: false, reason: "unsupported_manifest_version" };
  }
  if (hasNewline(signed) || !/^[0-9a-f]{64}$/.test(signed.sha256)) {
    return { valid: false, reason: "malformed_manifest" };
  }

  const problem = sourceProblem(signed.source);
  if (problem) return { valid: false, reason: problem };

  const pubKey = trust.trustedPublicKeys[signed.signerPeerId];
  if (!pubKey) {
    return { valid: false, reason: "no_public_key_for_peer" };
  }

  const payload = canonicalize(signed);
  const ok = verify(
    null,
    Buffer.from(payload, "utf8"),
    pubKey,
    Buffer.from(signed.signature, "base64")
  );

  if (!ok) {
    return { valid: false, reason: "invalid_signature" };
  }

  return { valid: true };
}

/**
 * #144: the downloaded bytes must match the signed sha256 before the file is used. Call this
 * after verifyModelManifest() on the data actually downloaded from `source`.
 */
export function modelFileMatches(signed: Pick<ModelManifest, "sha256">, data: Buffer): boolean {
  const actual = createHash("sha256").update(data).digest();
  const expected = Buffer.from(signed.sha256, "hex");
  return expected.length === 32 && timingSafeEqual(actual, expected);
}
