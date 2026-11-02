// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// Coordinator discovery: the announcement record a coordinator publishes (DNS, Nostr,
// /discovery/announcement) and the candidate record the selector ranks.

import { createHash } from "node:crypto";
import { z } from "zod";
import { signPayload, verifyPayload } from "../mesh/peer.js";

/** A coordinator's self-description, signed with its Ed25519 mesh identity. */
export interface CoordinatorAnnouncement {
  peerId: string;
  publicKeyPem: string;
  url: string;
  region: string;
  services: string[];
  computeClasses: string[];
  version: string;
  announcedAtMs: number;
  /** base64 Ed25519 signature over `canonicalizeAnnouncement(record without signature)`. */
  signature: string;
}

export type UnsignedAnnouncement = Omit<CoordinatorAnnouncement, "signature">;

export type CandidateSource = "static" | "dns" | "nostr" | "peer" | "current";

/** A coordinator the selector may probe. Only `url` is required; the rest enriches scoring. */
export interface CoordinatorCandidate {
  url: string;
  peerId?: string;
  publicKeyPem?: string;
  region?: string;
  source: CandidateSource;
  announcement?: CoordinatorAnnouncement;
}

export const announcementSchema = z.object({
  peerId: z.string().min(1).max(256),
  publicKeyPem: z.string().min(1).max(4096),
  url: z.string().url().max(2048),
  region: z.string().max(64).default("unknown"),
  services: z.array(z.string().max(64)).max(64).default([]),
  computeClasses: z.array(z.string().max(64)).max(64).default([]),
  version: z.string().max(64).default(""),
  announcedAtMs: z.number().int().nonnegative(),
  signature: z.string().min(1).max(1024)
});

/** Strip a trailing slash so `https://a` and `https://a/` de-duplicate. Returns null when not http(s). */
export function normalizeCoordinatorUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    u.search = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Canonical JSON for signing: fixed key order, arrays preserved in order, no whitespace.
 * The signature field is never part of the signed bytes.
 */
export function canonicalizeAnnouncement(a: UnsignedAnnouncement): string {
  return JSON.stringify({
    v: 1,
    peerId: a.peerId,
    publicKeyPem: a.publicKeyPem,
    url: a.url,
    region: a.region,
    services: [...a.services],
    computeClasses: [...a.computeClasses],
    version: a.version,
    announcedAtMs: a.announcedAtMs
  });
}

export function signAnnouncement(a: UnsignedAnnouncement, privateKeyPem: string): CoordinatorAnnouncement {
  return { ...a, signature: signPayload(canonicalizeAnnouncement(a), privateKeyPem) };
}

export interface VerifyOptions {
  /** Reject announcements older than this (default 24 h). 0 disables the age check. */
  maxAgeMs?: number;
  /** Reject announcements from further than this in the future (default 5 min). */
  maxSkewMs?: number;
  now?: () => number;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** Verify the Ed25519 signature and freshness. Shape is validated with `parseAnnouncement` first. */
export function verifyAnnouncement(a: CoordinatorAnnouncement, opts: VerifyOptions = {}): VerifyResult {
  const parsed = parseAnnouncement(a);
  if (!parsed) return { ok: false, reason: "malformed" };
  const { signature, ...unsigned } = parsed;
  if (!verifyPayload(canonicalizeAnnouncement(unsigned), signature, parsed.publicKeyPem)) {
    return { ok: false, reason: "bad_signature" };
  }
  const now = (opts.now ?? Date.now)();
  const maxAge = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const maxSkew = opts.maxSkewMs ?? 5 * 60 * 1000;
  if (maxAge > 0 && now - parsed.announcedAtMs > maxAge) return { ok: false, reason: "expired" };
  if (parsed.announcedAtMs - now > maxSkew) return { ok: false, reason: "future" };
  return { ok: true };
}

/** Validate an untrusted value's shape (no signature check). Returns null when malformed. */
export function parseAnnouncement(input: unknown): CoordinatorAnnouncement | null {
  const r = announcementSchema.safeParse(input);
  if (!r.success) return null;
  const url = normalizeCoordinatorUrl(r.data.url);
  if (!url) return null;
  // Keep the URL exactly as signed; only reject ones we could not normalize.
  return r.data;
}

/** sha256 hex of the PEM with whitespace normalized; used for operator key pins. */
export function publicKeyFingerprint(publicKeyPem: string): string {
  const normalized = publicKeyPem.replace(/\r/g, "").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

/** True when `pin` matches the PEM either verbatim (whitespace-insensitive) or by fingerprint. */
export function pinMatchesKey(pin: string, publicKeyPem: string): boolean {
  const p = pin.trim();
  if (!p) return false;
  if (/^[0-9a-f]{64}$/i.test(p)) return p.toLowerCase() === publicKeyFingerprint(publicKeyPem);
  return p.replace(/\s+/g, "") === publicKeyPem.replace(/\s+/g, "");
}

export function candidateFromAnnouncement(a: CoordinatorAnnouncement, source: CandidateSource): CoordinatorCandidate | null {
  const url = normalizeCoordinatorUrl(a.url);
  if (!url) return null;
  return { url, peerId: a.peerId, publicKeyPem: a.publicKeyPem, region: a.region, source, announcement: a };
}

/**
 * Merge candidates from several sources. A later candidate with the same peerId or URL
 * enriches (never replaces) the first one seen; the first source wins for `source`.
 */
export function mergeCandidates(...lists: CoordinatorCandidate[][]): CoordinatorCandidate[] {
  const byUrl = new Map<string, CoordinatorCandidate>();
  const byPeer = new Map<string, CoordinatorCandidate>();
  for (const list of lists) {
    for (const raw of list) {
      const url = normalizeCoordinatorUrl(raw.url);
      if (!url) continue;
      const existing = byUrl.get(url) ?? (raw.peerId ? byPeer.get(raw.peerId) : undefined);
      if (!existing) {
        const c: CoordinatorCandidate = { ...raw, url };
        byUrl.set(url, c);
        if (c.peerId) byPeer.set(c.peerId, c);
        continue;
      }
      existing.peerId ??= raw.peerId;
      existing.publicKeyPem ??= raw.publicKeyPem;
      existing.region ??= raw.region;
      if (!existing.announcement && raw.announcement) existing.announcement = raw.announcement;
      else if (existing.announcement && raw.announcement && raw.announcement.announcedAtMs > existing.announcement.announcedAtMs) {
        existing.announcement = raw.announcement;
      }
      if (existing.peerId) byPeer.set(existing.peerId, existing);
    }
  }
  return [...byUrl.values()];
}
