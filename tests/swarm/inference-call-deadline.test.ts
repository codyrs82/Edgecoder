import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";

/*
 * Run 4 (real coordinator app):
 * - a holder still sending when its claim reaches the hard deadline (claim + timeout + grace) ran out
 *   its time; the requester is told "timed out after N s" (a non-streamed reply then returns the
 *   part it got, inference-api/routes.ts), not agent_lost_mid_reply;
 * - a call re-run after its agent was lost gets a fresh timeout, capped at submit + timeout +
 *   INFERENCE_RERUN_BUDGET_MS.
 */

const MESH = "mesh-secret-call-deadline";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.49";
const MODEL = "qwen-deadline:7b";
const RERUN_BUDGET_MS = 2_000;
const CLAIM_TIMEOUT_MS = 1_500;
const LIVENESS_MS = 1_000;
let portal: Server;
let app: any;
const requester = createPeerKeys("agent-deadline-requester");
const worker = createPeerKeys("agent-deadline-worker");
const worker2 = createPeerKeys("agent-deadline-worker2");

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
  // Run 5 prior speed off: these calls are judged on measured samples only (start-eta.ts; the prior has its own tests).
  process.env.INFERENCE_COMPLETION_PRIOR_SPEED = "off";
  process.env.INFERENCE_CLAIM_TIMEOUT_MS = String(CLAIM_TIMEOUT_MS);
  process.env.CLAIM_LEASE_LIVENESS_MS = String(LIVENESS_MS);
  process.env.CLAIM_LEASE_GRACE_MS = "0";
  process.env.INFERENCE_RERUN_BUDGET_MS = String(RERUN_BUDGET_MS);
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  for (const keys of [requester, worker, worker2]) {
    const payload = JSON.stringify({
      os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
      sandboxMode: "docker", installedModels: keys === requester ? [] : [MODEL],
    });
    const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
    const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
    expect(res.statusCode).toBe(200);
  }
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  delete process.env.INFERENCE_CLAIM_TIMEOUT_MS;
  delete process.env.CLAIM_LEASE_LIVENESS_MS;
  delete process.env.CLAIM_LEASE_GRACE_MS;
  delete process.env.INFERENCE_RERUN_BUDGET_MS;
});

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const submit = (taskId: string, timeoutMs: number) =>
  post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: "hi" }], timeoutMs }, requester);

const stream = (taskId: string, subtaskId: string, after = 0, waitMs = 0) => post("/inference/stream", { taskId, subtaskId, after, waitMs }, requester);

async function claimed(timeoutMs: number): Promise<{ taskId: string; subtaskId: string; atMs: number }> {
  const taskId = `inf-${randomUUID()}`;
  const atMs = Date.now();
  const sub = await submit(taskId, timeoutMs);
  expect(sub.statusCode, sub.body).toBe(200);
  const subtaskId = sub.json().subtaskId;
  const pulled = await post("/pull", { agentId: worker.peerId }, worker);
  expect(pulled.json().subtask?.id ?? pulled.json().envelope?.subtaskId).toBe(subtaskId);
  return { taskId, subtaskId, atMs };
}

/** Let `agent`'s claim lapse (silent past the liveness; other traffic runs the expiry), then have `next` pull it. */
async function lapseTo(next: PeerKeys): Promise<{ subtaskId?: string; timeoutMs?: number }> {
  await sleep(LIVENESS_MS + 300);
  await post("/heartbeat", { agentId: requester.peerId }, requester);
  const r = (await post("/pull", { agentId: next.peerId }, next)).json();
  return { subtaskId: r.subtask?.id ?? r.envelope?.subtaskId, timeoutMs: r.subtask?.timeoutMs };
}

