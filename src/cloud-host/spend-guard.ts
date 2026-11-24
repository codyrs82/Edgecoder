// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The cloud host's spend guard: what the platform's provider key has spent, from the provider's
 * own token counts at its price (catalog.ts providerCostUsd), against a daily and a monthly cap.
 *
 * - At `alertAtPct` (80 %) of a cap: one ops alert per period (src/alerting channels).
 * - At 100 %: paused. The host stops advertising its models and refuses calls with a
 *   "cloud_capacity_paused" error until the period ends (UTC day / UTC month), then resumes.
 * - `authFailureLimit` (3) provider auth failures in a row (a bad or revoked key): paused with an
 *   alert until a call or the key probe succeeds again (host.ts probes it).
 *
 * Periods are UTC. The state is saved after every change (host.ts keeps it in a file), so a restart
 * neither forgets the month's spend nor repeats an alert. Pure: time, storage and alerts are passed in.
 */

export interface SpendGuardConfig {
  dailyCapUsd: number;
  monthlyCapUsd: number;
  /** Share of a cap that sends the warning (0..1). */
  alertAtPct: number;
  /** Consecutive auth failures that pause the host. */
  authFailureLimit: number;
}

export const DEFAULT_SPEND_GUARD: SpendGuardConfig = { dailyCapUsd: 200, monthlyCapUsd: 2_000, alertAtPct: 0.8, authFailureLimit: 3 };

export interface SpendState {
  /** UTC day (YYYY-MM-DD) and month (YYYY-MM) the totals are for. */
  day: string;
  month: string;
  dayUsd: number;
  monthUsd: number;
  /** Alerts already sent this period ("day:warn", "day:cap", "month:warn", "month:cap"). */
  alerted: string[];
  authFailures: number;
  /** Set while paused for auth failures. */
  authPausedAtMs?: number;
}

export type PauseReason = "daily_cap" | "monthly_cap" | "auth";

export type SpendEvent =
  | { kind: "warn"; scope: "day" | "month"; spentUsd: number; capUsd: number }
  | { kind: "paused"; reason: PauseReason; spentUsd?: number; capUsd?: number; resumesAtMs?: number; failures?: number }
  | { kind: "resumed"; reason: PauseReason };

export interface SpendStatus {
  paused: boolean;
  reason?: PauseReason;
  resumesAtMs?: number;
  dayUsd: number;
  monthUsd: number;
  dailyCapUsd: number;
  monthlyCapUsd: number;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);
/** Start of the next UTC day / month. */
export function nextDayMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
export function nextMonthMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export function freshSpendState(nowMs: number): SpendState {
  return { day: dayOf(nowMs), month: monthOf(nowMs), dayUsd: 0, monthUsd: 0, alerted: [], authFailures: 0 };
}

/** A stored state, or a fresh one when it is missing or malformed. */
export function validSpendState(raw: unknown, nowMs: number): SpendState {
  const r = raw as Partial<SpendState> | null | undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  if (!r || typeof r !== "object" || typeof r.day !== "string" || typeof r.month !== "string") return freshSpendState(nowMs);
  return {
    day: r.day,
    month: r.month,
    dayUsd: num(r.dayUsd),
    monthUsd: num(r.monthUsd),
    alerted: Array.isArray(r.alerted) ? r.alerted.filter((a): a is string => typeof a === "string").slice(0, 16) : [],
    authFailures: num(r.authFailures),
    ...(typeof r.authPausedAtMs === "number" ? { authPausedAtMs: r.authPausedAtMs } : {})
  };
}

export class SpendGuard {
  private state: SpendState;
  private readonly now: () => number;

  constructor(
    readonly config: SpendGuardConfig,
    private readonly io: { now?: () => number; load?: () => unknown; save?: (s: SpendState) => void; notify?: (e: SpendEvent) => void } = {}
  ) {
    this.now = io.now ?? Date.now;
    const now = this.now();
    let loaded: unknown;
    try {
      loaded = io.load?.();
    } catch {
      loaded = undefined;
    }
    this.state = validSpendState(loaded, now);
    this.roll(now);
  }

  /** Paused for a cap of the current state (no roll). */
  private capPause(): { reason: PauseReason; resumesAtMs: number; spentUsd: number; capUsd: number } | undefined {
    const s = this.state;
    const now = this.now();
    if (s.monthUsd >= this.config.monthlyCapUsd) return { reason: "monthly_cap", resumesAtMs: nextMonthMs(now), spentUsd: s.monthUsd, capUsd: this.config.monthlyCapUsd };
    if (s.dayUsd >= this.config.dailyCapUsd) return { reason: "daily_cap", resumesAtMs: nextDayMs(now), spentUsd: s.dayUsd, capUsd: this.config.dailyCapUsd };
    return undefined;
  }

