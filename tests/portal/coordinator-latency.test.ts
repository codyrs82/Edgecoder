import { describe, expect, it, vi } from "vitest";
import { callSizeFor, createChatCapacityDirectory, LOAD_REPORT_MAX_AGE_MS, type CapacityReport } from "../../src/portal/chat-capacity.js";
import { chooseByLatency, equallyFast, expectedLatency, hostCallMs, latencyPolicyFromEnv, type FreeHost, type LatencyCandidate, type LatencyPolicy } from "../../src/portal/coordinator-latency.js";
import { callSizeOf } from "../../src/portal/routes/hosted.js";
import { clientRegionOf, sanitizeCoordinatorChoice } from "../../src/common/coordinator-choice.js";
import { streamNetworkCompletion } from "../../src/apps/ide/network-inference.js";

/*
 * Latency-aware coordinator choice: the load rule's pick stands unless another coordinator is
 * faster by the margin (30 ms and 15 %) and has a free slot, or the pick has no free slot (overflow).
 * A coordinator without the model, or with a stale load report, is never chosen for latency.
 */

const US = "https://coordinator.example.com";
const EU = "https://coordinator-eu.example.com";
const POLICY: LatencyPolicy = { enabled: true, marginMs: 30, marginPct: 15, maxReportAgeMs: LOAD_REPORT_MAX_AGE_MS };
const cand = (o: Partial<LatencyCandidate> & { url: string }): LatencyCandidate => ({
  free: 2, waiting: 0, agents: 2, rttMs: 10, pickupP90Ms: 200, callP50Ms: 8_000, agentRttMs: 20, reportAgeMs: 100, ...o,
});

describe("expected latency", () => {
  it("is the round trip and the agent round trip when a slot is free: no queueing", () => {
    expect(expectedLatency(cand({ url: US, rttMs: 99 }), 2_000)).toEqual({ queueMs: 0, expectedMs: 119, stale: false });
  });
  it("does not count a backlog-inflated pickup p90 while slots are free (run 4: US 2,103 ms with 14 free)", () => {
    // inf-1795589138500-c70eb012: rtt 7, pickup p90 1,928, agent rtt 168, 14 free slots.
    expect(expectedLatency(cand({ url: US, rttMs: 7, pickupP90Ms: 1_928, agentRttMs: 168, free: 14, agents: 7 }), 2_000)).toEqual({ queueMs: 0, expectedMs: 175, stale: false });
    // The same coordinator with no free slot does wait for pickup and a round of calls.
    expect(expectedLatency(cand({ url: US, rttMs: 7, pickupP90Ms: 1_928, agentRttMs: 168, free: 0, agents: 7, callP50Ms: 4_000 }), 2_000).queueMs).toBe(1_928 + 4_000);
  });
  it("adds a call duration per round of calls ahead when no slot is free", () => {
    // free -3 over 2 agents: (1 + 3) / 2 = 2 rounds of 8 s.
    expect(expectedLatency(cand({ url: US, free: -3 }), 2_000).queueMs).toBe(200 + 16_000);
  });
  it("is unknown without a round trip or with a stale report", () => {
    expect(expectedLatency(cand({ url: US, rttMs: null }), 2_000).expectedMs).toBeNull();
    expect(expectedLatency(cand({ url: US, reportAgeMs: 2_500 }), 2_000)).toMatchObject({ expectedMs: null, stale: true });
  });
});

describe("chooseByLatency", () => {
  it("a nearer coordinator with a free slot wins only above the margin", () => {
    // Portal machine in Europe: the US pick (more free slots) is ~95 ms further away.
    const far = chooseByLatency([cand({ url: US, free: 5, agents: 9, rttMs: 100 }), cand({ url: EU, free: 1, rttMs: 5 })], US, POLICY, { clientRegion: "lhr", portalRegion: "cdg" });
    expect(far).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "latency", clientRegion: "lhr", portalRegion: "cdg" });
    expect(far.reason).toMatch(/faster with a free slot: expected 25 ms vs 120 ms/);
    expect(far.candidates.map((c) => c.expectedMs)).toEqual([120, 25]);
    // 25 ms faster: under the 30 ms margin, the load pick stands.
    const near = chooseByLatency([cand({ url: US, free: 5, rttMs: 30 }), cand({ url: EU, free: 1, rttMs: 5 })], US, POLICY);
    expect(near).toMatchObject({ chosen: "coordinator.example.com", rule: "load" });
    expect(near.reason).toMatch(/not faster by the margin/);
    // 40 ms faster but under 15 % of a slow baseline (agents far away): the load pick stands.
    const pct = chooseByLatency([cand({ url: US, rttMs: 45, agentRttMs: 400 }), cand({ url: EU, free: 1, rttMs: 5, agentRttMs: 400 })], US, POLICY);
    expect(pct.rule).toBe("load");
  });

  it("never moves a call to a slower coordinator to balance load", () => {
    // The load rule picked the EU (more free slots), but it is 90 ms further from this portal.
    const c = chooseByLatency([cand({ url: US, free: 1, agents: 9, rttMs: 2 }), cand({ url: EU, free: 3, rttMs: 99 })], EU, POLICY);
    expect(c).toMatchObject({ chosen: "coordinator.example.com", rule: "latency" });
  });

  it("does not move to a nearer coordinator that has no free slot while the pick has one", () => {
    const c = chooseByLatency([cand({ url: US, free: 1, rttMs: 100 }), cand({ url: EU, free: 0, rttMs: 5, callP50Ms: 1 })], US, POLICY);
    expect(c.rule).toBe("load");
    expect(c.chosen).toBe("coordinator.example.com");
  });

  it("overflows from a congested pick to a coordinator that is faster even after the distance", () => {
    // Everything busy; the US (9 agents) takes the backlog share, but 12 calls queue there.
    const c = chooseByLatency([cand({ url: US, free: -12, waiting: 12, agents: 9, rttMs: 2 }), cand({ url: EU, free: 1, rttMs: 99 })], US, POLICY);
    expect(c).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "overflow" });
    expect(c.reason).toMatch(/^overflow: coordinator\.example\.com has no free slot/);
    // A congested pick still beats a farther one that is just as congested.
    const both = chooseByLatency([cand({ url: US, free: -2, agents: 9, rttMs: 2 }), cand({ url: EU, free: -2, agents: 2, rttMs: 99 })], US, POLICY);
    expect(both.rule).toBe("load");
  });

  it("keeps the load pick when its latency is unknown, and when the choice is off", () => {
    expect(chooseByLatency([cand({ url: US, reportAgeMs: 5_000 }), cand({ url: EU, rttMs: 1 })], US, POLICY)).toMatchObject({ chosen: "coordinator.example.com", rule: "load", reason: expect.stringMatching(/stale load report/) });
    expect(chooseByLatency([cand({ url: US, rttMs: 300 }), cand({ url: EU, rttMs: 1 })], US, { ...POLICY, enabled: false }).rule).toBe("load");
    expect(chooseByLatency([cand({ url: US })], US, POLICY).rule).toBe("single");
  });

  it("reads its policy from the environment", () => {
    expect(latencyPolicyFromEnv({}, 2_000)).toEqual({ enabled: true, marginMs: 30, marginPct: 15, localityMarginKm: 700, speedFreshMs: 300_000, maxReportAgeMs: 2_000 });
    expect(latencyPolicyFromEnv({ PORTAL_COORD_LATENCY_ROUTING: "off", PORTAL_COORD_LATENCY_MARGIN_MS: "50", PORTAL_COORD_LATENCY_MARGIN_PCT: "250", PORTAL_COORD_LOCALITY_MARGIN_KM: "0" }, 2_000)).toEqual({ enabled: false, marginMs: 50, marginPct: 100, localityMarginKm: 0, speedFreshMs: 300_000, maxReportAgeMs: 2_000 });
  });
});

