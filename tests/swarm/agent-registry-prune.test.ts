import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * Stress finding 5: agentCapabilities was never pruned (/metrics edgecoder_connected_agents said 233
 * with 40 live agents). Stale entries are dropped after the retention window, except agents someone
 * still needs (a reservation), the connected gauge counts recently seen agents only, and a dropped
 * agent re-registers and works as after a restart.
 */

const MESH = "mesh-secret-prune";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.70";
let portal: Server;
let app: any;
let state: typeof import("../../src/swarm/coordinator/agent-state.js");
const live = createPeerKeys("agent-prune-live");
const stale = createPeerKeys("agent-prune-stale");
const kept = createPeerKeys("agent-prune-kept");

function register(keys: PeerKeys) {
  const payload = JSON.stringify({ os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem, sandboxMode: "docker" });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
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
  process.env.METRICS_TOKEN = "metrics-secret-prune";
  delete process.env.MESH_PEER_ALLOWLIST;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  state = await import("../../src/swarm/coordinator/agent-state.js");
  for (const k of [live, stale, kept]) expect((await register(k)).statusCode).toBe(200);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  delete process.env.METRICS_TOKEN;
});

describe("agent registry pruning", () => {
  test("stale entries leave the registry, kept and live ones stay; the connected count is the live ones", () => {
    const now = Date.now();
    state.agentCapabilities.get(stale.peerId)!.lastSeenMs = now - 2 * 3_600_000;
    state.agentCapabilities.get(kept.peerId)!.lastSeenMs = now - 2 * 3_600_000;
    expect(state.connectedAgentCount(now)).toBe(state.agentCapabilities.size - 2);
    const dropped = state.pruneStaleAgentCapabilities(now, 3_600_000, (id) => id === kept.peerId);
    expect(dropped).toEqual([stale.peerId]);
    expect(state.agentCapabilities.has(stale.peerId)).toBe(false);
    expect(state.agentCapabilities.has(kept.peerId)).toBe(true);
    expect(state.agentCapabilities.has(live.peerId)).toBe(true);
  });

  test("/metrics: connected counts recently seen agents, known counts the registry", async () => {
    const res = await app.inject({ method: "GET", url: "/metrics", remoteAddress: REMOTE, headers: { authorization: "Bearer metrics-secret-prune" } });
    expect(res.statusCode).toBe(200);
    const connected = Number(/^edgecoder_connected_agents\{[^}]*\} (\d+)$/m.exec(res.body)?.[1]);
    const known = Number(/^edgecoder_known_agents\{[^}]*\} (\d+)$/m.exec(res.body)?.[1]);
    expect(known).toBe(state.agentCapabilities.size);
    expect(connected).toBe(state.connectedAgentCount());
    expect(connected).toBeLessThan(known);
  });

  test("a pruned agent re-registers and can pull work again", async () => {
    expect((await register(stale)).statusCode).toBe(200);
    expect(state.agentCapabilities.has(stale.peerId)).toBe(true);
    const payload = JSON.stringify({ agentId: stale.peerId });
    const signed = signRequest({ method: "POST", path: "/pull", bodyHash: hashRequestBody(payload), privateKeyPem: stale.privateKeyPem, agentId: stale.peerId }) as unknown as Record<string, string>;
    const pull = await app.inject({ method: "POST", url: "/pull", remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
    expect(pull.statusCode).toBe(200);
  });
});
