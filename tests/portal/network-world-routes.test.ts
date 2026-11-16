import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanWorld, pingUrlFor, registerNetworkWorldRoutes } from "../../src/portal/routes/network-world.js";
import { CDG, MY_MACHINE, ORD, WORLD } from "./fixtures/world-view.js";

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
    totals: { ...WORLD.totals, mine: accountId === "acct-u1" ? 1 : 0 }
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
    expect(body.links).toEqual([{ from: ORD, to: CDG, rttMs: 99 }]);
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
