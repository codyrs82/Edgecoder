import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { grantCredits } from "../../src/credits/store.js";

/*
 * Network validation run 10 (deployed 607f3f1b, #582/#583), each test replays a sequence from the run-10 logs:
 *
 * 1. Nearest host 47% in the CPU ramp, though the coordinator logged "free host nearest the buyer, 0 km":
 *    the Fly CPU hosts pull every ~3-5 s (time since last pull: idle p50 2.7 s, p90 4.4 s, ag.jsonl);
 *    the 2 s locality hold lapsed before the nearest host's next pull and whoever pulled first took the
 *    call (inf-1795643763890-e24ed851: lhr 1/2 free, last pull 1.5-4.5 s before; fra idle took it).
 * 2. Claim-time refusals: 23 at exactly 4.0 s (the submit's decision timer, second window): the
 *    decision counted a host's free slot from a report it sent long ago (busy hosts "free" by report had
 *    not pulled for p90 33.9 s, up to 117 s), so it waited, then refused. The 39-118 s tail and the
 *    Auto ~48 s refusals had no request id (armed outside the submit): calls back on the queue after a
 *    take-back got only the 45 s bound, no decision.
 * 3. The three Auto "deepseek busy" calls at ~48 s: claimed by the cloud host, then taken back for
 *    "withheld slots" (its slot report lags its claims), excluded from it, and the only deepseek host
 *    gone, they waited out the 45 s bound; ag.jsonl showed 0 claimed, 3 deepseek waiting and the cloud
 *    host idle with 13/16 free (it was still running the three taken-back calls).
 */

const MESH = "mesh-secret-run10";
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
const requester = createPeerKeys("agent-run10-requester");
const lhr = createPeerKeys("agent-run10-lhr");
const fra = createPeerKeys("agent-run10-fra");
const cloud = createPeerKeys("agent-run10-cloud");
const DECISION_MS = 800;

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

describe("run 10, 1: the nearest free host keeps its call until its next pull", () => {
  test("a call arriving between the nearest host's pulls is not taken by an idle far host when the 2 s hold ends", async () => {
    // Both pulling, lhr running one call (1 of 2 free), fra idle: as for inf-1795643763890-e24ed851.
    const first = await submit({ clientRegion: "lhr" });
    expect((await pull(lhr)).id).toBe(first.subtaskId);
    expect((await pull(fra)).id).toBeNull();
    const t0 = Date.now();
    const call = await submit({ clientRegion: "lhr" });
    expect(dispatch.preferredAgentFor(call.subtaskId)).toBe(lhr.peerId);
    const st = ctx.queue.getSubtask(call.subtaskId);
    const claims = () => ctx.queue.activeClaims();
    // fra polls at +2.3 s, before lhr's next pull: before, the 2 s hold had lapsed and fra took the call.
    expect(dispatch.mayTakeNow(fra.peerId, st, claims(), t0 + 2_300)).toBe(false);
    expect(dispatch.preferredAgentFor(call.subtaskId, t0 + 2_300)).toBe(lhr.peerId);
    // lhr's next pull (+2.4 s) takes it.
    expect(dispatch.mayTakeNow(lhr.peerId, st, claims(), t0 + 2_400)).toBe(true);
    // Bounded: past LOCALITY_PULL_HOLD_MS anyone may take it.
    expect(dispatch.mayTakeNow(fra.peerId, st, claims(), t0 + locality.LOCALITY_PULL_HOLD_MS + 100)).toBe(true);
    expect((await pull(lhr, 2, 1)).id).toBe(call.subtaskId);
    await finish(lhr, first.taskId, first.subtaskId);
    await finish(lhr, call.taskId, call.subtaskId);
  });

  test("the hold ends at the nearest host's first pull, and is not extended for a host that is not pulling", async () => {
    const t0 = Date.now();
    const call = await submit({ clientRegion: "lhr" });
    const st = ctx.queue.getSubtask(call.subtaskId);
    // lhr pulls (+2.1 s) and cannot take it (reports no free slot): the hold ends with that pull.
    dispatch.noteAgentPull(lhr.peerId, { inferenceSlots: 2, freeInferenceSlots: 0, wake: true }, t0 + 2_100);
    expect(dispatch.preferredAgentFor(call.subtaskId, t0 + 2_200)).toBeUndefined();
    expect(dispatch.mayTakeNow(fra.peerId, st, ctx.queue.activeClaims(), t0 + 2_200)).toBe(true);
    expect((await pull(fra)).id).toBe(call.subtaskId);
    await finish(fra, call.taskId, call.subtaskId);
    // A nearest host that last pulled more than PULL_FRESH_MS ago is held for only the 2 s.
    const t1 = Date.now();
    dispatch.noteAgentPull(lhr.peerId, { inferenceSlots: 2, freeInferenceSlots: 2, wake: true });
    const other = await submit({ clientRegion: "lhr" });
    expect(dispatch.preferredAgentFor(other.subtaskId, t1 + 1_000)).toBe(lhr.peerId);
    expect(dispatch.preferredAgentFor(other.subtaskId, t1 + dispatch.PULL_FRESH_MS + 100)).toBeUndefined();
    expect((await pull(lhr)).id).toBe(other.subtaskId);
    await finish(lhr, other.taskId, other.subtaskId);
  });
});

