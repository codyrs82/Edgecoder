import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { grantCredits } from "../../src/credits/store.js";

/*
 * BHV006 on the real coordinator app. A heartbeat gap while holding a claim (laptop sleep, the
 * desktop restarting to finish an update) requeues the claim and records one abandoned claim; it
 * is not a blacklist. An agent that announces it is going offline hands its claims back at once and
 * abandons nothing. Admins list and lift blacklists with the admin token alone.
 */

const MESH = "mesh-secret-bhv006";
const ADMIN = "admin-secret-bhv006";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.61";
const MODEL = "qwen-bhv006:7b";
const LIVENESS_MS = 1_000;
let portal: Server;
let app: any;
let state: typeof import("../../src/swarm/coordinator/agent-state.js");
let ctx: typeof import("../../src/swarm/coordinator/context.js");
const requester = createPeerKeys("agent-bhv006-requester");
const worker = createPeerKeys("agent-bhv006-worker");

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
  process.env.ADMIN_API_TOKEN = ADMIN;
  process.env.CLAIM_LEASE_LIVENESS_MS = String(LIVENESS_MS);
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  state = await import("../../src/swarm/coordinator/agent-state.js");
  ctx = await import("../../src/swarm/coordinator/context.js");
  await app.ready();
  for (const keys of [requester, worker]) await register(keys);
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  delete process.env.CLAIM_LEASE_LIVENESS_MS;
  delete process.env.ADMIN_API_TOKEN;
});

async function register(keys: PeerKeys) {
  const payload = JSON.stringify({
    os: "macos", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
    sandboxMode: "docker", installedModels: keys === worker ? [MODEL] : [],
  });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
  return res;
}

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function submitAndClaim(): Promise<string> {
  const taskId = `inf-${randomUUID()}`;
  const sub = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, requester);
  expect(sub.statusCode, sub.body).toBe(200);
  const subtaskId = sub.json().subtaskId as string;
  const pulled = await post("/pull", { agentId: worker.peerId }, worker);
  expect(pulled.json().subtask?.id ?? pulled.json().envelope?.subtaskId).toBe(subtaskId);
  return subtaskId;
}

const abandoned = () => state.behaviorTracker.getStats(worker.peerId)?.abandonedClaimCount ?? 0;

describe("BHV006: a heartbeat gap is not misbehaviour", () => {
  test("a long gap while holding a claim requeues it and records one abandoned claim; no blacklist", async () => {
    await post("/heartbeat", { agentId: worker.peerId }, worker);
    const before = abandoned();
    const subtaskId = await submitAndClaim();
    // The worker goes quiet (sleep, an update restart) well past the lease's liveness.
    await sleep(LIVENESS_MS * 2.5);
    await post("/heartbeat", { agentId: requester.peerId }, requester);
    expect(ctx.queue.isUnclaimed(subtaskId)).toBe(true);
    await sleep(0);
    expect(abandoned()).toBe(before + 1);
    // It comes back: heartbeats, registers again, and is not blacklisted.
    const hb = await post("/heartbeat", { agentId: worker.peerId }, worker);
    expect(hb.json().blacklisted).toBeUndefined();
    expect((await register(worker)).statusCode).toBe(200);
    expect(state.activeBlacklistRecord(worker.peerId)).toBeUndefined();
    expect(state.behaviorTracker.getStats(worker.peerId)?.heartbeatGapMaxMs ?? 0).toBeGreaterThan(LIVENESS_MS);
    // Hand the requeued call back so it doesn't linger for the next test.
    ctx.queue.removeHeld(subtaskId);
  }, 20_000);

  test("several claims held at once that lapse together are one lapse; their late results withdraw them", async () => {
    // 2026-11-25: a cloud host running several calls side by side was blacklisted when they lapsed together.
    await post("/heartbeat", { agentId: worker.peerId }, worker);
    const before = abandoned();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await submitAndClaim());
    await sleep(LIVENESS_MS * 2.5);
    await post("/heartbeat", { agentId: requester.peerId }, requester);
    await sleep(0);
    expect(abandoned()).toBe(before + 6);
    expect(state.activeBlacklistRecord(worker.peerId)).toBeUndefined();
    // The results arrive late: refused (the calls went back on the queue), but they were returned.
    for (const subtaskId of ids) {
      const late = await post("/result", { subtaskId, taskId: "x", agentId: worker.peerId, ok: true, output: "late", durationMs: 100 }, worker);
      expect(late.statusCode).toBe(409);
      expect(late.json().error).toBe("lease_expired");
    }
    expect(abandoned()).toBe(before);
    for (const subtaskId of ids) ctx.queue.removeHeld(subtaskId);
    // The lapses also opened the agent's routing circuit (memory-admission.ts), a separate mechanism: close it for the next test.
    (await import("../../src/swarm/coordinator/memory-admission.js")).resetMemoryAdmission();
  }, 30_000);

  test("a call its requester cancelled is not the agent's abandoned claim when it lapses", async () => {
    await post("/heartbeat", { agentId: worker.peerId }, worker);
    const before = abandoned();
    const taskId = `inf-${randomUUID()}`;
    const sub = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, requester);
    const subtaskId = sub.json().subtaskId as string;
    const pulled = await post("/pull", { agentId: worker.peerId }, worker);
    expect(pulled.json().subtask?.id ?? pulled.json().envelope?.subtaskId).toBe(subtaskId);
    const cancel = await post("/inference/cancel", { taskId, subtaskId }, requester);
    expect(cancel.json()).toMatchObject({ ok: true, outcome: "stopping" });
    await sleep(LIVENESS_MS * 2.5);
    await post("/heartbeat", { agentId: requester.peerId }, requester);
    await sleep(0);
    expect(abandoned()).toBe(before);
    ctx.queue.removeHeld(subtaskId);
    (await import("../../src/swarm/coordinator/memory-admission.js")).resetMemoryAdmission();
  }, 20_000);

  test("going offline cleanly hands claims back at once and abandons nothing", async () => {
    const before = abandoned();
    const subtaskId = await submitAndClaim();
    const bye = await post("/heartbeat", { agentId: worker.peerId, goingOffline: "update" }, worker);
    expect(bye.statusCode, bye.body).toBe(200);
    expect(bye.json()).toMatchObject({ ok: true, offline: true, released: 1 });
    expect(ctx.queue.isUnclaimed(subtaskId)).toBe(true);
    await sleep(LIVENESS_MS * 2);
    await post("/heartbeat", { agentId: requester.peerId }, requester);
    await sleep(0);
    expect(abandoned()).toBe(before);
    // A late result from the released claim is refused, as after a lease expiry.
    const late = await post("/result", { subtaskId, taskId: "x", agentId: worker.peerId, ok: true, output: "late", durationMs: 100 }, worker);
    expect(late.statusCode).toBeGreaterThanOrEqual(400);
    ctx.queue.removeHeld(subtaskId);
  }, 20_000);
});