/** Network reports with a measured round trip; `slowMs` moves the clock while that probe is out. */
function directory(reports: Record<string, CapacityReport & { slowMs?: number }>) {
  let t = 1_000_000;
  const probe = vi.fn(async (url: string) => {
    const { slowMs, ...r } = reports[url];
    if (slowMs) t += slowMs;
    return r;
  });
  const dir = createChatCapacityDirectory({ candidates: async () => Object.keys(reports), allowed: () => true, ttlMs: 15_000, now: () => t, probe, latency: POLICY, portalRegion: "cdg" });
  return { dir, probe, advance: (ms: number) => void (t += ms) };
}
const M = "qwen2.5-coder:7b";
const report = (o: { rttMs: number; free: number; agents: number; waiting?: number; models?: string[]; slowMs?: number }): CapacityReport & { slowMs?: number } => ({
  reachable: true,
  rttMs: o.rttMs,
  agentModels: o.models ?? [M],
  modelLoad: Object.fromEntries((o.models ?? [M]).map((m) => [m, { agents: o.agents, idle: 0, free: o.free, waiting: o.waiting ?? 0, agentRttMs: 20 }])),
  pickupP90Ms: 200,
  callP50Ms: 8_000,
  ...(o.slowMs ? { slowMs: o.slowMs } : {}),
});

describe("the portal's coordinator directory", () => {
  it("sends a call to the nearer coordinator with a free slot and says why", async () => {
    const { dir } = directory({ [US]: report({ rttMs: 100, free: 6, agents: 9 }), [EU]: report({ rttMs: 4, free: 2, agents: 2 }) });
    const p = await dir.pick({ kind: "network", model: M }, [], { clientRegion: "lhr" });
    expect(p.url).toBe(EU);
    expect(p.choice).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "latency", clientRegion: "lhr", portalRegion: "cdg" });
  });

  it("a nearer coordinator without the model loses", async () => {
    const { dir } = directory({ [US]: report({ rttMs: 100, free: 6, agents: 9 }), [EU]: report({ rttMs: 4, free: 2, agents: 2, models: ["other:1b"] }) });
    const p = await dir.pick({ kind: "network", model: M });
    expect(p.url).toBe(US);
    expect(p.choice).toMatchObject({ rule: "single" });
  });

  it("overflows when the home coordinator's slots are taken by calls already sent", async () => {
    const { dir } = directory({ [US]: report({ rttMs: 2, free: 1, agents: 9 }), [EU]: report({ rttMs: 99, free: 2, agents: 2 }) });
    // Portal near the US: the first call stays there (the EU has more free slots but is 97 ms further).
    expect((await dir.pick({ kind: "network", model: M })).choice).toMatchObject({ chosen: "coordinator.example.com", rule: "latency" });
    // That took the US slot; the next call would queue behind it, so it goes to the EU.
    const next = await dir.pick({ kind: "network", model: M });
    expect(next.url).toBe(EU);
    expect(next.choice?.rule).toBe("load");
  });

  it("overflows from a queued home coordinator to a farther one with room", async () => {
    const { dir } = directory({ [US]: report({ rttMs: 2, free: 0, waiting: 14, agents: 9 }), [EU]: report({ rttMs: 99, free: 0, waiting: 0, agents: 2 }) });
    // Both full: the backlog share sends it to the EU already; the latency step agrees (US queue is longer).
    const p = await dir.pick({ kind: "network", model: M });
    expect(p.url).toBe(EU);
    const { dir: d2 } = directory({ [US]: report({ rttMs: 2, free: 0, waiting: 20, agents: 9 }), [EU]: report({ rttMs: 99, free: 1, agents: 2 }) });
    expect((await d2.pick({ kind: "network", model: M })).url).toBe(EU);
  });

  it("ignores a stale load report", async () => {
    // The EU's answer is slow: the probe sent for an earlier call comes back 2.5 s later, older
    // than LOAD_REPORT_MAX_AGE_MS. The US is asked again and is fresh; the EU is not compared.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const reports: Record<string, CapacityReport> = { [US]: report({ rttMs: 100, free: 6, agents: 9 }), [EU]: report({ rttMs: 4, free: 2, agents: 2 }) };
    let t = 1_000_000;
    const dir = createChatCapacityDirectory({
      candidates: async () => [US, EU],
      allowed: () => true,
      now: () => t,
      probe: async (url) => {
        if (url === EU) await held;
        return reports[url];
      },
      latency: POLICY,
    });
    const first = dir.pick({ kind: "network", model: M });
    await new Promise((r) => setTimeout(r, 0));
    t += 2_500;
    const second = dir.pick({ kind: "network", model: M });
    await new Promise((r) => setTimeout(r, 0));
    release();
    const p = await second;
    await first;
    expect(p.url).toBe(US);
    expect(p.choice?.rule).toBe("load");
    expect(p.choice?.candidates.find((c) => c.coordinator === "coordinator-eu.example.com")).toMatchObject({ stale: true, expectedMs: null });
    expect(p.choice?.candidates.find((c) => c.coordinator === "coordinator.example.com")?.expectedMs).toBe(120);
  });

  it("applies to model auto across all models", async () => {
    const { dir } = directory({ [US]: report({ rttMs: 100, free: 6, agents: 9 }), [EU]: report({ rttMs: 4, free: 2, agents: 2 }) });
    const r = await dir.pickAutoChoice!({ clientRegion: "lhr" });
    expect(r).toMatchObject({ url: EU, choice: { rule: "latency" } });
    expect(await dir.pickAuto()).toBe(EU);
  });
});

describe("recording the choice", () => {
  it("reads the client's region from its own header, Fly's edge or Cloudflare", () => {
    expect(clientRegionOf({ "x-edgecoder-client-region": "LHR", "fly-region": "iad" })).toBe("lhr");
    expect(clientRegionOf({ "fly-region": "lhr" })).toBe("lhr");
    expect(clientRegionOf({ "cf-ipcountry": "GB" })).toBe("cc-gb");
    expect(clientRegionOf({ "x-edgecoder-client-region": "<script>", "cf-ipcountry": "XX" })).toBeNull();
  });

  it("keeps only known, bounded fields", () => {
    expect(sanitizeCoordinatorChoice({ chosen: "x", rule: "nope" })).toBeUndefined();
    const c = sanitizeCoordinatorChoice({ chosen: "eu", rule: "overflow", reason: "r".repeat(500), clientRegion: "lhr", candidates: [{ coordinator: "eu", rttMs: 9.6, extra: 1 }] });
    expect(c?.reason).toHaveLength(300);
    expect(c?.candidates[0]).toEqual({ coordinator: "eu", rttMs: 10, queueMs: null, agentRttMs: null, expectedMs: null, free: 0, waiting: 0, agents: 0 });
  });

  it("sends the choice with the call it was made for", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const transport = async (_m: "GET" | "POST", path: string, body?: unknown) => {
      if (path === "/inference/submit") {
        bodies.push(body as Record<string, unknown>);
        return { status: 409, json: { error: "no_agent_has_model" } };
      }
      return { status: 200, json: {} };
    };
    const choice = { chosen: "eu", rule: "latency" as const, reason: "faster", clientRegion: "lhr", portalRegion: "cdg", candidates: [] };
    await expect(streamNetworkCompletion({ forwarder: "", token: () => "", agentId: "acct-1", transport }, { model: M, computeClass: "any", messages: [{ role: "user", content: "hi" }], coordinatorChoice: choice }).next()).rejects.toThrow();
    expect(bodies[0].coordinatorChoice).toEqual(choice);
  });
});

