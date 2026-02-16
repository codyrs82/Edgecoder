import { request } from "undici";
import { randomUUID } from "node:crypto";
import { ProviderRegistry } from "../model/providers.js";
import { SwarmWorkerAgent } from "../agent/worker.js";
import { Subtask } from "../common/types.js";
import { createPeerKeys, signPayload } from "../mesh/peer.js";
import { ensureOllamaModelInstalled } from "../model/ollama-installer.js";

const COORDINATOR = process.env.COORDINATOR_URL ?? "http://127.0.0.1:4301";
const AGENT_ID = process.env.AGENT_ID ?? "worker-1";
const MODE = (process.env.AGENT_MODE ?? "swarm-only") as "swarm-only" | "ide-enabled";
const OS = (process.env.AGENT_OS ?? "macos") as "debian" | "ubuntu" | "windows" | "macos" | "ios";
const PROVIDER = (process.env.LOCAL_MODEL_PROVIDER ?? "edgecoder-local") as
  | "edgecoder-local"
  | "ollama-local";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:latest";
const OLLAMA_HOST = process.env.OLLAMA_HOST;
const OLLAMA_AUTO_INSTALL = process.env.OLLAMA_AUTO_INSTALL === "true";
const MESH_AUTH_TOKEN = process.env.MESH_AUTH_TOKEN ?? "";
const MAX_CONCURRENT_TASKS = Number(process.env.MAX_CONCURRENT_TASKS ?? "1");
const AGENT_CLIENT_TYPE = process.env.AGENT_CLIENT_TYPE ?? "edgecoder-native";
const PEER_DIRECT_WORK_ITEMS = (process.env.PEER_DIRECT_WORK_ITEMS ??
  "help peer with lightweight test scaffolding||review edge case handling").split("||");
const AGENT_REGISTRATION_TOKEN = process.env.AGENT_REGISTRATION_TOKEN ?? "";
const keys = createPeerKeys(AGENT_ID);
const peerTunnels = new Map<string, string>();
const peerOfferCooldownMs = Number(process.env.PEER_OFFER_COOLDOWN_MS ?? "20000");
const lastOfferAtByPeer = new Map<string, number>();
let peerWorkCursor = 0;

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
  if (!MESH_AUTH_TOKEN) return {};
  return { "x-mesh-token": MESH_AUTH_TOKEN };
}

