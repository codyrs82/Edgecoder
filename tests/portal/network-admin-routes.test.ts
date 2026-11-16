import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mergeNetworkSnapshots, mergeRoutingDecisions, mergeSeries, registerNetworkAdminRoutes, type OwnerDirectory } from "../../src/portal/routes/network-admin.js";
import { cannedSnapshots } from "./fixtures/network-snapshots.js";

/** Settings > Network's API: system admins only; every coordinator asked with the admin token, merged, joined to emails. */
describe("portal network admin API", () => {
  const seen: Array<{ coordinator: string; url: string; adminToken: unknown }> = [];
  const coordinators: FastifyInstance[] = [];
  const bases: string[] = [];
  let user: { userId: string; email: string; emailVerified: boolean } | null;
  let isAdmin = true;
  let lookups: Array<{ agentIds: string[]; userIds: string[] }> = [];
  const NOW = Date.now();

  beforeAll(async () => {
    const snaps = cannedSnapshots(NOW);
    for (const [name, snap] of [["us", snaps.us], ["eu", snaps.eu]] as const) {
      const c = Fastify();
      c.get("/admin/network", async (req, reply) => {
        seen.push({ coordinator: name, url: req.url, adminToken: req.headers["x-admin-token"] });
        if (req.headers["x-admin-token"] !== "coord-admin-token") return reply.code(401).send({ error: "invalid_admin_token" });
        return snap;
      });
      await c.listen({ port: 0, host: "127.0.0.1" });
      const addr = c.server.address();
      bases.push(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
      coordinators.push(c);
    }
  });
  afterAll(async () => {
    for (const c of coordinators) await c.close();
  });

  const owners: OwnerDirectory = {
    // The portal's enrollment of the US Mac names its owner; the others resolve through acct-<userId>.
    nodeOwners: new Map([["mac-studio-7f3a", { userId: "u-alice", email: "alice@portal.example" }]]),
    userEmails: new Map([["u-bob", "bob@portal.example"], ["u-dora", "dora@portal.example"]])
  };

  const build = (opts: { token?: string; urls?: string[] } = {}): FastifyInstance => {
    const app = Fastify();
    registerNetworkAdminRoutes(app, {
      coordinatorAdminToken: opts.token ?? "coord-admin-token",
      EXTERNAL_HTTP_TIMEOUT_MS: 3000,
      coordinatorUrls: async () => opts.urls ?? [bases[0] + "/", bases[1]!, bases[0]!],
      getCurrentUser: async () => user,
      buildAccessContext: async () => ({ isSystemAdmin: isAdmin }),
      lookupOwners: async (agentIds, userIds) => {
        lookups.push({ agentIds: [...agentIds].sort(), userIds: [...userIds].sort() });
        return owners;
      }
    });
    return app;
  };

  beforeEach(() => {
    seen.length = 0;
    lookups = [];
    user = { userId: "u-root", email: "root@example.com", emailVerified: true };
    isAdmin = true;
  });

  it("refuses anyone who is not a system admin, before any coordinator call", async () => {
    const app = build();
    user = null;
    expect((await app.inject({ url: "/portal/api/admin/network" })).statusCode).toBe(401);
    user = { userId: "u-1", email: "someone@example.com", emailVerified: true };
    isAdmin = false;
    const res = await app.inject({ url: "/portal/api/admin/network" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "admin_only" });
    expect(seen).toEqual([]);
    expect(lookups).toEqual([]);
  });

  it("says when the coordinator admin token is not configured", async () => {
    const res = await build({ token: "" }).inject({ url: "/portal/api/admin/network" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("coordinator_admin_token_not_configured");
    expect(seen).toEqual([]);
  });

  it("asks every coordinator once with the admin token, merges them and joins agents to emails", async () => {
    const res = await build().inject({ url: "/portal/api/admin/network?range=6h" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(seen.map((s) => s.coordinator).sort()).toEqual(["eu", "us"]);
    expect(seen.every((s) => s.adminToken === "coord-admin-token" && s.url === "/admin/network?range=6h")).toBe(true);
    expect(lookups).toEqual([{ agentIds: ["mac-studio-7f3a", "mbp-m3-carol", "old-laptop-9", "rtx4090-box-21", "ryzen-eu-55"], userIds: ["u-alice", "u-bob", "u-carol", "u-dora"] }]);

    const r = res.json();
    expect(r.range).toBe("6h");
    expect(r.coordinators).toHaveLength(2);
    // The Mac is on both lists; the newer (US, connected) entry wins, and its email comes from the enrollment.
    const mac = r.agents.filter((a: { agentId: string }) => a.agentId === "mac-studio-7f3a");
    expect(mac).toHaveLength(1);
    expect(mac[0]).toMatchObject({ status: "busy", coordinator: bases[0]!.replace("http://", ""), userId: "u-alice", email: "alice@portal.example", emailSource: "enrollment" });
    expect(r.agents.find((a: { agentId: string }) => a.agentId === "ryzen-eu-55")).toMatchObject({ email: "dora@portal.example", emailSource: "account", coordinatorRegion: "ams" });
    // No portal record: the coordinator's own owner email is not there either, so nothing.
    expect(r.agents.find((a: { agentId: string }) => a.agentId === "mbp-m3-carol")).toMatchObject({ userId: "u-carol", email: null });

    expect(r.kpis).toMatchObject({ agentsOnline: 4, agentsBusy: 3, totalSlots: 12, freeSlots: 6, queued: 7, waitingInference: 1, callsPerMin: 17.3, pickupP90: 1650, ttftP90: 2800 });
    expect(r.latency.ttft).toEqual({ count: 160, p50: Math.round((820 * 120 + 950 * 40) / 160), p90: 2800 });
    const llama = r.models.find((m: { model: string }) => m.model === "llama3.1:8b");
    expect(llama).toMatchObject({ agents: 3, slots: 10, freeSlots: 6, calls24h: 5100 });
    expect(r.gaps.missingModels[0]).toEqual({ model: "deepseek-r1:70b", noAgentHasModel: 13, noCapacity: 0, holders: 0 });
    expect(r.gaps.staleAgents.map((a: { agentId: string }) => a.agentId)).toEqual(["old-laptop-9"]);
    expect(r.gaps.thinCoordinators).toEqual([{ coordinator: bases[1]!.replace("http://", ""), region: "ams", connected: 1 }]);
    // Regions: the agent's own where it reported one (sin), else its coordinator's (iad, ams); never
    // "unknown" because the portal had no country for it.
    expect(r.gaps.regions).toEqual([{ region: "iad", agents: 2, reported: 0 }, { region: "ams", agents: 1, reported: 0 }, { region: "sin", agents: 1, reported: 1 }]);
    expect(r.gaps.coordinators).toEqual([
      { coordinator: bases[0]!.replace("http://", ""), region: "iad", connected: 3 },
      { coordinator: bases[1]!.replace("http://", ""), region: "ams", connected: 1 }
    ]);
    // The gap series: maps merged per key, agents per coordinator added from each list.
    const p = r.series.points.at(-1);
    expect(Object.keys(p.agentsByRegion).sort()).toEqual(["ams", "iad", "sin"]);
    expect(Object.keys(p.agentsByCoordinator).sort()).toEqual([bases[0]!.replace("http://", "") + " · iad", bases[1]!.replace("http://", "") + " · ams"].sort());
    expect(p.modelSlots["llama3.1:8b"]).toEqual({ free: expect.any(Number), total: expect.any(Number) });
    expect(typeof p.staleAgents).toBe("number");
    // Series: bucket starts line up, so the merged series has the longer list's length.
    expect(r.series.points).toHaveLength(240);
  });

  it("passes the 7 d range through to every coordinator; an unknown range falls back to 1 h", async () => {
    const res = await build().inject({ url: "/portal/api/admin/network?range=7d" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().range).toBe("7d");
    expect(seen.every((s) => s.url === "/admin/network?range=7d")).toBe(true);
    seen.length = 0;
    expect((await build().inject({ url: "/portal/api/admin/network?range=30d" })).json().range).toBe("1h");
    expect(seen.every((s) => s.url === "/admin/network?range=1h")).toBe(true);
  });

  it("reports a coordinator that refuses or does not answer, and still shows the others", async () => {
    const res = await build({ urls: [bases[0]!, "http://127.0.0.1:1"] }).inject({ url: "/portal/api/admin/network" });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.coordinators).toEqual([expect.objectContaining({ ok: true, peerId: "coord-us" }), { url: "http://127.0.0.1:1", ok: false, error: "coordinator_unreachable", status: null }]);
    expect(r.gaps.unreachableCoordinators).toEqual(["http://127.0.0.1:1"]);
    expect(r.kpis.agentsOnline).toBe(3);
  });

  it("merges routing decisions from every coordinator, newest first, marked with where they were made", () => {
    const { us, eu } = cannedSnapshots(1_000_000);
    us.routing = { decisions: [{ atMs: 10, model: "qwen3-coder:30b", job: "agentic" }, { atMs: 30, model: "qwen2.5-coder:7b", job: "chat" }], config: { weights: { quality: 0.4 } } };
    eu.routing = { decisions: [{ atMs: 20, model: "qwen2.5-coder:14b", job: "code_edit" }] };
    const d = mergeRoutingDecisions([{ url: "https://us.example", snapshot: us }, { url: "https://eu.example", snapshot: eu }]);
    expect(d.map((x) => [x.atMs, x.coordinator])).toEqual([[30, "us.example"], [20, "eu.example"], [10, "us.example"]]);
    const r = mergeNetworkSnapshots([{ url: "https://us.example", ok: true, snapshot: us }, { url: "https://eu.example", ok: true, snapshot: eu }], { nodeOwners: new Map(), userEmails: new Map() }, "1h");
    expect(r.routing.decisions).toHaveLength(3);
    expect(r.routing.config).toEqual({ weights: { quality: 0.4 } });
    // Older coordinators send no routing: nothing, not an error.
    delete us.routing;
    delete eu.routing;
    expect(mergeRoutingDecisions([{ url: "https://us.example", snapshot: us }])).toEqual([]);
  });

  it("a wrong admin token on the coordinator shows as admin_token_rejected", async () => {
    const r = mergeNetworkSnapshots([{ url: "https://c", ok: false, error: "admin_token_rejected", status: 401 }], { nodeOwners: new Map(), userEmails: new Map() }, "1h");
    expect(r.kpis.agentsOnline).toBe(0);
    expect(r.coordinators[0]).toMatchObject({ ok: false, error: "admin_token_rejected" });
  });

  it("merges the gap series: keyed maps add per key, saturation is counted again, agents per coordinator", () => {
    const a = [{ atMs: 0, connectedAgents: 3, staleAgents: 1, saturatedModels: 1, unmetByModel: { llama: 2 }, agentsByRegion: { ord: 3 }, modelSlots: { llama: { free: 0, total: 4 }, qwen: { free: 1, total: 2 } } }];
    const b = [{ atMs: 0, connectedAgents: 2, staleAgents: 0, saturatedModels: 2, unmetByModel: { llama: 1, qwen: 4 }, agentsByRegion: { cdg: 2 }, modelSlots: { llama: { free: 0, total: 2 }, qwen: { free: 0, total: 2 } } }];
    expect(mergeSeries([a, b], ["coordinator · ord", "coordinator-eu · cdg"])).toEqual([
      {
        atMs: 0, connectedAgents: 5, staleAgents: 1,
        // llama is full on both coordinators: one saturated model, not two (qwen has a free slot on one).
        saturatedModels: 1,
        unmetByModel: { llama: 3, qwen: 4 },
        agentsByRegion: { ord: 3, cdg: 2 },
        agentsByCoordinator: { "coordinator · ord": 3, "coordinator-eu · cdg": 2 },
        modelSlots: { llama: { free: 0, total: 6 }, qwen: { free: 1, total: 4 } },
        pickupP50: null, pickupP90: null, ttftP50: null, ttftP90: null
      }
    ]);
    // Older coordinators send none of these: nothing is added.
    expect(mergeSeries([[{ atMs: 0, queued: 1 }]])[0]).toEqual({ atMs: 0, queued: 1, pickupP50: null, pickupP90: null, ttftP50: null, ttftP90: null });
  });

  it("merges series: sums counts and gauges, averages p50, takes the worst p90", () => {
    const a = [{ atMs: 0, queued: 1, started: 2, pickupP50: 100, pickupP90: 300, ttftP50: null, ttftP90: null }];
    const b = [{ atMs: 0, queued: 3, started: 1, pickupP50: 200, pickupP90: 900, ttftP50: 50, ttftP90: 70 }, { atMs: 15_000, queued: 0, started: 0, pickupP50: null, pickupP90: null, ttftP50: null, ttftP90: null }];
    expect(mergeSeries([a, b])).toEqual([
      { atMs: 0, queued: 4, started: 3, pickupP50: 150, pickupP90: 900, ttftP50: 50, ttftP90: 70 },
      { atMs: 15_000, queued: 0, started: 0, pickupP50: null, pickupP90: null, ttftP50: null, ttftP90: null }
    ]);
  });
});