  /** A new UTC day or month resets its total (and resumes a host its cap paused). */
  private roll(now: number): void {
    const s = this.state;
    const before = this.capPause();
    let changed = false;
    if (s.month !== monthOf(now)) {
      s.month = monthOf(now);
      s.monthUsd = 0;
      s.alerted = s.alerted.filter((a) => !a.startsWith("month:"));
      changed = true;
    }
    if (s.day !== dayOf(now)) {
      s.day = dayOf(now);
      s.dayUsd = 0;
      s.alerted = s.alerted.filter((a) => !a.startsWith("day:"));
      changed = true;
    }
    if (!changed) return;
    this.save();
    if (before && !this.capPause()) this.io.notify?.({ kind: "resumed", reason: before.reason });
  }

  private save(): void {
    try {
      this.io.save?.(this.state);
    } catch {
      // a failed write keeps the in-memory state; the next change tries again
    }
  }

  private once(key: string, e: SpendEvent): void {
    if (this.state.alerted.includes(key)) return;
    this.state.alerted.push(key);
    this.io.notify?.(e);
  }

  /** Add what a call cost (USD), then warn or pause as the totals cross the thresholds. */
  record(usd: number): void {
    this.roll(this.now());
    if (!Number.isFinite(usd) || usd <= 0) return;
    const s = this.state;
    s.dayUsd = Number((s.dayUsd + usd).toFixed(9));
    s.monthUsd = Number((s.monthUsd + usd).toFixed(9));
    const c = this.config;
    if (s.dayUsd >= c.dailyCapUsd * c.alertAtPct) this.once("day:warn", { kind: "warn", scope: "day", spentUsd: s.dayUsd, capUsd: c.dailyCapUsd });
    if (s.monthUsd >= c.monthlyCapUsd * c.alertAtPct) this.once("month:warn", { kind: "warn", scope: "month", spentUsd: s.monthUsd, capUsd: c.monthlyCapUsd });
    const now = this.now();
    if (s.monthUsd >= c.monthlyCapUsd) this.once("month:cap", { kind: "paused", reason: "monthly_cap", spentUsd: s.monthUsd, capUsd: c.monthlyCapUsd, resumesAtMs: nextMonthMs(now) });
    else if (s.dayUsd >= c.dailyCapUsd) this.once("day:cap", { kind: "paused", reason: "daily_cap", spentUsd: s.dayUsd, capUsd: c.dailyCapUsd, resumesAtMs: nextDayMs(now) });
    this.save();
  }

  /** A call the provider refused for the key (401 / 403). */
  noteAuthFailure(): void {
    const s = this.state;
    s.authFailures += 1;
    if (s.authFailures >= this.config.authFailureLimit && s.authPausedAtMs === undefined) {
      s.authPausedAtMs = this.now();
      this.io.notify?.({ kind: "paused", reason: "auth", failures: s.authFailures });
    }
    this.save();
  }

  /** The key worked (a call or the probe): clears the failure count and an auth pause. */
  noteAuthOk(): void {
    const s = this.state;
    const wasPaused = s.authPausedAtMs !== undefined;
    if (s.authFailures === 0 && !wasPaused) return;
    s.authFailures = 0;
    delete s.authPausedAtMs;
    this.save();
    if (wasPaused) this.io.notify?.({ kind: "resumed", reason: "auth" });
  }

  status(): SpendStatus {
    this.roll(this.now());
    const s = this.state;
    const base = { dayUsd: s.dayUsd, monthUsd: s.monthUsd, dailyCapUsd: this.config.dailyCapUsd, monthlyCapUsd: this.config.monthlyCapUsd };
    if (s.authPausedAtMs !== undefined) return { ...base, paused: true, reason: "auth" };
    const cap = this.capPause();
    return cap ? { ...base, paused: true, reason: cap.reason, resumesAtMs: cap.resumesAtMs } : { ...base, paused: false };
  }

  canServe(): boolean {
    return !this.status().paused;
  }

  /** The error a refused call gets ("cloud_capacity_paused: …"), or undefined while serving. */
  pausedError(): string | undefined {
    const st = this.status();
    if (!st.paused) return undefined;
    if (st.reason === "auth") return "cloud_capacity_paused: the cloud provider is refusing the platform's API key; paused until it is fixed";
    const when = st.resumesAtMs ? new Date(st.resumesAtMs).toISOString() : "the next period";
    return `cloud_capacity_paused: the ${st.reason === "monthly_cap" ? "monthly" : "daily"} cloud spend cap is reached; resumes at ${when}`;
  }

  snapshot(): SpendState {
    return structuredClone(this.state);
  }
}
