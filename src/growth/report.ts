// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * What the owner reads: the new-sign-up alert, the batch of held alerts, the daily digest, and the
 * campaign -> social post mapping shared with the admin panel. Pure text/HTML builders.
 */
import type { SocialPost } from "../social/store.js";
import { tweetUrl } from "../social/x-client.js";
import { campaignsInText, chicagoTime, type Utm } from "./attribution.js";
import type { DailyRow, SignupRecord } from "./store.js";

export interface PostRef {
  id: string;
  status: string;
  xUrl: string | null;
  snippet: string;
}

export interface Email {
  subject: string;
  text: string;
  html: string;
}

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const RANK: Record<string, number> = { posted: 0, posting: 1, approved: 2, draft: 3, failed: 4, rejected: 5 };

/** Each short-link campaign to the post that carries it: a posted one first, then the most recent. */
export function postsByCampaign(posts: SocialPost[]): Map<string, PostRef> {
  const out = new Map<string, { ref: PostRef; rank: number; at: number }>();
  for (const p of posts) {
    const rank = RANK[p.status] ?? 9;
    const at = p.postedAtMs ?? p.updatedAtMs;
    for (const c of campaignsInText(p.text)) {
      const cur = out.get(c);
      if (cur && (cur.rank < rank || (cur.rank === rank && cur.at >= at))) continue;
      const flat = p.text.replace(/\s+/g, " ").trim();
      out.set(c, { rank, at, ref: { id: p.id, status: p.status, xUrl: p.xTweetId ? tweetUrl(p.xTweetId) : null, snippet: flat.length > 90 ? `${flat.slice(0, 89)}…` : flat } });
    }
  }
  return new Map([...out].map(([k, v]) => [k, v.ref]));
}

export const METHOD_LABEL: Record<string, string> = { email: "email and password", google: "Google", microsoft: "Microsoft", github: "GitHub" };

export function campaignLabel(u: Utm | null): string {
  if (!u) return "none (direct or untagged)";
  return [u.source || "?", u.medium || "?", u.campaign || "?"].join(" / ") + (u.content ? ` (${u.content})` : "");
}

export interface SignupAlertInput {
  email: string;
  method: string;
  createdAtMs: number;
  first: Utm | null;
  post: PostRef | null;
  adminUrl: string;
}

