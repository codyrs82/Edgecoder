// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { request } from "undici";
import WebSocket from "ws";
import { randomUUID, createHash } from "node:crypto";
import { cpus, freemem, hostname, totalmem } from "node:os";
import { defaultServing, parallelInferenceFor } from "./parallelism.js";
import { fitModel, fmtGb, memoryBudgetBytes, memoryBudgetPct, modelFacts } from "./memory-budget.js";
import { readMemoryPressure } from "./memory-pressure.js";
import { HostMemoryManager } from "./memory-manager.js";
import { paramsB } from "../inference-api/auto-route.js";
import { OpenAiEngineProvider, ProviderRegistry } from "../model/providers.js";
import { ENGINE_PRESETS, openAiEngineChat, resolveEngine, type EngineConfig } from "../inference-api/openai-engine.js";
import type { ChatMessage, ToolSpec } from "../inference-api/types.js";
import { parseModelAliases } from "../model/engine-models.js";
import { engineServing, probeEngine, type EngineStatus } from "./engine-probe.js";
import { CloudHost, alertNotifier, cloudHostConfigFromEnv } from "../cloud-host/host.js";
import { configureCloudCatalog } from "../cloud-host/catalog.js";
import { alertConfigFromEnv } from "../alerting/config.js";
import { SwarmWorkerAgent } from "../agent/worker.js";
import { Subtask, SubtaskResult, BLETaskRequest, Language, MeshMessage, SandboxMode } from "../common/types.js";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { ensureSandboxImages, isDockerAvailable } from "../executor/docker-sandbox.js";
import { runInferenceSubtask } from "./inference-runner.js";
import { warmOllamaModel } from "../inference-api/ollama.js";
import { detectHardware, gpuNeedsOffloadProof, hardwareProfileFor, selectGpu, selectGpuPool, type Probe } from "../install/hardware.js";
import { claimedProfile, decideGpuClaim, type GpuClaimDecision } from "./gpu-claim.js";
import { encodePendingResult, flushPendingResultBuffer, isPermanentResultRefusal, ResultNotRoutableYetError } from "./pending-results.js";
import { enforceSandboxPolicy, inferenceOnlyRejection, resolveSandboxMode, swarmExecutionEnabled } from "./sandbox-enforcement.js";
import { portalLabel, enrollmentBackoffMs, enrollmentRefusalFromError, enrollmentRefusalKey, enrollmentRefusalMessage, isAgentNotRegisteredError, isNotRegisteredWsClose, MESH_WS_REBIND_CLOSE_CODE, QuickReregisterGate, parseRetryAfterMs, rateLimitWaitMs, registeredLogLine, registerRefreshMsFromEnv, shouldLogEnrollmentRefusal, shouldRegister, type RegisterReply } from "./registration-policy.js";
import { createPeerKeys, signPayload } from "../mesh/peer.js";
import { signMeshWsBind } from "../mesh/ws-auth.js";
import { hashResultOutput, signReceiptAsAgent } from "../receipts/receipt.js";
import { withNetworkTrustDefaults } from "../trust/seed-keys.js";
import { CoordinatorTrustGate, PinnedKeyStore, challengePolicyFromEnv, describeTrustFailure, DEFAULT_TRUST_REVERIFY_MS } from "../trust/pinned-keys.js";
import { ActiveCoordinator, meshWsUrl } from "./active-coordinator.js";
import { createCoordinatorClient, CoordinatorResponseRejectedError, type CoordinatorTarget } from "./coordinator-client.js";
import { ResponseVerifier, responseSigningPolicyFromEnv } from "../trust/response-signing.js";
import { checkSnapshotPolicy, envelopeResultPayload, parseSnapshotEnforcement } from "./execution-policy.js";
import { DIRECT_WORK_MARKET_HINT, isOwnAccountCall, workerAcceptsDirectWorkOffer } from "./direct-work-policy.js";
import { BleRequestGuard, bleRequestProof } from "../mesh/ble/ble-request-guard.js";
import { selectCoordinatorFromEnv } from "../discovery/index.js";
import { createCoordinatorSteering, registryUrlsFor, type SteeringResult } from "../discovery/steering.js";
import { registryPublicKeysFromEnv } from "../discovery/registry.js";
import { ensureOllamaModelInstalled, isOllamaLibraryModelName } from "../model/ollama-installer.js";
import { NobleBLETransport } from "../mesh/ble/noble-ble-transport.js";
import { BLEMeshManager } from "../mesh/ble/ble-mesh-manager.js";
import { BleCosignProvider } from "../mesh/ble/ble-cosign.js";
import { catalogEntryForTag, paramSizeBillions } from "../model/catalog.js";
import { ledgerRowToTransaction, settledBleTxIds } from "../mesh/ble/offline-ledger.js";
import { localStore } from "../db/local-store.js";
import { hashRequestBody, signRequest } from "../security/request-signing.js";
import { generateX25519KeyPair, decryptTaskEnvelope, encryptResult, type TaskEnvelope } from "../security/envelope.js";
import { MeshPeer } from "../mesh/mesh-peer.js";
import { MeshTaskQueue } from "../mesh/mesh-task-queue.js";
import { MeshHttpServer } from "../mesh/mesh-http-server.js";
import { getLocalIpAddress } from "../mesh/network-utils.js";
import { localLanAddresses } from "./lan-proximity.js";
import { collectDesktopTelemetry } from "./desktop-telemetry.js";
import { detectPlatform, getConfigDir, getLogDir, type PlatformInfo } from "../common/platform.js";
import { computeDistHash, loadReleaseManifest, detectDistributionChannel } from "../security/release-integrity.js";
import { CpuStealGuard, CPU_STEAL_HOLD_MS, modelSlotReport, type CpuStealReport } from "./cpu-steal.js";
import { answerChallenge, runLocalBenchmark, selfBenchmarkDue, type AgentBenchmarkReport, type BenchmarkChallenge } from "./benchmark.js";
import { appVersion, isReleaseInstall } from "../common/app-version.js";
import { createUpdateNudge } from "./update-nudge.js";
import { autoUpdateSetting } from "../install/update-schedule.js";
import { startUpdateDrain } from "./update-drain.js";
import { createLocalForwarder } from "./local-forwarder.js";
import { ServingJobs } from "./serving-jobs.js";
import { AgentLifecycle, DEFAULT_DRAIN_MS, announceGoingOffline, blacklistReasonFromError, type GoingOfflineReason } from "./agent-lifecycle.js";
import { resolveIdeToken } from "../apps/ide/ide-auth.js";
import { loadConfigOrExit } from "../common/config.js";
import { workerConfigSchema } from "../config/worker.js";
import { layerOverrides, loadOverrides, overridesPath, saveOverrides, withoutKeys, type EnvModelSettings, type ModelOverridesFile } from "../model/remote-control/overrides.js";
import { ModelControlAgent, type CurrentModelSettings } from "../model/remote-control/agent-controller.js";
import { createOllamaAdmin, diskSpace, ollamaModelsDir, registryModelSize } from "../model/remote-control/ollama-admin.js";
import { remoteControlEnabled, resolveAllowlist } from "../model/remote-control/policy.js";
import { MODEL_CONTROL_FRAME_TYPE } from "../model/remote-control/protocol.js";
import { COORDINATOR_DRAIN_NOTICE_FRAME_TYPE, COORDINATOR_RECONNECT_FRAME_TYPE, CoordinatorReconnectState, CoordinatorRestartWindow, RESTART_REQUEST_TIMEOUT_MS, isDrainingError, isRestartTransientError, isRestartClose, nextMeshWsDelay, verifyCoordinatorDrainNoticeFrame, verifyCoordinatorReconnectFrame } from "../mesh/coordinator-reconnect.js";
import { DrainFailover, homeProbeState } from "../mesh/drain-failover.js";
import { BOT_CONTROL_FRAME_TYPE, botRelayMode } from "../common/bot-relay.js";
import { BotRelayAgent, httpProviderClient } from "./bot-relay-agent.js";
import { CODE_CONTROL_FRAME_TYPE, codeRelayMode } from "../common/code-relay.js";
import { CodeRelayAgent, httpCodeProviderClient } from "./code-relay-agent.js";
import { LOCAL_WEB_FRAME_TYPE, LocalWebAgent, localWebEnabled } from "../web-tool/local-web.js";
import { searxngBaseUrl, searxngHealthy, searxngSearch } from "../web-tool/searxng.js";
import { fetchPage } from "../web-tool/fetch-page.js";

// #15: validated once; a malformed value exits here with a message naming the variable.
const W = loadConfigOrExit("worker", workerConfigSchema);

const platformInfo: PlatformInfo = detectPlatform();
const PLATFORM_CONFIG_DIR = W.EDGECODER_CONFIG_DIR ?? getConfigDir();
const PLATFORM_LOG_DIR = W.EDGECODER_LOG_DIR ?? getLogDir();
// Pinned-key trust (architecture step 4): TRUSTED_COORDINATOR_KEYS / EDGECODER_TRUST_FILE / EDGECODER_TRUST_MODE.
// On the edgecoder.io network the default is strict with the seeds' keys (src/trust/seed-keys.ts).
const TRUST_ENV = withNetworkTrustDefaults(process.env);
const coordinatorTrustStore = PinnedKeyStore.fromEnv(TRUST_ENV, { pinFile: `${PLATFORM_CONFIG_DIR}/trusted-coordinators` });
// Each coordinator URL must prove possession of its key (POST /identity/challenge); a verification
// lasts EDGECODER_TRUST_REVERIFY_MS (default 10 min) and is redone on reconnect and URL changes.
const coordinatorTrust = new CoordinatorTrustGate({
  store: coordinatorTrustStore,
  challenge: challengePolicyFromEnv(TRUST_ENV, coordinatorTrustStore.mode),
  reverifyMs: W.EDGECODER_TRUST_REVERIFY_MS || DEFAULT_TRUST_REVERIFY_MS
});
{
  // Strict mode with nothing listed would refuse every coordinator: say so once and stop.
  const problem = coordinatorTrustStore.configProblem();
  if (problem) {
    console.error(`[worker] ${problem}`);
    process.exit(1);
  }
}

// BHV006: draining before a restart or quit, paused by a blacklist, claims running (agent-lifecycle.ts).
const lifecycle = new AgentLifecycle();
// The network jobs running here now, for the app's Settings → Active work (serving-jobs.ts).
const servingJobs = new ServingJobs();
let shuttingDown = false;
/**
 * Stopping (SIGTERM / SIGINT, or the all-in-one parent went away: the desktop app quit or restarted
 * to finish an update): pull nothing more and tell the coordinator, so the claims we hold go to
 * other agents now instead of lapsing as abandoned claims. Bounded; then exit.
 */
async function shutdownGracefully(reason: GoingOfflineReason, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  lifecycle.startDrain(Infinity);
  let registered = false;
  try {
    registered = Boolean(registeredWithUrl);
  } catch {
    // stopped before registration state existed
  }
  if (registered) {
    const r = await announceGoingOffline((body) => post("/heartbeat", body, { retries: 0, timeoutMs: 2_500, signed: true }), AGENT_ID, reason, 3_000);
    console.log(`[agent:${AGENT_ID}] going offline (${reason})${r.ok ? `: ${r.released} claim(s) handed back` : ": coordinator not told; claims lapse at lease expiry"}`);
  }
  process.exit(code);
}
// Forked by the all-in-one agent: exit with it rather than linger as an orphan.
if (process.send) process.on("disconnect", () => void shutdownGracefully("quit"));
process.once("SIGTERM", () => void shutdownGracefully("shutdown"));
process.once("SIGINT", () => void shutdownGracefully("shutdown", 130));

const COORDINATOR_BOOTSTRAP_URL = W.COORDINATOR_URL ?? "http://127.0.0.1:4301";
const SNAPSHOT_ENFORCEMENT = parseSnapshotEnforcement(W.SNAPSHOT_ENFORCEMENT);
const CONTROL_PLANE_URL = W.CONTROL_PLANE_URL ?? "";
const COORDINATOR_DISCOVERY_URL =
  process.env.COORDINATOR_DISCOVERY_URL ??
  (CONTROL_PLANE_URL ? `${CONTROL_PLANE_URL.replace(/\/$/, "")}/network/coordinators` : "");
// #96: default to a per-host id so N replicas without AGENT_ID (docker compose --scale) don't all register as "worker-1".
const AGENT_ID = W.AGENT_ID ?? `worker-${hostname().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 16) || "1"}`;
const MODE = W.AGENT_MODE;
const OS = (W.AGENT_OS ?? platformInfo.os) as "debian" | "ubuntu" | "windows" | "macos" | "ios";
/*
 * The engine that runs the model: Ollama (default), or vLLM / MLX (EDGECODER_ENGINE), which are
 * started on their own and only health-checked here (src/swarm/engine-probe.ts). With vLLM or MLX
 * the agent is a local-model agent ("ollama-local" to the coordinator), its model is whatever
 * catalog model the engine serves, and nothing Ollama-specific (pull, warm, keep_alive, remote
 * model changes) runs.
 */
/*
 * A cloud host (EDGECODER_ENGINE=cloud, or `edgecoder cloud-host`; docs/cloud-host.md): the same
 * agent with a hosted model API (src/cloud-host/) in place of Ollama / vLLM. It serves the enabled
 * cloud models with the platform's key, registers in the `cloud` class, and pauses itself at its
 * spend caps. Nothing Ollama-specific (pull, warm, memory budget, benchmark, remote model control) runs.
 */
const CLOUD_MODE = (W.EDGECODER_ENGINE ?? "").trim().toLowerCase() === "cloud";
const ENGINE: EngineConfig = CLOUD_MODE
  ? { kind: "ollama" }
  : (() => {
      try {
        return resolveEngine(process.env);
      } catch (e) {
        console.error(`[worker] ${(e as Error).message}`);
        process.exit(1);
      }
    })();
const OPENAI_ENGINE = ENGINE.kind === "ollama" ? undefined : ENGINE;
const CLOUD_HOST: CloudHost | undefined = CLOUD_MODE
  ? (() => {
      try {
        configureCloudCatalog(W.CLOUD_MODELS_JSON);
        const cfg = cloudHostConfigFromEnv(W, { stateFile: `${PLATFORM_CONFIG_DIR}/cloud-host-spend.json` });
        const host = new CloudHost(cfg, {
          notify: alertNotifier(alertConfigFromEnv(process.env), { agentId: W.AGENT_ID ?? hostname(), provider: cfg.label, portalUrl: W.PORTAL_URL ?? "", log: (line) => console.warn(`[cloud-host] ${line}`) })
        });
        const st = host.guard.status();
        // Never the key: only where it goes and what is served.
        console.log(`[cloud-host] ${cfg.label} at ${cfg.baseUrl}: serving ${cfg.models.join(", ")} (${cfg.maxSlots} slots); spend today $${st.dayUsd.toFixed(2)} of $${cfg.guard.dailyCapUsd}, this month $${st.monthUsd.toFixed(2)} of $${cfg.guard.monthlyCapUsd}${st.paused ? ` — paused (${st.reason})` : ""}`);
        return host;
      } catch (e) {
        console.error(`[worker] cloud host: ${(e as Error).message}`);
        process.exit(1);
      }
    })()
  : undefined;
