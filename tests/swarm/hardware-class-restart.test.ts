import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import type { HardwareVerificationRecord } from "../../src/swarm/hardware-verification.js";

/*
 * Live regtest, 2026-11-16: after coordinator redeploys, Apple-silicon Macs showed as CPU · cpu.std
 * and a verified 2×A16 GPU agent fell to cpu, until its next full registration and a new challenge.
 * The agent, offline while the coordinator restarted, re-registered from its reconnect probe with a
 * short body (no hardware profile, no challenge kinds): the coordinator classified that as cpu.std and
 * the verifier reset the stored grant for the "changed" hardware.
 *
 * Here: real coordinator app (Fastify inject), agents register in full, the verifier's records are
 * persisted as Postgres would hold them, the coordinator restarts (fresh modules, records loaded like
 * init.ts does), and the agents re-register with the short body older agents still send.
 */

const ADMIN = "admin-secret-hw-restart";
const MESH = "mesh-secret-hw-restart";

type Coordinator = {
  app: any;
  economy: typeof import("../../src/swarm/coordinator/economy.js");
  state: typeof import("../../src/swarm/coordinator/agent-state.js");
};

async function boot(persisted?: HardwareVerificationRecord[]): Promise<Coordinator> {
  vi.resetModules();
  const app = (await import("../../src/swarm/coordinator.js")).coordinatorServer;
  const economy = await import("../../src/swarm/coordinator/economy.js");
  const state = await import("../../src/swarm/coordinator/agent-state.js");
  if (persisted) economy.hardwareVerifier.load(structuredClone(persisted)); // init.ts: listHardwareVerifications()
  await app.ready();
  return { app, economy, state };
}

const MAC = { agentId: "desktop-mac-hw-restart", keys: createPeerKeys("desktop-mac-hw-restart") as PeerKeys };
const GPU = { agentId: "gpu-a16-hw-restart", keys: createPeerKeys("gpu-a16-hw-restart") as PeerKeys };
const MAC_PROFILE = { cpuCores: 12, cpuModel: "Apple M3 Max", ramGb: 64, arch: "arm64", platform: "darwin", gpu: { vendor: "apple", model: "Apple M3 Max", vramGb: 64, datacenter: false } };
const GPU_PROFILE = { cpuCores: 24, cpuModel: "AMD EPYC", ramGb: 128, arch: "x64", platform: "linux", gpu: { vendor: "nvidia", model: "NVIDIA A16", vramGb: 30, datacenter: true, count: 2 } };

function post(c: Coordinator, agent: { agentId: string; keys: PeerKeys }, path: string, body: Record<string, unknown>) {
  const payload = JSON.stringify({ agentId: agent.agentId, ...body });
  const signed = signRequest({ method: "POST", path, bodyHash: hashRequestBody(payload), privateKeyPem: agent.keys.privateKeyPem, agentId: agent.agentId }) as unknown as Record<string, string>;
  // Loopback: the portal's activation check is not what this test is about.
  return c.app.inject({ method: "POST", url: path, remoteAddress: "127.0.0.1", headers: { "content-type": "application/json", "x-mesh-token": MESH, ...signed }, payload });
}

/** The full /register body (worker-runner's buildRegisterBody). */
const fullRegister = (agent: { keys: PeerKeys }, hardwareProfile: Record<string, unknown>) => ({
  os: hardwareProfile.platform === "darwin" ? "macos" : "linux", version: "1.0.0", mode: "swarm-only", localModelProvider: "ollama-local",
  maxConcurrentTasks: 1, publicKeyPem: agent.keys.publicKeyPem, hardwareProfile, challengeKinds: ["cpu", "gpu"]
});
/** What the reconnect probe of agents up to this fix sends (desktop 1.4.37–1.4.39 included). */
const probeRegister = (agent: { keys: PeerKeys }, os: string) => ({ os, version: "0.1.0", mode: "swarm-only", localModelProvider: "ollama-local", maxConcurrentTasks: 1, publicKeyPem: agent.keys.publicKeyPem });

