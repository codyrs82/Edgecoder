import { request } from "undici";
import { randomUUID } from "node:crypto";
import { totalmem } from "node:os";
import { ProviderRegistry } from "../model/providers.js";
import { SwarmWorkerAgent } from "../agent/worker.js";
import { Subtask, BLETaskRequest, Language } from "../common/types.js";
import { createPeerKeys, signPayload } from "../mesh/peer.js";
import { ensureOllamaModelInstalled } from "../model/ollama-installer.js";
import { NobleBLETransport } from "../mesh/ble/noble-ble-transport.js";
import { BLEMeshManager } from "../mesh/ble/ble-mesh-manager.js";
import { localStore } from "../db/local-store.js";

const COORDINATOR_BOOTSTRAP_URL = process.env.COORDINATOR_URL ?? "http://127.0.0.1:4301";
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? "";
const COORDINATOR_DISCOVERY_URL =
  process.env.COORDINATOR_DISCOVERY_URL ??
  (CONTROL_PLANE_URL ? `${CONTROL_PLANE_URL.replace(/\/$/, "")}/network/coordinators` : "");
const AGENT_ID = process.env.AGENT_ID ?? "worker-1";
const MODE = (process.env.AGENT_MODE ?? "swarm-only") as "swarm-only" | "ide-enabled";
const OS = (process.env.AGENT_OS ?? "macos") as "debian" | "ubuntu" | "windows" | "macos" | "ios";
const PROVIDER = (process.env.LOCAL_MODEL_PROVIDER ?? "edgecoder-local") as
  | "edgecoder-local"
  | "ollama-local";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:latest";
const OLLAMA_HOST = process.env.OLLAMA_HOST;
const OLLAMA_AUTO_INSTALL = process.env.OLLAMA_AUTO_INSTALL === "true";
let meshAuthToken = process.env.MESH_AUTH_TOKEN ?? "";
const COORDINATOR_HTTP_TIMEOUT_MS = Number(process.env.COORDINATOR_HTTP_TIMEOUT_MS ?? "15000");
const COORDINATOR_POST_RETRIES = Number(process.env.COORDINATOR_POST_RETRIES ?? "2");
const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS ?? "1");
const AGENT_CLIENT_TYPE = process.env.AGENT_CLIENT_TYPE ?? "edgecoder-native";
const PEER_DIRECT_WORK_ITEMS = (process.env.PEER_DIRECT_WORK_ITEMS ??
  "help peer with lightweight test scaffolding||review edge case handling").split("||");
const AGENT_REGISTRATION_TOKEN = process.env.AGENT_REGISTRATION_TOKEN ?? "";
const AGENT_DEVICE_ID = (() => {
  const explicit = (process.env.AGENT_DEVICE_ID ?? process.env.IOS_DEVICE_ID ?? "").trim();
  if (explicit) return explicit;
  if (OS === "ios") return AGENT_ID.replace(/^ios-|^iphone-/i, "").trim();
  return "";
})();
const keys = createPeerKeys(AGENT_ID);
const peerTunnels = new Map<string, string>();
const peerOfferCooldownMs = Number(process.env.PEER_OFFER_COOLDOWN_MS ?? "20000");
const lastOfferAtByPeer = new Map<string, number>();
let peerWorkCursor = 0;
let activeCoordinatorUrl = COORDINATOR_BOOTSTRAP_URL;

// ── Offline resilience state ──────────────────────────────────
let consecutiveFailures = 0;
let coordinatorOnline = true;
const OFFLINE_THRESHOLD = 3;
const BACKOFF_BASE_MS = 1500;
const BACKOFF_MAX_MS = 30_000;
const RECONNECT_PROBE_INTERVAL_MS = 15_000;
let lastReconnectProbeMs = 0;

function backoffMs(): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.min(consecutiveFailures, 10), BACKOFF_MAX_MS);
}

