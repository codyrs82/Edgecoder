// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Production alerting on the portal (src/alerting) and the Alerts section of Settings > Network.
 *
 * The portal watches what a coordinator cannot report about itself: every coordinator's
 * GET /health/runtime (N failures in a row), the network as a whole (a popular model with no agent
 * online, a host at critical memory pressure, a no-capacity spike), its own database, and the
 * Postgres backups the scheduled ops check reports (POST /internal/alerts/backup-report, from
 * scripts/ops/report-pg-backups.sh; nothing in the app can list Fly backups itself).
 *
 * Admin API (system admins, session):
 *   GET  /portal/api/admin/alerts       the portal's and every coordinator's alerts, merged
 *   POST /portal/api/admin/alerts/ack   { origin, source, key }: origin "portal" or a coordinator URL
 *   POST /portal/api/admin/alerts/test  send a test alert from the portal and every coordinator
 */
import type { FastifyInstance } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { request } from "undici";
import { z } from "zod";
import type { Pool } from "pg";
import { alertConfigFromEnv, type AlertConfig } from "../alerting/config.js";
import { AlertRunner, SHARED_SOURCE, createAlertManager, type AlertManager } from "../alerting/index.js";
import { pgPoolErrorCount } from "../db/pool.js";
import { loadMergedNetwork, type NetworkAdminRoutesDeps } from "./routes/network-admin.js";
import { backupMonitor, capacityMonitor, databaseMonitor, healthWatchMonitor, type BackupReport, type CapacityView, type Monitor } from "../alerting/monitors.js";
import type { AlertEvent, AlertRecord } from "../alerting/types.js";

export const BACKUP_STATE = "pg_backups";

export interface PortalAlertDeps {
  manager: AlertManager;
  config: AlertConfig;
  coordinatorAdminToken: string;
  timeoutMs: number;
  coordinatorUrls: () => Promise<string[]>;
  getCurrentUser: (req: { headers: Record<string, unknown> }) => Promise<{ userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean } | null>;
  buildAccessContext: (user: { userId: string; email: string; role?: "user" | "admin"; emailVerified?: boolean }) => Promise<{ isSystemAdmin: boolean }>;
}

const digest = (v: string) => createHash("sha256").update(v).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));
const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/+$/, "");

/** The portal's monitors. `network` is the merged admin view (src/portal/routes/network-admin.ts). */
export function portalMonitors(o: {
  config: AlertConfig;
  coordinatorUrls: () => Promise<string[]>;
  network: (() => Promise<CapacityView | null>) | null;
  backups: () => Promise<BackupReport[]>;
  db: { errorCount: () => number; probe: () => Promise<void> } | null;
  startedAtMs: number;
}): Monitor[] {
  const c = o.config;
  const monitors: Monitor[] = [
    healthWatchMonitor({
      name: "coordinator_health",
      what: "coordinator",
      targets: async () => [...new Set((await o.coordinatorUrls()).map((u) => u.replace(/\/+$/, "")))].map((u) => ({ url: `${u}/health/runtime`, label: host(u) })),
      failures: c.healthFailures,
      minDownMs: c.healthMinDownMs,
      observer: "the portal"
    }),
    backupMonitor({ reports: o.backups, maxAgeMs: c.backupMaxAgeMs, expected: c.backupExpected, startedAtMs: o.startedAtMs })
  ];
  const network = o.network;
  if (network) {
    monitors.push(
      capacityMonitor({
        view: async () => {
          const v = await network();
          if (!v) throw new Error("no_coordinator_answered");
          return v;
        },
        popularMinCalls24h: c.popularModelMinCalls24h,
        gapMs: c.capacityGapMs,
        noCapacityRate: c.noCapacityRate,
        noCapacityMinCalls: c.noCapacityMinCalls
      })
    );
  }
  if (o.db) monitors.push(databaseMonitor({ errorCount: o.db.errorCount, probe: o.db.probe, errorsPer10Min: c.dbErrorsPer10Min, failures: c.healthFailures, label: "portal" }));
  return monitors;
}

