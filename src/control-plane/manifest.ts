import { createHash } from "node:crypto";
import { LocalModelManifest } from "../common/types.js";

export interface ManifestVerification {
  ok: boolean;
  reason?: string;
}

const ALLOWED_MODEL_SOURCES = [
  "https://models.edgecoder.local/",
  "https://huggingface.co/"
];

export function verifyManifest(manifest: LocalModelManifest): ManifestVerification {
  const sourceAllowed = ALLOWED_MODEL_SOURCES.some((prefix) =>
    manifest.sourceUrl.startsWith(prefix)
  );
  if (!sourceAllowed) {
    return { ok: false, reason: "source_not_allowed" };
  }

  if (!/^[a-fA-F0-9]{64}$/.test(manifest.checksumSha256)) {
    return { ok: false, reason: "invalid_checksum_format" };
  }

  if (manifest.signature.length < 16) {
    return { ok: false, reason: "invalid_signature" };
  }

  return { ok: true };
}

export function checksumText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
