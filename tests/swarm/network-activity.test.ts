import { describe, expect, it } from "vitest";
import { RecentEvents } from "../../src/swarm/recent-events.js";
import { agentCalls, meshGossip, meshWork, recordMeshMessage } from "../../src/swarm/coordinator/world-activity.js";
import {
  WORLD_MAX_CALLS_PER_MIN,
  WORLD_MAX_LINK_PER_MIN,
  WORLD_MAX_YOUR_REQUESTS,
  localWorldAgent,
  maskedId,
  parseLocalWorld,
  toPublicWorld,
  worldMaskKey,
  worldOwnerTag,
  type AgentFacts,
  type LocalWorld
} from "../../src/swarm/network-world.js";

/*
 * The world view's activity (the Network graph's pulses): per-machine counts, mesh-link work and
 * gossip, and the caller's own requests. Privacy: another account's request never reaches an answer.
 */
const KEY = worldMaskKey("coordinator-secret");
const NOW = 1_800_000_000_000;

function facts(agentId: string, over: Partial<AgentFacts> = {}): AgentFacts {
  return {
    agentId, ownerAccountId: null, os: "linux", region: null, countryCode: "US", computeClass: "gpu", tier: null,
    models: ["qwen3.5:9b"], activeModel: "qwen3.5:9b", connected: true, claims: 0, slots: 4, lastSeenMs: NOW - 1_000, rttMs: 10, ...over
  };
}

function world(id: string, agents: AgentFacts[], extra: Partial<LocalWorld> = {}): LocalWorld {
  const list = agents.map((a) => localWorldAgent(KEY, id, a));
  return { coordinator: { id, url: `https://${id}.example`, region: "ord", country: "US", continent: "NA", agents: list.length, agentsOnline: list.length }, links: [], agents: list, generatedAtMs: NOW, ...extra };
}

describe("RecentEvents", () => {
  it("counts events in the last minute per key", () => {
    const e = new RecentEvents(60_000, 10, 100);
    e.record("a", NOW - 61_000);
    e.record("a", NOW - 30_000);
    e.record("a", NOW);
    e.record("b", NOW);
    expect(e.count("a", NOW)).toBe(2);
    expect(e.count("b", NOW)).toBe(1);
    expect(e.count("a", NOW + 31_000)).toBe(1);
    e.prune(NOW + 120_000);
    expect(e.size).toBe(0);
  });

  it("is bounded in keys and in events per key", () => {
    const e = new RecentEvents(60_000, 3, 5);
    for (let i = 0; i < 10; i++) e.record(`k${i}`, NOW);
    expect(e.size).toBe(3);
    expect(e.count("k9", NOW)).toBe(1);
    expect(e.count("k0", NOW)).toBe(0);
    for (let i = 0; i < 50; i++) e.record("busy", NOW);
    expect(e.count("busy", NOW)).toBe(5);
  });

  it("mesh messages count as work (offers, claims, results) or gossip (everything else)", () => {
    const peer = `peer-${Math.random()}`;
    for (const t of ["task_offer", "task_claim", "result_announce", "capability_summary", "peer_exchange"]) recordMeshMessage(peer, t, NOW);
    expect(meshWork.count(peer, NOW)).toBe(3);
    expect(meshGossip.count(peer, NOW)).toBe(2);
    expect(agentCalls.count(peer, NOW)).toBe(0);
  });
});

describe("machine activity", () => {
  it("counts calls now, streaming and per minute; a stale machine is doing nothing", () => {
    const busy = localWorldAgent(KEY, "c", facts("a", { claims: 3, streaming: 2, callsPerMin: 14 }));
    expect(busy.activity).toEqual({ callsNow: 3, streaming: 2, callsPerMin: 14 });
    const stale = localWorldAgent(KEY, "c", facts("b", { connected: false, claims: 2, streaming: 2, callsPerMin: 4 }));
    expect(stale.activity).toEqual({ callsNow: 0, streaming: 0, callsPerMin: 4 });
    // Streaming never exceeds the calls held; nonsense is zero.
    expect(localWorldAgent(KEY, "c", facts("c", { claims: 1, streaming: 5, callsPerMin: Number.NaN })).activity).toEqual({ callsNow: 1, streaming: 1, callsPerMin: 0 });
  });

  it("a peer's counts are bounded and checked", () => {
    const w = parseLocalWorld({
      coordinator: { id: "peer" },
      links: [{ from: "peer", to: "me", rttMs: 5, workPerMin: 1e12, gossipPerMin: -4 }],
      agents: [
        { agentId: "x", id: "abcdef0123", status: "busy", activity: { callsNow: 9_999, streaming: 50, callsPerMin: 1e9 } },
        { agentId: "y", id: "abcdef0124", status: "stale", activity: { callsNow: 3, streaming: 3, callsPerMin: 2 } },
        { agentId: "z", id: "abcdef0125", status: "idle", activity: "lots" }
      ]
    })!;
    expect(w.links[0]).toMatchObject({ workPerMin: WORLD_MAX_LINK_PER_MIN, gossipPerMin: 0 });
    expect(w.agents[0].activity).toEqual({ callsNow: 64, streaming: 50, callsPerMin: WORLD_MAX_CALLS_PER_MIN });
    expect(w.agents[1].activity).toEqual({ callsNow: 0, streaming: 0, callsPerMin: 2 });
    expect(w.agents[2].activity).toEqual({ callsNow: 0, streaming: 0, callsPerMin: 0 });
  });
});

