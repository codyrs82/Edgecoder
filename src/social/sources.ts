// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { stripLeadingMentions, withUtm, X_MAX_WEIGHTED, xWeightedLength } from "./rules.js";
import type { NewDraft } from "./store.js";

/**
 * Where drafts come from. Each function turns data the portal can already see into drafts with a
 * stable source key, so a source is drafted once:
 *
 * - weekly:<ISO week>: the merged Settings > Network admin view over 7 days (hosts online now,
 *   jobs completed) and the coordinator's GET /admin/revenue (the Revenue page's numbers). Sats paid
 *   to hosts are derived from the fee income: each compute payment splits into the host's share and
 *   NETWORK_FEE_BPS for the network, so the hosts' share is fee x (10000 - bps) / bps.
 * - release:<product>:<version>: the GitHub releases listing the portal already reads for "update
 *   available" (src/portal/agent-release.ts): agent-vX.Y.Z and desktop-vX.Y.Z tags. iOS ships
 *   through the App Store with no listing the portal can see: iOS notes are written by hand.
 * - docs:<path>: <loc> entries of the docs sitemap not seen before.
 *
 * Release and docs sources are baselined on their first run (everything that exists then counts
 * as seen), so turning the feature on does not draft the whole back catalog.
 */

/** ISO-8601 week key (2026-W48) of a time, UTC. */
export function isoWeekKey(ms: number): string {
  const d = new Date(ms);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface WeeklyStats {
  /** Distinct accounts with at least one live agent now (agents online when owners are unknown). */
  hostsOnline: number | null;
  /** Model calls completed over the last 7 days, all coordinators. */
  jobs7d: number | null;
  /** Sats the hosts' share of compute payments came to over the last 7 days. */
  hostSats7d: number | null;
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

export function weeklyDraft(stats: WeeklyStats, nowMs: number, siteUrl: string | null = null): NewDraft | null {
  const lines: string[] = [];
  if (stats.hostsOnline !== null) lines.push(`• ${fmt(stats.hostsOnline)} ${stats.hostsOnline === 1 ? "host" : "hosts"} online`);
  if (stats.jobs7d !== null) lines.push(`• ${fmt(stats.jobs7d)} ${stats.jobs7d === 1 ? "job" : "jobs"} run`);
  if (stats.hostSats7d !== null) lines.push(`• ${fmt(stats.hostSats7d)} sats paid to hosts`);
  if (!lines.length) return null;
  const text = `The EdgeCoder network, last 7 days:\n${lines.join("\n")}${siteUrl ? `\n\n${withUtm(siteUrl, "x", "weekly")}` : ""}`;
  return { sourceKey: `weekly:${isoWeekKey(nowMs)}`, kind: "weekly", text };
}

type SeriesPoint = { atMs: number; completed?: unknown };
type NetworkView = {
  agents: Array<{ connected: boolean; blacklisted: boolean; userId?: string | null; accountId?: string | null }>;
  series: { points: SeriesPoint[] };
};

/** Hosts online and jobs over the window, from the merged admin network view (range 7d). */
export function networkWeekly(view: NetworkView | null, nowMs: number): Pick<WeeklyStats, "hostsOnline" | "jobs7d"> {
  if (!view) return { hostsOnline: null, jobs7d: null };
  const live = view.agents.filter((a) => a.connected && !a.blacklisted);
  const owners = new Set(live.map((a) => a.userId ?? a.accountId ?? null).filter((v): v is string => !!v));
  const hostsOnline = owners.size || live.length;
  const since = nowMs - 7 * 86_400_000;
  const points = view.series?.points ?? [];
  const jobs7d = points.length ? points.filter((p) => p.atMs >= since).reduce((a, p) => a + (typeof p.completed === "number" ? p.completed : 0), 0) : null;
  return { hostsOnline, jobs7d };
}

/** The hosts' share over the last 7 UTC days, from GET /admin/revenue (byDay fee income and the fee rate). */
export function hostSatsFromRevenue(revenue: { feeBps?: unknown; byDay?: Array<{ date: string; msat: number }> } | null, nowMs: number): number | null {
  const bps = Number(revenue?.feeBps);
  if (!revenue || !Array.isArray(revenue.byDay) || !Number.isFinite(bps) || bps <= 0 || bps >= 10_000) return null;
  const since = new Date(nowMs - 7 * 86_400_000).toISOString().slice(0, 10);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const feeMsat = revenue.byDay.filter((d) => d.date > since && d.date <= today).reduce((a, d) => a + (Number(d.msat) || 0), 0);
  return Math.floor((feeMsat * (10_000 - bps)) / bps / 1000);
}

// ── Releases ──

export type ReleaseProduct = "agent" | "desktop";
const RELEASE_TAG = /^(agent|desktop)-v(\d+)\.(\d+)\.(\d+)$/;

export interface ReleaseInfo {
  product: ReleaseProduct;
  version: string;
  url: string;
  notes: string;
}

const cmp = (a: string, b: string) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
};

/** The newest published, non-prerelease release per product in a GitHub releases listing. */
export function latestReleases(listing: unknown): Partial<Record<ReleaseProduct, ReleaseInfo>> {
  const out: Partial<Record<ReleaseProduct, ReleaseInfo>> = {};
  if (!Array.isArray(listing)) return out;
  for (const r of listing) {
    if (!r || typeof r !== "object") continue;
    const rel = r as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; html_url?: unknown; body?: unknown; name?: unknown };
    if (rel.draft || rel.prerelease || typeof rel.tag_name !== "string") continue;
    const m = RELEASE_TAG.exec(rel.tag_name);
    if (!m) continue;
    const product = m[1] as ReleaseProduct;
    const version = `${m[2]}.${m[3]}.${m[4]}`;
    const prev = out[product];
    if (prev && cmp(prev.version, version) >= 0) continue;
    const url = typeof rel.html_url === "string" && rel.html_url.startsWith("https://github.com/") ? rel.html_url : `https://github.com/codyrs82/Edgecoder/releases/tag/${rel.tag_name}`;
    out[product] = { product, version, url, notes: typeof rel.body === "string" ? rel.body : "" };
  }
  return out;
}

