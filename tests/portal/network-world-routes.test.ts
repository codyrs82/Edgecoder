import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanWorld, pingUrlFor, registerNetworkWorldRoutes } from "../../src/portal/routes/network-world.js";
import { ACTIVE_WORLD, CDG, MY_MACHINE, ORD, SERVING, WORLD } from "./fixtures/world-view.js";

/*
 * Settings > Network (everyone): GET /portal/api/network/world asks a coordinator's /network/world
 * with the portal service token and the account from the session, then rebuilds the answer from an
 * allowlist. Your machines are named; another account's machine is masked even if a coordinator
 * sent more than it should.
 */
const SERVICE = "s".repeat(40);
const seen: Array<{ url: string; token: unknown }> = [];
let mode: "ok" | "rate_limited" | "down" = "ok";

/** What a coordinator answers, plus fields that must never reach the browser. */
function coordinatorAnswer(accountId: string): unknown {
  return {
    ...WORLD,
    // The portal never receives myRttMs from a coordinator; the browser measures it.
    coordinators: WORLD.coordinators.map((c) => ({ ...c, myRttMs: undefined, meshToken: "mesh-secret" })),
    agents: WORLD.agents.map((a) =>
      a.mine && accountId === "acct-u1"
        ? { ...a, agentId: a.name, ownerTag: "tag-u1" }
        : { ...a, mine: false, name: undefined, ...(a.label === "lin-•••4e08" ? { name: "someone-elses-box", agentId: "someone-elses-box", sourceIp: "198.51.100.77", email: "stranger@example.com", ownerAccountId: "acct-u2" } : {}) }
    ),
    totals: { ...WORLD.totals, mine: accountId === "acct-u1" ? 1 : 0 },
    // u1's own request (the coordinator filters per account); a coordinator that leaked everyone's
    // requests and who is served by what must not get them past the portal.
    yourRequests: accountId === "acct-u1" ? [{ coordinator: ORD, machineKey: WORLD.agents[1].id, state: "streaming", accountId: "acct-u1", prompt: "secret prompt" }] : [],
    requests: [{ tag: "tag-u2", account: "acct-u2", machine: WORLD.agents[1].id, state: "starting" }]
  };
}