const ENGINE_LABEL = OPENAI_ENGINE ? ENGINE_PRESETS[OPENAI_ENGINE.preset].label : "Ollama";
const ENGINE_ALIASES = parseModelAliases(W.ENGINE_MODEL_ALIASES);
if (OPENAI_ENGINE && W.LOCAL_MODEL_PROVIDER !== "ollama-local") console.log(`[worker] EDGECODER_ENGINE=${OPENAI_ENGINE.preset}: serving the local model (LOCAL_MODEL_PROVIDER=ollama-local implied)`);
const PROVIDER = OPENAI_ENGINE || CLOUD_MODE ? "ollama-local" : W.LOCAL_MODEL_PROVIDER;
const OLLAMA_HOST = W.OLLAMA_HOST;
const OLLAMA_AUTO_INSTALL = W.OLLAMA_AUTO_INSTALL;
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
/** Set by buildHardwareProfile: the reported card is one only Vulkan / sysfs vouches for (src/swarm/gpu-claim.ts). */
let GPU_NEEDS_OFFLOAD_PROOF = false;
function buildHardwareProfile(): Record<string, unknown> {
  const hw = detectHardware({ probe: hardwareProbe });
  const gpuModel = W.AGENT_GPU_MODEL;
  const gpuVram = W.AGENT_GPU_VRAM_GB ?? Number.NaN;
  if (gpuModel || (Number.isFinite(gpuVram) && gpuVram > 0)) {
    return {
      ...hardwareProfileFor(hw, undefined),
      gpu: {
        vendor: W.AGENT_GPU_VENDOR,
        model: gpuModel || undefined,
        vramGb: Number.isFinite(gpuVram) && gpuVram > 0 ? gpuVram : undefined,
        datacenter: W.AGENT_GPU_DATACENTER
      },
      overridden: true
    };
  }
  const gpu = selectGpu(hw, process.env);
  GPU_NEEDS_OFFLOAD_PROOF = gpuNeedsOffloadProof(gpu);
  return hardwareProfileFor(hw, gpu, selectGpuPool(hw, process.env));
}
/** The detected hardware (memory budget, the portal's machine panel). What the agent claims is CLAIMED_PROFILE. */
const HARDWARE_PROFILE = buildHardwareProfile();
/**
 * GPU claim (src/swarm/gpu-claim.ts): a card only Vulkan can drive is claimed once Ollama shows the
 * model in VRAM or the GPU benchmark clears the GPU floor; until then the agent registers as CPU.
 */
let gpuClaim: GpuClaimDecision = decideGpuClaim({ needsProof: GPU_NEEDS_OFFLOAD_PROOF });
let gpuClaimCheckedAtMs = 0;
const claimedHardwareProfile = (): Record<string, unknown> => (CLOUD_HOST ? CLOUD_HOST.hardwareProfile() : claimedProfile(HARDWARE_PROFILE, gpuClaim.claimGpu));
/**
 * Host memory budget (src/swarm/memory-budget.ts): AGENT_MEMORY_BUDGET_PCT of RAM (default 60%),
 * or 90% of a discrete GPU's VRAM. Network models are loaded, served and sized to fit it.
 */
const OLLAMA_SERVER_PARALLEL = (() => {
  const n = Number(process.env.OLLAMA_NUM_PARALLEL);
  return Number.isInteger(n) && n > 0 ? n : undefined;
})();
const MEMORY_BUDGET_BYTES = (() => {
  const gpu = HARDWARE_PROFILE.gpu as { vendor?: string; vramGb?: number } | undefined;
  const vram = gpu && gpu.vendor !== "apple" && gpu.vramGb ? gpu.vramGb * 1024 ** 3 : undefined;
  return memoryBudgetBytes(totalmem(), memoryBudgetPct(W.AGENT_MEMORY_BUDGET_PCT), vram);
})();
/** Distinct models served on the network at once: AGENT_MAX_NETWORK_MODELS, never past Ollama's OLLAMA_MAX_LOADED_MODELS. */
const MAX_NETWORK_MODELS = (() => {
  const loadedCap = Number(process.env.OLLAMA_MAX_LOADED_MODELS);
  const caps = [W.AGENT_MAX_NETWORK_MODELS, Number.isInteger(loadedCap) && loadedCap > 0 ? loadedCap : undefined].filter((n): n is number => typeof n === "number");
  return caps.length ? Math.min(...caps) : undefined;
})();

/*
 * Model settings: the env file, with the owner's remote changes layered over it
 * (src/model/remote-control/overrides.ts). The env file is root's on a headless install; remote
 * changes live in the agent's own <config dir>/model-overrides.json, and a local change to the env
 * (the operator, or the desktop app) supersedes the remote one for that setting.
 */
const MODEL_OVERRIDES_FILE = overridesPath(PLATFORM_CONFIG_DIR);
const ENV_MODEL_SETTINGS: EnvModelSettings = {
  model: process.env.OLLAMA_MODEL?.trim() || undefined,
  contextWindow: process.env.AGENT_CONTEXT_WINDOW?.trim() || undefined,
  parallel: process.env.AGENT_PARALLEL_INFERENCE?.trim() || undefined,
  keepAlive: process.env.AGENT_MODEL_KEEP_ALIVE?.trim() || undefined
};
let modelOverrides: ModelOverridesFile = (() => {
  const { overrides, problems } = loadOverrides(MODEL_OVERRIDES_FILE);
  for (const p of problems) console.warn(`[worker] model overrides: ${p}`);
  const { superseded } = layerOverrides(ENV_MODEL_SETTINGS, overrides);
  if (superseded.length === 0) return overrides;
  console.log(`[worker] model overrides: local configuration changed ${superseded.join(", ")} since the remote change; the local value wins`);
  const kept = withoutKeys(overrides, superseded);
  try {
    saveOverrides(MODEL_OVERRIDES_FILE, kept);
  } catch (e) {
    console.warn(`[worker] model overrides: could not rewrite ${MODEL_OVERRIDES_FILE}: ${String(e)}`);
  }
  return kept;
})();
/**
 * The discrete GPU the agent sizes its model from (VRAM, summed over a pool, and how many cards),
 * or undefined: no GPU, Apple's unified memory (counted as RAM), or a card only Vulkan can drive
 * that Ollama has not been seen using yet (src/swarm/gpu-claim.ts; once seen, it stays).
 */
let gpuSizingConfirmed = false;
function sizingGpu(): { vramBytes: number; count?: number } | undefined {
  if (CLOUD_MODE) return undefined;
  const gpu = HARDWARE_PROFILE.gpu as { vendor?: string; vramGb?: number; count?: number } | undefined;
  if (!gpu || gpu.vendor === "apple" || !gpu.vramGb || gpu.vramGb <= 0) return undefined;
  if (GPU_NEEDS_OFFLOAD_PROOF && !gpuSizingConfirmed) return undefined;
  return { vramBytes: gpu.vramGb * 1024 ** 3, ...(gpu.count ? { count: gpu.count } : {}) };
}
/** The effective model settings from the env and the override file (also re-run after a remote change, or when Ollama describes the model). */
function computeModelSettings(): CurrentModelSettings {
  const layered = layerOverrides(ENV_MODEL_SETTINGS, modelOverrides);
  const model = layered.env.model || W.OLLAMA_MODEL;
  const modelParamsB = model ? paramsB(model) : undefined;
  const gpu = sizingGpu();
  // By memory and the model's size, never past this machine's OLLAMA_NUM_PARALLEL when set
  // (src/swarm/parallelism.ts); on a GPU, defaultServing may give up slots for a 32k window.
  const parallel = parallelInferenceFor(totalmem(), layered.env.parallel, { modelParamsB, ollamaNumParallel: process.env.OLLAMA_NUM_PARALLEL });
  const parRaw = Number(layered.env.parallel);
  const ctxRaw = layered.env.contextWindow !== undefined ? Number(layered.env.contextWindow) : undefined;
  /**
   * One context window for every network call (Ollama reloads the model when num_ctx changes):
   * AGENT_CONTEXT_WINDOW, else from a discrete GPU's free VRAM after the weights, using what Ollama
   * says about the model (size, KV cache per token, context length), else by RAM (parallelism.ts).
   */
  const facts = model ? modelFacts(model) : undefined;
  const want = defaultServing(totalmem(), Number.isInteger(ctxRaw) ? ctxRaw : undefined, {
    modelParamsB,
    slots: parallel,
    slotsFixed: Number.isInteger(parRaw) && parRaw >= 1 && parRaw <= 16,
    discreteGpu: OPENAI_ENGINE ? undefined : gpu,
    weightsBytes: facts?.sizeBytes,
    kvBytesPer8k: facts?.kvBytesPer8k,
    nativeContext: facts?.contextLength ?? (model ? catalogEntryForTag(model)?.contextTokens : undefined),
    kvSlotsFloor: OLLAMA_SERVER_PARALLEL
  });
  const wantContext = want.contextWindow;
  // The memory budget has the last word, an explicit AGENT_CONTEXT_WINDOW / AGENT_PARALLEL_INFERENCE
  // included: the window (then the slots) come down until the model fits (memory-budget.ts fitModel).
  let contextWindow = wantContext;
  let slots = want.slots;
  if (model && !OPENAI_ENGINE && !CLOUD_MODE) {
    const fit = fitModel(model, { budgetBytes: MEMORY_BUDGET_BYTES, wantContext, wantSlots: want.slots, fixedKvSlots: OLLAMA_SERVER_PARALLEL });
    if (fit.contextWindow !== wantContext || fit.slots !== want.slots || !fit.fits) {
      console.warn(`[worker] memory budget ${fmtGb(MEMORY_BUDGET_BYTES)}: ${model} at ${wantContext} tokens x ${want.slots} slot(s) ${fit.fits ? "does not fit; serving" : "does not fit even at"} ${fit.contextWindow} tokens x ${fit.slots} slot(s) (${fmtGb(fit.bytes)})`);
    }
    contextWindow = fit.contextWindow;
    slots = fit.slots;
  }
  // The desktop app (all-in-one) frees an idle model after 5 minutes, as its Ollama does (OLLAMA_KEEP_ALIVE).
  const keepAlive = layered.env.keepAlive ?? (SANDBOX_MODE_FOR_DEFAULTS === "none" && W.AGENT_INFERENCE_ONLY === true ? "-1" : process.env.EDGE_RUNTIME_MODE === "all-in-one" ? "5m" : "30m");
  const src = (k: keyof EnvModelSettings): "env" | "remote" | "default" => (layered.sources[k] === "remote" ? "remote" : ENV_MODEL_SETTINGS[k] !== undefined ? "env" : "default");
  return { model, parallel: slots, contextWindow, keepAlive, sources: { model: src("model"), contextWindow: src("contextWindow"), parallel: src("parallel"), keepAlive: src("keepAlive") } };
}
const SANDBOX_MODE_FOR_DEFAULTS: SandboxMode = resolveSandboxMode(process.env);
let modelSettings = computeModelSettings();
let OLLAMA_MODEL = modelSettings.model;
let MAX_PARALLEL_INFERENCE = modelSettings.parallel;
let CONTEXT_WINDOW = modelSettings.contextWindow;
if (CLOUD_HOST) {
  // A hosted API: its slots and window are the cloud host's, not this machine's memory.
  OLLAMA_MODEL = CLOUD_HOST.config.models[0];
  MAX_PARALLEL_INFERENCE = CLOUD_HOST.config.maxSlots;
  CONTEXT_WINDOW = CLOUD_HOST.contextWindow();
}
const inflightInference = new Set<Promise<void>>();
let meshAuthToken = W.MESH_AUTH_TOKEN ?? "";
const COORDINATOR_HTTP_TIMEOUT_MS = W.COORDINATOR_HTTP_TIMEOUT_MS;
const COORDINATOR_POST_RETRIES = W.COORDINATOR_POST_RETRIES;
const MAX_CONCURRENT_TASKS = W.MAX_CONCURRENT_TASKS;
const AGENT_CLIENT_TYPE = W.AGENT_CLIENT_TYPE;
/** Hosting region shown (coarsely) in the network's world view: AGENT_REGION, else Fly's own FLY_REGION. */
const AGENT_REGION = [W.AGENT_REGION, process.env.FLY_REGION].find((r) => typeof r === "string" && /^[a-z0-9-]{2,24}$/.test(r));
const PEER_DIRECT_WORK_ITEMS = (W.PEER_DIRECT_WORK_ITEMS ??
  "help peer with lightweight test scaffolding||review edge case handling").split("||");
const SANDBOX_MODE: SandboxMode = resolveSandboxMode(process.env);
/**
 * Throughput benchmark (src/swarm/benchmark.ts): a < ~30 s self-benchmark once the agent has
 * registered after startup and every AGENT_BENCHMARK_INTERVAL_MS (default 6 h), reported with the heartbeat, plus answers to the
 * coordinator's challenges, which are what actually grant a tier. AGENT_BENCHMARK=0 turns both off
 * (the agent then earns at its class base tier).
 */
// A cloud host has no hardware to prove (the coordinator admits it by its allowlist).
const BENCHMARK_ENABLED = W.AGENT_BENCHMARK && !CLOUD_MODE;
const BENCHMARK_INTERVAL_MS = Math.max(10 * 60_000, W.AGENT_BENCHMARK_INTERVAL_MS || 6 * 60 * 60_000);
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
  const n = W.AGENT_ASK_MSAT_PER_CREDIT ?? Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
})();
const SANDBOX_REQUIRED = W.SANDBOX_REQUIRED;
// #45: without a sandbox this node contributes no swarm compute (no /pull, no mesh/BLE/peer code execution).
const SWARM_EXECUTION_ENABLED = swarmExecutionEnabled(SANDBOX_MODE);
// Inference-only mode: with no sandbox, AGENT_INFERENCE_ONLY=1 lets the agent pull from the coordinator,
// which then hands it inference subtasks only (a model on text, never task code). Mesh, BLE and
// peer-direct code execution stay off. With a sandbox the flag is ignored: the agent takes all work.
const INFERENCE_ONLY = SANDBOX_MODE === "none" && W.AGENT_INFERENCE_ONLY === true;
if (W.AGENT_INFERENCE_ONLY && SANDBOX_MODE !== "none") {
  console.warn(`[agent] AGENT_INFERENCE_ONLY is ignored with SANDBOX_MODE=${SANDBOX_MODE}: this agent takes code and inference work`);
}
const PULLS_FROM_COORDINATOR = SWARM_EXECUTION_ENABLED || INFERENCE_ONLY;
if (CLOUD_MODE && !INFERENCE_ONLY) {
  // A cloud host answers model calls only; it never runs task code.
  console.error("[worker] a cloud host runs inference only: set SANDBOX_MODE=none and AGENT_INFERENCE_ONLY=1 (the `edgecoder cloud-host` role sets both)");
  process.exit(1);
}
/** Ollama keep_alive for network calls: a dedicated (inference-only) host keeps its model loaded. */
let MODEL_KEEP_ALIVE = modelSettings.keepAlive;
/** The configured network model has been loaded once (a re-sized window then re-loads it). */
let networkModelWarmed = false;
/**
 * Load the network model before taking work, so the first call does not pay a cold load (about
 * 4-5 s on a CPU, and a headers timeout under parallel calls). Bounded: a missing model or a
 * stopped Ollama only logs, and the agent goes on (the call then fails and is retried elsewhere).
 */
