// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Campaign attribution for visits from X posts and ads (src/portal/growth.ts).
 *
 * A public page request carrying utm_* tags (or the /x/<campaign> short link) is counted once per
 * visitor per campaign per day in an aggregate table: no IP, no user agent, nothing per person on
 * the server. The visitor gets one first-party cookie, `ec_utm` (`__Host-ec_utm` when cookies are
 * Secure), holding the first-touch campaign for 30 days and the campaigns already counted today,
 * so a reload or the short link's own redirect is not counted twice and a later sign-up can be
 * credited to the campaign that brought the visitor.
 *
 * Everything here is pure (no I/O) so the rules are easy to test.
 */
import { SCHEDULE_TIME_ZONE } from "../social/media.js";

export interface Utm {
  source: string;
  medium: string;
  campaign: string;
  /** "" when the link had no utm_content (ads use it to tell creatives apart). */
  content: string;
}

export interface FirstTouch extends Utm {
  /** When the first tagged visit happened (UTC ms). */
  atMs: number;
}

export interface UtmCookie {
  first: FirstTouch;
  /** The Chicago day `counted` is for. */
  day: string;
  /** Keys (utmKey) already counted on `day`. */
  counted: string[];
}

export const UTM_COOKIE = "ec_utm";
export const UTM_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many campaigns remembered as counted per day (a cookie stays small). */
const MAX_COUNTED = 12;
const MAX_VALUE = 64;

/** A tag value as stored: lower case, [a-z0-9._-] only, at most 64 characters; "" when nothing is left. */
export function cleanTag(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .trim()
    .toLowerCase()
    .replace(/[\s+]+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, MAX_VALUE);
}

/** The campaign tags of a query string, or null when there is no source and no campaign. */
export function utmFromQuery(q: Record<string, unknown> | null | undefined): Utm | null {
  if (!q) return null;
  const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const u: Utm = {
    source: cleanTag(first(q.utm_source)),
    medium: cleanTag(first(q.utm_medium)),
    campaign: cleanTag(first(q.utm_campaign)),
    content: cleanTag(first(q.utm_content))
  };
  return u.source || u.campaign ? u : null;
}

