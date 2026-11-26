import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";

/*
 * Network validation run 14 (deployed f236405e), each test replays a sequence from the run-14 logs.
 * (Harness as in run11/run12-overflow.test.ts; the run-11 notes below are kept for its setup.)
 * Network validation run 11 (main 1cbfb1c1), each test replays a sequence from the run-11 logs:
 *
 * 1. Two bursts of 20 simple Auto calls (max_tokens 1024): 14 refused "every machine that runs
 *    qwen2.5-coder:1.5b is busy" while the cloud host had 16/16 free. All 14 had been sent by the US
 *    coordinator to the EU one (route_elsewhere: its own 1.5b hosts were full, the EU view still showed
 *    lhr/fra free for every call of the burst), and the EU coordinator has no cloud host. Also: a
 *    re-placement asked best fit with hosts free by count that could not start the call, which kept
 *    the cloud out (cloudConsidered), and the cloud was never tried past the decision bound.
 * 2. Refusals took 2.0-3.5 s at the coordinator (3.44 s at the portal): the decision window is 1.5 s now.
 * 3. inf-1795652230416-401ddacd: "preferredHolding=true reason=preference_lapsed waited=116ms": fra
 *    (preferred) had just taken another call; lhr pulled and took fra's buyer's call, not the lhr
 *    buyer's call held for it, which waited and was refused.
 */

const MESH = "mesh-secret-run14";
const REMOTE = "203.0.113.114";
const MODEL = "qwen2.5-coder:1.5b";
const CLOUD_MODEL = "deepseek-v4.1-flash";
const OWNER = "ops@edgecoder.io";
const TOKENS: Record<string, { ownerEmail: string; hostApproved: boolean }> = {
  "token-host": { ownerEmail: "host@example.com", hostApproved: true },
  "token-cloud": { ownerEmail: OWNER, hostApproved: true },
};
const DECISION_MS = 800;
let portal: Server;
let app: any;
let dispatch: any;
let ctx: any;
let routing: any;
let autoReplace: any;
let economy: any;
let inference: any;
const requester = createPeerKeys("agent-run14-requester");
const lhr = createPeerKeys("agent-run14-lhr");
const fra = createPeerKeys("agent-run14-fra");
const cloud = createPeerKeys("agent-run14-cloud");
const mac = createPeerKeys("agent-run14-mac");
const MAC_MODEL = "qwen3.5:9b";
const MAC_PROFILE = { cpuCores: 12, cpuModel: "Apple M3 Max", ramGb: 64, arch: "arm64", platform: "darwin", gpu: { vendor: "apple", model: "Apple M3 Max", vramGb: 64, datacenter: false } };

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
  ctx = await import("../../src/swarm/coordinator/context.js");
  routing = await import("../../src/swarm/coordinator/routing.js");
  autoReplace = await import("../../src/swarm/coordinator/auto-replace.js");
  economy = await import("../../src/swarm/coordinator/economy.js");
  inference = await import("../../src/swarm/coordinator/routes/inference.js");
  await app.ready();
  dispatch.setNudgeTransport({ connected: () => true, send: () => true });
  await register(requester, "token-host", { installedModels: [] });
  await register(lhr, "token-host", { installedModels: [MODEL], region: "lhr" });
  await register(fra, "token-host", { installedModels: [MODEL], region: "fra" });
  await register(mac, "token-host", { installedModels: [MAC_MODEL], region: "iad", hardwareProfile: MAC_PROFILE });
  await register(cloud, "token-cloud", { installedModels: [CLOUD_MODEL], hardwareProfile: { platform: "linux", arch: "x64", cpuCores: 2, ramGb: 2, cloud: { provider: "fireworks" } } });
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  dispatch?.setNudgeTransport(undefined);
  routing?.setPeerWorldSource(undefined);
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
const pull = async (k: PeerKeys, slots = 1, free = slots) => {
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: slots, freeInferenceSlots: free, wake: true }, k)).json();
  return { id: (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null, taskId: (r.subtask?.taskId ?? r.envelope?.taskId ?? null) as string | null };
};
const pullCloud = (free = 16) => pull(cloud, 16, free);
const submit = async (body: Record<string, unknown>) => {
  const taskId = `inf-${randomUUID()}`;
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, timeoutMs: 120_000, messages: [{ role: "user", content: `hi ${randomUUID()}` }], ...body }, requester);
  return { taskId, r, subtaskId: r.json().subtaskId as string };
};
const submitAuto = (body: Record<string, unknown> = {}) => submit({ model: "auto", maxTokens: 1024, ...body });
const finish = async (k: PeerKeys, taskId: string, subtaskId: string, model = MODEL) => {
  await post("/inference/chunks", { subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 3, outputTokens: 1 }, k);
  await post("/result", { subtaskId, taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model }, k);
};
const read = (taskId: string, subtaskId: string) => post("/inference/stream", { taskId, subtaskId, after: 0, waitMs: 0 }, requester);
/** The host stopped pulling 8 s ago with its slot free by its last report (busy hosts do not pull): free by count, cannot claim now. */
const stalePull = (k: PeerKeys) => dispatch.noteAgentPull(k.peerId, { inferenceSlots: 1, freeInferenceSlots: 1, wake: true }, Date.now() - 8_000);