async function warmNetworkModel(model: string, why: string): Promise<void> {
  // vLLM / MLX load their model at start: check that it is up and serving instead.
  if (OPENAI_ENGINE) return refreshEngine(why);
  if (CLOUD_HOST) return; // nothing to load: the provider serves the model
  const host = OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const started = Date.now();
  // Never load past the host's memory budget (memory-manager.ts admits it or says why not).
  await hostMemory.refresh();
  const admission = await hostMemory.admit(model);
  if (!admission.ok) {
    console.warn(`[agent:${AGENT_ID}] not loading ${model} (${why}): ${admission.error}`);
    return;
  }
  try {
    // `generate`: also run a first short generation, whose one-time set-up (seconds to tens of seconds
    // on a GPU) would otherwise land on the first network call or the first benchmark challenge.
    await warmOllamaModel(host, model, { keepAlive: MODEL_KEEP_ALIVE, timeoutMs: 180_000, numCtx: CONTEXT_WINDOW, generate: true });
    if (model === OLLAMA_MODEL) networkModelWarmed = true;
    console.log(`[agent:${AGENT_ID}] model ${model} loaded (${why}) in ${Date.now() - started} ms, context ${CONTEXT_WINDOW}, keep_alive ${MODEL_KEEP_ALIVE}, ${MAX_PARALLEL_INFERENCE} parallel`);
  } catch (e) {
    console.warn(`[agent:${AGENT_ID}] could not load model ${model} (${why}): ${String(e).slice(0, 200)}`);
  } finally {
    admission.release();
  }
}
/** Last vLLM / MLX probe (undefined with Ollama, or before the first probe). */
let engineStatus: EngineStatus | undefined;
let engineLogKey = "";
/**
 * Probe the vLLM / MLX engine and take what it serves: the model (its catalog tag becomes this
 * agent's model), the context window and the slots (engine-probe.ts engineServing). Logged when
 * the state changes; a down engine leaves the last model in place but no free slot (the pull
 * reports 0), so no call is handed to an agent that cannot run it.
 */
async function refreshEngine(why: string): Promise<void> {
  if (!OPENAI_ENGINE) return;
  const s = await probeEngine(OPENAI_ENGINE, ENGINE_ALIASES);
  engineStatus = s;
  if (s.ok && s.model) {
    const ctxRaw = ENV_MODEL_SETTINGS.contextWindow !== undefined ? Number(ENV_MODEL_SETTINGS.contextWindow) : undefined;
    const plan = engineServing({ preset: OPENAI_ENGINE.preset, status: s, maxSlots: OPENAI_ENGINE.maxSlots, parallelOverride: ENV_MODEL_SETTINGS.parallel, contextOverride: ctxRaw, totalMemBytes: totalmem() });
    if (OLLAMA_MODEL !== s.model.tag || CONTEXT_WINDOW !== plan.contextWindow) lastRegisteredAtMs = 0; // re-register with the served model
    OLLAMA_MODEL = s.model.tag;
    MAX_PARALLEL_INFERENCE = plan.slots;
    CONTEXT_WINDOW = plan.contextWindow;
    installedModelsCache = { models: [s.model.tag], atMs: Date.now() };
  } else installedModelsCache = { models: [], atMs: Date.now() };
  const key = s.ok ? `ok:${s.model?.id}:${CONTEXT_WINDOW}:${MAX_PARALLEL_INFERENCE}` : `down:${s.problem}`;
  if (key === engineLogKey) return;
  engineLogKey = key;
  if (s.ok && s.model) {
    console.log(`[agent:${AGENT_ID}] ${ENGINE_LABEL} at ${OPENAI_ENGINE.url} serves ${s.model.id} as ${s.model.tag} (${why}): context ${CONTEXT_WINDOW}${s.model.maxModelLen ? ` (max_model_len ${s.model.maxModelLen})` : ""}, ${MAX_PARALLEL_INFERENCE} slot(s)${s.kvCacheTokens ? `, KV cache ${s.kvCacheTokens} tokens` : ""}`);
  } else {
    console.warn(`[agent:${AGENT_ID}] ${ENGINE_LABEL} not serving (${why}): ${s.problem}; taking no model calls until it is`);
  }
}
/**
 * The served id for a requested catalog tag: only the model the agent serves with (an MLX server
 * would otherwise load another cached model on demand, swapping out the one it serves).
 */
function servedEngineModel(tag: string): string | undefined {
  return engineStatus?.ok && engineStatus.model?.tag === tag ? engineStatus.model.id : undefined;
}
/** A network model call on the vLLM / MLX engine (inference-runner deps.chat). */
async function* engineChat(model: string, req: { messages: ChatMessage[]; tools?: ToolSpec[]; maxTokens?: number; temperature?: number }, signal: AbortSignal, timeoutMs: number) {
  const id = servedEngineModel(model);
  if (!OPENAI_ENGINE || !id) throw new Error(`model_unavailable: ${ENGINE_LABEL} here serves ${engineStatus?.model?.tag ?? "no model"}, not ${model}`);
  yield* openAiEngineChat(OPENAI_ENGINE, { model: id, ...req }, signal, timeoutMs);
}
/** The engine is up and serving (always true with Ollama, whose failures show per call). */
function engineReady(): boolean {
  // A cloud host is ready unless its spend guard paused it (a spend cap, or a key the provider refuses).
  if (CLOUD_HOST) return CLOUD_HOST.ready();
  return !OPENAI_ENGINE || engineStatus?.ok === true;
}
let warnedNoSandbox = false;
const AGENT_REGISTRATION_TOKEN = W.AGENT_REGISTRATION_TOKEN ?? "";
const PORTAL_URL = W.PORTAL_URL ?? "";
const AGENT_DEVICE_ID = (() => {
  const explicit = W.AGENT_DEVICE_ID ?? W.IOS_DEVICE_ID ?? "";
  if (explicit) return explicit;
  if (OS === "ios") return AGENT_ID.replace(/^ios-|^iphone-/i, "").trim();
  return "";
})();
const keys = createPeerKeys(AGENT_ID);
const envelopeKeys = generateX25519KeyPair();
const peerTunnels = new Map<string, string>();
const peerOfferCooldownMs = W.PEER_OFFER_COOLDOWN_MS;
const lastOfferAtByPeer = new Map<string, number>();
/** Direct-work offers already refused (logged once each). */
const refusedDirectOffers = new Set<string>();
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
  W.EDGECODER_STEERING &&
  !isLoopbackUrl(COORDINATOR_BOOTSTRAP_URL) &&
  REGISTRY_PUBLIC_KEYS.length > 0;
const STEERING_INTERVAL_MS = Math.max(60_000, W.EDGECODER_STEERING_INTERVAL_MS || 600_000);
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
  if (!W.COORDINATOR_URL || W.EDGECODER_DISCOVERY) {
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
/** Consecutive /register refusals for an enrolment problem, and the last one logged (registration-policy.ts). */
let enrollmentRefusals = 0;
let lastEnrollmentLog: { key: string; atMs: number } | null = null;
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
const LOCAL_FORWARD_PORT = W.LOCAL_FORWARD_PORT ?? 0;
if (LOCAL_FORWARD_PORT > 0) {
  let forwardToken: string | undefined;
  createLocalForwarder({
    token: () => (forwardToken ??= resolveIdeToken()),
    coordinatorUrl: () => registeredWithUrl,
    steering: () => steeringStatus,
    lifecycle: () => ({ ...lifecycle.status(), memory: hostMemory.view() }),
    serving: () => servingJobs.view(MAX_PARALLEL_INFERENCE),
    drain: async (resume) => {
      if (resume) {
        lifecycle.endDrain();
        return { draining: false, released: 0, told: false };
      }
      lifecycle.startDrain(DEFAULT_DRAIN_MS);
      if (!registeredWithUrl) return { draining: true, released: 0, told: false };
      const r = await announceGoingOffline((body) => post("/heartbeat", body, { retries: 0, timeoutMs: 4_000, signed: true }), AGENT_ID, "drain", 5_000);
      console.log(`[agent:${AGENT_ID}] draining for a restart${r.ok ? `: ${r.released} claim(s) handed back` : ""}`);
      return { draining: true, released: r.released, told: r.ok };
    },
    meshHeaders,
    signedHeaders,
    agentId: AGENT_ID
  })
    .on("error", (err) => console.warn(`[agent:${AGENT_ID}] local forwarder unavailable: ${String(err)}`))
    .listen(LOCAL_FORWARD_PORT, "127.0.0.1", () =>
      console.log(`[agent:${AGENT_ID}] local forwarder on 127.0.0.1:${LOCAL_FORWARD_PORT}`)
    );
}

// Installed headless agents (edgecoder-install writes EDGECODER_INSTANCE): agent-status.json in the
// agent's HOME and the SIGUSR2/SIGHUP update drain, so `edgecoder-install update` restarts it only
// when no work is running (src/swarm/update-drain.ts). Not on desktop runs, where SIGHUP must still end the process.
const updateDrain = process.env.EDGECODER_INSTANCE !== undefined && process.platform !== "win32" && process.env.HOME
  ? startUpdateDrain({
      home: process.env.HOME,
      version: appVersion(),
      status: () => {
        const st = lifecycle.status();
        return { registered: Boolean(registeredWithUrl), draining: st.draining, busy: st.claims + servingJobs.view(MAX_PARALLEL_INFERENCE).jobs.length + inflightInference.size };
      },
      startDrain: (ms) => lifecycle.startDrain(ms),
      endDrain: () => lifecycle.endDrain(),
      log: (line) => console.log(`[agent:${AGENT_ID}] ${line}`)
    })
  : null;

// The coordinator's update nudge (src/swarm/update-nudge.ts): same installed headless agents, signed
// release installs only (a package or source install is not updated by edgecoder-install update).
const updateNudge = updateDrain && isReleaseInstall()
  ? createUpdateNudge({
      home: process.env.HOME!,
      installedVersion: appVersion(),
      enabled: () => {
        if (/^(off|0|false|no|disabled?)$/i.test((process.env.EDGECODER_AUTO_UPDATE ?? "").trim())) return false;
        const read = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } };
        return autoUpdateSetting(read, (dir) => readdirSync(dir), "/etc/edgecoder").enabled;
      },
      log: (line) => console.log(`[agent:${AGENT_ID}] ${line}`)
    })
  : null;

/** Models in this machine's Ollama (embedding-only models left out); [] when it can't be reached. */
async function listInstalledModels(): Promise<string[]> {
  // A cloud host: its enabled cloud models, none while paused.
  if (CLOUD_HOST) return CLOUD_HOST.advertisedModels();
  if (OPENAI_ENGINE) {
    await refreshEngine("refresh");
    return engineStatus?.ok && engineStatus.model ? [engineStatus.model.tag] : [];
  }
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

// ── Remote model control (src/model/remote-control/) ──
// The owner changes this machine's models from the portal: the coordinator signs each command and
// sends it down the mesh WebSocket; the host's policy (AGENT_REMOTE_CONTROL, AGENT_MODEL_ALLOWLIST,
// bounds, disk and memory) decides what is done.
const ollamaAdmin = createOllamaAdmin(OLLAMA_HOST);
const SERVES_OLLAMA = PROVIDER === "ollama-local" || INFERENCE_ONLY;
/** Running network model calls, cancelled together under critical memory pressure. */
const networkCallAborts = new Set<AbortController>();
/**
 * Host memory (src/swarm/memory-manager.ts): which models this host serves on the network, what
 * may load, and the pressure guard. With vLLM / MLX (or no local model) only the guard applies.
 */
const MANAGES_OLLAMA_MEMORY = SERVES_OLLAMA && !OPENAI_ENGINE && !CLOUD_MODE;
const hostMemory = new HostMemoryManager({
  ollama: MANAGES_OLLAMA_MEMORY ? ollamaAdmin : { list: async () => [], loaded: async () => [], unload: async () => undefined },
  // vLLM / MLX: the served model is resident and holds the whole budget (vLLM preallocates
  // --gpu-memory-utilization of the VRAM); calls for it are limited by the engine's slots, which
  // come from its reported KV cache (refreshEngine), not from Ollama's /api/ps.
  ...(OPENAI_ENGINE ? { engine: () => (engineStatus?.ok && engineStatus.model ? { model: engineStatus.model.tag, bytes: MEMORY_BUDGET_BYTES } : undefined) } : {}),
  // A cloud host loads nothing: no plan, so every advertised model is served; only the pressure guard applies.
  ...(CLOUD_MODE ? { engine: () => undefined } : {}),
  readPressure: () =>
    readMemoryPressure({
      platform: process.platform,
      totalBytes: totalmem(),
      freeBytes: freemem,
      exec: (cmd, args) => {
        try {
          return execFileSync(cmd, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
        } catch {
          return null;
        }
      },
      readFile: (path) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return null;
        }
      }
    }),
  budgetBytes: MEMORY_BUDGET_BYTES,
  maxModels: MAX_NETWORK_MODELS,
  settings: () => ({ primary: OLLAMA_MODEL, contextWindow: CONTEXT_WINDOW, slots: MAX_PARALLEL_INFERENCE, kvSlots: OLLAMA_SERVER_PARALLEL ?? MAX_PARALLEL_INFERENCE }),
  guardEnabled: W.AGENT_MEMORY_GUARD !== false,
  // Critical pressure: cancel the running model calls (each fails with a memory_ error, so the
  // coordinator gives it to another agent) and hand every claim back (BHV006 going-offline path).
  onCritical: async () => {
    for (const a of networkCallAborts) a.abort();
    if (!registeredWithUrl) return;
    const r = await announceGoingOffline((body) => post("/heartbeat", body, { retries: 0, timeoutMs: 4_000, signed: true }), AGENT_ID, "drain", 5_000);
    console.warn(`[agent:${AGENT_ID}] critical memory pressure: network calls cancelled${r.ok ? `, ${r.released} claim(s) handed back` : ""}`);
  },
  log: (msg) => console.log(`[agent:${AGENT_ID}] ${msg}`),
  onModelFacts: () => resizeServing("sized from Ollama's model details")
});
setInterval(() => void hostMemory.refresh(), 5_000).unref?.();
void hostMemory.refresh();
console.log(`[agent:${AGENT_ID}] memory budget ${fmtGb(MEMORY_BUDGET_BYTES)}${MAX_NETWORK_MODELS ? `, at most ${MAX_NETWORK_MODELS} network model(s)` : ""}; pressure guard ${W.AGENT_MEMORY_GUARD !== false ? "on" : "off"}`);
// CPU steal guard (cpu-steal.ts): a VM throttled to its CPU baseline (credits spent) takes no new
// model call. Only where the model runs on this machine's CPU through Ollama (not the cloud host or
// a vLLM / MLX engine), and only where /proc/stat exists.
const cpuSteal = W.AGENT_CPU_STEAL_GUARD !== false && !CLOUD_HOST && !OPENAI_ENGINE && process.platform === "linux"
  ? new CpuStealGuard({ holdMs: W.AGENT_CPU_STEAL_HOLD_MS ?? CPU_STEAL_HOLD_MS })
  : undefined;
