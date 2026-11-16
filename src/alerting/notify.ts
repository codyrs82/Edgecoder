// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Alert channels: email through Resend (src/common/resend.ts, the portal's sender) and an optional
 * webhook (Slack incoming webhook, ntfy topic for phone push, Discord, or any JSON endpoint).
 * Every message says what is wrong, since when, who saw it, and links to the admin page.
 */
import { request } from "undici";
import { postResendEmail, type ResendMessage } from "../common/resend.js";
import type { AlertChannel, AlertNotification } from "./types.js";

const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** "3 h 12 min", "45 s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

const PREFIX: Record<AlertNotification["kind"], string> = { firing: "", renotify: "Still active: ", resolved: "Resolved: ", test: "" };

/** The subject / headline of a notification. */
export function alertHeadline(n: AlertNotification): string {
  const sev = n.kind === "resolved" || n.kind === "test" ? "" : `[${n.alert.severity.toUpperCase()}] `;
  return `${sev}${PREFIX[n.kind]}${n.alert.title}`;
}

/** Plain-text body (webhooks, the email's text part). */
export function alertText(n: AlertNotification): string {
  const a = n.alert;
  const since = new Date(a.firstSeenMs).toISOString();
  const lines = [alertHeadline(n)];
  if (n.kind === "resolved") {
    lines.push(`Cleared after ${formatDuration((a.resolvedAtMs ?? n.nowMs) - a.firstSeenMs)} (since ${since}).`);
    lines.push(`Was: ${a.summary}`);
  } else {
    lines.push(a.summary);
    if (n.kind !== "test") lines.push(`Since: ${since} (${formatDuration(n.nowMs - a.firstSeenMs)} ago)`);
    if (a.acknowledgedAtMs) lines.push(`Acknowledged by ${a.acknowledgedBy ?? "an admin"}.`);
  }
  lines.push(`Seen by: ${n.reporter}`);
  for (const [k, v] of Object.entries(a.details ?? {}).slice(0, 8)) lines.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  lines.push(`Details: ${n.url}`);
  return lines.join("\n");
}

export function alertHtml(n: AlertNotification): string {
  const a = n.alert;
  const color = n.kind === "resolved" ? "#2e7d32" : n.kind === "test" ? "#455a64" : a.severity === "critical" ? "#c62828" : "#ef6c00";
  const rows = Object.entries(a.details ?? {})
    .slice(0, 12)
    .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${esc(k)}</td><td>${esc(typeof v === "object" ? JSON.stringify(v) : v)}</td></tr>`)
    .join("");
  const when =
    n.kind === "resolved"
      ? `<p>Cleared after ${esc(formatDuration((a.resolvedAtMs ?? n.nowMs) - a.firstSeenMs))}. It started at ${esc(new Date(a.firstSeenMs).toISOString())}.</p>`
      : n.kind === "test"
        ? ""
        : `<p>Since ${esc(new Date(a.firstSeenMs).toISOString())} (${esc(formatDuration(n.nowMs - a.firstSeenMs))} ago).</p>`;
  return `
    <h2 style="color:${color};margin:0 0 8px">${esc(alertHeadline(n))}</h2>
    <p>${n.kind === "resolved" ? "Was: " : ""}${esc(a.summary)}</p>
    ${when}
    <p>Seen by ${esc(n.reporter)}.${a.acknowledgedAtMs && n.kind !== "resolved" ? ` Acknowledged by ${esc(a.acknowledgedBy ?? "an admin")}.` : ""}</p>
    ${rows ? `<table style="font-size:13px">${rows}</table>` : ""}
    <p><a href="${esc(n.url)}">${esc(n.url)}</a></p>
    <p style="color:#888;font-size:12px">Alert key ${esc(a.key)}. Acknowledge it on the admin page to stop reminders.</p>`;
}

export type EmailSender = (m: ResendMessage) => Promise<void>;

export function emailChannel(cfg: { apiKey: string; from: string; to: string[] }, send: EmailSender = (m) => postResendEmail(m, "alert_email")): AlertChannel | null {
  if (!cfg.apiKey || !cfg.from || cfg.to.length === 0) return null;
  return {
    name: "email",
    async send(n) {
      await send({ apiKey: cfg.apiKey, from: cfg.from, to: cfg.to, subject: `EdgeCoder alert: ${alertHeadline(n)}`, html: alertHtml(n), text: alertText(n) });
    }
  };
}

export type WebhookFormat = "slack" | "ntfy" | "json";

export function webhookFormatFor(url: string, configured: "auto" | WebhookFormat): WebhookFormat {
  if (configured !== "auto") return configured;
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (host === "hooks.slack.com") return "slack";
  if (host === "ntfy.sh" || host.startsWith("ntfy.")) return "ntfy";
  return "json";
}

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** What a webhook receives: the body and headers for the format. Exported for tests. */
export function webhookRequest(url: string, format: WebhookFormat, n: AlertNotification): WebhookRequest {
  const text = alertText(n);
  if (format === "ntfy") {
    // ntfy: plain body, headers for the title, priority (5 max .. 1 min), tags and the click target.
    const priority = n.kind === "resolved" || n.kind === "renotify" ? "2" : n.kind === "test" ? "3" : n.alert.severity === "critical" ? "5" : "4";
    const tag = n.kind === "resolved" ? "white_check_mark" : n.kind === "test" ? "test_tube" : n.alert.severity === "critical" ? "rotating_light" : "warning";
    // Header values must be ASCII.
    const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, "?");
    return { url, headers: { "content-type": "text/plain; charset=utf-8", Title: ascii(alertHeadline(n)).slice(0, 200), Priority: priority, Tags: tag, Click: ascii(n.url) }, body: text };
  }
  if (format === "slack") return { url, headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) };
  return {
    url,
    headers: { "content-type": "application/json" },
    // `text` for Slack-compatible receivers, `content` for Discord; the structured alert for anything else.
    body: JSON.stringify({
      text,
      content: text.slice(0, 1_900),
      event: n.kind,
      reporter: n.reporter,
      url: n.url,
      alert: {
        key: n.alert.key,
        rule: n.alert.rule,
        severity: n.alert.severity,
        title: n.alert.title,
        summary: n.alert.summary,
        status: n.alert.status,
        firstSeenMs: n.alert.firstSeenMs,
        resolvedAtMs: n.alert.resolvedAtMs,
        details: n.alert.details
      }
    })
  };
}

export type WebhookPoster = (r: WebhookRequest) => Promise<void>;

async function postWebhook(r: WebhookRequest): Promise<void> {
  const res = await request(r.url, { method: "POST", headers: r.headers, body: r.body, headersTimeout: 10_000, bodyTimeout: 10_000 });
  try {
    await res.body.text();
  } catch {
    // ignore
  }
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`alert_webhook_failed:${res.statusCode}`);
}

export function webhookChannel(url: string | null, format: "auto" | WebhookFormat, post: WebhookPoster = postWebhook): AlertChannel | null {
  if (!url) return null;
  const f = webhookFormatFor(url, format);
  return { name: `webhook:${f}`, send: (n) => post(webhookRequest(url, f, n)) };
}
