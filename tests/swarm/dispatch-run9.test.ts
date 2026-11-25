import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { grantCredits } from "../../src/credits/store.js";

/*
 * Network validation run 9 (2026-11-25):
 *
 * 1. Nearest host under load 17/46: the portal picked the right coordinator, but a non-nearest host
 *    took the call (lhr buyer -> fra, iad -> lax / jnb). The nearest host, running one call with a
 *    slot free, was preferred but left the fresh call to an idle host elsewhere (dispatch.ts
 *    idleTakerExists), which itself left it to the preferred one; the hold ran out and the far host
 *    took it. And locality's load term (1,500 km for a full host) let an idle host 640 km farther
 *    beat a half-busy nearest one.
 * 2. Claim-time refusals 6-82 s after submit ("none could start this request in time"): calls waited
 *    in the queue on a start estimate and were refused later. Now decided within
 *    INFERENCE_CLAIM_DECISION_MS of becoming claimable.
 * 3. Standard Auto calls best fit placed on the cloud host (est. 9.9 s) were refused "deepseek busy"
 *    after 25-48 s while it had 12-16 free slots: the claim admission's completion re-check (scaled
 *    from call times that are mostly reasoning) refused the cloud host's pull.
 */

const MESH = "mesh-secret-run9";
const REMOTE = "203.0.113.99";
const MODEL = "qwen-run9:1.5b";
const CLOUD_MODEL = "deepseek-v4.1-flash";
const OWNER = "ops@edgecoder.io";
const TOKENS: Record<string, { ownerEmail: string; hostApproved: boolean }> = {
  "token-host": { ownerEmail: "host@example.com", hostApproved: true },
  "token-cloud": { ownerEmail: OWNER, hostApproved: true },
};
let portal: Server;
let app: any;
let dispatch: any;
let locality: any;
let inference: any;
let eta: any;
let ctx: any;
const requester = createPeerKeys("agent-run9-requester");
const lhr = createPeerKeys("agent-run9-lhr");
const fra = createPeerKeys("agent-run9-fra");
const cloud = createPeerKeys("agent-run9-cloud");
const DECISION_MS = 600;

