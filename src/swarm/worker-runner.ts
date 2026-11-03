// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { request } from "undici";
import WebSocket from "ws";
import { randomUUID, createHash } from "node:crypto";
import { cpus, hostname, totalmem } from "node:os";
import { parallelInferenceFor } from "./parallelism.js";
import { ProviderRegistry } from "../model/providers.js";
import { SwarmWorkerAgent } from "../agent/worker.js";
import { Subtask, SubtaskResult, BLETaskRequest, Language, MeshMessage, SandboxMode } from "../common/types.js";
import { execFileSync } from "node:child_process";
import { ensureSandboxImages, isDockerAvailable } from "../executor/docker-sandbox.js";
import { runInferenceSubtask } from "./inference-runner.js";
import { detectHardware, hardwareProfileFor, selectGpu, type Probe } from "../install/hardware.js";
import { enforceSandboxPolicy, resolveSandboxMode, swarmExecutionEnabled } from "./sandbox-enforcement.js";
import { isAgentNotRegisteredError, registerRefreshMsFromEnv, shouldRegister } from "./registration-policy.js";
import { createPeerKeys, signPayload } from "../mesh/peer.js";
import { signMeshWsBind } from "../mesh/ws-auth.js";
import { hashResultOutput, signReceiptAsAgent } from "../receipts/receipt.js";
import { withNetworkTrustDefaults } from "../trust/seed-keys.js";
import { CoordinatorTrustGate, PinnedKeyStore, challengePolicyFromEnv, describeTrustFailure, DEFAULT_TRUST_REVERIFY_MS } from "../trust/pinned-keys.js";
import { ActiveCoordinator, meshWsUrl } from "./active-coordinator.js";
import { createCoordinatorClient, CoordinatorResponseRejectedError } from "./coordinator-client.js";
import { ResponseVerifier, responseSigningPolicyFromEnv } from "../trust/response-signing.js";
import { checkSnapshotPolicy, envelopeResultPayload, parseSnapshotEnforcement } from "./execution-policy.js";
import { BleRequestGuard } from "../mesh/ble/ble-request-guard.js";
import { selectCoordinatorFromEnv } from "../discovery/index.js";
import { createCoordinatorSteering, registryUrlsFor, type SteeringResult } from "../discovery/steering.js";
import { registryPublicKeysFromEnv } from "../discovery/registry.js";
import { ensureOllamaModelInstalled, isOllamaLibraryModelName } from "../model/ollama-installer.js";
import { NobleBLETransport } from "../mesh/ble/noble-ble-transport.js";
import { BLEMeshManager } from "../mesh/ble/ble-mesh-manager.js";
import { localStore } from "../db/local-store.js";
import { hashRequestBody, signRequest } from "../security/request-signing.js";
import { generateX25519KeyPair, decryptTaskEnvelope, encryptResult, type TaskEnvelope } from "../security/envelope.js";
import { MeshPeer } from "../mesh/mesh-peer.js";
import { MeshHttpServer } from "../mesh/mesh-http-server.js";
import { getLocalIpAddress } from "../mesh/network-utils.js";
import { collectDesktopTelemetry } from "./desktop-telemetry.js";
import { detectPlatform, getConfigDir, getLogDir, type PlatformInfo } from "../common/platform.js";
import { computeDistHash, loadReleaseManifest, detectDistributionChannel } from "../security/release-integrity.js";
import { answerChallenge, runLocalBenchmark, type AgentBenchmarkReport, type BenchmarkChallenge } from "./benchmark.js";
import { createLocalForwarder } from "./local-forwarder.js";
import { resolveIdeToken } from "../apps/ide/ide-auth.js";

const platformInfo: PlatformInfo = detectPlatform();
const PLATFORM_CONFIG_DIR = process.env.EDGECODER_CONFIG_DIR ?? getConfigDir();
const PLATFORM_LOG_DIR = process.env.EDGECODER_LOG_DIR ?? getLogDir();
// Pinned-key trust (architecture step 4): TRUSTED_COORDINATOR_KEYS / EDGECODER_TRUST_FILE / EDGECODER_TRUST_MODE.
// On the edgecoder.io network the default is strict with the seeds' keys (src/trust/seed-keys.ts).
const TRUST_ENV = withNetworkTrustDefaults(process.env);
const coordinatorTrustStore = PinnedKeyStore.fromEnv(TRUST_ENV, { pinFile: `${PLATFORM_CONFIG_DIR}/trusted-coordinators` });
// Each coordinator URL must prove possession of its key (POST /identity/challenge); a verification
// lasts EDGECODER_TRUST_REVERIFY_MS (default 10 min) and is redone on reconnect and URL changes.
const coordinatorTrust = new CoordinatorTrustGate({
  store: coordinatorTrustStore,
  challenge: challengePolicyFromEnv(TRUST_ENV, coordinatorTrustStore.mode),
  reverifyMs: Number(process.env.EDGECODER_TRUST_REVERIFY_MS) > 0 ? Number(process.env.EDGECODER_TRUST_REVERIFY_MS) : DEFAULT_TRUST_REVERIFY_MS
});
{
  // Strict mode with nothing listed would refuse every coordinator: say so once and stop.
  const problem = coordinatorTrustStore.configProblem();
  if (problem) {
    console.error(`[worker] ${problem}`);
    process.exit(1);
  }
}

// Forked by the all-in-one agent: exit with it rather than linger as an orphan.
if (process.send) process.on("disconnect", () => process.exit(0));

const COORDINATOR_BOOTSTRAP_URL = process.env.COORDINATOR_URL ?? "http://127.0.0.1:4301";
const SNAPSHOT_ENFORCEMENT = parseSnapshotEnforcement(process.env.SNAPSHOT_ENFORCEMENT);
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? "";
const COORDINATOR_DISCOVERY_URL =
  process.env.COORDINATOR_DISCOVERY_URL ??
  (CONTROL_PLANE_URL ? `${CONTROL_PLANE_URL.replace(/\/$/, "")}/network/coordinators` : "");
// #96: default to a per-host id so N replicas without AGENT_ID (docker compose --scale) don't all register as "worker-1".
const AGENT_ID = process.env.AGENT_ID ?? `worker-${hostname().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16) || "1"}`;
const MODE = (process.env.AGENT_MODE ?? "swarm-only") as "swarm-only" | "ide-enabled";
const OS = (process.env.AGENT_OS ?? platformInfo.os) as "debian" | "ubuntu" | "windows" | "macos" | "ios";
const PROVIDER = (process.env.LOCAL_MODEL_PROVIDER ?? "edgecoder-local") as
  | "edgecoder-local"
  | "ollama-local";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
const OLLAMA_HOST = process.env.OLLAMA_HOST;
const OLLAMA_AUTO_INSTALL = process.env.OLLAMA_AUTO_INSTALL === "true";
const MAX_PARALLEL_INFERENCE = parallelInferenceFor(totalmem(), process.env.AGENT_PARALLEL_INFERENCE);
const inflightInference = new Set<Promise<void>>();
let meshAuthToken = process.env.MESH_AUTH_TOKEN ?? "";
const COORDINATOR_HTTP_TIMEOUT_MS = Number(process.env.COORDINATOR_HTTP_TIMEOUT_MS ?? "15000");
const COORDINATOR_POST_RETRIES = Number(process.env.COORDINATOR_POST_RETRIES ?? "2");
const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS ?? "1");
const AGENT_CLIENT_TYPE = process.env.AGENT_CLIENT_TYPE ?? "edgecoder-native";
const PEER_DIRECT_WORK_ITEMS = (process.env.PEER_DIRECT_WORK_ITEMS ??
  "help peer with lightweight test scaffolding||review edge case handling").split("||");
const SANDBOX_MODE: SandboxMode = resolveSandboxMode(process.env);
const hardwareProbe: Probe = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};
/**
 * Hardware profile reported at registration; the coordinator classifies it into a compute class
 * that prices this agent's seconds. GPUs are detected (nvidia-smi / rocm-smi / Apple silicon,
 * src/install/hardware.ts); CUDA_VISIBLE_DEVICES or EDGECODER_GPU_INDEX picks the card this
 * instance owns. AGENT_GPU_VENDOR / AGENT_GPU_MODEL / AGENT_GPU_VRAM_GB / AGENT_GPU_DATACENTER=1
 * override detection (containers and unusual hardware); such a profile is marked `overridden` and
 * the coordinator re-proves it with a benchmark challenge every session.
 */
function buildHardwareProfile(): Record<string, unknown> {
  const hw = detectHardware({ probe: hardwareProbe });
  const gpuModel = process.env.AGENT_GPU_MODEL?.trim();
  const gpuVram = Number(process.env.AGENT_GPU_VRAM_GB);
  if (gpuModel || (Number.isFinite(gpuVram) && gpuVram > 0)) {
    return {
      ...hardwareProfileFor(hw, undefined),
      gpu: {
        vendor: process.env.AGENT_GPU_VENDOR?.trim() || undefined,
        model: gpuModel || undefined,
        vramGb: Number.isFinite(gpuVram) && gpuVram > 0 ? gpuVram : undefined,
        datacenter: process.env.AGENT_GPU_DATACENTER === "1"
      },
      overridden: true
    };
  }
  return hardwareProfileFor(hw, selectGpu(hw, process.env));
}
const HARDWARE_PROFILE = buildHardwareProfile();
/**
 * Throughput benchmark (src/swarm/benchmark.ts): a < ~30 s self-benchmark at startup and every
 * AGENT_BENCHMARK_INTERVAL_MS (default 6 h), reported with the profile, plus answers to the
 * coordinator's challenges, which are what actually grant a tier. AGENT_BENCHMARK=0 turns both off
 * (the agent then earns at its class base tier).
 */
