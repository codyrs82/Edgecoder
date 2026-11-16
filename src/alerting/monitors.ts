// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The alert rules. Each monitor answers "which conditions of my rule are active now?"; the runner
 * (src/alerting/runner.ts) hands that to AlertManager.apply, which raises the new ones and
 * resolves the rest. A monitor that cannot evaluate (its source is down) throws, and nothing of
 * its rule is resolved that round.
 *
 * The monitors only take functions (a probe, a query, a snapshot), so the portal and the
 * coordinator wire them to their own state (src/portal/alerts.ts, src/swarm/coordinator/alerts.ts)
 * and the tests drive them with fakes and a fake clock.
 */
import { request } from "undici";
import { ConsecutiveFailures, CounterWindow, EventWindow, Sustained } from "./conditions.js";
import type { AlertInput, AlertScope, AlertSeverity } from "./types.js";
import { formatDuration } from "./notify.js";
import type { LightningNodeHealth } from "../economy/lightning.js";

export interface Monitor {
  /** The rule name; incidents of the rule are resolved when the monitor stops reporting them. */
  name: string;
  scope: AlertScope;
  /** Defaults to ALERT_CHECK_INTERVAL_MS. */
  intervalMs?: number;
  check(nowMs: number): Promise<AlertInput[]>;
}

export const NETWORK_LINK = "/portal/settings/network#alerts";
const hostOf = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
const sats = (n: number) => `${Math.round(n).toLocaleString("en-US")} sats`;

// ── 1, 2. Health watches: N consecutive failed probes ──

export type ProbeResult = { ok: true } | { ok: false; error: string };

