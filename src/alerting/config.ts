// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envEnum, envFlag, envInt, envNumber, envUrl, loadConfig } from "../common/config.js";

/*
 * Production alerting (src/alerting): who is told, how, and the thresholds of each rule. The portal
 * and every coordinator spread these into their schemas (src/portal/config.ts,
 * src/swarm/coordinator-config.ts) and read them with alertConfigFromEnv. Documented in
 * site-docs/reference/environment-variables.md ("Alerting").
 */
export const alertingEnv = {
  /** "0", "false", "off" or "no" stops every alert check on this process. */
  ALERT_ENABLED: envFlag({ off: ["0", "false", "off", "no"], ci: true }),
  /** Comma-separated recipients. Unset: no alert email (the admin page still lists alerts). */
  ALERT_EMAILS: z.string().optional(),
  /** Optional webhook for phone push (Slack incoming webhook, ntfy topic URL, Discord, or any JSON endpoint). */
  ALERT_WEBHOOK_URL: envUrl(),
  ALERT_WEBHOOK_FORMAT: envEnum(["auto", "slack", "ntfy", "json"]).default("auto"),
  /** Resend credentials (shared with the portal's transactional email); the coordinator needs them to email alerts. */
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().optional(),
  ALERT_CHECK_INTERVAL_MS: envInt(30_000, { min: 5_000, max: 3_600_000 }),
  ALERT_HEALTH_FAILURES: envInt(3, { min: 1, max: 100 }),
  ALERT_RATE_LIMIT_MINUTES: envInt(15, { min: 1, max: 1_440 }),
  ALERT_RENOTIFY_MINUTES: envInt(240, { min: 0, max: 10_080 }),
  /** Coordinator: the portal health URL its watch probes; default PORTAL_PUBLIC_URL + /health. */
  ALERT_PORTAL_HEALTH_URL: envUrl(),
  ALERT_LN_MIN_OUTBOUND_SATS: envInt(0, { min: 0 }),
  /** Inbound capacity (sats the node can still receive) below which the coordinator alerts; 0 = off. */
  ALERT_LN_MIN_INBOUND_SATS: envInt(300_000, { min: 0 }),
  /** Recovery needs ALERT_LN_MIN_INBOUND_SATS plus this, so a balance at the line does not flap. */
  ALERT_LN_INBOUND_HYSTERESIS_SATS: envInt(25_000, { min: 0 }),
  ALERT_LN_INBOUND_CHECK_MINUTES: envInt(10, { min: 1, max: 1_440 }),
  /** Reminder interval while inbound stays low and unacknowledged; 0 = never. */
  ALERT_LN_INBOUND_RENOTIFY_MINUTES: envInt(720, { min: 0, max: 10_080 }),
  ALERT_PAYOUT_FAILURES_PER_HOUR: envInt(3, { min: 1 }),
  ALERT_PAYOUT_PENDING_MINUTES: envInt(60, { min: 1 }),
  ALERT_PURCHASE_FAILURE_RATE: envNumber(0.5, { min: 0, max: 1 }),
  ALERT_PURCHASE_MIN_ATTEMPTS: envInt(5, { min: 1 }),
  ALERT_DB_ERRORS_PER_10MIN: envInt(5, { min: 1 }),
  ALERT_BACKUP_MAX_AGE_HOURS: envNumber(26, { min: 1 }),
  ALERT_BACKUP_EXPECTED: envFlag({ on: ["1", "true", "yes", "on"], ci: true }),
  ALERT_POPULAR_MODEL_MIN_CALLS_24H: envInt(20, { min: 1 }),
  ALERT_CAPACITY_GAP_MINUTES: envInt(10, { min: 1 }),
  ALERT_NO_CAPACITY_RATE: envNumber(0.25, { min: 0, max: 1 }),
  ALERT_NO_CAPACITY_MIN_CALLS: envInt(20, { min: 1 }),
  ALERT_AUTH_FAILURES_PER_10MIN: envInt(50, { min: 1 })
};