async function post(path: string, body: unknown): Promise<any> {
  const res = await request(`${COORDINATOR}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...meshHeaders() },
    body: JSON.stringify(body)
  });
  return res.body.json();
}

async function loop(): Promise<void> {
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
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const powerTelemetry = readAgentPowerTelemetry();
      await post("/register", {
        agentId: AGENT_ID,
        os: OS,
        version: "0.1.0",
        mode: effectiveMode,
        registrationToken: AGENT_REGISTRATION_TOKEN,
        localModelProvider: currentProvider,
        clientType: AGENT_CLIENT_TYPE,
        maxConcurrentTasks: MAX_CONCURRENT_TASKS,
        powerTelemetry
      });

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
        language: "python" | "javascript";
        input: string;
      }>;
      blacklist?: { version: number; agents: string[] };
    };
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

      const idlePeersResponse = await request(`${COORDINATOR}/agent-mesh/peers/${AGENT_ID}`, {
        method: "GET",
        headers: meshHeaders()
      });
      if (idlePeersResponse.statusCode >= 200 && idlePeersResponse.statusCode < 300) {
        const peersJson = (await idlePeersResponse.body.json()) as { peers: string[] };
        for (const peerId of peersJson.peers.slice(0, 2)) {
          if (blacklistSet.has(peerId)) continue;
          if (peerId === AGENT_ID) continue;
          if (peerTunnels.has(peerId)) continue;
          const connect = await request(`${COORDINATOR}/agent-mesh/connect`, {
            method: "POST",
            headers: { "content-type": "application/json", ...meshHeaders() },
            body: JSON.stringify({ fromAgentId: AGENT_ID, toAgentId: peerId })
          });
          if (connect.statusCode >= 200 && connect.statusCode < 300) {
            const body = (await connect.body.json()) as { token: string };
            if (body.token) peerTunnels.set(peerId, body.token);
          }
        }
      }

      for (const token of peerTunnels.values()) {
        const relayRes = await request(`${COORDINATOR}/agent-mesh/relay`, {
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
        try {
          await ensureOllamaModelInstalled({
            enabled: hb.orchestration.provider === "ollama-local",
            autoInstall: hb.orchestration.autoInstall,
            model: hb.orchestration.model ?? OLLAMA_MODEL,
            role: "agent",
            host: OLLAMA_HOST
          });
          currentProvider = hb.orchestration.provider;
          providers.use(currentProvider);
          await post(`/orchestration/agents/${AGENT_ID}/ack`, { ok: true });
        } catch (error) {
          await post(`/orchestration/agents/${AGENT_ID}/ack`, {
            ok: false,
            error: String(error)
          });
        }
      }

      const pulled = (await post("/pull", { agentId: AGENT_ID })) as {
        subtask: Subtask | null;
      };
      if (pulled.subtask) {
        const result = await worker.runSubtask(pulled.subtask, AGENT_ID);
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
        await post("/result", result);
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
        const accepted = await request(`${COORDINATOR}/agent-mesh/direct-work/accept`, {
          method: "POST",
          headers: { "content-type": "application/json", ...meshHeaders() },
          body: JSON.stringify({
            offerId: offer.offerId,
            byAgentId: AGENT_ID
          })
        });
        if (accepted.statusCode >= 200 && accepted.statusCode < 300) {
          const peerSubtask: Subtask = {
            id: `peer-${offer.offerId}`,
            taskId: `peer-direct-${offer.offerId}`,
            kind: "single_step",
            language: offer.language,
            input: offer.input,
            timeoutMs: 4000,
            snapshotRef: "peer-direct",
            projectMeta: {
              projectId: "peer-direct",
              resourceClass: "cpu",
              priority: 10
            }
          };
          const peerResult = await worker.runSubtask(peerSubtask, AGENT_ID);
          await request(`${COORDINATOR}/agent-mesh/direct-work/result`, {
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
        const peersResponse = await request(`${COORDINATOR}/agent-mesh/peers/${AGENT_ID}`, {
          method: "GET",
          headers: meshHeaders()
        });
        if (peersResponse.statusCode >= 200 && peersResponse.statusCode < 300) {
          const peersJson = (await peersResponse.body.json()) as { peers: string[] };
          const now = Date.now();
          for (const peerId of peersJson.peers.slice(0, 2)) {
            if (blacklistSet.has(peerId)) continue;
            if (peerId === AGENT_ID) continue;
            const lastOffer = lastOfferAtByPeer.get(peerId) ?? 0;
            if (now - lastOffer < peerOfferCooldownMs) continue;
            const workInput = PEER_DIRECT_WORK_ITEMS[peerWorkCursor % PEER_DIRECT_WORK_ITEMS.length].trim();
            peerWorkCursor += 1;
            if (!workInput) continue;
            const offerRes = await request(`${COORDINATOR}/agent-mesh/direct-work/offer`, {
              method: "POST",
              headers: { "content-type": "application/json", ...meshHeaders() },
              body: JSON.stringify({
                fromAgentId: AGENT_ID,
                toAgentId: peerId,
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
      const idleDelayMs = OS === "ios" && !canUsePeerDirect ? 2500 : 1200;
      await new Promise((r) => setTimeout(r, idleDelayMs));
    } catch (error) {
      console.error(`[agent:${AGENT_ID}] loop error: ${String(error)}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

loop().catch((error) => {
  console.error(error);
  process.exit(1);
});
