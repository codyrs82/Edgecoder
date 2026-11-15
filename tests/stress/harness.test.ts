// Unit tests for the stress harness's pure parts (scripts/stress/lib): metrics, saturation,
// report merging, target safety rules and the honest-output contract with the verifier.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { executionResultKey } from "../../src/swarm/verification.js";
import { honestOutput } from "../../scripts/stress/lib/agent.js";
import { redact } from "../../scripts/stress/lib/http.js";
import { Recorder, mergeEndpointData, percentile, saturationPoint, summarizeEndpoint, isOk } from "../../scripts/stress/lib/metrics.js";
import { buildReport, renderMarkdown, type RunResult } from "../../scripts/stress/lib/report-lib.js";
import { SCENARIOS, scenarioRefusal } from "../../scripts/stress/lib/scenarios.js";
import { validateProfile, type TargetProfile } from "../../scripts/stress/lib/target.js";

const profile = (name: string): TargetProfile => JSON.parse(readFileSync(`scripts/stress/targets/${name}.json`, "utf8"));

describe("metrics", () => {
  it("percentiles use nearest rank", () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(95);
    expect(percentile(s, 99)).toBe(99);
    expect(percentile([], 50)).toBeNaN();
  });

  it("counts expected rejections as non-errors", () => {
    const r = new Recorder();
    r.record("POST /result", 5, "200");
    r.record("POST /result", 6, "expected:401:signature_invalid");
    r.record("POST /result", 7, "500:boom", { response: { status: 500 } });
    const s = summarizeEndpoint("POST /result", r.data.endpoints["POST /result"]);
    expect(s.count).toBe(3);
    expect(s.errorRate).toBeCloseTo(1 / 3);
    expect(isOk("expected:404:result_not_ready")).toBe(true);
    expect(r.data.evidence).toHaveLength(1);
  });

  it("merges endpoint data from several load generators", () => {
    const a = { samples: [1, 2, 3], count: 3, outcomes: { "200": 3 } };
    const b = { samples: [10, 20], count: 2, outcomes: { "200": 1, "503:x": 1 } };
    const m = mergeEndpointData([a, b]);
    expect(m.count).toBe(5);
    expect(m.outcomes).toEqual({ "200": 4, "503:x": 1 });
    expect(m.samples.length).toBe(5);
  });

  it("finds the saturation step", () => {
    const sat = saturationPoint([
      { step: 1, offeredPerSec: 1, completedPerSec: 1, errorRate: 0, p95Ms: 100 },
      { step: 2, offeredPerSec: 2, completedPerSec: 1.95, errorRate: 0, p95Ms: 200 },
      { step: 3, offeredPerSec: 4, completedPerSec: 2.5, errorRate: 0.01, p95Ms: 900 }
    ]);
    expect(sat.lastHealthy?.step).toBe(2);
    expect(sat.firstSaturated?.step).toBe(3);
    expect(sat.reason).toMatch(/completed 2.50\/s/);
  });
});

describe("report", () => {
  const run = (region: string, ms: number[]): RunResult => {
    const r = new Recorder(1_000);
    for (const x of ms) r.record("POST /pull [coord-a]", x, "200");
    return {
      schema: "edgecoder-stress-run/1", runId: "r", scenario: "smoke", target: "t", targetKind: "remote", region, host: "h",
      startedAtMs: 1_000, endedAtMs: 11_000, scale: {} as never, metrics: r.data, phases: [], extra: {},
      invariants: [{ id: "x", title: "x", status: region === "b" ? "fail" : "pass", severity: "critical", detail: "d" }],
      findings: [], notes: []
    };
  };
  it("merges regions, keeps per-region latency and turns failed invariants into findings", () => {
    const rep = buildReport([run("a", [1, 2, 3]), run("b", [100, 200])]);
    expect(rep.totals.requests).toBe(5);
    expect(Object.keys(rep.endpointsByRegion)).toEqual(["a", "b"]);
    expect(rep.endpointsByRegion.b[0].endpoint).toBe("POST /pull");
    expect(rep.findings[0].severity).toBe("critical");
    expect(renderMarkdown(rep)).toContain("### Region b");
  });
});

describe("targets", () => {
  it("ships valid profiles", () => {
    for (const n of ["local", "remote-local", "live-regtest"]) expect(validateProfile(profile(n))).toEqual([]);
  });

  it("refuses database, docker and payout scenarios on the live target", () => {
    const live = { profile: profile("live-regtest"), creds: { tokens: {} } };
    expect(scenarioRefusal(SCENARIOS["db-slowdown"], live)).toMatch(/not allowed|database/);
    expect(scenarioRefusal(SCENARIOS["payout-storm"], live)).toMatch(/not allowed|operator|portal/);
    expect(scenarioRefusal(SCENARIOS["ramp"], live)).toBeNull();
    // Even if someone adds them to allowedScenarios, the capability flags still refuse.
    const forced = { profile: { ...profile("live-regtest"), allowedScenarios: Object.keys(SCENARIOS) }, creds: { tokens: {} } };
    expect(scenarioRefusal(SCENARIOS["db-slowdown"], forced)).toMatch(/database/);
    expect(scenarioRefusal(SCENARIOS["payout-storm"], forced)).toMatch(/operator state|portal service token/);
  });

  it("rejects a remote profile that asks for database or docker access", () => {
    expect(validateProfile({ ...profile("live-regtest"), allowDatabase: true })).toContain("a remote target may not allow database or docker access");
  });
});

describe("simulated agents", () => {
  it("honest outputs agree under the verifier's comparator, and differ per input", () => {
    const a = executionResultKey({ ok: true, output: honestOutput("print(1)") });
    expect(executionResultKey({ ok: true, output: honestOutput("print(1)") })).toBe(a);
    expect(executionResultKey({ ok: true, output: honestOutput("print(2)") })).not.toBe(a);
  });

  it("redacts API keys and invoices from recorded evidence", () => {
    const s = redact(`{"key":"eck_${"a".repeat(40)}","bolt11":"lnbcrt10u1${"q".repeat(80)}"}`);
    expect(s).not.toContain("a".repeat(40));
    expect(s).not.toContain("q".repeat(80));
  });
});