/** The first plain line of release notes: no headings, list markers, links or markdown. */
export function firstNotesLine(notes: string): string {
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/^>\s*/, "")
      .replace(/[`*]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!line || /^#/.test(raw.trim()) || /^(?:full changelog|what'?s changed|sha256|checksums?)\b/i.test(line) || /https?:\/\//.test(line)) continue;
    return stripLeadingMentions(line);
  }
  return "";
}

const PRODUCT_NAME: Record<ReleaseProduct, string> = { agent: "EdgeCoder agent", desktop: "EdgeCoder desktop app" };

export function releaseDraft(r: ReleaseInfo): NewDraft {
  const head = `${PRODUCT_NAME[r.product]} ${r.version} is out.`;
  let summary = firstNotesLine(r.notes);
  const fits = (s: string) => xWeightedLength(`${head}${s ? ` ${s}` : ""}\n\n${r.url}`) <= X_MAX_WEIGHTED;
  if (summary && !fits(summary)) summary = shortenToFit(summary, fits);
  return { sourceKey: `release:${r.product}:${r.version}`, kind: "release", text: `${head}${summary ? ` ${summary}` : ""}\n\n${r.url}` };
}

// ── Docs ──

/** The <loc> URLs of a sitemap on `host` (sitemap indexes are not followed). */
export function sitemapUrls(xml: string, host: string): string[] {
  const out = new Set<string>();
  for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    const raw = m[1]!.replace(/&amp;/g, "&");
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" && u.host === host && !/\.xml$/i.test(u.pathname)) out.add(`${u.origin}${u.pathname}`);
    } catch {
      /* not a URL */
    }
  }
  return [...out];
}

export const docsPath = (url: string) => new URL(url).pathname.replace(/\/+$/, "") || "/";

/** A page title from its HTML <title> (site suffix dropped), else from the path's last segment. */
export function docsTitle(url: string, html: string | null): string {
  const m = html ? /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html) : null;
  if (m) {
    const t = m[1]!
      .replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .split(/\s+[|·–—-]\s+/)[0]!
      .trim();
    if (t) return t;
  }
  const slug = docsPath(url).split("/").pop() || "docs";
  const words = slug.replace(/\.html?$/, "").replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function docsDraft(url: string, title: string): NewDraft {
  const link = withUtm(url, "x", "docs");
  const make = (s: string) => `New in the EdgeCoder docs: ${s}\n\n${link}`;
  let t = stripLeadingMentions(title.replace(/\s+/g, " ").trim());
  if (xWeightedLength(make(t)) > X_MAX_WEIGHTED) t = shortenToFit(t, (s) => xWeightedLength(make(s)) <= X_MAX_WEIGHTED) || "a new page";
  return { sourceKey: `docs:${docsPath(url)}`, kind: "docs", text: make(t) };
}

/** Drop whole words from the end (adding "…") until `fits`; "" when nothing fits. */
function shortenToFit(s: string, fits: (s: string) => boolean): string {
  const words = s.split(" ");
  while (words.length) {
    words.pop();
    const candidate = `${words.join(" ")}…`;
    if (words.length && fits(candidate)) return candidate;
  }
  return "";
}
