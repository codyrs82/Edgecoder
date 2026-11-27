import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { SELF_AGENT_HEADER, SELF_AGENT_SECRET } from "../../src/swarm/self-agent-secret.js";

/*
 * A coordinator behind a reverse proxy on the same machine (the Linux guide's Caddy) sees every
 * request from 127.0.0.1. A request that carries proxy headers is therefore never loopback / self,
 * whether or not COORDINATOR_TRUST_PROXY is set. In production, loopback self-registration also
 * needs the embedded worker's per-process secret (or the operator's opt-in).
 */

const VALID_TOKEN = "valid-registration-token";
const MESH = "mesh-secret-test";
let portal: Server;
let app: any;
const savedNodeEnv = process.env.NODE_ENV;

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
  process.env.PORTAL_SERVICE_TOKEN = "portal-service-test";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.COORDINATOR_LOOPBACK_SELF_REGISTRATION;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
}, 60_000);

afterEach(() => {
  process.env.NODE_ENV = savedNodeEnv;
});

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

function register(agentId: string, keys: PeerKeys, opts: { remoteAddress: string; headers?: Record<string, string>; token?: string }) {
  const payload = JSON.stringify({
    os: "linux",
    version: "1",
    mode: "swarm-only",
    agentId,
    publicKeyPem: keys.publicKeyPem,
    ...(opts.token ? { registrationToken: opts.token } : {})
  });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId }) as unknown as Record<string, string>;
  return app.inject({
    method: "POST",
    url: "/register",
    remoteAddress: opts.remoteAddress,
    headers: { "content-type": "application/json", ...(opts.headers ?? {}), ...signed },
    payload
  });
}

const relayed: Array<[string, Record<string, string>]> = [
  ["x-forwarded-for", { "x-forwarded-for": "198.51.100.7" }],
  ["forwarded", { forwarded: "for=198.51.100.7;proto=https" }],
  ["x-real-ip", { "x-real-ip": "198.51.100.7" }],
  ["via", { via: "1.1 Caddy" }],
  ["x-forwarded-for naming loopback", { "x-forwarded-for": "127.0.0.1" }]
];

describe("a loopback socket relaying a proxy's caller is not self", () => {
  test.each(relayed)("%s on a 127.0.0.1 socket needs a portal token", async (_name, headers) => {
    const keys = createPeerKeys();
    const res = await register(`agent-px-${keys.peerId}`, keys, { remoteAddress: "127.0.0.1", headers });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "node_not_activated", reason: "registration_token_required" });
  });

  test("the same relayed agent registers with a valid portal token", async () => {
    const keys = createPeerKeys("agent-px-token");
    const res = await register("agent-px-token", keys, { remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": "198.51.100.7" }, token: VALID_TOKEN });
    expect(res.statusCode).toBe(200);
  });

  test("the self-agent secret does not help a relayed request", async () => {
    process.env.NODE_ENV = "production";
    const keys = createPeerKeys("agent-px-relayed-secret");
    const res = await register("agent-px-relayed-secret", keys, {
      remoteAddress: "127.0.0.1",
      headers: { via: "1.1 Caddy", [SELF_AGENT_HEADER]: SELF_AGENT_SECRET }
    });
    expect(res.statusCode).toBe(403);
  });

  test("a co-located agent without proxy headers still self-registers outside production", async () => {
    const keys = createPeerKeys("agent-px-local");
    expect((await register("agent-px-local", keys, { remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
  });
});

describe("production: loopback self-registration needs the embedded worker's secret", () => {
  test("a plain loopback caller is sent to the portal", async () => {
    process.env.NODE_ENV = "production";
    const keys = createPeerKeys("agent-px-prod-plain");
    const res = await register("agent-px-prod-plain", keys, { remoteAddress: "127.0.0.1" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: "registration_token_required" });
  });

  test("the embedded worker (secret, loopback, no proxy headers) registers", async () => {
    process.env.NODE_ENV = "production";
    const keys = createPeerKeys("agent-px-prod-self");
    const res = await register("agent-px-prod-self", keys, { remoteAddress: "127.0.0.1", headers: { [SELF_AGENT_HEADER]: SELF_AGENT_SECRET } });
    expect(res.statusCode).toBe(200);
  });

  test("a wrong secret does not", async () => {
    process.env.NODE_ENV = "production";
    const keys = createPeerKeys("agent-px-prod-wrong");
    const res = await register("agent-px-prod-wrong", keys, { remoteAddress: "::1", headers: { [SELF_AGENT_HEADER]: "x".repeat(SELF_AGENT_SECRET.length) } });
    expect(res.statusCode).toBe(403);
  });
});

describe("submitter account: a relayed loopback request is not the coordinator's own caller", () => {
  const task = (taskId: string) => ({ taskId, prompt: "print(1)", snapshotRef: "a".repeat(40), submitterAccountId: "acct-px-victim" });

  test("unsigned, relayed from 127.0.0.1: may not name an account", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/submit",
      remoteAddress: "127.0.0.1",
      headers: { "content-type": "application/json", "x-mesh-token": MESH, "x-forwarded-for": "198.51.100.7" },
      payload: task("task-px-relayed")
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "submitter_signature_required" });
  });

  test("unsigned, direct from 127.0.0.1: still the coordinator's own caller", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/submit",
      remoteAddress: "127.0.0.1",
      headers: { "content-type": "application/json", "x-mesh-token": MESH },
      payload: task("task-px-direct")
    });
    expect(res.json()?.error).not.toBe("submitter_signature_required");
  });
});
