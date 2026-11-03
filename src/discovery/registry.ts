// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// The signed coordinator registry: the pool behind coordinator.edgecoder.io (EdgeCoder seeds plus
// admitted community coordinators), with health, signed by an EdgeCoder registry key (Ed25519).
// The portal serves it at GET /network/registry; coordinators mirror it at the same path, so the
// one platform URL also hands it out. Clients verify it against a pinned registry public key and
// never use an unsigned, badly signed or expired registry.
//
// Wire format (the signature covers the exact payload bytes, so no canonicalization is needed):
//   { "format": "edgecoder-registry/1", "keyId": "<sha256 hex of the SPKI DER>",
//     "payload": "<JSON string of RegistryPayload>", "signature": "<base64 Ed25519>" }

import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { z } from "zod";
import { signPayload, verifyPayload } from "../mesh/peer.js";
import { publicKeyFingerprint, tryPublicKeyFingerprint } from "../security/key-fingerprint.js";

export const REGISTRY_FORMAT = "edgecoder-registry/1";

/**
 * EdgeCoder's registry public keys, pinned in every client. Empty until the operator generates the
 * registry key and publishes its public half here (docs/discovery.md, "Turning steering on"):
 * with no key pinned, clients never accept a registry and keep using the configured URL.
 * Override or extend with EDGECODER_REGISTRY_PUBLIC_KEYS (PEM, or 64-hex raw Ed25519 key; comma or
 * semicolon separated, for rotation).
 */
export const DEFAULT_REGISTRY_PUBLIC_KEYS: readonly string[] = [];

export type RegistryHealthStatus = "healthy" | "unhealthy" | "unknown";
export type OperatorKind = "edgecoder" | "community";

export interface RegistryHealth {
  status: RegistryHealthStatus;
  checkedAtMs: number | null;
  latencyMs: number | null;
  /** Why the last check failed (identity_mismatch, health_503, unreachable, ...). */
  reason?: string;
  consecutiveFailures?: number;
}

export interface RegistryAdmission {
  /** The operator's identity was verified by EdgeCoder (always true for EdgeCoder's seeds). */
  verifiedOperator: boolean;
  /** The coordinator's key is published (DNS fp=, signed announcement, or this registry). */
  publishedKey: boolean;
  /** Stake or bond in sats. Recorded for the admission rules to come; not enforced yet. */
  stakeSats: number;
}

export interface RegistryEntry {
  peerId: string;
  /** sha256 hex of the coordinator's Ed25519 SPKI DER, as GET /identity reports `fingerprint`. */
  publicKeyFingerprint: string;
  urls: string[];
  region: string;
  operator: { id: string; name: string; kind: OperatorKind };
  admission: RegistryAdmission;
  admittedAtMs: number;
  health: RegistryHealth;
}

export interface RegistryPayload {
  v: 1;
  network: string;
  issuedAtMs: number;
  expiresAtMs: number;
  coordinators: RegistryEntry[];
  /** Where clients go when nothing in the pool is usable (the seeds behind the platform URL). */
  fallbackUrls: string[];
}

export interface SignedRegistry {
  format: typeof REGISTRY_FORMAT;
  keyId: string;
  payload: string;
  signature: string;
}

const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
const urlSchema = z
  .string()
  .max(2048)
  .refine((u) => {
    try {
      const p = new URL(u).protocol;
      return p === "https:" || p === "http:";
    } catch {
      return false;
    }
  }, "url must be http(s)");

export const registryEntrySchema = z.object({
  peerId: z.string().min(1).max(256),
  publicKeyFingerprint: fingerprintSchema,
  urls: z.array(urlSchema).min(1).max(8),
  region: z.string().max(64).default("unknown"),
  operator: z.object({ id: z.string().max(256), name: z.string().max(256), kind: z.enum(["edgecoder", "community"]) }),
  admission: z.object({
    verifiedOperator: z.boolean(),
    publishedKey: z.boolean(),
    stakeSats: z.number().int().nonnegative().default(0)
  }),
  admittedAtMs: z.number().int().nonnegative(),
  health: z.object({
    status: z.enum(["healthy", "unhealthy", "unknown"]),
    checkedAtMs: z.number().int().nonnegative().nullable(),
    latencyMs: z.number().nonnegative().nullable(),
    reason: z.string().max(256).optional(),
    consecutiveFailures: z.number().int().nonnegative().optional()
  })
});

export const registryPayloadSchema = z.object({
  v: z.literal(1),
  network: z.string().max(64),
  issuedAtMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
  coordinators: z.array(registryEntrySchema).max(512),
  fallbackUrls: z.array(urlSchema).max(16).default([])
});

