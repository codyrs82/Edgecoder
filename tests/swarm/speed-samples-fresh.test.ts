import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  agentServiceTimes, hostSpeed, HOST_SPEED_WINDOW_MS, noteServiceTime, serviceTimes, ServiceTimes, SPEED_HALF_LIFE_MS, weightedMedian,
} from "../../src/swarm/coordinator/start-eta.js";
import { agentStolenAt, clearAgentSteal, noteAgentSteal, parseStealShare, SPEED_STEAL_SHARE, stolenDuring } from "../../src/swarm/coordinator/host-steal.js";

/*
 * Network validation run 7 (2026-11-25): the nearest free host was chosen 66.7 % of the time idle and
 * 36.1 % under CPU load. The portal compared two CPU hosts by their own measured speeds (#562), and
 * those had been measured while a fleet deploy had left the hosts throttled by their CPU credit: an
 * lhr buyer went to iad on "iad 936 ms vs lhr 2160 ms" and took 2.5 s (inf-1795614734673-bec45a48);
 * served locally the call took about 1 s. Speeds now decay with age, a host's own speed looks back
 * HOST_SPEED_WINDOW_MS only, and samples from calls during which the host reported CPU steal are left
 * out (host-steal.ts).
 */

const MODEL = "qwen2.5-coder:1.5b";
const LHR = "agent-lhr";
const IAD = "agent-iad";

beforeEach(() => {
  agentServiceTimes.clear();
  serviceTimes.clear();
  clearAgentSteal();
});
afterEach(() => {
  delete process.env.INFERENCE_SPEED_HALF_LIFE_MS;
  delete process.env.INFERENCE_HOST_SPEED_WINDOW_MS;
  delete process.env.INFERENCE_SPEED_STEAL_SHARE;
});

describe("weightedMedian", () => {
  it("is the plain median with equal weights", () => {
    expect(weightedMedian([1, 2, 3].map((v) => ({ v, w: 1 })))).toBe(2);
    expect(weightedMedian([1, 2, 3, 10].map((v) => ({ v, w: 1 })))).toBe(2.5);
    expect(weightedMedian([1, 2].map((v) => ({ v, w: 1 })))).toBeNull();
  });
  it("leans to the heavier samples", () => {
    expect(weightedMedian([{ v: 1, w: 4 }, { v: 2, w: 1 }, { v: 3, w: 1 }])).toBe(1);
    expect(weightedMedian([{ v: 1, w: 0.1 }, { v: 2, w: 0.1 }, { v: 3, w: 1 }])).toBe(3);
  });
});

describe("speed samples decay with age", () => {
  it("recent samples outweigh older ones", () => {
    const t = new ServiceTimes();
    const now = 10_000_000;
    // Three slow samples 8 minutes ago (throttled), two fast ones just now.
    for (let i = 0; i < 3; i++) t.record(MODEL, "cpu", 2_160, now - 8 * 60_000, 1_000);
    for (let i = 0; i < 2; i++) t.record(MODEL, "cpu", 1_000, now - 1_000, 1_000);
    expect(t.speed(MODEL, "cpu", now)).toBeCloseTo(1.0);
    // Without the weighting, the old ones are the median.
    process.env.INFERENCE_SPEED_HALF_LIFE_MS = "0";
    expect(t.speed(MODEL, "cpu", now)).toBeCloseTo(2.16);
  });

  it("a host's own speed drops samples older than its window; a class's keeps them", () => {
    const now = 10_000_000;
    const old = now - HOST_SPEED_WINDOW_MS - 1_000;
    for (let i = 0; i < 3; i++) noteServiceTime(MODEL, LHR, old - 2_160, old, { promptTokens: 20, outputTokens: 8 });
    expect(agentServiceTimes.speed(MODEL, LHR, now)).toBeNull();
    expect(serviceTimes.speed(MODEL, "cpu", now)).not.toBeNull();
    expect(hostSpeed(MODEL, LHR, "cpu", now)?.from).toBe("class");
    // INFERENCE_HOST_SPEED_WINDOW_MS widens it.
    process.env.INFERENCE_HOST_SPEED_WINDOW_MS = String(HOST_SPEED_WINDOW_MS * 1.5);
    expect(hostSpeed(MODEL, LHR, "cpu", now)).toMatchObject({ from: "host", ageMs: HOST_SPEED_WINDOW_MS + 1_000 });
  });

  it("defaults", () => {
    expect(SPEED_HALF_LIFE_MS).toBe(180_000);
    expect(HOST_SPEED_WINDOW_MS).toBe(600_000);
  });
});