async function networkRow(c: Coordinator, agentId: string) {
  const res = await c.app.inject({ method: "GET", url: "/admin/network?range=1h", headers: { "x-admin-token": ADMIN } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().agents.find((a: { agentId: string }) => a.agentId === agentId);
}

let before: Coordinator;
let after: Coordinator;
let persisted: HardwareVerificationRecord[] = [];

beforeAll(async () => {
  Object.assign(process.env, { ADMIN_API_TOKEN: ADMIN, MESH_AUTH_TOKEN: MESH, BITCOIN_NETWORK: "signet", LIGHTNING_PROVIDER: "mock" });
  delete process.env.DATABASE_URL;
  delete process.env.HARDWARE_VERIFICATION;
  before = await boot();
}, 60_000);

afterAll(async () => {
  await before?.app?.close();
  await after?.app?.close();
  delete process.env.ADMIN_API_TOKEN;
});

describe("hardware class across a coordinator restart", () => {
  test("before the restart: full registrations claim apple.m.hi and gpu.dc40; the GPU proves it", async () => {
    expect((await post(before, MAC, "/register", fullRegister(MAC, MAC_PROFILE))).statusCode).toBe(200);
    expect((await post(before, GPU, "/register", fullRegister(GPU, GPU_PROFILE))).statusCode).toBe(200);
    // The GPU passed its challenge (the verifier's own path is covered in hardware-verification.test.ts).
    const rec = before.economy.hardwareVerifier.get(GPU.agentId)!;
    expect(rec.claimed.tier).toBe("gpu.dc40");
    Object.assign(rec, { status: "verified", granted: { computeClass: "gpu.dc", tier: "gpu.dc40" }, lastPassAtMs: Date.now(), nextChallengeAtMs: Date.now() + 3_600_000 });

    expect(await networkRow(before, MAC.agentId)).toMatchObject({ computeClass: "apple", tier: "apple.m", claimedTier: "apple.m.hi", verification: "unverified" });
    expect(await networkRow(before, GPU.agentId)).toMatchObject({ computeClass: "gpu.dc", tier: "gpu.dc40", claimedTier: "gpu.dc40", verification: "verified" });
    // What Postgres holds (upsertHardwareVerification stores the record as JSON).
    persisted = JSON.parse(JSON.stringify(before.economy.hardwareVerifier.list()));
    expect(persisted.find((r) => r.agentId === MAC.agentId)?.profile).toMatchObject({ platform: "darwin", arch: "arm64" });
  });

  test("after the restart: a probe re-registration without a profile keeps apple / gpu.dc (and the GPU's proven tier)", async () => {
    await before.app.close();
    after = await boot(persisted);
    expect(after.state.agentCapabilities.has(MAC.agentId)).toBe(false); // fresh process state

    const mac = await post(after, MAC, "/register", probeRegister(MAC, "macos"));
    expect(mac.statusCode, mac.body).toBe(200);
    expect(mac.json().hardwareVerification).toMatchObject({ grantedClass: "apple", grantedTier: "apple.m", claimedTier: "apple.m.hi" });
    const gpu = await post(after, GPU, "/register", probeRegister(GPU, "linux"));
    expect(gpu.statusCode, gpu.body).toBe(200);
    expect(gpu.json().hardwareVerification).toMatchObject({ status: "verified", grantedClass: "gpu.dc", grantedTier: "gpu.dc40" });

    expect(await networkRow(after, MAC.agentId)).toMatchObject({ computeClass: "apple", tier: "apple.m", claimedTier: "apple.m.hi" });
    expect(await networkRow(after, GPU.agentId)).toMatchObject({ computeClass: "gpu.dc", tier: "gpu.dc40", verification: "verified" });
    // The challenge kinds survive too, so the Mac is still challenged for its claim.
    expect(after.economy.hardwareVerifier.get(MAC.agentId)?.challengeKinds).toEqual(["cpu", "gpu"]);

    // The next full registration (same hardware) changes nothing.
    expect((await post(after, GPU, "/register", fullRegister(GPU, GPU_PROFILE))).json().hardwareVerification).toMatchObject({ status: "verified", grantedTier: "gpu.dc40" });
  });

  test("anti-spoofing: a kept claim without proof is paid at its class base tier, never above", async () => {
    // The Mac claims apple.m.hi but never proved it: base tier apple.m, weight 1.
    const eff = after.economy.effectiveHardware(MAC.agentId)!;
    expect(eff).toMatchObject({ computeClass: "apple", tier: "apple.m", creditsPerSecond: 1 });
    // A GPU claim whose stored grant is not fresh is re-proven after the restart, at the class base meanwhile.
    const stale = JSON.parse(JSON.stringify(persisted)) as HardwareVerificationRecord[];
    const g = stale.find((r) => r.agentId === GPU.agentId)!;
    g.lastPassAtMs = Date.now() - 7 * 3_600_000;
    await after.app.close();
    after = await boot(stale);
    const res = await post(after, GPU, "/register", probeRegister(GPU, "linux"));
    expect(res.json().hardwareVerification).toMatchObject({ status: "unverified", grantedClass: "gpu.dc", claimedTier: "gpu.dc40" });
    const effGpu = after.economy.effectiveHardware(GPU.agentId)!;
    expect(effGpu.computeClass).toBe("gpu.dc");
    expect(effGpu.creditsPerSecond).toBe(1);
  });

  test("an agent never seen before still registers as cpu.std without a profile", async () => {
    const fresh = { agentId: "no-profile-hw-restart", keys: createPeerKeys("no-profile-hw-restart") as PeerKeys };
    const res = await post(after, fresh, "/register", probeRegister(fresh, "linux"));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().hardwareVerification).toMatchObject({ status: "base", grantedClass: "cpu", grantedTier: "cpu.std" });
  });
});
