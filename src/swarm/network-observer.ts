// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * In-memory observations for the admin network view (GET /admin/network): model-call latency
 * (submit to first piece, submit to done), events by model (calls, refusals for lack of a model,
 * no-capacity cancellations) and a time series sampled every 15 s for 24 h.
 *
 * Everything here is bounded: a fixed-size ring for the time series, a capped list of latency
 * samples, per-minute buckets for at most 24 h with a cap on distinct models per bucket, and a cap
 * on calls followed at once. Nothing is persisted; a restart starts empty. No coordinator state is
 * imported, so this module is tested on its own.
 */

/** A fixed-capacity ring: pushing past capacity drops the oldest entry. */
export class RingBuffer<T> {
  private readonly items: Array<T | undefined>;
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("ring_capacity_invalid");
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(item: T): void {
    if (this.count < this.capacity) {
      this.items[(this.start + this.count) % this.capacity] = item;
      this.count++;
      return;
    }
    this.items[this.start] = item;
    this.start = (this.start + 1) % this.capacity;
  }

  /** Oldest first. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) out.push(this.items[(this.start + i) % this.capacity] as T);
    return out;
  }

  last(): T | undefined {
    return this.count ? this.items[(this.start + this.count - 1) % this.capacity] : undefined;
  }
}

/** The p-quantile of an ascending list (nearest rank, like dispatch.ts pickupStats). */
export function quantile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export interface Percentiles {
  count: number;
  p50: number;
  p90: number;
}

/** Durations with the time they were taken; the newest `max` are kept. */
export class TimedSamples {
  private readonly ring: RingBuffer<{ atMs: number; ms: number }>;

  constructor(max = 2_000) {
    this.ring = new RingBuffer(max);
  }

  add(ms: number, atMs = Date.now()): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.ring.push({ atMs, ms });
  }

  /** p50/p90 of the samples taken at or after `sinceMs`. */
  percentiles(sinceMs = 0): Percentiles {
    const sorted = this.ring
      .toArray()
      .filter((s) => s.atMs >= sinceMs)
      .map((s) => s.ms)
      .sort((a, b) => a - b);
    return { count: sorted.length, p50: quantile(sorted, 0.5), p90: quantile(sorted, 0.9) };
  }

  get size(): number {
    return this.ring.size;
  }
}

export type ModelEvent = "submitted" | "completed" | "failed" | "noAgentHasModel" | "noCapacity";
export type ModelEventCounts = Record<ModelEvent, number>;
const EMPTY_COUNTS = (): ModelEventCounts => ({ submitted: 0, completed: 0, failed: 0, noAgentHasModel: 0, noCapacity: 0 });

/** Model names past this many in one minute are counted under OTHER_MODEL. */
export const MAX_MODELS_PER_BUCKET = 64;
export const OTHER_MODEL = "(other)";
const MINUTE_MS = 60_000;

/** Model-call events by model, in per-minute buckets kept for `keepMs` (24 h). */
export class ModelEventCounter {
  private readonly buckets: Array<{ minute: number; byModel: Map<string, ModelEventCounts> }> = [];

  constructor(private readonly keepMs = 24 * 60 * MINUTE_MS) {}

  record(model: string, event: ModelEvent, atMs = Date.now()): void {
    const minute = Math.floor(atMs / MINUTE_MS);
    let bucket = this.buckets.at(-1);
    if (!bucket || bucket.minute !== minute) {
      // Events arrive in time order; a late one (a clock step) goes in the newest bucket.
      if (!bucket || minute > bucket.minute) {
        bucket = { minute, byModel: new Map() };
        this.buckets.push(bucket);
        this.prune(atMs);
      }
    }
    const name = String(model || "(none)").slice(0, 200);
    const key = bucket.byModel.has(name) || bucket.byModel.size < MAX_MODELS_PER_BUCKET ? name : OTHER_MODEL;
    const counts = bucket.byModel.get(key) ?? EMPTY_COUNTS();
    counts[event]++;
    bucket.byModel.set(key, counts);
  }

