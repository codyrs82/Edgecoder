import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/*
 * The Network page's data path: GET /v1/ide/network/world (IDE provider, IDE token) -> the agent's
 * forwarder GET /forward/network/world (signed by the agent) -> the coordinator's world view, plus
 * this computer's own round trip to each coordinator.
 */

const TOKEN = "test-ide-token-world-0123456789";
const HOST = "127.0.0.1:4304";
let fake: Server;
let base = "";
const seen: Array<{ url?: string; auth?: string }> = [];
let worldStatus = 200;

function world() {
  return {
    generatedAtMs: 1,
    servedBy: "coord-us",
    coordinators: [
      { id: "coord-us", url: base, region: "iad", country: "US", continent: "NA", agents: 2, agentsOnline: 2, reachable: true, self: true },
      { id: "coord-eu", url: "https://eu.invalid", region: "fra", country: "DE", continent: "EU", agents: 1, agentsOnline: 1, reachable: false, self: false }
    ],
    links: [{ from: "coord-us", to: "coord-eu", rttMs: 88 }],
    agents: [{ id: "abcdef0123", label: "lin-•••0123", mine: false, coordinatorId: "coord-us", rttMs: 40, status: "idle" }],
    models: [],
    totals: { coordinators: 2, agents: 1, online: 1, busy: 0, mine: 0, models: 0, slots: 1, slotsUsed: 0 },
    truncated: false
  };
}

