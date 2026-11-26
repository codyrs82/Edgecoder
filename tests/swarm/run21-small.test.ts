import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";

/*
 * Network validation run 21 (main cc54b465), each test replays a sequence from the run-21 logs.
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

const MESH = "mesh-secret-run21";
const REMOTE = "203.0.113.121";
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
const requester = createPeerKeys("agent-run21-requester");
const lhr = createPeerKeys("agent-run21-lhr");
const fra = createPeerKeys("agent-run21-fra");
const cloud = createPeerKeys("agent-run21-cloud");
const mac = createPeerKeys("agent-run21-mac");
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





describe("run 21, 1: a submit-time refusal says when the price ceiling kept the cloud out", () => {
  test("inf-1795733394312-f30ff6e4: best fit's pick has no slot to start it (here the Mac, out of CPU credit); the cloud is over the ceiling: 503 reason price with neededCSats (was: busy)", async () => {
    try {
      // The Mac (the only >= 7B host here) withholds its slots: it reported CPU steal.
      await post("/pull", { agentId: mac.peerId, inferenceSlots: 2, freeInferenceSlots: 0, cpuThrottled: true, cpuStealShare: 0.8, wake: true }, mac);
      const before = creditEngine.balance(requester.peerId);
      const t0 = Date.now();
      const c = await submit({ model: "auto", maxTokens: 1024, routing: { minParamsB: 7, maxCSats: 0.2 } });
      expect(Date.now() - t0).toBeLessThan(500);
      expect(c.r.statusCode, c.r.body).toBe(503);
      expect(c.r.json()).toMatchObject({ error: "no_capacity", reason: "price" });
      expect(c.r.json().neededCSats).toBeGreaterThan(0.2);
      expect(creditEngine.balance(requester.peerId)).toBe(before);
      // The client turns it into a price refusal a tentacle helper retries on.
      const { noCapacityError } = await import("../../src/apps/ide/network-inference.js");
      const { priceRefusalNeed } = await import("../../src/apps/ide/tentacle-reserve.js");
      expect(priceRefusalNeed(noCapacityError(c.r.json(), "auto"))).toBe(c.r.json().neededCSats);
      // Without the ceiling: the pick that cannot start is left out, and the cloud takes it at submit.
      const free = await submit({ model: "auto", maxTokens: 1024, routing: { minParamsB: 7 } });
      expect(free.r.statusCode, free.r.body).toBe(200);
      expect(free.r.json().model).toBe(CLOUD_MODEL);
      expect((await pullCloud()).id).toBe(free.subtaskId);
      await finish(cloud, free.taskId, free.subtaskId, CLOUD_MODEL);
    } finally {
      (await import("../../src/swarm/coordinator/host-steal.js")).clearAgentSteal();
      await pull(mac, 2);
    }
  });
});

describe("run 21, 2: a request over a size limit is a clean 413, nothing charged", () => {
  const raw = (body: Record<string, unknown>) => {
    const taskId = `inf-${randomUUID()}`;
    return post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, timeoutMs: 60_000, messages: [{ role: "user", content: "hi" }], ...body }, requester);
  };
  test("a prompt over 400,000 characters (was: 500, the portal said 503)", async () => {
    const before = creditEngine.balance(requester.peerId);
    const r = await raw({ messages: [{ role: "system", content: "s" }, { role: "user", content: "x".repeat(400_001) }] });
    expect(r.statusCode).toBe(413);
    expect(r.json()).toMatchObject({ error: "request_too_large", limit: "message_chars", size: 400_001, max: 400_000 });
    expect(r.json().message).toMatch(/message 2 has 400,001 characters, the limit is 400,000/);
    expect(creditEngine.balance(requester.peerId)).toBe(before);
  });
  test("too many messages, tools or tool calls: 413 naming the limit; another malformed field: 400", async () => {
    expect((await raw({ messages: Array.from({ length: 2001 }, () => ({ role: "user", content: "x" })) })).json()).toMatchObject({ error: "request_too_large", limit: "messages", size: 2001, max: 2000 });
    expect((await raw({ tools: Array.from({ length: 257 }, () => ({})) })).json()).toMatchObject({ error: "request_too_large", limit: "tools", size: 257 });
    expect((await raw({ messages: [{ role: "assistant", content: "", tool_calls: Array.from({ length: 65 }, () => ({})) }] })).json()).toMatchObject({ error: "request_too_large", limit: "tool_calls", size: 65 });
    const bad = await raw({ temperature: 9 });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_request" });
  });
});
