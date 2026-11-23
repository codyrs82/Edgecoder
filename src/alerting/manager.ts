// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Production alerting. Monitors (src/alerting/monitors.ts) report the conditions they find active;
 * the manager turns them into incidents and notifications:
 *
 *  - one incident per (source, key): repeated reports refresh it, they never notify again;
 *  - at most one notification per key per ALERT_RATE_LIMIT_MINUTES (15), across incidents, so a
 *    flapping check cannot flood the owner; a severity raised (warning to critical) notifies at once
 *    within that limit;
 *  - while still active and not acknowledged, a quiet reminder every ALERT_RENOTIFY_MINUTES
 *    (low priority on the webhook; 0 = never), or the alert's own renotifyMs when it sets one;
 *  - a resolution notice when it clears, for incidents the owner was told about;
 *  - acknowledging (admin page) stops reminders until the incident resolves.
 *
 * The clock is injected so every rule is tested with a fake one.
 */
import { randomUUID } from "node:crypto";
import type { AlertStore } from "./store.js";
import { SEVERITY_RANK, type AlertChannel, type AlertEvent, type AlertInput, type AlertNotification, type AlertRecord, type AlertScope, type NotificationKind } from "./types.js";

export const SHARED_SOURCE = "shared";

export interface AlertManagerOptions {
  store: AlertStore;
  channels: AlertChannel[];
  /** This process: "portal" or the coordinator's peer id. */
  sourceId: string;
  /** How it is named in messages: "portal", "coordinator seed-ord". */
  reporter: string;
  /** The portal's public origin, for links ("https://edgecoder.io"). */
  portalUrl: string;
  rateLimitMs: number;
  renotifyMs: number;
  now?: () => number;
  log?: { warn: (o: unknown, m: string) => void; info?: (o: unknown, m: string) => void };
}

export interface ChannelResult {
  channel: string;
  ok: boolean;
  error?: string;
}

export const DEFAULT_ALERT_LINK = "/portal/settings/network#alerts";

export class AlertManager {
  readonly sourceId: string;
  private readonly now: () => number;

  constructor(private readonly o: AlertManagerOptions) {
    this.sourceId = o.sourceId;
    this.now = o.now ?? Date.now;
  }

  /** State beyond incidents (the backup reports) lives in the same store. */
  get store(): AlertStore {
    return this.o.store;
  }

  get channels(): string[] {
    return this.o.channels.map((c) => c.name);
  }

  sourceFor(scope: AlertScope): string {
    return scope === "shared" ? SHARED_SOURCE : this.o.sourceId;
  }

  /** The sources this process shows and acknowledges: its own and the shared ones. */
  get sources(): string[] {
    return [this.o.sourceId, SHARED_SOURCE];
  }

  linkFor(link: string | null | undefined): string {
    const l = link || DEFAULT_ALERT_LINK;
    return /^https?:\/\//.test(l) ? l : `${this.o.portalUrl.replace(/\/+$/, "")}${l.startsWith("/") ? "" : "/"}${l}`;
  }

  /** Report a condition as active now. */
  async raise(scope: AlertScope, rule: string, input: AlertInput): Promise<AlertRecord> {
    const source = this.sourceFor(scope);
    const nowMs = this.now();
    const before = await this.o.store.get(source, input.key);
    const record = await this.o.store.open({ ...input, source, rule, nowMs });
    const opened = !before || before.status === "resolved";
    if (opened) await this.event(record, "raised", nowMs);
    const escalated = !opened && before !== null && SEVERITY_RANK[input.severity] > SEVERITY_RANK[before.severity];
    let kind: NotificationKind | null = null;
    let interval = this.o.rateLimitMs;
    const renotifyMs = input.renotifyMs ?? this.o.renotifyMs;
    if (record.notifyCount === 0 || escalated) kind = "firing";
    else if (!record.acknowledgedAtMs && renotifyMs > 0 && record.lastNotifiedMs !== null && nowMs - record.lastNotifiedMs >= renotifyMs) {
      kind = "renotify";
      interval = renotifyMs;
    }
    if (!kind) return record;
    const claimed = await this.o.store.claimNotify(source, input.key, nowMs, interval);
    if (!claimed) return record;
    await this.event(claimed, kind === "renotify" ? "renotified" : "notified", nowMs);
    await this.dispatch(kind, claimed, nowMs);
    return claimed;
  }