/*
 * #526: locality. Each coordinator says where its hosts with a free slot are (freeRegions); the one
 * with a free host nearest the buyer wins when it is nearer than the load pick's by the margin. A busy
 * near coordinator (no free slot) never holds a call; without regions everywhere nothing changes.
 */
describe("locality", () => {
  it("sends a London buyer to the coordinator with a free host in London, though the US has more room and a shorter round trip", () => {
    const c = chooseByLatency(
      [cand({ url: US, free: 9, agents: 9, rttMs: 2, freeRegions: ["iad", "lax", "sin", "syd"] }), cand({ url: EU, free: 2, rttMs: 99, freeRegions: ["lhr", "fra"] })],
      US,
      POLICY,
      { clientRegion: "lhr", portalRegion: "ord" },
    );
    expect(c).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "locality", clientRegion: "lhr" });
    expect(c.reason).toMatch(/free host nearest the buyer \(lhr\): 0 km vs 5,\d{3} km on coordinator\.example\.com/);
    expect(c.candidates.map((x) => x.nearKm)).toEqual([expect.any(Number), 0]);
  });

  it("keeps a Sydney buyer on the coordinator that has a free host in Sydney", () => {
    const c = chooseByLatency(
      [cand({ url: US, free: 9, agents: 9, rttMs: 2, freeRegions: ["iad", "syd"] }), cand({ url: EU, free: 2, rttMs: 99, freeRegions: ["lhr", "fra"] })],
      EU,
      POLICY,
      { clientRegion: "syd" },
    );
    expect(c).toMatchObject({ chosen: "coordinator.example.com", rule: "locality" });
  });

  it("a busy near coordinator does not hold the call; nearby within the margin does not move it", () => {
    // The EU has no free slot: its region does not count, the load pick stands (or overflows by latency).
    const busy = chooseByLatency([cand({ url: US, free: 9, rttMs: 2, freeRegions: ["iad"] }), cand({ url: EU, free: 0, rttMs: 99, freeRegions: ["lhr"] })], US, POLICY, { clientRegion: "lhr" });
    expect(busy.rule).not.toBe("locality");
    expect(busy.chosen).toBe("coordinator.example.com");
    // lhr vs ams (~370 km): under the 700 km margin.
    const close = chooseByLatency([cand({ url: US, free: 9, rttMs: 2, freeRegions: ["ams"] }), cand({ url: EU, free: 2, rttMs: 2, freeRegions: ["lhr"] })], US, POLICY, { clientRegion: "lhr" });
    expect(close.rule).not.toBe("locality");
  });

  it("is not compared without the buyer's region, without every free coordinator's regions, or with the margin at 0", () => {
    const both = [cand({ url: US, free: 9, rttMs: 2, freeRegions: ["iad"] }), cand({ url: EU, free: 2, rttMs: 99, freeRegions: ["lhr"] })];
    expect(chooseByLatency(both, US, POLICY, {}).rule).not.toBe("locality");
    expect(chooseByLatency([both[0], cand({ url: EU, free: 2, rttMs: 99 })], US, POLICY, { clientRegion: "lhr" }).rule).not.toBe("locality");
    expect(chooseByLatency(both, US, { ...POLICY, localityMarginKm: 0 }, { clientRegion: "lhr" }).rule).not.toBe("locality");
  });

  it("the directory reads freeRegions from the coordinators' reports", async () => {
    const withRegions = (r: CapacityReport, regions: string[]): CapacityReport => ({ ...r, modelLoad: Object.fromEntries(Object.entries(r.modelLoad!).map(([m, l]) => [m, { ...l, freeRegions: regions }])) });
    const { dir } = directory({ [US]: withRegions(report({ rttMs: 2, free: 6, agents: 9 }), ["iad", "lax"]), [EU]: withRegions(report({ rttMs: 99, free: 2, agents: 2 }), ["lhr", "fra"]) });
    const p = await dir.pick({ kind: "network", model: M }, [], { clientRegion: "cc-gb" });
    expect(p).toMatchObject({ url: EU, choice: { rule: "locality" } });
    const auto = await dir.pickAutoChoice!({ clientRegion: "lhr" });
    expect(auto).toMatchObject({ url: EU, choice: { rule: "locality" } });
  });

  it("a recorded locality choice keeps its rule and distances", () => {
    const c = sanitizeCoordinatorChoice({ chosen: "eu", rule: "locality", reason: "near", clientRegion: "lhr", candidates: [{ coordinator: "eu", nearKm: 12.4 }, { coordinator: "us", nearKm: "x" }] });
    expect(c?.rule).toBe("locality");
    expect(c?.candidates[0].nearKm).toBe(12);
    expect(c?.candidates[1].nearKm).toBeUndefined();
  });
});

/*
 * Run 4 (3c under load, 1 of 22 nearest): the US coordinator was the load pick and had the free host
 * nearest the buyer, so locality did nothing and the latency rule (time to start, with a pickup p90 of
 * 1,928 ms counted while 14 slots were free) sent the call to the EU. Now the nearest free coordinator
 * is kept unless another is clearly faster end to end (round trips + queueing + service time).
 */