  /** Totals per model over buckets that start at or after the minute of `sinceMs`. */
  counts(sinceMs: number): Map<string, ModelEventCounts> {
    const from = Math.floor(sinceMs / MINUTE_MS);
    const out = new Map<string, ModelEventCounts>();
    for (const b of this.buckets) {
      if (b.minute < from) continue;
      for (const [model, c] of b.byModel) {
        const t = out.get(model) ?? EMPTY_COUNTS();
        for (const k of Object.keys(c) as ModelEvent[]) t[k] += c[k];
        out.set(model, t);
      }
    }
    return out;
  }

  get bucketCount(): number {
    return this.buckets.length;
  }

  private prune(nowMs: number): void {
    const oldest = Math.floor((nowMs - this.keepMs) / MINUTE_MS);
    while (this.buckets.length && this.buckets[0]!.minute < oldest) this.buckets.shift();
  }
}

/** How a followed call ended, when the coordinator can tell (see InferenceTracker.sweep). */
export type CallOutcome = "ok" | "failed" | "no_capacity" | undefined;

interface FollowedCall {
  taskId: string;
  model: string;
  submittedAtMs: number;
  firstChunkAtMs?: number;
}

/** Calls followed at once; past this the oldest is dropped (it is then not timed). */
export const MAX_FOLLOWED_CALLS = 10_000;
/** A call not seen to end within this long is forgotten (the longest call timeout is 300 s). */
export const FOLLOW_MAX_MS = 15 * 60_000;

/** Per-interval counts the sampler takes and resets. */
export interface IntervalCounts {
  started: number;
  completed: number;
  failed: number;
  noCapacity: number;
  noAgentHasModel: number;
}

/**
 * Model calls as the coordinator sees them: submitted, first piece accepted, done. TTFT is submit
 * to the first piece the coordinator accepted from the agent; duration is submit to the last piece
 * (or, when no last piece came, to when the result was seen).
 */
export class InferenceTracker {
  readonly ttft = new TimedSamples(2_000);
  readonly duration = new TimedSamples(2_000);
  readonly models = new ModelEventCounter();
  private readonly calls = new Map<string, FollowedCall>();
  private interval: IntervalCounts = { started: 0, completed: 0, failed: 0, noCapacity: 0, noAgentHasModel: 0 };

  get following(): number {
    return this.calls.size;
  }

  submitted(taskId: string, subtaskId: string, model: string, atMs = Date.now()): void {
    if (this.calls.size >= MAX_FOLLOWED_CALLS) {
      const oldest = this.calls.keys().next().value;
      if (oldest !== undefined) this.calls.delete(oldest);
    }
    this.calls.set(subtaskId, { taskId, model, submittedAtMs: atMs });
    this.models.record(model, "submitted", atMs);
    this.interval.started++;
  }

  /** /inference/submit refused the call: no connected agent holds the model. */
  refusedNoModel(model: string, atMs = Date.now()): void {
    this.models.record(model, "noAgentHasModel", atMs);
    this.interval.noAgentHasModel++;
  }

  /** A piece of the reply was accepted. `done` ends the call (`error` set: it failed). */
  chunk(subtaskId: string, done: boolean, error: string | undefined, atMs = Date.now()): void {
    const call = this.calls.get(subtaskId);
    if (!call) return;
    if (call.firstChunkAtMs === undefined) {
      call.firstChunkAtMs = atMs;
      if (!error) this.ttft.add(atMs - call.submittedAtMs, atMs);
    }
    if (done) this.end(subtaskId, call, error ? "failed" : "ok", atMs);
  }

  /** Settle calls that ended without a last piece: `outcome` says how (undefined: still running). */
  sweep(outcome: (taskId: string, subtaskId: string) => CallOutcome, nowMs = Date.now()): void {
    for (const [subtaskId, call] of this.calls) {
      const o = outcome(call.taskId, subtaskId);
      if (o) this.end(subtaskId, call, o, nowMs);
      else if (nowMs - call.submittedAtMs > FOLLOW_MAX_MS) this.calls.delete(subtaskId);
    }
  }

