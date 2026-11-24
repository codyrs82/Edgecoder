import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { grantCredits } from "../../src/credits/store.js";
import { iosAgentNotCharging, isIosAgent } from "../../src/swarm/power-policy.js";

/*
 * An iPhone takes coordinator jobs only while it is on external power. /pull from an iOS agent whose
 * latest power telemetry (from /register or /heartbeat) is not on external power, or that sent none,
 * answers like an idle pull (200, subtask null, powerDeferred), so an older app that pulls on battery
 * neither gets work nor retries hot. Plugged in, the same phone gets the job.
 */

const MESH = "mesh-secret-ios-pull";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.45";
const MODEL = "qwen-iospull:1b";
let portal: Server;
let app: any;
const requester = createPeerKeys("agent-iospull-requester");
const phone = createPeerKeys("iphone-iospull-phone");
const silentPhone = createPeerKeys("iphone-iospull-silent");
const desktop = createPeerKeys("agent-iospull-desktop");

const battery = (onExternalPower: boolean) => ({ onExternalPower, batteryLevelPct: 90, lowPowerMode: false, updatedAtMs: Date.now() });
const IDLE = { subtask: null, powerDeferred: true, reason: "ios_not_charging" };

function signedHeaders(path: string, payload: string, keys: PeerKeys): Record<string, string> {
  return signRequest({ method: "POST", path, bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
}

function post(url: string, body: unknown, signer: PeerKeys) {
  const payload = JSON.stringify(body);
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signedHeaders(url, payload, signer) }, payload });
}

async function register(keys: PeerKeys, extra: Record<string, unknown>) {
  const payload = JSON.stringify({
    version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem,
    sandboxMode: "docker", ...extra,
  });
  const res = await app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signedHeaders("/register", payload, keys) }, payload });
  expect(res.statusCode, res.body).toBe(200);
}

async function heartbeat(keys: PeerKeys, onExternalPower: boolean) {
  const res = await post("/heartbeat", { agentId: keys.peerId, powerTelemetry: battery(onExternalPower) }, keys);
  expect(res.statusCode, res.body).toBe(200);
}

async function submitJob(): Promise<string> {
  const res = await post("/inference/submit", { taskId: `inf-${randomUUID()}`, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, requester);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().subtaskId;
}

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
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.MESH_PEER_ALLOWLIST;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  await register(requester, { os: "linux" });
  // What the iOS app sends at /register (SwarmRuntimeController.registerAgent), here unplugged.
  await register(phone, {
    os: "ios", clientType: "edgecoder-ios", localModelProvider: "ollama-local", maxConcurrentTasks: 1, installedModels: [MODEL],
    powerTelemetry: battery(false),
  });
  await register(silentPhone, { os: "ios", clientType: "edgecoder-ios", maxConcurrentTasks: 1, installedModels: [MODEL] });
  await register(desktop, { os: "linux", installedModels: [MODEL] });
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

describe("iosAgentNotCharging", () => {
  test("only iOS agents not reporting external power are held back; missing telemetry counts as not charging", () => {
    expect(iosAgentNotCharging({ os: "ios", clientType: "edgecoder-ios", powerTelemetry: { onExternalPower: true } })).toBe(false);
    expect(iosAgentNotCharging({ os: "ios", clientType: "edgecoder-ios", powerTelemetry: { onExternalPower: false } })).toBe(true);
    expect(iosAgentNotCharging({ os: "ios", clientType: "edgecoder-ios" })).toBe(true);
    expect(iosAgentNotCharging({ os: "ios", clientType: "mesh-phone" })).toBe(true);
    expect(iosAgentNotCharging({ os: "macos", clientType: "edgecoder-ios", powerTelemetry: {} })).toBe(true);
    // Desktop agents are untouched, battery or not (their own power policy applies).
    expect(iosAgentNotCharging({ os: "macos", clientType: "edgecoder-native", powerTelemetry: { onACPower: false } })).toBe(false);
    expect(iosAgentNotCharging({ os: "linux" })).toBe(false);
    expect(iosAgentNotCharging(undefined)).toBe(false);
    expect(isIosAgent({ os: "ios" })).toBe(true);
    expect(isIosAgent({ os: "linux", clientType: "edgecoder-native" })).toBe(false);
  });
});

describe("/pull for an iOS agent", () => {
  test("on battery: an idle 200, not an error, and the job goes to a desktop agent", async () => {
    const subtaskId = await submitJob();
    const phonePull = await post("/pull", { agentId: phone.peerId }, phone);
    expect(phonePull.statusCode, phonePull.body).toBe(200);
    expect(phonePull.json()).toEqual(IDLE);
    const desktopPull = await post("/pull", { agentId: desktop.peerId }, desktop);
    expect(desktopPull.json().subtask?.id).toBe(subtaskId);
  }, 30_000);

  test("no power telemetry at all counts as not charging", async () => {
    const res = await post("/pull", { agentId: silentPhone.peerId }, silentPhone);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual(IDLE);
  });

  test("plugged in (latest heartbeat), the phone gets the job; unplugged again, it does not", async () => {
    await heartbeat(phone, true);
    const first = await submitJob();
    const charging = await post("/pull", { agentId: phone.peerId }, phone);
    expect(charging.statusCode, charging.body).toBe(200);
    expect(charging.json().subtask?.id).toBe(first);

    await heartbeat(phone, false);
    const second = await submitJob();
    const unplugged = await post("/pull", { agentId: phone.peerId }, phone);
    expect(unplugged.json()).toEqual(IDLE);
    expect((await post("/pull", { agentId: desktop.peerId }, desktop)).json().subtask?.id).toBe(second);
  }, 30_000);
});