let coord: Server;
let app: ReturnType<typeof Fastify>;
beforeAll(async () => {
  coord = createServer((req, res) => {
    seen.push({ url: req.url ?? "", token: req.headers["x-portal-service-token"] });
    if (mode === "down") return res.writeHead(503).end();
    if (mode === "rate_limited") return res.writeHead(429, { "content-type": "application/json", "retry-after": "12" }).end(JSON.stringify({ error: "rate_limited" }));
    const u = new URL(req.url ?? "/", "http://x");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(coordinatorAnswer(u.searchParams.get("accountId") ?? "")));
  });
  await new Promise<void>((r) => coord.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(coord.address() as AddressInfo).port}`;
  app = Fastify();
  registerNetworkWorldRoutes(app, {
    PORTAL_SERVICE_TOKEN: SERVICE,
    EXTERNAL_HTTP_TIMEOUT_MS: 3000,
    discoverCoordinatorUrlsForPortal: async () => [`${url}/`, url],
    getCurrentUser: async (req) => (req.headers["x-test-user"] ? { userId: String(req.headers["x-test-user"]) } : null)
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await new Promise<void>((r) => coord.close(() => r()));
});
beforeEach(() => {
  seen.length = 0;
  mode = "ok";
});

const get = (user?: string, query = "") => app.inject({ method: "GET", url: `/portal/api/network/world${query}`, headers: user ? { "x-test-user": user } : {} });

describe("GET /portal/api/network/world", () => {
  it("needs a session", async () => {
    expect((await get()).statusCode).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("asks with the service token and the session's account, never one from the request", async () => {
    const res = await get("u1", "?accountId=acct-u2");
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ url: "/network/world?accountId=acct-u1", token: SERVICE });
  });

  it("names your machine and masks another account's, whatever the coordinator sent", async () => {
    const res = await get("u1");
    const body = res.json();
    const mine = body.agents.filter((a: any) => a.mine);
    expect(mine).toHaveLength(1);
    expect(mine[0].name).toBe(MY_MACHINE);
    expect(body.totals.mine).toBe(1);
    const other = body.agents.find((a: any) => a.label === "lin-•••4e08");
    expect(other.mine).toBe(false);
    expect(other.name).toBeUndefined();
    for (const leak of ["someone-elses-box", "198.51.100.77", "stranger@example.com", "acct-u2", "ownerTag", "tag-u1", "agentId", "sourceIp", "mesh-secret"]) {
      expect(res.body).not.toContain(leak);
    }
  });

  it("another account sees the same machine masked", async () => {
    const body = (await get("u2")).json();
    expect(body.totals.mine).toBe(0);
    expect(body.agents.every((a: any) => !a.mine && a.name === undefined)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(MY_MACHINE);
    expect(body.agents.find((a: any) => a.label === "mac-•••6bfc")).toBeTruthy();
  });

  it("keeps the shape the page draws: coordinators with a ping URL, the mesh link, models and totals", async () => {
    const body = (await get("u1")).json();
    expect(body.connected).toBe(true);
    expect(body.coordinators.map((c: any) => c.id).sort()).toEqual([CDG, ORD].sort());
    const ord = body.coordinators.find((c: any) => c.id === ORD);
    expect(ord).toMatchObject({ region: "ord", reachable: true, self: true, myRttMs: null, pingUrl: "https://coordinator.edgecoder.io/identity" });
    expect(body.links).toEqual([{ from: ORD, to: CDG, rttMs: 99, workPerMin: 0, gossipPerMin: 0 }]);
    expect(body.models[0]).toEqual({ model: "qwen2.5-coder:1.5b", agents: 6, online: 5 });
    expect(body.totals).toMatchObject({ coordinators: 2, online: 5, busy: 1, slots: 12, slotsUsed: 1 });
  });

  it("passes a rate limit on and says when no coordinator answered", async () => {
    mode = "rate_limited";
    const limited = await get("u1");
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("12");
    expect(limited.json()).toEqual({ connected: false, reason: "rate_limited" });
    mode = "down";
    const down = await get("u1");
    expect(down.statusCode).toBe(502);
    expect(down.json()).toEqual({ connected: false, reason: "coordinator_unreachable" });
  });
});

describe("activity through the portal", () => {
  it("passes your own request, and no one else's", async () => {
    const u1 = await get("u1");
    expect(u1.json().yourRequests).toEqual([{ coordinator: ORD, machineKey: WORLD.agents[1].id, state: "streaming" }]);
    const u2 = await get("u2");
    expect(u2.json().yourRequests).toEqual([]);
    for (const res of [u1, u2]) {
      for (const leak of ["acct-u2", "tag-u2", "secret prompt", '"requests"', '"accountId"', '"tag"']) expect(res.body).not.toContain(leak);
    }
  });

  it("keeps a machine's counts only, bounded, and drops anything else in them", () => {
    const w = cleanWorld({
      coordinators: [{ id: ORD, url: "https://a.example" }],
      agents: [
        { id: "aa01", coordinatorId: ORD, label: "lin-•••aa01", status: "busy", activity: { callsNow: 999, streaming: 5, callsPerMin: 1e9, servingAccount: "acct-u2", requesters: ["tag-u2"] } },
        { id: "aa02", coordinatorId: ORD, label: "lin-•••aa02", status: "stale", activity: { callsNow: 3, streaming: 3, callsPerMin: 2 } },
        { id: "aa03", coordinatorId: ORD, label: "lin-•••aa03", status: "idle" }
      ]
    });
    const agents = w.agents as Array<Record<string, unknown>>;
    expect(agents[0].activity).toEqual({ callsNow: 64, streaming: 5, callsPerMin: 10_000 });
    expect(agents[1].activity).toEqual({ callsNow: 0, streaming: 0, callsPerMin: 2 });
    expect(agents[2].activity).toEqual({ callsNow: 0, streaming: 0, callsPerMin: 0 });
    expect(JSON.stringify(w)).not.toMatch(/acct-u2|tag-u2|servingAccount|requesters/);
  });

  it("your requests: known coordinators, masked machine ids, three states, at most 20, nothing else", () => {
    const w = cleanWorld({
      coordinators: [{ id: ORD, url: "https://a.example" }],
      yourRequests: [
        { coordinator: ORD, machineKey: "abcdef0123", state: "streaming", agentId: "someone-elses-box", accountId: "acct-u2" },
        { coordinator: "ghost", machineKey: "abcdef0123", state: "streaming" },
        { coordinator: ORD, machineKey: "someone-elses-box", state: "starting" },
        { coordinator: ORD, machineKey: "abcdef0123", state: "queued" },
        { coordinator: ORD, machineKey: "abcdef0123", state: "exfiltrating" },
        ...Array.from({ length: 40 }, () => ({ coordinator: ORD, machineKey: "abcdef0123", state: "starting" }))
      ]
    });
    const mine = w.yourRequests as unknown[];
    expect(mine[0]).toEqual({ coordinator: ORD, machineKey: "abcdef0123", state: "streaming" });
    expect(mine[1]).toEqual({ coordinator: ORD, machineKey: null, state: "starting" });
    expect(mine[2]).toEqual({ coordinator: ORD, machineKey: null, state: "queued" });
    expect(mine.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(w)).not.toMatch(/someone-elses-box|acct-u2|ghost|exfiltrating/);
    expect(cleanWorld({ coordinators: [], yourRequests: "lots" }).yourRequests).toEqual([]);
  });

  it("mesh links carry work and gossip per minute, bounded", () => {
    const w = cleanWorld({
      coordinators: [{ id: ORD, url: "https://a.example" }, { id: CDG, url: "https://b.example" }],
      links: [{ from: ORD, to: CDG, rttMs: 9, workPerMin: 12, gossipPerMin: 1e12, peers: ["x"] }]
    });
    expect(w.links).toEqual([{ from: ORD, to: CDG, rttMs: 9, workPerMin: 12, gossipPerMin: 100_000 }]);
  });

  it("the busy fixture survives the allowlist unchanged where it matters", () => {
    const w = cleanWorld(ACTIVE_WORLD) as any;
    expect(w.yourRequests).toEqual([{ coordinator: ORD, machineKey: SERVING, state: "streaming" }]);
    expect(w.agents.find((a: any) => a.id === SERVING).activity).toEqual({ callsNow: 2, streaming: 2, callsPerMin: 14 });
  });
});

describe("cleanWorld / pingUrlFor", () => {
  it("replaces a label that does not look masked and drops a name on a machine that is not yours", () => {
    const w = cleanWorld({ agents: [{ id: "x1", coordinatorId: ORD, label: "alice-laptop", name: "alice-laptop", mine: false, status: "idle", models: [] }], coordinators: [] });
    expect(w.agents).toEqual([expect.objectContaining({ id: "x1", label: "machine-•••", mine: false })]);
    expect(JSON.stringify(w)).not.toContain("alice");
  });

  it("drops links to coordinators it does not list, and malformed entries", () => {
    const w = cleanWorld({ coordinators: [{ id: ORD, url: "https://a.example" }, { id: 5 }], links: [{ from: ORD, to: "ghost", rttMs: 1 }], agents: [{ label: "lin-•••0000" }] });
    expect(w.coordinators).toHaveLength(1);
    expect(w.links).toEqual([]);
    expect(w.agents).toEqual([]);
  });

  it("pings only https origins without credentials, at /identity", () => {
    expect(pingUrlFor("https://coordinator.edgecoder.io/some/path?q=1")).toBe("https://coordinator.edgecoder.io/identity");
    expect(pingUrlFor("http://coordinator.edgecoder.io")).toBeNull();
    expect(pingUrlFor("https://u:p@coordinator.edgecoder.io")).toBeNull();
    expect(pingUrlFor("javascript:alert(1)")).toBeNull();
    expect(cleanWorld({ coordinators: [{ id: ORD, url: "https://a.example", reachable: false }] }).coordinators).toEqual([expect.objectContaining({ pingUrl: null })]);
  });
});