describe("a call's deadline", () => {
  test("a holder still sending at its hard deadline timed out (not lost): the requester keeps the part with a timeout", async () => {
    const before = creditEngine.balance(requester.peerId);
    const { taskId, subtaskId } = await claimed(10_000);
    const { queue } = await import("../../src/swarm/coordinator/context.js");
    const claimedAt = queue.getClaim(subtaskId)?.claimedAt;
    expect(claimedAt).toBeDefined();
    // The holder is sending: two pieces, each renewing the lease's liveness.
    for (const seq of [0, 1]) expect((await post("/inference/chunks", { subtaskId, seq, delta: `w${seq} ` }, worker)).statusCode).toBe(200);
    // The hard deadline (claim + 10 s, grace 0 here) is reached: run the lease expiry at that instant,
    // right after the last piece, instead of waiting ~10 s of wall clock for traffic or the sweep to run
    // it (a slow runner's timing decided whether the lapse counted as a timeout or a lost holder).
    const expiry = queue.expireLeases(claimedAt! + 10_000 + 1);
    expect(expiry.requeued).toContain(subtaskId);
    // The requeue hook ends the call (on a microtask): wait for that event, not for a time span.
    let read = await stream(taskId, subtaskId, 0, 0);
    for (let i = 0; i < 100 && !read.json().done; i++) {
      await new Promise((r) => setImmediate(r));
      read = await stream(taskId, subtaskId, 0, 0);
    }
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ done: true, error: "timed out after 10 s" });
    expect(read.json().chunks.join("")).toBe("w0 w1 ");
    // Nothing charged (its holder overran the deadline), and not handed out again.
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
    const again = await post("/pull", { agentId: worker2.peerId }, worker2);
    expect(again.json().subtask?.id ?? again.json().envelope?.subtaskId).not.toBe(subtaskId);
  }, 15_000);

  test("a re-run after a lost agent gets a fresh timeout, capped at submit + timeout + the re-run budget", async () => {
    const { subtaskId, atMs } = await claimed(20_000);
    // worker is lost before sending anything: worker2 runs it on a fresh 20 s (the cap, submit + 22 s, is further).
    const first = await lapseTo(worker2);
    expect(first.subtaskId).toBe(subtaskId);
    expect(first.timeoutMs).toBe(20_000);
    // worker2 is lost too: the next run ends by submit + 20 s + 2 s, so it gets less than a full timeout.
    const second = await lapseTo(worker);
    expect(second.subtaskId).toBe(subtaskId);
    const cap = atMs + 20_000 + RERUN_BUDGET_MS - Date.now();
    expect(second.timeoutMs).toBeLessThan(20_000);
    expect(second.timeoutMs).toBeGreaterThan(cap - 1_000);
    expect(second.timeoutMs).toBeLessThanOrEqual(cap + 1_000);
  }, 30_000);
});

describe("re-run budget and speed samples (unit)", () => {
  test("a re-run gets min(timeout, submit + timeout + budget - now); nothing past that end", async () => {
    const { rerunTimeoutMs } = await import("../../src/swarm/coordinator/routes/inference.js");
    expect(rerunTimeoutMs(180_000, 0, 30_000, 120_000)).toBe(180_000);
    expect(rerunTimeoutMs(180_000, 0, 170_000, 120_000)).toBe(130_000);
    expect(rerunTimeoutMs(180_000, 0, 290_000, 120_000)).toBe(10_000);
    expect(rerunTimeoutMs(180_000, 0, 300_000, 120_000)).toBe(0);
    // Budget 0: never past the first deadline.
    expect(rerunTimeoutMs(180_000, 0, 170_000, 0)).toBe(10_000);
  });

  test("a finished call's tokens for its speed sample: reported, else from the bytes, none without output", async () => {
    const { sampleTokens } = await import("../../src/swarm/coordinator/routes/admin-network.js");
    expect(sampleTokens({ promptTokens: 1200, outputTokens: 300 }, "x".repeat(400), 0)).toEqual({ promptTokens: 1200, outputTokens: 300 });
    expect(sampleTokens({}, "x".repeat(400), 2_000)).toEqual({ promptTokens: 100, outputTokens: 500 });
    expect(sampleTokens({}, "x".repeat(400), 0)).toBeUndefined();
  });
});
