import { describe, expect, it } from "vitest";
import {
  MASKED_LABEL_RE,
  WORLD_MAX_AGENTS,
  WORLD_MAX_MODELS_PER_AGENT,
  localWorldAgent,
  maskedId,
  nearestRegion,
  osFamily,
  regionFromGeo,
  parseLocalWorld,
  regionInfo,
  toPublicWorld,
  worldMaskKey,
  worldOwnerTag,
  type AgentFacts,
  type LocalWorld
} from "../../src/swarm/network-world.js";

const KEY = worldMaskKey("coordinator-secret");
const NOW = 1_800_000_000_000;

function facts(agentId: string, over: Partial<AgentFacts> = {}): AgentFacts {
  return {
    agentId, ownerAccountId: null, os: "macos", clientType: "desktop", region: null, countryCode: "US", computeClass: "apple", tier: "apple.m.hi",
    models: ["qwen3.5:9b"], activeModel: "qwen3.5:9b", connected: true, claims: 0, slots: 2, lastSeenMs: NOW - 1_000, rttMs: 42.4, ...over
  };
}

function world(id: string, url: string, agents: AgentFacts[], links: LocalWorld["links"] = []): LocalWorld {
  const list = agents.map((a) => localWorldAgent(KEY, id, a));
  return { coordinator: { id, url, region: "iad", country: "US", continent: "NA", agents: list.length, agentsOnline: list.length }, links, agents: list, generatedAtMs: NOW };
}

describe("masking", () => {
  it("labels a machine with its OS family and a short keyed hash, never its id", () => {
    const a = localWorldAgent(KEY, "coord-us", facts("codys-mac-studio.local"));
    expect(a.label).toMatch(MASKED_LABEL_RE);
    expect(a.label.startsWith("mac-•••")).toBe(true);
    expect(a.label.endsWith(a.id.slice(-4))).toBe(true);
    expect(a.id).toMatch(/^[0-9a-f]{10}$/);
    // Stable for the same machine, different for another, and keyed (another key gives another id).
    expect(localWorldAgent(KEY, "coord-us", facts("codys-mac-studio.local")).id).toBe(a.id);
    expect(maskedId(KEY, "other")).not.toBe(a.id);
    expect(maskedId(worldMaskKey("another-secret"), "codys-mac-studio.local")).not.toBe(a.id);
  });

  it("takes the OS family from a fixed set, so a free-form os string cannot leak a name", () => {
    expect(osFamily("Darwin 24.1")).toBe("macos");
    expect(osFamily("linux")).toBe("linux");
    expect(osFamily("win32")).toBe("windows");
    expect(osFamily("ios", "edgecoder-ios")).toBe("ios");
    expect(osFamily("bobs-workstation")).toBe("other");
    expect(localWorldAgent(KEY, "c", facts("x", { os: "bobs-workstation" })).label.startsWith("dev-")).toBe(true);
  });

  it("the public view carries no agent id, account, e-mail, IP or host name of anyone else", () => {
    const self = world("coord-us", "https://coordinator.example", [
      facts("node-alice-macbook", { ownerAccountId: "acct-alice" }),
      facts("node-bob-gpu-box", { ownerAccountId: "acct-bob", os: "linux", computeClass: "gpu" })
    ]);
    const view = toPublicWorld(self, [], "acct-alice", NOW);
    const json = JSON.stringify(view);
    for (const secret of ["node-bob-gpu-box", "acct-bob", "acct-alice", "bob", worldOwnerTag("acct-bob"), "lastSeenMs", "ownerTag", "agentId"]) {
      expect(json).not.toContain(secret);
    }
    const mine = view.agents.find((a) => a.mine)!;
    expect(mine.name).toBe("node-alice-macbook");
    const other = view.agents.find((a) => !a.mine)!;
    expect(other.name).toBeUndefined();
    expect(Object.keys(other).sort()).toEqual(
      ["activeModel", "activity", "computeClass", "continent", "coordinatorId", "country", "id", "label", "mine", "models", "modelsTotal", "os", "region", "rttMs", "slots", "slotsUsed", "status", "tier", "vramGb"].sort()
    );
  });
});

