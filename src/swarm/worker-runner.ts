// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { request } from "undici";
import WebSocket from "ws";
import { randomUUID, createHash } from "node:crypto";
import { cpus, hostname, totalmem } from "node:os";
import { ProviderRegistry } from "../model/providers.js";
import { SwarmWorkerAgent } from "../agent/worker.js";
import { Subtask, BLETaskRequest, Language, MeshMessage, SandboxMode } from "../common/types.js";
import { execFileSync } from "node:child_process";
import { isDockerAvailable } from "../executor/docker-sandbox.js";
import { detectHardware, hardwareProfileFor, selectGpu, type Probe } from "../install/hardware.js";
import { enforceSandboxPolicy, resolveSandboxMode, swarmExecutionEnabled } from "./sandbox-enforcement.js";
import { isAgentNotRegisteredError, registerRefreshMsFromEnv, shouldRegister } from "./registration-policy.js";
import { createPeerKeys, signPayload } from "../mesh/peer.js";
import { signMeshWsBind } from "../mesh/ws-auth.js";
import { hashResultOutput, signReceiptAsAgent } from "../receipts/receipt.js";
import { CoordinatorTrustGate, PinnedKeyStore, describeTrustFailure } from "../trust/pinned-keys.js";
import { selectCoordinatorFromEnv } from "../discovery/index.js";
import { ensureOllamaModelInstalled } from "../model/ollama-installer.js";
import { NobleBLETransport } from "../mesh/ble/noble-ble-transport.js";
import { BLEMeshManager } from "../mesh/ble/ble-mesh-manager.js";
import { localStore } from "../db/local-store.js";
import { hashRequestBody, signRequest } from "../security/request-signing.js";
import { generateX25519KeyPair, decryptTaskEnvelope, encryptResult, type TaskEnvelope } from "../security/envelope.js";
import { MeshPeer } from "../mesh/mesh-peer.js";
import { MeshHttpServer } from "../mesh/mesh-http-server.js";
import { getLocalIpAddress } from "../mesh/network-utils.js";
import { isValidSnapshotRef } from "./snapshot-resolver.js";
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
const coordinatorTrustStore = PinnedKeyStore.fromEnv(process.env, { pinFile: `${PLATFORM_CONFIG_DIR}/trusted-coordinators` });
const coordinatorTrust = new CoordinatorTrustGate({ store: coordinatorTrustStore });
{
  // Strict mode with nothing listed would refuse every coordinator: say so once and stop.
  const problem = coordinatorTrustStore.configProblem();
  if (problem) {
    console.error(`[worker] ${problem}`);
    process.exit(1);
  }
}

const COORDINATOR_BOOTSTRAP_URL = process.env.COORDINATOR_URL ?? "http://127.0.0.1:4301";
const SNAPSHOT_ENFORCEMENT = process.env.SNAPSHOT_ENFORCEMENT ?? "warn";
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

let activeCoordinatorUrl = COORDINATOR_BOOTSTRAP_URL;

// Attempt portal-based coordinator discovery at startup
(async () => {
  if (!process.env.COORDINATOR_URL || process.env.EDGECODER_DISCOVERY === "1") {
    // Strict trust: never pick an announced coordinator whose key is not listed (key-less
    // candidates are still checked against /identity by the trust gate before registering).
    const acceptCandidate =
      coordinatorTrustStore.mode === "strict" ? (c: { peerId?: string; publicKeyPem?: string }) => !c.publicKeyPem || coordinatorTrustStore.wouldTrust(c.peerId, c.publicKeyPem) : undefined;
    const picked = await selectCoordinatorFromEnv({ currentUrl: COORDINATOR_BOOTSTRAP_URL, meshToken: meshAuthToken || undefined, acceptCandidate });
    if (picked) {
      console.log(`[worker] Discovery selected coordinator ${picked.url} (source=${picked.source} score=${picked.score} latency=${picked.latencyMs}ms)`);
      activeCoordinatorUrl = picked.url;
    }
  }
  if (PORTAL_URL && AGENT_REGISTRATION_TOKEN) {
    const discovered = await discoverCoordinatorFromPortal();
    if (discovered) {
      console.log(`[worker] Discovered coordinator from portal: ${discovered}`);
      activeCoordinatorUrl = discovered;
    } else {
      console.log(`[worker] Portal discovery returned no coordinator, using ${COORDINATOR_BOOTSTRAP_URL}`);
    }
  }
})();