describe("samples from a host stolen from do not count", () => {
  const tokens = { promptTokens: 20, outputTokens: 8 };

  it("parses INFERENCE_SPEED_STEAL_SHARE", () => {
    expect(parseStealShare(undefined)).toBe(SPEED_STEAL_SHARE);
    expect(parseStealShare("0.4")).toBe(0.4);
    expect(parseStealShare("off")).toBeNull();
    expect(parseStealShare("0")).toBeNull();
    expect(parseStealShare("7")).toBe(SPEED_STEAL_SHARE);
  });

  it("run 7's case: lhr's throttled calls leave no speed, and the lhr buyer's host is judged as its class", () => {
    const t0 = 10_000_000;
    // lhr ran three calls throttled after the deploy; its pieces said so.
    for (let i = 0; i < 3; i++) {
      const claimed = t0 + i * 5_000;
      noteAgentSteal(LHR, { cpuStealShare: 0.9 }, claimed + 1_000);
      noteServiceTime(MODEL, LHR, claimed, claimed + 2_160, tokens);
    }
    // iad, not throttled.
    for (let i = 0; i < 3; i++) {
      noteAgentSteal(IAD, { cpuStealShare: 0.02, cpuThrottled: false }, t0 + i * 5_000);
      noteServiceTime(MODEL, IAD, t0 + i * 5_000, t0 + i * 5_000 + 936, tokens);
    }
    const now = t0 + 20_000;
    expect(agentServiceTimes.speed(MODEL, LHR, now)).toBeNull();
    expect(hostSpeed(MODEL, LHR, "cpu", now)?.from).toBe("class");
    expect(hostSpeed(MODEL, IAD, "cpu", now)?.from).toBe("host");
    // The class's speed is iad's alone (lhr's throttled samples left out of it too).
    expect(serviceTimes.speed(MODEL, "cpu", now)).toBeCloseTo(agentServiceTimes.speed(MODEL, IAD, now)!);
    // Throttling over: lhr's next calls measure it as it is, and the old ones do not linger.
    for (let i = 0; i < 3; i++) {
      const claimed = t0 + 60_000 + i * 5_000;
      noteAgentSteal(LHR, { cpuStealShare: 0.01, cpuThrottled: false }, claimed);
      noteServiceTime(MODEL, LHR, claimed, claimed + 1_000, tokens);
    }
    const later = t0 + 80_000;
    const lhr = hostSpeed(MODEL, LHR, "cpu", later)!;
    const iad = hostSpeed(MODEL, IAD, "cpu", later)!;
    expect(lhr.from).toBe("host");
    expect(lhr.speed / iad.speed).toBeCloseTo(1_000 / 936, 2);
  });

  it("a host's samples from before its last stolen report do not count", () => {
    const t0 = 10_000_000;
    for (let i = 0; i < 3; i++) noteServiceTime(MODEL, LHR, t0 + i * 1_000, t0 + i * 1_000 + 2_000, tokens);
    expect(hostSpeed(MODEL, LHR, "cpu", t0 + 5_000)?.from).toBe("host");
    // The guard reports throttling a few seconds later (its reading spans ~5 s).
    noteAgentSteal(LHR, { cpuThrottled: true }, t0 + 6_000);
    expect(agentStolenAt(LHR)).toBe(t0 + 6_000);
    expect(hostSpeed(MODEL, LHR, "cpu", t0 + 7_000)?.from).toBe("class");
  });

  it("a genuinely slower host with fresh, unthrottled samples keeps its speed", () => {
    const t0 = 10_000_000;
    for (let i = 0; i < 3; i++) {
      noteAgentSteal(LHR, { cpuStealShare: 0.03, cpuThrottled: false }, t0 + i * 5_000);
      noteServiceTime(MODEL, LHR, t0 + i * 5_000, t0 + i * 5_000 + 3_000, tokens);
      noteServiceTime(MODEL, IAD, t0 + i * 5_000, t0 + i * 5_000 + 900, tokens);
    }
    const now = t0 + 20_000;
    const lhr = hostSpeed(MODEL, LHR, "cpu", now)!;
    const iad = hostSpeed(MODEL, IAD, "cpu", now)!;
    expect(lhr).toMatchObject({ from: "host" });
    expect(lhr.ageMs).toBeLessThan(10_000);
    expect(lhr.speed / iad.speed).toBeGreaterThan(3);
  });

  it("small steal is noise; a call claimed well after the last report is not stolen; off ignores reports", () => {
    noteAgentSteal(LHR, { cpuStealShare: 0.1 }, 1_000);
    expect(agentStolenAt(LHR)).toBeUndefined();
    noteAgentSteal(LHR, { cpuStealShare: 0.3 }, 1_000);
    expect(stolenDuring(LHR, 5_000)).toBe(true);
    expect(stolenDuring(LHR, 20_000)).toBe(false);
    process.env.INFERENCE_SPEED_STEAL_SHARE = "off";
    expect(stolenDuring(LHR, 5_000)).toBe(false);
    noteAgentSteal(IAD, { cpuThrottled: true }, 1_000);
    delete process.env.INFERENCE_SPEED_STEAL_SHARE;
    expect(agentStolenAt(IAD)).toBeUndefined();
  });
});
