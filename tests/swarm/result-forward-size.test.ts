import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { buildAgentEnvelope } from "../../src/mesh/forwarded-agent-envelope.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { AGENT_RESULT_BODY_LIMIT_BYTES, RESULT_ROUTE_BODY_LIMIT_BYTES, resultBodyTooLarge } from "../../src/swarm/result-integrity.js";

/*
 * #122: a peer forward carries the output twice (plaintext + the agent's signed body), so /result
 * accepts a forwarded max-size agent result, while agents themselves keep the 1 MiB limit.
 * Real coordinator app (Fastify inject), mesh-token forwards without an allowlist (non-prod).
 */

const MESH = "mesh-secret-size";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.30";
const agent = createPeerKeys("agent-size-a");
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
  process.env.MESH_AUTH_TOKEN = MESH;
  // The agent envelope is mandatory here, so an accepted forward was checked against the agent's signature.
  process.env.MESH_REQUIRE_AGENT_SIGNED_RESULTS = "true";
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  const payload = JSON.stringify({ os: "macos", version: "1", mode: "swarm-only", agentId: agent.peerId, registrationToken: VALID_TOKEN, publicKeyPem: agent.publicKeyPem });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: agent.privateKeyPem, agentId: agent.peerId }) as unknown as Record<string, string>;
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
  expect(res.statusCode).toBe(200);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  delete process.env.MESH_REQUIRE_AGENT_SIGNED_RESULTS;
});

/** An agent result whose JSON body is just under `bytes`, with an output heavy in characters JSON escapes. */
function agentResult(subtaskId: string, bytes: number) {
  const base = { subtaskId, taskId: `task-${subtaskId}`, agentId: agent.peerId, ok: true, output: "", durationMs: 5 };
  const unit = 'print("a\\\\b")\n'; // quotes, backslashes and newlines: each grows when re-escaped
  const room = bytes - Buffer.byteLength(JSON.stringify(base)) - 64;
  let output = unit.repeat(Math.floor(room / Buffer.byteLength(JSON.stringify(unit).slice(1, -1))));
  const raw = () => JSON.stringify({ ...base, output });
  while (Buffer.byteLength(raw()) > bytes) output = output.slice(0, -1);
  const body = raw();
  const headers = signRequest({ method: "POST", path: "/result", bodyHash: hashRequestBody(body), privateKeyPem: agent.privateKeyPem, agentId: agent.peerId });
  return { result: { ...base, output }, body, headers };
}

describe("/result body size", () => {
  test("a forward of a near-1 MiB agent result is accepted and checked against the agent signature", async () => {
    const { result, body, headers } = agentResult("sub-size-forward", AGENT_RESULT_BODY_LIMIT_BYTES - 16);
    const forward = JSON.stringify({ ...result, agentEnvelope: buildAgentEnvelope(headers, body) });
    expect(Buffer.byteLength(forward)).toBeGreaterThan(2 * AGENT_RESULT_BODY_LIMIT_BYTES);
    expect(Buffer.byteLength(forward)).toBeLessThan(RESULT_ROUTE_BODY_LIMIT_BYTES);
    const res = await app.inject({ method: "POST", url: "/result", remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH }, payload: forward });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  test("a forward whose output differs from what the agent signed is refused", async () => {
    const { result, body, headers } = agentResult("sub-size-tampered", 64 * 1024);
    const forward = JSON.stringify({ ...result, output: "forged", agentEnvelope: buildAgentEnvelope(headers, body) });
    const res = await app.inject({ method: "POST", url: "/result", remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH }, payload: forward });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "agent_envelope_result_mismatch" });
  });

  test("an agent posting more than 1 MiB directly is still refused", async () => {
    const { body, headers } = agentResult("sub-size-direct", AGENT_RESULT_BODY_LIMIT_BYTES + 64 * 1024);
    const res = await app.inject({ method: "POST", url: "/result", remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...headers }, payload: body });
    expect(res.statusCode).toBe(413);
  });

  test("the larger limit is only for unsigned mesh-token requests", () => {
    expect(resultBodyTooLarge(AGENT_RESULT_BODY_LIMIT_BYTES + 1, false)).toBe(true);
    expect(resultBodyTooLarge(AGENT_RESULT_BODY_LIMIT_BYTES, false)).toBe(false);
    expect(resultBodyTooLarge(3 * AGENT_RESULT_BODY_LIMIT_BYTES, true)).toBe(false);
    expect(resultBodyTooLarge(RESULT_ROUTE_BODY_LIMIT_BYTES + 1, true)).toBe(true);
  });
});
