// Unit tests for the live-network load generator's pure parts (scripts/loadgen): schedules and
// their hard cap, mergeable histograms, error classes and the coding-session workload.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { HARD_MAX_RATE, PROFILES, buildSchedule, parseDuration } from "../../scripts/loadgen/profiles.mjs";
// @ts-expect-error plain .mjs script without type declarations
import { StageStats, classifyCall, classifyError, digestStage, histAdd, histPct, isFailure, mergeStage } from "../../scripts/loadgen/stats.mjs";
// @ts-expect-error plain .mjs script without type declarations
import { CapacityPlanner, parseModelId, shareOf } from "../../scripts/loadgen/planner.mjs";
// @ts-expect-error plain .mjs script without type declarations
import { capacityFrom } from "../../scripts/loadgen/capacity.mjs";
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
    expect(classifyError(401, "invalid api key")).toBe("auth_error");
    expect(isFailure("no_capacity")).toBe(true);
    expect(isFailure("http_502")).toBe(true);
    expect(isFailure("stream_error")).toBe(true);
    expect(isFailure("insufficient_funds")).toBe(true);
    expect(isFailure("auth_error")).toBe(true);
    expect(isFailure("over_capacity")).toBe(false);
    expect(isFailure("timeout_over_capacity")).toBe(false);
    expect(isFailure("no_agent_in_class")).toBe(false);
  });

  it("says how a streamed call ended instead of one stream_error", () => {
    const cf502 = '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->';
    // The connection closed under the client (undici "terminated"): before or after the first token.
    expect(classifyCall({ status: 200, errBody: "terminated", failure: "network", gotHeaders: true, tokens: true })).toBe("stream_cut_after_tokens");
    expect(classifyCall({ status: 200, errBody: "terminated", failure: "network", gotHeaders: true, tokens: false })).toBe("stream_cut_before_tokens");
    expect(classifyCall({ status: 0, errBody: "ECONNRESET", failure: "network", gotHeaders: false })).toBe("network_error");
    // The client's own bounds: the deadline (before / after tokens) and no byte, keepalives included.
    expect(classifyCall({ status: 0, failure: "timeout" })).toBe("timeout");
    expect(classifyCall({ status: 200, failure: "timeout", gotHeaders: true, tokens: true })).toBe("timeout_after_tokens");
    expect(classifyCall({ status: 200, failure: "idle", gotHeaders: true })).toBe("stream_idle_timeout");
    expect(classifyCall({ status: 0, failure: "idle", gotHeaders: false })).toBe("no_response_timeout");
    // An edge proxy's page vs the portal's own JSON error.
    expect(classifyCall({ status: 502, errBody: cf502, gotHeaders: true })).toBe("upstream_502");
    expect(classifyCall({ status: 502, errBody: "", gotHeaders: true })).toBe("upstream_502");
    expect(classifyCall({ status: 502, errBody: '{"error":{"message":"Network request failed: x","type":"api_error","code":502}}', gotHeaders: true })).toBe("http_502");
    // Error events inside the stream.
    const ev = (message: string, type = "api_error", code = 502) => JSON.stringify({ message, type, code });
    expect(classifyCall({ status: 200, gotHeaders: true, inband: true, errBody: ev("The machine running qwen2.5-coder:1.5b reported: timed out after 180 s") })).toBe("agent_error");
    expect(classifyCall({ status: 200, gotHeaders: true, inband: true, tokens: true, errBody: ev("The machine running qwen3.5:9b reported: agent_lost_mid_reply: the machine stopped responding") })).toBe("agent_lost_mid_reply");
    expect(classifyCall({ status: 200, gotHeaders: true, inband: true, errBody: ev("EdgeCoder is restarting; retry the request.", "server_restarting", 503) })).toBe("server_restarting");
    expect(classifyCall({ status: 200, gotHeaders: true, inband: true, errBody: ev("Network stream failed: unknown_stream") })).toBe("relay_error");
    expect(classifyCall({ status: 200, gotHeaders: true, inband: true, errBody: ev("The network didn't finish within 6 minutes.", "api_error", 504) })).toBe("relay_timeout");
    expect(classifyCall({ status: 200, gotHeaders: true, inband: true, errBody: ev("No agent could take this call", "no_capacity", 503) })).toBe("no_capacity");
    expect(classifyCall({ status: 200, gotHeaders: true, inband: true, errBody: ev("something else") })).toBe("inband_error");
    // A clean end, and a 200 stream that just stopped without [DONE] (was counted as a success).
    expect(classifyCall({ status: 200, gotHeaders: true, tokens: true, sawDone: true })).toBeNull();
    expect(classifyCall({ status: 200, gotHeaders: true, tokens: true, sawDone: false })).toBe("stream_truncated");
    for (const e of ["stream_cut_after_tokens", "stream_cut_before_tokens", "stream_idle_timeout", "upstream_502", "agent_lost_mid_reply", "server_restarting", "stream_truncated"]) expect(isFailure(e)).toBe(true);
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

describe("capacity planner", () => {
  const snapshot = capacityFrom([
    {
      models: [
        { model: "qwen2.5-coder:1.5b", slots: 20, freeSlots: 20, agents: 9 },
        { model: "qwen3-coder:30b", slots: 1, freeSlots: 1, agents: 1 },
        { model: "qwen2.5-coder:7b", slots: 4, freeSlots: 4, agents: 1 },
      ],
      agents: [
        { computeClass: "cpu", slots: 2, freeSlots: 2, modelsInstalled: ["qwen2.5-coder:1.5b"], connected: true },
        { computeClass: "gpu.dc", slots: 1, freeSlots: 1, modelsInstalled: ["qwen3-coder:30b"], connected: true },
        { computeClass: "cpu", slots: 4, freeSlots: 4, modelsInstalled: ["qwen2.5-coder:7b"], connected: true },
        { computeClass: "cpu", slots: 2, freeSlots: 0, modelsInstalled: ["qwen2.5-coder:1.5b"], connected: false },
      ],
    },
    null,
  ]);

  it("reads slots and classes from /admin/network snapshots", () => {
    expect(snapshot.models["qwen3-coder:30b"]).toMatchObject({ slots: 1, classes: ["gpu.dc"] });
    expect(snapshot.classes.cpu).toEqual({ slots: 6, freeSlots: 6, agents: 2 });
  });

  it("splits a model's cap over the machines without exceeding it", () => {
    for (const [cap, n] of [[1, 4], [4, 4], [30, 4], [7, 3]]) {
      const total = Array.from({ length: n }, (_, i) => shareOf(cap, n, i, "m")).reduce((a, b) => a + b, 0);
      expect(total).toBe(cap);
    }
  });

  it("caps scarce models at their slots across all machines and oversubscribes the bulk", () => {
    const shares = (key: string) => Array.from({ length: 4 }, (_, i) => new CapacityPlanner({ machines: 4, index: i, capacity: snapshot }).share(key));
    expect(shares("qwen3-coder:30b").reduce((a, b) => a + b, 0)).toBe(1);
    expect(shares("qwen2.5-coder:7b").reduce((a, b) => a + b, 0)).toBe(4);
    expect(shares("qwen2.5-coder:1.5b").reduce((a, b) => a + b, 0)).toBe(30);
  });

  it("puts most of the load on the model with free slots", () => {
    const p = new CapacityPlanner({ machines: 1, index: 0, capacity: snapshot });
    let seed = 1;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 200; i++) {
      const m = p.pick({ "network/qwen2.5-coder:1.5b": 1, "network/qwen3-coder:30b": 1 }, r);
      counts[m.key] = (counts[m.key] ?? 0) + 1;
    }
    expect(counts["qwen2.5-coder:1.5b"]).toBeGreaterThan(150);
  });

  it("never sends more than a model's share and backs it off on over-capacity", () => {
    const p = new CapacityPlanner({ machines: 1, index: 0, capacity: snapshot, now: () => t });
    let t = 0;
    const atCap = p.start("qwen3-coder:30b");
    expect(atCap).toBe(true);
    expect(p.pick({ "network/qwen3-coder:30b": 1 }, () => 0.5)).toBeNull();
    expect(p.finish("qwen3-coder:30b", "no_capacity", atCap)).toBe("over_capacity");
    expect(p.headroom("qwen3-coder:30b")).toBe(0); // penalty
    t += 31_000;
    expect(p.headroom("qwen3-coder:30b")).toBe(1);
    // Below its share a no_capacity is a real failure.
    const bulkAtCap = p.start("qwen2.5-coder:1.5b");
    expect(bulkAtCap).toBe(false);
    expect(p.finish("qwen2.5-coder:1.5b", "no_capacity", bulkAtCap)).toBe("no_capacity");
    expect(p.finish("qwen2.5-coder:1.5b", "timeout", true)).toBe("timeout_over_capacity");
  });

  it("drops a class nobody holds and skips models nobody holds", () => {
    const p = new CapacityPlanner({ capacity: snapshot });
    expect(p.resolve("network/qwen2.5-coder:7b@apple")).toMatchObject({ id: "network/qwen2.5-coder:7b", rewrittenFrom: "network/qwen2.5-coder:7b@apple" });
    expect(p.resolve("network/qwen3-coder:30b@gpu.dc")).toMatchObject({ id: "network/qwen3-coder:30b@gpu.dc" });
    expect(p.resolve("network/deepseek-r1:14b")).toBeNull();
    expect(parseModelId("auto")).toEqual({ key: "auto", cls: null });
  });
});