describe("locality under load", () => {
  // inf-1795589138500-c70eb012 (portal ord, buyer gru): the candidates as recorded.
  const usRun4 = (o: Partial<LatencyCandidate> = {}) =>
    cand({ url: US, rttMs: 7, pickupP90Ms: 1_928, agentRttMs: 168, free: 14, waiting: 0, agents: 7, callP50Ms: 4_000, serviceMs: 4_000, freeRegions: ["gru", "iad", "lax"], ...o });
  const euRun4 = (o: Partial<LatencyCandidate> = {}) =>
    cand({ url: EU, rttMs: 100, pickupP90Ms: 600, agentRttMs: 15, free: 3, waiting: 0, agents: 2, callP50Ms: 4_000, serviceMs: 4_000, freeRegions: ["lhr", "fra"], ...o });

  it("keeps a São Paulo buyer on the US coordinator with 14 free slots 0 km away", () => {
    const c = chooseByLatency([usRun4(), euRun4()], US, POLICY, { clientRegion: "gru", portalRegion: "ord" });
    expect(c).toMatchObject({ chosen: "coordinator.example.com", rule: "locality", clientRegion: "gru" });
    // Time to start: US 7 + 0 + 168 = 175 ms, EU 100 + 0 + 15 = 115 ms (was 2,103 vs 715).
    expect(c.candidates.map((x) => [x.queueMs, x.expectedMs])).toEqual([[0, 175], [0, 115]]);
    // End to end with the same 4 s service: US 7 + 0 (gru host, 0 km) + 4,000; EU 100 + 135 (lhr host,
    // 9,459 km) + 4,000. The agent round trip is in the service time, so it is not added again.
    expect(c.reason).toMatch(/^free host nearest the buyer \(gru\): 0 km vs 9,\d{3} km; coordinator-eu\.example\.com not clearly faster end to end \(expected 4235 ms vs 4007 ms, hosts lhr 4000 ms vs gru 4000 ms\)$/);
  });

  it("keeps the nearest when no service time is reported (both get the default)", () => {
    const c = chooseByLatency([usRun4({ serviceMs: null }), euRun4({ serviceMs: null })], US, POLICY, { clientRegion: "gru" });
    expect(c).toMatchObject({ chosen: "coordinator.example.com", rule: "locality" });
    expect(c.reason).toMatch(/expected 15235 ms vs 15007 ms, hosts lhr vs gru\)/);
  });

  it("also holds when the EU was the load pick: the buyer goes to the free host 0 km away", () => {
    const c = chooseByLatency([usRun4(), euRun4({ free: 20 })], EU, POLICY, { clientRegion: "gru" });
    expect(c).toMatchObject({ chosen: "coordinator.example.com", rule: "locality" });
  });

  it("moves when the other coordinator is clearly faster end to end", () => {
    // The model takes 9 s on the US hosts and 3 s on the EU ones: 9,007 vs 3,235 ms.
    const c = chooseByLatency([usRun4({ serviceMs: 9_000 }), euRun4({ serviceMs: 3_000 })], US, POLICY, { clientRegion: "gru" });
    expect(c).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "latency" });
    expect(c.reason).toBe("clearly faster end to end than the free host nearest the buyer (gru, 0 km on coordinator.example.com): expected 3235 ms vs 9007 ms, hosts lhr 3000 ms vs gru 9000 ms");
    // 4,007 vs 3,735 ms: 272 ms is under 15 % of 4,007 (601 ms), the nearest stays.
    const close = chooseByLatency([usRun4({ serviceMs: 4_000 }), euRun4({ serviceMs: 3_500 })], US, POLICY, { clientRegion: "gru" });
    expect(close).toMatchObject({ chosen: "coordinator.example.com", rule: "locality" });
  });

  it("a locality move is also checked end to end", () => {
    // London buyer, US the load pick: the EU free host is in London, but the model is far slower there.
    const c = chooseByLatency(
      [cand({ url: US, free: 9, agents: 9, rttMs: 2, serviceMs: 2_000, freeRegions: ["iad"] }), cand({ url: EU, free: 2, rttMs: 99, serviceMs: 12_000, freeRegions: ["lhr"] })],
      US,
      POLICY,
      { clientRegion: "lhr" },
    );
    expect(c).toMatchObject({ chosen: "coordinator.example.com", rule: "latency" });
  });

  it("a nearest coordinator with no free slot does not hold: the call overflows", () => {
    // US full (queue 1,928 + 4,000 ms) and the EU free: locality counts only the EU's free hosts.
    const c = chooseByLatency([usRun4({ free: 0, waiting: 5 }), euRun4()], US, POLICY, { clientRegion: "gru" });
    expect(c.chosen).toBe("coordinator-eu.example.com");
  });

  it("the directory passes each model's service time through", async () => {
    const withLoad = (r: CapacityReport, regions: string[], serviceMs: number): CapacityReport => ({ ...r, modelLoad: Object.fromEntries(Object.entries(r.modelLoad!).map(([m, l]) => [m, { ...l, freeRegions: regions, serviceMs }])) });
    const { dir } = directory({
      [US]: { ...withLoad(report({ rttMs: 7, free: 14, agents: 7 }), ["gru", "iad"], 4_000), pickupP90Ms: 1_928 },
      [EU]: { ...withLoad(report({ rttMs: 100, free: 3, agents: 2 }), ["lhr", "fra"], 4_000), pickupP90Ms: 600 },
    });
    const p = await dir.pick({ kind: "network", model: M }, [], { clientRegion: "gru" });
    expect(p).toMatchObject({ url: US, choice: { rule: "locality" } });
    expect(p.choice?.reason).toMatch(/not clearly faster end to end \(expected 4235 ms vs 4007 ms, hosts lhr 4000 ms vs gru 4000 ms\)/);
  });
});

/*
 * Run 5 (3c: nearest free host 22 % idle, 48 % under load). The "clearly faster end to end" rule
 * scored the US coordinator (ord) with its median over every 1.5b call there (~1,700 ms) plus the
 * median round trip to all seven US hosts (163 ms), so iad, lax and sin buyers went to the EU while a
 * free host sat in their own region. Now each coordinator is scored by its best free host with that
 * host's own numbers (/inference/models freeHosts), and calls already sent take those hosts first.
 */
describe("run 5: the nearest free host, scored by its own numbers", () => {
  const US_REGIONS = ["iad", "lax", "gru", "syd", "nrt", "jnb", "sin"];
  // The same CPU machines everywhere: one reference-call time for all of them.
  const hosts = (regions: string[], serviceMs = 1_200) => regions.map((region) => ({ region, free: 2, rttMs: 40, serviceMs }));
  // inf-1795598700801-20aab089 (portal ord), as recorded: US median 1,699 ms, EU 1,320 ms.
  const us = (o: Partial<LatencyCandidate> = {}) =>
    cand({ url: US, rttMs: 5, agentRttMs: 162, free: 14, agents: 7, serviceMs: 1_699, callP50Ms: 1_699, freeRegions: US_REGIONS, freeHosts: hosts(US_REGIONS), ...o });
  const eu = (o: Partial<LatencyCandidate> = {}) =>
    cand({ url: EU, rttMs: 98, agentRttMs: 11, free: 4, agents: 2, serviceMs: 1_320, callP50Ms: 1_320, freeRegions: ["lhr", "fra"], freeHosts: hosts(["lhr", "fra"]), ...o });

  it.each([
    ["iad", "inf-1795598700801-20aab089"],
    ["lax", "inf-1795598703741-61d690c7"],
    ["sin", "inf-1795598706926-6b8874f7"],
    ["nrt", "inf-1795599027496-de8dd861"],
  ])("keeps a %s buyer on the free host in its region (%s went to the EU)", (region) => {
    const c = chooseByLatency([us(), eu()], US, POLICY, { clientRegion: region, portalRegion: "ord" });
    expect(c).toMatchObject({ chosen: "coordinator.example.com", rule: "locality" });
    expect(c.reason).toMatch(new RegExp(`hosts (lhr|fra) 1200 ms vs ${region} 1200 ms\\)$`));
  });

  it("keeps a London buyer on the London host (inf-1795600195510-5eb5428e went to US iad and timed out)", () => {
    // As recorded: US median 437 ms, EU 863 ms (heavier calls had run there); the hosts are alike.
    const c = chooseByLatency([us({ rttMs: 6, free: 10, serviceMs: 437 }), eu({ rttMs: 107, serviceMs: 863 })], US, POLICY, { clientRegion: "lhr", portalRegion: "ord" });
    expect(c).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "locality" });
  });

  it("older coordinators (no freeHosts): the nearest free region and the model's median, without the averaged agent round trip", () => {
    const old = (c: LatencyCandidate) => ({ ...c, freeHosts: undefined });
    for (const [region, euRtt] of [["iad", 98], ["lax", 201]] as const) {
      const c = chooseByLatency([old(us()), old(eu({ rttMs: euRtt }))], US, POLICY, { clientRegion: region });
      expect(c).toMatchObject({ chosen: "coordinator.example.com", rule: "locality" });
    }
  });

  it("still moves when the far coordinator's host is clearly faster", () => {
    // The sin host takes 3 s for the reference call (far from its coordinator, or slower): the EU's 1.2 s
    // plus 98 ms and the sin <-> fra trip is faster by more than 15 %.
    const c = chooseByLatency([us({ freeHosts: [...hosts(["iad", "lax"]), { region: "sin", free: 2, rttMs: 230, serviceMs: 3_000 }] }), eu()], US, POLICY, { clientRegion: "sin" });
    expect(c).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "latency" });
    expect(c.reason).toMatch(/hosts (lhr|fra) 1200 ms vs sin 3000 ms$/);
  });

  it("a host without a reference time compares by round trips only", () => {
    const c = chooseByLatency([us({ freeHosts: US_REGIONS.map((region) => ({ region, free: 2 })) }), eu()], US, POLICY, { clientRegion: "iad" });
    expect(c).toMatchObject({ chosen: "coordinator.example.com", rule: "locality" });
  });

  it("calls sent but not yet in the report take the best hosts first", () => {
    // Two iad calls already sent to the US: its iad host is taken, the next nearest is lax.
    const c = chooseByLatency([us({ free: 12, sentFor: ["iad", "iad"] }), eu()], US, POLICY, { clientRegion: "iad" });
    expect(c.chosen).toBe("coordinator.example.com");
    expect(c.candidates[0].nearKm).toBeGreaterThan(3_000);
    // Calls for syd and gru buyers took their own hosts: the iad host is still free for this one.
    expect(chooseByLatency([us({ free: 12, sentFor: ["syd", "gru"] }), eu()], US, POLICY, { clientRegion: "iad" }).candidates[0].nearKm).toBe(0);
  });

  /** A directory over run 5's two coordinators; reports never show the calls sent (as in a burst). */
  function run5Directory() {
    let t = 2_000_000;
    const model = (free: number, regions: string[], serviceMs: number) => ({ [M]: { agents: regions.length, idle: 0, free, waiting: 0, agentRttMs: 160, serviceMs, freeRegions: regions, freeHosts: hosts(regions) } });
    const reports: Record<string, CapacityReport> = {
      [US]: { reachable: true, rttMs: 5, agentModels: [M], modelLoad: model(14, US_REGIONS, 1_699), pickupP90Ms: 200, callP50Ms: 1_699 },
      [EU]: { reachable: true, rttMs: 98, agentModels: [M], modelLoad: model(4, ["lhr", "fra"], 1_320), pickupP90Ms: 200, callP50Ms: 1_320 },
    };
    const probe = vi.fn(async (url: string) => reports[url]);
    const dir = createChatCapacityDirectory({ candidates: async () => [US, EU], allowed: () => true, ttlMs: 15_000, now: () => t, probe, latency: POLICY, portalRegion: "ord" });
    return { dir, probe, advance: (ms: number) => void (t += ms) };
  }

  it("a burst from iad, syd, lax and gru buyers stays on the US hosts near them (inf-1795598815059-ceb6d2f3 and others went to the EU's 4 slots)", async () => {
    const { dir } = run5Directory();
    const buyers = ["iad", "syd", "lax", "gru", "iad", "lax"];
    const picks = await Promise.all(buyers.map((clientRegion) => dir.pick({ kind: "network", model: M }, [], { clientRegion })));
    expect(picks.map((p) => p.url)).toEqual(buyers.map(() => US));
    expect(picks.every((p) => p.choice?.rule === "locality")).toBe(true);
  });

  it("calls sent still count after the report is refreshed, until it can show them", async () => {
    // Frankfurt buyers: the EU's 4 slots fill, then the next call goes to the US, though a report
    // taken in between (before the coordinator shows the calls) still says 4 free.
    const { dir, probe, advance } = run5Directory();
    const pick = () => dir.pick({ kind: "network", model: M }, [], { clientRegion: "fra" });
    expect((await pick()).url).toBe(EU);
    advance(1_900);
    for (let i = 0; i < 3; i++) expect((await pick()).url).toBe(EU);
    const probes = probe.mock.calls.length;
    advance(200); // the report is now 2.1 s old: asked again, still 4 free
    const fifth = await pick();
    expect(probe.mock.calls.length).toBeGreaterThan(probes);
    // The 3 calls from 200 ms ago count (the one from 2.1 s ago is taken as shown): 1 EU slot left.
    expect(fifth.url).toBe(EU);
    expect(fifth.choice?.candidates.find((c) => c.coordinator === "coordinator-eu.example.com")?.free).toBe(1);
    const sixth = await pick();
    expect(sixth.url).toBe(US);
    expect(sixth.choice?.candidates.find((c) => c.coordinator === "coordinator-eu.example.com")?.free).toBe(0);
    // Once a report is taken SENT_REFLECT_MS after them, they no longer count.
    advance(2_100);
    expect((await pick()).choice?.candidates.find((c) => c.coordinator === "coordinator-eu.example.com")?.free).toBe(4);
  });
});