beforeAll(async () => {
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const t = TOKENS[body.registrationToken as string];
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/internal/nodes/validate" && t) res.end(JSON.stringify({ allowed: true, reason: "ok", node: { nodeId: body.nodeId, ...t } }));
      else res.end(JSON.stringify({ allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = MESH;
  process.env.CLOUD_HOST_OWNER_EMAILS = OWNER;
  process.env.INFERENCE_COMPLETION_PRIOR_SPEED = "off";
  process.env.COORDINATOR_STARTUP_GRACE_MS = "0";
  process.env.INFERENCE_CLAIM_DECISION_MS = String(DECISION_MS);
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  dispatch = await import("../../src/swarm/coordinator/dispatch.js");
  locality = await import("../../src/swarm/coordinator/locality.js");
  inference = await import("../../src/swarm/coordinator/routes/inference.js");
  eta = await import("../../src/swarm/coordinator/start-eta.js");
  ctx = await import("../../src/swarm/coordinator/context.js");
  await app.ready();
  // Agents that take nudges (a connected mesh socket): the idle-taker deferral applies to them.
  dispatch.setNudgeTransport({ connected: () => true, send: () => true });
  await register(requester, "token-host", { installedModels: [] });
  await register(lhr, "token-host", { installedModels: [MODEL], region: "lhr" });
  await register(fra, "token-host", { installedModels: [MODEL], region: "fra" });
  await register(cloud, "token-cloud", { installedModels: [CLOUD_MODEL], hardwareProfile: { platform: "linux", arch: "x64", cpuCores: 2, ramGb: 2, cloud: { provider: "fireworks" } } });
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  dispatch?.setNudgeTransport(undefined);
  for (const k of ["COORDINATOR_STARTUP_GRACE_MS", "INFERENCE_CLAIM_DECISION_MS", "CLOUD_HOST_OWNER_EMAILS", "INFERENCE_COMPLETION_PRIOR_SPEED"]) delete process.env[k];
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

async function register(keys: PeerKeys, token: string, extra: Record<string, unknown>) {
  const payload = JSON.stringify({ os: "linux", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: token, publicKeyPem: keys.publicKeyPem, sandboxMode: "docker", ...extra });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
  expect(res.statusCode, res.body).toBe(200);
}

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  const signed = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: signer.privateKeyPem, agentId: signer.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pull = async (k: PeerKeys, slots = 2, free = slots) => {
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: slots, freeInferenceSlots: free, wake: true }, k)).json();
  return { id: (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null, taskId: (r.subtask?.taskId ?? r.envelope?.taskId ?? null) as string | null };
};
const submit = async (body: Record<string, unknown>) => {
  const taskId = `inf-${randomUUID()}`;
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, timeoutMs: 60_000, messages: [{ role: "user", content: "hi" }], ...body }, requester);
  expect(r.statusCode, r.body).toBe(200);
  return { taskId, subtaskId: r.json().subtaskId as string };
};
const finish = async (k: PeerKeys, taskId: string, subtaskId: string, model = MODEL) => {
  await post("/inference/chunks", { subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 3, outputTokens: 1 }, k);
  await post("/result", { subtaskId, taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model }, k);
};
const read = (taskId: string, subtaskId: string) => post("/inference/stream", { taskId, subtaskId, after: 0, waitMs: 0 }, requester);

async function drain() {
  for (let i = 0; i < 32; i++) {
    let any = false;
    for (const k of [lhr, fra]) {
      const r = await pull(k);
      if (!r.id || !r.taskId) continue;
      any = true;
      await finish(k, r.taskId, r.id);
    }
    if (!any) break;
  }
}

beforeEach(async () => {
  await drain();
});

describe("run 9, 1: the nearest host with a free slot gets the call under load", () => {
  test("locality: a half-busy nearest host beats an idle one 640 km farther; load only separates hosts in the same place", () => {
    const lhrHalf = { agentId: "lhr", free: 1, slots: 2, region: "lhr" };
    const fraIdle = { agentId: "fra", free: 2, slots: 2, region: "fra" };
    expect(locality.nearestFreeHolder([fraIdle, lhrHalf], "lhr")?.agentId).toBe("lhr");
    // Nearly full (1 of 8 free) still beats an idle host in another metro.
    expect(locality.nearestFreeHolder([fraIdle, { ...lhrHalf, free: 1, slots: 8 }], "lhr")?.agentId).toBe("lhr");
    // Two hosts in the buyer's own region: the freer one.
    expect(locality.nearestFreeHolder([lhrHalf, { agentId: "lhr-2", free: 2, slots: 2, region: "lhr" }], "lhr")?.agentId).toBe("lhr-2");
  });

  test("the preferred nearest host takes its call with a free slot while it runs another; the idle far host waits", async () => {
    const first = await submit({ clientRegion: "lhr" });
    expect(dispatch.preferredAgentFor(first.subtaskId)).toBe(lhr.peerId);
    expect((await pull(lhr)).id).toBe(first.subtaskId);
    // lhr now runs one call with one slot free; fra is idle and 640 km farther.
    const second = await submit({ clientRegion: "lhr" });
    expect(dispatch.preferredAgentFor(second.subtaskId)).toBe(lhr.peerId);
    expect((await pull(fra)).id).toBeNull();
    // Before: lhr, busy, left the fresh call to idle fra (which left it to lhr) until the hold ran out.
    expect((await pull(lhr, 2, 1)).id).toBe(second.subtaskId);
    await finish(lhr, first.taskId, first.subtaskId);
    await finish(lhr, second.taskId, second.subtaskId);
  });

  test("a preferred host that reports no free slot does not hold the call: another free host takes it", async () => {
    const call = await submit({ clientRegion: "lhr" });
    expect(dispatch.preferredAgentFor(call.subtaskId)).toBe(lhr.peerId);
    // lhr reports its slots full (throttled, or filled in between): fra need not wait out the hold.
    expect((await pull(lhr, 2, 0)).id).toBeNull();
    expect((await pull(fra)).id).toBe(call.subtaskId);
    await finish(fra, call.taskId, call.subtaskId);
  });
});

describe("run 9, 2: an unclaimed call is decided within INFERENCE_CLAIM_DECISION_MS", () => {
  test("every slot busy: the call is refused (503 busy, nothing charged) within the decision window, not at the 45 s bound", async () => {
    expect(inference.INFERENCE_CLAIM_DECISION_MS).toBe(DECISION_MS);
    // One slot each, both running a call.
    const a = await submit({ clientRegion: "lhr" });
    expect((await pull(lhr, 1, 1)).id).toBe(a.subtaskId);
    const b = await submit({ clientRegion: "fra" });
    expect((await pull(fra, 1, 1)).id).toBe(b.subtaskId);
    const t0 = Date.now();
    const c = await submit({ clientRegion: "lhr" });
    await sleep(DECISION_MS + 300);
    const r = await read(c.taskId, c.subtaskId);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(ctx.queue.isUnclaimed(c.subtaskId)).toBe(false);
    await finish(lhr, a.taskId, a.subtaskId);
    await finish(fra, b.taskId, b.subtaskId);
  });

  test("a free slot here: the call waits one more window for its host, then is refused if nobody took it", async () => {
    const call = await submit({ clientRegion: "lhr" });
    // lhr and fra report free slots but do not pull.
    expect(await inference.decideUnclaimedCall(call.taskId, call.subtaskId)).toBe("waiting");
    expect(ctx.queue.isUnclaimed(call.subtaskId)).toBe(true);
    expect(await inference.decideUnclaimedCall(call.taskId, call.subtaskId, Date.now(), true)).toBe("ended");
    expect((await read(call.taskId, call.subtaskId)).statusCode).toBe(503);
  });

  test("a call claimed within the window is not touched", async () => {
    const call = await submit({ clientRegion: "fra" });
    expect((await pull(fra)).id).toBe(call.subtaskId);
    await sleep(DECISION_MS + 100);
    expect(await inference.decideUnclaimedCall(call.taskId, call.subtaskId, Date.now(), true)).toBe("claimed");
    await finish(fra, call.taskId, call.subtaskId);
    const r = await read(call.taskId, call.subtaskId);
    expect(r.statusCode).toBe(200);
  });
});

describe("run 9, 3: claim admission admits the cloud host", () => {
  test("a cloud host with a free slot is admitted though its reasoning-heavy call times scale past the limit", async () => {
    expect((await pull(cloud, 16, 16)).id).toBeNull();
    const prompt = "refactor this:\n" + "const x = 1;\n".repeat(900);
    const taskId = `inf-${randomUUID()}`;
    const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: CLOUD_MODEL, timeoutMs: 180_000, maxTokens: 2048, messages: [{ role: "user", content: prompt }] }, requester);
    expect(r.statusCode, r.body).toBe(200);
    const st = ctx.queue.getSubtask(r.json().subtaskId);
    const now = Date.now();
    const messages = [{ role: "user", content: prompt }];
    // The cloud class's measured calls of this size: half the completion limit (mostly reasoning).
    const { limitMs } = inference.completionCheck(CLOUD_MODEL, "cloud", messages, undefined, 2048, 180_000, now);
    const work = inference.completionWork(messages, undefined, 2048);
    const workMs = eta.callWorkMs(CLOUD_MODEL, "cloud", work.promptTokens, work.outputTokens);
    for (let i = 0; i < 6; i++) eta.serviceTimes.record(CLOUD_MODEL, "cloud", Math.round(limitMs / 2), now, workMs);
    expect(inference.completionCheck(CLOUD_MODEL, "cloud", messages, undefined, 2048, 180_000, now, { waiting: 0 }).exclude).not.toContain(cloud.peerId);
    // It has waited 70% of its limit: the estimate says it would no longer finish there (it fit at submit).
    ctx.usagePending.get(taskId).atMs = now - Math.round(limitMs * 0.7);
    expect(inference.completionCheck(CLOUD_MODEL, "cloud", messages, undefined, 2048, 180_000, now, { elapsedMs: Math.round(limitMs * 0.7), waiting: 0 }).exclude).toContain(cloud.peerId);
    // Before: refused at every pull, so the call sat beside 16 free slots until it was re-placed or refused.
    expect(inference.claimAdmits(cloud.peerId, st, now)).toBe(true);
    // (Not pulled here: on a slow runner the call may already have been decided, INFERENCE_CLAIM_DECISION_MS.)
  });
});