  /** Counts since the last call, then reset. */
  takeInterval(): IntervalCounts {
    const out = this.interval;
    this.interval = { started: 0, completed: 0, failed: 0, noCapacity: 0, noAgentHasModel: 0 };
    return out;
  }

  private end(subtaskId: string, call: FollowedCall, outcome: Exclude<CallOutcome, undefined>, atMs: number): void {
    this.calls.delete(subtaskId);
    if (outcome === "no_capacity") {
      this.models.record(call.model, "noCapacity", atMs);
      this.interval.noCapacity++;
      return;
    }
    this.models.record(call.model, outcome === "ok" ? "completed" : "failed", atMs);
    if (outcome === "ok") {
      this.interval.completed++;
      this.duration.add(atMs - call.submittedAtMs, atMs);
    } else {
      this.interval.failed++;
    }
  }
}

/** One point of the time series. Latency fields are null when there was nothing to measure. */
export interface NetworkSample {
  atMs: number;
  connectedAgents: number;
  busyAgents: number;
  totalSlots: number;
  freeSlots: number;
  queued: number;
  claimed: number;
  waitingInference: number;
  started: number;
  completed: number;
  failed: number;
  noCapacity: number;
  noAgentHasModel: number;
  pickupP50: number | null;
  pickupP90: number | null;
  ttftP50: number | null;
  ttftP90: number | null;
}

export const SAMPLE_INTERVAL_MS = 15_000;
/** 24 h of 15 s samples. */
export const SAMPLE_CAPACITY = (24 * 60 * 60_000) / SAMPLE_INTERVAL_MS;

/** Time ranges the series is served in, and the bucket width each is served at (240 points). */
export const SERIES_RANGES = { "1h": 60 * 60_000, "6h": 6 * 60 * 60_000, "24h": 24 * 60 * 60_000 } as const;
export type SeriesRange = keyof typeof SERIES_RANGES;
export const SERIES_POINTS = 240;

export function seriesBucketMs(range: SeriesRange): number {
  return Math.max(SAMPLE_INTERVAL_MS, Math.round(SERIES_RANGES[range] / SERIES_POINTS));
}

const GAUGES = ["connectedAgents", "busyAgents", "totalSlots", "freeSlots", "queued", "claimed", "waitingInference"] as const;
const COUNTERS = ["started", "completed", "failed", "noCapacity", "noAgentHasModel"] as const;
const P50S = ["pickupP50", "ttftP50"] as const;
const P90S = ["pickupP90", "ttftP90"] as const;

/**
 * Samples in the last `range`, merged into wall-clock buckets of seriesBucketMs(range) (so two
 * coordinators' buckets line up): gauges are averaged and rounded to 0.1, per-interval counts
 * summed, p50s averaged and p90s the bucket's worst. `atMs` is the bucket start.
 */
export function downsample(samples: readonly NetworkSample[], range: SeriesRange, nowMs = Date.now()): NetworkSample[] {
  const width = seriesBucketMs(range);
  const since = nowMs - SERIES_RANGES[range];
  const out: NetworkSample[] = [];
  let group: NetworkSample[] = [];
  let key = -1;
  const flush = () => {
    if (!group.length) return;
    const avg = (vals: number[]) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
    const s = { atMs: key * width } as NetworkSample;
    for (const g of GAUGES) s[g] = Math.round((avg(group.map((x) => x[g])) ?? 0) * 10) / 10;
    for (const c of COUNTERS) s[c] = group.reduce((a, x) => a + x[c], 0);
    for (const p of P50S) {
      const v = avg(group.map((x) => x[p]).filter((x): x is number => x !== null));
      s[p] = v === null ? null : Math.round(v);
    }
    for (const p of P90S) {
      const vals = group.map((x) => x[p]).filter((x): x is number => x !== null);
      s[p] = vals.length ? Math.max(...vals) : null;
    }
    out.push(s);
    group = [];
  };
  for (const sample of samples) {
    if (sample.atMs < since) continue;
    const k = Math.floor(sample.atMs / width);
    if (k !== key) {
      flush();
      key = k;
    }
    group.push(sample);
  }
  flush();
  return out;
}
