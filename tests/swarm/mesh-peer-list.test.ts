import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { MeshConnectBackoff, MESH_CONNECT_REFUSED_BACKOFF_MS } from "../../src/swarm/mesh-connect-backoff.js";
import { CONNECT_REFUSAL_LOG_INTERVAL_MS, shouldLogConnectRefusal } from "../../src/swarm/coordinator/routes/agent-mesh.js";

/*
 * Mesh peer list and tunnel connects follow the same-account rule of direct work: the peer list
 * names only peers the caller may connect to, a refused connect is logged at most once an hour per
 * pair, and the worker backs off an hour from a peer that refused it.
 */

const accounts = vi.hoisted(() => new Map<string, string>());
vi.mock("../../src/swarm/coordinator/agent-accounts.js", () => ({
  verifiedAccountOf: async (agentId: string) => accounts.get(agentId) ?? null,
  accountsFor: async (ids: string[]) => new Map(ids.map((id) => [id, accounts.get(id) ?? null]))
}));

const VALID_TOKEN = "valid-registration-token";
let portal: Server;
let app: any;
const mine1 = createPeerKeys("agent-mpl-mine-1");
const mine2 = createPeerKeys("agent-mpl-mine-2");
const other = createPeerKeys("agent-mpl-other");
const unlinked = createPeerKeys("agent-mpl-unlinked");

function post(keys: PeerKeys, url: string, body: unknown) {
  const payload = JSON.stringify(body);
  const headers = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: "203.0.113.78", headers: { "content-type": "application/json", ...headers }, payload });
}

function get(keys: PeerKeys, url: string) {
  const headers = signRequest({ method: "GET", path: url, bodyHash: hashRequestBody(""), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "GET", url, remoteAddress: "203.0.113.78", headers });
}

beforeAll(async () => {
  accounts.set(mine1.peerId, "acct-mpl-mine");
  accounts.set(mine2.peerId, "acct-mpl-mine");
  accounts.set(other.peerId, "acct-mpl-other");
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body.registrationToken === VALID_TOKEN ? { allowed: true, reason: "ok", node: {} } : { allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = "mesh-secret-mpl";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  for (const keys of [mine1, mine2, other, unlinked]) {
    const res = await post(keys, "/register", { os: "macos", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem, localModelEnabled: true });
    expect(res.statusCode).toBe(200);
  }
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

describe("/agent-mesh/peers/:agentId", () => {
  test("lists only peers of the caller's own account", async () => {
    const res = await get(mine1, `/agent-mesh/peers/${mine1.peerId}`);
    expect(res.statusCode).toBe(200);
    const peers = res.json().peers as string[];
    expect(peers).toContain(mine2.peerId);
    expect(peers).not.toContain(other.peerId);
    expect(peers).not.toContain(unlinked.peerId);
    expect(peers).not.toContain(mine1.peerId);
  });

  test("an agent without a verified account gets no peers", async () => {
    const res = await get(unlinked, `/agent-mesh/peers/${unlinked.peerId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().peers).toEqual([]);
  });
});

describe("/agent-mesh/connect refusals", () => {
  test("still answer 403, logged once per pair under their own message", async () => {
    const warn = vi.spyOn(app.log, "warn");
    try {
      for (let i = 0; i < 3; i++) {
        const res = await post(other, "/agent-mesh/connect", { fromAgentId: other.peerId, toAgentId: mine1.peerId });
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ error: "direct_work_cross_account", market: "/submit" });
      }
      const refusals = warn.mock.calls.filter((c) => c[1] === "agent_mesh_connect_refused");
      expect(refusals).toHaveLength(1);
      expect(warn.mock.calls.some((c) => c[1] === "direct_work_offer_refused")).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("same-account connect still opens a tunnel", async () => {
    const res = await post(mine1, "/agent-mesh/connect", { fromAgentId: mine1.peerId, toAgentId: mine2.peerId });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  test("log dedupe is per pair and lapses after the interval", () => {
    const t0 = 1_000_000;
    expect(shouldLogConnectRefusal("dd-a", "dd-b", t0)).toBe(true);
    expect(shouldLogConnectRefusal("dd-b", "dd-a", t0 + 1)).toBe(false);
    expect(shouldLogConnectRefusal("dd-a", "dd-c", t0 + 1)).toBe(true);
    expect(shouldLogConnectRefusal("dd-a", "dd-b", t0 + CONNECT_REFUSAL_LOG_INTERVAL_MS - 1)).toBe(false);
    expect(shouldLogConnectRefusal("dd-a", "dd-b", t0 + CONNECT_REFUSAL_LOG_INTERVAL_MS)).toBe(true);
  });
});

describe("worker connect back-off", () => {
  const opts = (nowMs: number, tunnels: string[] = []) => ({
    self: "me",
    nowMs,
    blacklisted: (id: string) => id === "bad",
    hasTunnel: (id: string) => tunnels.includes(id)
  });

  test("skips self, blacklisted and tunnelled peers, up to two per pass", () => {
    const b = new MeshConnectBackoff();
    expect(b.pick(["me", "bad", "p1", "p2", "p3"], opts(0, ["p1"]))).toEqual(["p2", "p3"]);
  });

  test("a 403 skips that peer for an hour, then it is tried again", () => {
    const b = new MeshConnectBackoff();
    const t0 = 5_000;
    expect(b.pick(["x1", "x2", "mine"], opts(t0))).toEqual(["x1", "x2"]);
    b.note("x1", 403, t0);
    b.note("x2", 403, t0);
    // Later passes go past the refused peers to the ones that can connect.
    expect(b.pick(["x1", "x2", "mine"], opts(t0 + 1_000))).toEqual(["mine"]);
    expect(b.pick(["x1", "x2", "mine"], opts(t0 + MESH_CONNECT_REFUSED_BACKOFF_MS - 1))).toEqual(["mine"]);
    expect(b.pick(["x1", "x2", "mine"], opts(t0 + MESH_CONNECT_REFUSED_BACKOFF_MS))).toEqual(["x1", "x2"]);
  });

  test("other failures do not back off; success clears a back-off", () => {
    const b = new MeshConnectBackoff();
    b.note("p", 500, 0);
    expect(b.isBackingOff("p", 1)).toBe(false);
    b.note("p", 403, 0);
    expect(b.isBackingOff("p", 1)).toBe(true);
    b.note("p", 200, 2);
    expect(b.isBackingOff("p", 3)).toBe(false);
  });
});
