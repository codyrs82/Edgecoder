// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { neverClaimProblems, type RuleProblem } from "./rules.js";

/**
 * Images on brand posts and send times.
 *
 * Images: up to 4 per post, PNG or JPEG (detected from the bytes, not the name or a declared type),
 * at most 5 MB each (X's tweet_image limit). Alt text is optional, at most 1000 characters, and is
 * held to the never-claim list like the post itself (it is public).
 *
 * Send times are stored as UTC milliseconds. The admin page shows and edits them as America/Chicago
 * wall-clock time; the conversions here follow Chicago's DST rules through Intl.
 */

export const MAX_IMAGES_PER_POST = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_ALT_CHARS = 1000;
export const SCHEDULE_TIME_ZONE = "America/Chicago";

export type ImageType = "image/png" | "image/jpeg";

/** The image type from its magic bytes; null for anything else. */
export function sniffImageType(b: Uint8Array): ImageType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

/** A file name safe to store and show: path parts, control characters and quotes removed, at most 100 characters. */
export function cleanFilename(name: string, type: ImageType): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f"<>]/g, "").trim().slice(0, 100);
  return base || (type === "image/png" ? "image.png" : "image.jpg");
}

export interface ImageInput {
  filename: string;
  /** Base64 (standard or URL-safe; a data: URL prefix is accepted). */
  base64: string;
  alt?: string | null;
}

export interface ValidImage {
  filename: string;
  contentType: ImageType;
  bytes: Uint8Array;
  alt: string | null;
}

export type ImageCheck = { ok: true; image: ValidImage } | { ok: false; error: string; problems?: RuleProblem[] };

/** Decode and check one uploaded image. */
export function validateImage(i: ImageInput): ImageCheck {
  const raw = i.base64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!raw || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return { ok: false, error: "image_not_base64" };
  // Base64 is 4/3 of the bytes: refuse before decoding something far too large.
  if (raw.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) return { ok: false, error: "image_too_large" };
  const bytes = new Uint8Array(Buffer.from(raw, raw.includes("-") || raw.includes("_") ? "base64url" : "base64"));
  if (!bytes.length) return { ok: false, error: "image_empty" };
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: "image_too_large" };
  const type = sniffImageType(bytes);
  if (!type) return { ok: false, error: "image_type_not_png_or_jpeg" };
  const alt = (i.alt ?? "").trim();
  if (alt.length > MAX_ALT_CHARS) return { ok: false, error: "alt_too_long" };
  const problems = alt ? altProblems(alt) : [];
  if (problems.length) return { ok: false, error: "rule_problems", problems };
  return { ok: true, image: { filename: cleanFilename(i.filename, type), contentType: type, bytes, alt: alt || null } };
}

/** Never-claim wording in alt text (the same list as posts). */
export function altProblems(alt: string): RuleProblem[] {
  return neverClaimProblems(alt).map((p) => ({ code: p.code, message: `Image description: ${p.message}` }));
}

// ── Send times ──

/** The zone's offset from UTC at a UTC instant (Chicago: -6 h in winter, -5 h in summer), in ms. */
export function zoneOffsetMs(utcMs: number, timeZone = SCHEDULE_TIME_ZONE): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** "2026-12-01T09:30" as America/Chicago wall time -> UTC ms; null when malformed. */
export function chicagoLocalToUtcMs(local: string): number | null {
  const m = LOCAL_RE.exec(local.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0)) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  if (new Date(wall).getUTCDate() !== d) return null;
  const first = wall - zoneOffsetMs(wall);
  return wall - zoneOffsetMs(first);
}

/** UTC ms -> "2026-12-01T09:30" America/Chicago wall time (for a datetime-local input). */
export function utcMsToChicagoLocal(utcMs: number): string {
  return new Date(utcMs + zoneOffsetMs(utcMs)).toISOString().slice(0, 16);
}

/**
 * A send time from an API body: `scheduledAt` (ISO 8601 with Z or an offset) or `scheduledAtLocal`
 * (America/Chicago wall time). null clears it; undefined when neither field is present.
 */
export function parseSchedule(b: { scheduledAt?: string | null; scheduledAtLocal?: string | null }): { ok: true; ms: number | null | undefined } | { ok: false; error: string } {
  if (b.scheduledAt !== undefined && b.scheduledAtLocal !== undefined && b.scheduledAt !== null && b.scheduledAtLocal !== null) return { ok: false, error: "scheduled_at_twice" };
  if (typeof b.scheduledAt === "string" && b.scheduledAt.trim()) {
    const t = b.scheduledAt.trim();
    const ms = ISO_RE.test(t) ? Date.parse(t) : NaN;
    return Number.isFinite(ms) ? { ok: true, ms } : { ok: false, error: "scheduled_at_invalid (ISO 8601 with Z or an offset)" };
  }
  if (typeof b.scheduledAtLocal === "string" && b.scheduledAtLocal.trim()) {
    const ms = chicagoLocalToUtcMs(b.scheduledAtLocal);
    return ms === null ? { ok: false, error: "scheduled_at_local_invalid (YYYY-MM-DDTHH:mm, America/Chicago)" } : { ok: true, ms };
  }
  if (b.scheduledAt === null || b.scheduledAtLocal === null || b.scheduledAt === "" || b.scheduledAtLocal === "") return { ok: true, ms: null };
  return { ok: true, ms: undefined };
}