const schema = z.object(alertingEnv);
type Raw = z.infer<typeof schema>;

export interface AlertConfig {
  enabled: boolean;
  emails: string[];
  webhookUrl: string | null;
  webhookFormat: "auto" | "slack" | "ntfy" | "json";
  resendApiKey: string;
  resendFromEmail: string;
  checkIntervalMs: number;
  healthFailures: number;
  rateLimitMs: number;
  renotifyMs: number;
  portalHealthUrl: string | null;
  lnMinOutboundSats: number;
  lnMinInboundSats: number;
  lnInboundHysteresisSats: number;
  lnInboundCheckMs: number;
  lnInboundRenotifyMs: number;
  payoutFailuresPerHour: number;
  payoutPendingMs: number;
  purchaseFailureRate: number;
  purchaseMinAttempts: number;
  dbErrorsPer10Min: number;
  backupMaxAgeMs: number;
  backupExpected: boolean;
  popularModelMinCalls24h: number;
  capacityGapMs: number;
  noCapacityRate: number;
  noCapacityMinCalls: number;
  authFailuresPer10Min: number;
}

export function alertConfigFrom(raw: Raw): AlertConfig {
  return {
    enabled: raw.ALERT_ENABLED,
    emails: (raw.ALERT_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.includes("@")),
    webhookUrl: raw.ALERT_WEBHOOK_URL ?? null,
    webhookFormat: raw.ALERT_WEBHOOK_FORMAT,
    resendApiKey: raw.RESEND_API_KEY ?? "",
    resendFromEmail: raw.RESEND_FROM_EMAIL ?? "",
    checkIntervalMs: raw.ALERT_CHECK_INTERVAL_MS,
    healthFailures: raw.ALERT_HEALTH_FAILURES,
    rateLimitMs: raw.ALERT_RATE_LIMIT_MINUTES * 60_000,
    renotifyMs: raw.ALERT_RENOTIFY_MINUTES * 60_000,
    portalHealthUrl: raw.ALERT_PORTAL_HEALTH_URL ?? null,
    lnMinOutboundSats: raw.ALERT_LN_MIN_OUTBOUND_SATS,
    lnMinInboundSats: raw.ALERT_LN_MIN_INBOUND_SATS,
    lnInboundHysteresisSats: raw.ALERT_LN_INBOUND_HYSTERESIS_SATS,
    lnInboundCheckMs: raw.ALERT_LN_INBOUND_CHECK_MINUTES * 60_000,
    lnInboundRenotifyMs: raw.ALERT_LN_INBOUND_RENOTIFY_MINUTES * 60_000,
    payoutFailuresPerHour: raw.ALERT_PAYOUT_FAILURES_PER_HOUR,
    payoutPendingMs: raw.ALERT_PAYOUT_PENDING_MINUTES * 60_000,
    purchaseFailureRate: raw.ALERT_PURCHASE_FAILURE_RATE,
    purchaseMinAttempts: raw.ALERT_PURCHASE_MIN_ATTEMPTS,
    dbErrorsPer10Min: raw.ALERT_DB_ERRORS_PER_10MIN,
    backupMaxAgeMs: raw.ALERT_BACKUP_MAX_AGE_HOURS * 3_600_000,
    backupExpected: raw.ALERT_BACKUP_EXPECTED,
    popularModelMinCalls24h: raw.ALERT_POPULAR_MODEL_MIN_CALLS_24H,
    capacityGapMs: raw.ALERT_CAPACITY_GAP_MINUTES * 60_000,
    noCapacityRate: raw.ALERT_NO_CAPACITY_RATE,
    noCapacityMinCalls: raw.ALERT_NO_CAPACITY_MIN_CALLS,
    authFailuresPer10Min: raw.ALERT_AUTH_FAILURES_PER_10MIN
  };
}

/** Validated alert settings (throws ConfigError on a bad value; the service schemas already checked them at startup). */
export function alertConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  return alertConfigFrom(loadConfig("alerting", schema, env));
}
