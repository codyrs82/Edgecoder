import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { creditEngine, grantCredits } from "../../src/credits/store.js";

/*
 * Network validation run 18, outage test 3b (main f6d5faeb): the US seed restarted; its agents moved
 * to the EU seed within ~2-10 s, came home at ~41 s, yet 17 of 130 named qwen2.5-coder:1.5b probes
 * (US buyers) were refused "every machine ... is busy" from +0.6 s to +54.7 s (run 16: 1 of 130).
 *
 * The agents that moved were still running calls the US seed had given them (those stay pinned to
 * their issuer). The EU seed holds none of those claims, so it counted them free, and a busy 1-slot
 * host does not pull. Locality held each US buyer's call 2 s (LOCALITY_PREFER_MS) for the US host
 * nearest the buyer, which never came; the claim decision released the hold at its 1.5 s window
 * with ~0.1 s left of its 1.6 s bound (#609/#611), too little for a host across the Atlantic to pull.
 * After the return home the same happened at the US seed, with calls pinned to the EU one.
 * A host that has not pulled here lately is no longer held a call for (locality.ts nearestFreeHolder).
 * (Harness as in run18-coord.test.ts.)
 */

const MESH = "mesh-secret-run18";
const REMOTE = "203.0.113.117";
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
const requester = createPeerKeys("agent-run18-requester");
const lhr = createPeerKeys("agent-run18-lhr");
const fra = createPeerKeys("agent-run18-fra");
const cloud = createPeerKeys("agent-run18-cloud");
const mac = createPeerKeys("agent-run18-mac");
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





describe("run 18, outage 3b: moved agents on the peer during a planned drain", () => {
  const iad = createPeerKeys("agent-run18-iad");
  const lax = createPeerKeys("agent-run18-lax");

  test("the host nearest the US buyer moved here busy with a call pinned to the draining seed (free by count, not pulling): the call is not held for it, and an idle moved host takes it on its next pull", async () => {
    // lhr and fra (EU's own) are busy; iad and lax just registered here for the drain.
    for (const k of [lhr, fra]) expect((await pull(k, 1, 0)).id).toBeNull();
    await register(iad, "token-host", { installedModels: [MODEL], region: "iad" });
    await register(lax, "token-host", { installedModels: [MODEL], region: "lax" });
    // lax is idle and pulls; iad runs the US seed's call and does not pull here (all_slots_busy).
    expect((await pull(lax, 1)).id).toBeNull();
    expect(dispatch.pulledWithin(iad.peerId, dispatch.PULL_FRESH_MS)).toBe(false);
    const c = await submit({ model: MODEL, clientRegion: "iad" });
    expect(c.r.statusCode, c.r.body).toBe(200);
    // Was: held 2 s for iad (nearest), lax's pulls returned nothing, refused at the 1.6 s bound.
    expect(dispatch.preferredAgentFor(c.subtaskId)).toBe(lax.peerId);
    const got = await pullUntil(lax, 1, 3_000);
    expect(got.id).toBe(c.subtaskId);
    expect(got.afterMs).toBeLessThan(DECISION_MS);
    await finish(lax, c.taskId, c.subtaskId);
    expect((await read(c.taskId, c.subtaskId)).json().done).toBe(true);
    for (const k of [iad, lax]) await post("/pull", { agentId: k.peerId, inferenceSlots: 1, freeInferenceSlots: 0 }, k);
  });

  test("once the moved host pulls here (its pinned call done), it is the nearest host again", async () => {
    for (const k of [lhr, fra]) expect((await pull(k, 1, 0)).id).toBeNull();
    // iad finished the call pinned to the other seed and pulls here now, with its slot free.
    await post("/pull", { agentId: lax.peerId, inferenceSlots: 1, freeInferenceSlots: 1 }, lax);
    await post("/pull", { agentId: iad.peerId, inferenceSlots: 1, freeInferenceSlots: 1 }, iad);
    const c = await submit({ model: MODEL, clientRegion: "iad" });
    expect(c.r.statusCode, c.r.body).toBe(200);
    expect(dispatch.preferredAgentFor(c.subtaskId)).toBe(iad.peerId);
    expect((await pull(lax, 1)).id).toBeNull();
    expect((await pull(iad, 1)).id).toBe(c.subtaskId);
    await finish(iad, c.taskId, c.subtaskId);
  });
});
