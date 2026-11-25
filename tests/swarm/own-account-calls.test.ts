import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * A call that runs on a machine of the account that sent it is not charged and earns nothing: the
 * requester's reserve goes back whole (one reserve row, one refund row) and no earnings or network
 * fee are recorded. A call run by another account's machine is charged and paid as before.
 * Ownership is mocked (in memory an agent is its own account).
 */

const owners = vi.hoisted(() => new Map<string, string>());
vi.mock("../../src/credits/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/credits/store.js")>();
  return { ...actual, rewardAccountForAgent: async (agentId: string) => owners.get(agentId) ?? agentId };
});

const { creditEngine, earnedMsat, grantCredits, NETWORK_FEE_POOL_ACCOUNT, sameAccountGroup } = await import("../../src/credits/store.js");

const MESH = "mesh-secret-own-account";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.61";
const MODEL_OWN = "qwen-ownacct:7b";
const MODEL_OTHER = "qwen-otheracct:7b";
let portal: Server;
let app: any;
const requester = createPeerKeys("agent-ownacct-requester");
const ownWorker = createPeerKeys("agent-ownacct-own-worker");
const otherWorker = createPeerKeys("agent-ownacct-other-worker");

beforeAll(async () => {
  owners.set(ownWorker.peerId, requester.peerId);
  owners.set(otherWorker.peerId, "acct-ownacct-other");
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
  // Run 5 prior speed off: completion admission is not what these test (start-eta.ts; tests/swarm/completion-run5.test.ts).
  process.env.INFERENCE_COMPLETION_PRIOR_SPEED = "off";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  for (const [keys, models] of [[requester, []], [ownWorker, [MODEL_OWN]], [otherWorker, [MODEL_OTHER]]] as const) {
    const payload = JSON.stringify({
      os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
      sandboxMode: "docker", installedModels: models,
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
});

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

async function runCall(model: string, worker: PeerKeys): Promise<string> {
  const taskId = `inf-${randomUUID()}`;
  const sub = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, requester);
  expect(sub.statusCode, sub.body).toBe(200);
  const subtaskId = sub.json().subtaskId;
  const pulled = await post("/pull", { agentId: worker.peerId }, worker);
  expect(pulled.json().subtask?.id ?? pulled.json().envelope?.subtaskId).toBe(subtaskId);
  expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "hello there" }, worker)).statusCode).toBe(200);
  expect((await post("/inference/chunks", { subtaskId, seq: 1, delta: "", done: true, promptTokens: 2_000, outputTokens: 500 }, worker)).statusCode).toBe(200);
  const res = await post("/result", { subtaskId, taskId, agentId: worker.peerId, ok: true, output: "hello there", durationMs: 4_000, model }, worker);
  expect(res.statusCode, res.body).toBe(200);
  const read = await post("/inference/stream", { taskId, subtaskId, after: 0, waitMs: 0 }, requester);
  expect(read.statusCode, read.body).toBe(200);
  expect(read.json()).toMatchObject({ done: true });
  return taskId;
}

const rowsFor = (accountId: string, taskId: string) =>
  creditEngine.history(accountId).filter((t) => t.relatedTaskId === taskId || t.reason.endsWith(`:${taskId}`));

describe("calls served by the requester's own account", () => {
  test("not charged and not paid: the reserve comes back whole, no earnings, no fee", async () => {
    const before = creditEngine.balance(requester.peerId);
    const earnedBefore = await earnedMsat(requester.peerId);
    const feeBefore = await earnedMsat(NETWORK_FEE_POOL_ACCOUNT);
    const taskId = await runCall(MODEL_OWN, ownWorker);
    expect(creditEngine.balance(requester.peerId)).toBeCloseTo(before, 6);
    expect(await earnedMsat(requester.peerId)).toBe(earnedBefore);
    expect(await earnedMsat(ownWorker.peerId)).toBe(0);
    expect(await earnedMsat(NETWORK_FEE_POOL_ACCOUNT)).toBe(feeBefore);
    // Ledger shape: one reserve, one refund of the same amount, nothing else for the task.
    const rows = rowsFor(requester.peerId, taskId);
    const reserve = rows.filter((t) => t.reason === "inference_reserve");
    const refund = rows.filter((t) => t.reason === `task_submit_refund:${taskId}`);
    expect(reserve).toHaveLength(1);
    expect(refund).toHaveLength(1);
    expect(refund[0].credits).toBeCloseTo(reserve[0].credits, 6);
    expect(rows.filter((t) => t.reason === "compute_contribution")).toHaveLength(0);
    expect(rowsFor(NETWORK_FEE_POOL_ACCOUNT, taskId)).toHaveLength(0);
  }, 20_000);

  test("another account's machine is charged and paid as before", async () => {
    const before = creditEngine.balance(requester.peerId);
    const taskId = await runCall(MODEL_OTHER, otherWorker);
    const spent = before - creditEngine.balance(requester.peerId);
    const earned = await earnedMsat("acct-ownacct-other");
    expect(spent).toBeGreaterThan(0);
    expect(earned).toBeGreaterThan(0);
    expect(spent * 1000).toBeGreaterThanOrEqual(earned);
    expect(rowsFor(NETWORK_FEE_POOL_ACCOUNT, taskId).length).toBeGreaterThan(0);
    // Paid out of the reserve: reserve - refund = what the host and the fee were credited.
    const rows = rowsFor(requester.peerId, taskId);
    const reserved = rows.filter((t) => t.reason === "inference_reserve").reduce((s, t) => s + t.credits, 0);
    const refunded = rows.filter((t) => t.reason === `task_submit_refund:${taskId}`).reduce((s, t) => s + t.credits, 0);
    const paid = [...rowsFor("acct-ownacct-other", taskId), ...rowsFor(NETWORK_FEE_POOL_ACCOUNT, taskId)].reduce((s, t) => s + t.credits, 0);
    expect(paid + refunded).toBeLessThanOrEqual(reserved + 1e-6);
  }, 20_000);
});

describe("sameAccountGroup (in memory)", () => {
  test("only the same account id counts without a database", async () => {
    expect(await sameAccountGroup("acct-a", "acct-a")).toBe(true);
    expect(await sameAccountGroup("acct-a", "acct-b")).toBe(false);
    expect(await sameAccountGroup("", "")).toBe(false);
  });
});
