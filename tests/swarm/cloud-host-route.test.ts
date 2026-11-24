import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * Cloud hosts on the coordinator (src/swarm/coordinator/cloud-hosts.ts): a registration claiming the
 * cloud class is admitted only from CLOUD_HOST_OWNER_EMAILS; the cloud host advertises the cloud
 * model ids in the `cloud` class ("glm-5.3 · cloud") with their cost-plus price and origin; no
 * other machine can advertise a cloud model id.
 */

const MESH = "mesh-secret-cloud-host";
const REMOTE = "203.0.113.90";
const OWNER = "ops@edgecoder.io";
let portal: Server;
let app: any;
let agentCapabilities: typeof import("../../src/swarm/coordinator/agent-state.js").agentCapabilities;
let effectiveHardware: typeof import("../../src/swarm/coordinator/economy.js").effectiveHardware;
const cloud = createPeerKeys("agent-cloud-fw-1");
const intruder = createPeerKeys("agent-cloud-intruder");
const ordinary = createPeerKeys("agent-ordinary-gpu");
const TOKENS: Record<string, { ownerEmail: string; hostApproved?: boolean }> = {
  "token-owner": { ownerEmail: OWNER, hostApproved: true },
  "token-intruder": { ownerEmail: "someone@example.com", hostApproved: true },
  "token-ordinary": { ownerEmail: "gpu-owner@example.com", hostApproved: true }
};

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
  process.env.CLOUD_HOST_OWNER_EMAILS = ` ${OWNER.toUpperCase()} `;
  process.env.CLOUD_MARGIN_PCT = "30";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  ({ agentCapabilities } = await import("../../src/swarm/coordinator/agent-state.js"));
  ({ effectiveHardware } = await import("../../src/swarm/coordinator/economy.js"));
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
  delete process.env.CLOUD_HOST_OWNER_EMAILS;
  delete process.env.CLOUD_MARGIN_PCT;
});

async function register(keys: PeerKeys, token: string, extra: Record<string, unknown>) {
  const payload = JSON.stringify({ os: "debian", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: token, publicKeyPem: keys.publicKeyPem, sandboxMode: "none", localModelProvider: "ollama-local", ...extra });
  const signed = signRequest({ method: "POST", path: "/register", bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url: "/register", remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed }, payload });
}

const cloudProfile = { platform: "linux", arch: "x64", cpuCores: 2, ramGb: 2, cloud: { provider: "fireworks" } };

describe("cloud hosts on the coordinator", () => {
  test("the owner's cloud host registers in the cloud class and advertises only the cloud model ids", async () => {
    const res = await register(cloud, "token-owner", { hardwareProfile: cloudProfile, installedModels: ["glm-5.3", "deepseek-v4.1-flash", "qwen3.5:4b"] });
    expect(res.statusCode, res.body).toBe(200);
    const cap = agentCapabilities.get(cloud.peerId)!;
    expect(cap.localModelCatalog).toEqual(["glm-5.3", "deepseek-v4.1-flash"]);
    expect(effectiveHardware(cloud.peerId)).toMatchObject({ computeClass: "cloud", tier: "cloud", creditsPerSecond: 1 });
  });

  test("anyone else claiming the cloud class is refused", async () => {
    const res = await register(intruder, "token-intruder", { hardwareProfile: cloudProfile, installedModels: ["glm-5.3"] });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "cloud_host_not_allowed" });
    expect(agentCapabilities.get(intruder.peerId)).toBeUndefined();
  });

  test("an ordinary machine cannot advertise a cloud model id", async () => {
    const res = await register(ordinary, "token-ordinary", { hardwareProfile: { platform: "linux", arch: "x64", cpuCores: 16, ramGb: 64, gpu: { vendor: "nvidia", model: "RTX 4090", vramGb: 24 } }, installedModels: ["glm-5.3", "qwen3-coder:30b"] });
    expect(res.statusCode, res.body).toBe(200);
    expect(agentCapabilities.get(ordinary.peerId)!.localModelCatalog).toEqual(["qwen3-coder:30b"]);
  });

  test("/inference/models lists glm-5.3 · cloud with its cost-plus price, window and origin", async () => {
    const res = await app.inject({ method: "GET", url: "/inference/models" });
    expect(res.statusCode).toBe(200);
    const models = res.json().models as Array<Record<string, any>>;
    const glm = models.find((m) => m.model === "glm-5.3")!;
    expect(glm).toMatchObject({ classes: ["cloud"], contextWindow: 1_000_000, origin: { vendor: "Z.ai (Zhipu AI)", country: "CN" }, hostedBy: "fireworks" });
    const ds = models.find((m) => m.model === "deepseek-v4.1-flash")!;
    expect(ds.classes).toEqual(["cloud"]);
    // Cost plus 30 %: GLM's output is 4.40 × 1.3 = 5.72 USD/M and its input 1.82 USD/M, in cSats at the live rate.
    expect(glm.cSatsPerMTokens.output / glm.cSatsPerMTokens.input).toBeCloseTo(5.72 / 1.82, 2);
    expect(glm.cSatsPerMTokens.cachedInput).toBeGreaterThan(0);
    // The GPU machine's qwen3-coder is listed under its own class, not cloud.
    expect(models.find((m) => m.model === "qwen3-coder:30b")?.classes).not.toContain("cloud");
    expect(models.find((m) => m.model === "glm-5.3" && m.classes.includes("gpu"))).toBeUndefined();
  });
});