/** Read the steal guard on a loop tick: true while this host takes no new model call. Logs each change. */
function cpuThrottledNow(): boolean {
  if (!cpuSteal) return false;
  const s = cpuSteal.sample();
  if (s.changed) {
    const pct = cpuSteal.recentShare();
    console.warn(s.throttled
      ? `[agent:${AGENT_ID}] CPU throttled (${pct === null ? "?" : Math.round(pct * 100)}% of busy CPU time stolen): taking no new model calls for now`
      : `[agent:${AGENT_ID}] CPU no longer throttled: taking model calls again`);
  }
  return s.throttled;
}
/**
 * Run 7: the steal report sent with each pull and reply piece (coordinator host-steal.ts leaves calls
 * run while stolen from out of this host's measured speed). Empty where the guard does not run.
 */
function cpuStealReport(): CpuStealReport {
  if (!cpuSteal) return {};
  // A fresh reading (and its log line on a change), then what it says.
  cpuThrottledNow();
  return cpuSteal.report();
}
/** keep_alive for a network call: the agent's own model keeps the configured one; other models go after 5 minutes idle. */
function keepAliveFor(model: string | undefined): string {
  return model && model !== OLLAMA_MODEL && MODEL_KEEP_ALIVE !== "0" ? "5m" : MODEL_KEEP_ALIVE;
}
/** Puts the env + override file back into effect after a remote change (model reload included). */
async function applyModelSettings(): Promise<void> {
  const before = OLLAMA_MODEL;
  const sizedBefore = `${CONTEXT_WINDOW}x${MAX_PARALLEL_INFERENCE}`;
  modelOverrides = loadOverrides(MODEL_OVERRIDES_FILE).overrides;
  modelSettings = computeModelSettings();
  OLLAMA_MODEL = modelSettings.model;
  MAX_PARALLEL_INFERENCE = modelSettings.parallel;
  CONTEXT_WINDOW = modelSettings.contextWindow;
  MODEL_KEEP_ALIVE = modelSettings.keepAlive;
  installedModelsCache = undefined;
  if (before !== OLLAMA_MODEL) {
    // The old model would otherwise hold its memory until its keep-alive runs out (never, with -1).
    await ollamaAdmin.unload(before).catch(() => undefined);
    lastRegisteredAtMs = 0; // re-register: the coordinator learns the new active model
  }
  // A new window or slot count ("auto" from the portal re-sizes both) goes with the next register.
  if (sizedBefore !== `${CONTEXT_WINDOW}x${MAX_PARALLEL_INFERENCE}`) lastRegisteredAtMs = 0;
  console.log(`[agent:${AGENT_ID}] model settings now: ${OLLAMA_MODEL}, context ${CONTEXT_WINDOW}, ${MAX_PARALLEL_INFERENCE} parallel, keep_alive ${MODEL_KEEP_ALIVE}`);
  if (SERVES_OLLAMA) await warmNetworkModel(OLLAMA_MODEL, "remote change");
}
/**
 * Re-size the context window (and slots) when its inputs change after startup: Ollama described
 * the model (size, KV cache per token, context length: memory-manager.ts learnFacts), or a
 * Vulkan-only GPU was confirmed in use. The new window is reported with the next pull and register;
 * an already loaded model is re-loaded with it now, so no network call pays for the reload.
 */
function resizeServing(why: string): void {
  if (OPENAI_ENGINE || CLOUD_HOST) return;
  const next = computeModelSettings();
  if (next.model !== OLLAMA_MODEL) return; // a model change is applied by applyModelSettings
  if (next.contextWindow === CONTEXT_WINDOW && next.parallel === MAX_PARALLEL_INFERENCE) return;
  console.log(`[agent:${AGENT_ID}] context window ${CONTEXT_WINDOW} -> ${next.contextWindow} tokens, ${MAX_PARALLEL_INFERENCE} -> ${next.parallel} parallel (${why})`);
  modelSettings = next;
  CONTEXT_WINDOW = next.contextWindow;
  MAX_PARALLEL_INFERENCE = next.parallel;
  lastRegisteredAtMs = 0;
  if (networkModelWarmed && SERVES_OLLAMA && PULLS_FROM_COORDINATOR) void warmNetworkModel(OLLAMA_MODEL, "context window resized");
}
const modelControl = new ModelControlAgent({
  agentId: AGENT_ID,
  // vLLM / MLX serve the model they were started with: model changes are made on the host.
  enabled: remoteControlEnabled(W.AGENT_REMOTE_CONTROL) && !OPENAI_ENGINE && !CLOUD_MODE,
  extraNotes: () => [
    ...(OPENAI_ENGINE ? [`The model is served by ${ENGINE_LABEL} (EDGECODER_ENGINE=${OPENAI_ENGINE.preset}) at ${OPENAI_ENGINE.url}: change it on the host; remote model control is view only`] : []),
    // A Vulkan-only GPU (src/swarm/gpu-claim.ts): say which class the agent claims and why.
    ...(GPU_NEEDS_OFFLOAD_PROOF && HARDWARE_PROFILE.gpu
      ? [gpuClaim.claimGpu
          ? `GPU class claimed: ${gpuClaim.detail}`
          : `Paid as CPU until the GPU is confirmed: ${gpuClaim.detail}. Run Ollama on the GPU (AMD without ROCm: sudo edgecoder-install apply --keep-config --ollama-env OLLAMA_VULKAN=1) and load the model`]
      : [])
  ],
  allowlist: resolveAllowlist(W.AGENT_MODEL_ALLOWLIST),
  ollama: ollamaAdmin,
  overridesFile: MODEL_OVERRIDES_FILE,
  env: ENV_MODEL_SETTINGS,
  overrides: modelOverrides,
  current: () => ({ ...modelSettings, model: OLLAMA_MODEL, parallel: MAX_PARALLEL_INFERENCE, contextWindow: CONTEXT_WINDOW, keepAlive: MODEL_KEEP_ALIVE }),
  apply: applyModelSettings,
  hardware: (() => {
    const gpu = HARDWARE_PROFILE.gpu as { vendor?: string; model?: string; vramGb?: number; count?: number } | undefined;
    // Apple silicon shares RAM with the GPU: memory is counted once (as RAM).
    const vramBytes = gpu && gpu.vendor !== "apple" && gpu.vramGb ? Math.round(gpu.vramGb * 1024 ** 3) : undefined;
    return { ramBytes: totalmem(), vramBytes, gpu: gpu ? { vendor: gpu.vendor, model: gpu.model, count: gpu.count } : undefined };
  })(),
  modelsDir: ollamaModelsDir(),
  diskSpace,
  sizeOf: (model) => registryModelSize(model),
  report: async (body) => {
    await post(`/agent-control/agents/${encodeURIComponent(AGENT_ID)}/report`, body, { retries: 1, timeoutMs: 10_000, signed: true });
  },
  // The desktop app (all-in-one) owns its machine's settings.
  localUi: process.env.EDGE_RUNTIME_MODE === "all-in-one",
  ollamaNumParallel: Number.isInteger(Number(process.env.OLLAMA_NUM_PARALLEL)) && Number(process.env.OLLAMA_NUM_PARALLEL) > 0 ? Number(process.env.OLLAMA_NUM_PARALLEL) : undefined
});
// Bots on the web (src/common/bot-relay.ts): with the desktop's IDE provider on this machine (it
// routes its swarm work through this agent), its bots are published to the owner's portal and the
// owner's signed commands are handed to it.
const botRelay: BotRelayAgent | null = LOCAL_FORWARD_PORT > 0
  ? new BotRelayAgent({
      agentId: AGENT_ID,
      mode: botRelayMode(W.AGENT_BOT_RELAY, remoteControlEnabled(W.AGENT_REMOTE_CONTROL)),
      machineName: hostname().replace(/\.local$/i, ""),
      provider: httpProviderClient({
        baseUrl: `http://127.0.0.1:${W.IDE_PROVIDER_PORT ?? 4304}`,
        token: (() => {
          let t: string | undefined;
          return () => (t ??= resolveIdeToken());
        })(),
        request
      }),
      report: async (body) => {
        if (!registeredWithUrl) throw new Error("not registered yet");
        await post(`/agent-control/agents/${encodeURIComponent(AGENT_ID)}/bots/report`, body, { retries: 0, timeoutMs: 10_000, signed: true });
      },
      log: (m) => console.log(`[agent:${AGENT_ID}] ${m}`)
    })
  : null;
// Code from your phone (src/common/code-relay.ts): with the desktop's IDE provider on this machine,
// its trusted projects and visible sessions are published for the account that owns this machine
// (the coordinator names it at /register), and that account's signed commands are handed to it.
// Off unless the app's "Code from your phone" setting (AGENT_CODE_RELAY) turns it on.
let codeRelayAccount: string | null = null;
const codeRelayModeHere = codeRelayMode(W.AGENT_CODE_RELAY, remoteControlEnabled(W.AGENT_REMOTE_CONTROL));
const codeRelay: CodeRelayAgent | null = LOCAL_FORWARD_PORT > 0 && codeRelayModeHere !== "off"
  ? new CodeRelayAgent({
      agentId: AGENT_ID,
      mode: codeRelayModeHere,
      machineName: hostname().replace(/\.local$/i, ""),
      account: () => codeRelayAccount,
      provider: httpCodeProviderClient({
        baseUrl: `http://127.0.0.1:${W.IDE_PROVIDER_PORT ?? 4304}`,
        token: (() => {
          let t: string | undefined;
          return () => (t ??= resolveIdeToken());
        })(),
        request
      }),
      report: async (body) => {
        if (!registeredWithUrl) throw new Error("not registered yet");
        await post(`/agent-control/agents/${encodeURIComponent(AGENT_ID)}/code/report`, body, { retries: 0, timeoutMs: 10_000, signed: true });
      },
      log: (m) => console.log(`[agent:${AGENT_ID}] ${m}`)
    })
  : null;
// Web calls on this machine for its owner's own chats (src/web-tool/local-web.ts): searches on the
// host's SearXNG (SEARXNG_URL, loopback only) and page reads, asked by our pinned coordinator.
const localWeb = new LocalWebAgent({
  agentId: AGENT_ID,
  searxngUrl: searxngBaseUrl(W.SEARXNG_URL),
  enabled: localWebEnabled(W.AGENT_LOCAL_WEB),
  search: (base, query, count) => searxngSearch(base, query, count),
  read: (url) => fetchPage(url),
  healthy: (base) => searxngHealthy(base),
  report: async (result) => {
    if (!registeredWithUrl) throw new Error("not registered yet");
    await post(`/agent-control/agents/${encodeURIComponent(AGENT_ID)}/web/result`, result, { retries: 0, timeoutMs: 10_000, signed: true });
  },
  log: (m) => console.log(`[agent:${AGENT_ID}] ${m}`)
});
const MODEL_STATE_REPORT_MS = 10 * 60_000;
let lastModelStateReportMs = 0;
/** Sends this machine's model state to the coordinator (the portal's view). */
async function reportModelState(): Promise<void> {
  lastModelStateReportMs = Date.now();
  try {
    await post(`/agent-control/agents/${encodeURIComponent(AGENT_ID)}/report`, { state: await modelControl.state() }, { retries: 0, timeoutMs: 10_000, signed: true });
  } catch (e) {
    console.warn(`[agent:${AGENT_ID}] model state report failed: ${String(e).slice(0, 160)}`);
  }
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
function signedHeaders(path: string, body: unknown, method = "POST"): Record<string, string> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const bodyHash = hashRequestBody(raw);
  return signRequest({
    method,
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
const LEASE_HEARTBEAT_MS = Math.max(1_000, W.LEASE_HEARTBEAT_MS || 15_000);
/**
 * #51: lease-only renewal while a claimed subtask runs. `leaseOnly` tells the
 * coordinator to renew leases without draining tunnel invites / close notices /
 * direct-work offers, which the main loop's full heartbeat still collects.
 * Only wired around claims pulled from this coordinator: mesh-gossip tasks are
 * leased by their origin coordinator, and peer-direct/offline runs hold no lease.
 */
function startLeaseHeartbeat(issuer: CoordinatorTarget | null): () => void {
  const claimEnded = lifecycle.claimStarted();
  const timer = setInterval(() => {
    const body = { agentId: AGENT_ID, sandboxMode: SANDBOX_MODE, leaseOnly: true };
    // To the coordinator that issued the claim (it holds the lease), even after a drain failover.
    void post("/heartbeat", body, { retries: 0, timeoutMs: 5000, signed: true, to: issuer }).catch(
      (e) => console.warn(`[agent:${AGENT_ID}] lease heartbeat failed: ${e}`)
    );
  }, LEASE_HEARTBEAT_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    claimEnded();
  };
}

async function post(
  path: string,
  body: unknown,
  options?: { retries?: number; timeoutMs?: number; extraHeaders?: Record<string, string>; signed?: boolean; to?: CoordinatorTarget | null }
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
      }, options?.to);
      const parsed = (await parseJsonBodySafe(res)) as unknown;
      const rawText = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const payloadText = rawText && rawText !== "{}" ? rawText : "<empty>";
        const err = new Error(`POST ${path} failed (${res.statusCode}): ${payloadText}`);
        (err as any).statusCode = res.statusCode;
        if (res.statusCode === 429) (err as any).retryAfterMs = parseRetryAfterMs(res.headers["retry-after"]) ?? undefined;
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
      // 429: over the per-agent request rate. Wait what the coordinator asked, then try again.
      const rateLimitWait = rateLimitWaitMs(error);
      if (rateLimitWait !== null) {
        await new Promise((r) => setTimeout(r, rateLimitWait));
        continue;
      }
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
  // Signed over GET + path: the coordinator admits agents by their own key, not a shared token.
  return coordinatorClient.call({ method: "GET", path, headers: { ...meshHeaders(), ...signedHeaders(path, "", "GET") } });
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

/**
 * Coordinators this agent pulled claims from, with the key each proved then: a buffered result goes
 * to the coordinator that issued its claim (drain-failover.ts), not to whichever one is active now.
 */
const claimIssuers = new Map<string, CoordinatorTarget>();
/** Claims running now, per issuing coordinator URL (a drain failover comes home once the peer's are done). */
const claimsInFlight = new Map<string, number>();
function claimsInFlightFor(url: string | null): number {
  return url ? (claimsInFlight.get(url) ?? 0) : 0;
}
function noteClaimIssuer(target: CoordinatorTarget): CoordinatorTarget {
  claimIssuers.set(target.url, target);
  if (claimIssuers.size > 16) claimIssuers.delete(claimIssuers.keys().next().value!);
  return target;
}

async function flushPendingResults(): Promise<void> {
  // A result refused for good (lease_expired) is dropped, not retried forever (src/swarm/pending-results.ts).
  // One owed to another coordinator than the active one goes there (its claim's issuer), or waits.
  const deliver = (payload: unknown, issuerUrl?: string) => {
    if (!issuerUrl || issuerUrl === coordinator.url) return post("/result", payload, { signed: true });
    const to = claimIssuers.get(issuerUrl);
    if (!to) return Promise.reject(new ResultNotRoutableYetError(issuerUrl));
    return post("/result", payload, { signed: true, to });
  };
  await flushPendingResultBuffer(localStore, deliver, {
    info: (m) => console.log(`[agent:${AGENT_ID}] ${m}`),
    warn: (m) => console.warn(`[agent:${AGENT_ID}] ${m}`),
  });
}

async function flushOfflineLedger(): Promise<void> {
  const unsynced = localStore.listUnsyncedBLECredits(50);
  if (unsynced.length === 0) return;
  console.log(`[agent:${AGENT_ID}] flushing ${unsynced.length} BLE credit transaction(s)`);
  try {
    const transactions = unsynced.map(ledgerRowToTransaction);
    const bleSyncBody = { transactions };
    const result = await post("/credits/ble-sync", bleSyncBody, { signed: true });
    // #63: only stop retrying what settled (or can never settle); the rest stays in the ledger.
    const settled = settledBleTxIds(result);
    localStore.markBLECreditsSynced(settled);
    const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
    if (skipped.length) console.warn(`[agent:${AGENT_ID}] BLE credit sync skipped ${skipped.length}: ${JSON.stringify(skipped.slice(0, 5))}`);
    console.log(`[agent:${AGENT_ID}] BLE credits synced (${Array.isArray(result?.applied) ? result.applied.length : 0} applied)`);
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
    peer.addPeer({ peerId: id.peerId, publicKeyPem: id.publicKeyPem, coordinatorUrl, networkMode: id.networkMode === "enterprise_overlay" ? "enterprise_overlay" : "public_mesh" }, "coordinator", { trusted: true });
  } catch {
    // unknown sender stays unknown; its messages are dropped
  }
}

// ── Fast dispatch (src/swarm/coordinator/dispatch.ts) ──
// The coordinator sends "work_available" (no task, no id) down the authenticated mesh WebSocket
// when there is work this agent could take; the agent then pulls at once with its normal signed
// /pull, where every claim rule applies. The poll stays as the fallback, slower while the socket
// is up. A nudge can only make the agent pull sooner.
/** Poll interval while idle: with the mesh WebSocket up (nudges arrive), and without. */
const IDLE_POLL_WITH_NUDGES_MS = 3_000;
const IDLE_POLL_MS = 1_200;
/** A nudged pass skips registration/heartbeat/tunnels when a full pass ran this recently. */
const QUICK_PULL_WINDOW_MS = 5_000;
let meshWsOpen = false;
/**
 * Registration epochs: bumped by every registration made from the unregistered state (first
 * start, after a coordinator restart / 401 agent_not_registered, after offline recovery). A mesh
 * socket opened in an earlier epoch was bound before the coordinator held our key again, so it is
 * reopened for a fresh signed bind (and the bot/code relays publish again on open).
 */
let registrationEpoch = 0;
let meshWsEpoch = -1;
let currentMeshWs: WebSocket | null = null;
/** One immediate re-registration per window (registration-policy.ts), shared by HTTP 401s and WS refusals. */
const quickReregister = new QuickReregisterGate();

/** Call after a successful /register; `fresh` when we were not registered with this URL before it. */
function noteRegistered(fresh: boolean): void {
  if (!fresh) return;
  registrationEpoch++;
  const ws = currentMeshWs;
  if (ws && ws.readyState === WebSocket.OPEN && meshWsEpoch < registrationEpoch) {
    console.log(`[agent:${AGENT_ID}] registered again: reopening the mesh WebSocket for a fresh bind`);
    try {
      ws.close(MESH_WS_REBIND_CLOSE_CODE, "rebind_after_register");
    } catch {
      /* the close handler reconnects either way */
    }
  }
}
let wokenByNudge = false;
let lastHousekeepingAtMs = 0;
let wakeIdle: (() => void) | null = null;
let wakePending = false;
/** Wake the loop's idle wait now (a nudge, or a model slot that just freed). */
function wakeLoop(byNudge: boolean): void {
  if (byNudge) wokenByNudge = true;
  if (wakeIdle) wakeIdle();
  else wakePending = true;
}
/** The loop's idle wait: ends after `ms` or at the first wakeLoop. */
function idleWait(ms: number): Promise<void> {
  if (wakePending) {
    wakePending = false;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wakeIdle = null;
      resolve();
    };
    const timer = setTimeout(done, ms);
    wakeIdle = done;
  });
}

