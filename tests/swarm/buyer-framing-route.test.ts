import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * Buyer framing through BHV004 (success collapse), against the real coordinator app: a buyer whose
 * code jobs exit non-zero (`import sys; sys.exit(1)`) must not get the honest workers that ran them
 * struck or blacklisted. A program error the agent ran is a correctly executed (and paid) job; an
 * older agent's failures count, but at most BEHAVIOR_SUBMITTER_FAILURE_CAP per submitter.
 */

const VALID_TOKEN = "valid-registration-token";
const MESH = "mesh-secret-framing";
const T0 = 1_960_000_000_000;

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
    subtasks: [{ taskId: body.taskId, kind: "single_step", input: "import sys; sys.exit(1)", language: "python", timeoutMs: 3_600_000, snapshotRef: body.snapshotRef }]
  }));
  Object.assign(process.env, {
    PORTAL_SERVICE_URL: urlOf(portal),
    INFERENCE_URL: urlOf(inference),
    MESH_AUTH_TOKEN: MESH,
    REQUIRE_SIGNED_AGENT_REQUESTS: "false",
    RESULT_VERIFICATION_RATE: "0",
    CLAIM_LEASE_LIVENESS_MS: "86400000",
    CLAIM_MAX_TIMEOUT_MS: "86400000"
  });
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.DATABASE_URL;
  delete process.env.BEHAVIOR_SUBMITTER_FAILURE_CAP;
  credits = await import("../../src/credits/store.js");
  app = (await import("../../src/swarm/coordinator.js")).coordinatorServer;
  await app.ready();
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
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: "203.0.113.29", headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
  expect(res.statusCode, res.body).toBe(200);
}

const post = (url: string, body: unknown) =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/json", "x-mesh-token": MESH }, payload: JSON.stringify(body) });

const funded = new Set<string>();
let seq = 0;
/**
 * One job from `buyer`, claimed by `agentId`, `serverMs` on the coordinator's clock (jittered: equal
 * durations trip BHV009), reported failed.
 */
async function failOne(agentId: string, buyer: string, report: Record<string, unknown>, serverMs = 2_000 + ((seq * 337) % 1_500)) {
  if (!funded.has(buyer)) {
    await credits.grantCredits(buyer, 10_000, "test_funding");
    funded.add(buyer);
  }
  const taskId = `task-framing-${agentId}-${seq++}`;
  const submit = await post("/submit", { taskId, prompt: "exit with status 1", snapshotRef: "d".repeat(40), submitterAccountId: buyer });
  expect(submit.statusCode, submit.body).toBe(200);
  // A job left queued by an earlier test (its agent got blocked) may come first: claim past it.
  let pulled: any;
  let st: { id: string; taskId: string } | null = null;
  for (let i = 0; i < 5 && st?.taskId !== taskId; i++) {
    pulled = await post("/pull", { agentId });
    st = pulled.json().subtask ?? null;
    if (!st) break;
  }
  if (!st) return { blocked: pulled.json().blocked === true, status: 0 };
  expect(st.taskId).toBe(taskId);
  vi.setSystemTime(Date.now() + serverMs);
  const res = await post("/result", { subtaskId: st.id, taskId: st.taskId, agentId, ok: false, output: "", error: "Traceback ...", durationMs: serverMs, ...report });
  vi.setSystemTime(Date.now() + 1_000);
  return { blocked: false, status: res.statusCode };
}

const programError = { executed: true, exitCode: 1, programError: "exit_nonzero" };
const blocked = async (agentId: string) => (await post("/pull", { agentId })).json().blocked === true;

describe("a buyer cannot frame honest workers through failing programs (BHV004)", () => {
  test("an agent reporting program errors is not struck, and is paid for running them", async () => {
    await register("framed-new");
    for (let i = 0; i < 15; i++) expect((await failOne("framed-new", "acct-framer-1", programError)).status).toBe(200);
    expect(await blocked("framed-new")).toBe(false);
    expect(await credits.earnedMsat("framed-new")).toBeGreaterThan(0);
  });

  test("an older agent (no executed field): one buyer's failures count at most the cap", async () => {
    await register("framed-legacy");
    for (let i = 0; i < 15; i++) expect((await failOne("framed-legacy", "acct-framer-2", {})).status).toBe(200);
    expect(await blocked("framed-legacy")).toBe(false);
    // Failures of an older agent are not paid, as before.
    expect(await credits.earnedMsat("framed-legacy")).toBe(0);
  });

  test("a broken agent failing many submitters' jobs is still caught", async () => {
    await register("broken-agent");
    let wasBlocked = false;
    for (let i = 0; i < 15 && !wasBlocked; i++) {
      const r = await failOne("broken-agent", `acct-buyer-${i}`, { executed: false });
      wasBlocked = r.blocked || r.status === 403;
    }
    expect(wasBlocked || (await blocked("broken-agent"))).toBe(true);
  });

  test("a program error claimed faster than an honest run is the agent's failure, and unpaid", async () => {
    await register("fake-failer");
    for (let i = 0; i < 3; i++) expect((await failOne("fake-failer", `acct-fast-${i}`, programError, 50)).status).toBe(200);
    expect(await credits.earnedMsat("fake-failer")).toBe(0);
  });
});