/*
 * Run 6 (3c: nearest free host 72 % idle, 22 % in phase 1, 37 % under CPU load). Free hosts were
 * compared by their time for a fixed reference call (1,000 tokens in, 200 out): 19-29 s on 1.5b CPU
 * hosts, so a 9 s gap between a host measured fast and one on its class's prior outweighed distance
 * for calls of about a second. Now a host's time is its speed times this call's work, and two hosts
 * of one class count as equally fast unless both are measured and differ by SAME_CLASS_SPEED_RATIO.
 */
describe("run 6: hosts compared by their time for this call", () => {
  const M15 = "qwen2.5-coder:1.5b";
  // The run 6 probe: "Reply with the number n." with max_tokens 8.
  const SMALL = { paramsB: 1.5, promptTokens: 20, outputTokens: 8 };
  const host = (region: string, speed: number, speedFrom: FreeHost["speedFrom"], computeClass = "cpu", serviceMs?: number): FreeHost => ({ region, free: 2, rttMs: 40, computeClass, speed, speedFrom, ...(serviceMs ? { serviceMs } : {}) });
  // Portal in lhr: the EU coordinator is next door, the US one (ord) across the Atlantic. The US has more room.
  const us = (freeHosts: FreeHost[], o: Partial<LatencyCandidate> = {}) => cand({ url: US, rttMs: 75, agentRttMs: 120, free: 10, agents: 5, serviceMs: 1_000, callP50Ms: 1_000, freeRegions: freeHosts.map((h) => h.region), freeHosts, ...o });
  const eu = (freeHosts: FreeHost[], o: Partial<LatencyCandidate> = {}) => cand({ url: EU, rttMs: 4, agentRttMs: 15, free: 4, agents: 2, serviceMs: 1_000, callP50Ms: 1_000, freeRegions: freeHosts.map((h) => h.region), freeHosts, ...o });

  it("keeps an lhr buyer on the free lhr host, though iad was measured faster than lhr's prior (inf-1795606309908-ba1349fe, inf-1795606309948-152594a8)", () => {
    // As recorded: "hosts iad 19348 ms vs lhr 28691 ms": iad at a measured 0.337, lhr at the CPU prior 0.5.
    const usHosts = [host("iad", 0.337, "class", "cpu", 19_348), host("lax", 0.337, "class", "cpu", 19_348)];
    const euHosts = [host("lhr", 0.5, "prior", "cpu", 28_691), host("fra", 0.5, "prior", "cpu", 28_691)];
    for (const call of [SMALL, undefined]) {
      const c = chooseByLatency([us(usHosts), eu(euHosts)], US, POLICY, { clientRegion: "lhr", portalRegion: "lhr", call });
      expect(c).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "locality" });
    }
    // Both measured on their own calls, but less than 1.5 times apart: still alike, distance decides.
    const c = chooseByLatency([us([host("iad", 0.34, "host")]), eu([host("lhr", 0.48, "host")])], US, POLICY, { clientRegion: "lhr", call: SMALL });
    expect(c).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "locality" });
  });

  it("keeps a fra buyer in the EU rather than on a jnb host (inf-1795606309948-dc24048a)", () => {
    const usHosts = [host("jnb", 0.3, "host"), host("iad", 0.3, "class")];
    for (const euHosts of [[host("fra", 0.5, "prior")], [host("fra", 0.42, "host"), host("lhr", 0.5, "class")]]) {
      const c = chooseByLatency([us(usHosts, { rttMs: 20 }), eu(euHosts)], US, POLICY, { clientRegion: "fra", call: SMALL });
      expect(c).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "locality" });
    }
  });

  it("a genuinely faster GPU elsewhere still wins a large call, and the time is for that call", () => {
    const big = { paramsB: 7, promptTokens: 3_000, outputTokens: 2_000 };
    const gpu = host("iad", 0.1, "prior", "gpu");
    const cpu = host("lhr", 0.5, "prior", "cpu");
    const c = chooseByLatency([us([gpu]), eu([cpu])], EU, POLICY, { clientRegion: "lhr", call: big });
    expect(c).toMatchObject({ chosen: "coordinator.example.com", rule: "latency" });
    expect(c.reason).toContain(`hosts iad ${hostCallMs(gpu, big)} ms (gpu, prior) vs lhr ${hostCallMs(cpu, big)} ms (cpu, prior)`);
    expect(hostCallMs(cpu, big)!).toBeGreaterThan(10 * hostCallMs(gpu, big)!);
  });

  it("a same-class host measured much faster on its own calls can still win", () => {
    const mid = { paramsB: 1.5, promptTokens: 2_000, outputTokens: 1_000 };
    // Run 7: both measurements fresh (seconds old).
    const fresh = (h: FreeHost): FreeHost => ({ ...h, speedAgeMs: 30_000 });
    const c = chooseByLatency([us([fresh(host("iad", 0.15, "host"))]), eu([fresh(host("lhr", 0.6, "host"))])], EU, POLICY, { clientRegion: "lhr", call: mid });
    expect(c).toMatchObject({ chosen: "coordinator.example.com", rule: "latency" });
  });

  it("which hosts count as equally fast", () => {
    const h = (computeClass: string | undefined, speed: number, speedFrom?: "host" | "class" | "prior") => ({ computeClass, speed, speedFrom, speedAgeMs: 0 });
    expect(equallyFast(h("cpu", 0.3, "class"), h("cpu", 0.5, "prior"))).toBe(true);
    expect(equallyFast(h("cpu", 0.3, "host"), h("cpu", 0.9, "prior"))).toBe(true);
    expect(equallyFast(h("cpu", 0.4, "host"), h("cpu", 0.5, "host"))).toBe(true);
    expect(equallyFast(h("cpu", 0.2, "host"), h("cpu", 0.5, "host"))).toBe(false);
    expect(equallyFast(h("cpu", 0.5, "prior"), h("gpu", 0.1, "prior"))).toBe(false);
    expect(equallyFast(h(undefined, 0.5), h(undefined, 0.5))).toBe(false);
  });

  it("the directory reads each host's class and speed and passes the call's size", async () => {
    const load = (free: number, freeHosts: unknown[]) => ({ [M15]: { agents: 2, idle: 0, free, waiting: 0, agentRttMs: 60, serviceMs: 1_000, freeRegions: (freeHosts as Array<{ region: string }>).map((x) => x.region), freeHosts } });
    const reports: Record<string, CapacityReport> = {
      [US]: { reachable: true, rttMs: 75, agentModels: [M15], modelLoad: load(10, [{ region: "iad", free: 2, rttMs: 40, serviceMs: 19_348, computeClass: "cpu", speed: 0.337, speedFrom: "class" }]), pickupP90Ms: 200, callP50Ms: 1_000 },
      [EU]: { reachable: true, rttMs: 4, agentModels: [M15], modelLoad: load(12, [{ region: "lhr", free: 2, rttMs: 10, serviceMs: 28_691, computeClass: "cpu", speed: 0.5, speedFrom: "prior" }]), pickupP90Ms: 200, callP50Ms: 1_000 },
    };
    const probe = vi.fn(async (url: string) => reports[url]);
    const dir = createChatCapacityDirectory({ candidates: async () => [US, EU], allowed: () => true, ttlMs: 15_000, now: () => 1_000_000, probe, latency: POLICY, portalRegion: "lhr" });
    const call = callSizeOf({ messages: [{ role: "user", content: "Reply with the number 7." }], max_tokens: 8 });
    const pick = await dir.pick({ kind: "network", model: M15 }, [], { clientRegion: "lhr", call });
    expect(pick.url).toBe(EU);
    expect(pick.choice?.rule).toBe("locality");
    // The hosts' times are for this call (a few seconds at most), not the 19-29 s reference call.
    const size = callSizeFor(M15, call);
    expect(size).toEqual({ paramsB: 1.5, promptTokens: call!.promptTokens, outputTokens: 8 });
    const iadMs = hostCallMs({ computeClass: "cpu", speed: 0.337 }, size)!;
    const lhrMs = hostCallMs({ computeClass: "cpu", speed: 0.5 }, size)!;
    expect(lhrMs).toBeLessThan(5_000);
    expect(pick.choice?.reason).toContain(`hosts iad ${iadMs} ms (cpu, class) vs lhr ${lhrMs} ms (cpu, prior)`);
  });

  it("a /v1 call's size: prompt tokens as the coordinator counts them, and max_tokens when set", () => {
    const messages = [{ role: "user", content: "x".repeat(400) }];
    const n = Math.ceil(Buffer.byteLength(JSON.stringify({ messages, tools: [] }), "utf8") / 4);
    expect(callSizeOf({ messages, max_tokens: 64 })).toEqual({ promptTokens: n, maxTokens: 64 });
    expect(callSizeOf({ messages })).toEqual({ promptTokens: n });
    expect(callSizeOf(null)).toMatchObject({ promptTokens: expect.any(Number) });
  });
});

