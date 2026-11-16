// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Request metrics for the stress harness: per-endpoint latency samples, outcome counts by
 * status/code, a per-second timeline (for the saturation point) and a bounded set of evidence
 * records (request + response excerpts) for the report's Findings section.
 *
 * Everything here is plain data so a run's metrics serialize to JSON and several load generators'
 * results (one per region) merge into one report (mergeRuns in report-lib.ts).
 */

/** Kept per endpoint; beyond it samples are reservoir-sampled so percentiles stay representative. */
export const MAX_SAMPLES_PER_ENDPOINT = 20_000;
/** Evidence records kept per (endpoint, outcome). */
export const MAX_EVIDENCE_PER_OUTCOME = 3;

export interface Evidence {
  atMs: number;
  endpoint: string;
  outcome: string;
  request?: { method: string; url: string; body?: string };
  response?: { status: number; body?: string };
  note?: string;
}

export interface EndpointData {
  samples: number[];
  /** Total observations (samples may be a reservoir of them). */
  count: number;
  /** "200", "401:signature_invalid", "0:ECONNREFUSED", ... -> count */
  outcomes: Record<string, number>;
}

export interface TimelineBucket {
  /** Seconds since run start. */
  t: number;
  ok: number;
  err: number;
  /** Sum of latencies of the bucket's requests (ms), for a mean per second. */
  latencySumMs: number;
}

export interface RunMetrics {
  startedAtMs: number;
  endpoints: Record<string, EndpointData>;
  timeline: TimelineBucket[];
  counters: Record<string, number>;
  /** Named gauges sampled over time (queue depth, coordinator memory, ...). */
  series: Record<string, Array<{ t: number; v: number }>>;
  evidence: Evidence[];
}

/** An outcome is a failure unless it is 2xx or marked expected (a poll's 404, a refused attack). */
export function isOk(outcome: string): boolean {
  return /^2\d\d/.test(outcome) || outcome.startsWith("expected:");
}

export class Recorder {
  readonly data: RunMetrics;
  private readonly evidenceKeys = new Map<string, number>();
  private rngState = 0x9e3779b9;

  constructor(startedAtMs = Date.now()) {
    this.data = { startedAtMs, endpoints: {}, timeline: [], counters: {}, series: {}, evidence: [] };
  }

  /** Deterministic xorshift so a run's reservoir does not depend on Math.random. */
  private rand(): number {
    let x = this.rngState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rngState = x >>> 0;
    return this.rngState / 0x100000000;
  }

  record(endpoint: string, latencyMs: number, outcome: string, evidence?: Omit<Evidence, "atMs" | "endpoint" | "outcome">): void {
    const e = (this.data.endpoints[endpoint] ??= { samples: [], count: 0, outcomes: {} });
    e.count++;
    if (e.samples.length < MAX_SAMPLES_PER_ENDPOINT) e.samples.push(latencyMs);
    else {
      const j = Math.floor(this.rand() * e.count);
      if (j < MAX_SAMPLES_PER_ENDPOINT) e.samples[j] = latencyMs;
    }
    e.outcomes[outcome] = (e.outcomes[outcome] ?? 0) + 1;
    const now = Date.now();
    const t = Math.max(0, Math.floor((now - this.data.startedAtMs) / 1000));
    let b = this.data.timeline[this.data.timeline.length - 1];
    if (!b || b.t !== t) {
      b = this.data.timeline.find((x) => x.t === t) ?? { t, ok: 0, err: 0, latencySumMs: 0 };
      if (!this.data.timeline.includes(b)) {
        this.data.timeline.push(b);
        this.data.timeline.sort((a, c) => a.t - c.t);
      }
    }
    if (isOk(outcome)) b.ok++;
    else b.err++;
    b.latencySumMs += latencyMs;
    if (evidence && !isOk(outcome)) this.addEvidence({ endpoint, outcome, ...evidence });
  }

  addEvidence(ev: Omit<Evidence, "atMs">): void {
    const key = `${ev.endpoint}|${ev.outcome}`;
    const n = this.evidenceKeys.get(key) ?? 0;
    if (n >= MAX_EVIDENCE_PER_OUTCOME) return;
    this.evidenceKeys.set(key, n + 1);
    this.data.evidence.push({ atMs: Date.now(), ...ev });
  }

