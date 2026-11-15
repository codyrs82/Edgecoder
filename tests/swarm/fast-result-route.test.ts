import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * BHV001 ("suspiciously fast") against the real coordinator app (Fastify inject): speed is judged
 * by the coordinator's clock (claim to result receipt), never by the duration the agent reports,
 * and being fast sends the agent's results to verification instead of blacklisting it.
 */

const VALID_TOKEN = "valid-registration-token";
const MESH = "mesh-secret-fast";
const T0 = 1_950_000_000_000;

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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  portal = await stub((url, body) =>
    url === "/internal/nodes/validate" && body.registrationToken === VALID_TOKEN
      ? { allowed: true, reason: "portal_validated", node: {} }
      : { allowed: false, reason: "invalid_token" }
  );
  inference = await stub((_url, body) => ({
    subtasks: [{ taskId: body.taskId, kind: "single_step", input: "print(6*7)", language: "python", timeoutMs: 3_600_000, snapshotRef: body.snapshotRef }]
  }));
  Object.assign(process.env, {
    PORTAL_SERVICE_URL: urlOf(portal),
    INFERENCE_URL: urlOf(inference),
    MESH_AUTH_TOKEN: MESH,
    REQUIRE_SIGNED_AGENT_REQUESTS: "false",
    // Verification on, but sampled so rarely that only a BHV001 flag sends a result to it.
    RESULT_VERIFICATION_RATE: "0.000001",
    CLAIM_LEASE_LIVENESS_MS: "86400000",
    CLAIM_MAX_TIMEOUT_MS: "86400000"
  });
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.DATABASE_URL;
  credits = await import("../../src/credits/store.js");
  app = (await import("../../src/swarm/coordinator.js")).coordinatorServer;
  await app.ready();
  await credits.grantCredits("acct-fast-requester", 10_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  await new Promise<void>((resolve) => inference.close(() => resolve()));
  vi.useRealTimers();
});

async function register(agentId: string) {
  const keys = createPeerKeys(agentId);
  const payload = JSON.stringify({ agentId, os: "linux", version: "1", mode: "swarm-only", registrationToken: VALID_TOKEN, sandboxMode: "docker", publicKeyPem: keys.publicKeyPem });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId }) as unknown as Record<string, string>;
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: "203.0.113.19", headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
  expect(res.statusCode, res.body).toBe(200);
}

const post = (url: string, body: unknown) =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/json", "x-mesh-token": MESH }, payload: JSON.stringify(body) });

let seq = 0;
/** Submit one task, let `agentId` claim it, wait `serverMs` on the coordinator's clock, report `reportedMs`. */
async function runOne(agentId: string, serverMs: number, reportedMs: number) {
  const taskId = `task-fast-${agentId}-${seq++}`;
  const submit = await post("/submit", { taskId, prompt: "compute 6*7", snapshotRef: "c".repeat(40), submitterAccountId: "acct-fast-requester" });
  expect(submit.statusCode, submit.body).toBe(200);
  // Verification replicas of earlier agents' results may come first: claim past them.
  let st: { id: string; taskId: string } | null = null;
  for (let i = 0; i < 20 && st?.taskId !== taskId; i++) st = (await post("/pull", { agentId })).json().subtask ?? null;
  expect(st?.taskId).toBe(taskId);
  if (!st) throw new Error("unreachable");
  vi.setSystemTime(Date.now() + serverMs);
  const res = await post("/result", { subtaskId: st.id, taskId: st.taskId, agentId, ok: true, output: `42 ${taskId}`, durationMs: reportedMs });
  expect(res.statusCode, res.body).toBe(200);
  vi.setSystemTime(Date.now() + 1_000);
  return res.json() as { ok: boolean; held?: boolean };
}

describe("BHV001 suspiciously fast (server-measured, graduated)", () => {
  test("an agent that is fast by the coordinator's clock is flagged for verification, not blacklisted", async () => {
    await register("quick");
    const outcomes = [];
    for (let i = 0; i < 6; i++) outcomes.push(await runOne("quick", 50, 50));
    // The first two are below the flag threshold; from the third on every result is verified.
    expect(outcomes.map((o) => o.held === true)).toEqual([false, false, true, true, true, true]);
    const next = await post("/pull", { agentId: "quick" });
    expect(next.json().blocked).toBeUndefined();
  });

  test("reporting a long duration does not hide a fast result", async () => {
    await register("liar");
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push(await runOne("liar", 20, 5_000));
    expect(outcomes.map((o) => o.held === true)).toEqual([false, false, true, true]);
  });

  test("an agent slow by the coordinator's clock is not flagged, whatever it reports", async () => {
    await register("steady");
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push(await runOne("steady", 2_000, 10));
    expect(outcomes.every((o) => o.held !== true)).toBe(true);
    expect((await post("/pull", { agentId: "steady" })).json().blocked).toBeUndefined();
  });
});