/*
 * Run 7 (nearest free host 66.7 % idle, 36.1 % under CPU load). #562 compared two hosts of one class by
 * their own measured speeds once 1.5x apart, and those speeds had been measured while a fleet deploy
 * had left the hosts throttled (CPU credit): an lhr buyer went to iad on "iad 936 ms vs lhr 2160 ms"
 * and took 2.5 s (inf-1795614734673-bec45a48), a fra buyer the same way took 2.4 s
 * (inf-1795614734666-c27e07d8); served locally such calls took about 1.0-1.1 s. The slow-looking host
 * then got no calls, so its old measurement never changed. Now a measured speed compares two hosts of
 * one class only while both are fresh (speedAgeMs, with the report's age, within speedFreshMs).
 */
describe("run 7: only fresh measured speeds tell two hosts of one class apart", () => {
  const SMALL = { paramsB: 1.5, promptTokens: 20, outputTokens: 8 };
  const host = (region: string, speed: number, speedAgeMs?: number): FreeHost => ({ region, free: 2, rttMs: 40, computeClass: "cpu", speed, speedFrom: "host", ...(speedAgeMs !== undefined ? { speedAgeMs } : {}) });
  const us = (freeHosts: FreeHost[]) => cand({ url: US, rttMs: 75, agentRttMs: 120, free: 10, agents: 5, serviceMs: 1_000, callP50Ms: 1_000, freeRegions: freeHosts.map((h) => h.region), freeHosts });
  const eu = (freeHosts: FreeHost[]) => cand({ url: EU, rttMs: 4, agentRttMs: 15, free: 4, agents: 2, serviceMs: 1_000, callP50Ms: 1_000, freeRegions: freeHosts.map((h) => h.region), freeHosts });
  // As recorded: lhr's own speed measured while throttled, 2.3x iad's.
  const IAD = 0.2;
  const LHR_THROTTLED = 0.46;

  it("keeps the lhr buyer on lhr once lhr's throttled measurement is no longer fresh (inf-1795614734673-bec45a48)", () => {
    // Fresh on both sides (as #562 judged it): iad wins, as before.
    const before = chooseByLatency([us([host("iad", IAD, 20_000)]), eu([host("lhr", LHR_THROTTLED, 60_000)])], US, POLICY, { clientRegion: "lhr", call: SMALL });
    expect(before).toMatchObject({ chosen: "coordinator.example.com", rule: "latency" });
    // lhr's measurement is 6 minutes old (it got no calls since): distance decides.
    const after = chooseByLatency([us([host("iad", IAD, 20_000)]), eu([host("lhr", LHR_THROTTLED, 360_000)])], US, POLICY, { clientRegion: "lhr", call: SMALL });
    expect(after).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "locality" });
    // The load report's own age counts: 4 min 50 s old at the coordinator, in a report 20 s old.
    const reportOld = cand({ ...eu([host("lhr", LHR_THROTTLED, 290_000)]), reportAgeMs: 20_000 });
    expect(chooseByLatency([us([host("iad", IAD, 20_000)]), reportOld], US, { ...POLICY, maxReportAgeMs: 60_000 }, { clientRegion: "lhr", call: SMALL }).chosen).toBe("coordinator-eu.example.com");
  });

  it("keeps the fra buyer in the EU when the coordinator does not say how old the speeds are (inf-1795614734666-c27e07d8)", () => {
    // An older coordinator: no speedAgeMs, so neither measurement counts as fresh.
    const c = chooseByLatency([us([host("iad", IAD)]), eu([host("fra", LHR_THROTTLED)])], US, POLICY, { clientRegion: "fra", call: SMALL });
    expect(c).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "locality" });
  });

  it("a genuinely slower host with fresh measurements still loses", () => {
    const mid = { paramsB: 1.5, promptTokens: 2_000, outputTokens: 1_000 };
    const c = chooseByLatency([us([host("iad", 0.15, 30_000)]), eu([host("lhr", 0.6, 45_000)])], EU, POLICY, { clientRegion: "lhr", call: mid });
    expect(c).toMatchObject({ chosen: "coordinator.example.com", rule: "latency" });
  });

  it("speedFreshMs 0: same-class hosts always count as equally fast", () => {
    const mid = { paramsB: 1.5, promptTokens: 2_000, outputTokens: 1_000 };
    const c = chooseByLatency([us([host("iad", 0.15, 1_000)]), eu([host("lhr", 0.6, 1_000)])], EU, { ...POLICY, speedFreshMs: 0 }, { clientRegion: "lhr", call: mid });
    expect(c).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "locality" });
  });

  it("equallyFast checks the age", () => {
    const h = (speed: number, speedAgeMs?: number) => ({ computeClass: "cpu", speed, speedFrom: "host" as const, speedAgeMs });
    expect(equallyFast(h(0.2, 10_000), h(0.5, 10_000))).toBe(false);
    expect(equallyFast(h(0.2, 10_000), h(0.5, 400_000))).toBe(true);
    expect(equallyFast(h(0.2), h(0.5, 10_000))).toBe(true);
    expect(equallyFast(h(0.2, 400_000), h(0.5, 400_000), 600_000)).toBe(false);
  });

  it("the directory reads speedAgeMs", async () => {
    const M15 = "qwen2.5-coder:1.5b";
    const load = (freeHosts: unknown[]) => ({ [M15]: { agents: 2, idle: 0, free: 4, waiting: 0, agentRttMs: 60, serviceMs: 1_000, freeRegions: (freeHosts as Array<{ region: string }>).map((x) => x.region), freeHosts } });
    const pickWith = async (lhrAgeMs: number) => {
      const reports: Record<string, CapacityReport> = {
        [US]: { reachable: true, rttMs: 75, agentModels: [M15], modelLoad: load([{ region: "iad", free: 2, rttMs: 40, computeClass: "cpu", speed: IAD, speedFrom: "host", speedAgeMs: 20_000 }]), pickupP90Ms: 200, callP50Ms: 1_000 },
        [EU]: { reachable: true, rttMs: 4, agentModels: [M15], modelLoad: load([{ region: "lhr", free: 2, rttMs: 10, computeClass: "cpu", speed: LHR_THROTTLED, speedFrom: "host", speedAgeMs: lhrAgeMs }]), pickupP90Ms: 200, callP50Ms: 1_000 },
      };
      const dir = createChatCapacityDirectory({ candidates: async () => [US, EU], allowed: () => true, ttlMs: 15_000, now: () => 1_000_000, probe: vi.fn(async (url: string) => reports[url]), latency: POLICY, portalRegion: "lhr" });
      return dir.pick({ kind: "network", model: M15 }, [], { clientRegion: "lhr", call: { promptTokens: 20, maxTokens: 8 } });
    };
    expect((await pickWith(60_000)).url).toBe(US);
    expect((await pickWith(360_000)).url).toBe(EU);
  });

  it("PORTAL_COORD_SPEED_FRESH_MS sets the limit", () => {
    expect(latencyPolicyFromEnv({}, 2_000).speedFreshMs).toBe(300_000);
    expect(latencyPolicyFromEnv({ PORTAL_COORD_SPEED_FRESH_MS: "60000" }, 2_000).speedFreshMs).toBe(60_000);
    expect(latencyPolicyFromEnv({ PORTAL_COORD_SPEED_FRESH_MS: "0" }, 2_000).speedFreshMs).toBe(0);
  });
});