/** Stored backup reports, one per database. */
export async function readBackupReports(manager: Pick<AlertManager, "store">): Promise<BackupReport[]> {
  const s = await manager.store.getState<{ apps?: Record<string, Omit<BackupReport, "app">> }>(BACKUP_STATE);
  return Object.entries(s?.value?.apps ?? {}).map(([app, r]) => ({ app, ...r }));
}

type CoordinatorAlerts = { source: string; reporter: string; channels: string[]; enabled?: boolean; active: AlertRecord[]; history: AlertEvent[] };
type Origin = { origin: string; ok: true; data: CoordinatorAlerts } | { origin: string; ok: false; error: string; status?: number };

async function coordinatorCall(url: string, path: string, token: string, timeoutMs: number, body?: unknown): Promise<{ status: number; json: any }> {
  try {
    const res = await request(`${url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-admin-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.body.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = {};
    }
    return { status: res.statusCode, json };
  } catch {
    return { status: 0, json: { error: "coordinator_unreachable" } };
  }
}

/** The portal's own alerts and every coordinator's, as one list; shared incidents (both seeds) once. */
export function mergeAlerts(portal: CoordinatorAlerts & { enabled: boolean }, coordinators: Origin[]) {
  const sources: Array<{ origin: string; ok: boolean; reporter: string; channels: string[]; enabled: boolean; error?: string }> = [{ origin: "portal", ok: true, reporter: portal.reporter, channels: portal.channels, enabled: portal.enabled }];
  const active: Array<AlertRecord & { origin: string; reporter: string }> = portal.active.map((a) => ({ ...a, origin: "portal", reporter: portal.reporter }));
  const history: Array<AlertEvent & { origin: string; reporter: string }> = portal.history.map((e) => ({ ...e, origin: "portal", reporter: portal.reporter }));
  const sharedSeen = new Set<string>();
  const sharedEventSeen = new Set<string>();
  for (const c of coordinators) {
    if (!c.ok) {
      sources.push({ origin: c.origin, ok: false, reporter: host(c.origin), channels: [], enabled: false, error: c.error });
      continue;
    }
    const reporter = c.data.reporter;
    sources.push({ origin: c.origin, ok: true, reporter, channels: c.data.channels ?? [], enabled: c.data.enabled !== false });
    for (const a of c.data.active ?? []) {
      if (a.source === SHARED_SOURCE) {
        if (sharedSeen.has(a.key)) continue;
        sharedSeen.add(a.key);
      }
      active.push({ ...a, origin: c.origin, reporter: a.source === SHARED_SOURCE ? "coordinators (shared database)" : reporter });
    }
    for (const e of c.data.history ?? []) {
      if (e.source === SHARED_SOURCE) {
        const id = `${e.key}|${e.kind}|${e.atMs}`;
        if (sharedEventSeen.has(id)) continue;
        sharedEventSeen.add(id);
      }
      history.push({ ...e, origin: c.origin, reporter: e.source === SHARED_SOURCE ? "coordinators (shared database)" : reporter });
    }
  }
  const rank = (s: string) => (s === "critical" ? 2 : 1);
  active.sort((a, b) => rank(b.severity) - rank(a.severity) || b.firstSeenMs - a.firstSeenMs);
  history.sort((a, b) => b.atMs - a.atMs);
  return { sources, active, history: history.slice(0, 200) };
}

const ackSchema = z.object({ origin: z.string().min(1).max(300), source: z.string().min(1).max(200), key: z.string().min(1).max(300) });
const backupSchema = z.object({
  app: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  /** ISO time or epoch ms of the newest successful backup; null when none is listed. */
  lastSuccessAt: z.union([z.string().max(64), z.number(), z.null()]),
  detail: z.string().max(500).optional()
});

export function registerPortalAlertRoutes(app: FastifyInstance, d: PortalAlertDeps): void {
  async function gate(req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): Promise<{ email: string } | null> {
    const user = await d.getCurrentUser(req as never);
    if (!user) {
      reply.code(401).send({ error: "not_authenticated" });
      return null;
    }
    if (!(await d.buildAccessContext(user)).isSystemAdmin) {
      reply.code(403).send({ error: "admin_only" });
      return null;
    }
    return { email: user.email };
  }
  const urls = async () => [...new Set((await d.coordinatorUrls()).map((u) => u.replace(/\/+$/, "")))];

  app.get("/portal/api/admin/alerts", async (req, reply) => {
    if (!(await gate(req, reply))) return;
    const own = { ...(await d.manager.list()), enabled: d.config.enabled };
    const coordinators: Origin[] = d.coordinatorAdminToken
      ? await Promise.all(
          (await urls()).map(async (u): Promise<Origin> => {
            const r = await coordinatorCall(u, "/admin/alerts", d.coordinatorAdminToken, d.timeoutMs);
            if (r.status !== 200) return { origin: u, ok: false, error: r.status === 0 ? "coordinator_unreachable" : r.status === 404 ? "route_not_deployed" : r.status === 401 ? "admin_token_rejected" : "coordinator_error", status: r.status };
            return { origin: u, ok: true, data: r.json as CoordinatorAlerts };
          })
        )
      : [];
    reply.header("cache-control", "no-store");
    return { ...mergeAlerts(own, coordinators), coordinatorAdminToken: Boolean(d.coordinatorAdminToken), generatedAtMs: Date.now() };
  });

  app.post("/portal/api/admin/alerts/ack", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const parsed = ackSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const { origin, source, key } = parsed.data;
    if (origin === "portal") {
      const r = await d.manager.acknowledge(source, key, who.email);
      return r ? { ok: true } : reply.code(404).send({ error: "alert_not_active" });
    }
    // Only a coordinator the portal already talks to (the allowlisted list), never a URL from the browser.
    const target = (await urls()).find((u) => u === origin.replace(/\/+$/, ""));
    if (!target) return reply.code(400).send({ error: "unknown_origin" });
    if (!d.coordinatorAdminToken) return reply.code(503).send({ error: "coordinator_admin_token_not_configured" });
    const r = await coordinatorCall(target, "/admin/alerts/ack", d.coordinatorAdminToken, d.timeoutMs, { source, key, by: who.email });
    return reply.code(r.status === 0 ? 502 : r.status).send(r.json);
  });

  app.post("/portal/api/admin/alerts/test", async (req, reply) => {
    const who = await gate(req, reply);
    if (!who) return;
    const results: Array<{ origin: string; ok: boolean; channels: Array<{ channel: string; ok: boolean; error?: string }>; error?: string }> = [];
    const own = await d.manager.sendTest(who.email);
    results.push({ origin: "portal", ok: own.length > 0 && own.every((c) => c.ok), channels: own, ...(own.length ? {} : { error: "no_channel_configured" }) });
    if (d.coordinatorAdminToken) {
      for (const u of await urls()) {
        const r = await coordinatorCall(u, "/admin/alerts/test", d.coordinatorAdminToken, d.timeoutMs, { by: who.email });
        const channels = Array.isArray(r.json?.channels) ? r.json.channels : [];
        results.push({ origin: u, ok: r.status === 200 && r.json?.ok === true, channels, ...(r.status === 200 ? (channels.length ? {} : { error: "no_channel_configured" }) : { error: r.json?.error ?? `http_${r.status}` }) });
      }
    }
    req.log.info({ by: who.email, results: results.map((r) => ({ origin: r.origin, ok: r.ok })) }, "admin_alert_test");
    return { ok: results.every((r) => r.ok), results };
  });
}

/** POST /internal/alerts/backup-report (inside the portal's /internal plugin: service token). */
export function registerBackupReportRoute(internal: FastifyInstance, d: { manager: AlertManager; serviceToken: string; now?: () => number }): void {
  internal.post("/internal/alerts/backup-report", async (req, reply) => {
    // A write: the portal's own service token only, not the coordinators' read token the plugin also accepts.
    const provided = req.headers["x-portal-service-token"];
    if (d.serviceToken && !(typeof provided === "string" && safeEqual(provided, d.serviceToken))) return reply.code(401).send({ error: "portal_service_token_required" });
    const parsed = backupSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const nowMs = (d.now ?? Date.now)();
    const raw = parsed.data.lastSuccessAt;
    const lastSuccessAtMs = raw === null ? null : typeof raw === "number" ? raw : Date.parse(raw);
    if (lastSuccessAtMs !== null && (!Number.isFinite(lastSuccessAtMs) || lastSuccessAtMs > nowMs + 3_600_000)) return reply.code(400).send({ error: "invalid_last_success_at" });
    const current = await d.manager.store.getState<{ apps?: Record<string, Omit<BackupReport, "app">> }>(BACKUP_STATE);
    const apps = { ...(current?.value?.apps ?? {}) };
    apps[parsed.data.app] = { lastSuccessAtMs, reportedAtMs: nowMs, detail: parsed.data.detail ?? null };
    // Bounded: a typo in the app name must not grow this forever.
    const names = Object.keys(apps).sort((a, b) => (apps[b]!.reportedAtMs ?? 0) - (apps[a]!.reportedAtMs ?? 0));
    for (const n of names.slice(20)) delete apps[n];
    await d.manager.store.setState(BACKUP_STATE, { apps }, nowMs);
    return { ok: true, app: parsed.data.app, lastSuccessAtMs };
  });
}


/**
 * Everything server.ts needs: the manager, the admin routes now, the internal backup route inside
 * the /internal plugin, and the checks once the portal listens (ALERT_ENABLED=false keeps them off).
 */
export function setupPortalAlerting(
  app: FastifyInstance,
  d: Pick<NetworkAdminRoutesDeps, "coordinatorAdminToken" | "EXTERNAL_HTTP_TIMEOUT_MS" | "coordinatorUrls" | "getCurrentUser" | "buildAccessContext" | "lookupOwners"> & { portalUrl: string; pool: Pool | null; serviceToken: string },
  config: AlertConfig = alertConfigFromEnv()
) {
  const manager = createAlertManager(config, { pool: d.pool, sourceId: "portal", reporter: "portal", portalUrl: d.portalUrl, log: app.log });
  registerPortalAlertRoutes(app, { manager, config, coordinatorAdminToken: d.coordinatorAdminToken, timeoutMs: d.EXTERNAL_HTTP_TIMEOUT_MS, coordinatorUrls: d.coordinatorUrls, getCurrentUser: d.getCurrentUser, buildAccessContext: d.buildAccessContext });
  const pool = d.pool;
  const runner = new AlertRunner(
    manager,
    portalMonitors({
      config,
      coordinatorUrls: d.coordinatorUrls,
      network: d.coordinatorAdminToken ? () => loadMergedNetwork(d, "1h") : null,
      backups: () => readBackupReports(manager),
      db: pool ? { errorCount: pgPoolErrorCount, probe: async () => void (await pool.query("SELECT 1")) } : null,
      startedAtMs: Date.now()
    }),
    { intervalMs: config.checkIntervalMs, log: app.log }
  );
  app.addHook("onClose", async () => runner.stop());
  return {
    manager,
    registerInternal: (internal: FastifyInstance) => registerBackupReportRoute(internal, { manager, serviceToken: d.serviceToken }),
    start: () => {
      if (!config.enabled) return;
      runner.start();
      app.log.info({ channels: manager.channels, intervalMs: config.checkIntervalMs }, "alerting_started");
      if (!manager.channels.length) app.log.warn({}, "alerting_no_channels: set ALERT_EMAILS or ALERT_WEBHOOK_URL");
    }
  };
}
