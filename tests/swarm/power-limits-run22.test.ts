import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { grantCredits } from "../../src/credits/store.js";
import { evaluateAgentPowerPolicy, powerAllowsTask, SMALL_TASK_MAX_TIMEOUT_MS } from "../../src/swarm/power-policy.js";

/*
 * Network run 22 (desktop-maw-mb-02, a Mac laptop on a low battery: laptop_battery_low): it still
 * counted as a free Apple host for 1.5b calls, so the portal's latency rule kept sending lhr/fra
 * buyers' calls to it. /pull let it claim each one, then handed it back (power_small_task_filter, 39
 * times); the claim had spent the call's locality hold and a distant CPU host took it
 * (inf-1795742684105-60f32074: fra -> lax). Now its power state is judged wherever a host is free or
 * ready for a call, the heartbeat says which jobs it takes, and a call held for it before its battery
 * went low is held next for the nearest host that can take it.
 */

const MESH = "mesh-secret-power-run22";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.52";
const MODEL = "qwen-power22:1.5b";
let portal: Server;
let app: any;
let dispatch: any;
let routing: any;
let locality: any;
const requester = createPeerKeys("agent-power22-requester");
const mac = createPeerKeys("agent-power22-mac-fra");
const lhr = createPeerKeys("agent-power22-lhr");
const lax = createPeerKeys("agent-power22-lax");

const LOW = { onACPower: false, batteryPct: 30, deviceType: "laptop" as const };
const PLUGGED = { onACPower: true, batteryPct: 30, deviceType: "laptop" as const };

function signed(url: string, payload: string, k: PeerKeys) {
  return signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: k.privateKeyPem, agentId: k.peerId }) as unknown as Record<string, string>;
}
function post(url: string, body: unknown, k: PeerKeys) {
  const payload = JSON.stringify(body);
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed(url, payload, k) }, payload });
}
async function register(k: PeerKeys, region: string, os: string, extra: Record<string, unknown> = {}) {
  const payload = JSON.stringify({ os, version: "1", mode: "swarm-only", agentId: k.peerId, registrationToken: VALID_TOKEN, publicKeyPem: k.publicKeyPem, sandboxMode: "docker", installedModels: [MODEL], region, ...extra });
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed("/register", payload, k) }, payload });
  expect(res.statusCode, res.body).toBe(200);
}
const heartbeat = async (k: PeerKeys, powerTelemetry: Record<string, unknown>) => {
  const res = await post("/heartbeat", { agentId: k.peerId, powerTelemetry }, k);
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const pull = async (k: PeerKeys) => {
  const r = (await post("/pull", { agentId: k.peerId, inferenceSlots: 2, freeInferenceSlots: 2 }, k)).json();
  return (r.subtask?.id ?? r.envelope?.subtaskId ?? null) as string | null;
};
const submit = async (clientRegion: string, timeoutMs = 60_000) => {
  const taskId = `inf-${randomUUID()}`;
  const r = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, timeoutMs, clientRegion, messages: [{ role: "user", content: "hi" }] }, requester);
  expect(r.statusCode, r.body).toBe(200);
  return { taskId, sub: r.json().subtaskId as string };
};
const finish = async (k: PeerKeys, taskId: string, subtaskId: string) => {
  expect((await post("/inference/chunks", { subtaskId, seq: 0, delta: "ok", done: true, promptTokens: 3, outputTokens: 1 }, k)).statusCode).toBe(200);
  expect((await post("/result", { subtaskId, taskId, agentId: k.peerId, ok: true, output: "ok", durationMs: 100, model: MODEL }, k)).statusCode).toBe(200);
};
const freeHostsRow = async () => {
  const res = await app.inject({ method: "GET", url: "/inference/models", remoteAddress: REMOTE, headers: { "x-mesh-token": MESH } });
  return res.json().models.find((m: { model: string }) => m.model === MODEL);
};

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
  process.env.INFERENCE_COMPLETION_PRIOR_SPEED = "off";
  process.env.COORDINATOR_STARTUP_GRACE_MS = "0";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  dispatch = await import("../../src/swarm/coordinator/dispatch.js");
  routing = await import("../../src/swarm/coordinator/routing.js");
  locality = await import("../../src/swarm/coordinator/locality.js");
  await app.ready();
  await register(requester, "iad", "linux", { installedModels: [] });
  await register(mac, "fra", "macos", { powerTelemetry: LOW });
  await register(lhr, "lhr", "linux");
  await register(lax, "lax", "linux");
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
  for (const k of [mac, lhr, lax]) expect(await pull(k)).toBeNull();
}, 60_000);