/*
 * Run 8 (2026-11-25), CPU ramp: the nearest free host 33.9 % of the time (39/115). Most of the rest
 * had no free slot near the buyer (moving them is the rule). With every coordinator busy, lhr buyers
 * were queued on the US by agent count although the EU was expected to start them sooner, only not by
 * the margin (inf-1795625910042-dedcdc64: EU 3,057 ms vs US 3,490 ms, served on iad;
 * inf-1795625914571-83829970: EU 3,057 vs US 3,533, served on jnb). Now the call queues where its
 * hosts are nearest the buyer, unless another coordinator would start it sooner by the margin.
 */
describe("run 8: every coordinator busy, the call queues nearest the buyer", () => {
  const US_REGIONS = ["iad", "lax", "gru", "jnb", "nrt", "sin", "syd"];
  const EU_REGIONS = ["lhr", "fra"];
  // As recorded for inf-1795625910042-dedcdc64: US rtt 7, queue 3,321, agent rtt 162 (expected 3,490); EU rtt 96, queue 2,950, agent rtt 11 (3,057).
  const usBusy = (o: Partial<LatencyCandidate> = {}) => cand({ url: US, rttMs: 7, free: -3, waiting: 2, agents: 7, pickupP90Ms: 321, callP50Ms: 3_000, agentRttMs: 162, hostRegions: US_REGIONS, ...o });
  const euBusy = (o: Partial<LatencyCandidate> = {}) => cand({ url: EU, rttMs: 96, free: -1, waiting: 1, agents: 2, pickupP90Ms: 950, callP50Ms: 2_000, agentRttMs: 11, hostRegions: EU_REGIONS, ...o });

  it("queues an lhr buyer on the EU when the US is not faster by the margin (inf-1795625910042-dedcdc64)", () => {
    const c = chooseByLatency([usBusy(), euBusy()], US, POLICY, { clientRegion: "lhr", portalRegion: "ord" });
    expect(c.candidates.map((x) => x.expectedMs)).toEqual([3_490, 3_057]);
    expect(c).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "locality" });
    expect(c.reason).toMatch(/^every coordinator busy: queued nearest the buyer \(lhr\): hosts 0 km vs 5,\d{3} km; coordinator\.example\.com not faster by the margin \(expected 3490 ms vs 3057 ms\)$/);
    // Without the regions (an older record), the backlog share by agents stands, as before.
    const before = chooseByLatency([usBusy({ hostRegions: undefined }), euBusy({ hostRegions: undefined })], US, POLICY, { clientRegion: "lhr" });
    expect(before).toMatchObject({ chosen: "coordinator.example.com", rule: "load" });
  });

  it("overflows to the other coordinator when the nearest queues longer by the margin (inf-1795625912119-f7136858)", () => {
    // EU 2 behind (4,139 ms queue) against US 3,533 ms: 714 ms is over 15 % of 4,247.
    const c = chooseByLatency([usBusy({ free: 0, waiting: 0, pickupP90Ms: 364 }), euBusy({ free: -2, waiting: 2, pickupP90Ms: 139 })], US, POLICY, { clientRegion: "lhr" });
    expect(c.candidates.map((x) => x.expectedMs)).toEqual([3_533, 4_246]);
    expect(c).toMatchObject({ chosen: "coordinator.example.com", rule: "overflow" });
    expect(c.reason).toMatch(/^overflow: every coordinator busy; coordinator-eu\.example\.com has the hosts nearest the buyer \(lhr, 0 km\) but queues longer/);
  });

  it("a buyer whose nearest hosts are on the load pick stays there; regions within the margin do not move it", () => {
    const sin = chooseByLatency([usBusy(), euBusy()], US, POLICY, { clientRegion: "sin" });
    expect(sin).toMatchObject({ chosen: "coordinator.example.com", rule: "load" });
    // Both coordinators have hosts in the same region: no queue is nearer.
    const same = chooseByLatency([usBusy({ hostRegions: ["lhr"] }), euBusy({ hostRegions: ["lhr"] })], US, POLICY, { clientRegion: "lhr" });
    expect(same.rule).toBe("load");
    // Locality off.
    expect(chooseByLatency([usBusy(), euBusy()], US, { ...POLICY, localityMarginKm: 0 }, { clientRegion: "lhr" }).rule).toBe("load");
  });

  it("a nearest coordinator with a free slot still wins under load; one with none does not hold the call", () => {
    // EU has a slot on fra (lhr busy): the lhr buyer goes there, 661 km, not to a US host.
    const euOpen = cand({ url: EU, rttMs: 96, free: 1, agents: 2, agentRttMs: 11, freeRegions: ["fra"], hostRegions: EU_REGIONS });
    const usOpen = cand({ url: US, rttMs: 7, free: 14, agents: 7, agentRttMs: 162, freeRegions: ["iad", "lax"], hostRegions: US_REGIONS });
    expect(chooseByLatency([usOpen, euOpen], US, POLICY, { clientRegion: "lhr" })).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "locality" });
    // The EU's last slot is taken by a call already sent: the US host is the nearest free one.
    expect(chooseByLatency([usOpen, { ...euOpen, free: 0 }], US, POLICY, { clientRegion: "lhr" }).chosen).toBe("coordinator.example.com");
  });

  it("the directory remembers where a coordinator's hosts are once their slots are all busy", async () => {
    let t = 1_000_000;
    const withRegions = (r: CapacityReport, regions: string[] | undefined): CapacityReport => ({ ...r, modelLoad: Object.fromEntries(Object.entries(r.modelLoad!).map(([m, l]) => [m, { ...l, ...(regions ? { freeRegions: regions } : {}) }])) });
    const reports: Record<string, CapacityReport> = {
      [US]: withRegions(report({ rttMs: 7, free: 6, agents: 7 }), ["iad", "lax"]),
      [EU]: withRegions(report({ rttMs: 96, free: 2, agents: 2 }), ["lhr", "fra"]),
    };
    const dir = createChatCapacityDirectory({ candidates: async () => [US, EU], allowed: () => true, ttlMs: 15_000, now: () => t, probe: vi.fn(async (url: string) => reports[url]), latency: POLICY, portalRegion: "ord" });
    expect((await dir.pick({ kind: "network", model: M }, [], { clientRegion: "lhr" })).url).toBe(EU);
    // A minute later every slot is busy and the reports name no free region; both queue about as long.
    t += 60_000;
    reports[US] = withRegions(report({ rttMs: 7, free: 0, waiting: 3, agents: 7 }), undefined);
    reports[EU] = withRegions(report({ rttMs: 96, free: 0, waiting: 1, agents: 2 }), undefined);
    const busy = await dir.pick({ kind: "network", model: M }, [], { clientRegion: "lhr" });
    expect(busy.choice).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "locality" });
    // Long after (HOST_REGIONS_KEEP_MS), the regions are forgotten and the backlog share decides.
    t += 20 * 60_000;
    const later = await dir.pick({ kind: "network", model: M }, [], { clientRegion: "lhr" });
    expect(later.choice?.rule).not.toBe("locality");
  });
});

