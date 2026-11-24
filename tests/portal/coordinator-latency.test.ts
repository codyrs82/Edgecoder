import { describe, expect, it, vi } from "vitest";
import { createChatCapacityDirectory, LOAD_REPORT_MAX_AGE_MS, type CapacityReport } from "../../src/portal/chat-capacity.js";
import { chooseByLatency, expectedLatency, latencyPolicyFromEnv, type LatencyCandidate, type LatencyPolicy } from "../../src/portal/coordinator-latency.js";
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
  it("is the round trip, the pickup p90 and the agent round trip when a slot is free", () => {
    expect(expectedLatency(cand({ url: US, rttMs: 99 }), 2_000)).toEqual({ queueMs: 200, expectedMs: 319, stale: false });
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
    expect(far.reason).toMatch(/faster with a free slot: expected 225 ms vs 320 ms/);
    expect(far.candidates.map((c) => c.expectedMs)).toEqual([320, 225]);
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
    expect(latencyPolicyFromEnv({}, 2_000)).toEqual({ enabled: true, marginMs: 30, marginPct: 15, localityMarginKm: 700, maxReportAgeMs: 2_000 });
    expect(latencyPolicyFromEnv({ PORTAL_COORD_LATENCY_ROUTING: "off", PORTAL_COORD_LATENCY_MARGIN_MS: "50", PORTAL_COORD_LATENCY_MARGIN_PCT: "250", PORTAL_COORD_LOCALITY_MARGIN_KM: "0" }, 2_000)).toEqual({ enabled: false, marginMs: 50, marginPct: 100, localityMarginKm: 0, maxReportAgeMs: 2_000 });
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
    expect(p.choice?.candidates.find((c) => c.coordinator === "coordinator.example.com")?.expectedMs).toBe(320);
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
