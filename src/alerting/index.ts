// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { Pool } from "pg";
import type { AlertConfig } from "./config.js";
import { AlertManager } from "./manager.js";
import { emailChannel, webhookChannel, type EmailSender, type WebhookPoster } from "./notify.js";
import { MemoryAlertStore, PostgresAlertStore, ResilientAlertStore, type AlertStore } from "./store.js";
import type { AlertChannel } from "./types.js";

export { AlertManager, DEFAULT_ALERT_LINK, SHARED_SOURCE } from "./manager.js";
export { AlertRunner } from "./runner.js";
export type { AlertConfig } from "./config.js";

/** The channels ALERT_EMAILS / ALERT_WEBHOOK_URL configure (none in development unless set). */
export function alertChannels(cfg: AlertConfig, senders: { email?: EmailSender; webhook?: WebhookPoster } = {}): AlertChannel[] {
  return [emailChannel({ apiKey: cfg.resendApiKey, from: cfg.resendFromEmail, to: cfg.emails }, senders.email), webhookChannel(cfg.webhookUrl, cfg.webhookFormat, senders.webhook)].filter(
    (c): c is AlertChannel => c !== null
  );
}

/** Postgres-backed (falling back to memory while the database is down), or memory only. */
export function alertStore(pool: Pool | null, onError?: (error: unknown, op: string) => void): AlertStore {
  return pool ? new ResilientAlertStore(new PostgresAlertStore(pool), new MemoryAlertStore(), onError) : new MemoryAlertStore();
}

export function createAlertManager(
  cfg: AlertConfig,
  o: {
    pool: Pool | null;
    sourceId: string;
    reporter: string;
    portalUrl: string;
    log?: { warn: (o: unknown, m: string) => void };
    now?: () => number;
    senders?: { email?: EmailSender; webhook?: WebhookPoster };
  }
): AlertManager {
  return new AlertManager({
    store: alertStore(o.pool, (error, op) => o.log?.warn({ op, error: error instanceof Error ? error.message : String(error) }, "alert_store_degraded_to_memory")),
    channels: alertChannels(cfg, o.senders),
    sourceId: o.sourceId,
    reporter: o.reporter,
    portalUrl: o.portalUrl,
    rateLimitMs: cfg.rateLimitMs,
    renotifyMs: cfg.renotifyMs,
    now: o.now,
    log: o.log
  });
}