describe("run 10, 2: unclaimed calls are decided on hosts that are pulling, and again after a take-back", () => {
  test("a free slot reported long ago by a host that has not pulled since does not make the call wait (was: refused at 4.0 s)", async () => {
    // lhr runs a call with a slot free by its report, then stops pulling (busy p90 33.9 s since its last pull).
    const a = await submit({ clientRegion: "lhr" });
    expect((await pull(lhr, 2, 2)).id).toBe(a.subtaskId);
    dispatch.noteAgentPull(lhr.peerId, { inferenceSlots: 2, freeInferenceSlots: 1, wake: true }, Date.now() - 30_000);
    // fra is full.
    const b = await submit({ clientRegion: "fra" });
    expect((await pull(fra, 1, 1)).id).toBe(b.subtaskId);
    const c = await submit({ clientRegion: "lhr" });
    const st = ctx.queue.getSubtask(c.subtaskId);
    const cand = dispatch.claimCandidates(st);
    expect(cand.ready).toEqual([]);
    expect(cand.not[lhr.peerId]).toBe("not_pulling");
    expect(cand.not[fra.peerId]).toBe("no_room");
    // Decided at the first decision: refused, not "waiting" for a second window.
    expect(await inference.decideUnclaimedCall(c.taskId, c.subtaskId)).toBe("ended");
    const r = await read(c.taskId, c.subtaskId);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    dispatch.noteAgentPull(lhr.peerId, { inferenceSlots: 2, freeInferenceSlots: 1, wake: true });
    await finish(lhr, a.taskId, a.subtaskId);
    await finish(fra, b.taskId, b.subtaskId);
  });

  test("a call taken back from a throttled host is decided again within the window, not after the 45 s bound", async () => {
    const call = await submit({ clientRegion: "fra" });
    // Only fra may run it (lhr reports full and is not pulling).
    dispatch.noteAgentPull(lhr.peerId, { inferenceSlots: 2, freeInferenceSlots: 0, wake: true }, Date.now() - 30_000);
    expect((await pull(fra, 2, 2)).id).toBe(call.subtaskId);
    // fra runs out of CPU credit before its first piece; the waiting sweep takes the call back.
    await post("/pull", { agentId: fra.peerId, inferenceSlots: 2, freeInferenceSlots: 0, cpuThrottled: true, cpuStealShare: 0.8, wake: true }, fra);
    const t0 = Date.now();
    await inference.takeBackStalledClaims(Date.now() + 2_500);
    expect(ctx.queue.isUnclaimed(call.subtaskId)).toBe(true);
    let r = await read(call.taskId, call.subtaskId);
    for (let i = 0; i < 40 && r.statusCode === 200; i++) {
      await sleep(50);
      r = await read(call.taskId, call.subtaskId);
    }
    expect(r.statusCode).toBe(503);
    expect(Date.now() - t0).toBeLessThan(DECISION_MS * 2.5);
    (await import("../../src/swarm/coordinator/host-steal.js")).clearAgentSteal();
    dispatch.noteAgentPull(lhr.peerId, { inferenceSlots: 2, freeInferenceSlots: 2, wake: true });
  });
});

describe("run 10, 3: the cloud host keeps the calls it claimed", () => {
  test("a cloud host whose slot report lags its claims is not taken back for withheld slots", async () => {
    expect((await pull(cloud, 16, 16)).id).toBeNull();
    const taskId = `inf-${randomUUID()}`;
    const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: CLOUD_MODEL, timeoutMs: 180_000, maxTokens: 2048, messages: [{ role: "user", content: "refactor this: const x = 1;" }] }, requester);
    expect(r.statusCode, r.body).toBe(200);
    const sub = r.json().subtaskId;
    expect((await pull(cloud, 16, 16)).id).toBe(sub);
    // Its next pull still counts calls it is finishing: 12 free while it holds 1 here (3 "withheld").
    await post("/pull", { agentId: cloud.peerId, inferenceSlots: 16, freeInferenceSlots: 12, wake: true }, cloud);
    expect(eta.agentWithholding(cloud.peerId)).toBe(true);
    // Reasoning, no first piece yet at +2.5 s: before, taken back here and left to the 45 s bound.
    await inference.takeBackStalledClaims(Date.now() + 2_500);
    expect(ctx.queue.isUnclaimed(sub)).toBe(false);
    expect(ctx.queue.excludedAgents(sub)).not.toContain(cloud.peerId);
    await finish(cloud, taskId, sub, CLOUD_MODEL);
  });
});