describe("lease traffic has its own rate budget", () => {
  test("pulls over the general budget never starve a lease heartbeat or a result; a refused one is logged apart", async () => {
    const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
    const stop = ctx.securityLog.addListener((e) => events.push(e as never));
    try {
      while (ctx.agentRateLimiter.check(worker.peerId)) { /* use up the general budget */ }
      expect((await post("/pull", { agentId: worker.peerId }, worker)).statusCode).toBe(429);
      const lease = await post("/heartbeat", { agentId: worker.peerId, leaseOnly: true }, worker);
      expect(lease.statusCode, lease.body).toBe(200);
      const result = await post("/result", { subtaskId: `none-${randomUUID()}`, taskId: "x", agentId: worker.peerId, ok: true, output: "x", durationMs: 100 }, worker);
      expect(result.statusCode).not.toBe(429);
      expect(events.some((e) => e.event === "agent_lease_traffic_rate_limited")).toBe(false);
      // The lease budget itself used up: refused, and logged as its own event (once a minute).
      while (ctx.agentLeaseRateLimiter.check(worker.peerId)) { /* use up the lease budget */ }
      expect((await post("/heartbeat", { agentId: worker.peerId, leaseOnly: true }, worker)).statusCode).toBe(429);
      expect((await post("/result", { subtaskId: "y", taskId: "x", agentId: worker.peerId, ok: true, output: "x", durationMs: 1 }, worker)).statusCode).toBe(429);
      const logged = events.filter((e) => e.event === "agent_lease_traffic_rate_limited");
      expect(logged).toHaveLength(1);
      expect(logged[0].details).toMatchObject({ route: "/heartbeat" });
    } finally {
      stop();
      ctx.agentRateLimiter.reset(worker.peerId);
      ctx.agentLeaseRateLimiter.reset(worker.peerId);
    }
  });
});

