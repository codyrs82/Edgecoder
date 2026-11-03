// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Usage: one record per request an account made (a model call, a code job, a reservation), with
 * what ran it, where, for how long and what it cost. The coordinator writes a record when the
 * request settles; the usage page summarizes them.
 */

export type UsageKind = "inference" | "job" | "reservation";
export type UsagePlacement = "network" | "mine" | "reserved";

export interface UsageRecord {
  id: string;
  accountId: string;
  atMs: number;
  kind: UsageKind;
  placement: UsagePlacement;
  /** Model requested (inference), or the model a reservation needed. */
  model?: string;
  /** Class that ran it (or was requested, when it never ran). */
  computeClass?: string;
  agentId?: string;
  /** What sent it: a connection's name, "EdgeCoder chat", "hosted API", ... */
  source?: string;
  ok: boolean;
  durationMs: number;
  costMsat: number;
  /** Tokens the model read and wrote (inference, when the agent reported them). */
  promptTokens?: number;
  outputTokens?: number;
}

export interface UsageSlice {
  key: string;
  requests: number;
  cSats: number;
  seconds: number;
  promptTokens: number;
  outputTokens: number;
}

export interface UsageSummary {
  sinceMs: number;
  totals: { requests: number; cSats: number; seconds: number; failed: number; promptTokens: number; outputTokens: number };
  byDay: Array<{ day: string; requests: number; cSats: number }>;
  byModel: UsageSlice[];
  byClass: UsageSlice[];
  bySource: UsageSlice[];
  byPlacement: UsageSlice[];
  /** Newest first. */
  records: UsageRecord[];
}

const round = (n: number, d = 3) => Number(n.toFixed(d));
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function slice(records: UsageRecord[], keyOf: (r: UsageRecord) => string | undefined): UsageSlice[] {
  const m = new Map<string, UsageSlice>();
  for (const r of records) {
    const key = keyOf(r) || "other";
    const s = m.get(key) ?? { key, requests: 0, cSats: 0, seconds: 0, promptTokens: 0, outputTokens: 0 };
    s.requests++;
    s.promptTokens += r.promptTokens ?? 0;
    s.outputTokens += r.outputTokens ?? 0;
    s.cSats += r.costMsat / 1000;
    s.seconds += r.durationMs / 1000;
    m.set(key, s);
  }
  return [...m.values()].map((s) => ({ ...s, cSats: round(s.cSats), seconds: round(s.seconds, 1) })).sort((a, b) => b.cSats - a.cSats || b.requests - a.requests);
}

/** Summarize an account's records since `sinceMs` (every day in the window appears, even empty). */
export function summarizeUsage(all: UsageRecord[], sinceMs: number, nowMs = Date.now(), maxRecords = 500): UsageSummary {
  const records = all.filter((r) => r.atMs >= sinceMs).sort((a, b) => b.atMs - a.atMs);
  const days = new Map<string, { day: string; requests: number; cSats: number }>();
  for (let t = sinceMs; t <= nowMs; t += 86_400_000) days.set(dayOf(t), { day: dayOf(t), requests: 0, cSats: 0 });
  days.set(dayOf(nowMs), days.get(dayOf(nowMs)) ?? { day: dayOf(nowMs), requests: 0, cSats: 0 });
  for (const r of records) {
    const d = days.get(dayOf(r.atMs)) ?? { day: dayOf(r.atMs), requests: 0, cSats: 0 };
    d.requests++;
    d.cSats += r.costMsat / 1000;
    days.set(d.day, d);
  }
  return {
    sinceMs,
    totals: {
      requests: records.length,
      cSats: round(records.reduce((n, r) => n + r.costMsat, 0) / 1000),
      seconds: round(records.reduce((n, r) => n + r.durationMs, 0) / 1000, 1),
      failed: records.filter((r) => !r.ok).length,
      promptTokens: records.reduce((n, r) => n + (r.promptTokens ?? 0), 0),
      outputTokens: records.reduce((n, r) => n + (r.outputTokens ?? 0), 0),
    },
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, cSats: round(d.cSats) })),
    byModel: slice(records, (r) => r.model),
    byClass: slice(records, (r) => r.computeClass),
    bySource: slice(records, (r) => r.source),
    byPlacement: slice(records, (r) => r.placement),
    records: records.slice(0, maxRecords),
  };
}

/** In-memory store when there's no database (development, tests); newest kept. */
export class MemoryUsageStore {
  private readonly rows: UsageRecord[] = [];
  constructor(private readonly cap = 50_000) {}
  add(r: UsageRecord): void {
    this.rows.push(r);
    if (this.rows.length > this.cap) this.rows.splice(0, this.rows.length - this.cap);
  }
  forAccount(accountId: string, sinceMs: number): UsageRecord[] {
    return this.rows.filter((r) => r.accountId === accountId && r.atMs >= sinceMs);
  }
}
