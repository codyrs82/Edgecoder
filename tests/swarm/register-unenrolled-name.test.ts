import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { enrollmentRefusalFromError } from "../../src/swarm/registration-policy.js";

/*
 * An agent presents its token under a name that isn't enrolled (the installer named it after the
 * host): the coordinator refuses it, tells it the token's node id, and records the attempt under
 * the token owner's email (node_status_projection), never anyone else's.
 */

const REMOTE = "203.0.113.77";
let portal: Server;
let app: any;
let rejectedAttemptTokenNode: typeof import("../../src/swarm/coordinator/enrollment.js").rejectedAttemptTokenNode;
let ordering: { snapshot(): Array<{ eventType: string; taskId: string; payloadJson?: string }> };

beforeAll(async () => {
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(404, { "content-type": "application/json" });
      // tok-patrick is the token of RTXA2000-Laptop (patrick@example.com); any other token is unknown.
      res.end(JSON.stringify(body.registrationToken === "tok-patrick"
        ? { allowed: false, reason: "node_not_enrolled", tokenNode: { nodeId: "RTXA2000-Laptop", ownerEmail: "patrick@example.com" } }
        : { allowed: false, reason: "node_not_enrolled" }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = "mesh-secret-test";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  ({ ordering } = await import("../../src/swarm/coordinator/agent-state.js"));
  ({ rejectedAttemptTokenNode } = await import("../../src/swarm/coordinator/enrollment.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

function register(agentId: string, token: string) {
  const keys = createPeerKeys(agentId);
  const payload = JSON.stringify({ os: "linux", version: "1", mode: "swarm-only", agentId, registrationToken: token, publicKeyPem: keys.publicKeyPem });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
}

function lastValidation(agentId: string): Record<string, unknown> {
  const rec = ordering.snapshot().filter((r) => r.eventType === "node_validation" && r.taskId === `agent:${agentId}`).pop();
  return JSON.parse(rec?.payloadJson ?? "{}");
}

describe("/register under a name its token wasn't enrolled as", () => {
  test("refused with the token's node id; the attempt is recorded for the token's owner", async () => {
    const res = await register("nvidia-1-gpu", "tok-patrick");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "node_not_activated", reason: "node_not_enrolled", tokenNodeId: "RTXA2000-Laptop" });
    expect(lastValidation("nvidia-1-gpu")).toMatchObject({ allowed: false, reason: "node_not_enrolled", ownerEmail: "patrick@example.com" });
    // The agent reads it from the error post() throws.
    const err = Object.assign(new Error(`POST /register failed (403): ${res.body}`), { statusCode: 403 });
    expect(enrollmentRefusalFromError(err)).toEqual({ reason: "node_not_enrolled", tokenNodeId: "RTXA2000-Laptop" });
  });

  test("a token the portal doesn't know names nobody", async () => {
    const res = await register("stranger-gpu", "tok-unknown-123");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "node_not_activated", reason: "node_not_enrolled" });
    expect(lastValidation("stranger-gpu").ownerEmail).toBeNull();
  });

  test("only a well-formed tokenNode is used", () => {
    expect(rejectedAttemptTokenNode({ nodeId: "RTXA2000-Laptop", ownerEmail: "p@example.com" })).toEqual({ nodeId: "RTXA2000-Laptop", ownerEmail: "p@example.com" });
    expect(rejectedAttemptTokenNode({ nodeId: "x y", ownerEmail: "p@example.com" })).toBeUndefined();
    expect(rejectedAttemptTokenNode({ nodeId: "node-1", ownerEmail: "not an email" })).toBeUndefined();
    expect(rejectedAttemptTokenNode(null)).toBeUndefined();
  });
});