// ── Offline resilience state ──────────────────────────────────
let consecutiveFailures = 0;
let coordinatorOnline = true;
const OFFLINE_THRESHOLD = 3;
const BACKOFF_BASE_MS = 1500;
const BACKOFF_MAX_MS = 30_000;
const RECONNECT_PROBE_INTERVAL_MS = 15_000;
const COORDINATOR_CACHE_TTL_MS = 5 * 60_000; // 5 minutes
let lastReconnectProbeMs = 0;

// ── Registration state (see registration-policy.ts for why this is not every tick) ──
const REGISTER_REFRESH_MS = registerRefreshMsFromEnv();
let registeredWithUrl: string | null = null;
let lastRegisteredAtMs = 0;
/** SANDBOX_MODE=docker but the daemon isn't reachable right now. */
let sandboxDown = false;

// The user's IDE / local coding agent sends swarm work here; this agent signs and relays it.
const LOCAL_FORWARD_PORT = Number(process.env.LOCAL_FORWARD_PORT ?? "");
if (LOCAL_FORWARD_PORT > 0) {
  let forwardToken: string | undefined;
  createLocalForwarder({
    token: () => (forwardToken ??= resolveIdeToken()),
    coordinatorUrl: () => registeredWithUrl,
    meshHeaders,
    signedHeaders,
    agentId: AGENT_ID
  })
    .on("error", (err) => console.warn(`[agent:${AGENT_ID}] local forwarder unavailable: ${String(err)}`))
    .listen(LOCAL_FORWARD_PORT, "127.0.0.1", () =>
      console.log(`[agent:${AGENT_ID}] local forwarder on 127.0.0.1:${LOCAL_FORWARD_PORT}`)
    );
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

async function resolveCoordinatorUrl(): Promise<{ url: string; source: "registry" | "cache" | "bootstrap" }> {
  const discovered = await discoverCoordinatorUrlFromRegistry();
  if (discovered) return { url: discovered, source: "registry" };
  const cached = readCachedCoordinatorUrl();
  if (cached) return { url: cached, source: "cache" };
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
      const res = await request(`${activeCoordinatorUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...meshHeaders(), ...(options?.extraHeaders ?? {}), ...signature },
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
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
      if (attempt >= retries) break;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "unknown_post_error"));
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

function connectMeshWebSocket(
  coordinatorUrl: string,
  getMeshPeer: () => MeshPeer | null
): void {
  const wsUrl = coordinatorUrl
    .replace(/^https:/, "wss:")
    .replace(/^http:/, "ws:");

  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 30_000;

  function connect(): void {
    // Wait for a valid mesh token before connecting — connecting without one
    // triggers rapid 4001 close → reconnect loops that trip DOS detection.
    if (!meshAuthToken) {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
      return;
    }
    // Build URL on each connect so it picks up the latest meshAuthToken
    // (token may be provisioned from coordinator after initial registration)
    // Token in a header (not the URL), and a signed bind so the coordinator ties this connection to
    // AGENT_ID's registered key (src/mesh/ws-auth.ts). The query token stays for older coordinators.
    const fullUrl = `${wsUrl}/mesh/ws?token=${encodeURIComponent(meshAuthToken)}&peerId=${encodeURIComponent(AGENT_ID)}`;
    const ws = new WebSocket(fullUrl, { headers: { "x-mesh-token": meshAuthToken, ...signMeshWsBind(AGENT_ID, keys.privateKeyPem) } });

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
  activeCoordinatorUrl = coordinatorSelection.url;
  cacheCoordinatorUrl(activeCoordinatorUrl);
  console.log(`[agent:${AGENT_ID}] coordinator selected (${coordinatorSelection.source}): ${activeCoordinatorUrl}`);

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
      bootstrapUrls: [activeCoordinatorUrl],
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

    await meshPeer.bootstrap();
    console.log(`[agent:${AGENT_ID}] mesh peer bootstrapped, ${meshPeer.peerCount()} peers known`);

    // Open persistent WebSocket to coordinator for NAT traversal.
    // The coordinator pushes gossip messages down this connection,
    // bypassing the agent's NAT/firewall.
    connectMeshWebSocket(activeCoordinatorUrl, () => meshPeer);
  } catch (e) {
    console.warn(`[agent:${AGENT_ID}] mesh peer init failed (non-fatal): ${String(e)}`);
    meshPeer = null;
    meshServer = null;
  }

  // Initialize BLE mesh transport for local peer discovery
  let bleMesh: BLEMeshManager | null = null;
  let bleTransport: NobleBLETransport | null = null;
  if (OS === "macos") {
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
        // Authenticate: verify requester shares our mesh token
        const ownHash = computeMeshTokenHash();
        if (ownHash) {
          const peers = bleTransport!.discoveredPeers();
          const requesterPeer = peers.find(p => p.agentId === req.requesterId);
          if (!requesterPeer || requesterPeer.meshTokenHash !== ownHash) {
            console.warn(`[BLE] rejecting task from unauthenticated peer: ${req.requesterId}`);
            return {
              requestId: req.requestId,
              providerId: AGENT_ID,
              status: "failed" as const,
              output: "mesh_token_mismatch",
              cpuSeconds: 0,
              providerSignature: "",
            };
          }
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

      console.log(`[agent:${AGENT_ID}] BLE mesh transport initialized`);
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
        // ── Sandbox policy enforcement ──
        const sandboxError = await enforceSandboxPolicy(SANDBOX_MODE, SANDBOX_REQUIRED);
        if (sandboxError?.startsWith("sandbox_required")) {
          console.error(`[agent:${AGENT_ID}] ${sandboxError}`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        // Docker configured but not running: stay registered (the IDE forwarder and heartbeats
        // keep working) but pull nothing until it is back.
        if (Boolean(sandboxError) !== sandboxDown) {
          sandboxDown = Boolean(sandboxError);
          console.warn(`[agent:${AGENT_ID}] ${sandboxDown ? `${sandboxError}; not pulling swarm tasks until it is` : "sandbox available again; pulling swarm tasks"}`);
        }

        // Pinned-key trust: never register with a coordinator whose key is not trusted (checked once per URL).
        const trust = await coordinatorTrust.check(activeCoordinatorUrl);
        if (!trust.trusted) {
          console.error(`[agent:${AGENT_ID}] refusing to work for ${activeCoordinatorUrl}: ${describeTrustFailure(trust)}`);
          // A key mismatch for a pinned id is a possible impersonation: stop. An unlisted coordinator
          // (strict mode) is just not ours to work for: back off and fail over to another one.
          if (trust.decision?.reason === "pinned_mismatch") process.exit(1);
          throw new Error(trust.decision ? "coordinator_not_trusted" : "coordinator_identity_unavailable");
        }
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
        if (shouldRegister({ registeredWithUrl, lastRegisteredAtMs }, activeCoordinatorUrl, Date.now(), REGISTER_REFRESH_MS)) {
          const registerBody = {
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
          registeredWithUrl = activeCoordinatorUrl;
          lastRegisteredAtMs = Date.now();
          if (typeof registerResponse.meshToken === "string" && registerResponse.meshToken.length > 0) {
            if (meshAuthToken !== registerResponse.meshToken) {
              meshAuthToken = registerResponse.meshToken;
              console.log(`[agent:${AGENT_ID}] mesh token provisioned from coordinator register response`);
              if (bleTransport) bleTransport.updateAdvertisement({ meshTokenHash: computeMeshTokenHash() });
              if (bleMesh) bleMesh.setOwnTokenHash(computeMeshTokenHash());
            }
          }
        }

        const hbStart = Date.now();
        const hbBody = { agentId: AGENT_ID, powerTelemetry, sandboxMode: SANDBOX_MODE, ...(benchmarkUnreported && lastBenchmark ? { benchmark: lastBenchmark } : {}) };
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
        try { localStore.recordHeartbeat(activeCoordinatorUrl, hb.blacklisted ? "blacklisted" : "ok", Date.now() - hbStart); } catch (e) { console.warn(`[db] heartbeat write failed: ${e}`); }

        // Heartbeat succeeded — reset failure counter and cache proven URL
        consecutiveFailures = 0;
        cacheCoordinatorUrl(activeCoordinatorUrl);

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
          await post("/agent-mesh/close-ack", { agentId: AGENT_ID, token: notice.token });
        }
        for (const invite of hb.tunnelInvites ?? []) {
          if (blacklistSet.has(invite.fromAgentId)) continue;
          await post("/agent-mesh/accept", { agentId: AGENT_ID, token: invite.token });
          peerTunnels.set(invite.fromAgentId, invite.token);
        }

        const idlePeersResponse = await request(`${activeCoordinatorUrl}/agent-mesh/peers/${AGENT_ID}`, {
          method: "GET",
          headers: meshHeaders()
        });
        if (idlePeersResponse.statusCode >= 200 && idlePeersResponse.statusCode < 300) {
          const peersJson = (await parseJsonBodySafe(idlePeersResponse)) as { peers?: string[] };
          for (const peerId of (peersJson.peers ?? []).slice(0, 2)) {
            if (blacklistSet.has(peerId)) continue;
            if (peerId === AGENT_ID) continue;
            if (peerTunnels.has(peerId)) continue;
            const connect = await request(`${activeCoordinatorUrl}/agent-mesh/connect`, {
              method: "POST",
              headers: { "content-type": "application/json", ...meshHeaders() },
              body: JSON.stringify({ fromAgentId: AGENT_ID, toAgentId: peerId })
            });
            if (connect.statusCode >= 200 && connect.statusCode < 300) {
              const body = (await parseJsonBodySafe(connect)) as { token?: string };
              if (body.token) peerTunnels.set(peerId, body.token);
            }
          }
        }

        for (const token of peerTunnels.values()) {
          const relayRes = await request(`${activeCoordinatorUrl}/agent-mesh/relay`, {
            method: "POST",
            headers: { "content-type": "application/json", ...meshHeaders() },
            body: JSON.stringify({
              token,
              fromAgentId: AGENT_ID,
              payload: `ping:${Date.now()}`
            })
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
              await post("/orchestration/agents/" + AGENT_ID + "/status", { phase, message, progressPct });
            } catch {
              // best-effort; coordinator may be unreachable
            }
          };
          try {
            await reportStatus("starting", "Preparing to switch model…");
            await ensureOllamaModelInstalled(
              {
                enabled: hb.orchestration.provider === "ollama-local",
                autoInstall: hb.orchestration.autoInstall,
                model: hb.orchestration.model ?? OLLAMA_MODEL,
                role: "agent",
                host: OLLAMA_HOST
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
                { retries: Math.max(3, COORDINATOR_POST_RETRIES + 1), timeoutMs: Math.max(20000, COORDINATOR_HTTP_TIMEOUT_MS) }
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
              { retries: Math.max(3, COORDINATOR_POST_RETRIES + 1), timeoutMs: Math.max(20000, COORDINATOR_HTTP_TIMEOUT_MS) }
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
              taskId: pulled.envelope.subtaskId.split(":")[0] ?? pulled.envelope.subtaskId,
              kind: "single_step",
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

          // ── Frozen snapshot enforcement (Design Decision #8) ──
          if (!st.snapshotRef || !isValidSnapshotRef(st.snapshotRef)) {
            if (SNAPSHOT_ENFORCEMENT === "strict") {
              console.error(`[agent:${AGENT_ID}] snapshot enforcement STRICT: refusing subtask ${st.id} — invalid snapshotRef: "${st.snapshotRef ?? ""}"`);
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
            }
            console.warn(`[agent:${AGENT_ID}] snapshot warning: subtask ${st.id} has invalid snapshotRef: "${st.snapshotRef ?? ""}" — proceeding (enforcement=${SNAPSHOT_ENFORCEMENT})`);
          } else {
            console.log(`[agent:${AGENT_ID}] snapshot verified for subtask ${st.id}: ${st.snapshotRef}`);
          }

          // ── PRIMARY: Local execution (HTTP mesh is primary, BLE is last resort) ──
          try { localStore.recordTaskStart(st.id, st.taskId, st.input, st.language, currentProvider, activeCoordinatorUrl); } catch (e) { console.warn(`[db] task start write failed: ${e}`); }
          // #51: keep the coordinator's claim lease alive while the subtask runs.
          const stopLeaseHeartbeat = startLeaseHeartbeat();
          const result = await worker.runSubtask(st, AGENT_ID).finally(stopLeaseHeartbeat);
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
          if (taskEnvelope) {
            try {
              const encrypted = encryptResult(
                { ok: result.ok, output: result.output, error: result.error, durationMs: result.durationMs },
                taskEnvelope,
                envelopeKeys.privateKey
              );
              resultPayload = {
                ...encrypted,
                taskId: result.taskId,
                agentId: result.agentId,
                reportNonce,
                reportSignature,
              };
              console.log(`[agent:${AGENT_ID}] encrypted result for envelope task: ${result.subtaskId}`);
            } catch (encryptErr) {
              console.warn(`[agent:${AGENT_ID}] result encryption failed, sending plaintext: ${encryptErr}`);
            }
          }
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
              resultHash: hashResultOutput(result.output)
            },
            keys.privateKeyPem
          );

          try {
            await post("/result", resultPayload, { signed: true });
          } catch (resultErr) {
            try { localStore.enqueuePendingResult(result.subtaskId, JSON.stringify(resultPayload)); } catch (e) { console.warn(`[db] pending result write failed: ${e}`); }
            console.warn(`[agent:${AGENT_ID}] result buffered for retry: ${result.subtaskId}`);
          }
          continue;
        }

        // ── Mesh task execution: process tasks received via gossip ──
        if (SWARM_EXECUTION_ENABLED && meshPeer && meshTaskQueue.length > 0) {
          const meshItem = meshTaskQueue.shift()!;
          const st = meshItem.subtask;
          console.log(`[agent:${AGENT_ID}] executing mesh task: ${st.id} (snapshot: ${st.snapshotRef})`);
          try { localStore.recordTaskStart(st.id, st.taskId, st.input, st.language, currentProvider, "mesh-gossip"); } catch (e) { console.warn(`[db] mesh task start write failed: ${e}`); }
          const result = await worker.runSubtask(st, AGENT_ID);
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
          const accepted = await request(`${activeCoordinatorUrl}/agent-mesh/direct-work/accept`, {
            method: "POST",
            headers: { "content-type": "application/json", ...meshHeaders() },
            body: JSON.stringify({
              offerId: offer.offerId,
              byAgentId: AGENT_ID
            })
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
                ? await worker.runSubtask(peerSubtask, AGENT_ID)
                : { ok: false, output: "", error: "sandbox_required_for_remote_task", durationMs: 0 };
              peerResult = {
                ok: result.ok,
                output: result.output,
                error: result.error,
                durationMs: result.durationMs
              };
            }
            await request(`${activeCoordinatorUrl}/agent-mesh/direct-work/result`, {
              method: "POST",
              headers: { "content-type": "application/json", ...meshHeaders() },
              body: JSON.stringify({
                offerId: offer.offerId,
                byAgentId: AGENT_ID,
                ok: peerResult.ok,
                output: peerResult.output,
                error: peerResult.error,
                durationMs: peerResult.durationMs
              })
            });
            await new Promise((r) => setTimeout(r, 300));
            continue;
          }
        }

        // While idle, offer direct work to nearby peers for spare compute utilization.
        if (canUsePeerDirect) {
          const peersResponse = await request(`${activeCoordinatorUrl}/agent-mesh/peers/${AGENT_ID}`, {
            method: "GET",
            headers: meshHeaders()
          });
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
              const offerRes = await request(`${activeCoordinatorUrl}/agent-mesh/direct-work/offer`, {
                method: "POST",
                headers: { "content-type": "application/json", ...meshHeaders() },
                body: JSON.stringify({
                  fromAgentId: AGENT_ID,
                  toAgentId: peerId,
                  workType: "code_task",
                  language: "python",
                  input: workInput
                })
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
        if (now - lastReconnectProbeMs > RECONNECT_PROBE_INTERVAL_MS) {
          lastReconnectProbeMs = now;
          try {
            const probeStart = Date.now();
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
            await post("/register", registerBody, { retries: 0, timeoutMs: 5000, signed: true });
            const probeBody = { agentId: AGENT_ID, powerTelemetry };
            await post("/heartbeat", probeBody, { retries: 0, timeoutMs: 5000, signed: true });
            const probeLatency = Date.now() - probeStart;
            try { localStore.recordHeartbeat(activeCoordinatorUrl, "reconnected", probeLatency); } catch {}
            // Probe succeeded — back online
            coordinatorOnline = true;
            consecutiveFailures = 0;
            cacheCoordinatorUrl(activeCoordinatorUrl);
            bleMesh?.setOffline(false);
            // The probe just registered: don't register again on the next online tick.
            registeredWithUrl = activeCoordinatorUrl;
            lastRegisteredAtMs = Date.now();
            console.log(`[agent:${AGENT_ID}] coordinator back online (probe latency: ${probeLatency}ms)`);
            await flushPendingResults();
            await flushOfflineLedger();
          } catch {
            console.log(`[agent:${AGENT_ID}] offline probe failed, still offline`);
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
        const result = await worker.runSubtask(st, AGENT_ID);
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
        bleMesh?.setOffline(true);
        try { localStore.deleteConfig("coordinator_url"); } catch {}
        console.warn(`[agent:${AGENT_ID}] entering offline mode after ${consecutiveFailures} consecutive failures — cleared stale coordinator cache`);
      }
      const failover = await resolveCoordinatorUrl();
      if (failover.url !== activeCoordinatorUrl) {
        activeCoordinatorUrl = failover.url;
        console.warn(`[agent:${AGENT_ID}] coordinator failover (${failover.source}): ${activeCoordinatorUrl}`);
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