const signedRegistrySchema = z.object({
  format: z.literal(REGISTRY_FORMAT),
  keyId: z.string().max(128),
  payload: z.string().min(2).max(1_000_000),
  signature: z.string().min(1).max(1024)
});

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Parse one pinned registry key: a PEM (real or "\n"-escaped newlines) or the 32-byte raw Ed25519
 * key as 64 hex chars. Returns the PEM, or null when it is not an Ed25519 public key.
 */
export function parseRegistryPublicKey(raw: string): string | null {
  const text = raw.trim().replace(/\\n/g, "\n");
  if (!text) return null;
  let key: KeyObject;
  try {
    if (/^[0-9a-f]{64}$/i.test(text)) {
      key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(text, "hex")]), format: "der", type: "spki" });
    } else {
      key = createPublicKey(text);
    }
  } catch {
    return null;
  }
  if (key.asymmetricKeyType !== "ed25519") return null;
  return key.export({ type: "spki", format: "pem" }).toString();
}

/** Pinned registry keys from EDGECODER_REGISTRY_PUBLIC_KEYS plus the built-in defaults. Invalid entries are dropped. */
export function registryPublicKeysFromEnv(env: NodeJS.ProcessEnv = process.env, defaults: readonly string[] = DEFAULT_REGISTRY_PUBLIC_KEYS): string[] {
  const raw = (env.EDGECODER_REGISTRY_PUBLIC_KEYS ?? env.EDGECODER_REGISTRY_PUBLIC_KEY ?? "").trim();
  // A PEM has no commas or semicolons, so either separates entries.
  const fromEnv = raw ? raw.split(/[;,]/) : [];
  const out = new Map<string, string>();
  for (const entry of [...fromEnv, ...defaults]) {
    const pem = parseRegistryPublicKey(entry);
    if (!pem) continue;
    out.set(publicKeyFingerprint(pem), pem);
  }
  return [...out.values()];
}

/** Load the registry signing key (PKCS#8 PEM, "\n" escapes allowed). Throws when it is not Ed25519. */
export function loadRegistrySigningKey(pem: string): { privateKeyPem: string; publicKeyPem: string; keyId: string } {
  const text = pem.trim().replace(/\\n/g, "\n");
  const key = createPrivateKey(text);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("REGISTRY_SIGNING_KEY_PEM must be an Ed25519 private key");
  const publicKeyPem = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  return { privateKeyPem: key.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem, keyId: publicKeyFingerprint(publicKeyPem) };
}

export function signRegistry(payload: RegistryPayload, signingKey: { privateKeyPem: string; keyId: string }): SignedRegistry {
  const text = JSON.stringify(payload);
  return { format: REGISTRY_FORMAT, keyId: signingKey.keyId, payload: text, signature: signPayload(text, signingKey.privateKeyPem) };
}

export interface RegistryVerifyOptions {
  /** Pinned registry public keys (PEM). An empty list rejects every registry. */
  publicKeys: readonly string[];
  now?: () => number;
  /** Tolerated clock skew for issuedAtMs in the future and expiresAtMs in the past (default 5 min). */
  maxSkewMs?: number;
}

export type RegistryVerifyResult =
  | { ok: true; registry: RegistryPayload; keyId: string }
  | { ok: false; reason: "malformed" | "no_pinned_key" | "unknown_key" | "bad_signature" | "invalid_payload" | "expired" | "future" };

/** Verify signature, shape and freshness. The payload is parsed only after the signature checks out. */
export function verifySignedRegistry(input: unknown, opts: RegistryVerifyOptions): RegistryVerifyResult {
  const env = signedRegistrySchema.safeParse(input);
  if (!env.success) return { ok: false, reason: "malformed" };
  const keys = opts.publicKeys.map((pem) => ({ pem, fp: tryPublicKeyFingerprint(pem) })).filter((k): k is { pem: string; fp: string } => Boolean(k.fp));
  if (keys.length === 0) return { ok: false, reason: "no_pinned_key" };
  const key = keys.find((k) => k.fp === env.data.keyId.toLowerCase());
  if (!key) return { ok: false, reason: "unknown_key" };
  if (!verifyPayload(env.data.payload, env.data.signature, key.pem)) return { ok: false, reason: "bad_signature" };
  let json: unknown;
  try {
    json = JSON.parse(env.data.payload);
  } catch {
    return { ok: false, reason: "invalid_payload" };
  }
  const parsed = registryPayloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "invalid_payload" };
  const now = (opts.now ?? Date.now)();
  const skew = opts.maxSkewMs ?? 5 * 60_000;
  if (parsed.data.expiresAtMs + skew < now) return { ok: false, reason: "expired" };
  if (parsed.data.issuedAtMs - skew > now) return { ok: false, reason: "future" };
  return { ok: true, registry: parsed.data as RegistryPayload, keyId: key.fp };
}