describe("own machines", () => {
  it("marks the caller's machines on this and on peer coordinators, and an unlinked agent as its own account", () => {
    const self = world("coord-us", "https://us.example", [facts("mine-1", { ownerAccountId: "acct-1" }), facts("theirs", { ownerAccountId: "acct-2" })]);
    const peer = world("coord-eu", "https://eu.example", [facts("mine-2", { ownerAccountId: "acct-1" })]);
    const view = toPublicWorld(self, [{ url: "https://eu.example", id: "coord-eu", world: peer, rttMs: 80 }], "acct-1", NOW);
    expect(view.agents.filter((a) => a.mine).map((a) => a.name).sort()).toEqual(["mine-1", "mine-2"]);
    expect(view.totals.mine).toBe(2);
    // Mine first.
    expect(view.agents[0].mine && view.agents[1].mine).toBe(true);

    const unlinked = toPublicWorld(world("c", "https://c.example", [facts("solo-agent")]), [], "solo-agent", NOW);
    expect(unlinked.agents[0]).toMatchObject({ mine: true, name: "solo-agent" });
    // No caller account: nothing is anyone's.
    expect(toPublicWorld(self, [], null, NOW).agents.every((a) => !a.mine)).toBe(true);
  });
});

describe("status, region and models", () => {
  it("reports busy / idle / stale, slots used and the coordinator's round trip", () => {
    const w = world("c", "u", [facts("a", { claims: 3, slots: 2 }), facts("b"), facts("c", { connected: false, lastSeenMs: NOW - 5 * 60_000 })]);
    const v = toPublicWorld(w, [], null, NOW);
    expect(v.agents.map((a) => a.status)).toEqual(["busy", "idle", "stale"]);
    expect(v.agents[0]).toMatchObject({ slots: 2, slotsUsed: 2, rttMs: 42 });
    expect(v.agents[2].rttMs).toBeNull();
    expect(v.totals).toMatchObject({ agents: 3, online: 2, busy: 1 });
  });

  it("leaves out agents not seen for the TTL", () => {
    const v = toPublicWorld(world("c", "u", [facts("old", { connected: false, lastSeenMs: NOW - 60 * 60_000 })]), [], null, NOW);
    expect(v.agents).toHaveLength(0);
  });

  it("maps Fly regions and countries to a continent without any lookup", () => {
    expect(regionInfo("sin", null)).toEqual({ region: "sin", country: "SG", continent: "AS" });
    expect(regionInfo("jnb", "US")).toEqual({ region: "jnb", country: "ZA", continent: "AF" });
    expect(regionInfo(null, "de")).toEqual({ region: null, country: "DE", continent: "EU" });
    expect(regionInfo("Not A Region!", "zz")).toEqual({ region: null, country: "ZZ", continent: null });
  });

  it("keeps the active model first and caps models per agent", () => {
    const models = Array.from({ length: 30 }, (_, i) => `m${String(i).padStart(2, "0")}:1b`);
    const a = localWorldAgent(KEY, "c", facts("a", { models: [...models, "edgecoder-default"], activeModel: "m29:1b" }));
    expect(a.models).toHaveLength(WORLD_MAX_MODELS_PER_AGENT);
    expect(a.models[0]).toBe("m29:1b");
    expect(a.modelsTotal).toBe(30);
  });

  it("lists another person's home GPU host with no region, country, VRAM or LAN facts, masked, with its model", () => {
    // What a plain Linux agent (clientType edgecoder-native) reports: no AGENT_REGION, no country, a
    // demoted grant (the tier is the grant, not the claim). None of those gate the world view.
    const gpuHost = facts("amd-5700xt", {
      ownerAccountId: "acct-patrick", os: "linux", clientType: "edgecoder-native", region: null, countryCode: null,
      computeClass: "gpu", tier: "gpu.c8", vramGb: undefined, models: ["qwen3-coder:30b"], activeModel: "qwen3-coder:30b", slots: 1,
      sourceIp: undefined, lanAddresses: undefined
    });
    const v = toPublicWorld(world("c", "u", [facts("mine-mac", { ownerAccountId: "acct-cody" }), gpuHost]), [], "acct-cody", NOW);
    const host = v.agents.find((a) => !a.mine)!;
    expect(host).toMatchObject({ os: "linux", region: null, country: null, continent: null, computeClass: "gpu", tier: "gpu.c8", vramGb: null, models: ["qwen3-coder:30b"], status: "idle", slots: 1 });
    expect(host.label).toMatch(/^lin-\u2022\u2022\u2022[0-9a-f]{4}$/);
    expect(JSON.stringify(host)).not.toContain("amd-5700xt");
    expect(v.models.map((m) => m.model)).toContain("qwen3-coder:30b");
    expect(v.totals).toMatchObject({ agents: 2, online: 2 });
  });

  it("counts models over online agents", () => {
    const v = toPublicWorld(world("c", "u", [facts("a", { models: ["x:1b", "y:2b"] }), facts("b", { models: ["x:1b"] })]), [], null, NOW);
    expect(v.models[0]).toEqual({ model: "x:1b", agents: 2, online: 2 });
    expect(v.totals.models).toBe(2);
  });
});