async function drain() {
  for (let i = 0; i < 32; i++) {
    let any = false;
    for (const [k, model, slots] of [[lhr, MODEL, 1], [fra, MODEL, 1], [mac, MAC_MODEL, 2], [cloud, CLOUD_MODEL, 16]] as const) {
      const r = await pull(k, slots);
      if (!r.id || !r.taskId) continue;
      any = true;
      await finish(k, r.taskId, r.id, model);
    }
    if (!any) break;
  }
}

/** Pull as `k` every 50 ms until it gets a call (or `ms` passes). */
async function pullUntil(k: PeerKeys, slots: number, ms: number): Promise<{ id: string | null; taskId: string | null; afterMs: number }> {
  const t0 = Date.now();
  for (;;) {
    const r = await pull(k, slots);
    if (r.id || Date.now() - t0 > ms) return { ...r, afterMs: Date.now() - t0 };
    await sleep(50);
  }
}

beforeEach(async () => {
  routing.setPeerWorldSource(undefined);
  routing.clearPeerRedirects();
  await drain();
});



/** Read the call's stream until it ends; the time from `t0` and the last answer. */
async function waitForEnd(taskId: string, subtaskId: string, t0: number) {
  let r = await read(taskId, subtaskId);
  for (let i = 0; i < 120 && r.statusCode === 200 && !r.json().done; i++) {
    await sleep(20);
    r = await read(taskId, subtaskId);
  }
  return { r, ms: Date.now() - t0 };
}