  /** Report a condition as cleared. */
  async resolve(scope: AlertScope, key: string): Promise<AlertRecord | null> {
    const source = this.sourceFor(scope);
    const nowMs = this.now();
    const resolved = await this.o.store.resolve(source, key, nowMs);
    if (!resolved) return null;
    await this.event(resolved, "resolved", nowMs);
    if (resolved.notifyCount > 0) await this.dispatch("resolved", resolved, nowMs);
    return resolved;
  }

  /**
   * A monitor's full answer for its rule: these conditions are active, so every other active
   * incident of the rule (in this scope) has cleared.
   */
  async apply(scope: AlertScope, rule: string, active: AlertInput[]): Promise<void> {
    const keys = new Set(active.map((a) => a.key));
    for (const a of active) await this.raise(scope, rule, a);
    const source = this.sourceFor(scope);
    for (const r of await this.o.store.listActive([source])) {
      if (r.rule === rule && !keys.has(r.key)) await this.resolve(scope, r.key);
    }
  }

  async acknowledge(source: string, key: string, by: string): Promise<AlertRecord | null> {
    if (!this.sources.includes(source)) return null;
    const nowMs = this.now();
    const r = await this.o.store.acknowledge(source, key, by, nowMs);
    if (r) await this.event(r, "acknowledged", nowMs, { by });
    return r;
  }

  async list(limit = 100): Promise<{ source: string; reporter: string; channels: string[]; active: AlertRecord[]; history: AlertEvent[] }> {
    const [active, history] = await Promise.all([this.o.store.listActive(this.sources), this.o.store.listEvents(this.sources, limit)]);
    active.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.firstSeenMs - a.firstSeenMs);
    return { source: this.o.sourceId, reporter: this.o.reporter, channels: this.channels, active, history };
  }

  /** "Send test alert": every channel, now, ignoring the rate limit. Never stored as an incident. */
  async sendTest(by: string): Promise<ChannelResult[]> {
    const nowMs = this.now();
    const alert: AlertRecord = {
      source: this.o.sourceId,
      key: `test:${randomUUID().slice(0, 8)}`,
      rule: "test",
      severity: "warning",
      title: "Test alert",
      summary: `A test alert sent by ${by} from the admin page. Alerting on ${this.o.reporter} reaches you through this channel.`,
      link: DEFAULT_ALERT_LINK,
      details: null,
      status: "active",
      firstSeenMs: nowMs,
      lastSeenMs: nowMs,
      resolvedAtMs: null,
      lastNotifiedMs: nowMs,
      notifyCount: 1,
      acknowledgedAtMs: null,
      acknowledgedBy: null
    };
    const results = await this.dispatch("test", alert, nowMs);
    await this.o.store.addEvent({ source: this.o.sourceId, key: alert.key, kind: "test", severity: null, title: alert.title, summary: alert.summary, atMs: nowMs, detail: { by, results } }).catch(() => undefined);
    return results;
  }

  private async dispatch(kind: NotificationKind, alert: AlertRecord, nowMs: number): Promise<ChannelResult[]> {
    const n: AlertNotification = { kind, alert, reporter: this.o.reporter, url: this.linkFor(alert.link), nowMs };
    const results: ChannelResult[] = [];
    for (const c of this.o.channels) {
      try {
        await c.send(n);
        results.push({ channel: c.name, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ channel: c.name, ok: false, error: message.slice(0, 200) });
        this.o.log?.warn({ channel: c.name, key: alert.key, error: message.slice(0, 200) }, "alert_notify_failed");
        if (kind !== "test") await this.event(alert, "notify_failed", nowMs, { channel: c.name, error: message.slice(0, 200) });
      }
    }
    if (!this.o.channels.length && kind !== "test") this.o.log?.warn({ key: alert.key, title: alert.title }, "alert_no_channel_configured");
    return results;
  }

  private async event(r: AlertRecord, kind: AlertEvent["kind"], atMs: number, detail?: Record<string, unknown>): Promise<void> {
    try {
      await this.o.store.addEvent({ source: r.source, key: r.key, kind, severity: r.severity, title: r.title, summary: r.summary, atMs, detail: detail ?? null });
    } catch (error) {
      this.o.log?.warn({ error: String(error) }, "alert_event_save_failed");
    }
  }
}