/** One campaign's identity, for the per-day dedupe list. */
export function utmKey(u: Utm): string {
  // FNV-1a, 32 bits, hex: short and stable; a collision only means one visit is not counted.
  let h = 0x811c9dc5;
  for (const ch of `${u.source}|${u.medium}|${u.campaign}|${u.content}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: SCHEDULE_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const hourFormat = new Intl.DateTimeFormat("en-US", { timeZone: SCHEDULE_TIME_ZONE, hour: "2-digit", hourCycle: "h23" });

/** The America/Chicago calendar day of an instant, "YYYY-MM-DD". */
export function chicagoDay(ms: number): string {
  return dayFormat.format(new Date(ms));
}

/** The America/Chicago hour (0-23) of an instant. */
export function chicagoHour(ms: number): number {
  return Number(hourFormat.format(new Date(ms))) % 24;
}

/** The day before a "YYYY-MM-DD" day. */
export function previousDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** "Nov 23, 2026, 9:41 AM CST": a time as the owner reads it. */
export function chicagoTime(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: SCHEDULE_TIME_ZONE, dateStyle: "medium", timeStyle: "short" }).format(new Date(ms)) + " " + zoneAbbrev(ms);
}

function zoneAbbrev(ms: number): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: SCHEDULE_TIME_ZONE, timeZoneName: "short" }).formatToParts(new Date(ms));
  return p.find((x) => x.type === "timeZoneName")?.value ?? "CT";
}

// Crawlers, link unfurlers (X's own card fetcher included), monitors and scripts. Not exhaustive:
// the per-visitor cookie dedupe is what keeps reloads out; this only keeps obvious robots out.
const BOT_RE =
  /bot\b|bot\/|crawl|spider|slurp|preview|facebookexternalhit|embedly|quora link|whatsapp|telegram|skype|discord|slack|vkshare|pinterest|outbrain|bitly|tumblr|redditbot|applebot|yandex|baidu|duckduckgo|semrush|ahrefs|mj12|petalbot|bytespider|gptbot|claude|anthropic|perplexity|ccbot|headless|phantom|puppeteer|playwright|selenium|lighthouse|pagespeed|pingdom|uptime|monitor|statuscake|datadog|newrelic|curl|wget|python|go-http|java\/|okhttp|axios|node-fetch|undici|httpclient|libwww|scrapy|feed|rss|validator|scan|probe|check_http|^-?$/i;

/** Obvious robots by user agent; an empty or missing user agent counts as one. */
export function isBotUserAgent(ua: unknown): boolean {
  if (typeof ua !== "string") return true;
  const s = ua.trim();
  if (s.length < 10) return true;
  return BOT_RE.test(s);
}

const TAG_RE = /^[a-z0-9._-]{0,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[0-9a-f]{8}$/;

/** The cookie value, base64url JSON. */
export function encodeUtmCookie(c: UtmCookie): string {
  const f = c.first;
  return Buffer.from(JSON.stringify({ v: 1, s: f.source, m: f.medium, c: f.campaign, t: f.content, a: f.atMs, d: c.day, k: c.counted.slice(-MAX_COUNTED) }), "utf8").toString("base64url");
}

/** The cookie back, or null when it is missing, malformed, tampered into nonsense or expired. */
export function decodeUtmCookie(raw: string | undefined | null, nowMs: number): UtmCookie | null {
  if (!raw || raw.length > 600) return null;
  try {
    const j = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    if (j.v !== 1) return null;
    const tags = [j.s, j.m, j.c, j.t];
    if (!tags.every((t) => typeof t === "string" && TAG_RE.test(t))) return null;
    if (!j.s && !j.c) return null;
    const atMs = Number(j.a);
    if (!Number.isFinite(atMs) || atMs > nowMs + 60_000 || nowMs - atMs > UTM_COOKIE_TTL_MS) return null;
    const day = typeof j.d === "string" && DAY_RE.test(j.d) ? j.d : "";
    const counted = Array.isArray(j.k) ? j.k.filter((k): k is string => typeof k === "string" && KEY_RE.test(k)).slice(-MAX_COUNTED) : [];
    return { first: { source: j.s as string, medium: j.m as string, campaign: j.c as string, content: j.t as string, atMs }, day, counted };
  } catch {
    return null;
  }
}

export interface VisitInput {
  method: string;
  /** The campaign tags of this request (query string, or the short link's), null when untagged. */
  utm: Utm | null;
  userAgent: unknown;
  /** The ec_utm cookie value as received, if any. */
  cookie: string | undefined;
  nowMs: number;
}

export interface VisitDecision {
  /** Count one visit for this campaign today; null: do not count. */
  count: Utm | null;
  /** The new cookie value to set; null: leave the cookie alone. */
  cookie: UtmCookie | null;
  day: string;
}

/**
 * What a request does to the counts and the cookie. Only a GET with campaign tags from something
 * that is not an obvious robot counts, at most once per campaign per day per visitor; the first
 * tagged visit in 30 days is the one a sign-up is credited to.
 */
export function decideVisit(v: VisitInput): VisitDecision {
  const day = chicagoDay(v.nowMs);
  if (v.method !== "GET" || !v.utm || isBotUserAgent(v.userAgent)) return { count: null, cookie: null, day };
  const prev = decodeUtmCookie(v.cookie, v.nowMs);
  const key = utmKey(v.utm);
  const countedToday = prev && prev.day === day ? prev.counted : [];
  if (countedToday.includes(key)) return { count: null, cookie: null, day };
  const first: FirstTouch = prev?.first ?? { ...v.utm, atMs: v.nowMs };
  return { count: v.utm, cookie: { first, day, counted: [...countedToday, key].slice(-MAX_COUNTED) }, day };
}

/** Seconds the cookie has left: 30 days from the first touch. */
export function utmCookieMaxAgeSeconds(c: UtmCookie, nowMs: number): number {
  return Math.max(1, Math.floor((c.first.atMs + UTM_COOKIE_TTL_MS - nowMs) / 1000));
}

/** Short-link campaigns named in a post's text (edgecoder.io/x/<campaign>). */
export function campaignsInText(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\/x\/([a-z0-9][a-z0-9-]{0,47})(?![a-z0-9-])/gi)) out.add(m[1]!.toLowerCase());
  return [...out];
}
