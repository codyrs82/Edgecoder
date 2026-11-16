import { describe, expect, test } from "vitest";
import {
  FOLLOW_MAX_MS,
  InferenceTracker,
  MAX_FOLLOWED_CALLS,
  MAX_SERIES_KEYS,
  MAX_MODELS_PER_BUCKET,
  ModelEventCounter,
  OTHER_MODEL,
  RingBuffer,
  SAMPLE_CAPACITY,
  TimedSamples,
  capKeys,
  downsample,
  seriesBucketMs,
  type NetworkSample
} from "../../src/swarm/network-observer.js";

/** In-memory observations behind GET /admin/network: every structure stays bounded. */
describe("network observer", () => {
  test("the ring keeps the newest `capacity` items, oldest first", () => {
    const ring = new RingBuffer<number>(3);
    expect(ring.toArray()).toEqual([]);
    for (let i = 1; i <= 7; i++) ring.push(i);
    expect(ring.size).toBe(3);
    expect(ring.toArray()).toEqual([5, 6, 7]);
    expect(ring.last()).toBe(7);
    expect(() => new RingBuffer(0)).toThrow();
  });

  test("the series ring holds exactly 7 days of 15 s samples and never more", () => {
    expect(SAMPLE_CAPACITY).toBe(40_320);
    const ring = new RingBuffer<number>(SAMPLE_CAPACITY);
    for (let i = 0; i < SAMPLE_CAPACITY * 2 + 17; i++) ring.push(i);
    expect(ring.size).toBe(SAMPLE_CAPACITY);
    expect(ring.toArray()[0]).toBe(SAMPLE_CAPACITY + 17);
  });

  test("timed samples are capped and give windowed p50/p90", () => {
    const t = new TimedSamples(100);
    for (let i = 1; i <= 250; i++) t.add(i, i * 1000);
    expect(t.size).toBe(100);
    expect(t.percentiles()).toEqual({ count: 100, p50: 201, p90: 241 });
    expect(t.percentiles(241_000)).toMatchObject({ count: 10 });
    t.add(-1);
    t.add(Number.NaN);
    expect(t.size).toBe(100);
  });

  test("model events: per-minute buckets kept 24 h, distinct models capped per bucket", () => {
    const c = new ModelEventCounter(60 * 60_000);
    const t0 = 1_000 * 60_000;
    c.record("llama", "submitted", t0);
    c.record("llama", "noCapacity", t0 + 1000);
    c.record("qwen", "noAgentHasModel", t0 + 61_000);
    expect(c.counts(t0).get("llama")).toMatchObject({ submitted: 1, noCapacity: 1 });
    expect(c.counts(t0 + 60_000).has("llama")).toBe(false);
    for (let m = 0; m < 200; m++) c.record(`m${m}`, "submitted", t0 + 2 * 60_000);
    const minute = c.counts(t0 + 2 * 60_000);
    expect(minute.size).toBe(MAX_MODELS_PER_BUCKET + 1);
    expect(minute.get(OTHER_MODEL)?.submitted).toBe(200 - MAX_MODELS_PER_BUCKET);
    // Two hours later the first buckets are gone (keep = 1 h).
    c.record("llama", "submitted", t0 + 120 * 60_000);
    expect(c.bucketCount).toBe(1);
  });

  test("tracker times first piece and completion, and counts per interval", () => {
    const tr = new InferenceTracker();
    tr.submitted("t1", "s1", "llama", 1_000);
    tr.chunk("s1", false, undefined, 1_400);
    tr.chunk("s1", false, undefined, 1_500);
    tr.chunk("s1", true, undefined, 3_000);
    tr.submitted("t2", "s2", "llama", 2_000);
    tr.chunk("s2", true, "model crashed", 2_100);
    tr.refusedNoModel("missing", 2_000);
    tr.submitted("t3", "s3", "qwen", 2_000);
    tr.sweep((taskId) => (taskId === "t3" ? "no_capacity" : undefined), 50_000);
    expect(tr.ttft.percentiles()).toEqual({ count: 1, p50: 400, p90: 400 });
    expect(tr.duration.percentiles()).toEqual({ count: 1, p50: 2000, p90: 2000 });
    // Unmet by model: the refusal (no holder) and the no-capacity cancellation.
    expect(tr.takeInterval()).toEqual({ started: 3, completed: 1, failed: 1, noCapacity: 1, noAgentHasModel: 1, unmetByModel: { missing: 1, qwen: 1 } });
    expect(tr.takeInterval()).toEqual({ started: 0, completed: 0, failed: 0, noCapacity: 0, noAgentHasModel: 0, unmetByModel: {} });
    expect(tr.following).toBe(0);
    const counts = tr.models.counts(0);
    expect(counts.get("missing")?.noAgentHasModel).toBe(1);
    expect(counts.get("qwen")?.noCapacity).toBe(1);
    expect(counts.get("llama")).toMatchObject({ submitted: 2, completed: 1, failed: 1 });
  });

  test("tracker follows a bounded number of calls and forgets old ones", () => {
    const tr = new InferenceTracker();
    for (let i = 0; i < MAX_FOLLOWED_CALLS + 50; i++) tr.submitted(`t${i}`, `s${i}`, "m", 0);
    expect(tr.following).toBe(MAX_FOLLOWED_CALLS);
    tr.sweep(() => undefined, FOLLOW_MAX_MS + 1);
    expect(tr.following).toBe(0);
  });

  test("downsample merges samples into wall-clock buckets", () => {
    const now = 10 * 3_600_000;
    const base = (atMs: number, over: Partial<NetworkSample> = {}): NetworkSample => ({
      atMs, connectedAgents: 2, busyAgents: 1, totalSlots: 4, freeSlots: 2, queued: 0, claimed: 1, waitingInference: 0,
      started: 1, completed: 1, failed: 0, noCapacity: 0, noAgentHasModel: 0, pickupP50: 100, pickupP90: 200, ttftP50: null, ttftP90: null, ...over
    });
    const width = seriesBucketMs("6h");
    expect(width).toBe(90_000);
    const start = Math.floor((now - 3_600_000) / width) * width;
    const samples = [base(start), base(start + 15_000, { busyAgents: 2, pickupP90: 900, ttftP50: 50, ttftP90: 80 }), base(start + width), base(now - 7 * 3_600_000)];
    const out = downsample(samples, "6h", now);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ atMs: start, busyAgents: 1.5, started: 2, pickupP50: 100, pickupP90: 900, ttftP50: 50, ttftP90: 80 });
    expect(out[1]).toMatchObject({ atMs: start + width, ttftP50: null });
    expect(seriesBucketMs("1h")).toBe(15_000);
  });

  test("7 d range: 30 min clock-aligned buckets, nothing older than 7 days", () => {
    const now = Date.UTC(2026, 10, 15, 12, 7);
    const base = (atMs: number, over: Partial<NetworkSample> = {}): NetworkSample => ({
      atMs, connectedAgents: 2, busyAgents: 1, totalSlots: 4, freeSlots: 2, queued: 0, claimed: 1, waitingInference: 0,
      started: 1, completed: 1, failed: 0, noCapacity: 0, noAgentHasModel: 0, pickupP50: 100, pickupP90: 200, ttftP50: null, ttftP90: null, ...over
    });
    const width = seriesBucketMs("7d");
    expect(width).toBe(30 * 60_000);
    const samples: NetworkSample[] = [base(now - 8 * 86_400_000)];
    for (let t = now - 7 * 86_400_000 + 1_000; t <= now; t += 15_000) samples.push(base(t));
    const out = downsample(samples, "7d", now);
    expect(out.length).toBeGreaterThanOrEqual(336);
    expect(out.length).toBeLessThanOrEqual(337);
    expect(out.every((p) => p.atMs % width === 0)).toBe(true);
    // A full bucket sums its 120 samples' counts.
    expect(out[5]).toMatchObject({ connectedAgents: 2, started: 120 });
  });

  test("buckets with no samples (coordinator down) are left out, not filled with zeros", () => {
    const now = 10 * 3_600_000;
    const s = (atMs: number): NetworkSample => ({
      atMs, connectedAgents: 3, busyAgents: 1, totalSlots: 4, freeSlots: 2, queued: 0, claimed: 1, waitingInference: 0,
      started: 1, completed: 1, failed: 0, noCapacity: 0, noAgentHasModel: 0, pickupP50: null, pickupP90: null, ttftP50: null, ttftP90: null
    });
    // Up for 10 min, down 20 min, up again for 10 min.
    const samples: NetworkSample[] = [];
    for (let t = now - 40 * 60_000; t < now - 30 * 60_000; t += 15_000) samples.push(s(t));
    for (let t = now - 10 * 60_000; t <= now; t += 15_000) samples.push(s(t));
    const out = downsample(samples, "1h", now);
    expect(out.every((p) => p.connectedAgents === 3)).toBe(true);
    expect(out.some((p) => p.atMs >= now - 30 * 60_000 && p.atMs < now - 10 * 60_000)).toBe(false);
  });

  test("unmet requests per interval are kept per model, at most MAX_SERIES_KEYS names plus (other)", () => {
    const tr = new InferenceTracker();
    for (let i = 0; i < 12; i++) for (let j = 0; j <= i; j++) tr.refusedNoModel(`m${i}`, 1_000);
    const unmet = tr.takeInterval().unmetByModel;
    expect(Object.keys(unmet)).toHaveLength(MAX_SERIES_KEYS + 1);
    expect(unmet.m11).toBe(12);
    expect(unmet.m6).toBe(7);
    expect(unmet).not.toHaveProperty("m5");
    // m0..m5 (1 + 2 + ... + 6) fold into (other).
    expect(unmet[OTHER_MODEL]).toBe(21);
  });

  test("capKeys keeps the largest keys and sums the rest, with any (other) already there", () => {
    expect(capKeys({ a: 1, b: 2 }, 3)).toEqual({ a: 1, b: 2 });
    expect(capKeys({ a: 1, b: 5, c: 3, [OTHER_MODEL]: 2 }, 2)).toEqual({ b: 5, c: 3, [OTHER_MODEL]: 3 });
    const slots = capKeys({ a: { free: 1, total: 2 }, b: { free: 0, total: 8 }, c: { free: 3, total: 4 } }, 1, (v) => v.total, (x, y) => ({ free: x.free + y.free, total: x.total + y.total }));
    expect(slots).toEqual({ b: { free: 0, total: 8 }, [OTHER_MODEL]: { free: 4, total: 6 } });
  });

  test("downsamples the gap fields: unmet summed, counts and per-key gauges averaged, old samples without them left alone", () => {
    const now = 10 * 3_600_000;
    const base = (atMs: number, over: Partial<NetworkSample> = {}): NetworkSample => ({
      atMs, connectedAgents: 3, busyAgents: 1, totalSlots: 4, freeSlots: 2, queued: 0, claimed: 1, waitingInference: 0,
      started: 0, completed: 0, failed: 0, noCapacity: 0, noAgentHasModel: 0, pickupP50: null, pickupP90: null, ttftP50: null, ttftP90: null, ...over
    });
    const width = seriesBucketMs("6h");
    const t = Math.floor((now - 30 * 60_000) / width) * width;
    const out = downsample(
      [
        // A sample stored before the gap fields existed.
        base(t - width),
        base(t, { unmetByModel: { llama: 2 }, saturatedModels: 1, staleAgents: 2, modelSlots: { llama: { free: 0, total: 4 }, qwen: { free: 2, total: 2 } }, agentsByRegion: { ord: 2, cdg: 1 } }),
        base(t + 15_000, { unmetByModel: { llama: 1, qwen: 3 }, saturatedModels: 0, staleAgents: 1, modelSlots: { llama: { free: 2, total: 4 } }, agentsByRegion: { ord: 3 } })
      ],
      "6h",
      now
    );
    expect(out).toHaveLength(2);
    expect(out[0]).not.toHaveProperty("unmetByModel");
    expect(out[0]).not.toHaveProperty("staleAgents");
    expect(out[1]).toMatchObject({
      unmetByModel: { llama: 3, qwen: 3 },
      saturatedModels: 0.5,
      staleAgents: 1.5,
      modelSlots: { llama: { free: 1, total: 4 }, qwen: { free: 1, total: 1 } },
      agentsByRegion: { ord: 2.5, cdg: 0.5 }
    });
  });
});