describe("your requests", () => {
  const alice = "acct-alice";
  const bob = "acct-bob";
  const servingId = maskedId(KEY, "node-serving");
  const self = world("coord-ord", [facts("node-serving", { claims: 2, streaming: 1 }), facts("node-alice", { ownerAccountId: alice })], {
    requests: [
      { tag: worldOwnerTag(alice), machine: servingId, state: "streaming" },
      { tag: worldOwnerTag(bob), machine: servingId, state: "starting" },
      { tag: worldOwnerTag(bob), machine: null, state: "queued" }
    ]
  });

  it("the caller gets their own requests and where they run; never anyone else's", () => {
    const v = toPublicWorld(self, [], alice, NOW);
    expect(v.yourRequests).toEqual([{ coordinator: "coord-ord", machineKey: servingId, state: "streaming" }]);
    const text = JSON.stringify(v);
    expect(text).not.toContain(worldOwnerTag(bob));
    expect(text).not.toContain(worldOwnerTag(alice));
    expect(text).not.toMatch(/"tag"|"requests"|acct-bob/);
    // The machine serving both shows only how busy it is.
    expect(v.agents.find((a) => a.id === servingId)!.activity).toEqual({ callsNow: 2, streaming: 1, callsPerMin: 0 });
  });

  it("bob sees his two; an anonymous caller sees none", () => {
    expect(toPublicWorld(self, [], bob, NOW).yourRequests).toEqual([
      { coordinator: "coord-ord", machineKey: servingId, state: "starting" },
      { coordinator: "coord-ord", machineKey: null, state: "queued" }
    ]);
    expect(toPublicWorld(self, [], null, NOW).yourRequests).toEqual([]);
  });

  it("requests on a peer coordinator are found too, and the list is capped", () => {
    const many = Array.from({ length: 40 }, () => ({ tag: worldOwnerTag(alice), machine: "abcdef0001", state: "starting" as const }));
    const peer = parseLocalWorld({ coordinator: { id: "coord-cdg" }, links: [], agents: [], requests: [...many, { tag: "not-a-tag", machine: null, state: "queued" }, { tag: worldOwnerTag(alice), machine: "bad id!", state: "starting" }] })!;
    const v = toPublicWorld(self, [{ url: "https://cdg.example", id: "coord-cdg", world: peer, rttMs: 90 }], alice, NOW);
    expect(v.yourRequests).toHaveLength(WORLD_MAX_YOUR_REQUESTS);
    expect(v.yourRequests[0]).toEqual({ coordinator: "coord-ord", machineKey: servingId, state: "streaming" });
    expect(v.yourRequests.slice(1).every((r) => r.coordinator === "coord-cdg")).toBe(true);
    // A malformed machine id is dropped, a malformed tag never matches.
    expect(peer.requests!.some((r) => r.machine === "bad id!")).toBe(false);
    expect(peer.requests!.some((r) => r.tag === "not-a-tag")).toBe(false);
  });
});

describe("mesh link activity", () => {
  it("a link's work and gossip are the sum of what each end reports", () => {
    const self = world("coord-ord", [], { links: [{ from: "coord-ord", to: "coord-cdg", rttMs: 99, workPerMin: 4, gossipPerMin: 6 }] });
    const peer = world("coord-cdg", [], { links: [{ from: "coord-cdg", to: "coord-ord", rttMs: 98, workPerMin: 3, gossipPerMin: 5 }] });
    const v = toPublicWorld(self, [{ url: "https://cdg.example", id: "coord-cdg", world: peer, rttMs: 99 }], null, NOW);
    expect(v.links).toEqual([{ from: "coord-ord", to: "coord-cdg", rttMs: 99, workPerMin: 7, gossipPerMin: 11 }]);
  });

  it("a coordinator cannot report activity on a link it is not on", () => {
    const self = world("coord-ord", [], { links: [{ from: "coord-ord", to: "coord-cdg", rttMs: 99, workPerMin: 1, gossipPerMin: 0 }] });
    const peer = world("coord-cdg", [], { links: [{ from: "coord-ord", to: "coord-cdg", rttMs: 99, workPerMin: 5_000, gossipPerMin: 5_000 }] });
    const v = toPublicWorld(self, [{ url: "https://cdg.example", id: "coord-cdg", world: peer, rttMs: 99 }], null, NOW);
    expect(v.links[0]).toMatchObject({ workPerMin: 1, gossipPerMin: 0 });
  });
});