// ── Coordinator restart (src/mesh/coordinator-reconnect.ts, src/swarm/coordinator/drain.ts) ──
// A coordinator stopping for a deploy sends each agent a signed reconnect frame. The agent waits
// the frame's jittered delay, registers again (the new instance knows nothing of it), and only
// then reopens the mesh WebSocket, whose open republishes the relay snapshots and model state.
const coordinatorReconnect = new CoordinatorReconnectState();
// Open from the restart signal until registered again: failures retry every ~1-2 s, not 3/6/12 s + offline.
const restartWindow = new CoordinatorRestartWindow();
// A planned drain (src/mesh/drain-failover.ts): serve through a peer coordinator meanwhile, come home after.
const drainFailover = new DrainFailover();
/**
 * A planned drain signal from `drainingUrl`: open the restart window as planned (no 30 s wait
 * before failover) and start serving through a peer. Claims held there keep reporting there.
 */
function onPlannedDrain(reason: string, drainingUrl: string, peerUrl?: string | null): void {
  // A late signal from a coordinator we already left (a stale socket's 1012) changes nothing.
  if (drainingUrl.replace(/\/+$/, "") !== coordinator.url) return;
  restartWindow.open(Date.now(), true);
  if (!drainFailover.notice({ drainingUrl, peerUrl, reason })) return;
  const waitMs = drainFailover.msUntilDue();
  console.log(`[agent:${AGENT_ID}] coordinator ${drainingUrl} is draining (${reason}): serving through a peer coordinator in ${waitMs}ms; claims held there report there`);
  setTimeout(() => wakeLoop(false), waitMs + 5).unref?.();
  wakeLoop(false);
}
function onCoordinatorDrainNotice(message: unknown, coordinatorUrl: string): void {
  let verified: { peerId: string; publicKeyPem: string } | null = null;
  try {
    verified = coordinator.url === coordinatorUrl ? coordinator.requireVerifiedIdentity().identity : null;
  } catch {
    verified = null;
  }
  const verdict = verifyCoordinatorDrainNoticeFrame(message, { agentId: AGENT_ID, coordinator: verified });
  if (!verdict.ok) {
    console.warn(`[agent:${AGENT_ID}] drain notice refused: ${verdict.reason}`);
    return;
  }
  onPlannedDrain("drain_notice", coordinatorUrl, verdict.command.peerUrl || null);
}
/** GET /identity at the home coordinator (unauthenticated, costs nothing against registration budgets). */
async function probeDrainHome(url: string): Promise<"up" | "draining" | "down"> {
  try {
    const res = await request(`${url}/identity`, { method: "GET", headersTimeout: 3_000, bodyTimeout: 3_000 });
    const body = res.statusCode >= 200 && res.statusCode < 300 ? await res.body.json().catch(() => null) : (await res.body.dump(), null);
    return homeProbeState(res.statusCode, body);
  } catch {
    return "down";
  }
}
/**
 * One step of a drain failover (drain-failover.ts), at the top of an online pass: move to a peer
 * when due, probe the home while away, switch back once it answers without draining.
 */
async function stepDrainFailover(): Promise<void> {
  const now = Date.now();
  // Something else moved the agent meanwhile (steering, the usual failover): that choice stands.
  if (drainFailover.state === "away" && coordinator.url !== drainFailover.away) {
    console.log(`[agent:${AGENT_ID}] drain failover ended: now working for ${coordinator.url}`);
    drainFailover.reset();
    return;
  }
  if (drainFailover.failoverDue(now)) {
    const steered = await steerCoordinator().catch(() => null);
    const peer = drainFailover.pickPeer([steered?.url, drainFailover.peerHint]);
    if (!peer) {
      drainFailover.noPeer();
      console.warn(`[agent:${AGENT_ID}] no peer coordinator to serve through while ${drainFailover.home} drains; waiting for it to come back`);
      return;
    }
    coordinator.set(peer, `drain_failover:${drainFailover.reason}`);
    // Register with the peer now (the reconnect hold was for the restarted home).
    registeredWithUrl = null;
    coordinatorReconnect.clear();
    drainFailover.moved(peer);
    console.warn(`[agent:${AGENT_ID}] serving through ${peer} while ${drainFailover.home} restarts`);
    return;
  }
  const home = drainFailover.home;
  if (home && drainFailover.homeProbeDue(now)) {
    if (drainFailover.onHomeProbe(await probeDrainHome(home))) {
      const waitMs = drainFailover.msUntilDue();
      console.log(`[agent:${AGENT_ID}] ${home} is back: returning in ${waitMs}ms`);
      setTimeout(() => wakeLoop(false), waitMs + 5).unref?.();
    }
    return;
  }
  if (home && drainFailover.returnDue(now)) {
    // The peer's own calls first (the pull meanwhile reports no free slot, so the peer neither gives
    // more nor takes them back as from a host that stopped pulling).
    if (drainFailover.holdingForPeerCalls(claimsInFlightFor(drainFailover.away), now)) return;
    coordinator.set(home, "drain_return");
    registeredWithUrl = null;
    drainFailover.homing();
  }
}
function onCoordinatorReconnectFrame(message: unknown, coordinatorUrl: string, ws: { close: (code?: number, reason?: string) => void }): void {
  let verified: { peerId: string; publicKeyPem: string } | null = null;
  try {
    verified = coordinator.url === coordinatorUrl ? coordinator.requireVerifiedIdentity().identity : null;
  } catch {
    verified = null;
  }
  const verdict = verifyCoordinatorReconnectFrame(message, { agentId: AGENT_ID, coordinator: verified });
  if (!verdict.ok) {
    console.warn(`[agent:${AGENT_ID}] reconnect frame refused: ${verdict.reason}`);
    return;
  }
  const delayMs = coordinatorReconnect.accept(verdict.command);
  if (delayMs === null) return;
  onPlannedDrain("reconnect_frame", coordinatorUrl);
  console.log(`[agent:${AGENT_ID}] coordinator restarting (${verdict.command.reason}); registering again in ${delayMs}ms, then reconnecting`);
  registeredWithUrl = null;
  try {
    ws.close(1000, "coordinator_reconnect");
  } catch {
    /* already closed */
  }
  setTimeout(() => wakeLoop(false), delayMs);
}

/** What /heartbeat answers (the fields the worker uses). */
type HeartbeatReply = {
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
    /** The verified account of the sender; the coordinator relays only same-account offers. */
    fromAccountId?: string;
  }>;
  blacklist?: { version: number; agents: string[] };
  /** The newest agent release, when this agent reported an older version (update-nudge.ts). */
  updateAvailable?: string;
    benchmarkChallenge?: BenchmarkChallenge;
    hardwareVerification?: { status?: string; claimedTier?: string; grantedTier?: string } | null;
};

