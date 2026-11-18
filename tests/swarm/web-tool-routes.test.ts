import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * The web tool's coordinator routes (docs/web-tool.md): account-authenticated (a signed agent, or
 * the portal naming the account), and off with "Web search isn't set up yet" while
 * BRAVE_SEARCH_API_KEY is unset.
 */

const MESH = "mesh-secret-web";
const PORTAL = "portal-secret-web";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.31";
let portal: Server;
let app: any;
const agent = createPeerKeys("agent-web-tool");

function signed(keys: PeerKeys, method: string, path: string, raw: string): Record<string, string> {
  return signRequest({ method, path, bodyHash: hashRequestBody(raw), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
}

beforeAll(async () => {
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const allowed = req.url === "/internal/nodes/validate" && body.registrationToken === VALID_TOKEN;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(allowed ? { allowed: true, reason: "portal_validated", node: {} } : { allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = MESH;
  process.env.PORTAL_SERVICE_TOKEN = PORTAL;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  const payload = JSON.stringify({ os: "macos", version: "1", mode: "swarm-only", agentId: agent.peerId, registrationToken: VALID_TOKEN, publicKeyPem: agent.publicKeyPem });
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed(agent, "POST", "/register", payload) }, payload });
  expect(res.statusCode).toBe(200);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

function signedPost(url: string, body: unknown) {
  const payload = JSON.stringify(body);
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed(agent, "POST", url, payload) }, payload });
}

describe("POST /v1/tools/web/* on the coordinator", () => {
  test("a signed agent passes the gate; without BRAVE_SEARCH_API_KEY status says it isn't set up", async () => {
    const res = await signedPost("/v1/tools/web/status", {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ configured: false, message: "Web search isn't set up yet", searchCSats: 0.5, readCSats: 0.2 });
  });

  test("search and read refuse with 503 before any charge", async () => {
    const s = await signedPost("/v1/tools/web/search", { query: "edgecoder", count: 3, requestId: "r1" });
    expect(s.statusCode).toBe(503);
    expect(s.json()).toEqual({ error: "web_search_not_configured", message: "Web search isn't set up yet" });
    const r = await signedPost("/v1/tools/web/read", { url: "https://example.com/", requestId: "r2" });
    expect(r.statusCode).toBe(503);
  });

  test("the portal names the account with its service token", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/tools/web/status", remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-portal-service-token": PORTAL }, payload: JSON.stringify({ accountId: "acct-u1" }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().configured).toBe(false);
  });

  test("free on your own machine: the portal's claim stands; an agent linked to no account can't claim it", async () => {
    const portalRes = await app.inject({ method: "POST", url: "/v1/tools/web/status", remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-portal-service-token": PORTAL }, payload: JSON.stringify({ accountId: "acct-u1", ownMachine: true }) });
    expect(portalRes.json()).toMatchObject({ free: true, canAfford: true, freeSearchesLeftToday: 100, freeReadsLeftToday: 200 });
    // This agent is registered but not linked to an account (no owner): its claim is ignored.
    const agentRes = await signedPost("/v1/tools/web/status", { ownMachine: true });
    expect(agentRes.statusCode).toBe(200);
    expect(agentRes.json().free).toBe(false);
    expect(agentRes.json()).not.toHaveProperty("freeSearchesLeftToday");
    // No claim, no free (a network chat).
    const plain = await app.inject({ method: "POST", url: "/v1/tools/web/status", remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-portal-service-token": PORTAL }, payload: JSON.stringify({ accountId: "acct-u1" }) });
    expect(plain.json().free).toBe(false);
  });

  test("a heartbeat may report local web; a machine with no verified owner still gets no local search", async () => {
    const hb = await signedPost("/heartbeat", { agentId: agent.peerId, localWeb: { search: true, read: true } });
    expect(hb.statusCode).toBe(200);
    // A malformed report is ignored, not a failed heartbeat (older/newer agents).
    expect((await signedPost("/heartbeat", { agentId: agent.peerId, localWeb: { search: "yes" } })).statusCode).toBe(200);
    // Claiming SearXNG gives nothing without ownership: no basis, no local search.
    const st = await signedPost("/v1/tools/web/status", { ownMachine: true });
    expect(st.json()).not.toHaveProperty("localSearch");
    expect(st.json().configured).toBe(false);
  });

  test("local web results: only the agent itself, only a command this coordinator sent it", async () => {
    const url = `/agent-control/agents/${encodeURIComponent(agent.peerId)}/web/result`;
    const result = { commandId: "00000000-0000-4000-8000-000000000000", status: "done", results: [] };
    const unsigned = await app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json" }, payload: JSON.stringify(result) });
    expect(unsigned.statusCode).toBe(401);
    const unknown = await signedPost(url, result);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ ok: false, error: "unknown_command" });
    const malformed = await signedPost(url, { ...result, extra: 1 });
    expect(malformed.statusCode).toBe(400);
    const other = createPeerKeys("agent-web-tool-other");
    const forged = await signedPost(`/agent-control/agents/${encodeURIComponent(other.peerId)}/web/result`, result);
    expect(forged.statusCode).toBe(403);
  });

  test("anyone else is refused", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/tools/web/search", remoteAddress: REMOTE, headers: { "content-type": "application/json" }, payload: JSON.stringify({ query: "x" }) });
    expect(res.statusCode).toBe(401);
  });
});
