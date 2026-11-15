import { describe, expect, it } from "vitest";
import {
  MASKED_LABEL_RE,
  WORLD_MAX_AGENTS,
  WORLD_MAX_MODELS_PER_AGENT,
  localWorldAgent,
  maskedId,
  osFamily,
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
      ["activeModel", "computeClass", "continent", "coordinatorId", "country", "id", "label", "mine", "models", "modelsTotal", "os", "region", "rttMs", "slots", "slotsUsed", "status", "tier", "vramGb"].sort()
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
    expect(v.links).toContainEqual({ from: "coord-us", to: "coord-eu", rttMs: 89 });
    expect(v.links.filter((l) => [l.from, l.to].includes("coord-eu"))).toHaveLength(1);
    expect(v.links).toContainEqual({ from: "coord-us", to: "coord-ap", rttMs: null });
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