  count(name: string, n = 1): void {
    this.data.counters[name] = (this.data.counters[name] ?? 0) + n;
  }

  gauge(name: string, v: number): void {
    const t = Math.round((Date.now() - this.data.startedAtMs) / 1000);
    (this.data.series[name] ??= []).push({ t, v });
  }
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export interface EndpointSummary {
  endpoint: string;
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  errorRate: number;
  outcomes: Record<string, number>;
}

export function summarizeEndpoint(endpoint: string, e: EndpointData): EndpointSummary {
  const s = [...e.samples].sort((a, b) => a - b);
  const total = Object.values(e.outcomes).reduce((a, b) => a + b, 0);
  const errors = Object.entries(e.outcomes).filter(([k]) => !isOk(k)).reduce((a, [, v]) => a + v, 0);
  return {
    endpoint,
    count: e.count,
    p50: round(percentile(s, 50)),
    p95: round(percentile(s, 95)),
    p99: round(percentile(s, 99)),
    max: round(s.length ? s[s.length - 1] : NaN),
    errorRate: total ? errors / total : 0,
    outcomes: e.outcomes
  };
}

function round(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : n;
}

/** Merge endpoint data from several runs (load generators): samples are concatenated (capped). */
export function mergeEndpointData(parts: EndpointData[]): EndpointData {
  const out: EndpointData = { samples: [], count: 0, outcomes: {} };
  for (const p of parts) {
    out.count += p.count;
    for (const [k, v] of Object.entries(p.outcomes)) out.outcomes[k] = (out.outcomes[k] ?? 0) + v;
  }
  // Each part contributes in proportion to its count so the merged percentiles are not skewed.
  const total = parts.reduce((a, p) => a + p.count, 0) || 1;
  for (const p of parts) {
    const share = Math.max(1, Math.round((p.count / total) * MAX_SAMPLES_PER_ENDPOINT));
    const step = Math.max(1, p.samples.length / share);
    for (let i = 0; i < p.samples.length && out.samples.length < MAX_SAMPLES_PER_ENDPOINT; i += step) out.samples.push(p.samples[Math.floor(i)]);
  }
  return out;
}

/**
 * Saturation: the first step of a ramp at which the system stops keeping up. A step saturates
 * when completed work falls below `keepUpRatio` of what was offered, the error rate passes
 * `maxErrorRate`, or p95 passes `maxP95Ms`. Returns the last healthy step and the first bad one.
 */
export interface RampStep {
  step: number;
  offeredPerSec: number;
  completedPerSec: number;
  errorRate: number;
  p95Ms: number;
}

export function saturationPoint(
  steps: RampStep[],
  opts: { keepUpRatio?: number; maxErrorRate?: number; maxP95Ms?: number } = {}
): { lastHealthy: RampStep | null; firstSaturated: RampStep | null; reason: string | null } {
  const keepUp = opts.keepUpRatio ?? 0.9;
  const maxErr = opts.maxErrorRate ?? 0.05;
  const maxP95 = opts.maxP95Ms ?? 5_000;
  let lastHealthy: RampStep | null = null;
  for (const s of steps) {
    const reasons: string[] = [];
    if (s.offeredPerSec > 0 && s.completedPerSec < keepUp * s.offeredPerSec) reasons.push(`completed ${s.completedPerSec.toFixed(2)}/s < ${keepUp} x offered ${s.offeredPerSec.toFixed(2)}/s`);
    if (s.errorRate > maxErr) reasons.push(`error rate ${(s.errorRate * 100).toFixed(1)}% > ${(maxErr * 100).toFixed(1)}%`);
    if (s.p95Ms > maxP95) reasons.push(`p95 ${Math.round(s.p95Ms)} ms > ${maxP95} ms`);
    if (reasons.length) return { lastHealthy, firstSaturated: s, reason: reasons.join("; ") };
    lastHealthy = s;
  }
  return { lastHealthy, firstSaturated: null, reason: null };
}