afterAll(async () => {
  delete process.env.COORDINATOR_STARTUP_GRACE_MS;
  delete process.env.INFERENCE_COMPLETION_PRIOR_SPEED;
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

describe("power policy: which jobs a small-tasks-only host takes", () => {
  test("a laptop on a low battery takes jobs up to SMALL_TASK_MAX_TIMEOUT_MS, so no model call", () => {
    const d = evaluateAgentPowerPolicy({ os: "macos", telemetry: LOW, nowMs: 0, batteryPullMinIntervalMs: 0, batteryTaskStopLevelPct: 0 });
    expect(d).toMatchObject({ allowSmallTasksOnly: true, maxTaskTimeoutMs: SMALL_TASK_MAX_TIMEOUT_MS, reason: "laptop_battery_low" });
    expect(powerAllowsTask(d, 5_000)).toBe(true);
    expect(powerAllowsTask(d, 60_000)).toBe(false);
    expect(powerAllowsTask(d, undefined)).toBe(false);
    const plugged = evaluateAgentPowerPolicy({ os: "macos", telemetry: PLUGGED, nowMs: 0, batteryPullMinIntervalMs: 0, batteryTaskStopLevelPct: 0 });
    expect(powerAllowsTask(plugged, 60_000)).toBe(true);
    expect(powerAllowsTask(undefined, 60_000)).toBe(true);
    // A high-CPU deferral is not a refusal (the next pull takes it).
    expect(powerAllowsTask({ allowCoordinatorTasks: true, allowPeerDirectWork: true, deferMs: 5000, reason: "high_cpu_defer" }, 60_000)).toBe(true);
  });
});

describe("a host on a low battery is not free for model calls", () => {
  test("its heartbeat reply says it takes small jobs only", async () => {
    const hb = await heartbeat(mac, LOW);
    expect(hb.power).toEqual({ acceptsTasks: true, acceptsModelCalls: false, smallTasksOnly: true, maxTaskTimeoutMs: SMALL_TASK_MAX_TIMEOUT_MS, reason: "laptop_battery_low" });
    expect((await heartbeat(lhr, {})).power).toMatchObject({ acceptsModelCalls: true, smallTasksOnly: false });
  });

  test("/inference/models leaves it out of the free hosts (the portal's latency rule)", async () => {
    const row = await freeHostsRow();
    expect(row.freeHosts.map((h: { region: string }) => h.region).sort()).toEqual(["lax", "lhr"]);
    expect([...row.freeRegions].sort()).toEqual(["lax", "lhr"]);
  });

  test("best fit and locality leave it out; claim readiness says no room", async () => {
    expect(routing.localAgentViews().map((v: { agentId: string }) => v.agentId)).not.toContain(mac.peerId);
    expect(routing.agentPerf(mac.peerId).freeSlots).toBe(0);
    expect(locality.freeLocalHolders(MODEL, "any", 0).map((h: { agentId: string }) => h.agentId)).not.toContain(mac.peerId);
    const { taskId, sub } = await submit("fra");
    // The fra buyer's call is held for lhr, the nearest host that can take it, not the fra laptop.
    expect(dispatch.preferredAgentFor(sub)).toBe(lhr.peerId);
    const st = (await import("../../src/swarm/coordinator/context.js")).queue.getSubtask(sub);
    expect(dispatch.claimReadiness(mac.peerId, st)).toBe("no_room");
    // The laptop never claims it (no claim and hand-back), lax leaves it to lhr.
    expect(await pull(mac)).toBeNull();
    expect(await pull(lax)).toBeNull();
    expect(await pull(lhr)).toBe(sub);
    await finish(lhr, taskId, sub);
  });

  test("a call held for it before its battery went low is held next for the nearest host that can take it", async () => {
    await heartbeat(mac, PLUGGED);
    expect((await freeHostsRow()).freeHosts.map((h: { region: string }) => h.region).sort()).toEqual(["fra", "lax", "lhr"]);
    const failBefore = routing.agentFailRate(mac.peerId) ?? 0;
    const placed = [];
    for (let i = 0; i < 2; i++) {
      await heartbeat(mac, PLUGGED);
      const p = await submit("fra");
      expect(dispatch.preferredAgentFor(p.sub)).toBe(mac.peerId);
      placed.push(p);
    }
    // Its battery goes low; at its next pull it takes neither, and each is held for lhr instead.
    await heartbeat(mac, LOW);
    expect(await pull(mac)).toBeNull();
    for (const p of placed) expect(dispatch.preferredAgentFor(p.sub)).toBe(lhr.peerId);
    expect(await pull(lax)).toBeNull();
    // Both refusals count as failed calls for the host (#621 FREE_HOST_MAX_FAIL_RATE).
    expect(routing.agentFailRate(mac.peerId)).toBeGreaterThan(failBefore);
    expect(routing.agentFailRate(mac.peerId)).toBeGreaterThanOrEqual(0.5);
    const got = [await pull(lhr), await pull(lhr)].filter(Boolean).sort();
    expect(got).toEqual(placed.map((p) => p.sub).sort());
    for (const p of placed) await finish(lhr, p.taskId, p.sub);
  });

  test("plugged in again, it takes model calls", async () => {
    await heartbeat(mac, PLUGGED);
    const { taskId, sub } = await submit("fra");
    expect(await pull(mac)).toBe(sub);
    await finish(mac, taskId, sub);
  });
});