describe("coordinators and links", () => {
  it("lists the coordinator asked, reachable peers with their agents and unreachable ones without", () => {
    const self = world("coord-us", "https://us.example", [facts("a")], [{ from: "coord-us", to: "coord-eu", rttMs: 88.6 }]);
    const peer = world("coord-eu", "https://eu.example", [facts("b"), facts("c")]);
    const v = toPublicWorld(
      self,
      [
        { url: "https://eu.example", id: "coord-eu", world: peer, rttMs: 90 },
        { url: "https://ap.example", id: "coord-ap", world: null, rttMs: null }
      ],
      null,
      NOW
    );
    expect(v.coordinators.map((c) => [c.id, c.self, c.reachable, c.agents])).toEqual([
      ["coord-us", true, true, 1],
      ["coord-eu", false, true, 2],
      ["coord-ap", false, false, 0]
    ]);
    // One link per pair; the measured figure kept.
    expect(v.links).toContainEqual({ from: "coord-us", to: "coord-eu", rttMs: 89, workPerMin: 0, gossipPerMin: 0 });
    expect(v.links.filter((l) => [l.from, l.to].includes("coord-eu"))).toHaveLength(1);
    expect(v.links).toContainEqual({ from: "coord-us", to: "coord-ap", rttMs: null, workPerMin: 0, gossipPerMin: 0 });
    expect(v.agents.filter((a) => a.coordinatorId === "coord-eu")).toHaveLength(2);
  });

  it("shows an agent known to two coordinators once, where it was seen last", () => {
    const self = world("us", "u", [facts("moved", { lastSeenMs: NOW - 100_000 })]);
    const peer = world("eu", "e", [facts("moved", { lastSeenMs: NOW - 1_000 })]);
    const v = toPublicWorld(self, [{ url: "e", id: "eu", world: peer, rttMs: null }], null, NOW);
    expect(v.agents).toHaveLength(1);
    expect(v.agents[0].coordinatorId).toBe("eu");
  });

  it("is bounded: at most WORLD_MAX_AGENTS agents, the caller's kept first", () => {
    const many = Array.from({ length: WORLD_MAX_AGENTS + 25 }, (_, i) => facts(`agent-${i}`));
    many.push(facts("mine", { ownerAccountId: "acct-me", connected: false, lastSeenMs: NOW - 5 * 60_000 }));
    const v = toPublicWorld(world("c", "u", many), [], "acct-me", NOW);
    expect(v.agents).toHaveLength(WORLD_MAX_AGENTS);
    expect(v.truncated).toBe(true);
    expect(v.totals.agents).toBe(WORLD_MAX_AGENTS + 26);
    expect(v.agents[0]).toMatchObject({ mine: true, name: "mine" });
  });
});

describe("parseLocalWorld (a peer coordinator's answer)", () => {
  it("drops malformed agents and replaces a label that is not masked", () => {
    const w = world("eu", "https://eu.example", [facts("a")]);
    const raw = JSON.parse(JSON.stringify(w));
    raw.agents[0].label = "bobs-macbook";
    raw.agents.push({ agentId: "x" }, { agentId: "y", id: "NOT-HEX", label: "mac-•••abcd" }, null);
    const parsed = parseLocalWorld(raw)!;
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0].label).toMatch(MASKED_LABEL_RE);
    expect(parsed.agents[0].label).not.toContain("bob");
    expect(parsed.agents[0].coordinatorId).toBe("eu");
    expect(parseLocalWorld({ agents: [] })).toBeNull();
    expect(parseLocalWorld("nope")).toBeNull();
  });
});