/*
 * Run 9 (CPU ramp): the load rule ("most free slots for the model") won 18 calls while a host near the
 * buyer was free. A coordinator's free count subtracts calls waiting there, so it read -3 while its syd
 * host sat free, and a syd buyer went to the EU's lhr host (inf-1795635739909-427d6667). Free capacity
 * is now judged by the free hosts each coordinator reports.
 */
describe("run 9: free capacity judged by the reported free hosts", () => {
  const host = (region: string, free = 1): FreeHost => ({ region, free, computeClass: "cpu", speed: 1, speedFrom: "prior" });
  const usWaiting = (o: Partial<LatencyCandidate> = {}) => cand({ url: US, rttMs: 6, free: -3, waiting: 3, agents: 7, agentRttMs: 163, pickupP90Ms: 300, callP50Ms: 3_000, freeHosts: [host("syd")], ...o });
  const euFree = (o: Partial<LatencyCandidate> = {}) => cand({ url: EU, rttMs: 96, free: 1, waiting: 0, agents: 2, agentRttMs: 12, freeHosts: [host("lhr")], ...o });

  it("a syd buyer goes to the free syd host though its coordinator's count is negative (inf-1795635739909-427d6667)", () => {
    const c = chooseByLatency([usWaiting(), euFree()], EU, POLICY, { clientRegion: "syd", portalRegion: "ord" });
    expect(c).toMatchObject({ chosen: "coordinator.example.com", rule: "locality" });
    expect(c.reason).toMatch(/^free host nearest the buyer \(syd\): 0 km vs 1\d,\d{3} km on coordinator-eu\.example\.com$/);
    // It starts at once there: no queue is counted against a free host.
    expect(c.candidates[0]).toMatchObject({ queueMs: 0, nearKm: 0 });
  });

  it("the load rule still applies when the near coordinator has no free host", () => {
    const c = chooseByLatency([usWaiting({ freeHosts: undefined }), euFree()], EU, POLICY, { clientRegion: "syd" });
    expect(c).toMatchObject({ chosen: "coordinator-eu.example.com", rule: "load" });
  });

  it("free hosts already taken by calls sent since the report are no free capacity, whatever the count says", () => {
    // The US count says 1 free and its free regions still name syd, but the call sent for a syd buyer has that host.
    const us = cand({ url: US, rttMs: 6, free: 1, agents: 7, freeRegions: ["syd"], freeHosts: [host("syd")], sentFor: ["syd"] });
    const c = chooseByLatency([us, euFree()], US, POLICY, { clientRegion: "syd" });
    expect(c.chosen).toBe("coordinator-eu.example.com");
    expect(c.candidates[0].nearKm).toBeUndefined();
  });

  it("the only coordinator with a free slot is recorded as locality when its free host is near the buyer, as load when it is not", () => {
    // inf-1795635705470-523f504f: iad buyer, the US the only one free, its iad host free.
    const near = chooseByLatency([usWaiting({ free: 1, waiting: 0, freeHosts: [host("iad"), host("nrt")] }), euFree({ free: -3, waiting: 3, freeHosts: undefined })], US, POLICY, { clientRegion: "iad" });
    expect(near).toMatchObject({ chosen: "coordinator.example.com", rule: "locality" });
    expect(near.reason).toBe("free host nearest the buyer (iad): 0 km; no other coordinator has a free slot");
    // inf-1795635566692-0e23c3c8: syd buyer, the US's nearest free host nrt (7,8xx km): no near free host, so the load rule.
    const far = chooseByLatency([usWaiting({ free: 2, waiting: 1, freeHosts: [host("nrt")] }), euFree({ free: 0, freeHosts: undefined })], US, POLICY, { clientRegion: "syd" });
    expect(far).toMatchObject({ chosen: "coordinator.example.com", rule: "load" });
  });
});