const BENCHMARK_ENABLED = process.env.AGENT_BENCHMARK !== "0";
const BENCHMARK_INTERVAL_MS = Math.max(10 * 60_000, Number(process.env.AGENT_BENCHMARK_INTERVAL_MS ?? 6 * 60 * 60_000) || 6 * 60 * 60_000);
let lastBenchmark: AgentBenchmarkReport | undefined;
let benchmarkDueAtMs = 0;
let benchmarkUnreported = false;
/** Refuse challenges no honest tier needs (a trusted coordinator never sends these; this bounds a bad config). */
function challengeAcceptable(c: BenchmarkChallenge): boolean {
  if (!c || typeof c.challengeId !== "string" || !(c.deadlineMs > 0 && c.deadlineMs <= 15 * 60_000)) return false;
  if (c.kind === "cpu") return typeof c.seed === "string" && Number.isInteger(c.workUnits) && c.workUnits > 0 && c.workUnits <= 2_000_000 && c.target > 0;
  return c.kind === "gpu" && typeof c.model === "string" && typeof c.nonce === "string" && c.numPredict > 0 && c.numPredict <= 4096 && c.lines > 0 && c.lines <= 200;
}
/** Minimum price this agent works for, msat per credit; unset = track the coordinator's class reference. */
const ASK_MSAT_PER_CREDIT = (() => {
  const n = Number(process.env.AGENT_ASK_MSAT_PER_CREDIT);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
})();
const SANDBOX_REQUIRED = process.env.SANDBOX_REQUIRED === "true";
// #45: without a sandbox this node contributes no swarm compute (no /pull, no mesh/BLE/peer code execution).
const SWARM_EXECUTION_ENABLED = swarmExecutionEnabled(SANDBOX_MODE);
let warnedNoSandbox = false;
const AGENT_REGISTRATION_TOKEN = process.env.AGENT_REGISTRATION_TOKEN ?? "";
const PORTAL_URL = process.env.PORTAL_URL ?? "";
const AGENT_DEVICE_ID = (() => {
  const explicit = (process.env.AGENT_DEVICE_ID ?? process.env.IOS_DEVICE_ID ?? "").trim();
  if (explicit) return explicit;
  if (OS === "ios") return AGENT_ID.replace(/^ios-|^iphone-/i, "").trim();
  return "";
})();
const keys = createPeerKeys(AGENT_ID);
const envelopeKeys = generateX25519KeyPair();
const peerTunnels = new Map<string, string>();
const peerOfferCooldownMs = Number(process.env.PEER_OFFER_COOLDOWN_MS ?? "20000");
const lastOfferAtByPeer = new Map<string, number>();
let peerWorkCursor = 0;
async function discoverCoordinatorFromPortal(): Promise<string | null> {
  if (!PORTAL_URL || !AGENT_REGISTRATION_TOKEN) return null;
  try {
    const res = await request(`${PORTAL_URL.replace(/\/$/, "")}/nodes/discover-coordinator`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${AGENT_REGISTRATION_TOKEN}`,
      },
      headersTimeout: 10_000,
      bodyTimeout: 10_000,
    });
    if (res.statusCode !== 200) return null;
    const body = (await res.body.json()) as { coordinatorUrl?: string | null };
    return body.coordinatorUrl ?? null;
  } catch (err) {
    console.warn("[worker] Portal coordinator discovery failed:", err);
    return null;
  }
}

/** The coordinator this agent works for; every URL change goes through coordinator.set(). */
const coordinator = new ActiveCoordinator(COORDINATOR_BOOTSTRAP_URL, coordinatorTrust, (from, to, reason) =>
  console.log(`[worker] coordinator ${from} -> ${to} (${reason}); verifying before use`)
);

/*
 * Signed coordinator responses (src/trust/response-signing.ts): every response the worker acts on
 * is verified against the key the coordinator proved in its identity challenge. Required in strict
 * mode (EDGECODER_RESPONSE_SIGNING=required); otherwise required from coordinators that advertise
 * it or were seen signing, and an older coordinator's unsigned responses are accepted with a warning.
 */
const responseVerifier = new ResponseVerifier(responseSigningPolicyFromEnv(TRUST_ENV, coordinatorTrustStore.mode), {
  load: () => {
    const raw = localStore.getConfig("coordinator_response_signers");
    return raw ? (JSON.parse(raw) as string[]) : [];
  },
  save: (peerIds) => localStore.setConfig("coordinator_response_signers", JSON.stringify(peerIds))
});
const coordinatorClient = createCoordinatorClient({
  coordinator,
  verifier: responseVerifier,
  agentId: AGENT_ID,
  warn: (m) => console.warn(`[agent:${AGENT_ID}] ${m}`),
  onRejected: (err) =>
    console.error(`[agent:${AGENT_ID}] refused an unauthenticated coordinator response (${err.reason}) for ${err.method} ${err.path}; failures=${responseVerifier.failures}; re-verifying ${coordinator.url}`)
});

/*
 * One platform URL, steered (src/discovery/steering.ts): fetch the signed registry from the
 * configured URL (or the portal, or the cache), verify it against the pinned registry key, and
 * work for the lowest-latency healthy coordinator whose identity matches the registry. Off for a
 * loopback coordinator, with EDGECODER_STEERING=off, or while no registry key is pinned.
 */
const REGISTRY_PUBLIC_KEYS = registryPublicKeysFromEnv(process.env);
const STEERING_ENABLED =
  !["off", "0", "false"].includes((process.env.EDGECODER_STEERING ?? "").trim().toLowerCase()) &&
  !isLoopbackUrl(COORDINATOR_BOOTSTRAP_URL) &&
  REGISTRY_PUBLIC_KEYS.length > 0;
const STEERING_INTERVAL_MS = Math.max(60_000, Number(process.env.EDGECODER_STEERING_INTERVAL_MS ?? "600000") || 600_000);
const coordinatorSteering = STEERING_ENABLED
  ? createCoordinatorSteering({
      registryUrls: registryUrlsFor(COORDINATOR_BOOTSTRAP_URL, PORTAL_URL || undefined),
      publicKeys: REGISTRY_PUBLIC_KEYS,
      fallbackUrl: COORDINATOR_BOOTSTRAP_URL,
      cache: {
        read: () => localStore.getConfig("coordinator_registry") ?? null,
        write: (text) => localStore.setConfig("coordinator_registry", text)
      }
    })
  : null;
/** The last steering decision (shown in the app's Settings via the local forwarder). */
let steeringStatus: SteeringResult | null = null;
let lastSteeredAtMs = 0;
/** True once the signed registry chose the coordinator (unsigned discovery must not override it). */
const steeredByRegistry = (): boolean => steeringStatus?.source === "registry";

/** One steering round; returns the registry pick, or null when steering is off or fell back. */
async function steerCoordinator(): Promise<SteeringResult | null> {
  if (!coordinatorSteering) return null;
  lastSteeredAtMs = Date.now();
  const result = await coordinatorSteering.steer();
  steeringStatus = result;
  // Coordinators the signed registry lists are trusted with exactly the listed key.
  coordinatorTrustStore.setRegistryEntries(coordinatorSteering.trustedEntries());
  if (result.source === "registry") {
    if (!result.kept || result.url !== coordinator.url) {
      console.log(`[worker] steering: ${result.url} (${result.peerId}, region=${result.region}, ${result.latencyMs}ms${result.kept ? ", kept" : ""}; registry from ${result.registry?.from})`);
    }
    return result;
  }
  console.log(`[worker] steering fell back to ${result.url}: ${result.reason}`);
  return null;
}

// Coordinator discovery at startup. It starts now, but its pick is applied by the loop (after it
// is awaited and before anything talks to a coordinator), so it cannot swap the URL mid-iteration.
const startupDiscovery: Promise<{ url: string; source: string } | null> = (async () => {
  let pick: { url: string; source: string } | null = null;
  if (!process.env.COORDINATOR_URL || process.env.EDGECODER_DISCOVERY === "1") {
    // Strict trust: never pick an announced coordinator whose key is not listed (key-less
    // candidates are still checked against /identity by the trust gate before registering).
    const acceptCandidate =
      coordinatorTrustStore.mode === "strict" ? (c: { peerId?: string; publicKeyPem?: string }) => !c.publicKeyPem || coordinatorTrustStore.wouldTrust(c.peerId, c.publicKeyPem) : undefined;
    const picked = await selectCoordinatorFromEnv({ currentUrl: COORDINATOR_BOOTSTRAP_URL, meshToken: meshAuthToken || undefined, acceptCandidate });
    // A signed-registry pick (steering) wins over unsigned discovery.
    if (picked) {
      console.log(`[worker] Discovery selected coordinator ${picked.url} (source=${picked.source} score=${picked.score} latency=${picked.latencyMs}ms)`);
      pick = { url: picked.url, source: `discovery:${picked.source}` };
    }
  }
  if (PORTAL_URL && AGENT_REGISTRATION_TOKEN) {
    const discovered = await discoverCoordinatorFromPortal();
    if (discovered) {
      console.log(`[worker] Discovered coordinator from portal: ${discovered}`);
      pick = { url: discovered, source: "portal" };
    } else {
      console.log(`[worker] Portal discovery returned no coordinator, using ${COORDINATOR_BOOTSTRAP_URL}`);
    }
  }
  return pick;
})().catch((err) => {
  console.warn(`[worker] startup discovery failed: ${String(err)}`);
  return null;
});

/**
 * Prove the current coordinator holds its pinned key, or throw (the loop then backs off and fails
 * over). A key mismatch for a pinned id is a possible impersonation: stop the agent.
 */
async function verifyCoordinatorOrThrow(opts: { force?: boolean } = {}): Promise<void> {
  const trust = await coordinator.verify(opts);
  if (!trust.trusted) {
    console.error(`[agent:${AGENT_ID}] refusing to work for ${coordinator.url}: ${describeTrustFailure(trust)}`);
    if (trust.decision?.reason === "pinned_mismatch") process.exit(1);
    throw new Error(trust.decision ? "coordinator_not_trusted" : "coordinator_identity_unavailable");
  }
  if (trust.warning) console.warn(`[agent:${AGENT_ID}] ${trust.warning}`);
}

// ── Offline resilience state ──────────────────────────────────
let consecutiveFailures = 0;
let coordinatorOnline = true;
const OFFLINE_THRESHOLD = 3;
const BACKOFF_BASE_MS = 1500;
const BACKOFF_MAX_MS = 30_000;
// Each failed probe doubles the wait (15 s .. 5 min). A probe registers, and registering every
// 15 s while offline tripped the coordinator's registration-storm rule (BHV008), whose ban then
// kept the agent offline for good.
const RECONNECT_PROBE_MIN_MS = 15_000;
const RECONNECT_PROBE_MAX_MS = 5 * 60_000;
let reconnectProbeIntervalMs = RECONNECT_PROBE_MIN_MS;
const COORDINATOR_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
let lastReconnectProbeMs = 0;

// ── Registration state (see registration-policy.ts for why this is not every tick) ──
const REGISTER_REFRESH_MS = registerRefreshMsFromEnv();
let registeredWithUrl: string | null = null;
let lastRegisteredAtMs = 0;
/** SANDBOX_MODE=docker but the daemon isn't reachable right now. */
let sandboxDown = false;
// The sandbox images are built locally on first use (see ensureSandboxImages); until then the
// sandbox counts as down. The build runs in the background so heartbeats keep flowing.
let sandboxImagesReady = SANDBOX_MODE !== "docker";
let sandboxImagesBuilding = false;

// The user's IDE / local coding agent sends swarm work here; this agent signs and relays it.
const LOCAL_FORWARD_PORT = Number(process.env.LOCAL_FORWARD_PORT ?? "");
if (LOCAL_FORWARD_PORT > 0) {
  let forwardToken: string | undefined;
  createLocalForwarder({
    token: () => (forwardToken ??= resolveIdeToken()),
    coordinatorUrl: () => registeredWithUrl,
    steering: () => steeringStatus,
    meshHeaders,
    signedHeaders,
    agentId: AGENT_ID
  })
    .on("error", (err) => console.warn(`[agent:${AGENT_ID}] local forwarder unavailable: ${String(err)}`))
    .listen(LOCAL_FORWARD_PORT, "127.0.0.1", () =>
      console.log(`[agent:${AGENT_ID}] local forwarder on 127.0.0.1:${LOCAL_FORWARD_PORT}`)
    );
}

/** Models in this machine's Ollama (embedding-only models left out); [] when it can't be reached. */
async function listInstalledModels(): Promise<string[]> {
  try {
    const res = await request(`${OLLAMA_HOST ?? "http://127.0.0.1:11434"}/api/tags`, { method: "GET", headersTimeout: 3000, bodyTimeout: 3000 });
    const body = (await res.body.json()) as { models?: Array<{ name: string }> };
    return (body.models ?? []).map((m) => m.name).filter((n) => !/embed/i.test(n)).slice(0, 200);
  } catch {
    return [];
  }
}

/** #54: installed models, re-read at most once a minute; reported (signed) with register and heartbeats. */
const INSTALLED_MODELS_REFRESH_MS = 60_000;
let installedModelsCache: { models: string[]; atMs: number } | undefined;
async function installedModelsCached(nowMs = Date.now()): Promise<string[]> {
  if (!installedModelsCache || nowMs - installedModelsCache.atMs >= INSTALLED_MODELS_REFRESH_MS) {
    installedModelsCache = { models: await listInstalledModels(), atMs: nowMs };
  }
  return installedModelsCache.models;
}

function backoffMs(): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(consecutiveFailures, 10), BACKOFF_MAX_MS);
}

type AgentPowerTelemetry = {
  onExternalPower?: boolean;
  batteryLevelPct?: number;
  lowPowerMode?: boolean;
  updatedAtMs?: number;
  onACPower?: boolean;
  batteryPct?: number;
  thermalState?: "nominal" | "fair" | "serious" | "critical";
  cpuUsagePct?: number;
  memoryUsagePct?: number;
  deviceType?: "desktop" | "laptop" | "phone" | "tablet" | "server";
};

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return undefined;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

let cachedDesktopTelemetry: AgentPowerTelemetry | undefined;
let lastDesktopTelemetryMs = 0;
const DESKTOP_TELEMETRY_CACHE_MS = 10_000;

function readAgentPowerTelemetry(): AgentPowerTelemetry | undefined {
  if (OS === "ios") {
    const onExternalPower = parseOptionalBoolean(process.env.IOS_ON_EXTERNAL_POWER);
    const batteryLevelPct = parseOptionalNumber(process.env.IOS_BATTERY_LEVEL_PCT);
    const lowPowerMode = parseOptionalBoolean(process.env.IOS_LOW_POWER_MODE);
    return {
      onExternalPower,
      batteryLevelPct: typeof batteryLevelPct === "number" ? Math.max(0, Math.min(100, batteryLevelPct)) : undefined,
      lowPowerMode,
      updatedAtMs: Date.now()
    };
  }

  // For desktop/laptop, return cached telemetry (refreshed async)
  const now = Date.now();
  if (now - lastDesktopTelemetryMs > DESKTOP_TELEMETRY_CACHE_MS || !cachedDesktopTelemetry) {
    lastDesktopTelemetryMs = now;
    collectDesktopTelemetry()
      .then((t) => { cachedDesktopTelemetry = t; })
      .catch(() => {
        cachedDesktopTelemetry = { onACPower: true, deviceType: "desktop", updatedAtMs: Date.now() };
      });
  }
  return cachedDesktopTelemetry;
}

function allowPeerDirectWork(telemetry: AgentPowerTelemetry | undefined): boolean {
  if (OS === "ios") {
    if (!telemetry) return false;
    if (telemetry.lowPowerMode === true) return false;
    return telemetry.onExternalPower === true;
  }
  // Desktop/laptop: use desktop telemetry
  if (!telemetry) return true;
  if (telemetry.deviceType === "server" || telemetry.deviceType === "desktop") return true;
  if (telemetry.thermalState === "serious" || telemetry.thermalState === "critical") return false;
  if (typeof telemetry.batteryPct === "number" && telemetry.onACPower === false && telemetry.batteryPct <= 40) return false;
  if (telemetry.onACPower === true) return true;
  return telemetry.onACPower !== false;
}

function meshHeaders(): Record<string, string> {
  if (!meshAuthToken) return {};
  return { "x-mesh-token": meshAuthToken };
}

/**
 * Request-signing headers. The coordinator checks `x-body-sha256` against the raw bytes it
 * receives, so pass the exact serialized body that goes on the wire (post() does this).
 */
function signedHeaders(path: string, body: unknown): Record<string, string> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const bodyHash = hashRequestBody(raw);
  return signRequest({
    method: "POST",
    path,
    bodyHash,
    privateKeyPem: keys.privateKeyPem,
    agentId: AGENT_ID,
  }) as unknown as Record<string, string>;
}

function computeMeshTokenHash(): string {
  if (!meshAuthToken) return "";
  return createHash("sha256").update(meshAuthToken).digest("hex");
}

function computeTaskHash(task: string): string {
  return createHash("sha256").update(task).digest("hex");
}

function normalizeUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
  } catch {
    return false;
  }
}

function readCachedCoordinatorUrl(): string | null {
  const cached = localStore.getConfigWithTTL("coordinator_url", COORDINATOR_CACHE_TTL_MS);
  return cached ? normalizeUrl(cached) : null;
}

function cacheCoordinatorUrl(url: string): void {
  localStore.setConfig("coordinator_url", url);
}

async function discoverCoordinatorUrlFromRegistry(): Promise<string | null> {
  if (!COORDINATOR_DISCOVERY_URL) return null;
  try {
    const res = await request(COORDINATOR_DISCOVERY_URL, { method: "GET" });
    if (res.statusCode < 200 || res.statusCode >= 300) return null;
    const payload = (await parseJsonBodySafe(res)) as {
      coordinators?: Array<{ coordinatorUrl?: string }>;
    };
    const candidate = normalizeUrl(payload.coordinators?.[0]?.coordinatorUrl);
    return candidate;
  } catch {
    return null;
  }
}

async function resolveCoordinatorUrl(): Promise<{ url: string; source: "steering" | "registry" | "cache" | "bootstrap" }> {
  const steered = await steerCoordinator();
  if (steered) return { url: steered.url, source: "steering" };
  const discovered = await discoverCoordinatorUrlFromRegistry();
  if (discovered) return { url: discovered, source: "registry" };
  const cached = readCachedCoordinatorUrl();
  // A loopback URL cached by a local-only run must not override a network bootstrap URL:
  // the local coordinator's key changes per run and would fail the pin forever.
  if (cached && !(isLoopbackUrl(cached) && !isLoopbackUrl(COORDINATOR_BOOTSTRAP_URL))) {
    return { url: cached, source: "cache" };
  }
  return { url: COORDINATOR_BOOTSTRAP_URL, source: "bootstrap" };
}

/**
 * #51: while a claimed subtask runs, heartbeat every LEASE_HEARTBEAT_MS so the
 * coordinator renews the claim lease (it expires after CLAIM_LEASE_LIVENESS_MS of silence).
 */
const LEASE_HEARTBEAT_MS = Math.max(1_000, Number(process.env.LEASE_HEARTBEAT_MS ?? "15000") || 15_000);
/**
 * #51: lease-only renewal while a claimed subtask runs. `leaseOnly` tells the
 * coordinator to renew leases without draining tunnel invites / close notices /
 * direct-work offers, which the main loop's full heartbeat still collects.
 * Only wired around claims pulled from this coordinator: mesh-gossip tasks are
 * leased by their origin coordinator, and peer-direct/offline runs hold no lease.
 */
function startLeaseHeartbeat(): () => void {
  const timer = setInterval(() => {
    const body = { agentId: AGENT_ID, sandboxMode: SANDBOX_MODE, leaseOnly: true };
    void post("/heartbeat", body, { retries: 0, timeoutMs: 5000, signed: true }).catch(
      (e) => console.warn(`[agent:${AGENT_ID}] lease heartbeat failed: ${e}`)
    );
  }, LEASE_HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function post(
  path: string,
  body: unknown,
  options?: { retries?: number; timeoutMs?: number; extraHeaders?: Record<string, string>; signed?: boolean }
): Promise<any> {
  const retries = Math.max(0, options?.retries ?? COORDINATOR_POST_RETRIES);
  const timeoutMs = Math.max(1000, options?.timeoutMs ?? COORDINATOR_HTTP_TIMEOUT_MS);
  // Serialize once: the signature's body hash covers exactly these bytes.
  const payload = JSON.stringify(body);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      // Signed requests get a fresh nonce per attempt; a retry of a request the coordinator
      // already saw would otherwise be refused as a replay.
      const signature = options?.signed ? signedHeaders(path, payload) : {};
      // The coordinator client sends only to the verified URL and verifies the signed response.
      const res = await coordinatorClient.call({
        method: "POST",
        path,
        headers: { "content-type": "application/json", ...meshHeaders(), ...(options?.extraHeaders ?? {}), ...signature },
        timeoutMs,
        body: payload
      });
      const parsed = (await parseJsonBodySafe(res)) as unknown;
      const rawText = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const payloadText = rawText && rawText !== "{}" ? rawText : "<empty>";
        const err = new Error(`POST ${path} failed (${res.statusCode}): ${payloadText}`);
        (err as any).statusCode = res.statusCode;
        throw err;
      }
      return parsed;
    } catch (error) {
      lastError = error;
      // Don't retry on 403 (blacklisted/rejected) or 401 (auth) — retrying wastes
      // budget and can trigger DOS detection from rapid registration attempts.
      const code = (error as any).statusCode;
      if (code === 401 || code === 403) break;
      // A refused response is not retried: the coordinator is re-verified first.
      if (error instanceof CoordinatorResponseRejectedError) break;
      if (attempt >= retries) break;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "unknown_post_error"));
}

/**
 * One signed POST, no retries; the caller reads the status. Routes that act for this agent
 * (agent-mesh tunnels, direct work) take the agent id from the signature, not the mesh token.
 */
function signedJsonPost(path: string, body: unknown) {
  // Same path as post(): verified URL only, signed response checked before use.
  const payload = JSON.stringify(body);
  return coordinatorClient.call({
    method: "POST",
    path,
    headers: { "content-type": "application/json", ...meshHeaders(), ...signedHeaders(path, payload) },
    body: payload
  });
}

/** A GET the worker acts on (agent-mesh peers): same verified, signed-response path. */
function coordinatorGet(path: string) {
  return coordinatorClient.call({ method: "GET", path, headers: { ...meshHeaders(), "x-agent-id": AGENT_ID } });
}

async function parseJsonBodySafe(res: { headers: Record<string, unknown>; body: { text: () => Promise<string> } }): Promise<unknown> {
  const contentType = String(res.headers["content-type"] ?? "");
  const raw = await res.body.text();
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const looksJson =
    contentType.toLowerCase().includes("application/json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");
  if (!looksJson) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

async function flushPendingResults(): Promise<void> {
  const pending = localStore.listPendingResults(20);
  if (pending.length === 0) return;
  console.log(`[agent:${AGENT_ID}] flushing ${pending.length} buffered result(s)`);
  for (const row of pending) {
    try {
      const resultPayload = JSON.parse(row.payload);
      await post("/result", resultPayload, { signed: true });
      localStore.markResultSynced(row.subtaskId);
      console.log(`[agent:${AGENT_ID}] flushed result: ${row.subtaskId}`);
    } catch {
      localStore.incrementResultAttempt(row.subtaskId);
      console.warn(`[agent:${AGENT_ID}] flush failed for ${row.subtaskId} (attempt ${row.attempts + 1}), stopping`);
      break;
    }
  }
}

async function flushOfflineLedger(): Promise<void> {
  const unsynced = localStore.listUnsyncedBLECredits(50);
  if (unsynced.length === 0) return;
  console.log(`[agent:${AGENT_ID}] flushing ${unsynced.length} BLE credit transaction(s)`);
  try {
    const transactions = unsynced.map(row => ({
      txId: row.txId,
      requesterId: row.requesterId,
      providerId: row.providerId,
      requesterAccountId: row.requesterId,
      providerAccountId: row.providerId,
      credits: row.credits,
      cpuSeconds: row.cpuSeconds,
      taskHash: row.taskHash,
      timestamp: row.createdAt * 1000,
      requesterSignature: row.requesterSig,
      providerSignature: row.providerSig,
    }));
    const bleSyncBody = { transactions };
    await post("/credits/ble-sync", bleSyncBody, { signed: true });
    localStore.markBLECreditsSynced(unsynced.map(tx => tx.txId));
    console.log(`[agent:${AGENT_ID}] BLE credits synced`);
  } catch (e) {
    console.warn(`[agent:${AGENT_ID}] BLE credit flush failed (will retry): ${String(e)}`);
  }
}

/**
 * The mesh only hears peers in its table. When bootstrap did not add the coordinator this WebSocket
 * is connected to, add it from its /identity, but only with a key the trust store accepts for it.
 */
const coordinatorPeerLookups = new Map<string, number>();
async function learnCoordinatorPeer(peer: MeshPeer, coordinatorUrl: string, fromPeerId: string): Promise<void> {
  const key = `${coordinatorUrl}|${fromPeerId}`;
  const last = coordinatorPeerLookups.get(key) ?? 0;
  if (Date.now() - last < 60_000) return;
  coordinatorPeerLookups.set(key, Date.now());
  try {
    const res = await request(`${coordinatorUrl.replace(/\/+$/, "")}/identity`, { method: "GET", headersTimeout: 8_000, bodyTimeout: 8_000 });
    if (res.statusCode !== 200) {
      await res.body.dump();
      return;
    }
    const id = (await res.body.json()) as { peerId?: string; publicKeyPem?: string; networkMode?: string };
    if (id.peerId !== fromPeerId || typeof id.publicKeyPem !== "string") return;
    if (!coordinatorTrustStore.wouldTrust(id.peerId, id.publicKeyPem)) return;
    peer.addPeer({ peerId: id.peerId, publicKeyPem: id.publicKeyPem, coordinatorUrl, networkMode: id.networkMode === "enterprise_overlay" ? "enterprise_overlay" : "public_mesh" }, "coordinator");
  } catch {
    // unknown sender stays unknown; its messages are dropped
  }
}

function connectMeshWebSocket(getMeshPeer: () => MeshPeer | null): void {
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 30_000;

  function connect(): void {
    // Wait for a valid mesh token before connecting — connecting without one
    // triggers rapid 4001 close → reconnect loops that trip DOS detection.
    // Only to a coordinator that has proven its key (it follows URL changes on reconnect).
    if (!meshAuthToken || !coordinator.isVerified()) {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      return;
    }
    // Token in a header only (never the URL, where proxies log it), and a signed bind so the
    // coordinator ties this connection to AGENT_ID's registered key (src/mesh/ws-auth.ts).
    const coordinatorUrl = coordinator.url;
    const ws = new WebSocket(meshWsUrl(coordinatorUrl, AGENT_ID), { headers: { "x-mesh-token": meshAuthToken, ...signMeshWsBind(AGENT_ID, keys.privateKeyPem) } });

    // Track which coordinator peerId this WS is registered against
    let registeredPeerId: string | null = null;

    ws.on("open", () => {
      console.log(`[agent:${AGENT_ID}] mesh WebSocket connected to ${coordinatorUrl}`);
      reconnectDelay = 1000;
    });

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());
        const peer = getMeshPeer();
        if (peer) {
          // Register this WS for outbound gossip on first message from the coordinator.
          // We learn the coordinator's peerId from the message's fromPeerId field,
          // which isn't known until after bootstrap (and bootstrap may have timed out).
          if (!registeredPeerId && message.fromPeerId) {
            registeredPeerId = message.fromPeerId;
            peer.gossip.setWebSocketForPeer(message.fromPeerId, ws as any);
            console.log(`[agent:${AGENT_ID}] registered WS for outbound gossip to ${message.fromPeerId}`);
          }
          if (typeof message.fromPeerId === "string" && !peer.getPeer(message.fromPeerId)) {
            await learnCoordinatorPeer(peer, coordinatorUrl, message.fromPeerId);
          }
          await peer.handleIngest(message);
        }
      } catch (err) {
        console.warn(`[agent:${AGENT_ID}] ws ingest error: ${(err as Error).message}`);
      }
    });

    ws.on("close", () => {
      // Unregister WS from gossip mesh
      if (registeredPeerId) {
        const peer = getMeshPeer();
        if (peer) peer.gossip.removeWebSocketForPeer(registeredPeerId);
        registeredPeerId = null;
      }
      console.log(`[agent:${AGENT_ID}] mesh WebSocket closed, reconnecting in ${reconnectDelay}ms`);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
    });

    ws.on("error", (err) => {
      console.warn(`[agent:${AGENT_ID}] mesh WebSocket error: ${err.message}`);
      // 'close' event fires after 'error', so reconnect happens there
    });
  }

  connect();
}

async function loop(): Promise<void> {
  console.log(`[agent:${AGENT_ID}] platform: os=${platformInfo.os} arch=${platformInfo.arch} docker=${platformInfo.isDocker} wsl=${platformInfo.isWSL} systemd=${platformInfo.hasSystemd} pkg=${platformInfo.packageManager} shell=${platformInfo.shell}`);
  console.log(`[agent:${AGENT_ID}] configDir=${PLATFORM_CONFIG_DIR} logDir=${PLATFORM_LOG_DIR}`);

  const coordinatorSelection = await resolveCoordinatorUrl();
  coordinator.set(coordinatorSelection.url, coordinatorSelection.source);
  // Startup discovery settles before the loop starts; a signed-registry pick (steering) wins over it.
  const discoveredAtStartup = await startupDiscovery;
  if (discoveredAtStartup && !steeredByRegistry()) coordinator.set(discoveredAtStartup.url, discoveredAtStartup.source);
  cacheCoordinatorUrl(coordinator.url);
  console.log(`[agent:${AGENT_ID}] coordinator selected (${discoveredAtStartup && !steeredByRegistry() ? discoveredAtStartup.source : coordinatorSelection.source}): ${coordinator.url}`);

  await ensureOllamaModelInstalled({
    enabled: PROVIDER === "ollama-local",
    autoInstall: OLLAMA_AUTO_INSTALL,
    model: OLLAMA_MODEL,
    role: "agent",
    host: OLLAMA_HOST
  });

  const providers = new ProviderRegistry();
  let currentProvider = PROVIDER;
  providers.use(currentProvider);
  const worker = new SwarmWorkerAgent(providers.current());
  const effectiveMode = OS === "ios" ? "swarm-only" : MODE;

  /** Every subtask runs through the same execution policy, whatever its source. */
  async function runPolicedSubtask(st: Subtask, opts: { quiet?: boolean } = {}): Promise<SubtaskResult> {
    const policy = checkSnapshotPolicy(st, SNAPSHOT_ENFORCEMENT);
    if (!policy.run) {
      console.error(`[agent:${AGENT_ID}] snapshot enforcement: ${policy.error}`);
      return { subtaskId: st.id, taskId: st.taskId, agentId: AGENT_ID, ok: false, output: "", error: policy.error, durationMs: 0 };
    }
    if (policy.warning && !opts.quiet) console.warn(`[agent:${AGENT_ID}] snapshot warning: ${policy.warning}`);
    return worker.runSubtask(st, AGENT_ID);
  }

  // ── Initialize HTTP mesh peer (BitTorrent-style P2P) ──
  let meshPeer: MeshPeer | null = null;
  let meshServer: MeshHttpServer | null = null;
  const meshTaskQueue: Array<{ subtask: Subtask; fromPeerId: string }> = [];
  const meshClaimedTasks = new Set<string>();
  try {
    const localIp = getLocalIpAddress();
    meshPeer = new MeshPeer({
      peerId: AGENT_ID,
      keys,
      publicUrl: `http://${localIp}:0`, // will update after server starts
      networkMode: "public_mesh",
      role: "agent",
      bootstrapUrls: [coordinator.url],
      meshToken: meshAuthToken || undefined,
    });

    meshServer = new MeshHttpServer({
      port: 0,
      meshPeer,
      meshToken: meshAuthToken || undefined,
    });

    const meshPort = await meshServer.start();
    meshPeer.setPublicUrl(`http://${localIp}:${meshPort}`);
    console.log(`[agent:${AGENT_ID}] mesh HTTP server listening on ${localIp}:${meshPort}`);

    // Handle task_offer: queue tasks received via gossip
    meshPeer.on("task_offer", async (msg: MeshMessage) => {
      const p = msg.payload as {
        subtaskId?: string; taskId?: string; kind?: string;
        language?: string; input?: string; timeoutMs?: number;
        snapshotRef?: string; projectMeta?: Subtask["projectMeta"];
        originCoordinatorId?: string;
      };
      if (!p.subtaskId || !p.taskId || !p.input) return;
      if (meshClaimedTasks.has(p.subtaskId)) return;
      // Same execution policy as pulled work: don't claim what we would refuse to run.
      const offerPolicy = checkSnapshotPolicy({ id: p.subtaskId, kind: (p.kind as Subtask["kind"]) ?? "single_step", snapshotRef: p.snapshotRef }, SNAPSHOT_ENFORCEMENT);
      if (!offerPolicy.run) {
        console.warn(`[agent:${AGENT_ID}] mesh task_offer ignored: ${offerPolicy.error}`);
        return;
      }
      // Don't accept tasks we originated
      if (p.originCoordinatorId === AGENT_ID) return;
      // #45 review: a node without a sandbox never drains this queue, so don't fill it.
      if (!SWARM_EXECUTION_ENABLED) return;
      meshTaskQueue.push({
        subtask: {
          id: p.subtaskId,
          taskId: p.taskId,
          kind: (p.kind as Subtask["kind"]) ?? "single_step",
          language: (p.language as Language) ?? "python",
          input: p.input,
          timeoutMs: p.timeoutMs ?? 30_000,
          snapshotRef: p.snapshotRef ?? "mesh",
          projectMeta: p.projectMeta ?? { projectId: "mesh", resourceClass: "cpu", priority: 5 },
        },
        fromPeerId: msg.fromPeerId,
      });
      // Broadcast claim
      await meshPeer!.broadcast("task_claim", {
        subtaskId: p.subtaskId,
        claimedByCoordinator: AGENT_ID,
      });
      meshClaimedTasks.add(p.subtaskId);
      console.log(`[agent:${AGENT_ID}] mesh task_offer queued: ${p.subtaskId}`);
    });

    // Handle task_claim: remove tasks claimed by other peers
    meshPeer.on("task_claim", async (msg: MeshMessage) => {
      const p = msg.payload as { subtaskId?: string; claimedByCoordinator?: string };
      if (p.subtaskId && p.claimedByCoordinator !== AGENT_ID) {
        const idx = meshTaskQueue.findIndex(t => t.subtask.id === p.subtaskId);
        if (idx >= 0) {
          meshTaskQueue.splice(idx, 1);
          console.log(`[agent:${AGENT_ID}] mesh task claimed by ${p.claimedByCoordinator}: ${p.subtaskId}`);
        }
      }
    });

    // Bootstrap and the coordinator WebSocket wait for a verified coordinator and a mesh token
    // (startMeshUplink, after registration).
  } catch (e) {
    console.warn(`[agent:${AGENT_ID}] mesh peer init failed (non-fatal): ${String(e)}`);
    meshPeer = null;
    meshServer = null;
  }

  // Initialize BLE mesh transport for local peer discovery
  let bleMesh: BLEMeshManager | null = null;
  let bleTransport: NobleBLETransport | null = null;
  /**
   * Bootstrap the mesh peer from the coordinator and open the persistent WebSocket (NAT traversal:
   * the coordinator pushes gossip down it). Only once the coordinator has proven its key and a
   * mesh token exists; the WebSocket then follows the verified coordinator on reconnect.
   */
  let meshUplinkStarted = false;
  function startMeshUplink(): void {
    if (!meshPeer || meshUplinkStarted || !meshAuthToken || !coordinator.isVerified()) return;
    meshUplinkStarted = true;
    const peer = meshPeer;
    peer.config.bootstrapUrls = [coordinator.url];
    void peer
      .bootstrap()
      .then(() => console.log(`[agent:${AGENT_ID}] mesh peer bootstrapped, ${peer.peerCount()} peers known`))
      .catch((e) => console.warn(`[agent:${AGENT_ID}] mesh bootstrap failed (non-fatal): ${String(e)}`));
    connectMeshWebSocket(() => meshPeer);
  }
  /** Use the mesh token a coordinator's /register response provisions (heartbeats and pulls need it). */
  function adoptMeshToken(token: unknown): void {
    if (typeof token === "string" && token.length > 0 && token !== meshAuthToken) {
      meshAuthToken = token;
      console.log(`[agent:${AGENT_ID}] mesh token provisioned from coordinator register response`);
      // The LAN mesh server refuses everything but /identity until it has a token.
      meshServer?.setMeshToken(token);
      meshPeer?.setMeshToken(token);
      if (bleTransport) bleTransport.updateAdvertisement({ meshTokenHash: computeMeshTokenHash() });
      if (bleMesh) bleMesh.setOwnTokenHash(computeMeshTokenHash());
    }
    startMeshUplink();
  }
  const bleGuard = new BleRequestGuard();
  // EDGECODER_BLE=0: the user turned BLE peer discovery off in the app.
  if (OS === "macos" && process.env.EDGECODER_BLE === "0") console.log(`[agent:${AGENT_ID}] BLE mesh off (turned off in settings)`);
  if (OS === "macos" && process.env.EDGECODER_BLE !== "0") {
    try {
      bleTransport = new NobleBLETransport(AGENT_ID);
      await bleTransport.init();
      bleMesh = new BLEMeshManager(AGENT_ID, AGENT_ID, bleTransport, localStore);
      bleMesh.setOwnTokenHash(computeMeshTokenHash());
      bleTransport.startAdvertising({
        agentId: AGENT_ID,
        model: OLLAMA_MODEL,
        modelParamSize: 0,
        memoryMB: Math.round(totalmem() / 1_000_000),
        batteryPct: 100,
        currentLoad: 0,
        deviceType: "laptop",
        meshTokenHash: computeMeshTokenHash(),
      });
      bleTransport.startScanning();

      // Register handler for incoming BLE task requests (from iOS peers)
      bleTransport.onTaskRequest(async (req) => {
        // Admission: no mesh token here means no remote BLE work at all; otherwise the requester
        // must advertise the same token hash, within size and rate limits. BLE adverts carry no
        // public key, so requesterSignature cannot be verified against an identity.
        const requesterPeer = bleTransport!.discoveredPeers().find(p => p.agentId === req.requesterId);
        const admission = bleGuard.admit({
          ownTokenHash: computeMeshTokenHash(),
          requesterTokenHash: requesterPeer?.meshTokenHash,
          requesterId: String(req.requesterId ?? ""),
          task: req.task
        });
        if (!admission.ok) {
          console.warn(`[BLE] rejecting task from ${req.requesterId}: ${admission.reason}`);
          return {
            requestId: req.requestId,
            providerId: AGENT_ID,
            status: "failed" as const,
            output: admission.reason,
            cpuSeconds: 0,
            providerSignature: "",
          };
        }

        console.log(`[BLE] processing incoming task: ${req.requestId}`);
        const subtaskId = `ble-${req.requestId}`;
        try { localStore.recordTaskStart(subtaskId, subtaskId, req.task, req.language ?? "python", "ble-incoming", "ble-mesh"); } catch (e) { console.warn(`[db] BLE task start write failed: ${e}`); }
        const started = Date.now();
        try {
          const response = await providers.current().generate({ prompt: req.task });
          const durationMs = Date.now() - started;
          try { localStore.recordTaskComplete(subtaskId, response.text, durationMs); } catch (e) { console.warn(`[db] BLE task complete write failed: ${e}`); }
          const taskHash = computeTaskHash(req.task);
          return {
            requestId: req.requestId,
            providerId: AGENT_ID,
            status: "completed" as const,
            output: response.text,
            cpuSeconds: durationMs / 1000,
            providerSignature: signPayload(JSON.stringify({ providerId: AGENT_ID, status: "completed", cpuSeconds: durationMs / 1000, taskHash }), keys.privateKeyPem),
          };
        } catch (e) {
          const durationMs = Date.now() - started;
          try { localStore.recordTaskFailed(subtaskId, String(e), durationMs); } catch (dbErr) { console.warn(`[db] BLE task fail write failed: ${dbErr}`); }
          const taskHash = computeTaskHash(req.task);
          return {
            requestId: req.requestId,
            providerId: AGENT_ID,
            status: "failed" as const,
            output: String(e),
            cpuSeconds: durationMs / 1000,
            providerSignature: signPayload(JSON.stringify({ providerId: AGENT_ID, status: "failed", cpuSeconds: durationMs / 1000, taskHash }), keys.privateKeyPem),
          };
        }
      });

      // Say what actually works: the transport "initializes" even when its native parts are missing.
      const caps = bleTransport?.capabilities();
      if (caps && !caps.scanning && !caps.advertising) console.warn(`[agent:${AGENT_ID}] BLE mesh unavailable: Bluetooth native modules are missing from this install`);
      else console.log(`[agent:${AGENT_ID}] BLE mesh transport initialized${caps ? ` (scanning ${caps.scanning ? "on" : "off"}, advertising ${caps.advertising ? "on" : "off"})` : ""}`);
    } catch (e) {
      console.warn(`[agent:${AGENT_ID}] BLE mesh init failed (non-fatal): ${String(e)}`);
      bleTransport = null;
    }
  }
  // ── Binary integrity self-check ──
  let binaryIntegrity: { distHash: string; releaseVersion: string; releaseSignature: string; distributionChannel: string } | undefined;
  try {
    const distDir = new URL("../../dist", import.meta.url).pathname;
    const distHash = await computeDistHash(distDir);
    const signed = await loadReleaseManifest(distDir);
    const distributionChannel = detectDistributionChannel();
    binaryIntegrity = {
      distHash,
      releaseVersion: signed?.manifest.version ?? "unknown",
      releaseSignature: signed?.signature ?? "",
      distributionChannel,
    };
    console.log(`[agent:${AGENT_ID}] binary integrity: dist=${distHash.slice(0, 12)}... channel=${distributionChannel}`);
  } catch (e) {
    console.warn(`[agent:${AGENT_ID}] binary integrity check failed (non-fatal): ${String(e)}`);
  }

  let bleTaskTestDone = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const powerTelemetry = readAgentPowerTelemetry();

      if (coordinatorOnline) {
        // ═══ ONLINE PATH: all coordinator HTTP calls ═══
        // Re-steer now and then; hysteresis keeps the current coordinator unless another is clearly faster.
        if (coordinatorSteering && Date.now() - lastSteeredAtMs >= STEERING_INTERVAL_MS) {
          const steered = await steerCoordinator();
          if (steered && coordinator.set(steered.url, "steering")) cacheCoordinatorUrl(coordinator.url);
        }
        // ── Sandbox policy enforcement ──
        const sandboxError = await enforceSandboxPolicy(SANDBOX_MODE, SANDBOX_REQUIRED);
        if (sandboxError?.startsWith("sandbox_required")) {
          console.error(`[agent:${AGENT_ID}] ${sandboxError}`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        // Docker configured but not running: stay registered (the IDE forwarder and heartbeats
        // keep working) but pull nothing until it is back.
        if (!sandboxError && !sandboxImagesReady && !sandboxImagesBuilding) {
          sandboxImagesBuilding = true;
          console.log(`[agent:${AGENT_ID}] preparing sandbox images (first run builds them; this can take a few minutes)`);
          void ensureSandboxImages().then((r) => {
            sandboxImagesBuilding = false;
            sandboxImagesReady = r.ok;
            if (!r.ok) console.warn(`[agent:${AGENT_ID}] sandbox images not ready: ${r.error}`);
          });
        }
        const sandboxProblem = sandboxError ?? (sandboxImagesReady ? null : "sandbox images not ready");
        if (Boolean(sandboxProblem) !== sandboxDown) {
          sandboxDown = Boolean(sandboxProblem);
          console.warn(`[agent:${AGENT_ID}] ${sandboxDown ? `${sandboxProblem}; not pulling swarm tasks until it is` : "sandbox available again; pulling swarm tasks"}`);
        }

        // Pinned-key trust: the coordinator proves possession of its key before any register,
        // heartbeat or pull (re-proven on URL change, on reconnect and when the check expires).
        await verifyCoordinatorOrThrow();
        // Self-benchmark when due (startup, then every BENCHMARK_INTERVAL_MS), before any task runs alongside it.
        if (BENCHMARK_ENABLED && Date.now() >= benchmarkDueAtMs) {
          benchmarkDueAtMs = Date.now() + BENCHMARK_INTERVAL_MS;
          try {
            lastBenchmark = await runLocalBenchmark({ ollama: currentProvider === "ollama-local" ? { host: OLLAMA_HOST, model: OLLAMA_MODEL } : undefined });
            benchmarkUnreported = true;
            console.log(`[agent:${AGENT_ID}] benchmark: cpu=${lastBenchmark.cpu?.workUnitsPerSec ?? "-"} units/s gpu=${lastBenchmark.gpu ? `${lastBenchmark.gpu.tokensPerSec} tok/s (${lastBenchmark.gpu.bandwidthGbps ?? "?"} GB/s)` : "-"} in ${lastBenchmark.durationMs} ms`);
          } catch (e) {
            console.warn(`[agent:${AGENT_ID}] benchmark failed: ${e}`);
          }
        }
        if (shouldRegister({ registeredWithUrl, lastRegisteredAtMs }, coordinator.url, Date.now(), REGISTER_REFRESH_MS)) {
          if (currentProvider === "ollama-local") installedModelsCache = undefined; // register reads them fresh
          const installedModels = currentProvider === "ollama-local" ? await installedModelsCached() : [];
          const registerBody = {
            ...(installedModels.length ? { installedModels, activeModel: installedModels.includes(OLLAMA_MODEL) ? OLLAMA_MODEL : installedModels[0] } : {}),
            agentId: AGENT_ID,
            ...(AGENT_DEVICE_ID ? { deviceId: AGENT_DEVICE_ID } : {}),
            os: OS,
            version: "0.1.0",
            mode: effectiveMode,
            registrationToken: AGENT_REGISTRATION_TOKEN,
            localModelProvider: currentProvider,
            clientType: AGENT_CLIENT_TYPE,
            maxConcurrentTasks: MAX_CONCURRENT_TASKS,
            sandboxMode: SANDBOX_MODE,
            powerTelemetry,
            publicKeyPem: keys.publicKeyPem,
            x25519PublicKey: envelopeKeys.publicKey.toString("base64"),
            hardwareProfile: HARDWARE_PROFILE,
            ...(BENCHMARK_ENABLED ? { challengeKinds: currentProvider === "ollama-local" ? ["cpu", "gpu"] : ["cpu"] } : {}),
            ...(lastBenchmark ? { benchmark: lastBenchmark } : {}),
            ...(ASK_MSAT_PER_CREDIT !== undefined ? { askMsatPerCredit: ASK_MSAT_PER_CREDIT } : {}),
            ...(binaryIntegrity ? { binaryIntegrity } : {})
          };
          const registerResponse = (await post("/register", registerBody, {
            signed: true,
          })) as {
            accepted?: boolean;
            meshToken?: string;
          };
          registeredWithUrl = coordinator.url;
          lastRegisteredAtMs = Date.now();
          adoptMeshToken(registerResponse.meshToken);
        }

        const hbStart = Date.now();
        // #54: the installed-model list rides every heartbeat (cached), so a pulled or removed model is routed correctly.
        const hbModels = currentProvider === "ollama-local" ? await installedModelsCached() : [];
        const hbBody = { agentId: AGENT_ID, powerTelemetry, sandboxMode: SANDBOX_MODE, ...(hbModels.length ? { installedModels: hbModels } : {}), ...(benchmarkUnreported && lastBenchmark ? { benchmark: lastBenchmark } : {}) };
        const hb = (await post("/heartbeat", hbBody, { signed: true })) as {
          ok?: boolean;
          blacklisted?: boolean;
          reason?: string;
          orchestration?: {
            provider: "edgecoder-local" | "ollama-local";
            model?: string;
            autoInstall: boolean;
            pending: boolean;
          } | null;
          tunnelInvites?: Array<{ fromAgentId: string; token: string }>;
          tunnelCloseNotices?: Array<{ peerAgentId: string; token: string; reason: string }>;
          directWorkOffers?: Array<{
            offerId: string;
            fromAgentId: string;
            toAgentId: string;
            workType: "code_task" | "model_inference";
            language?: "python" | "javascript";
            input: string;
          }>;
          blacklist?: { version: number; agents: string[] };
          benchmarkChallenge?: BenchmarkChallenge;
          hardwareVerification?: { status?: string; claimedTier?: string; grantedTier?: string } | null;
        };
        if ("benchmark" in hbBody) benchmarkUnreported = false;
        try { localStore.recordHeartbeat(coordinator.url, hb.blacklisted ? "blacklisted" : "ok", Date.now() - hbStart); } catch (e) { console.warn(`[db] heartbeat write failed: ${e}`); }

        // Heartbeat succeeded — reset failure counter and cache proven URL
        consecutiveFailures = 0;
        cacheCoordinatorUrl(coordinator.url);

        if (hb.blacklisted) {
          console.error(`[agent:${AGENT_ID}] blacklisted by coordinator: ${hb.reason ?? "policy_violation"}`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        // Coordinator benchmark challenge: answer now, before pulling work (its clock is running).
        if (hb.benchmarkChallenge && challengeAcceptable(hb.benchmarkChallenge)) {
          const answer = await answerChallenge(hb.benchmarkChallenge, { ollamaHost: OLLAMA_HOST });
          const answerBody = { agentId: AGENT_ID, ...answer };
          try {
            const res = (await post("/benchmark/response", answerBody, { retries: 0, signed: true })) as {
              verification?: { status?: string; grantedTier?: string; claimedTier?: string } | null;
            };
            const v = res?.verification;
            console.log(`[agent:${AGENT_ID}] benchmark challenge ${answer.kind}${answer.declined ? ` declined (${answer.declined})` : ""}: ${v ? `${v.status} ${v.grantedTier}/${v.claimedTier}` : "answered"}`);
          } catch (e) {
            console.warn(`[agent:${AGENT_ID}] benchmark challenge answer failed: ${e}`);
          }
        }
        const blacklistSet = new Set(hb.blacklist?.agents ?? []);
        for (const notice of hb.tunnelCloseNotices ?? []) {
          peerTunnels.delete(notice.peerAgentId);
          await post("/agent-mesh/close-ack", { agentId: AGENT_ID, token: notice.token }, { signed: true });
        }
        for (const invite of hb.tunnelInvites ?? []) {
          if (blacklistSet.has(invite.fromAgentId)) continue;
          await post("/agent-mesh/accept", { agentId: AGENT_ID, token: invite.token }, { signed: true });
          peerTunnels.set(invite.fromAgentId, invite.token);
        }

        const idlePeersResponse = await coordinatorGet(`/agent-mesh/peers/${AGENT_ID}`);
        if (idlePeersResponse.statusCode >= 200 && idlePeersResponse.statusCode < 300) {
          const peersJson = (await parseJsonBodySafe(idlePeersResponse)) as { peers?: string[] };
          for (const peerId of (peersJson.peers ?? []).slice(0, 2)) {
            if (blacklistSet.has(peerId)) continue;
            if (peerId === AGENT_ID) continue;
            if (peerTunnels.has(peerId)) continue;
            const connect = await signedJsonPost("/agent-mesh/connect", { fromAgentId: AGENT_ID, toAgentId: peerId });
            if (connect.statusCode >= 200 && connect.statusCode < 300) {
              const body = (await parseJsonBodySafe(connect)) as { token?: string };
              if (body.token) peerTunnels.set(peerId, body.token);
            }
          }
        }

        for (const token of peerTunnels.values()) {
          const relayRes = await signedJsonPost("/agent-mesh/relay", {
            token,
            fromAgentId: AGENT_ID,
            payload: `ping:${Date.now()}`
          });
          if (relayRes.statusCode === 404 || relayRes.statusCode === 403) {
            for (const [peerId, peerToken] of peerTunnels.entries()) {
              if (peerToken === token) peerTunnels.delete(peerId);
            }
          }
        }

        if (hb.orchestration?.pending) {
          const reportStatus = async (phase: string, message: string, progressPct?: number): Promise<void> => {
            try {
              await post("/orchestration/agents/" + AGENT_ID + "/status", { phase, message, progressPct }, { signed: true });
            } catch {
              // best-effort; coordinator may be unreachable
            }
          };
          try {
            await reportStatus("starting", "Preparing to switch model…");
            const switchModel = hb.orchestration.model ?? OLLAMA_MODEL;
            // A coordinator may only name Ollama library models, and never installs the binary.
            if (!isOllamaLibraryModelName(switchModel)) throw new Error("orchestration_model_rejected");
            await ensureOllamaModelInstalled(
              {
                enabled: hb.orchestration.provider === "ollama-local",
                autoInstall: hb.orchestration.autoInstall,
                model: switchModel,
                role: "agent",
                host: OLLAMA_HOST,
                allowBinaryInstall: false
              },
              reportStatus
            );
            currentProvider = hb.orchestration.provider;
            providers.use(currentProvider);
            await reportStatus("done", "Model switch complete.");
            try {
              await post(
                `/orchestration/agents/${AGENT_ID}/ack`,
                { ok: true },
                { retries: Math.max(3, COORDINATOR_POST_RETRIES + 1), timeoutMs: Math.max(20000, COORDINATOR_HTTP_TIMEOUT_MS), signed: true }
              );
            } catch (ackError) {
              console.warn(`[agent:${AGENT_ID}] orchestration ack retry exhausted: ${String(ackError)}`);
              await reportStatus("warning", "Model switch done locally; waiting for coordinator ack retry.").catch(() => {});
            }
          } catch (error) {
            await reportStatus("error", String(error)).catch(() => {});
            await post(
              `/orchestration/agents/${AGENT_ID}/ack`,
              {
                ok: false,
                error: String(error)
              },
              { retries: Math.max(3, COORDINATOR_POST_RETRIES + 1), timeoutMs: Math.max(20000, COORDINATOR_HTTP_TIMEOUT_MS), signed: true }
            ).catch(() => {});
          }
        }

        const pullBody = { agentId: AGENT_ID };
        if (!SWARM_EXECUTION_ENABLED && !warnedNoSandbox) {
          warnedNoSandbox = true;
          console.warn(`[agent:${AGENT_ID}] SANDBOX_MODE=none: not pulling swarm tasks (install Docker and set SANDBOX_MODE=docker to contribute compute)`);
        }
        const pulled = (SWARM_EXECUTION_ENABLED && !sandboxDown
          ? await post("/pull", pullBody, { signed: true })
          : { subtask: null }) as {
          subtask: Subtask | null;
          envelope?: TaskEnvelope;
        };

        // Decrypt envelope if coordinator sent an encrypted task
        let taskEnvelope: TaskEnvelope | undefined;
        if (pulled.envelope) {
          try {
            const decrypted = decryptTaskEnvelope(pulled.envelope, envelopeKeys.privateKey);
            pulled.subtask = {
              id: pulled.envelope.subtaskId,
              // Coordinators before this change did not send taskId; they now correct it on /result.
              taskId: pulled.envelope.metadata.taskId ?? pulled.envelope.subtaskId,
              kind: (pulled.envelope.metadata.kind as Subtask["kind"] | undefined) ?? "single_step",
              ...(pulled.envelope.metadata.requestedModel ? { requestedModel: pulled.envelope.metadata.requestedModel } : {}),
              input: decrypted.input,
              snapshotRef: decrypted.snapshotRef,
              language: decrypted.kind as Language,
              timeoutMs: pulled.envelope.metadata.timeoutMs ?? 60_000,
              projectMeta: {
                projectId: "default",
                resourceClass: (pulled.envelope.metadata.resourceClass as "cpu" | "gpu") ?? "cpu",
                priority: pulled.envelope.metadata.priority ?? 50,
              },
            };
            taskEnvelope = pulled.envelope;
            console.log(`[agent:${AGENT_ID}] decrypted envelope task: ${pulled.envelope.subtaskId}`);
          } catch (envelopeErr) {
            console.error(`[agent:${AGENT_ID}] envelope decryption failed: ${envelopeErr}`);
          }
        }

        if (pulled.subtask) {
          const st = pulled.subtask;

          // ── Frozen snapshot enforcement (Design Decision #8; same check for every source) ──
          const snapshotPolicy = checkSnapshotPolicy(st, SNAPSHOT_ENFORCEMENT);
          if (!snapshotPolicy.run) {
            console.error(`[agent:${AGENT_ID}] snapshot enforcement: ${snapshotPolicy.error}`);
            try {
              // Sign exactly the body that is posted (the signature covers the body hash).
              const snapshotRejection = {
                subtaskId: st.id, taskId: st.taskId, agentId: AGENT_ID,
                ok: false, output: "", error: "snapshot_invalid: frozen snapshot enforcement rejected this subtask",
                durationMs: 0,
              };
              await post("/result", snapshotRejection, { signed: true });
            } catch { /* best effort */ }
            continue;
          } else if (snapshotPolicy.warning) {
            console.warn(`[agent:${AGENT_ID}] snapshot warning: ${snapshotPolicy.warning}`);
          } else if (snapshotPolicy.verified) {
            console.log(`[agent:${AGENT_ID}] snapshot verified for subtask ${st.id}: ${st.snapshotRef}`);
          }

          // ── PRIMARY: Local execution (HTTP mesh is primary, BLE is last resort) ──
          const envelopeForTask = taskEnvelope;
          const runAndReport = async () => {
            try { localStore.recordTaskStart(st.id, st.taskId, st.input, st.language, currentProvider, coordinator.url); } catch (e) { console.warn(`[db] task start write failed: ${e}`); }
            // #51: keep the coordinator's claim lease alive while the subtask runs.
            const stopLeaseHeartbeat = startLeaseHeartbeat();
            const run = st.kind === "inference"
              ? runInferenceSubtask(st, { agentId: AGENT_ID, ollamaHost: OLLAMA_HOST ?? "http://127.0.0.1:11434", post: (path, body) => post(path, body, { retries: 0, timeoutMs: 10_000, signed: true }) })
              : runPolicedSubtask(st, { quiet: true });
            if (st.kind === "inference") console.log(`[agent:${AGENT_ID}] running inference ${st.id} on ${st.requestedModel}`);
            const result = await run.finally(stopLeaseHeartbeat);
            result.snapshotRef = st.snapshotRef;
            try {
              if (result.ok) {
                localStore.recordTaskComplete(st.id, result.output, result.durationMs);
              } else {
                localStore.recordTaskFailed(st.id, result.error ?? "unknown", result.durationMs);
              }
            } catch (e) { console.warn(`[db] task result write failed: ${e}`); }
            const reportNonce = randomUUID();
            const reportSignature = signPayload(
              JSON.stringify({
                subtaskId: result.subtaskId,
                taskId: result.taskId,
                agentId: result.agentId,
                ok: result.ok,
                durationMs: result.durationMs,
                reportNonce
              }),
              keys.privateKeyPem
            );
            result.reportNonce = reportNonce;
            result.reportSignature = reportSignature;

            // Encrypt result if task was received as an envelope
            let resultPayload: Record<string, unknown> = { ...result };
            if (envelopeForTask) {
              // Fails closed: if the result cannot be encrypted, report a failure without the output.
              const sealed = envelopeResultPayload(
                result,
                envelopeForTask,
                (r, env) => encryptResult(r, env, envelopeKeys.privateKey),
                (ok) => {
                  const nonce = randomUUID();
                  return {
                    reportNonce: nonce,
                    reportSignature: signPayload(
                      JSON.stringify({ subtaskId: result.subtaskId, taskId: result.taskId, agentId: result.agentId, ok, durationMs: result.durationMs, reportNonce: nonce }),
                      keys.privateKeyPem
                    )
                  };
                }
              );
              resultPayload = sealed.payload;
              if (sealed.encrypted) console.log(`[agent:${AGENT_ID}] encrypted result for envelope task: ${result.subtaskId}`);
              else console.error(`[agent:${AGENT_ID}] result encryption failed for ${result.subtaskId}; reporting failure without output: ${sealed.error}`);
            }
            // #54: say which model produced the result (inside the signed request); the coordinator
            // rejects a result whose model isn't the one the subtask requested.
            const ranModel = st.kind === "inference" ? st.requestedModel : currentProvider === "ollama-local" ? OLLAMA_MODEL : undefined;
            if (ranModel) resultPayload.model = ranModel;
            // Work receipt claim (architecture step 2): the coordinator countersigns this after accrual.
            const finishedAtMs = Date.now();
            resultPayload.receipt = signReceiptAsAgent(
              {
                taskId: result.taskId,
                subtaskId: result.subtaskId,
                agentId: result.agentId,
                agentPublicKeyPem: keys.publicKeyPem,
                startedAtMs: Math.max(0, finishedAtMs - Math.max(0, Math.round(result.durationMs))),
                finishedAtMs,
                // The output actually reported ("" when encryption failed and it was withheld).
                resultHash: hashResultOutput(typeof resultPayload.output === "string" ? resultPayload.output : result.output)
              },
              keys.privateKeyPem
            );

            try {
              await post("/result", resultPayload, { signed: true });
            } catch (resultErr) {
              try { localStore.enqueuePendingResult(result.subtaskId, JSON.stringify(resultPayload)); } catch (e) { console.warn(`[db] pending result write failed: ${e}`); }
              console.warn(`[agent:${AGENT_ID}] result buffered for retry: ${result.subtaskId}`);
            }
          };
          // Model calls run side by side (Ollama serves several at once); code jobs one at a time.
          if (st.kind === "inference" && MAX_PARALLEL_INFERENCE > 1) {
            while (inflightInference.size >= MAX_PARALLEL_INFERENCE) await Promise.race(inflightInference);
            const job: Promise<void> = runAndReport()
              .catch((e) => console.warn(`[agent:${AGENT_ID}] inference ${st.id} failed: ${String(e)}`))
              .finally(() => inflightInference.delete(job));
            inflightInference.add(job);
            continue;
          }
          await runAndReport();
          continue;
        }

        // ── Mesh task execution: process tasks received via gossip ──
        if (SWARM_EXECUTION_ENABLED && meshPeer && meshTaskQueue.length > 0) {
          const meshItem = meshTaskQueue.shift()!;
          const st = meshItem.subtask;
          console.log(`[agent:${AGENT_ID}] executing mesh task: ${st.id} (snapshot: ${st.snapshotRef})`);
          try { localStore.recordTaskStart(st.id, st.taskId, st.input, st.language, currentProvider, "mesh-gossip"); } catch (e) { console.warn(`[db] mesh task start write failed: ${e}`); }
          const result = await runPolicedSubtask(st);
          result.snapshotRef = st.snapshotRef;
          try {
            if (result.ok) localStore.recordTaskComplete(st.id, result.output, result.durationMs);
            else localStore.recordTaskFailed(st.id, result.error ?? "unknown", result.durationMs);
          } catch (e) { console.warn(`[db] mesh task result write failed: ${e}`); }
          // Broadcast result to mesh
          await meshPeer.broadcast("result_announce", {
            taskId: result.taskId,
            subtaskId: result.subtaskId,
            ok: result.ok,
            output: result.output,
            durationMs: result.durationMs,
            snapshotRef: result.snapshotRef,
          });
          // Also try to report to coordinator (best effort)
          try {
            const reportNonce = randomUUID();
            const reportSignature = signPayload(
              JSON.stringify({
                subtaskId: result.subtaskId, taskId: result.taskId,
                agentId: result.agentId, ok: result.ok, durationMs: result.durationMs, reportNonce
              }),
              keys.privateKeyPem
            );
            result.reportNonce = reportNonce;
            result.reportSignature = reportSignature;
            await post("/result", result, { signed: true });
          } catch { /* mesh broadcast is primary delivery */ }
          console.log(`[agent:${AGENT_ID}] mesh task ${st.id} complete: ok=${result.ok}`);
          continue;
        }

        // If coordinator has no work assigned, accept direct peer work first.
        const incomingDirect = hb.directWorkOffers ?? [];
        const canUsePeerDirect = allowPeerDirectWork(powerTelemetry);
        if (incomingDirect.length > 0 && canUsePeerDirect) {
          const offer = incomingDirect.find((item) => !blacklistSet.has(item.fromAgentId));
          if (!offer) {
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          const accepted = await signedJsonPost("/agent-mesh/direct-work/accept", {
            offerId: offer.offerId,
            byAgentId: AGENT_ID
          });
          if (accepted.statusCode >= 200 && accepted.statusCode < 300) {
            let peerResult: { ok: boolean; output: string; error?: string; durationMs: number };
            if (offer.workType === "model_inference") {
              const started = Date.now();
              try {
                const response = await providers.current().generate({ prompt: offer.input });
                peerResult = {
                  ok: true,
                  output: response.text,
                  durationMs: Date.now() - started
                };
              } catch (error) {
                peerResult = {
                  ok: false,
                  output: "",
                  error: String(error),
                  durationMs: Date.now() - started
                };
              }
            } else {
              const peerSubtask: Subtask = {
                id: `peer-${offer.offerId}`,
                taskId: `peer-direct-${offer.offerId}`,
                kind: "single_step",
                language: offer.language ?? "python",
                input: offer.input,
                timeoutMs: 4000,
                snapshotRef: "peer-direct",
                projectMeta: {
                  projectId: "peer-direct",
                  resourceClass: "cpu",
                  priority: 10
                }
              };
              const result = SWARM_EXECUTION_ENABLED
                ? await runPolicedSubtask(peerSubtask)
                : { ok: false, output: "", error: "sandbox_required_for_remote_task", durationMs: 0 };
              peerResult = {
                ok: result.ok,
                output: result.output,
                error: result.error,
                durationMs: result.durationMs
              };
            }
            await signedJsonPost("/agent-mesh/direct-work/result", {
              offerId: offer.offerId,
              byAgentId: AGENT_ID,
              ok: peerResult.ok,
              output: peerResult.output,
              error: peerResult.error,
              durationMs: peerResult.durationMs
            });
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
        }

        // While idle, offer direct work to nearby peers for spare compute utilization.
        if (canUsePeerDirect) {
          const peersResponse = await coordinatorGet(`/agent-mesh/peers/${AGENT_ID}`);
          if (peersResponse.statusCode >= 200 && peersResponse.statusCode < 300) {
            const peersJson = (await parseJsonBodySafe(peersResponse)) as { peers?: string[] };
            const now = Date.now();
            for (const peerId of (peersJson.peers ?? []).slice(0, 2)) {
              if (blacklistSet.has(peerId)) continue;
              if (peerId === AGENT_ID) continue;
              const lastOffer = lastOfferAtByPeer.get(peerId) ?? 0;
              if (now - lastOffer < peerOfferCooldownMs) continue;
              const workInput = PEER_DIRECT_WORK_ITEMS[peerWorkCursor % PEER_DIRECT_WORK_ITEMS.length].trim();
              peerWorkCursor += 1;
              if (!workInput) continue;
              const offerRes = await signedJsonPost("/agent-mesh/direct-work/offer", {
                fromAgentId: AGENT_ID,
                toAgentId: peerId,
                workType: "code_task",
                language: "python",
                input: workInput
              });
              if (offerRes.statusCode >= 200 && offerRes.statusCode < 300) {
                lastOfferAtByPeer.set(peerId, now);
              }
            }
          }
        }
      } else {
        // ═══ OFFLINE PATH: periodic reconnect probe ═══
        const now = Date.now();
        if (now - lastReconnectProbeMs > reconnectProbeIntervalMs) {
          lastReconnectProbeMs = now;
          try {
            const probeStart = Date.now();
            // Only register once the coordinator answers at all: an unauthenticated read costs
            // nothing against the registration-storm rule.
            const reach = await request(`${coordinator.url}/identity`, { method: "GET", headersTimeout: 5000, bodyTimeout: 5000 });
            await reach.body.dump();
            if (reach.statusCode < 200 || reach.statusCode >= 300) throw new Error(`coordinator unreachable (${reach.statusCode})`);
            // Reconnecting: the coordinator proves its key again before we register.
            await verifyCoordinatorOrThrow({ force: true });
            // Re-register first (coordinator may have restarted and lost agent state)
            const registerBody = {
              agentId: AGENT_ID,
              ...(AGENT_DEVICE_ID ? { deviceId: AGENT_DEVICE_ID } : {}),
              os: OS, version: "0.1.0", mode: effectiveMode,
              registrationToken: AGENT_REGISTRATION_TOKEN,
              localModelProvider: currentProvider,
              clientType: AGENT_CLIENT_TYPE,
              maxConcurrentTasks: MAX_CONCURRENT_TASKS,
              powerTelemetry,
              publicKeyPem: keys.publicKeyPem
            };
            // Keep the mesh token from this register too: an agent that went offline before its first
            // registration has none, and without it every heartbeat is refused (mesh_unauthorized).
            const probeRegister = (await post("/register", registerBody, { retries: 0, timeoutMs: 5000, signed: true })) as { meshToken?: string };
            adoptMeshToken(probeRegister.meshToken);
            const probeBody = { agentId: AGENT_ID, powerTelemetry };
            await post("/heartbeat", probeBody, { retries: 0, timeoutMs: 5000, signed: true });
            const probeLatency = Date.now() - probeStart;
            try { localStore.recordHeartbeat(coordinator.url, "reconnected", probeLatency); } catch {}
            // Probe succeeded — back online
            coordinatorOnline = true;
            consecutiveFailures = 0;
            cacheCoordinatorUrl(coordinator.url);
            bleMesh?.setOffline(false);
            // The probe just registered: don't register again on the next online tick.
            registeredWithUrl = coordinator.url;
            lastRegisteredAtMs = Date.now();
            reconnectProbeIntervalMs = RECONNECT_PROBE_MIN_MS;
            console.log(`[agent:${AGENT_ID}] coordinator back online (probe latency: ${probeLatency}ms)`);
            await flushPendingResults();
            await flushOfflineLedger();
          } catch (err) {
            reconnectProbeIntervalMs = Math.min(reconnectProbeIntervalMs * 2, RECONNECT_PROBE_MAX_MS);
            console.log(`[agent:${AGENT_ID}] offline probe failed (${String(err).slice(0, 200)}); next probe in ${Math.round(reconnectProbeIntervalMs / 1000)}s`);
          }
        }

        // Process outbound task queue via BLE peers while offline
        if (bleMesh && bleTransport) {
          const peers = bleTransport.discoveredPeers();
          for (const peer of peers) {
            const task = localStore.claimNextOutbound(peer.agentId);
            if (!task) continue;
            const bleReq: BLETaskRequest = {
              requestId: task.id,
              requesterId: AGENT_ID,
              task: task.prompt,
              language: task.language as Language,
              requesterSignature: signPayload(JSON.stringify({ requesterId: AGENT_ID, taskHash: computeTaskHash(task.prompt) }), keys.privateKeyPem),
            };
            try {
              const resp = await bleMesh.routeTask(bleReq, 0);
              if (resp && resp.status === "completed") {
                try { localStore.recordBLETaskResult(resp.providerId, true); } catch {}
                localStore.completeOutbound(task.id, resp.output ?? "");
                console.log(`[agent:${AGENT_ID}] BLE outbound task completed: ${task.id}`);
              } else {
                if (resp) { try { localStore.recordBLETaskResult(resp.providerId, false); } catch {} }
                localStore.failOutbound(task.id);
                console.warn(`[agent:${AGENT_ID}] BLE outbound task failed: ${task.id}`);
              }
            } catch (e) {
              localStore.failOutbound(task.id);
              console.warn(`[agent:${AGENT_ID}] BLE outbound task error: ${task.id} - ${String(e)}`);
            }
          }
        }
      }

      // ── Mesh task execution during offline mode ──
      if (SWARM_EXECUTION_ENABLED && !coordinatorOnline && meshPeer && meshTaskQueue.length > 0) {
        const meshItem = meshTaskQueue.shift()!;
        const st = meshItem.subtask;
        console.log(`[agent:${AGENT_ID}] executing mesh task (offline): ${st.id} (snapshot: ${st.snapshotRef})`);
        try { localStore.recordTaskStart(st.id, st.taskId, st.input, st.language, currentProvider, "mesh-gossip"); } catch {}
        const result = await runPolicedSubtask(st);
        result.snapshotRef = st.snapshotRef;
        try {
          if (result.ok) localStore.recordTaskComplete(st.id, result.output, result.durationMs);
          else localStore.recordTaskFailed(st.id, result.error ?? "unknown", result.durationMs);
        } catch {}
        await meshPeer.broadcast("result_announce", {
          taskId: result.taskId, subtaskId: result.subtaskId,
          ok: result.ok, output: result.output, durationMs: result.durationMs,
          snapshotRef: result.snapshotRef,
        });
        console.log(`[agent:${AGENT_ID}] mesh task ${st.id} complete (offline): ok=${result.ok}`);
      }

      // ═══ BLE peer discovery — only in offline mode or when explicitly enabled ═══
      // BLE is a last-resort transport; HTTP mesh is primary for task distribution.
      if (bleTransport && (!coordinatorOnline || process.env.BLE_TEST_ENABLED === "true")) {
        const blePeers = bleTransport.discoveredPeers();
        if (blePeers.length > 0) {
          try { for (const p of blePeers) { localStore.upsertBLEPeer(p.agentId, p.model, p.modelParamSize, p.deviceType, p.rssi); } } catch (e) { console.warn(`[db] BLE peer write failed: ${e}`); }
          console.log(`[agent:${AGENT_ID}] BLE peers (offline): ${blePeers.map(p => `${p.agentId}(rssi:${p.rssi})`).join(", ")}`);

          if (!bleTaskTestDone && process.env.BLE_TEST_ENABLED === "true") {
            bleTaskTestDone = true;
            const peer = blePeers[0];
            console.log(`[BLE-TEST] will send test task to ${peer.agentId} in 5s...`);
            setTimeout(async () => {
              try {
                console.log(`[BLE-TEST] sending test task to ${peer.agentId} over BLE...`);
                const testTask = "Write a Python function called is_palindrome(s) that checks if a string is a palindrome, ignoring case and non-alphanumeric characters. Include a docstring.";
                const testReq = {
                  requestId: `ble-test-${Date.now()}`,
                  requesterId: AGENT_ID,
                  task: testTask,
                  language: "python" as const,
                  requesterSignature: signPayload(JSON.stringify({ requesterId: AGENT_ID, taskHash: computeTaskHash(testTask) }), keys.privateKeyPem),
                };
                const resp = await bleTransport!.sendTaskRequest(peer.agentId, testReq);
                console.log(`[BLE-TEST] response from ${peer.agentId}: status=${resp.status}, output=${(resp.output ?? "").substring(0, 200)}`);
              } catch (e) {
                console.error(`[BLE-TEST] error: ${String(e)}`);
              }
            }, 5000);
          }
        }
      }

      const idleDelayMs = coordinatorOnline
        ? (OS === "ios" && !allowPeerDirectWork(powerTelemetry) ? 2500 : 1200)
        : 5000;
      await new Promise((r) => setTimeout(r, idleDelayMs));
    } catch (error) {
      consecutiveFailures++;
      console.error(`[agent:${AGENT_ID}] loop error (failures: ${consecutiveFailures}): ${String(error)}`);
      if (isAgentNotRegisteredError(error)) {
        // Coordinator restarted or evicted us: register again on the next tick.
        registeredWithUrl = null;
      }
      if (coordinatorOnline && consecutiveFailures >= OFFLINE_THRESHOLD) {
        registeredWithUrl = null;
        coordinatorOnline = false;
        // Coming back means proving the key again.
        coordinator.invalidate();
        bleMesh?.setOffline(true);
        try { localStore.deleteConfig("coordinator_url"); } catch {}
        console.warn(`[agent:${AGENT_ID}] entering offline mode after ${consecutiveFailures} consecutive failures — cleared stale coordinator cache`);
      }
      const failover = await resolveCoordinatorUrl();
      if (coordinator.set(failover.url, `failover:${failover.source}`)) {
        console.warn(`[agent:${AGENT_ID}] coordinator failover (${failover.source}): ${coordinator.url}`);
      }
      const delay = backoffMs();
      console.log(`[agent:${AGENT_ID}] backing off ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

loop().catch((error) => {
  console.error(error);
  process.exit(1);
});