describe("routing facts (perf) between coordinators", () => {
  it("a peer's perf is parsed field by field, and never reaches a public answer", () => {
    const w = world("coord-eu", "https://eu.example", [facts("gpu-box")]);
    const perf = { contextWindow: 32_768, tokensPerSec: 40.5, reliability: 0.97, verified: true, freeSlots: 1, failRate: 0.05, tierWeight: 2 };
    const raw = JSON.parse(JSON.stringify({ ...w, agents: w.agents.map((a) => ({ ...a, perf })) }));
    const parsed = parseLocalWorld(raw)!;
    expect(parsed.agents[0].perf).toEqual(perf);
    // Malformed fields are dropped to null, not passed on.
    const bad = parseLocalWorld({ ...raw, agents: raw.agents.map((a: object) => ({ ...a, perf: { contextWindow: "big", tokensPerSec: -1, reliability: 3, verified: "yes", freeSlots: 1e9, failRate: null } })) })!;
    expect(bad.agents[0].perf).toEqual({ contextWindow: null, tokensPerSec: null, reliability: null, verified: false, freeSlots: 0, failRate: null, tierWeight: 1 });
    expect(parseLocalWorld({ ...raw, agents: raw.agents.map(({ perf: _p, ...a }: { perf: unknown }) => a) })!.agents[0].perf).toBeUndefined();
    const pub = toPublicWorld(world("coord-us", "https://us.example", []), [{ url: "https://eu.example", id: "coord-eu", world: parsed, rttMs: 80 }], null, NOW);
    expect(pub.agents).toHaveLength(1);
    expect("perf" in pub.agents[0]).toBe(false);
  });
});

describe("agents known to two coordinators", () => {
  const ids = (pub: ReturnType<typeof toPublicWorld>) => pub.agents.map((a) => a.coordinatorId);
  const coord = (pub: ReturnType<typeof toPublicWorld>, id: string) => pub.coordinators.find((c) => c.id === id)!;

  it("drops the stale copy when the agent is live elsewhere, even if the stale copy was seen later", () => {
    const us = world("coord-us", "https://us.example", [facts("ec-st6-fra", { connected: false, lastSeenMs: NOW - 500 })]);
    const eu = world("coord-eu", "https://eu.example", [facts("ec-st6-fra", { lastSeenMs: NOW - 2_000 })]);
    for (const [self, peer] of [[us, eu], [eu, us]] as const) {
      const pub = toPublicWorld(self, [{ url: peer.coordinator.url, id: peer.coordinator.id, world: peer, rttMs: 80 }], null, NOW);
      expect(ids(pub)).toEqual(["coord-eu"]);
      expect(pub.agents[0].status).toBe("idle");
      expect(coord(pub, "coord-us")).toMatchObject({ agents: 0, agentsOnline: 0 });
      expect(coord(pub, "coord-eu")).toMatchObject({ agents: 1, agentsOnline: 1 });
      expect(pub.totals).toMatchObject({ agents: 1, online: 1 });
    }
  });

  it("keeps the most recently seen copy when the agent is stale everywhere", () => {
    const us = world("coord-us", "https://us.example", [facts("ec-st5-lhr", { connected: false, lastSeenMs: NOW - 600_000 })]);
    const eu = world("coord-eu", "https://eu.example", [facts("ec-st5-lhr", { connected: false, lastSeenMs: NOW - 300_000 })]);
    const pub = toPublicWorld(us, [{ url: "https://eu.example", id: "coord-eu", world: eu, rttMs: 80 }], null, NOW);
    expect(ids(pub)).toEqual(["coord-eu"]);
    expect(pub.agents[0].status).toBe("stale");
    expect(coord(pub, "coord-us").agents).toBe(0);
    expect(coord(pub, "coord-eu")).toMatchObject({ agents: 1, agentsOnline: 0 });
    expect(pub.totals).toMatchObject({ agents: 1, online: 0 });
  });

  it("keeps one copy, the one seen last, when the agent is live on both", () => {
    const us = world("coord-us", "https://us.example", [facts("ec-st6-fra", { lastSeenMs: NOW - 5_000 })]);
    const eu = world("coord-eu", "https://eu.example", [facts("ec-st6-fra", { claims: 1, lastSeenMs: NOW - 1_000 })]);
    const pub = toPublicWorld(us, [{ url: "https://eu.example", id: "coord-eu", world: eu, rttMs: 80 }], null, NOW);
    expect(ids(pub)).toEqual(["coord-eu"]);
    expect(pub.agents[0].status).toBe("busy");
    expect(coord(pub, "coord-us").agents).toBe(0);
    expect(pub.totals).toMatchObject({ agents: 1, online: 1, busy: 1 });
  });

  it("keeps the mine marking on the surviving copy", () => {
    const us = world("coord-us", "https://us.example", [facts("ec-st6-fra", { ownerAccountId: "acct-1", connected: false, lastSeenMs: NOW - 500 })]);
    const eu = world("coord-eu", "https://eu.example", [facts("ec-st6-fra", { ownerAccountId: "acct-1" })]);
    const pub = toPublicWorld(us, [{ url: "https://eu.example", id: "coord-eu", world: eu, rttMs: 80 }], "acct-1", NOW);
    expect(pub.agents).toHaveLength(1);
    expect(pub.agents[0]).toMatchObject({ mine: true, name: "ec-st6-fra", coordinatorId: "coord-eu" });
    expect(pub.totals.mine).toBe(1);
  });
});

