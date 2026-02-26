// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { sign, verify } from "node:crypto";

export const ALLOWED_MODEL_EXTENSIONS = [".gguf", ".bin", ".safetensors"];
export const ALLOWED_DOWNLOAD_DOMAINS = ["models.edgecoder.io", "huggingface.co"];

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
    if (!ALLOWED_DOWNLOAD_DOMAINS.includes(url.hostname)) {
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
