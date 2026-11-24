import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { grantCredits } from "../../src/credits/store.js";
import { refusesCoordinatorJobs } from "../../src/swarm/power-policy.js";

/*
 * The iPhone hosts only over Bluetooth for nearby machines. A coordinator hands an iOS agent no
 * coordinator job: /pull answers like an idle pull (200, subtask null) so an older app that still
 * polls neither gets work nor retries hot, while a desktop agent pulling right after gets the job.
 */

const MESH = "mesh-secret-ios-pull";
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.45";
const MODEL = "qwen-iospull:1b";
let portal: Server;
let app: any;
const requester = createPeerKeys("agent-iospull-requester");
const phone = createPeerKeys("iphone-iospull-phone");
const desktop = createPeerKeys("agent-iospull-desktop");

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
  // What the iOS app sends at /register (SwarmRuntimeController.registerAgent), on external power.
  await register(phone, {
    os: "ios", clientType: "edgecoder-ios", localModelProvider: "ollama-local", maxConcurrentTasks: 1, installedModels: [MODEL],
    powerTelemetry: { onExternalPower: true, batteryLevelPct: 90, lowPowerMode: false, updatedAtMs: Date.now() },
  });
  await register(desktop, { os: "linux", installedModels: [MODEL] });
  await grantCredits(requester.peerId, 1_000_000, "test_funding");
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

describe("refusesCoordinatorJobs", () => {
  test("matches iOS agents by os or by the iOS app's clientType, and nothing else", () => {
    expect(refusesCoordinatorJobs({ os: "ios", clientType: "edgecoder-ios" })).toBe(true);
    expect(refusesCoordinatorJobs({ os: "ios", clientType: "mesh-phone" })).toBe(true);
    expect(refusesCoordinatorJobs({ os: "macos", clientType: "edgecoder-ios" })).toBe(true);
    expect(refusesCoordinatorJobs({ os: "macos", clientType: "edgecoder-native" })).toBe(false);
    expect(refusesCoordinatorJobs({ os: "linux" })).toBe(false);
    expect(refusesCoordinatorJobs(undefined)).toBe(false);
  });
});

describe("/pull for an iOS agent", () => {
  test("an iPhone gets no job (an idle 200, not an error) and the job stays for a desktop agent", async () => {
    const taskId = `inf-${randomUUID()}`;
    const submit = await post("/inference/submit", { taskId, submitterAccountId: requester.peerId, model: MODEL, messages: [{ role: "user", content: "hi" }], timeoutMs: 60_000 }, requester);
    expect(submit.statusCode, submit.body).toBe(200);
    const subtaskId = submit.json().subtaskId;

    const phonePull = await post("/pull", { agentId: phone.peerId }, phone);
    expect(phonePull.statusCode, phonePull.body).toBe(200);
    expect(phonePull.json()).toEqual({ subtask: null, reason: "ios_bluetooth_only" });

    const desktopPull = await post("/pull", { agentId: desktop.peerId }, desktop);
    expect(desktopPull.statusCode, desktopPull.body).toBe(200);
    expect(desktopPull.json().subtask?.id).toBe(subtaskId);
  }, 30_000);

  test("an iPhone still heartbeats (BLE online/offline detection relies on it)", async () => {
    const res = await post("/heartbeat", { agentId: phone.peerId, powerTelemetry: { onExternalPower: true, batteryLevelPct: 90, lowPowerMode: false, updatedAtMs: Date.now() } }, phone);
    expect(res.statusCode, res.body).toBe(200);
  });
});