describe("run 14, 1: after a move that is not claimed, the cloud before a refusal", () => {
  test("inf-1795679848520-2a6a2a54: Mac (no claim), moved to a ready CPU host (no claim): the cloud takes it (was: refused at 1.88 s, cloud 16/16 free)", async () => {
    // Two slots on each CPU host and a short reply: best fit counts them as room that finishes in time.
    for (const k of [lhr, fra]) expect((await pull(k, 2)).id).toBeNull();
    const t0 = Date.now();
    const c = await submitAuto({ maxTokens: 64 });
    expect(c.r.statusCode, c.r.body).toBe(200);
    // As in the run: placed on the Mac's 9b; the Mac reports free slots and never pulls the call.
    expect(c.r.json().model).toBe(MAC_MODEL);
    // The CPU hosts are ready (pulled just now, a free slot) but do not come either; only the cloud pulls.
    const got = await pullUntil(cloud, 16, DECISION_MS * 4);
    expect(got.id).toBe(c.subtaskId);
    const p = autoReplace.autoPlacementOf(c.subtaskId);
    expect(p.tried[0]).toBe(mac.peerId);
    expect([lhr.peerId, fra.peerId]).toContain(p.tried[1]);
    expect(p.tried.at(-1)).toBe(cloud.peerId);
    expect(ctx.usagePending.get(c.taskId)?.model).toBe(CLOUD_MODEL);
    // Moved to the cloud at the call's bound (1.2 windows), not later.
    expect(got.afterMs).toBeLessThan(DECISION_MS * autoReplace.AUTO_DECISION_BOUND + 300);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(DECISION_MS * autoReplace.AUTO_DECISION_BOUND - 50);
    await finish(cloud, c.taskId, c.subtaskId, CLOUD_MODEL);
    for (const k of [lhr, fra]) await pull(k, 1);
  });

  test("the cloud full too: refused at the bound (1.2 windows), not later", async () => {
    expect((await pullCloud(0)).id).toBeNull();
    const t0 = Date.now();
    const c = await submitAuto();
    expect(c.r.json().model).toBe(MAC_MODEL);
    const { r, ms } = await waitForEnd(c.taskId, c.subtaskId, t0);
    expect(r.statusCode).toBe(503);
    expect(ms).toBeLessThan(DECISION_MS * autoReplace.AUTO_DECISION_BOUND + 150);
  });
});

describe("run 14, 2: named refusals within 1.2 windows of the submit, the wait for a ready host included", () => {
  test("inf-1795680063689-c0863702: a ready host that never claims: refused by 1.2 windows (was: 1.5 windows, 2.25 s)", async () => {
    const inference = await import("../../src/swarm/coordinator/routes/inference.js");
    const t0 = Date.now();
    const c = await submit({ model: MODEL });
    expect(c.r.statusCode, c.r.body).toBe(200);
    // lhr and fra pulled just now with a free slot ("ready") and do not pull again.
    const { r, ms } = await waitForEnd(c.taskId, c.subtaskId, t0);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: "no_capacity", reason: "busy" });
    // It waited for the ready hosts after the first window, but only to the bound.
    expect(ms).toBeGreaterThanOrEqual(DECISION_MS);
    expect(ms).toBeLessThan(DECISION_MS * inference.CLAIM_DECISION_BOUND + 150);
  });

  test("inf-1795680081294-bf1e872f: a call another coordinator sent on (redirected) is decided within one window", async () => {
    const inference = await import("../../src/swarm/coordinator/routes/inference.js");
    const t0 = Date.now();
    const c = await submit({ model: MODEL, redirected: true });
    expect(c.r.statusCode, c.r.body).toBe(200);
    const { r, ms } = await waitForEnd(c.taskId, c.subtaskId, t0);
    expect(r.statusCode).toBe(503);
    expect(ms).toBeLessThan(DECISION_MS * (inference.CLAIM_DECISION_BOUND - inference.REDIRECT_ALLOWANCE) + 150);
  });

  test("the nearest host held for it does not come within the window: another ready host may take it before the bound", async () => {
    const c = await submit({ model: MODEL, clientRegion: "lhr" });
    expect(dispatch.preferredAgentFor(c.subtaskId)).toBe(lhr.peerId);
    // Within the hold, fra (also ready) leaves it to lhr.
    expect((await pull(fra)).id).toBeNull();
    await sleep(DECISION_MS + 50);
    // lhr has not come; the decision ended the hold, so fra takes it inside the bound.
    expect(dispatch.preferredAgentFor(c.subtaskId)).toBeUndefined();
    expect((await pull(fra)).id).toBe(c.subtaskId);
  });

  test("a ready host that claims during the wait still gets the call", async () => {
    const c = await submit({ model: MODEL });
    await sleep(DECISION_MS + 50);
    expect(ctx.queue.isUnclaimed(c.subtaskId)).toBe(true);
    const got = (await pull(lhr)).id ?? (await pull(fra)).id;
    expect(got).toBe(c.subtaskId);
  });
});