describe("admin blacklist listing and lift (admin token)", () => {
  const target = `agent-bhv006-listed-${randomUUID().slice(0, 8)}`;
  const get = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });

  test("needs the admin token; the mesh token alone is not enough", async () => {
    expect((await get("/admin/security/blacklist")).statusCode).toBe(401);
    expect((await get("/admin/security/blacklist", { "x-mesh-token": MESH })).statusCode).toBe(401);
    expect((await get("/admin/security/blacklist", { "x-admin-token": "wrong" })).statusCode).toBe(401);
    const lift = await app.inject({ method: "POST", url: `/admin/security/blacklist/${target}/lift`, headers: { "x-mesh-token": MESH, "content-type": "application/json" }, payload: "{}" });
    expect(lift.statusCode).toBe(401);
  });

  test("lists an automatic blacklist with its expiry, and lifts it", async () => {
    state.autoBlacklister.processAnomalies(target, [{ ruleId: "BHV005", ruleName: "Protocol abuse", severity: "CRITICAL", blacklistReason: "credential_abuse", description: "test", stats: {} }]);
    const listed = await get("/admin/security/blacklist", { "x-admin-token": ADMIN });
    expect(listed.statusCode).toBe(200);
    const row = listed.json().records.find((r: { agentId: string }) => r.agentId === target);
    expect(row).toMatchObject({ agentId: target, automatic: true, reasonCode: "credential_abuse" });
    expect(row.reason).toContain("BHV005");
    const lift = await app.inject({ method: "POST", url: `/admin/security/blacklist/${target}/lift`, headers: { "x-admin-token": ADMIN, "content-type": "application/json" }, payload: JSON.stringify({ reason: "owner review" }) });
    expect(lift.statusCode, lift.body).toBe(200);
    const after = await get("/admin/security/blacklist", { "x-admin-token": ADMIN });
    expect(after.json().records.some((r: { agentId: string }) => r.agentId === target)).toBe(false);
    const again = await app.inject({ method: "POST", url: `/admin/security/blacklist/${target}/lift`, headers: { "x-admin-token": ADMIN, "content-type": "application/json" }, payload: "{}" });
    expect(again.statusCode).toBe(404);
  });

});

describe("POST /admin/nodes/:nodeId/dismiss (ownerless enrollment requests)", () => {
  test("needs the admin token", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/nodes/lambda-a100-gpu/dismiss", headers: { "x-mesh-token": MESH, "content-type": "application/json" }, payload: "{}" });
    expect(res.statusCode).toBe(401);
  });

  test("dismisses and, with blockDays, blacklists the agent id for that long", async () => {
    const agentId = `ownerless-${randomUUID()}`;
    const res = await app.inject({ method: "POST", url: `/admin/nodes/${agentId}/dismiss`, headers: { "x-admin-token": ADMIN, "content-type": "application/json" }, payload: JSON.stringify({ nodeKind: "agent", blockDays: 3, reason: "rejected by admin@x.io" }) });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, nodeId: agentId, blacklisted: true });
    const listed = await app.inject({ method: "GET", url: "/admin/security/blacklist", headers: { "x-admin-token": ADMIN } });
    const row = listed.json().records.find((r: { agentId: string }) => r.agentId === agentId);
    expect(row).toMatchObject({ agentId, reasonCode: "manual_review", automatic: false });
    expect(row.expiresInMs).toBeGreaterThan(2.9 * 86_400_000);
    const noBlock = await app.inject({ method: "POST", url: `/admin/nodes/other-${agentId}/dismiss`, headers: { "x-admin-token": ADMIN, "content-type": "application/json" }, payload: "{}" });
    expect(noBlock.json()).toMatchObject({ ok: true, blacklisted: false });
  });
});


describe("POST /admin/nodes/:nodeId/remove (an approved machine that is gone)", () => {
  const post = (id: string, payload: unknown, token = ADMIN) =>
    app.inject({ method: "POST", url: `/admin/nodes/${id}/remove`, headers: { "x-admin-token": token, "content-type": "application/json" }, payload: JSON.stringify(payload) });

  test("needs the admin token", async () => {
    expect((await post("ec-st10-chi-gpu0-1", {}, "wrong")).statusCode).toBe(401);
  });

  test("refuses while it holds a reservation lease unless forced, then drops it from the registry", async () => {
    const agentId = `gone-${randomUUID()}`;
    state.agentCapabilities.set(agentId, { os: "linux" } as never);
    const now = Date.now();
    ctx.reservations.add({ id: `r-${agentId}`, accountId: "buyer", agentId, agentAccountId: "host", computeClass: "gpu.dc", creditsPerSecond: 1, startMs: now, endMs: now + 3_600_000, ratePerSecondMsat: 1, prepaidMsat: 1, status: "active" });
    const blocked = await post(agentId, {});
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "active_reservation", reservationId: `r-${agentId}` });
    expect((await post(agentId, { dryRun: true })).statusCode).toBe(409);
    expect(state.agentCapabilities.has(agentId)).toBe(true);
    const forced = await post(agentId, { force: true });
    expect(forced.statusCode, forced.body).toBe(200);
    expect(forced.json()).toMatchObject({ ok: true, registered: true, forced: true });
    expect(state.agentCapabilities.has(agentId)).toBe(false);
  });

  test("an idle machine is removed without force; dryRun changes nothing", async () => {
    const agentId = `idle-${randomUUID()}`;
    state.agentCapabilities.set(agentId, { os: "linux" } as never);
    expect((await post(agentId, { dryRun: true })).json()).toMatchObject({ ok: true, dryRun: true });
    expect(state.agentCapabilities.has(agentId)).toBe(true);
    expect((await post(agentId, {})).json()).toMatchObject({ ok: true, registered: true, forced: false });
    expect(state.agentCapabilities.has(agentId)).toBe(false);
  });
});