/** GET `url`; healthy when it answers 2xx within the timeout and its JSON does not say ok: false. */
export async function probeHealth(url: string, timeoutMs = 5_000): Promise<ProbeResult> {
  try {
    const res = await request(url, { method: "GET", headersTimeout: timeoutMs, bodyTimeout: timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.body.text().catch(() => "");
    if (res.statusCode < 200 || res.statusCode >= 300) return { ok: false, error: `http_${res.statusCode}` };
    try {
      const body = JSON.parse(text) as { ok?: unknown };
      if (body && body.ok === false) return { ok: false, error: "reported_unhealthy" };
    } catch {
      // A 2xx that is not JSON still means the service answers.
    }
    return { ok: true };
  } catch (error) {
    const e = error as { code?: string; name?: string; message?: string };
    return { ok: false, error: e.code ?? (e.name === "TimeoutError" ? "timeout" : (e.message ?? "unreachable")).slice(0, 120) };
  }
}

export interface HealthTarget {
  url: string;
  label: string;
}

/** How long a target that dropped out of the list (a peer pruned from the mesh because it is down) is still watched. */
export const TARGET_MEMORY_MS = 24 * 3_600_000;

export function healthWatchMonitor(o: {
  name: string;
  /** Key prefix and wording: "coordinator" or "portal". */
  what: "coordinator" | "portal";
  targets: () => Promise<HealthTarget[]>;
  probe?: (url: string) => Promise<ProbeResult>;
  failures: number;
  intervalMs?: number;
  scope?: AlertScope;
  observer: string;
}): Monitor {
  const runs = new ConsecutiveFailures(o.failures);
  const known = new Map<string, { target: HealthTarget; lastListedMs: number }>();
  const probe = o.probe ?? ((url: string) => probeHealth(url));
  return {
    name: o.name,
    scope: o.scope ?? "local",
    intervalMs: o.intervalMs,
    async check(nowMs) {
      for (const t of await o.targets()) known.set(t.url, { target: t, lastListedMs: nowMs });
      for (const [url, k] of known) {
        if (nowMs - k.lastListedMs > TARGET_MEMORY_MS) {
          known.delete(url);
          runs.forget(url);
        }
      }
      const out: AlertInput[] = [];
      await Promise.all(
        [...known.values()].map(async ({ target }) => {
          const r = await probe(target.url);
          const s = runs.record(target.url, r.ok, nowMs, r.ok ? undefined : r.error);
          if (!s.failing) return;
          const name = o.what === "portal" ? "The portal" : `Coordinator ${target.label}`;
          out.push({
            key: `${o.what}_down:${hostOf(target.label)}`,
            severity: "critical",
            title: `${o.what === "portal" ? "Portal" : `Coordinator ${target.label}`} is down or unhealthy`,
            summary: `${name} failed ${s.count} health checks in a row (${target.url}): ${s.lastError ?? "unhealthy"}. Seen from ${o.observer}.`,
            link: NETWORK_LINK,
            sinceMs: s.sinceMs,
            details: { url: target.url, consecutiveFailures: s.count, lastError: s.lastError ?? null }
          });
        })
      );
      return out;
    }
  };
}

// ── 3. Lightning ──

export type LightningHealth = LightningNodeHealth;

export function lightningMonitor(o: {
  getHealth: () => Promise<LightningHealth | { supported: false; reason: string }>;
  failures: number;
  minOutboundSats: number;
  minInboundSats: number;
  /** Not synced / channels inactive only count once they last this long (blocks arrive; peers reconnect). */
  sustainMs?: number;
  label: string;
}): Monitor {
  const unreachable = new ConsecutiveFailures(o.failures);
  const sustained = new Sustained(o.sustainMs ?? 10 * 60_000);
  const link = "/portal/settings/revenue";
  return {
    name: "lightning",
    scope: "local",
    async check(nowMs) {
      let h: LightningHealth | { supported: false; reason: string };
      try {
        h = await o.getHealth();
      } catch (error) {
        const s = unreachable.record("lnd", false, nowMs, error instanceof Error ? error.message : String(error));
        if (!s.failing) throw error; // not yet N in a row: keep the other lightning incidents as they are
        return [
          {
            key: "ln_unreachable",
            severity: "critical",
            title: `Lightning node unreachable (${o.label})`,
            summary: `The coordinator could not reach its Lightning node ${s.count} times in a row: ${String(s.lastError).slice(0, 160)}. Purchases and payouts fail until it is back.`,
            link,
            sinceMs: s.sinceMs,
            details: { consecutiveFailures: s.count }
          }
        ];
      }
      unreachable.record("lnd", true, nowMs);
      if (!h.supported) return [];
      const out: AlertInput[] = [];
      const unsynced = sustained.update("unsynced", !h.syncedToChain || !h.syncedToGraph, nowMs);
      if (unsynced.fire) {
        const what = [!h.syncedToChain ? "chain" : "", !h.syncedToGraph ? "graph" : ""].filter(Boolean).join(" and ");
        out.push({ key: "ln_not_synced", severity: "critical", title: `Lightning node not synced to ${what} (${o.label})`, summary: `The node reports it is not synced to the ${what}${h.blockHeight ? ` at block ${h.blockHeight}` : ""}. Invoices and payments may fail or route badly.`, link, sinceMs: unsynced.sinceMs, details: { syncedToChain: h.syncedToChain, syncedToGraph: h.syncedToGraph, blockHeight: h.blockHeight } });
      }
      if (o.minOutboundSats > 0 && h.localSats < o.minOutboundSats) {
        out.push({ key: "ln_low_outbound", severity: h.localSats === 0 ? "critical" : "warning", title: `Lightning outbound liquidity low (${o.label})`, summary: `${sats(h.localSats)} spendable in active channels, below ${sats(o.minOutboundSats)}. Payouts are at risk.`, link, details: { outboundSats: h.localSats, minOutboundSats: o.minOutboundSats, activeChannels: h.activeChannels } });
      }
      if (o.minInboundSats > 0 && h.remoteSats < o.minInboundSats) {
        out.push({ key: "ln_low_inbound", severity: h.remoteSats === 0 ? "critical" : "warning", title: `Lightning inbound liquidity low (${o.label})`, summary: `${sats(h.remoteSats)} receivable in active channels, below ${sats(o.minInboundSats)}. Buyers may be unable to pay invoices.`, link, details: { inboundSats: h.remoteSats, minInboundSats: o.minInboundSats, activeChannels: h.activeChannels } });
      }
      const inactive = sustained.update("inactive", h.inactiveChannels > 0, nowMs);
      if (inactive.fire) {
        out.push({ key: "ln_channels_inactive", severity: h.activeChannels === 0 ? "critical" : "warning", title: `${h.inactiveChannels} Lightning channel${h.inactiveChannels === 1 ? "" : "s"} inactive (${o.label})`, summary: `${h.inactiveChannels} of ${h.inactiveChannels + h.activeChannels} channels have been inactive (peer offline) for over ${formatDuration(nowMs - inactive.sinceMs)}.`, link, sinceMs: inactive.sinceMs, details: { inactiveChannels: h.inactiveChannels, activeChannels: h.activeChannels, inactive: h.inactive.slice(0, 5).map((c) => `${c.chanId} (${c.remotePubkey.slice(0, 16)}…, ${c.localSats} sats local)`) } });
      }
      return out;
    }
  };
}

// ── 4. Payouts and purchases ──

export interface PayoutAlertQueries {
  /** Failed payouts settled at or after `sinceMs` (payouts refused while paused excluded), newest first, at most 5. */
  failedSince(sinceMs: number): Promise<{ count: number; recent: Array<{ payoutId: string; kind: string; amountMsat: number; error: string | null; settledAtMs: number }> }>;
  /** Lightning payouts still pending that were created before `beforeMs`. */
  pendingBefore(beforeMs: number): Promise<{ count: number; oldestMs: number | null }>;
  /** The payout kill switch. */
  paused(): Promise<{ paused: boolean; reason?: string | null; sinceMs?: number | null } | null>;
}

export const PAYOUT_WINDOW_MS = 3_600_000;

export function payoutMonitor(o: { queries: PayoutAlertQueries; failuresPerHour: number; pendingMaxMs: number }): Monitor {
  const link = "/portal/settings/revenue";
  return {
    name: "payouts",
    // Payout rows live in the coordinators' shared database: one incident for all of them.
    scope: "shared",
    async check(nowMs) {
      const out: AlertInput[] = [];
      const failed = await o.queries.failedSince(nowMs - PAYOUT_WINDOW_MS);
      if (failed.count > 0) {
        const many = failed.count > o.failuresPerHour;
        out.push({
          key: many ? "payout_failures_high" : "payout_failed",
          severity: many ? "critical" : "warning",
          title: many ? `${failed.count} payouts failed in the last hour` : `Payout failed`,
          summary: `${failed.count} payout${failed.count === 1 ? "" : "s"} failed in the last hour${many ? `, more than ${o.failuresPerHour}` : ""}. Latest: ${failed.recent[0]?.error ?? "unknown error"}.`,
          link,
          sinceMs: Math.min(...failed.recent.map((r) => r.settledAtMs), nowMs),
          details: { failedLastHour: failed.count, recent: failed.recent.map((r) => `${r.payoutId} ${r.kind} ${Math.round(r.amountMsat / 1000)} sats: ${r.error ?? "?"}`) }
        });
      }
      const pending = await o.queries.pendingBefore(nowMs - o.pendingMaxMs);
      if (pending.count > 0) {
        out.push({
          key: "payout_pending_stuck",
          severity: "warning",
          title: `${pending.count} payout${pending.count === 1 ? "" : "s"} stuck pending`,
          summary: `${pending.count} Lightning payout${pending.count === 1 ? " has" : "s have"} been pending for over ${formatDuration(o.pendingMaxMs)}${pending.oldestMs ? `; the oldest since ${new Date(pending.oldestMs).toISOString()}` : ""}.`,
          link,
          sinceMs: pending.oldestMs ?? undefined,
          details: { stuckPending: pending.count }
        });
      }
      const pause = await o.queries.paused();
      if (pause?.paused) {
        out.push({ key: "payouts_paused", severity: "critical", title: "Payouts are paused", summary: `The payout kill switch is on${pause.reason ? `: ${pause.reason}` : ""}. Nothing leaves the Lightning node until it is resumed.`, link, sinceMs: pause.sinceMs ?? undefined, details: { reason: pause.reason ?? null } });
      }
      return out;
    }
  };
}

/** In-process counts of invoice creation (purchases), noted where the coordinator creates invoices. */
export class PurchaseSignals {
  private readonly window = new EventWindow(5_000, PAYOUT_WINDOW_MS);
  note(ok: boolean, nowMs = Date.now(), error?: string): void {
    this.window.add(ok ? "ok" : "failed", nowMs, ok ? undefined : { error: (error ?? "").slice(0, 160) });
  }
  stats(sinceMs: number): { attempts: number; failed: number; lastError: string | null } {
    const failed = this.window.since("failed", sinceMs);
    const ok = this.window.since("ok", sinceMs).length;
    return { attempts: ok + failed.length, failed: failed.length, lastError: (failed.at(-1)?.detail?.error as string | undefined) ?? null };
  }
}

export function purchaseMonitor(o: { signals: Pick<PurchaseSignals, "stats">; failureRate: number; minAttempts: number; label: string }): Monitor {
  return {
    name: "purchases",
    scope: "local",
    async check(nowMs) {
      const s = o.signals.stats(nowMs - PAYOUT_WINDOW_MS);
      if (s.attempts < o.minAttempts || s.failed / s.attempts < o.failureRate) return [];
      return [
        {
          key: "purchase_failure_rate",
          severity: s.failed === s.attempts ? "critical" : "warning",
          title: `Purchase invoices failing (${o.label})`,
          summary: `${s.failed} of ${s.attempts} purchase invoices failed to be created in the last hour (${Math.round((s.failed / s.attempts) * 100)}%). Last error: ${s.lastError ?? "unknown"}.`,
          link: "/portal/settings/revenue",
          details: { attempts: s.attempts, failed: s.failed }
        }
      ];
    }
  };
}

// ── 5. Ledger integrity ──

export interface LedgerVerification {
  windowStartMs: number;
  startedAtMs: number;
  finishedAtMs: number | null;
  ok: boolean | null;
  mismatches: number | null;
}

export function ledgerMonitor(o: {
  /** The newest rows of ledger_verifications (the periodic reconciliation), newest first. */
  latest: () => Promise<LedgerVerification[]>;
  /** A run that started this long ago and never finished counts as stalled. */
  stallMs?: number;
}): Monitor {
  const stallMs = o.stallMs ?? 2 * 3_600_000;
  return {
    name: "ledger",
    scope: "shared",
    async check(nowMs) {
      const rows = await o.latest();
      const out: AlertInput[] = [];
      const finished = rows.find((r) => r.finishedAtMs !== null);
      if (finished && finished.ok === false) {
        out.push({ key: "ledger_verify_failed", severity: "critical", title: "Ledger verification failed", summary: `The credit ledger reconciliation found ${finished.mismatches ?? "some"} mismatch${finished.mismatches === 1 ? "" : "es"} (run at ${new Date(finished.startedAtMs).toISOString()}). Review with GET /ledger/verify (admin token).`, link: "/portal/settings/network#alerts", sinceMs: finished.startedAtMs, details: { mismatches: finished.mismatches, windowStartMs: finished.windowStartMs } });
      }
      const stalled = rows.find((r) => r.finishedAtMs === null && nowMs - r.startedAtMs > stallMs);
      if (stalled && (!finished || finished.startedAtMs < stalled.startedAtMs)) {
        out.push({ key: "ledger_verify_stalled", severity: "warning", title: "Ledger verification did not finish", summary: `The run started at ${new Date(stalled.startedAtMs).toISOString()} never finished (the coordinator crashed or the query failed).`, link: "/portal/settings/network#alerts", sinceMs: stalled.startedAtMs, details: { windowStartMs: stalled.windowStartMs } });
      }
      return out;
    }
  };
}

/** This process's signed ordering chain (GET /ledger/verify without the admin token). */
export function orderingChainMonitor(o: { verify: () => { ok: boolean; reason?: string }; label: string; intervalMs?: number }): Monitor {
  return {
    name: "ordering_chain",
    scope: "local",
    intervalMs: o.intervalMs ?? 10 * 60_000,
    async check() {
      const r = o.verify();
      if (r.ok) return [];
      return [{ key: "ledger_chain_invalid", severity: "critical", title: `Ordering chain verification failed (${o.label})`, summary: `The coordinator's hash-chained event log failed its own check: ${r.reason ?? "unknown"}. Possible tampering or corruption.`, link: "/portal/settings/network#alerts", details: { reason: r.reason ?? null } }];
    }
  };
}

// ── 6. Database ──

export function databaseMonitor(o: { errorCount: () => number; probe: () => Promise<void>; errorsPer10Min: number; failures: number; label: string }): Monitor {
  const growth = new CounterWindow(10 * 60_000);
  const probes = new ConsecutiveFailures(o.failures);
  return {
    name: "database",
    scope: "local",
    async check(nowMs) {
      const errors = growth.observe(o.errorCount(), nowMs);
      let probeError: string | undefined;
      try {
        await o.probe();
      } catch (error) {
        probeError = error instanceof Error ? error.message : String(error);
      }
      const p = probes.record("db", probeError === undefined, nowMs, probeError);
      if (!p.failing && errors < o.errorsPer10Min) return [];
      return [
        {
          key: "db_errors",
          severity: p.failing ? "critical" : "warning",
          title: `Database connection errors (${o.label})`,
          summary: p.failing ? `The database failed ${p.count} checks in a row: ${String(p.lastError).slice(0, 160)}.` : `${errors} connection errors on the Postgres pool in the last 10 minutes.`,
          link: "/portal/settings/network#alerts",
          sinceMs: p.failing ? p.sinceMs : undefined,
          details: { poolErrors10Min: errors, consecutiveProbeFailures: p.count }
        }
      ];
    }
  };
}

/** Postgres backups, reported by the scheduled ops check (scripts/ops/report-pg-backups.sh). */
export interface BackupReport {
  /** Database (Fly app) name. */
  app: string;
  lastSuccessAtMs: number | null;
  reportedAtMs: number;
  detail?: string | null;
}

export function backupMonitor(o: { reports: () => Promise<BackupReport[]>; maxAgeMs: number; expected: boolean; startedAtMs: number }): Monitor {
  return {
    name: "backups",
    scope: "local",
    async check(nowMs) {
      const reports = await o.reports();
      const out: AlertInput[] = [];
      for (const r of reports) {
        if (r.lastSuccessAtMs === null || nowMs - r.lastSuccessAtMs > o.maxAgeMs) {
          out.push({ key: `pg_backup_stale:${r.app}`, severity: "critical", title: `Postgres backup overdue (${r.app})`, summary: r.lastSuccessAtMs === null ? `No successful backup of ${r.app} is listed.` : `The latest successful backup of ${r.app} is ${formatDuration(nowMs - r.lastSuccessAtMs)} old (limit ${formatDuration(o.maxAgeMs)}).`, link: "/portal/settings/network#alerts", sinceMs: r.lastSuccessAtMs ? r.lastSuccessAtMs + o.maxAgeMs : undefined, details: { lastSuccessAt: r.lastSuccessAtMs ? new Date(r.lastSuccessAtMs).toISOString() : null, detail: r.detail ?? null } });
        }
        if (o.expected && nowMs - r.reportedAtMs > o.maxAgeMs) {
          out.push({ key: `pg_backup_unreported:${r.app}`, severity: "warning", title: `Backup check stopped reporting (${r.app})`, summary: `The scheduled backup check last reported ${formatDuration(nowMs - r.reportedAtMs)} ago. Backups may be fine, but nothing is checking them.`, link: "/portal/settings/network#alerts", sinceMs: r.reportedAtMs + o.maxAgeMs });
        }
      }
      if (o.expected && reports.length === 0 && nowMs - o.startedAtMs > o.maxAgeMs) {
        out.push({ key: "pg_backup_unreported:any", severity: "warning", title: "No backup check has reported", summary: `ALERT_BACKUP_EXPECTED is on, but no backup report arrived in ${formatDuration(o.maxAgeMs)}. Schedule scripts/ops/report-pg-backups.sh.`, link: "/portal/settings/network#alerts" });
      }
      return out;
    }
  };
}

// ── 7. Capacity and safety (portal: the merged network view) ──

export interface CapacityView {
  models: Array<{ model: string; agents: number; calls24h: number; noAgentHasModel24h?: number }>;
  agents: Array<{ agentId: string; email?: string | null; connected: boolean; blacklisted: boolean; memory?: { pressure?: string; fresh?: boolean } | null }>;
  series: { points: Array<{ atMs: number; started?: unknown; noCapacity?: unknown }> };
}

export const NO_CAPACITY_WINDOW_MS = 15 * 60_000;

export function capacityMonitor(o: { view: () => Promise<CapacityView>; popularMinCalls24h: number; gapMs: number; memorySustainMs?: number; noCapacityRate: number; noCapacityMinCalls: number }): Monitor {
  const unserved = new Sustained(o.gapMs);
  const memory = new Sustained(o.memorySustainMs ?? 5 * 60_000);
  return {
    name: "capacity",
    scope: "local",
    async check(nowMs) {
      const v = await o.view();
      const out: AlertInput[] = [];
      const seenModels = new Set<string>();
      for (const m of v.models) {
        const demand = m.calls24h + (m.noAgentHasModel24h ?? 0);
        if (demand < o.popularMinCalls24h) continue;
        seenModels.add(m.model);
        const s = unserved.update(m.model, m.agents === 0, nowMs);
        if (s.fire) out.push({ key: `model_unserved:${m.model}`, severity: "critical", title: `No agent online for ${m.model}`, summary: `${m.model} had ${demand} requests in the last 24 h and no agent has been online for it for ${formatDuration(nowMs - s.sinceMs)}. Its calls are refused.`, link: "/portal/settings/network", sinceMs: s.sinceMs, details: { model: m.model, calls24h: m.calls24h, refusedNoAgent24h: m.noAgentHasModel24h ?? 0 } });
      }
      unserved.retain(seenModels);
      const seenAgents = new Set<string>();
      for (const a of v.agents) {
        if (!a.connected || a.blacklisted) continue;
        seenAgents.add(a.agentId);
        const critical = a.memory?.pressure === "critical" && a.memory.fresh !== false;
        const s = memory.update(a.agentId, critical, nowMs);
        if (s.fire) out.push({ key: `host_memory_critical:${a.agentId}`, severity: "warning", title: `Host at critical memory pressure: ${a.agentId}`, summary: `${a.agentId}${a.email ? ` (${a.email})` : ""} has reported critical memory pressure for ${formatDuration(nowMs - s.sinceMs)}. It takes no new model work until memory frees up.`, link: "/portal/settings/network", sinceMs: s.sinceMs, details: { agentId: a.agentId, owner: a.email ?? null } });
      }
      memory.retain(seenAgents);
      let started = 0;
      let noCapacity = 0;
      for (const p of v.series.points) {
        if (p.atMs < nowMs - NO_CAPACITY_WINDOW_MS) continue;
        started += typeof p.started === "number" ? p.started : 0;
        noCapacity += typeof p.noCapacity === "number" ? p.noCapacity : 0;
      }
      if (started >= o.noCapacityMinCalls && noCapacity / started >= o.noCapacityRate) {
        out.push({ key: "no_capacity_spike", severity: "warning", title: "Spike in no-capacity refusals", summary: `${noCapacity} of ${started} model calls in the last 15 min (${Math.round((noCapacity / started) * 100)}%) found no free agent.`, link: "/portal/settings/network", details: { started, noCapacity } });
      }
      return out;
    }
  };
}

// ── 8. Security events ──

export interface SecurityEventLike {
  event: string;
  timestamp?: string;
  details?: Record<string, unknown>;
  source?: { id?: string; ip?: string };
}

interface SecurityRule {
  key: string;
  threshold: number;
  windowMs: number;
  severity: AlertSeverity;
  title: string;
  what: string;
}

const H = 3_600_000;
const M10 = 10 * 60_000;

/** Which security events alert, and how many in what window. One occurrence is enough for the integrity ones. */
export function securityRules(authFailuresPer10Min: number): Record<string, SecurityRule> {
  const once = (key: string, severity: AlertSeverity, title: string, what: string): SecurityRule => ({ key, threshold: 1, windowMs: H, severity, title, what });
  return {
    ledger_chain_break: once("ledger_chain_break", "critical", "Ledger chain break detected", "the hash-chained ledger failed verification (possible tampering)"),
    blacklist_chain_tamper: once("blacklist_chain_tamper", "critical", "Blacklist chain tampering detected", "a blacklist record broke the signed chain"),
    manifest_signature_failure: once("manifest_signature_failure", "critical", "Release manifest signature failure", "a release manifest failed its signature check"),
    key_expired: once("key_expired", "critical", "Coordinator key expired", "a signing key expired"),
    ledger_reconciliation_mismatch: once("ledger_reconciliation_mismatch", "critical", "Ledger reconciliation mismatch", "the credit ledger does not reconcile"),
    payout_reconciliation_mismatch: once("payout_reconciliation_mismatch", "critical", "Payout reconciliation mismatch", "the Lightning node's payments do not match the payout records"),
    onchain_deposit_reversed: once("onchain_deposit_reversed", "critical", "On-chain deposit reversed", "a credited on-chain deposit disappeared from the chain"),
    onchain_batch_resurfaced: once("onchain_batch_resurfaced", "critical", "On-chain payout batch resurfaced", "a released payout batch reappeared in the node"),
    onchain_batch_stuck: once("onchain_batch_stuck", "warning", "On-chain payout batch stuck", "an on-chain payout batch is not confirming"),
    bot_control_not_owner: once("bot_control_not_owner", "warning", "Bot control attempted by a non-owner", "a portal session tried to control a bot on a machine its account does not own"),
    model_control_not_owner: once("model_control_not_owner", "warning", "Model control attempted by a non-owner", "a portal session tried to control a machine its account does not own"),
    restricted_access_suspended: once("restricted_access_suspended", "warning", "Restricted model access suspended", "an account's security-research access was suspended"),
    failed_auth: { key: "auth_failures", threshold: authFailuresPer10Min, windowMs: M10, severity: "warning", title: "Repeated authentication failures", what: "failed authentications" },
    auth_rate_limit_hit: { key: "auth_rate_limited", threshold: 10, windowMs: M10, severity: "warning", title: "Authentication rate limit hit repeatedly", what: "auth rate-limit hits" },
    invalid_signature: { key: "invalid_signatures", threshold: 20, windowMs: M10, severity: "warning", title: "Many invalid request signatures", what: "invalid signatures" },
    replay_attempt: { key: "replay_attempts", threshold: 5, windowMs: M10, severity: "warning", title: "Replay attempts", what: "replayed requests" },
    auto_blacklist_triggered: { key: "auto_blacklist_spike", threshold: 5, windowMs: H, severity: "warning", title: "Unusual number of auto-blacklists", what: "automatic blacklists" }
  };
}

const OWNED_BLACKLIST: SecurityRule = { key: "auto_blacklist_owned_host", threshold: 1, windowMs: 6 * H, severity: "critical", title: "Owner-verified host auto-blacklisted", what: "automatic blacklists of hosts with a verified owner" };

/** Short, flat details of an event (no nested blobs in an email). */
function brief(e: SecurityEventLike): Record<string, unknown> {
  const out: Record<string, unknown> = { at: e.timestamp ?? null };
  for (const [k, v] of Object.entries(e.details ?? {}).slice(0, 6)) out[k] = typeof v === "object" && v !== null ? JSON.stringify(v).slice(0, 160) : v;
  if (e.source?.id) out.source = e.source.id;
  if (e.source?.ip) out.ip = e.source.ip;
  return out;
}

/**
 * Fed by the coordinator's security-event stream (SecurityEventLogger listeners). An incident is
 * active while its rule's window holds at least `threshold` events, so it resolves by itself once
 * the events stop.
 */
export class SecurityEventMonitor implements Monitor {
  readonly name = "security";
  readonly scope = "local" as const;
  private readonly window = new EventWindow(2_000, 6 * H);
  private readonly rules: Record<string, SecurityRule>;
  constructor(private readonly o: { authFailuresPer10Min: number; isOwnedHost: (agentId: string) => boolean; label: string; now?: () => number }) {
    this.rules = securityRules(o.authFailuresPer10Min);
  }

  ingest(e: SecurityEventLike, atMs = (this.o.now ?? Date.now)()): void {
    const rule = this.rules[e.event];
    if (!rule) return;
    this.window.add(rule.key, atMs, brief(e));
    if (e.event === "auto_blacklist_triggered") {
      const agentId = typeof e.details?.agentId === "string" ? e.details.agentId : "";
      if (agentId && this.o.isOwnedHost(agentId)) this.window.add(OWNED_BLACKLIST.key, atMs, brief(e));
    }
  }

  async check(nowMs: number): Promise<AlertInput[]> {
    this.window.prune(nowMs);
    const out: AlertInput[] = [];
    for (const rule of [...new Map([...Object.values(this.rules), OWNED_BLACKLIST].map((r) => [r.key, r])).values()]) {
      const events = this.window.since(rule.key, nowMs - rule.windowMs);
      if (events.length < rule.threshold) continue;
      const latest = events.at(-1)!;
      out.push({
        key: `security:${rule.key}`,
        severity: rule.severity,
        title: `${rule.title} (${this.o.label})`,
        summary: rule.threshold === 1 ? `${events.length} event${events.length === 1 ? "" : "s"} in the last ${formatDuration(rule.windowMs)}: ${rule.what}.` : `${events.length} ${rule.what} in the last ${formatDuration(rule.windowMs)} (threshold ${rule.threshold}).`,
        link: "/portal/settings/network#alerts",
        sinceMs: events[0]!.atMs,
        details: { count: events.length, latest: latest.detail ?? null }
      });
    }
    return out;
  }
}
