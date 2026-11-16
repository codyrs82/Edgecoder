import { describe, expect, it } from "vitest";
import { alertChannels } from "../../src/alerting/index.js";
import { alertConfigFromEnv } from "../../src/alerting/config.js";
import { AlertManager } from "../../src/alerting/manager.js";
import { MemoryAlertStore } from "../../src/alerting/store.js";
import { webhookFormatFor, webhookRequest, type WebhookRequest } from "../../src/alerting/notify.js";
import type { ResendMessage } from "../../src/common/resend.js";
import type { AlertNotification, AlertRecord } from "../../src/alerting/types.js";

const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);
const record = (over: Partial<AlertRecord> = {}): AlertRecord => ({
  source: "portal", key: "coordinator_down:seed-eu", rule: "coordinator_health", severity: "critical", title: "Coordinator seed-eu is down or unhealthy",
  summary: "Coordinator seed-eu failed 3 health checks in a row: ECONNREFUSED.", link: "/portal/settings/network#alerts", details: { url: "https://seed-eu/health/runtime", consecutiveFailures: 3 },
  status: "active", firstSeenMs: T0, lastSeenMs: T0, resolvedAtMs: null, lastNotifiedMs: T0, notifyCount: 1, acknowledgedAtMs: null, acknowledgedBy: null, ...over
});
const note = (kind: AlertNotification["kind"], over: Partial<AlertRecord> = {}): AlertNotification => ({ kind, alert: record(over), reporter: "portal", url: "https://edgecoder.example/portal/settings/network#alerts", nowMs: T0 + 5 * 60_000 });

describe("alert channels from the environment", () => {
  it("none without ALERT_EMAILS / ALERT_WEBHOOK_URL (development sends nothing)", () => {
    expect(alertChannels(alertConfigFromEnv({}))).toEqual([]);
    // Email needs the Resend credentials as well as recipients.
    expect(alertChannels(alertConfigFromEnv({ ALERT_EMAILS: "owner@example.test" }))).toEqual([]);
  });

  it("email to every recipient and the webhook, through the injected senders", async () => {
    const mails: ResendMessage[] = [];
    const hooks: WebhookRequest[] = [];
    const cfg = alertConfigFromEnv({ ALERT_EMAILS: "owner@example.test, ops@example.test", RESEND_API_KEY: "re_test", RESEND_FROM_EMAIL: "EdgeCoder <alerts@example.test>", ALERT_WEBHOOK_URL: "https://ntfy.sh/edgecoder-secret" });
    const channels = alertChannels(cfg, { email: async (m) => void mails.push(m), webhook: async (r) => void hooks.push(r) });
    expect(channels.map((c) => c.name)).toEqual(["email", "webhook:ntfy"]);
    const m = new AlertManager({ store: new MemoryAlertStore(), channels, sourceId: "portal", reporter: "portal", portalUrl: "https://edgecoder.example", rateLimitMs: 900_000, renotifyMs: 0, now: () => T0 });
    await m.raise("local", "coordinator_health", { key: "coordinator_down:seed-eu", severity: "critical", title: "Coordinator seed-eu is down or unhealthy", summary: "3 failed checks", link: "/portal/settings/network#alerts" });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ apiKey: "re_test", from: "EdgeCoder <alerts@example.test>", to: ["owner@example.test", "ops@example.test"], subject: "EdgeCoder alert: [CRITICAL] Coordinator seed-eu is down or unhealthy" });
    expect(mails[0]!.html).toContain('href="https://edgecoder.example/portal/settings/network#alerts"');
    expect(mails[0]!.text).toContain("Since: 2026-11-16T12:00:00.000Z");
    expect(hooks[0]!.headers.Title).toBe("[CRITICAL] Coordinator seed-eu is down or unhealthy");
  });

  it("rejects a bad value", () => {
    expect(() => alertConfigFromEnv({ ALERT_WEBHOOK_FORMAT: "teams" })).toThrow(/ALERT_WEBHOOK_FORMAT/);
    expect(() => alertConfigFromEnv({ ALERT_LN_MIN_OUTBOUND_SATS: "lots" })).toThrow(/ALERT_LN_MIN_OUTBOUND_SATS/);
  });
});

describe("webhook payloads", () => {
  it("picks the format from the host", () => {
    expect(webhookFormatFor("https://hooks.slack.com/services/T/B/X", "auto")).toBe("slack");
    expect(webhookFormatFor("https://ntfy.sh/topic", "auto")).toBe("ntfy");
    expect(webhookFormatFor("https://ntfy.example.org/topic", "auto")).toBe("ntfy");
    expect(webhookFormatFor("https://discord.com/api/webhooks/1/x", "auto")).toBe("json");
    expect(webhookFormatFor("https://hooks.slack.com/x", "json")).toBe("json");
  });

  it("slack: one text field with what, since when, who and the link", () => {
    const r = webhookRequest("https://hooks.slack.com/x", "slack", note("firing"));
    const body = JSON.parse(r.body);
    expect(Object.keys(body)).toEqual(["text"]);
    expect(body.text).toBe(
      [
        "[CRITICAL] Coordinator seed-eu is down or unhealthy",
        "Coordinator seed-eu failed 3 health checks in a row: ECONNREFUSED.",
        "Since: 2026-11-16T12:00:00.000Z (5 min ago)",
        "Seen by: portal",
        "url: https://seed-eu/health/runtime",
        "consecutiveFailures: 3",
        "Details: https://edgecoder.example/portal/settings/network#alerts"
      ].join("\n")
    );
  });

  it("ntfy: priorities by kind, ASCII headers, click-through link", () => {
    const fire = webhookRequest("https://ntfy.sh/t", "ntfy", note("firing"));
    expect(fire.headers).toMatchObject({ Priority: "5", Tags: "rotating_light", Click: "https://edgecoder.example/portal/settings/network#alerts" });
    expect(webhookRequest("https://ntfy.sh/t", "ntfy", note("firing", { severity: "warning" })).headers.Priority).toBe("4");
    expect(webhookRequest("https://ntfy.sh/t", "ntfy", note("renotify")).headers.Priority).toBe("2");
    const resolved = webhookRequest("https://ntfy.sh/t", "ntfy", note("resolved", { status: "resolved", resolvedAtMs: T0 + 3_600_000 }));
    expect(resolved.headers).toMatchObject({ Title: "Resolved: Coordinator seed-eu is down or unhealthy", Priority: "2", Tags: "white_check_mark" });
    expect(resolved.body).toContain("Cleared after 1 h 0 min");
    expect(webhookRequest("https://ntfy.sh/t", "ntfy", note("firing", { title: "Host at critical memory pressure: mac·1 — ✓" })).headers.Title).toMatch(/^[\x20-\x7e]+$/);
  });

  it("json: text, content (Discord) and the structured alert", () => {
    const body = JSON.parse(webhookRequest("https://hooks.example/x", "json", note("renotify", { acknowledgedAtMs: null })).body);
    expect(body.event).toBe("renotify");
    expect(body.text.startsWith("[CRITICAL] Still active: Coordinator seed-eu")).toBe(true);
    expect(body.content).toBe(body.text);
    expect(body.alert).toMatchObject({ key: "coordinator_down:seed-eu", severity: "critical", status: "active", firstSeenMs: T0 });
  });
});