type AgentPowerTelemetry = {
  onExternalPower?: boolean;
  batteryLevelPct?: number;
  lowPowerMode?: boolean;
  updatedAtMs?: number;
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

function readAgentPowerTelemetry(): AgentPowerTelemetry | undefined {
  if (OS !== "ios") return undefined;
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

function allowPeerDirectWork(telemetry: AgentPowerTelemetry | undefined): boolean {
  if (OS !== "ios") return true;
  if (!telemetry) return false;
  if (telemetry.lowPowerMode === true) return false;
  return telemetry.onExternalPower === true;
}

function meshHeaders(): Record<string, string> {
  if (!meshAuthToken) return {};
  return { "x-mesh-token": meshAuthToken };
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
  const cached = localStore.getConfig("coordinator_url");
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

async function post(
  path: string,
  body: unknown,
  options?: { retries?: number; timeoutMs?: number }
): Promise<any> {
  const retries = Math.max(0, options?.retries ?? COORDINATOR_POST_RETRIES);
  const timeoutMs = Math.max(1000, options?.timeoutMs ?? COORDINATOR_HTTP_TIMEOUT_MS);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await request(`${activeCoordinatorUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...meshHeaders() },
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        body: JSON.stringify(body)
      });
      const parsed = (await parseJsonBodySafe(res)) as unknown;
      const rawText = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const payloadText = rawText && rawText !== "{}" ? rawText : "<empty>";
        throw new Error(`POST ${path} failed (${res.statusCode}): ${payloadText}`);
      }
      return parsed;
    } catch (error) {
      lastError = error;
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
      await post("/result", JSON.parse(row.payload));
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
    await post("/credits/ble-sync", { transactions: unsynced });
    localStore.markBLECreditsSynced(unsynced.map(tx => tx.txId));
    console.log(`[agent:${AGENT_ID}] BLE credits synced`);
  } catch (e) {
    console.warn(`[agent:${AGENT_ID}] BLE credit flush failed (will retry): ${String(e)}`);
  }
}

async function loop(): Promise<void> {
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

  // Initialize BLE mesh transport for local peer discovery
  let bleMesh: BLEMeshManager | null = null;
  let bleTransport: NobleBLETransport | null = null;
  if (OS === "macos") {
    try {
      bleTransport = new NobleBLETransport(AGENT_ID);
      await bleTransport.init();
      bleMesh = new BLEMeshManager(AGENT_ID, AGENT_ID, bleTransport, localStore);
      bleTransport.startAdvertising({
        agentId: AGENT_ID,
        model: OLLAMA_MODEL,
        modelParamSize: 0,
        memoryMB: Math.round(totalmem() / 1_000_000),
        batteryPct: 100,
        currentLoad: 0,
        deviceType: "laptop",
      });
      bleTransport.startScanning();

      // Register handler for incoming BLE task requests (from iOS peers)
      bleTransport.onTaskRequest(async (req) => {
        console.log(`[BLE] processing incoming task: ${req.requestId}`);
        const subtaskId = `ble-${req.requestId}`;
        try { localStore.recordTaskStart(subtaskId, subtaskId, req.task, req.language ?? "python", "ble-incoming", "ble-mesh"); } catch (e) { console.warn(`[db] BLE task start write failed: ${e}`); }
        const started = Date.now();
        try {
          const response = await providers.current().generate({ prompt: req.task });
          const durationMs = Date.now() - started;
          try { localStore.recordTaskComplete(subtaskId, response.text, durationMs); } catch (e) { console.warn(`[db] BLE task complete write failed: ${e}`); }
          return {
            requestId: req.requestId,
            providerId: AGENT_ID,
            status: "completed" as const,
            output: response.text,
            cpuSeconds: durationMs / 1000,
            providerSignature: "",
          };
        } catch (e) {
          const durationMs = Date.now() - started;
          try { localStore.recordTaskFailed(subtaskId, String(e), durationMs); } catch (dbErr) { console.warn(`[db] BLE task fail write failed: ${dbErr}`); }
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

      console.log(`[agent:${AGENT_ID}] BLE mesh transport initialized`);
    } catch (e) {
      console.warn(`[agent:${AGENT_ID}] BLE mesh init failed (non-fatal): ${String(e)}`);
      bleTransport = null;
    }
  }
  let bleTaskTestDone = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const powerTelemetry = readAgentPowerTelemetry();

      if (coordinatorOnline) {
        // ═══ ONLINE PATH: all coordinator HTTP calls ═══
        const registerResponse = (await post("/register", {
          agentId: AGENT_ID,
          ...(AGENT_DEVICE_ID ? { deviceId: AGENT_DEVICE_ID } : {}),
          os: OS,
          version: "0.1.0",
          mode: effectiveMode,
          registrationToken: AGENT_REGISTRATION_TOKEN,
          localModelProvider: currentProvider,
          clientType: AGENT_CLIENT_TYPE,
          maxConcurrentTasks: MAX_CONCURRENT_TASKS,
          powerTelemetry
        })) as {
          accepted?: boolean;
          meshToken?: string;
        };
        if (typeof registerResponse.meshToken === "string" && registerResponse.meshToken.length > 0) {
          if (meshAuthToken !== registerResponse.meshToken) {
            meshAuthToken = registerResponse.meshToken;
            console.log(`[agent:${AGENT_ID}] mesh token provisioned from coordinator register response`);
          }
        }

        const hbStart = Date.now();
        const hb = (await post("/heartbeat", { agentId: AGENT_ID, powerTelemetry })) as {
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
        };
        try { localStore.recordHeartbeat(activeCoordinatorUrl, hb.blacklisted ? "blacklisted" : "ok", Date.now() - hbStart); } catch (e) { console.warn(`[db] heartbeat write failed: ${e}`); }

        // Heartbeat succeeded — reset failure counter
        consecutiveFailures = 0;

        if (hb.blacklisted) {
          console.error(`[agent:${AGENT_ID}] blacklisted by coordinator: ${hb.reason ?? "policy_violation"}`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
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

        const pulled = (await post("/pull", { agentId: AGENT_ID })) as {
          subtask: Subtask | null;
        };
        if (pulled.subtask) {
          const st = pulled.subtask;

          // ── BLE delegation: try routing to an idle BLE peer ──
          let delegated = false;
          if (bleMesh && bleTransport) {
            const blePeers = bleTransport.discoveredPeers();
            const idlePeer = blePeers.find(p => p.currentLoad === 0);
            if (idlePeer) {
              const bleReq: BLETaskRequest = {
                requestId: st.id,
                requesterId: AGENT_ID,
                task: st.input,
                language: st.language,
                requesterSignature: "",
              };
              try {
                const resp = await bleMesh.routeTask(bleReq, 0);
                if (resp && resp.status === "completed") {
                  delegated = true;
                  try { localStore.recordBLETaskResult(resp.providerId, true); } catch {}
                  try { localStore.recordTaskStart(st.id, st.taskId, st.input, st.language, `ble-delegate:${resp.providerId}`, activeCoordinatorUrl); } catch {}
                  try { localStore.recordTaskComplete(st.id, resp.output ?? "", Math.round(resp.cpuSeconds * 1000)); } catch {}
                  const delegatedResult = {
                    subtaskId: st.id,
                    taskId: st.taskId,
                    agentId: AGENT_ID,
                    ok: true,
                    output: resp.output ?? "",
                    durationMs: Math.round(resp.cpuSeconds * 1000),
                    reportNonce: randomUUID(),
                    reportSignature: "",
                  };
                  delegatedResult.reportSignature = signPayload(
                    JSON.stringify({
                      subtaskId: delegatedResult.subtaskId,
                      taskId: delegatedResult.taskId,
                      agentId: delegatedResult.agentId,
                      ok: delegatedResult.ok,
                      durationMs: delegatedResult.durationMs,
                      reportNonce: delegatedResult.reportNonce
                    }),
                    keys.privateKeyPem
                  );
                  try {
                    await post("/result", delegatedResult);
                  } catch (resultErr) {
                    try { localStore.enqueuePendingResult(st.id, JSON.stringify(delegatedResult)); } catch {}
                    console.warn(`[agent:${AGENT_ID}] delegated result buffered: ${st.id}`);
                  }
                  console.log(`[agent:${AGENT_ID}] task ${st.id} delegated to BLE peer ${resp.providerId}`);
                } else if (resp) {
                  try { localStore.recordBLETaskResult(resp.providerId, false); } catch {}
                }
              } catch (e) {
                console.warn(`[agent:${AGENT_ID}] BLE delegation failed, executing locally: ${String(e)}`);
              }
            }
          }

          if (!delegated) {
            // ── Local execution (existing path) ──
            try { localStore.recordTaskStart(st.id, st.taskId, st.input, st.language, currentProvider, activeCoordinatorUrl); } catch (e) { console.warn(`[db] task start write failed: ${e}`); }
            const result = await worker.runSubtask(st, AGENT_ID);
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
            try {
              await post("/result", result);
            } catch (resultErr) {
              try { localStore.enqueuePendingResult(result.subtaskId, JSON.stringify(result)); } catch (e) { console.warn(`[db] pending result write failed: ${e}`); }
              console.warn(`[agent:${AGENT_ID}] result buffered for retry: ${result.subtaskId}`);
            }
          }
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
              const result = await worker.runSubtask(peerSubtask, AGENT_ID);
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
            await post("/heartbeat", { agentId: AGENT_ID, powerTelemetry }, { retries: 0, timeoutMs: 5000 });
            const probeLatency = Date.now() - probeStart;
            try { localStore.recordHeartbeat(activeCoordinatorUrl, "reconnected", probeLatency); } catch {}
            // Probe succeeded — back online
            coordinatorOnline = true;
            consecutiveFailures = 0;
            bleMesh?.setOffline(false);
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
              requesterSignature: "",
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

      // ═══ ALWAYS: BLE peer discovery + logging (runs in both modes) ═══
      if (bleTransport) {
        const blePeers = bleTransport.discoveredPeers();
        if (blePeers.length > 0) {
          try { for (const p of blePeers) { localStore.upsertBLEPeer(p.agentId, p.model, p.modelParamSize, p.deviceType, p.rssi); } } catch (e) { console.warn(`[db] BLE peer write failed: ${e}`); }
          console.log(`[agent:${AGENT_ID}] BLE peers: ${blePeers.map(p => `${p.agentId}(rssi:${p.rssi})`).join(", ")}`);

          if (!bleTaskTestDone) {
            bleTaskTestDone = true;
            const peer = blePeers[0];
            // Delay to let discovery connect/disconnect settle before task
            console.log(`[BLE-TEST] will send test task to ${peer.agentId} in 5s...`);
            setTimeout(async () => {
              try {
                console.log(`[BLE-TEST] sending test task to ${peer.agentId} over BLE...`);
                const testReq = {
                  requestId: `ble-test-${Date.now()}`,
                  requesterId: AGENT_ID,
                  task: "Write a Python function called is_palindrome(s) that checks if a string is a palindrome, ignoring case and non-alphanumeric characters. Include a docstring.",
                  language: "python" as const,
                  requesterSignature: "",
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
      if (coordinatorOnline && consecutiveFailures >= OFFLINE_THRESHOLD) {
        coordinatorOnline = false;
        bleMesh?.setOffline(true);
        console.warn(`[agent:${AGENT_ID}] entering offline mode after ${consecutiveFailures} consecutive failures`);
      }
      const failover = await resolveCoordinatorUrl();
      if (failover.url !== activeCoordinatorUrl) {
        activeCoordinatorUrl = failover.url;
        cacheCoordinatorUrl(activeCoordinatorUrl);
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
