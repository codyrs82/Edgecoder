import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * Found while checking the stress fixes (malicious scenario: 167 tasks each kept ~5.33 cSats): a task
 * whose last result was held for verification was never settled. /result returns early for held
 * results, and settleVerification paid and published but never returned the unused reserve.
 * Real coordinator app (Fastify inject), verification rate 1.
 */

const VALID_TOKEN = "valid-registration-token";
const MESH = "mesh-secret-verify-settle";
let portal: Server;
let inference: Server;
let app: any;
let credits: typeof import("../../src/credits/store.js");

function stub(handler: (url: string, body: any) => unknown): Promise<Server> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(handler(req.url ?? "", raw ? JSON.parse(raw) : {})));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}
const urlOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

beforeAll(async () => {
  portal = await stub((url, body) =>
    url === "/internal/nodes/validate" && body.registrationToken === VALID_TOKEN ? { allowed: true, reason: "portal_validated", node: {} } : { allowed: false, reason: "invalid_token" }
  );
  inference = await stub((_url, body) => ({ subtasks: [{ taskId: body.taskId, kind: "single_step", input: "print(6*7)", language: "python", timeoutMs: 60_000, snapshotRef: body.snapshotRef }] }));
  Object.assign(process.env, {
    PORTAL_SERVICE_URL: urlOf(portal),
    INFERENCE_URL: urlOf(inference),
    MESH_AUTH_TOKEN: MESH,
    REQUIRE_SIGNED_AGENT_REQUESTS: "false",
    RESULT_VERIFICATION_RATE: "1"
  });
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.DATABASE_URL;
  delete process.env.MESH_PEER_ALLOWLIST;
  credits = await import("../../src/credits/store.js");
  app = (await import("../../src/swarm/coordinator.js")).coordinatorServer;
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  await new Promise<void>((resolve) => inference.close(() => resolve()));
  delete process.env.RESULT_VERIFICATION_RATE;
  delete process.env.REQUIRE_SIGNED_AGENT_REQUESTS;
});

async function register(agentId: string) {
  const keys = createPeerKeys(agentId);
  const payload = JSON.stringify({ agentId, os: "linux", version: "1", mode: "swarm-only", registrationToken: VALID_TOKEN, sandboxMode: "docker", publicKeyPem: keys.publicKeyPem });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId }) as unknown as Record<string, string>;
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: "203.0.113.9", headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
  expect(res.statusCode, res.body).toBe(200);
}
const post = (url: string, body: unknown) => app.inject({ method: "POST", url, headers: { "content-type": "application/json", "x-mesh-token": MESH }, payload: JSON.stringify(body) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a verified result settles its task", () => {
  test("after the replica agrees, the requester gets back everything not paid for the work", async () => {
    for (const a of ["vs-orig", "vs-replica"]) await register(a);
    await credits.grantCredits("acct-vs-requester", 1_000, "test_funding");
    const before = credits.creditEngine.balance("acct-vs-requester");
    expect((await post("/submit", { taskId: "task-vs-1", prompt: "compute", snapshotRef: "a".repeat(40), submitterAccountId: "acct-vs-requester" })).statusCode).toBe(200);
    const original = (await post("/pull", { agentId: "vs-orig" })).json().subtask;
    expect(original).toBeTruthy();
    await sleep(1_100);
    expect((await post("/result", { subtaskId: original.id, taskId: original.taskId, agentId: "vs-orig", ok: true, output: "42", durationMs: 1000 })).json()).toMatchObject({ held: true });
    const replica = (await post("/pull", { agentId: "vs-replica" })).json().subtask;
    expect(replica?.id).toContain("::verify:");
    await sleep(1_100);
    expect((await post("/result", { subtaskId: replica.id, taskId: replica.taskId, agentId: "vs-replica", ok: true, output: "42", durationMs: 1000 })).statusCode).toBe(200);
    await sleep(50);
    const paidMsat = (await credits.earnedMsat("vs-orig")) + (await credits.earnedMsat("vs-replica")) + (await credits.earnedMsat(credits.NETWORK_FEE_POOL_ACCOUNT));
    const spentMsat = Math.round((before - credits.creditEngine.balance("acct-vs-requester")) * 1000);
    // The requester is down exactly what was paid for the work (agent + fee), not the reserve.
    expect(spentMsat).toBe(paidMsat);
  }, 20_000);
});
