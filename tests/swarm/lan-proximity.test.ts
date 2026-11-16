import { describe, expect, it } from "vitest";
import {
  LAN_MAX_ADDRESSES,
  inSubnet,
  isPrivateIPv4,
  localLanAddresses,
  networkKey,
  networkTag,
  parseLanCidr,
  pickSameNetworkAgent,
  probeableAddresses,
  samePublicNetwork,
  sanitizeLanAddresses
} from "../../src/swarm/lan-proximity.js";
import { localWorldAgent, parseLocalWorld, toPublicWorld, worldMaskKey, type AgentFacts, type LocalWorld } from "../../src/swarm/network-world.js";

describe("private addresses", () => {
  it("keeps RFC 1918 IPv4 only", () => {
    expect(["10.0.0.5", "172.16.3.4", "172.31.255.1", "192.168.1.23"].every(isPrivateIPv4)).toBe(true);
    expect(["8.8.8.8", "172.32.0.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "fe80::1", "nope"].some(isPrivateIPv4)).toBe(false);
  });
  it("sanitizes a reported list: CIDR shape, private, sane prefix, deduplicated, capped", () => {
    expect(parseLanCidr("192.168.1.23/24")).toEqual({ ip: "192.168.1.23", prefix: 24 });
    expect(parseLanCidr("192.168.1.23")).toBeNull();
    expect(parseLanCidr("192.168.1.23/31")).toBeNull();
    expect(parseLanCidr("8.8.8.8/24")).toBeNull();
    expect(sanitizeLanAddresses(["192.168.1.2/24", "192.168.1.2/24", "1.2.3.4/24", 7, "10.0.0.1/8", "10.0.0.2/8", "10.0.0.3/8", "10.0.0.4/8"])).toEqual([
      "192.168.1.2/24", "10.0.0.1/8", "10.0.0.2/8", "10.0.0.3/8"
    ]);
    expect(sanitizeLanAddresses("192.168.1.2/24")).toEqual([]);
    expect(sanitizeLanAddresses(Array(20).fill(0).map((_, i) => `10.0.0.${i + 1}/24`))).toHaveLength(LAN_MAX_ADDRESSES);
  });
  it("reads this computer's interfaces: private IPv4 only, physical first", () => {
    const nets = {
      lo0: [{ family: "IPv4", internal: true, cidr: "127.0.0.1/8", address: "127.0.0.1" }],
      bridge100: [{ family: "IPv4", internal: false, cidr: "192.168.64.1/24", address: "192.168.64.1" }],
      en0: [
        { family: "IPv4", internal: false, cidr: "192.168.1.23/24", address: "192.168.1.23" },
        { family: "IPv6", internal: false, cidr: "fe80::1/64", address: "fe80::1" }
      ],
      utun3: [{ family: "IPv4", internal: false, cidr: "100.101.1.2/32", address: "100.101.1.2" }]
    } as never;
    expect(localLanAddresses(nets)).toEqual(["192.168.1.23/24", "192.168.64.1/24"]);
  });
});

describe("what gets probed", () => {
  it("only another machine's addresses inside one of this computer's subnets, never its own", () => {
    expect(inSubnet("192.168.1.40", "192.168.1.23", 24)).toBe(true);
    expect(inSubnet("192.168.2.40", "192.168.1.23", 24)).toBe(false);
    const local = ["192.168.1.23/24"];
    expect(probeableAddresses(["192.168.1.40/24", "10.0.0.5/8"], local)).toEqual(["192.168.1.40"]);
    expect(probeableAddresses(["192.168.1.23/24"], local)).toEqual([]);
    expect(probeableAddresses(["192.168.9.9/24"], local)).toEqual([]);
    expect(probeableAddresses(["8.8.8.8/24"], ["8.8.8.1/24"])).toEqual([]);
  });
});

describe("same public network", () => {
  it("IPv4 by address, IPv6 by /64, v4-mapped normalized; loopback is no network", () => {
    expect(networkKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(networkKey("2001:db8:1:2::abcd")).toBe("2001:0db8:0001:0002::/64");
    expect(networkKey("127.0.0.1")).toBeNull();
    expect(networkKey("::1")).toBeNull();
    expect(networkKey(undefined)).toBeNull();
    expect(samePublicNetwork("203.0.113.9", "::ffff:203.0.113.9")).toBe(true);
    expect(samePublicNetwork("2001:db8:1:2::1", "2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(true);
    expect(samePublicNetwork("2001:db8:1:2::1", "2001:db8:1:3::1")).toBe(false);
    expect(samePublicNetwork("203.0.113.9", "203.0.113.10")).toBe(false);
    expect(samePublicNetwork(null, null)).toBe(false);
    expect(networkTag("203.0.113.9")).toMatch(/^[0-9a-f]{32}$/);
    expect(networkTag("203.0.113.9")).not.toContain("203");
  });
  it("prefers the requester's own machine behind the same router, with room", () => {
    const c = [
      { agentId: "far-box", sourceIp: "198.51.100.7", freeSlots: 4 },
      { agentId: "mbp", sourceIp: "203.0.113.9", freeSlots: 1 },
      { agentId: "studio", sourceIp: "203.0.113.9", freeSlots: 2 },
      { agentId: "busy", sourceIp: "203.0.113.9", freeSlots: 0 }
    ];
    expect(pickSameNetworkAgent(c, "203.0.113.9")).toBe("studio");
    expect(pickSameNetworkAgent(c, "192.0.2.1")).toBeNull();
    expect(pickSameNetworkAgent(c, undefined)).toBeNull();
  });
});

describe("world view: LAN facts only to the owner, only for a signed agent", () => {
  const KEY = worldMaskKey("coordinator-secret");
  const NOW = 1_800_000_000_000;
  const facts = (agentId: string, over: Partial<AgentFacts>): AgentFacts => ({
    agentId, ownerAccountId: null, os: "macos", computeClass: "apple", tier: null, models: ["qwen3.5:9b"], activeModel: null,
    connected: true, claims: 0, slots: 1, lastSeenMs: NOW - 1000, rttMs: 30, ...over
  });
  const self: LocalWorld = {
    coordinator: { id: "coord-us", url: "https://c.example", region: "iad", country: "US", continent: "NA", agents: 3, agentsOnline: 3 },
    links: [],
    agents: [
      localWorldAgent(KEY, "coord-us", facts("alice-mbp", { ownerAccountId: "acct-alice", sourceIp: "203.0.113.9", lanAddresses: ["192.168.1.40/24"] })),
      localWorldAgent(KEY, "coord-us", facts("alice-cloud", { ownerAccountId: "acct-alice", sourceIp: "198.51.100.7", lanAddresses: ["10.1.2.3/16"] })),
      localWorldAgent(KEY, "coord-us", facts("bob-mac", { ownerAccountId: "acct-bob", sourceIp: "203.0.113.9", lanAddresses: ["192.168.1.77/24"] }))
    ],
    generatedAtMs: NOW
  };
  const callerNetTag = networkTag("203.0.113.9");

  it("the owner's desktop gets its machines' addresses and the hint; another account's machine gets nothing", () => {
    const view = toPublicWorld(self, [], "acct-alice", NOW, { callerNetTag });
    const by = (n: string) => view.agents.find((a) => a.name === n);
    expect(by("alice-mbp")?.lan).toEqual({ samePublicNetwork: true, addresses: ["192.168.1.40/24"] });
    expect(by("alice-cloud")?.lan).toEqual({ samePublicNetwork: false, addresses: ["10.1.2.3/16"] });
    const bob = view.agents.find((a) => !a.mine)!;
    expect(bob.lan).toBeUndefined();
    expect(bob.label).toMatch(/^mac-•••[0-9a-f]{4}$/);
    const text = JSON.stringify(view);
    expect(text).not.toContain("192.168.1.77");
    expect(text).not.toContain("203.0.113.9");
    expect(text).not.toMatch(/netTag|ownerTag|bob-mac/);
  });

  it("the portal (no lanFor) and other accounts get no LAN facts at all", () => {
    const portal = JSON.stringify(toPublicWorld(self, [], "acct-alice", NOW));
    expect(portal).not.toMatch(/192\.168|10\.1\.2\.3|"lan"/);
    const bob = JSON.stringify(toPublicWorld(self, [], "acct-bob", NOW, { callerNetTag }));
    expect(bob).not.toContain("192.168.1.40");
    expect(bob).toContain("192.168.1.77");
  });

  it("lanGroup: the owner's machines sharing a public network, opaque, for the portal too", () => {
    const withTwin: LocalWorld = {
      ...self,
      agents: [...self.agents, localWorldAgent(KEY, "coord-us", facts("alice-studio", { ownerAccountId: "acct-alice", sourceIp: "203.0.113.9" }))]
    };
    const portal = toPublicWorld(withTwin, [], "acct-alice", NOW);
    const by = (n: string) => portal.agents.find((a) => a.name === n)!;
    expect(by("alice-mbp").lanGroup).toBe("n1");
    expect(by("alice-studio").lanGroup).toBe("n1");
    // Alone on its network: no group. Someone else's machine on the same public IP: never grouped.
    expect(by("alice-cloud").lanGroup).toBeUndefined();
    expect(portal.agents.find((a) => !a.mine)!.lanGroup).toBeUndefined();
    expect(JSON.stringify(portal)).not.toMatch(/192\.168|203\.0\.113|netTag/);
  });

  it("a peer coordinator's LAN facts are checked before use", () => {
    const raw = JSON.parse(JSON.stringify(self));
    raw.agents[0].lan = ["192.168.1.40/24", "8.8.8.8/24", "<script>"];
    raw.agents[0].netTag = "not-a-tag";
    const parsed = parseLocalWorld(raw)!;
    expect(parsed.agents[0].lan).toEqual(["192.168.1.40/24"]);
    expect(parsed.agents[0].netTag).toBeNull();
  });
});