beforeAll(async () => {
  // One fake server plays the agent's forwarder and the coordinator's public /identity.
  fake = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(req.url === "/forward/network/world" ? worldStatus : 200, { "content-type": "application/json" });
    if (req.url === "/forward/network/world") return res.end(JSON.stringify(worldStatus === 200 ? world() : { error: "rate_limited" }));
    if (req.url === "/identity") return res.end(JSON.stringify({ peerId: "coord-us" }));
    res.end("{}");
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
afterAll(() => fake.close());
beforeEach(async () => {
  seen.length = 0;
  worldStatus = 200;
  (await import("../../src/apps/ide/network-world.js")).resetCoordinatorProbeCache();
});

describe("networkWorld (src/apps/ide/network-world.ts)", () => {
  it("asks the forwarder with the IDE token and adds this computer's round trip to every coordinator, reachable from it or not", async () => {
    const { networkWorld } = await import("../../src/apps/ide/network-world.js");
    const probed: string[] = [];
    const r = await networkWorld({ forwarder: base, token: () => "ide-token", agentId: "mac-1" }, async (url) => {
      probed.push(url);
      return url === base ? 23 : 241;
    });
    expect(seen[0]).toEqual({ url: "/forward/network/world", auth: "Bearer ide-token" });
    expect(r.status).toBe(200);
    const coords = r.json.coordinators as Array<{ id: string; myRttMs: number | null }>;
    // coord-eu is unreachable from the answering coordinator, but this computer's round trip to it is still measured.
    expect(coords.map((c) => [c.id, c.myRttMs])).toEqual([["coord-us", 23], ["coord-eu", 241]]);
    expect(probed).toEqual([base, "https://eu.invalid"]);
    expect(r.json.latency).toMatchObject({ measuredFrom: "this computer" });
  });

  it("passes a coordinator refusal through, and a hosted transport is not timed from the server", async () => {
    const { networkWorld } = await import("../../src/apps/ide/network-world.js");
    worldStatus = 429;
    expect((await networkWorld({ forwarder: base, token: () => "t", agentId: "a" }, async () => 1)).status).toBe(429);
    const hosted = await networkWorld({ forwarder: "", token: () => "", agentId: "a", transport: async () => ({ status: 200, json: world() as never }) }, async () => {
      throw new Error("must not probe");
    });
    expect((hosted.json.coordinators as Array<{ myRttMs: unknown }>).every((c) => c.myRttMs === null)).toBe(true);
  });

  it("timedIdentityProbe times GET /identity and refuses anything but http(s)", async () => {
    const { timedIdentityProbe } = await import("../../src/apps/ide/network-world.js");
    const ms = await timedIdentityProbe(`${base}/some/other/path`);
    expect(typeof ms).toBe("number");
    expect(seen.map((s) => s.url)).toEqual(["/identity", "/identity"]);
    expect(await timedIdentityProbe("file:///etc/passwd")).toBeNull();
    expect(await timedIdentityProbe("not a url")).toBeNull();
    expect(await timedIdentityProbe("http://127.0.0.1:1")).toBeNull();
  });
});

describe("GET /v1/ide/network/world (IDE provider)", () => {
  let app: any;
  beforeAll(async () => {
    process.env.IDE_PROVIDER_TOKEN = TOKEN;
    process.env.SWARM_VIA_LOCAL_AGENT_URL = base;
    delete process.env.IDE_PROVIDER_HOST;
    app = (await import("../../src/apps/ide/provider-server.js")).ideProviderServer;
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    delete process.env.SWARM_VIA_LOCAL_AGENT_URL;
  });

  it("needs the IDE token", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/ide/network/world", headers: { host: HOST } })).statusCode).toBe(401);
  });

  it("answers the world view with this computer's round trips", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/ide/network/world", headers: { host: HOST, authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connected).toBe(true);
    expect(body.servedBy).toBe("coord-us");
    expect(typeof body.selfAgentId).toBe("string");
    expect(typeof body.coordinators[0].myRttMs).toBe("number");
    expect(seen.some((s) => s.url === "/forward/network/world" && s.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("reports a rate limit as such", async () => {
    worldStatus = 429;
    const res = await app.inject({ method: "GET", url: "/v1/ide/network/world", headers: { host: HOST, authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ connected: false, reason: "rate_limited" });
  });
});

describe("LAN proximity: only your own machines, probed directly from this computer", () => {
  const LOCAL = ["192.168.1.23/24"];
  const agents = () => [
    // Yours, same public network, on this subnet: probed.
    { id: "a1", mine: true, name: "codys-macbook-pro", status: "idle", lan: { samePublicNetwork: true, addresses: ["192.168.1.40/24"] } },
    // This computer itself: never probed.
    { id: "a2", mine: true, name: "mac-1", status: "idle", lan: { samePublicNetwork: true, addresses: ["192.168.1.23/24"] } },
    // Yours but on another public network (a café with the same 192.168.1.x): not probed.
    { id: "a3", mine: true, name: "codys-studio-away", status: "idle", lan: { samePublicNetwork: false, addresses: ["192.168.1.41/24"] } },
    // Yours, same public network, other subnet: not probed.
    { id: "a4", mine: true, name: "codys-pi", status: "idle", lan: { samePublicNetwork: true, addresses: ["10.0.0.9/24"] } },
    // Someone else's (a forged lan block would be ignored): never probed.
    { id: "a5", mine: false, label: "mac-•••beef", status: "idle", lan: { samePublicNetwork: true, addresses: ["192.168.1.77/24"] } },
    // Yours but stale: not probed.
    { id: "a6", mine: true, name: "codys-old-mac", status: "stale", lan: { samePublicNetwork: true, addresses: ["192.168.1.42/24"] } }
  ];

  it("picks candidates from own, same-network, same-subnet, live machines only", async () => {
    const { lanCandidates } = await import("../../src/apps/ide/network-world.js");
    expect(lanCandidates(agents(), "mac-1", LOCAL)).toEqual([{ index: 0, ip: "192.168.1.40" }]);
  });

  it("measures them, marks them same network, and never passes addresses to the page", async () => {
    const { withLanProximity } = await import("../../src/apps/ide/network-world.js");
    const probed: string[] = [];
    const out = await withLanProximity(agents(), "mac-1", { localCidrs: LOCAL, probe: async (ip) => (probed.push(ip), 2.4) });
    expect(probed).toEqual(["192.168.1.40"]);
    expect(out[0].lan).toEqual({ sameNetwork: true, rttMs: 2.4 });
    expect(out.slice(1).every((a) => a.lan === undefined)).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/192\.168|10\.0\.0|addresses|samePublicNetwork/);
  });

  it("a machine that does not answer is not marked same network", async () => {
    const { withLanProximity } = await import("../../src/apps/ide/network-world.js");
    const out = await withLanProximity(agents(), "mac-1", { localCidrs: LOCAL, probe: async () => null });
    expect(out[0].lan).toEqual({ sameNetwork: false, rttMs: null });
  });

  it("reads ping output on macOS, Linux and Windows", async () => {
    const { parsePingMs } = await import("../../src/apps/ide/network-world.js");
    expect(parsePingMs("round-trip min/avg/max/stddev = 1.912/2.401/3.002/0.4 ms")).toBe(1.9);
    expect(parsePingMs("rtt min/avg/max/mdev = 0.412/0.5/0.6/0.1 ms")).toBe(0.4);
    expect(parsePingMs("Minimum = 2ms, Maximum = 4ms, Average = 3ms")).toBe(2);
    expect(parsePingMs("3 packets transmitted, 0 packets received, 100.0% packet loss")).toBeNull();
  });

  it("the provider strips LAN facts when it is not on the user's computer (hosted transport)", async () => {
    const { networkWorld } = await import("../../src/apps/ide/network-world.js");
    const transport = async () => ({ status: 200, json: { coordinators: [], agents: agents() } });
    const r = await networkWorld({ forwarder: base, token: () => "t", agentId: "mac-1", transport: transport as never }, async () => 1, Date.now(), {
      localCidrs: LOCAL,
      probe: async () => {
        throw new Error("must not probe");
      }
    });
    expect(JSON.stringify(r.json)).not.toMatch(/192\.168|"lan"/);
  });
});