export function signupAlertEmail(s: SignupAlertInput): Email {
  const method = METHOD_LABEL[s.method] ?? s.method;
  const lines: Array<[string, string]> = [
    ["Email", s.email],
    ["Signed up with", method],
    ["Time", chicagoTime(s.createdAtMs)],
    ["Campaign", campaignLabel(s.first)]
  ];
  if (s.post) lines.push(["Post", s.post.xUrl ?? `${s.post.snippet} (${s.post.status})`]);
  lines.push(["Admin", s.adminUrl]);
  return {
    subject: `New EdgeCoder sign-up: ${s.email}`,
    text: lines.map(([k, v]) => `${k}: ${v}`).join("\n"),
    html: `<h2 style="margin:0 0 8px">New sign-up</h2><table style="font-size:14px">${lines
      .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${esc(k)}</td><td>${/^https:\/\//.test(v) ? `<a href="${esc(v)}">${esc(v)}</a>` : esc(v)}</td></tr>`)
      .join("")}</table>`
  };
}

/** Held alerts (more than the hourly limit) as one message. */
export function signupBatchEmail(signups: Array<SignupRecord & { ignoredNow?: boolean }>, adminUrl: string): Email {
  const shown = signups.filter((s) => !s.ignoredNow);
  const lines = shown.map((s) => `${s.email} · ${METHOD_LABEL[s.method] ?? s.method} · ${chicagoTime(s.createdAtMs)} · ${campaignLabel(s.first)}`);
  return {
    subject: `EdgeCoder: ${shown.length} more new sign-up${shown.length === 1 ? "" : "s"}`,
    text: [`${shown.length} sign-ups arrived after the hourly alert limit:`, ...lines, `Admin: ${adminUrl}`].join("\n"),
    html: `<h2 style="margin:0 0 8px">${shown.length} more new sign-up${shown.length === 1 ? "" : "s"}</h2><p>These arrived after the hourly alert limit.</p><ul>${lines
      .map((l) => `<li>${esc(l)}</li>`)
      .join("")}</ul><p><a href="${esc(adminUrl)}">${esc(adminUrl)}</a></p>`
  };
}

export interface DigestInput {
  day: string;
  rows: DailyRow[];
  signups: SignupRecord[];
  isIgnored: (email: string) => boolean;
  posts: Map<string, PostRef>;
  panelUrl: string;
}

export function digestEmail(d: DigestInput): Email {
  const visits = d.rows.reduce((n, r) => n + r.visits, 0);
  const tagged = d.rows.reduce((n, r) => n + r.signups, 0);
  const real = d.signups.filter((s) => !s.ignored && !d.isIgnored(s.email));
  const ignored = d.signups.length - real.length;
  const subject = `EdgeCoder daily ${d.day}: ${visits} visit${visits === 1 ? "" : "s"} from campaigns, ${real.length} sign-up${real.length === 1 ? "" : "s"}`;
  if (visits === 0 && real.length === 0) {
    const line = `${d.day}: no campaign visits and no new sign-ups${ignored ? ` (${ignored} from ignored accounts)` : ""}.`;
    return { subject, text: line, html: `<p>${esc(line)}</p>` };
  }
  const rows = [...d.rows].sort((a, b) => b.visits - a.visits || b.signups - a.signups || a.campaign.localeCompare(b.campaign));
  const postOf = (r: DailyRow) => (r.source === "x" ? (d.posts.get(r.campaign) ?? null) : null);
  const text: string[] = [`Campaign visits on ${d.day} (America/Chicago): ${visits} visits, ${tagged} sign-ups credited to a campaign.`];
  for (const r of rows) {
    const p = postOf(r);
    text.push(`  ${r.campaign || "(no campaign)"} · ${r.source}/${r.medium}${r.content ? ` · ${r.content}` : ""} · ${r.visits} visits · ${r.signups} sign-ups${p?.xUrl ? ` · ${p.xUrl}` : ""}`);
  }
  text.push("", `New sign-ups: ${real.length}${ignored ? ` (plus ${ignored} from ignored accounts)` : ""}`);
  for (const s of real) text.push(`  ${s.email} · ${METHOD_LABEL[s.method] ?? s.method} · ${campaignLabel(s.first)}`);
  text.push("", `Last 14 days: ${d.panelUrl}`);
  const td = (v: unknown, right = false) => `<td style="padding:3px 10px 3px 0;${right ? "text-align:right;" : ""}">${v}</td>`;
  const table = rows.length
    ? `<table style="font-size:13px;border-collapse:collapse"><tr>${["Campaign", "Medium", "Content", "Visits", "Sign-ups"].map((h) => `<th style="text-align:left;padding:3px 10px 3px 0;color:#666">${h}</th>`).join("")}</tr>${rows
        .map((r) => {
          const p = postOf(r);
          const name = esc(r.campaign || "(no campaign)");
          return `<tr>${td(p?.xUrl ? `<a href="${esc(p.xUrl)}">${name}</a>` : name)}${td(esc(`${r.source}/${r.medium}`))}${td(esc(r.content))}${td(r.visits, true)}${td(r.signups, true)}</tr>`;
        })
        .join("")}<tr>${td("<b>Total</b>")}${td("")}${td("")}${td(`<b>${visits}</b>`, true)}${td(`<b>${tagged}</b>`, true)}</tr></table>`
    : "<p>No campaign visits.</p>";
  const list = real.length ? `<ul>${real.map((s) => `<li>${esc(`${s.email} · ${METHOD_LABEL[s.method] ?? s.method} · ${campaignLabel(s.first)}`)}</li>`).join("")}</ul>` : "";
  return {
    subject,
    text: text.join("\n"),
    html: `<h2 style="margin:0 0 8px">Yesterday (${esc(d.day)}, America/Chicago)</h2>${table}<h3 style="margin:16px 0 4px">New sign-ups: ${real.length}${ignored ? ` <span style="color:#666;font-weight:normal">(plus ${ignored} from ignored accounts)</span>` : ""}</h3>${list}<p><a href="${esc(d.panelUrl)}">Last 14 days</a></p>`
  };
}