function connectMeshWebSocket(getMeshPeer: () => MeshPeer | null): void {
  let reconnectDelay = 1000;
  /** How often the mesh socket is pinged; a missed pong by the next ping ends it (half-open sockets after a coordinator restart). */
  const MESH_WS_PING_MS = 30_000;
  const MAX_RECONNECT_DELAY = 30_000;

  function connect(): void {
    // A coordinator restart: wait until this agent has registered with the new instance.
    if (coordinatorReconnect.pending()) {
      setTimeout(connect, 500);
      return;
    }
    // Only to a coordinator that has proven its key (it follows URL changes on reconnect), and only
    // once registered: the coordinator admits the connection by this agent's signed bind.
    // Waiting for our own registration is a local check: poll it quickly, without growing the wait
    // (a doubled wait used to leave the socket closed for up to 30 s after registering again).
    if (!registeredWithUrl || !coordinator.isVerified()) {
      const d = nextMeshWsDelay(reconnectDelay, { waitingForRegistration: true, restarting: restartWindow.active(), maxMs: MAX_RECONNECT_DELAY });
      reconnectDelay = d.next;
      setTimeout(connect, d.waitMs);
      return;
    }
    // Token in a header only (never the URL, where proxies log it), and a signed bind so the
    // coordinator ties this connection to AGENT_ID's registered key (src/mesh/ws-auth.ts).
    const coordinatorUrl = coordinator.url;
    const ws = new WebSocket(meshWsUrl(coordinatorUrl, AGENT_ID), { headers: { ...meshHeaders(), ...signMeshWsBind(AGENT_ID, keys.privateKeyPem) } });
    currentMeshWs = ws;
    const openedInEpoch = registrationEpoch;

    // Track which coordinator peerId this WS is registered against
    let registeredPeerId: string | null = null;

    // Liveness: a coordinator that restarted behind Fly's proxy can leave this socket half-open
    // (no close ever arrives), so the agent would never reconnect. Ping every 30 s; no pong by the
    // next ping = dead: terminate, and the close handler reconnects.
    let alive = true;
    let liveness: ReturnType<typeof setInterval> | undefined;
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("open", () => {
      alive = true;
      liveness = setInterval(() => {
        if (!alive) {
          console.warn(`[agent:${AGENT_ID}] mesh WebSocket stopped answering pings: reconnecting`);
          ws.terminate();
          return;
        }
        alive = false;
        try {
          ws.ping();
        } catch {
          /* the close handler takes over */
        }
      }, MESH_WS_PING_MS);
      liveness.unref?.();
      meshWsOpen = true;
      meshWsEpoch = openedInEpoch;
      console.log(`[agent:${AGENT_ID}] mesh WebSocket connected to ${coordinatorUrl}`);
      reconnectDelay = 1000;
      // The portal's view of this machine's models (also refreshed every MODEL_STATE_REPORT_MS).
      void reportModelState();
      // And of its bots: send them again now, then on change and on the heartbeat.
      if (botRelay) {
        botRelay.invalidate();
        botRelay.start();
        void botRelay.publish(true);
      }
      if (codeRelay) {
        codeRelay.invalidate();
        codeRelay.start();
        void codeRelay.publish(true);
      }
    });

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());
        // Fast dispatch: there is work; pull now (the pull decides what, if anything, we get).
        if (message && typeof message === "object" && message.type === "work_available" && !message.fromPeerId) {
          wakeLoop(true);
          return;
        }
        // The coordinator starts draining (a deploy or restart): serve through a peer meanwhile.
        if (message && typeof message === "object" && message.type === COORDINATOR_DRAIN_NOTICE_FRAME_TYPE) {
          onCoordinatorDrainNotice(message, coordinatorUrl);
          return;
        }
        // The coordinator is stopping (a deploy): register again after the delay, then reconnect.
        if (message && typeof message === "object" && message.type === COORDINATOR_RECONNECT_FRAME_TYPE) {
          onCoordinatorReconnectFrame(message, coordinatorUrl, ws);
          return;
        }
        // Remote model control: checked against the coordinator identity we proved (pinned key),
        // its target, lifetime and replay; then the host's own policy. Never gossip.
        if (message && typeof message === "object" && message.type === MODEL_CONTROL_FRAME_TYPE) {
          let verified: { peerId: string; publicKeyPem: string } | null = null;
          try {
            verified = coordinator.url === coordinatorUrl ? coordinator.requireVerifiedIdentity().identity : null;
          } catch {
            verified = null;
          }
          void modelControl.handleFrame(message, verified).then(() => {
            installedModelsCache = undefined;
          });
          return;
        }
        // Bots on the web: the same checks (pinned coordinator key, target, lifetime, replay), then
        // the host policy, then the desktop app's own (account, validation, the bot's rules).
        if (message && typeof message === "object" && message.type === BOT_CONTROL_FRAME_TYPE) {
          let verified: { peerId: string; publicKeyPem: string } | null = null;
          try {
            verified = coordinator.url === coordinatorUrl ? coordinator.requireVerifiedIdentity().identity : null;
          } catch {
            verified = null;
          }
          if (botRelay) void botRelay.handleFrame(message, verified);
          return;
        }
        // Code from your phone: the same checks (pinned coordinator key, target, lifetime, replay), then
        // AGENT_CODE_RELAY, then the desktop app's own (signed-in account, trusted folders, session rules).
        if (message && typeof message === "object" && message.type === CODE_CONTROL_FRAME_TYPE) {
          let verified: { peerId: string; publicKeyPem: string } | null = null;
          try {
            verified = coordinator.url === coordinatorUrl ? coordinator.requireVerifiedIdentity().identity : null;
          } catch {
            verified = null;
          }
          if (codeRelay) void codeRelay.handleFrame(message, verified);
          return;
        }
        // Local web for the owner's chat: the same checks (pinned coordinator key, target, lifetime, replay).
        if (message && typeof message === "object" && message.type === LOCAL_WEB_FRAME_TYPE) {
          let verified: { peerId: string; publicKeyPem: string } | null = null;
          try {
            verified = coordinator.url === coordinatorUrl ? coordinator.requireVerifiedIdentity().identity : null;
          } catch {
            verified = null;
          }
          void localWeb.handleFrame(message, verified);
          return;
        }
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
          // Also when the id is held by an untrusted (self-registered) entry: a trusted add replaces it.
          if (typeof message.fromPeerId === "string" && !peer.getPeer(message.fromPeerId)?.trusted) {
            await learnCoordinatorPeer(peer, coordinatorUrl, message.fromPeerId);
          }
          await peer.handleIngest(message);
        }
      } catch (err) {
        console.warn(`[agent:${AGENT_ID}] ws ingest error: ${(err as Error).message}`);
      }
    });

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      if (liveness) clearInterval(liveness);
      if (currentMeshWs === ws) currentMeshWs = null;
      meshWsOpen = false;
      // The coordinator does not know our key (it restarted): register again now rather than after
      // the HTTP loop has counted its way into offline mode; the reconnect below waits for it.
      const reason = reasonBuf?.toString?.() ?? "";
      if (isNotRegisteredWsClose(code, reason) && registeredWithUrl === coordinatorUrl && quickReregister.tryTake()) {
        console.warn(`[agent:${AGENT_ID}] mesh WebSocket refused (${code} ${reason}): registering again`);
        registeredWithUrl = null;
        wakeLoop(false);
      }
      // Unregister WS from gossip mesh
      if (registeredPeerId) {
        const peer = getMeshPeer();
        if (peer) peer.gossip.removeWebSocketForPeer(registeredPeerId);
        registeredPeerId = null;
      }
      // The coordinator is restarting (1012, or our own close on its reconnect frame): retry within
      // ~2 s until it is back, and have the HTTP loop register again on its next tick.
      if (isRestartClose(code, reason)) {
        if (!restartWindow.active()) reconnectDelay = 1000;
        // A planned restart: serve through a peer meanwhile (our own close on a reconnect frame already did).
        if (code === 1012) onPlannedDrain("restart_close", coordinatorUrl);
        else restartWindow.open(Date.now(), true);
        if (code === 1012 && registeredWithUrl === coordinatorUrl && !coordinatorReconnect.pending()) {
          registeredWithUrl = null;
          wakeLoop(false);
        }
      }
      const d = nextMeshWsDelay(reconnectDelay, { waitingForRegistration: false, restarting: restartWindow.active(), maxMs: MAX_RECONNECT_DELAY });
      reconnectDelay = d.next;
      console.log(`[agent:${AGENT_ID}] mesh WebSocket closed, reconnecting in ${d.waitMs}ms`);
      setTimeout(connect, d.waitMs);
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
    enabled: PROVIDER === "ollama-local" && !OPENAI_ENGINE && !CLOUD_MODE,
    autoInstall: OLLAMA_AUTO_INSTALL,
    model: OLLAMA_MODEL,
    role: "agent",
    host: OLLAMA_HOST
  });
  // Before the first pull (registration waits a few seconds at most): the network model is loaded.
  if (OPENAI_ENGINE) await refreshEngine("startup");
  else if (PULLS_FROM_COORDINATOR && (PROVIDER === "ollama-local" || INFERENCE_ONLY)) await warmNetworkModel(OLLAMA_MODEL, "startup");

  const providers = OPENAI_ENGINE
    ? new ProviderRegistry(undefined, new OpenAiEngineProvider(OPENAI_ENGINE, () => (engineStatus?.ok ? engineStatus.model?.id : undefined)))
    : new ProviderRegistry();
  let currentProvider = PROVIDER;
  providers.use(currentProvider);
  const worker = new SwarmWorkerAgent(providers.current());
  const effectiveMode = OS === "ios" ? "swarm-only" : MODE;

  /** Every subtask runs through the same execution policy, whatever its source. */
  async function runPolicedSubtask(st: Subtask, opts: { quiet?: boolean } = {}): Promise<SubtaskResult> {
    const policy = checkSnapshotPolicy(st, SNAPSHOT_ENFORCEMENT);
    if (!policy.run) {
      console.error(`[agent:${AGENT_ID}] snapshot enforcement: ${policy.error}`);
      return { subtaskId: st.id, taskId: st.taskId, agentId: AGENT_ID, ok: false, output: "", error: policy.error, durationMs: 0, executed: false };
    }
    if (policy.warning && !opts.quiet) console.warn(`[agent:${AGENT_ID}] snapshot warning: ${policy.warning}`);
    return worker.runSubtask(st, AGENT_ID);
  }

  // ── Initialize HTTP mesh peer (BitTorrent-style P2P) ──
  let meshPeer: MeshPeer | null = null;
  let meshServer: MeshHttpServer | null = null;
  // Bounded queue and claimed-id memory (src/mesh/mesh-task-queue.ts).
  const meshTaskQueue = new MeshTaskQueue();
  /** The identity the coordinator proved in its challenge; null until verified. */
  const verifiedCoordinatorIdentity = (): { peerId: string; publicKeyPem: string } | null => {
    try {
      return coordinator.requireVerifiedIdentity().identity;
    } catch {
      return null;
    }
  };
  try {
    const localIp = W.AGENT_MESH_HOST === "127.0.0.1" || W.AGENT_MESH_HOST === "localhost" ? "127.0.0.1" : getLocalIpAddress();
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
      // Loopback unless the operator opts in to LAN gossip (AGENT_MESH_HOST): a container's
      // HOST=0.0.0.0 must not expose the agent's mesh server to its network.
      host: W.AGENT_MESH_HOST,
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
      // Work is taken only from the coordinator this worker registered with: the sender's id and
      // the key its signature was checked against must be the identity the coordinator proved.
      if (!meshPeer!.isFromIdentity(msg, verifiedCoordinatorIdentity())) {
        console.warn(`[agent:${AGENT_ID}] mesh task_offer ignored: sender ${msg.fromPeerId} is not the verified coordinator`);
        return;
      }
      if (!p.subtaskId || !p.taskId || !p.input) return;
      if (meshTaskQueue.hasClaimed(p.subtaskId)) return;
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
      const queued = meshTaskQueue.push({
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
      if (!queued) {
        console.warn(`[agent:${AGENT_ID}] mesh task_offer ignored: queue full (${meshTaskQueue.length})`);
        return;
      }
      // Broadcast claim
      await meshPeer!.broadcast("task_claim", {
        subtaskId: p.subtaskId,
        claimedByCoordinator: AGENT_ID,
      });
      console.log(`[agent:${AGENT_ID}] mesh task_offer queued: ${p.subtaskId}`);
    });

    // Handle task_claim: remove tasks claimed by other peers
    meshPeer.on("task_claim", async (msg: MeshMessage) => {
      const p = msg.payload as { subtaskId?: string; claimedByCoordinator?: string };
      // Only peers the coordinator told us about can cancel queued work.
      if (!meshPeer!.getPeer(msg.fromPeerId)?.trusted) return;
      if (typeof p.subtaskId === "string" && p.claimedByCoordinator !== AGENT_ID) {
        if (meshTaskQueue.remove(p.subtaskId)) {
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
    if (!meshPeer || meshUplinkStarted || !coordinator.isVerified()) return;
    meshUplinkStarted = true;
    const peer = meshPeer;
    peer.config.bootstrapUrls = [coordinator.url];
    void peer
      .bootstrap()
      .then(() => console.log(`[agent:${AGENT_ID}] mesh peer bootstrapped, ${peer.peerCount()} peers known`))
      .catch((e) => console.warn(`[agent:${AGENT_ID}] mesh bootstrap failed (non-fatal): ${String(e)}`));
    connectMeshWebSocket(() => meshPeer);
  }
  /**
   * After a successful /register: start the mesh uplink. A coordinators' mesh token in the response
   * (coordinators before this change sent one) is ignored: agents authenticate with their own key,
   * and a shared token held by every install is no credential (docs/security/agent-threat-model.md).
   */
  function adoptMeshToken(token: unknown): void {
    if (typeof token === "string" && token.length > 0 && token !== meshAuthToken) {
      console.log(`[agent:${AGENT_ID}] ignoring a mesh token in the register response (agents sign their requests)`);
    }
    startMeshUplink();
  }
  /** #63: the reward account the coordinator resolves for this agent (both BLE tx sides sign it). */
  let rewardAccountId = AGENT_ID;
  function adoptRewardAccount(accountId: unknown): void {
    if (typeof accountId === "string" && accountId.length > 0 && !accountId.includes("\n")) {
      rewardAccountId = accountId;
      // An owner account (acct-...), not the agent-id fallback: the phone's account for code snapshots.
      const owner = accountId.startsWith("acct-") ? accountId : null;
      if (owner !== codeRelayAccount) {
        codeRelayAccount = owner;
        codeRelay?.invalidate();
      }
      bleMesh?.setAccountId(accountId);
    }
  }
  const bleGuard = new BleRequestGuard();
  // EDGECODER_BLE=0: the user turned BLE peer discovery off in the app.
  if (OS === "macos" && !W.EDGECODER_BLE) console.log(`[agent:${AGENT_ID}] BLE mesh off (turned off in settings)`);
  if (OS === "macos" && W.EDGECODER_BLE) {
    try {
      bleTransport = new NobleBLETransport(AGENT_ID);
      await bleTransport.init();
      bleMesh = new BLEMeshManager(AGENT_ID, rewardAccountId, bleTransport, localStore, { privateKeyPem: keys.privateKeyPem });
      // #63: provider side of the co-sign step for tasks this agent serves over BLE.
      const transportForCosign = bleTransport;
      const bleCosigner = new BleCosignProvider({
        agentId: AGENT_ID,
        accountId: () => rewardAccountId,
        privateKeyPem: keys.privateKeyPem,
        modelParamSize: () => transportForCosign.currentAdvertisement()?.modelParamSize ?? 0,
      });
      bleTransport.onCosignRequest((req) => bleCosigner.handle(req));
      bleMesh.setOwnTokenHash(computeMeshTokenHash());
      bleTransport.startAdvertising({
        agentId: AGENT_ID,
        model: OLLAMA_MODEL,
        modelParamSize: paramSizeBillions(OLLAMA_MODEL),
        memoryMB: Math.round(totalmem() / 1_000_000),
        batteryPct: 100,
        currentLoad: 0,
        deviceType: "laptop",
        meshTokenHash: computeMeshTokenHash(),
      });
      bleTransport.startScanning();

      // Register handler for incoming BLE task requests (from iOS peers)
      bleTransport.onTaskRequest(async (req) => {
        // Admission: no mesh token here means no remote BLE work at all; otherwise the request must
        // carry a proof keyed with the mesh token (the advertised hash is public, not a
        // credential), within size and rate limits. See src/mesh/ble/ble-request-guard.ts.
        const proof = req as typeof req & { requesterProof?: unknown; requesterIssuedAtMs?: unknown };
        const admission = bleGuard.admit({
          ownMeshToken: meshAuthToken,
          requestId: String(req.requestId ?? ""),
          requesterId: String(req.requesterId ?? ""),
          task: req.task,
          requesterProof: proof.requesterProof,
          requesterIssuedAtMs: proof.requesterIssuedAtMs
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
          // #63: credits are settled by the co-sign step that follows; remember what we served.
          bleCosigner.recordServed(req.requestId, String(req.requesterId ?? ""), taskHash, durationMs);
          return {
            requestId: req.requestId,
            providerId: AGENT_ID,
            providerAccountId: rewardAccountId,
            status: "completed" as const,
            output: response.text,
            cpuSeconds: durationMs / 1000,
            providerSignature: "",
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
            providerSignature: "",
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

  /**
   * The /register body, for the regular registration and the reconnect probe alike. The probe once
   * sent a short body without the hardware profile, so a coordinator that had restarted classified
   * the agent as cpu.std (and reset its proven GPU / Apple tier) until the next full registration.
   */
  const buildRegisterBody = async (powerTelemetry: ReturnType<typeof readAgentPowerTelemetry>): Promise<Record<string, unknown>> => {
    if (currentProvider === "ollama-local") installedModelsCache = undefined; // register reads them fresh
    // Only the models this host serves on the network (they fit its memory budget; memory-manager.ts).
    const installed = currentProvider === "ollama-local" ? await installedModelsCached() : [];
    const installedModels = currentProvider === "ollama-local" ? hostMemory.advertised(installed) : [];
    const memoryActive = hostMemory.activeModel();
    return {
      ...(installedModels.length ? { installedModels, activeModel: memoryActive && installedModels.includes(memoryActive) ? memoryActive : installedModels.includes(OLLAMA_MODEL) ? OLLAMA_MODEL : installedModels[0] } : {}),
      // Installed but not served on the network: only this machine's owner's own calls run them.
      ...(currentProvider === "ollama-local" && MANAGES_OLLAMA_MEMORY ? { ownerModels: hostMemory.ownerOnlyModels(installed) } : {}),
      ...(hostMemory.telemetry() ? { memory: hostMemory.telemetry() } : {}),
      agentId: AGENT_ID,
      ...(AGENT_DEVICE_ID ? { deviceId: AGENT_DEVICE_ID } : {}),
      os: OS,
      version: appVersion(),
      mode: effectiveMode,
      registrationToken: AGENT_REGISTRATION_TOKEN,
      localModelProvider: currentProvider,
      ...(OPENAI_ENGINE ? { inferenceEngine: OPENAI_ENGINE.preset, ...(engineStatus?.ok && engineStatus.model ? { engineModel: engineStatus.model.id.slice(0, 200) } : {}) } : {}),
      clientType: AGENT_CLIENT_TYPE,
      ...(AGENT_REGION ? { region: AGENT_REGION } : {}),
      // Private addresses, for the owner's own LAN proximity view only (src/swarm/lan-proximity.ts).
      ...(W.AGENT_LAN_HINTS ? (() => { const lan = localLanAddresses(); return lan.length ? { lanAddresses: lan } : {}; })() : {}),
      maxConcurrentTasks: MAX_CONCURRENT_TASKS,
      sandboxMode: SANDBOX_MODE,
      powerTelemetry,
      publicKeyPem: keys.publicKeyPem,
      x25519PublicKey: envelopeKeys.publicKey.toString("base64"),
      hardwareProfile: claimedHardwareProfile(),
      ...(BENCHMARK_ENABLED ? { challengeKinds: currentProvider === "ollama-local" ? ["cpu", "gpu"] : ["cpu"] } : {}),
      ...(lastBenchmark ? { benchmark: lastBenchmark } : {}),
      ...(ASK_MSAT_PER_CREDIT !== undefined ? { askMsatPerCredit: ASK_MSAT_PER_CREDIT } : {}),
      ...(binaryIntegrity ? { binaryIntegrity } : {})
    };
  };

  let bleTaskTestDone = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const powerTelemetry = readAgentPowerTelemetry();

      if (coordinatorOnline) {
        // ═══ ONLINE PATH: all coordinator HTTP calls ═══
        // A planned drain: move to a peer, probe the home, come back (drain-failover.ts).
        if (drainFailover.active()) await stepDrainFailover();
        // The coordinator said it is restarting: register again only once its delay is up
        // (while a drain failover is about to move us, only briefly).
        const reconnectHoldMs = coordinatorReconnect.holdMs();
        if (reconnectHoldMs > 0) {
          await idleWait(drainFailover.state === "leaving" ? Math.min(reconnectHoldMs, 250) : reconnectHoldMs);
          continue;
        }
        // A work_available nudge (fast dispatch) shortly after a full pass goes straight to the pull:
        // registration, heartbeat, tunnels and the rest ran a moment ago, and run again on the next pass.
        const quickPull = wokenByNudge && Date.now() - lastHousekeepingAtMs < QUICK_PULL_WINDOW_MS && registeredWithUrl === coordinator.url && coordinator.isVerified();
        wokenByNudge = false;
        let hb: HeartbeatReply = {};
        let blacklistSet = new Set<string>();
        if (quickPull) {
          await verifyCoordinatorOrThrow();
        } else {
          lastHousekeepingAtMs = Date.now();
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
          // Self-benchmark when due (right after the first registration, then every BENCHMARK_INTERVAL_MS),
          // before this tick pulls work. Never before registering: a slow run kept a started machine off the network.
          if (selfBenchmarkDue({ enabled: BENCHMARK_ENABLED, registered: registeredWithUrl !== null, nowMs: Date.now(), dueAtMs: benchmarkDueAtMs })) {
            benchmarkDueAtMs = Date.now() + BENCHMARK_INTERVAL_MS;
            try {
              const served = OPENAI_ENGINE && engineStatus?.ok ? engineStatus.model : undefined;
              lastBenchmark = await runLocalBenchmark(
                OPENAI_ENGINE
                  ? { engine: served ? { engine: OPENAI_ENGINE, model: served.id, tag: served.tag } : undefined }
                  : { ollama: currentProvider === "ollama-local" ? { host: OLLAMA_HOST, model: OLLAMA_MODEL, numCtx: CONTEXT_WINDOW } : undefined }
              );
              benchmarkUnreported = true;
              console.log(`[agent:${AGENT_ID}] benchmark: cpu=${lastBenchmark.cpu?.workUnitsPerSec ?? "-"} units/s gpu=${lastBenchmark.gpu ? `${lastBenchmark.gpu.tokensPerSec} tok/s (${lastBenchmark.gpu.bandwidthGbps ?? "?"} GB/s)` : "-"} in ${lastBenchmark.durationMs} ms${lastBenchmark.errors?.length ? ` (${lastBenchmark.errors.join("; ")})` : ""}`);
            } catch (e) {
              console.warn(`[agent:${AGENT_ID}] benchmark failed: ${e}`);
            }
          }
          // A Vulkan-only GPU: re-check the evidence; a changed claim re-registers now.
          if (GPU_NEEDS_OFFLOAD_PROOF && HARDWARE_PROFILE.gpu && Date.now() - gpuClaimCheckedAtMs >= 60_000) {
            gpuClaimCheckedAtMs = Date.now();
            const loaded = currentProvider === "ollama-local" && !OPENAI_ENGINE ? await ollamaAdmin.loaded().catch(() => undefined) : undefined;
            const next = decideGpuClaim({ needsProof: true, loaded, model: OLLAMA_MODEL, benchmarkBandwidthGbps: lastBenchmark?.gpu?.bandwidthGbps, previous: gpuClaim.claimGpu });
            if (next.claimGpu !== gpuClaim.claimGpu || next.evidence !== gpuClaim.evidence) {
              console.log(`[agent:${AGENT_ID}] GPU claim: ${next.claimGpu ? "GPU" : "CPU"} class (${next.detail})`);
              if (next.claimGpu !== gpuClaim.claimGpu) lastRegisteredAtMs = 0;
            }
            gpuClaim = next;
            // Ollama runs the model on the card: size the context window from its VRAM from now on.
            if (next.claimGpu && next.evidence === "offload" && !gpuSizingConfirmed) {
              gpuSizingConfirmed = true;
              resizeServing("GPU in use");
            }
          }
          if (CLOUD_HOST) {
            // A key the provider refuses: check it now and then. Paused or resumed: tell the
            // coordinator what is served now (a paused host advertises nothing).
            await CLOUD_HOST.maybeProbeKey();
            if (CLOUD_HOST.advertisedChanged()) {
              installedModelsCache = undefined;
              lastRegisteredAtMs = 0;
            }
          }
          if (shouldRegister({ registeredWithUrl, lastRegisteredAtMs }, coordinator.url, Date.now(), REGISTER_REFRESH_MS)) {
            const registerBody = await buildRegisterBody(powerTelemetry);
            // During a coordinator restart: no retries inside post() and a short timeout, so the loop's
            // ~1-2 s restart retry decides the pace rather than a connection held by the proxy.
            const registerResponse = (await post("/register", registerBody, {
              signed: true,
              ...(restartWindow.active() ? { retries: 0, timeoutMs: RESTART_REQUEST_TIMEOUT_MS } : {})
            })) as RegisterReply & {
              meshToken?: string;
              rewardAccountId?: string;
              updateAvailable?: string;
            };
            const freshRegistration = registeredWithUrl !== coordinator.url;
            registeredWithUrl = coordinator.url;
            lastRegisteredAtMs = Date.now();
            coordinatorReconnect.registered();
            if (restartWindow.active()) console.log(`[agent:${AGENT_ID}] registered again after the coordinator restart`);
            restartWindow.close();
            if (drainFailover.state === "homing") {
              drainFailover.registered(coordinator.url);
              console.log(`[agent:${AGENT_ID}] back with ${coordinator.url} after its restart`);
              // Results owed to it that could not be delivered while it restarted.
              void flushPendingResults().catch(() => undefined);
            }
            noteRegistered(freshRegistration);
            console.log(registeredLogLine(AGENT_ID, coordinator.url, registerResponse));
            updateDrain?.write();
            updateNudge?.onHint(registerResponse?.updateAvailable);
            enrollmentRefusals = 0;
            lastEnrollmentLog = null;
            servingJobs.setGrant(registerResponse?.hardwareVerification?.grantedClass, registerResponse?.hardwareVerification?.grantedTier);
            lifecycle.noteAccepted();
            adoptMeshToken(registerResponse.meshToken);
            adoptRewardAccount(registerResponse.rewardAccountId);
          }

          const hbStart = Date.now();
          // #54: the installed-model list rides every heartbeat (cached), so a pulled or removed model is routed correctly.
          const hbInstalled = currentProvider === "ollama-local" ? await installedModelsCached() : [];
          const hbModels = currentProvider === "ollama-local" ? hostMemory.advertised(hbInstalled) : [];
          // Installed but not served on the network: the owner's own calls only (sent every time, so a change clears).
          const hbOwnerModels = currentProvider === "ollama-local" && MANAGES_OLLAMA_MEMORY ? hostMemory.ownerOnlyModels(hbInstalled) : undefined;
          // The model already in memory, so the coordinator sends calls for it here first (affinity).
          const hbActive = currentProvider === "ollama-local" ? hostMemory.activeModel() : undefined;
          const hbMemory = hostMemory.telemetry();
          const hbLocalWeb = await localWeb.capability().catch(() => undefined);
          const hbBody = { agentId: AGENT_ID, ...(hbLocalWeb ? { localWeb: hbLocalWeb } : {}), powerTelemetry, sandboxMode: SANDBOX_MODE, ...(hbModels.length || CLOUD_MODE ? { installedModels: hbModels } : {}), ...(hbOwnerModels ? { ownerModels: hbOwnerModels } : {}), ...(hbActive && hbModels.includes(hbActive) ? { activeModel: hbActive, activeModelParamSize: paramsB(hbActive) } : {}), ...(hbMemory ? { memory: hbMemory } : {}), ...(benchmarkUnreported && lastBenchmark ? { benchmark: lastBenchmark } : {}) };
          hb = (await post("/heartbeat", hbBody, { signed: true })) as HeartbeatReply;
          updateNudge?.onHint(hb?.updateAvailable);
          if ("benchmark" in hbBody) benchmarkUnreported = false;
          try { localStore.recordHeartbeat(coordinator.url, hb.blacklisted ? "blacklisted" : "ok", Date.now() - hbStart); } catch (e) { console.warn(`[db] heartbeat write failed: ${e}`); }

          // Heartbeat succeeded — reset failure counter and cache proven URL
          consecutiveFailures = 0;
          cacheCoordinatorUrl(coordinator.url);

          if (hb.blacklisted) {
            lifecycle.notePaused(hb.reason ?? "policy_violation");
            console.error(`[agent:${AGENT_ID}] blacklisted by coordinator: ${hb.reason ?? "policy_violation"}`);
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
          // Coordinator benchmark challenge: answer now, before pulling work (its clock is running).
          if (hb.benchmarkChallenge && challengeAcceptable(hb.benchmarkChallenge)) {
            const answer = await answerChallenge(hb.benchmarkChallenge, { ollamaHost: OLLAMA_HOST, numCtx: CONTEXT_WINDOW, ...(OPENAI_ENGINE ? { engine: { engine: OPENAI_ENGINE, servedModelFor: servedEngineModel } } : {}) });
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
          lifecycle.noteAccepted();
          blacklistSet = new Set(hb.blacklist?.agents ?? []);
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

          if (meshWsOpen && Date.now() - lastModelStateReportMs >= MODEL_STATE_REPORT_MS) void reportModelState();
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
              // vLLM / MLX serve the model they were started with: only "keep the current one" can be done here.
              if (CLOUD_MODE) throw new Error("orchestration_engine_managed: a cloud host serves its configured cloud models; change CLOUD_HOST_MODELS on the host");
              if (OPENAI_ENGINE && (switchModel !== OLLAMA_MODEL || hb.orchestration.provider !== "ollama-local")) throw new Error(`orchestration_engine_managed: ${ENGINE_LABEL} serves ${OLLAMA_MODEL}; change its model on the host`);
              // A coordinator may only name Ollama library models, and never installs the binary.
              if (!isOllamaLibraryModelName(switchModel)) throw new Error("orchestration_model_rejected");
              // The same host policy as the owner's commands: AGENT_REMOTE_CONTROL and the allowlist.
              const refusal = hb.orchestration.provider === "ollama-local" ? modelControl.orchestrationRefusal(switchModel) : null;
              if (refusal) throw new Error(`orchestration_${refusal}`);
              await ensureOllamaModelInstalled(
                {
                  enabled: hb.orchestration.provider === "ollama-local" && !OPENAI_ENGINE,
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
              if (hb.orchestration.provider === "ollama-local") await warmNetworkModel(switchModel, "model switch");
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
        }

        // Our model slots (the coordinator hands a call only to an agent with one free) and that we take nudges.
        // A vLLM / MLX engine that is down or serves no catalog model: no free slot (no model call is handed to us).
        // Low on memory (or nothing fits the budget): no free slot, and no pull below.
        const memoryOk = hostMemory.canPull();
        // A throttled CPU (cpu-steal.ts): no free slot, but the pull still goes out to say so.
        const slotReport = modelSlotReport({ slots: MAX_PARALLEL_INFERENCE, inflight: inflightInference.size, available: engineReady() && memoryOk, cpuThrottled: cpuThrottledNow() });
        const freeInferenceSlots = slotReport.free;
        // AGENT_ALLOW_RESTRICTED_MODELS: the owner lets this machine take restricted-model calls (security
        // research tier; the coordinator also needs the owner's admin-approved host entitlement).
        // Run 7: with its CPU steal (coordinator host-steal.ts).
        // Coming home after a drain failover, the peer's calls still running: report no free slot (drain-failover.ts).
        const drainReturnHold = drainFailover.holdingForPeerCalls(claimsInFlightFor(drainFailover.away));
        const pullBody = { agentId: AGENT_ID, inferenceSlots: MAX_PARALLEL_INFERENCE, freeInferenceSlots: drainReturnHold ? 0 : freeInferenceSlots, contextWindow: CONTEXT_WINDOW, wake: true, ...(W.AGENT_ALLOW_RESTRICTED_MODELS ? { allowRestrictedModels: true } : {}), ...(cpuSteal ? cpuSteal.report() : {}) };
        if (!PULLS_FROM_COORDINATOR && !warnedNoSandbox) {
          warnedNoSandbox = true;
          console.warn(`[agent:${AGENT_ID}] SANDBOX_MODE=none: not pulling swarm tasks (install Docker and set SANDBOX_MODE=docker to contribute compute, or AGENT_INFERENCE_ONLY=1 to serve inference only)`);
        } else if (INFERENCE_ONLY && !warnedNoSandbox) {
          warnedNoSandbox = true;
          console.log(`[agent:${AGENT_ID}] inference-only: pulling inference subtasks only (no sandbox, no task code is run)`);
        }
        // Inference-only with every slot busy: nothing we could take; a finishing call wakes the loop.
        // (A throttled CPU with idle slots still pulls, to report that it has no free slot.)
        // Draining (a restart or quit is coming) or stopping: take nothing new (BHV006).
        // The coordinator a claim from this pull belongs to (URL and proven key): its lease renewals,
        // chunks and result go there even if the agent moves for a drain meanwhile (drain-failover.ts).
        let pullIssuer: CoordinatorTarget | null = null;
        try {
          pullIssuer = coordinator.requireVerifiedIdentity();
        } catch {
          pullIssuer = null;
        }
        const pulled = (PULLS_FROM_COORDINATOR && !sandboxDown && lifecycle.canPull() && memoryOk && !shuttingDown && !(INFERENCE_ONLY && freeInferenceSlots === 0 && !slotReport.reportAnyway && !drainReturnHold)
          ? await post("/pull", pullBody, { signed: true })
          : { subtask: null }) as {
          subtask: Subtask | null;
          envelope?: TaskEnvelope;
          draining?: boolean;
          coordinatorUrl?: string;
        };
        // "No work, draining": a planned restart; serve through a peer meanwhile.
        if (pulled.draining === true && !pulled.subtask && pullIssuer) onPlannedDrain("pull_draining", pullIssuer.url, typeof pulled.coordinatorUrl === "string" ? pulled.coordinatorUrl : null);

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
                // The owner's own call ("My machines"): newer coordinators say so in the envelope.
                ...(typeof pulled.envelope.metadata.onlyAccountId === "string" ? { onlyAccountId: pulled.envelope.metadata.onlyAccountId } : {}),
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
          const issuer = pullIssuer ? noteClaimIssuer(pullIssuer) : null;
          // A model call's timeout counts from here, as the coordinator's claim lease does (inference-runner.ts).
          const claimedAtMs = Date.now();

          // Inference-only: never run task code, whatever the coordinator sent.
          const inferenceOnlyRefusal = inferenceOnlyRejection(INFERENCE_ONLY, st);
          if (inferenceOnlyRefusal) {
            console.error(`[agent:${AGENT_ID}] refused subtask ${st.id}: ${inferenceOnlyRefusal}`);
            try {
              await post("/result", {
                subtaskId: st.id, taskId: st.taskId, agentId: AGENT_ID,
                ok: false, output: "", error: inferenceOnlyRefusal, durationMs: 0, executed: false,
              }, { signed: true });
            } catch { /* best effort */ }
            continue;
          }

          // ── Frozen snapshot enforcement (Design Decision #8; same check for every source) ──
          const snapshotPolicy = checkSnapshotPolicy(st, SNAPSHOT_ENFORCEMENT);
          if (!snapshotPolicy.run) {
            console.error(`[agent:${AGENT_ID}] snapshot enforcement: ${snapshotPolicy.error}`);
            try {
              // Sign exactly the body that is posted (the signature covers the body hash).
              const snapshotRejection = {
                subtaskId: st.id, taskId: st.taskId, agentId: AGENT_ID,
                ok: false, output: "", error: "snapshot_invalid: frozen snapshot enforcement rejected this subtask",
                durationMs: 0, executed: false,
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
          const runAndReportClaim = async () => {
            try { localStore.recordTaskStart(st.id, st.taskId, st.input, st.language, currentProvider, coordinator.url); } catch (e) { console.warn(`[db] task start write failed: ${e}`); }
            // #51: keep the coordinator's claim lease alive while the subtask runs.
            const stopLeaseHeartbeat = startLeaseHeartbeat(issuer);
            // Host memory: the model must fit this host's budget next to what is loaded (idle network
            // models are unloaded first); otherwise the call is handed back with a memory_ error and
            // the coordinator gives it to another agent (memory-manager.ts).
            // The owner's own call ("My machines", for this agent's own account) may also run a model this
            // host keeps off the network (too big for its budget): no budget refusal, pressure still applies.
            const ownCall = isOwnAccountCall(st.projectMeta?.onlyAccountId, rewardAccountId);
            const admission = st.kind === "inference" && MANAGES_OLLAMA_MEMORY && st.requestedModel ? await hostMemory.admit(st.requestedModel, { own: ownCall }) : undefined;
            const callAbort = new AbortController();
            networkCallAborts.add(callAbort);
            // Active work: the job while it runs (not one handed back for memory).
            const serving = admission && !admission.ok ? undefined : servingJobs.start(st);
            const run = admission && !admission.ok
              ? Promise.resolve<SubtaskResult>({ subtaskId: st.id, taskId: st.taskId, agentId: AGENT_ID, ok: false, output: "", error: admission.error, durationMs: 0, executed: false })
              : st.kind === "inference"
              ? runInferenceSubtask(st, { agentId: AGENT_ID, claimedAtMs, ollamaHost: OLLAMA_HOST ?? "http://127.0.0.1:11434", keepAlive: keepAliveFor(st.requestedModel), contextWindow: CONTEXT_WINDOW, signal: callAbort.signal, onDelta: serving?.delta, post: (path, body) => post(path, body, { retries: 0, timeoutMs: 10_000, signed: true, to: issuer }), ...(cpuSteal ? { cpuSteal: cpuStealReport } : {}), ...(OPENAI_ENGINE ? { chat: engineChat } : CLOUD_HOST ? { chat: (m, r, s, t) => CLOUD_HOST.chat(m, r, s, t) } : {}) })
              : runPolicedSubtask(st, { quiet: true });
            if (admission && !admission.ok) console.warn(`[agent:${AGENT_ID}] handed back inference ${st.id} on ${st.requestedModel}: ${admission.error}`);
            else if (st.kind === "inference") console.log(`[agent:${AGENT_ID}] running inference ${st.id} on ${st.requestedModel}`);
            const result = await run.finally(() => {
              serving?.end();
              stopLeaseHeartbeat();
              networkCallAborts.delete(callAbort);
              if (admission?.ok) admission.release();
            });
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
              // To the coordinator that issued the claim (it holds the lease and the billing).
              await post("/result", resultPayload, { signed: true, to: issuer });
            } catch (resultErr) {
              // The claim lapsed before the result arrived: the coordinator will refuse it every time.
              if (isPermanentResultRefusal(resultErr)) {
                console.warn(`[agent:${AGENT_ID}] result for ${result.subtaskId} refused (lease_expired: the claim lapsed); not buffered`);
                return;
              }
              try { localStore.enqueuePendingResult(result.subtaskId, encodePendingResult(resultPayload, issuer?.url)); } catch (e) { console.warn(`[db] pending result write failed: ${e}`); }
              console.warn(`[agent:${AGENT_ID}] result buffered for retry: ${result.subtaskId}`);
            }
          };
          // Counted per issuing coordinator while it runs (a drain failover's return waits for the peer's).
          const runAndReport = async () => {
            const key = issuer?.url;
            if (key) claimsInFlight.set(key, (claimsInFlight.get(key) ?? 0) + 1);
            try {
              await runAndReportClaim();
            } finally {
              if (key) {
                const left = (claimsInFlight.get(key) ?? 1) - 1;
                if (left > 0) claimsInFlight.set(key, left);
                else claimsInFlight.delete(key);
              }
            }
          };
          // Model calls run side by side (Ollama, vLLM and MLX serve several at once); code jobs one at a time.
          if (st.kind === "inference" && MAX_PARALLEL_INFERENCE > 1) {
            while (inflightInference.size >= MAX_PARALLEL_INFERENCE) await Promise.race(inflightInference);
            const job: Promise<void> = runAndReport()
              .catch((e) => console.warn(`[agent:${AGENT_ID}] inference ${st.id} failed: ${String(e)}`))
              .finally(() => {
                inflightInference.delete(job);
                // A slot is free: pull again now rather than at the next poll.
                wakeLoop(false);
              });
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
          // Direct work is unpaid: only from agents of this agent's own account (src/swarm/direct-work-policy.ts).
          // Everything else is refused here too, whatever the coordinator relayed, and logged once.
          const offer = incomingDirect.find((item) => {
            const decision = workerAcceptsDirectWorkOffer(item, rewardAccountId, (id) => blacklistSet.has(id));
            if (!decision.ok && decision.reason !== "sender_blacklisted" && !refusedDirectOffers.has(item.offerId)) {
              refusedDirectOffers.add(item.offerId);
              if (refusedDirectOffers.size > 256) refusedDirectOffers.delete(refusedDirectOffers.values().next().value!);
              console.warn(`[agent:${AGENT_ID}] direct-work offer ${item.offerId} from ${item.fromAgentId} refused (${decision.reason}): ${DIRECT_WORK_MARKET_HINT}`);
            }
            return decision.ok;
          });
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
              } else if (offerRes.statusCode === 403) {
                // Another account's agent (or no verified account): direct work is same-account only.
                // Back off for an hour; work for other accounts goes through the market.
                lastOfferAtByPeer.set(peerId, now + 60 * 60_000);
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
            const registerBody = await buildRegisterBody(powerTelemetry);
            // Keep the mesh token from this register too: an agent that went offline before its first
            // registration has none, and without it every heartbeat is refused (mesh_unauthorized).
            const probeRegister = (await post("/register", registerBody, { retries: 0, timeoutMs: 5000, signed: true })) as RegisterReply & { meshToken?: string; rewardAccountId?: string };
            console.log(registeredLogLine(AGENT_ID, coordinator.url, probeRegister));
            adoptMeshToken(probeRegister.meshToken);
            adoptRewardAccount(probeRegister.rewardAccountId);
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
            coordinatorReconnect.registered();
            restartWindow.close();
            noteRegistered(true);
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
              // Admission proof keyed with the mesh token (providers no longer accept the public hash).
              ...bleRequestProof(meshAuthToken, { requestId: task.id, requesterId: AGENT_ID, task: task.prompt }),
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
      if (bleTransport && (!coordinatorOnline || W.BLE_TEST_ENABLED)) {
        const blePeers = bleTransport.discoveredPeers();
        if (blePeers.length > 0) {
          try { for (const p of blePeers) { localStore.upsertBLEPeer(p.agentId, p.model, p.modelParamSize, p.deviceType, p.rssi); } } catch (e) { console.warn(`[db] BLE peer write failed: ${e}`); }
          console.log(`[agent:${AGENT_ID}] BLE peers (offline): ${blePeers.map(p => `${p.agentId}(rssi:${p.rssi})`).join(", ")}`);

          if (!bleTaskTestDone && W.BLE_TEST_ENABLED) {
            bleTaskTestDone = true;
            const peer = blePeers[0];
            console.log(`[BLE-TEST] will send test task to ${peer.agentId} in 5s...`);
            setTimeout(async () => {
              try {
                console.log(`[BLE-TEST] sending test task to ${peer.agentId} over BLE...`);
                const testTask = "Write a Python function called is_palindrome(s) that checks if a string is a palindrome, ignoring case and non-alphanumeric characters. Include a docstring.";
                const testRequestId = `ble-test-${Date.now()}`;
                const testReq = {
                  requestId: testRequestId,
                  requesterId: AGENT_ID,
                  task: testTask,
                  language: "python" as const,
                  requesterSignature: signPayload(JSON.stringify({ requesterId: AGENT_ID, taskHash: computeTaskHash(testTask) }), keys.privateKeyPem),
                  ...bleRequestProof(meshAuthToken, { requestId: testRequestId, requesterId: AGENT_ID, task: testTask }),
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
        ? (OS === "ios" && !allowPeerDirectWork(powerTelemetry) ? 2500 : meshWsOpen ? IDLE_POLL_WITH_NUDGES_MS : IDLE_POLL_MS)
        : 5000;
      await idleWait(idleDelayMs);
    } catch (error) {
      // 429: the coordinator is fine and knows us; we are only sending too fast. Back off for its
      // Retry-After without counting a failure: failures lead to offline mode and re-registering,
      // and registering on every refusal is what trips the registration-storm rule (BHV008).
      const rateLimitWait = rateLimitWaitMs(error);
      if (rateLimitWait !== null) {
        console.warn(`[agent:${AGENT_ID}] coordinator rate limit hit; backing off ${rateLimitWait}ms`);
        await new Promise((r) => setTimeout(r, rateLimitWait));
        continue;
      }
      // Not enrolled (or no / a wrong registration token): only the owner can fix it, so say how
      // once, wait minutes rather than seconds, and keep the coordinator (it answered fine).
      const refusal = enrollmentRefusalFromError(error);
      if (refusal) {
        enrollmentRefusals++;
        registeredWithUrl = null;
        const wait = enrollmentBackoffMs(enrollmentRefusals);
        const now = Date.now();
        if (shouldLogEnrollmentRefusal(lastEnrollmentLog, refusal, now)) {
          console.error(enrollmentRefusalMessage(AGENT_ID, refusal, wait, portalLabel(PORTAL_URL)));
          lastEnrollmentLog = { key: enrollmentRefusalKey(refusal), atMs: now };
        }
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const blacklistReason = blacklistReasonFromError(error);
      if (blacklistReason) lifecycle.notePaused(blacklistReason);
      // The coordinator restarted (or evicted us) and holds no key for us: register again on the very
      // next tick, without counting a failure, so a restart costs seconds rather than an offline cycle.
      // At most once per QUICK_REREGISTER_MIN_INTERVAL_MS (registration storms); beyond that, as before.
      if (coordinatorOnline && isAgentNotRegisteredError(error) && quickReregister.tryTake()) {
        registeredWithUrl = null;
        console.warn(`[agent:${AGENT_ID}] coordinator does not know this agent (restarted?): registering again now`);
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      // A coordinator restart (src/mesh/coordinator-reconnect.ts CoordinatorRestartWindow): the new
      // instance is usually up within seconds, so retry every ~1-2 s without counting toward offline
      // mode. Only once it has had RESTART_FAILOVER_AFTER_MS does the agent look for another coordinator.
      // Coming home after a drain failover, the restarted instance was not ready after all: back to
      // the peer, which still has us registered, and probe again.
      if (coordinatorOnline && drainFailover.state === "homing" && isRestartTransientError(error)) {
        const peer = drainFailover.homeNotReady();
        if (peer && coordinator.set(peer, "drain_return_not_ready")) {
          registeredWithUrl = null;
          console.warn(`[agent:${AGENT_ID}] ${drainFailover.home} not ready yet (${String(error).slice(0, 120)}); serving through ${peer} meanwhile`);
          continue;
        }
      }
      if (coordinatorOnline && isDrainingError(error)) onPlannedDrain("register_draining", coordinator.url);
      if (coordinatorOnline && restartWindow.active() && isRestartTransientError(error)) {
        registeredWithUrl = null;
        // A planned drain moves through drain-failover.ts (and comes home); an unexplained loss waits
        // RESTART_FAILOVER_AFTER_MS first, so a blip does not bounce the agent.
        if (!drainFailover.active() && restartWindow.mayFailOver()) {
          const failover = await resolveCoordinatorUrl();
          if (coordinator.set(failover.url, `failover:${failover.source}`)) {
            console.warn(`[agent:${AGENT_ID}] coordinator still restarting; failover (${failover.source}): ${coordinator.url}`);
          }
        }
        const wait = restartWindow.retryMs();
        console.log(`[agent:${AGENT_ID}] coordinator restarting (${String(error).slice(0, 120)}); trying again in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
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