describe("outside coordinators (signature-only peers on Fly sin and Azure jnb)", () => {
  it("names the region of a geolocated coordinator from its coordinates, and none when it is far from every region", () => {
    expect(nearestRegion(1.29, 103.85)).toBe("sin");
    expect(nearestRegion(-26.2, 28.04)).toBe("jnb");
    expect(nearestRegion(32.65, -97.33)).toBe("dfw");
    // Nairobi: Johannesburg is ~2,900 km away, too far to name.
    expect(nearestRegion(-1.29, 36.82)).toBeNull();
    expect(nearestRegion(Number.NaN, 0)).toBeNull();
    expect(nearestRegion(95, 0)).toBeNull();
  });

  it("reads a geolocation answer (keyless and full shapes) into a region code and a country", () => {
    // The keyless api.ipapi.is answer for the Azure South Africa North address.
    expect(regionFromGeo({ ip: "4.168.235.184", city: "Johannesburg", country: "South Africa", lat: -26.20227, lon: 28.04363 })).toEqual({ region: "jnb", countryCode: "ZA" });
    expect(regionFromGeo({ location: { latitude: 1.35, longitude: 103.82, country_code: "sg" } })).toEqual({ region: "sin", countryCode: "SG" });
    expect(regionFromGeo({ country: "Kenya", lat: -1.29, lon: 36.82 })).toEqual({ region: null, countryCode: "KE" });
    expect(regionFromGeo(null)).toEqual({ region: null, countryCode: null });
    expect(regionFromGeo("nope")).toEqual({ region: null, countryCode: null });
  });

  it("an unreachable peer keeps the region it gave at /identity, and a reachable one whose view names none takes it too", () => {
    const self = world("coord-us", "https://coordinator.example", []);
    const sinPlace = regionInfo("sin", null);
    const jnbPlace = regionInfo("jnb", null);
    const old = world("coord-jnb-azure", "https://jnb.example", [facts("ec-st9-jnb-host", { region: "jnb", countryCode: "ZA" })]);
    old.coordinator = { ...old.coordinator, region: null, country: null, continent: null };
    const view = toPublicWorld(
      self,
      [
        { url: "https://sin.example", id: "coord-sin-fly", world: null, rttMs: 212, place: sinPlace },
        { url: "https://jnb.example", id: "coord-jnb-azure", world: old, rttMs: 238, place: jnbPlace }
      ],
      null,
      NOW
    );
    const by = Object.fromEntries(view.coordinators.map((c) => [c.id, c]));
    expect(by["coord-sin-fly"]).toMatchObject({ reachable: false, region: "sin", country: "SG", continent: "AS", agents: 0 });
    expect(by["coord-jnb-azure"]).toMatchObject({ reachable: true, region: "jnb", country: "ZA", continent: "AF", agents: 1 });
    expect(view.links.find((l) => l.to === "coord-sin-fly")?.rttMs).toBe(212);
    expect(view.links.find((l) => l.to === "coord-jnb-azure")?.rttMs).toBe(238);
    // The region a peer reports in its own view wins over the hint.
    const own = toPublicWorld(self, [{ url: "https://x.example", id: "coord-x", world: world("coord-x", "https://x.example", []), rttMs: null, place: sinPlace }], null, NOW);
    expect(own.coordinators[1].region).toBe("iad");
  });

  it("marks your machine as yours on an outside coordinator, by its owner tag", () => {
    const self = world("coord-us", "https://coordinator.example", [facts("someone-else", { ownerAccountId: "acct-other" })]);
    const outside = world("coord-jnb-azure", "https://jnb.example", [facts("maw-mb-02", { ownerAccountId: "acct-maw", os: "linux", region: "jnb", countryCode: "ZA" })]);
    const view = toPublicWorld(self, [{ url: "https://jnb.example", id: "coord-jnb-azure", world: outside, rttMs: 240 }], "acct-maw", NOW);
    const mine = view.agents.filter((a) => a.mine);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: "maw-mb-02", coordinatorId: "coord-jnb-azure", region: "jnb" });
    expect(view.totals.mine).toBe(1);
  });
});
