import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * /register authentication against the real coordinator app (Fastify inject):
 * - a re-registration that changes an agent's key needs a portal-validated registration token;
 * - without a token, only a request signed by the already-registered key (and keeping it) passes;
 * - the loopback self-registration exemption comes from the socket, never from IP headers.
 */

const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.9";
let portal: Server;
let app: any;

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
  process.env.MESH_AUTH_TOKEN = "mesh-secret-test";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

const base = { os: "macos", version: "1", mode: "swarm-only" };

function register(
  agentId: string,
  opts: { key?: PeerKeys; publicKeyPem?: string; signWith?: PeerKeys; token?: string; remoteAddress?: string; headers?: Record<string, string> }
) {
  const payload = JSON.stringify({
    ...base,
    agentId,
    ...(opts.token ? { registrationToken: opts.token } : {}),
    publicKeyPem: opts.publicKeyPem ?? opts.key?.publicKeyPem
  });
  const signed = opts.signWith
    ? (signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: opts.signWith.privateKeyPem, agentId }) as unknown as Record<string, string>)
    : {};
  return app.inject({
    method: "POST",
    url: "/register",
    remoteAddress: opts.remoteAddress ?? REMOTE,
    headers: { "content-type": "application/json", ...(opts.headers ?? {}), ...signed },
    payload
  });
}

/** A signed heartbeat: 401 means the coordinator does not hold this key for the agent. */
function heartbeat(agentId: string, keys: PeerKeys) {
  const payload = JSON.stringify({ agentId });
  const signed = signRequest({ method: "POST", path: "/heartbeat", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId }) as unknown as Record<string, string>;
  return app.inject({
    method: "POST",
    url: "/heartbeat",
    remoteAddress: REMOTE,
    headers: { "content-type": "application/json", "x-mesh-token": "mesh-secret-test", ...signed },
    payload
  });
}

describe("/register key ownership", () => {
  test("tokenless re-register of a known agent with a different key is rejected and the stored key is unchanged", async () => {
    const victim = createPeerKeys("agent-c1-a");
    const other = createPeerKeys("agent-c1-a");
    expect((await register("agent-c1-a", { key: victim, token: VALID_TOKEN, signWith: victim })).statusCode).toBe(200);

    const unsigned = await register("agent-c1-a", { key: other });
    expect(unsigned.statusCode).toBe(403);
    expect(unsigned.json().meshToken).toBeUndefined();
    // Signed by the new key, or signed by the registered key while swapping in a new one: still no.
    expect((await register("agent-c1-a", { key: other, signWith: other })).statusCode).toBe(403);
    expect((await register("agent-c1-a", { publicKeyPem: other.publicKeyPem, signWith: victim })).statusCode).toBe(403);
    // An invalid token is no better than none.
    expect((await register("agent-c1-a", { key: other, token: "wrong", signWith: other })).statusCode).toBe(403);

    expect((await heartbeat("agent-c1-a", other)).statusCode).toBe(401);
    expect((await heartbeat("agent-c1-a", victim)).statusCode).not.toBe(401);
  });

  test("signed re-register with the same key and no token is accepted", async () => {
    const keys = createPeerKeys("agent-c1-b");
    expect((await register("agent-c1-b", { key: keys, token: VALID_TOKEN, signWith: keys })).statusCode).toBe(200);
    const res = await register("agent-c1-b", { key: keys, signWith: keys });
    expect(res.statusCode).toBe(200);
    expect(res.json().meshToken).toBe("mesh-secret-test");
  });

  test("re-register with a valid token and a new key is accepted and rotates the key", async () => {
    const oldKey = createPeerKeys("agent-c1-c");
    const newKey = createPeerKeys("agent-c1-c");
    expect((await register("agent-c1-c", { key: oldKey, token: VALID_TOKEN, signWith: oldKey })).statusCode).toBe(200);
    expect((await register("agent-c1-c", { key: newKey, token: VALID_TOKEN, signWith: newKey })).statusCode).toBe(200);
    expect((await heartbeat("agent-c1-c", oldKey)).statusCode).toBe(401);
    expect((await heartbeat("agent-c1-c", newKey)).statusCode).not.toBe(401);
    // The rotated key is now the one that proves ownership.
    expect((await register("agent-c1-c", { key: newKey, signWith: newKey })).statusCode).toBe(200);
    expect((await register("agent-c1-c", { key: oldKey, signWith: oldKey })).statusCode).toBe(403);
  });

  test("an unknown agent without a token is rejected", async () => {
    const keys = createPeerKeys("agent-c1-d");
    expect((await register("agent-c1-d", { key: keys, signWith: keys })).statusCode).toBe(403);
  });
});

describe("/register loopback exemption", () => {
  const spoofs: Array<[string, Record<string, string>]> = [
    ["x-real-ip", { "x-real-ip": "127.0.0.1" }],
    ["x-forwarded-for", { "x-forwarded-for": "127.0.0.1" }],
    ["fly-client-ip", { "fly-client-ip": "127.0.0.1" }],
    ["all of them", { "x-real-ip": "::1", "x-forwarded-for": "127.0.0.1, ::1", "fly-client-ip": "127.0.0.1", "cf-connecting-ip": "127.0.0.1", "true-client-ip": "127.0.0.1" }]
  ];
  test.each(spoofs)("a spoofed %s from a non-loopback socket is not loopback", async (_name, headers) => {
    const keys = createPeerKeys();
    const res = await register(`agent-h1-${keys.peerId}`, { key: keys, signWith: keys, headers });
    expect(res.statusCode).toBe(403);
    expect(res.json().meshToken).toBeUndefined();
  });

  test("a spoofed header cannot re-key a known agent either", async () => {
    const victim = createPeerKeys("agent-h1-known");
    const other = createPeerKeys("agent-h1-known");
    expect((await register("agent-h1-known", { key: victim, token: VALID_TOKEN, signWith: victim })).statusCode).toBe(200);
    expect((await register("agent-h1-known", { key: other, signWith: other, headers: { "x-real-ip": "127.0.0.1" } })).statusCode).toBe(403);
    expect((await heartbeat("agent-h1-known", victim)).statusCode).not.toBe(401);
  });

  test("a real loopback socket (embedded worker) registers without a token", async () => {
    const keys = createPeerKeys("agent-h1-local");
    const v4 = await register("agent-h1-local", { key: keys, signWith: keys, remoteAddress: "127.0.0.1" });
    expect(v4.statusCode).toBe(200);
    expect(v4.json().meshToken).toBe("mesh-secret-test");
    // The bundled worker restarts with a fresh key; loopback may still register it.
    const restarted = createPeerKeys("agent-h1-local");
    expect((await register("agent-h1-local", { key: restarted, signWith: restarted, remoteAddress: "::1" })).statusCode).toBe(200);
  });
});
