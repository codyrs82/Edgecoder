// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/** Production alerting (src/alerting/manager.ts): the shapes shared by the store, the channels and the monitors. */

export type AlertSeverity = "critical" | "warning";

export const SEVERITY_RANK: Record<AlertSeverity, number> = { warning: 1, critical: 2 };

/**
 * Where an alert's state lives. "local": this process's own observation (its LND, its view of a
 * peer). "shared": a fact about data every coordinator on the same database sees (payouts, the
 * ledger), so the coordinators share one incident and one notification.
 */
export type AlertScope = "local" | "shared";

/** One condition a monitor found active. */
export interface AlertInput {
  /** Stable incident key within the rule, e.g. "coordinator_down:seed-eu.fly.dev". */
  key: string;
  severity: AlertSeverity;
  title: string;
  /** What is wrong, in one or two sentences. */
  summary: string;
  /** Path on the portal (e.g. /portal/settings/network#alerts) or an absolute URL. */
  link?: string;
  /** When the problem started, when the monitor knows better than "now" (first failed probe). */
  sinceMs?: number;
  details?: Record<string, unknown>;
}

export interface AlertRecord {
  source: string;
  key: string;
  rule: string;
  severity: AlertSeverity;
  title: string;
  summary: string;
  link: string | null;
  details: Record<string, unknown> | null;
  status: "active" | "resolved";
  firstSeenMs: number;
  lastSeenMs: number;
  resolvedAtMs: number | null;
  /** Last notification about this key (kept across incidents, so a flapping key is rate-limited too). */
  lastNotifiedMs: number | null;
  /** Notifications sent for the current incident. */
  notifyCount: number;
  acknowledgedAtMs: number | null;
  acknowledgedBy: string | null;
}

export type AlertEventKind = "raised" | "notified" | "renotified" | "resolved" | "acknowledged" | "notify_failed" | "test";

export interface AlertEvent {
  source: string;
  key: string;
  kind: AlertEventKind;
  severity: AlertSeverity | null;
  title: string;
  summary: string;
  atMs: number;
  detail?: Record<string, unknown> | null;
}

export type NotificationKind = "firing" | "renotify" | "resolved" | "test";

export interface AlertNotification {
  kind: NotificationKind;
  alert: AlertRecord;
  /** Who observed it, e.g. "portal" or "coordinator seed-ord". */
  reporter: string;
  /** Absolute link to the admin page. */
  url: string;
  nowMs: number;
}

export interface AlertChannel {
  readonly name: string;
  send(n: AlertNotification): Promise<void>;
}
