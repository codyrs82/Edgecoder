import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { signMeshWsBind } from "../../src/mesh/ws-auth.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { isAgentNotRegisteredError } from "../../src/swarm/registration-policy.js";

/*
 * Production, 2026-11-24: after a coordinator redeploy (in-memory agent state lost) the desktop
 * agent's mesh WebSocket came back about a second after the old process went away, before the
 * agent noticed it had to register again; the coordinator could not check that bind (no key on
 * file) and the machine stayed "offline" on the web although its socket was open. The request
 * gate also refused the agent's signed /pull and /heartbeat with a bare mesh_unauthorized, so the
 * agent counted failures into offline mode before registering. Through the real coordinator app:
 */

const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.77";
let portal: Server;
let app: any;
let caps: Map<string, unknown>;
let connected: (agentId: string) => boolean;
const sockets: any[] = [];

function signedPost(keys: PeerKeys, url: string, body: unknown) {
  const payload = JSON.stringify(body);
  const headers = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", ...headers }, payload });
}
const register = (k: PeerKeys) => signedPost(k, "/register", { os: "macos", version: "1", mode: "swarm-only", agentId: k.peerId, registrationToken: VALID_TOKEN, publicKeyPem: k.publicKeyPem });
async function openWs(k: PeerKeys, signer: PeerKeys = k) {
  const ws = await app.injectWS(`/mesh/ws?peerId=${k.peerId}`, { headers: signMeshWsBind(k.peerId, signer.privateKeyPem) });
  const state = { closed: null as null | { code: number; reason: string } };
  ws.on("close", (code: number, reason: Buffer) => (state.closed = { code, reason: reason.toString() }));
  sockets.push(ws);
  return { ws, state };
}
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return cond();
};
/** What the agent's post() throws for a non-2xx answer (worker-runner.ts). */
const agentError = (path: string, res: any) => Object.assign(new Error(`POST ${path} failed (${res.statusCode}): ${res.body}`), { statusCode: res.statusCode });

beforeAll(async () => {
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body.registrationToken === VALID_TOKEN ? { allowed: true, reason: "portal_validated", node: {} } : { allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((r) => portal.listen(0, "127.0.0.1", r));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.PORTAL_SERVICE_TOKEN = "p".repeat(40);
  process.env.MESH_AUTH_TOKEN = "mesh-secret-reconnect";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  ({ agentCapabilities: caps } = (await import("../../src/swarm/coordinator/agent-state.js")) as any);
  ({ agentControlConnected: connected } = await import("../../src/swarm/coordinator/model-control.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await app?.close();
  await new Promise<void>((r) => portal.close(() => r()));
});

describe("a mesh socket that connects before the agent registers", () => {
  test("is held, then counts as connected as soon as the agent registers", async () => {
    const k = createPeerKeys("agent-reconnect-early");
    const { state } = await openWs(k);
    await new Promise((r) => setTimeout(r, 100));
    expect(state.closed).toBeNull();
    expect(connected(k.peerId)).toBe(false);
    expect((await register(k)).statusCode).toBe(200);
    expect(await until(() => connected(k.peerId))).toBe(true);
    expect(state.closed).toBeNull();
  });

  test("a socket bound with another key is closed when the real key registers", async () => {
    const k = createPeerKeys("agent-reconnect-victim");
    const mallory = createPeerKeys("agent-reconnect-mallory");
    const { state } = await openWs(k, mallory);
    expect((await register(k)).statusCode).toBe(200);
    expect(await until(() => state.closed !== null)).toBe(true);
    expect(state.closed!.code).toBe(4003);
    expect(connected(k.peerId)).toBe(false);
  });

  test("an unsigned socket from an unregistered agent is still refused", async () => {
    const k = createPeerKeys("agent-reconnect-unsigned");
    const ws = await app.injectWS(`/mesh/ws?peerId=${k.peerId}`);
    sockets.push(ws);
    const closed = await new Promise<number>((r) => ws.on("close", (code: number) => r(code)));
    expect(closed).toBe(4001);
  });
});

describe("coordinator restart: fresh state, agent with an old registration", () => {
  test("the agent is told it is not registered, and is connected again within one cycle", async () => {
    const k = createPeerKeys("agent-reconnect-restart");
    expect((await register(k)).statusCode).toBe(200);
    const first = await openWs(k);
    expect(await until(() => connected(k.peerId))).toBe(true);

    // Restart: the process forgets every agent and every socket.
    caps.delete(k.peerId);
    first.ws.terminate();
    expect(await until(() => first.state.closed !== null)).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(connected(k.peerId)).toBe(false);

    // ~1 s later the agent's socket is back, before the HTTP loop has noticed anything.
    const again = await openWs(k);
    await new Promise((r) => setTimeout(r, 100));
    expect(again.state.closed).toBeNull();
    expect(connected(k.peerId)).toBe(false);

    // Its next signed heartbeat/pull is refused with a reason the agent acts on at once.
    for (const path of ["/heartbeat", "/pull"]) {
      const res = await signedPost(k, path, { agentId: k.peerId });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: "mesh_unauthorized", reason: "agent_not_registered" });
      expect(isAgentNotRegisteredError(agentError(path, res))).toBe(true);
    }

    // It registers again: the socket it already has is now the machine's authenticated connection.
    expect((await register(k)).statusCode).toBe(200);
    expect(await until(() => connected(k.peerId))).toBe(true);
    expect(again.state.closed).toBeNull();
    expect((await signedPost(k, "/heartbeat", { agentId: k.peerId })).statusCode).toBe(200);
  });

  test("an unsigned request to an agent route still gets the bare refusal", async () => {
    const res = await app.inject({ method: "POST", url: "/pull", remoteAddress: REMOTE, headers: { "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "mesh_unauthorized" });
  });
});
