import { describe, expect, test } from "vitest";
import {
  FOLLOW_MAX_MS,
  InferenceTracker,
  MAX_FOLLOWED_CALLS,
  MAX_MODELS_PER_BUCKET,
  ModelEventCounter,
  OTHER_MODEL,
  RingBuffer,
  SAMPLE_CAPACITY,
  TimedSamples,
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

  test("the series ring holds exactly 24 h of 15 s samples and never more", () => {
    expect(SAMPLE_CAPACITY).toBe(5760);
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
    expect(tr.takeInterval()).toEqual({ started: 3, completed: 1, failed: 1, noCapacity: 1, noAgentHasModel: 1 });
    expect(tr.takeInterval()).toEqual({ started: 0, completed: 0, failed: 0, noCapacity: 0, noAgentHasModel: 0 });
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
});
