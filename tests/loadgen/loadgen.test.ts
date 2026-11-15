// Unit tests for the live-network load generator's pure parts (scripts/loadgen): schedules and
// their hard cap, mergeable histograms, error classes and the coding-session workload.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { HARD_MAX_RATE, PROFILES, buildSchedule, parseDuration } from "../../scripts/loadgen/profiles.mjs";
// @ts-expect-error plain .mjs script without type declarations
import { StageStats, classifyError, digestStage, histAdd, histPct, isLoadError, mergeStage } from "../../scripts/loadgen/stats.mjs";
// @ts-expect-error plain .mjs script without type declarations
import { CodingSession, approxTokens, question, rng } from "../../scripts/loadgen/workload.mjs";

describe("schedules", () => {
  it("never exceeds the 16 calls/s network cap, whatever the flags say", () => {
    for (const name of Object.keys(PROFILES)) {
      const s = buildSchedule(name, { rate: 100 });
      expect(s.stages.every((st: { rate: number }) => st.rate <= HARD_MAX_RATE)).toBe(true);
    }
    expect(buildSchedule("ramp", { maxRate: 8 }).stages.map((s: { rate: number }) => s.rate)).toEqual([0.5, 2, 4, 8, 8, 8]);
  });

  it("caps smoke at 3 calls/s and 2 minutes", () => {
    const s = buildSchedule("smoke", { rate: 10, durationSec: 3600 });
    expect(s.durationSec).toBe(120);
    expect(s.stages[0].rate).toBe(3);
  });

  it("cuts a ramp at --duration and loops soak", () => {
    const ramp = buildSchedule("ramp", { stageSeconds: 180, durationSec: 900 });
    expect(ramp.stages.map((s: { rate: number }) => s.rate)).toEqual([0.5, 2, 4, 8, 12]);
    expect(ramp.durationSec).toBe(900);
    const soak = buildSchedule("soak", { durationSec: 7200 });
    expect(soak.stages).toHaveLength(8);
    expect(soak.stages[4].rate).toBe(soak.stages[0].rate);
  });

  it("holds a single-stage profile for --duration", () => {
    const s = buildSchedule("steady", { durationSec: 600, rate: 6 });
    expect(s.stages).toEqual([{ index: 0, rate: 6, startSec: 0, seconds: 600 }]);
  });

  it("parses durations", () => {
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("5m")).toBe(300);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("45")).toBe(45);
    expect(() => parseDuration("soon")).toThrow();
  });
});

describe("stats", () => {
  it("gives percentiles within the bucket width and merges across machines", () => {
    const a: Record<string, number> = {}, b: Record<string, number> = {};
    for (let i = 1; i <= 100; i++) histAdd(i <= 50 ? a : b, i * 10);
    const sa = new StageStats({ index: 0, rate: 1 }), sb = new StageStats({ index: 0, rate: 1 });
    sa.all.total = a;
    sb.all.total = b;
    const m = mergeStage(mergeStage(undefined, sa.toJSON()), sb.toJSON());
    const p50 = histPct(m.all.total, 50), p90 = histPct(m.all.total, 90);
    expect(Math.abs(p50 - 500) / 500).toBeLessThan(0.06);
    expect(Math.abs(p90 - 900) / 900).toBeLessThan(0.06);
    expect(m.rate).toBe(2);
  });

  it("classifies the network's errors", () => {
    expect(classifyError(404, "No machine on the network has qwen2.5-coder:7b right now.")).toBe("no_agent_has_model");
    expect(classifyError(404, "No apple machine runs qwen2.5-coder:7b right now; it runs on: cpu.")).toBe("no_agent_in_class");
    expect(classifyError(200, '{"type":"no_capacity"}')).toBe("no_capacity");
    expect(classifyError(429, "")).toBe("rate_limited");
    expect(classifyError(402, "Not enough cSats")).toBe("insufficient_funds");
    expect(classifyError("timeout", "")).toBe("timeout");
    expect(isLoadError("no_capacity")).toBe(true);
    expect(isLoadError("http_502")).toBe(true);
    expect(isLoadError("no_agent_in_class")).toBe(false);
    expect(isLoadError("insufficient_funds")).toBe(false);
  });

  it("digests a stage by model, class and behaviour", () => {
    const s = new StageStats({ index: 2, rate: 4 });
    s.add({ behaviour: "chat", model: "network/qwen2.5-coder:7b@apple", error: null, ttftMs: 100, totalMs: 200, correct: true, cSats: 0.5 });
    s.add({ behaviour: "chat", model: "auto", error: "no_capacity", ttftMs: null, totalMs: 15000, correct: null, cSats: 0 });
    s.endMs = s.startMs + 10_000;
    const d = digestStage(s.toJSON());
    expect(d.calls).toBe(2);
    expect(d.successPct).toBe(50);
    expect(d.accuracyPct).toBe(100);
    expect(Object.keys(d.byClass).sort()).toEqual(["apple", "auto"]);
    expect(d.errors).toEqual({ no_capacity: 1 });
  });
});

describe("workload", () => {
  it("has a checkable answer for every question", () => {
    for (let i = 0; i < 16; i++) expect(typeof question(i).ok).toBe("function");
    expect(question(2).ok("Paris.")).toBe(true);
  });

  it("grows a coding session from ~2K towards its target and checks the needle", () => {
    const s = new CodingSession({ id: "t", model: "network/qwen3-coder:30b", seed: 42, targetTokens: 20_000 });
    const first = s.next();
    expect(first.contextTokens).toBeGreaterThan(1_500);
    expect(first.contextTokens).toBeLessThan(2_600);
    const value = (s as unknown as { pending: { value: number } }).pending.value;
    expect(s.record({ text: "", toolCalls: [{ id: "c1", function: { name: "answer", arguments: JSON.stringify({ value: String(value) }) } }] })).toBe(true);
    let turns = 1;
    while (!s.done && turns < 20) {
      s.next();
      s.record({ text: "no idea" });
      turns++;
    }
    expect(approxTokens(s.messages)).toBeGreaterThan(18_000);
    expect(turns).toBeLessThanOrEqual(12);
  });

  it("is deterministic per seed", () => {
    const a = rng(7), b = rng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
