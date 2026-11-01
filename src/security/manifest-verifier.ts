// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { sign, verify } from "node:crypto";

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

export interface SignedModelManifest extends ModelManifest {
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
  return `${m.modelId}\n${m.version}\n${m.sha256}`;
}

export function signModelManifest(
  manifest: ModelManifest,
  privateKeyPem: string,
  peerId: string
): SignedModelManifest {
  const payload = canonicalize(manifest);
  const signature = sign(null, Buffer.from(payload, "utf8"), privateKeyPem).toString("base64");
  return { ...manifest, signature, signerPeerId: peerId };
}

export function verifyModelManifest(
  signed: SignedModelManifest,
  trust: TrustConfig
): ManifestVerifyResult {
  if (!trust.trustedPeerIds.includes(signed.signerPeerId)) {
    return { valid: false, reason: "untrusted_peer" };
  }

  try {
    const url = new URL(signed.source);
    if (!allowedDownloadDomains().includes(url.hostname)) {
      return { valid: false, reason: "source_not_allowlisted" };
    }
  } catch {
    return { valid: false, reason: "invalid_source_url" };
  }

  const ext = signed.source.substring(signed.source.lastIndexOf("."));
  if (!ALLOWED_MODEL_EXTENSIONS.includes(ext)) {
    return { valid: false, reason: "disallowed_file_extension" };
  }

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
