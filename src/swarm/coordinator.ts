import Fastify from "fastify";
import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { request } from "undici";
import { z } from "zod";
import { extractCode } from "../model/extract.js";
import { SwarmQueue } from "./queue.js";
import {
  BitcoinAnchorRecord,
  BlacklistRecord,
  BlacklistReasonCode,
  CoordinatorFeeEvent,
  IssuanceAllocationRecord,
  IssuanceEpochRecord,
  IssuancePayoutEvent,
  ExecutionPolicy,
  KeyCustodyEvent,
  OllamaRolloutRecord,
  PaymentIntent,
  PriceEpochRecord,
  QueueEventRecord,
  QuorumLedgerRecord,
  MeshPeerIdentity,
  NetworkMode,
  ResourceClass,
  TreasuryPolicy,
  WalletType
} from "../common/types.js";
import { createPeerIdentity, createPeerKeys, signPayload, verifyPayload } from "../mesh/peer.js";
import { MeshProtocol } from "../mesh/protocol.js";
import { GossipMesh } from "../mesh/gossip.js";
import { OrderingChain } from "../ledger/chain.js";
import { verifyOrderingChain } from "../ledger/verify.js";
import { hashRecordPayload } from "../ledger/record.js";
import { accrueCredits, adjustCredits, creditEngine, rewardAccountForAgent, spendCredits } from "../credits/store.js";
import { ensureOllamaModelInstalled } from "../model/ollama-installer.js";
import { pgStore } from "../db/store.js";
import { computeDynamicPricePerComputeUnitSats, creditsForSats, satsForCredits } from "../economy/pricing.js";
import {
  computeDailyPoolTokens,
  computeHourlyIssuanceAllocations,
  computeLoadIndex,
  IssuancePoolConfig,
  smoothLoadIndex
} from "../economy/issuance.js";
import { createLightningProviderFromEnv } from "../economy/lightning.js";
import { createTreasuryPolicy, signKeyCustodyEvent } from "../economy/treasury.js";
import { AgentPowerTelemetry, evaluateAgentPowerPolicy } from "./power-policy.js";
import {
  BlacklistEvidenceInput,
  canonicalizeBlacklistEvidence,
  validateIncomingBlacklistRecord,
  buildBlacklistEventHash,
  verifyReporterEvidenceSignature
} from "../security/blacklist.js";
import { EscalationRequest, EscalationResult } from "../escalation/types.js";

const app = Fastify({ logger: true });
const queue = new SwarmQueue(pgStore);
const protocol = new MeshProtocol();
const mesh = new GossipMesh();
const peerScore = new Map<string, number>();
const peerMessageWindow = new Map<string, { windowMs: number; count: number }>();
const MESH_RATE_LIMIT_PER_10S = 50;
const MESH_AUTH_TOKEN = process.env.MESH_AUTH_TOKEN ?? "";
const PORTAL_SERVICE_URL = process.env.PORTAL_SERVICE_URL ?? "";
const PORTAL_SERVICE_TOKEN = process.env.PORTAL_SERVICE_TOKEN ?? "";
const COORDINATOR_FEE_BPS = Number(process.env.COORDINATOR_FEE_BPS ?? "150");
const COORDINATOR_FEE_ACCOUNT = process.env.COORDINATOR_FEE_ACCOUNT ?? "coordinator-fee:default";
const BITCOIN_NETWORK = (process.env.BITCOIN_NETWORK ?? "testnet") as "bitcoin" | "testnet" | "signet";
const APPROVED_COORDINATOR_IDS = new Set(
  (process.env.APPROVED_COORDINATOR_IDS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);
const PAYMENT_INTENT_TTL_MS = Number(process.env.PAYMENT_INTENT_TTL_MS ?? "900000");
const CONTRIBUTION_BURST_CREDITS = Number(process.env.CONTRIBUTION_BURST_CREDITS ?? "25");
const MIN_CONTRIBUTION_RATIO = Number(process.env.MIN_CONTRIBUTION_RATIO ?? "1.0");
const ISSUANCE_WINDOW_MS = Number(process.env.ISSUANCE_WINDOW_MS ?? String(24 * 60 * 60 * 1000));
const ISSUANCE_RECALC_MS = Number(process.env.ISSUANCE_RECALC_MS ?? String(60 * 60 * 1000));
const ISSUANCE_BASE_DAILY_POOL_TOKENS = Number(process.env.ISSUANCE_BASE_DAILY_POOL_TOKENS ?? "10000");
const ISSUANCE_MIN_DAILY_POOL_TOKENS = Number(process.env.ISSUANCE_MIN_DAILY_POOL_TOKENS ?? "2500");
const ISSUANCE_MAX_DAILY_POOL_TOKENS = Number(process.env.ISSUANCE_MAX_DAILY_POOL_TOKENS ?? "100000");
const ISSUANCE_LOAD_CURVE_SLOPE = Number(process.env.ISSUANCE_LOAD_CURVE_SLOPE ?? "0.35");
const ISSUANCE_SMOOTHING_ALPHA = Number(process.env.ISSUANCE_SMOOTHING_ALPHA ?? "0.35");
const ISSUANCE_COORDINATOR_SHARE = Number(process.env.ISSUANCE_COORDINATOR_SHARE ?? "0.05");
const ISSUANCE_RESERVE_SHARE = Number(process.env.ISSUANCE_RESERVE_SHARE ?? "0.05");
const ANCHOR_INTERVAL_MS = Number(process.env.ANCHOR_INTERVAL_MS ?? String(2 * 60 * 60 * 1000));
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "";
const IOS_BATTERY_PULL_MIN_INTERVAL_MS = Number(process.env.IOS_BATTERY_PULL_MIN_INTERVAL_MS ?? "45000");
const IOS_BATTERY_TASK_STOP_LEVEL_PCT = Number(process.env.IOS_BATTERY_TASK_STOP_LEVEL_PCT ?? "20");
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? "";
const COORDINATOR_PUBLIC_URL = process.env.COORDINATOR_PUBLIC_URL ?? "http://127.0.0.1:4301";
const COORDINATOR_DISCOVERY_URL =
  process.env.COORDINATOR_DISCOVERY_URL ??
  (CONTROL_PLANE_URL ? `${CONTROL_PLANE_URL.replace(/\/$/, "")}/network/coordinators` : "");
const COORDINATOR_BOOTSTRAP_URLS = (process.env.COORDINATOR_BOOTSTRAP_URLS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const COORDINATOR_REGISTRATION_TOKEN = process.env.COORDINATOR_REGISTRATION_TOKEN ?? "";
const COORDINATOR_PEER_CACHE_FILE = resolve(
  process.env.COORDINATOR_PEER_CACHE_FILE ?? `${homedir()}/.edgecoder/coordinator-peer-cache.json`
);
const STATS_LEDGER_SYNC_INTERVAL_MS = Number(process.env.STATS_LEDGER_SYNC_INTERVAL_MS ?? "10000");
const STATS_ANCHOR_INTERVAL_MS = Number(process.env.STATS_ANCHOR_INTERVAL_MS ?? "600000");
const STATS_ANCHOR_MIN_CONFIRMATIONS = Number(process.env.STATS_ANCHOR_MIN_CONFIRMATIONS ?? "1");

function loadCoordinatorKeys() {
  const peerId = process.env.COORDINATOR_PEER_ID ?? "coordinator-local";
  const privateKeyPem = process.env.COORDINATOR_PRIVATE_KEY_PEM;
  const publicKeyPem = process.env.COORDINATOR_PUBLIC_KEY_PEM;
  if (privateKeyPem) {
    const derivedPublicKeyPem = createPublicKey(createPrivateKey(privateKeyPem))
      .export({ type: "spki", format: "pem" })
      .toString();
    return {
      peerId,
      privateKeyPem,
      publicKeyPem: publicKeyPem ?? derivedPublicKeyPem
    };
  }
  return createPeerKeys(peerId);
}

const coordinatorKeys = loadCoordinatorKeys();
const networkMode: NetworkMode =
  (process.env.NETWORK_MODE as NetworkMode | undefined) ?? "public_mesh";
const PROVIDER = (process.env.LOCAL_MODEL_PROVIDER ?? "edgecoder-local") as
  | "edgecoder-local"
  | "ollama-local";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:latest";
const OLLAMA_HOST = process.env.OLLAMA_HOST;
const OLLAMA_AUTO_INSTALL = process.env.OLLAMA_AUTO_INSTALL === "true";
const INFERENCE_URL = process.env.INFERENCE_URL ?? "http://127.0.0.1:4302";
const INFERENCE_AUTH_TOKEN = process.env.INFERENCE_AUTH_TOKEN ?? "";
const identity = createPeerIdentity(coordinatorKeys, COORDINATOR_PUBLIC_URL, networkMode);
const ordering = new OrderingChain(identity.peerId, coordinatorKeys.privateKeyPem);
let coordinatorProvider = PROVIDER;
const agentOrchestration = new Map<
  string,
  {
    rolloutId: string;
    provider: "edgecoder-local" | "ollama-local";
    model?: string;
    autoInstall: boolean;
    pending: boolean;
    requestedAtMs: number;
    status?: { phase: string; message: string; progressPct?: number; updatedAtMs: number };
  }
>();
type DirectWorkOffer = {
  offerId: string;
  fromAgentId: string;
  toAgentId: string;
  workType: "code_task" | "model_inference";
  language?: "python" | "javascript";
  input: string;
  createdAtMs: number;
  status: "offered" | "accepted" | "completed" | "rejected";
  acceptedBy?: string;
  acceptedAtMs?: number;
  result?: { ok: boolean; output: string; error?: string; durationMs: number; completedAtMs: number };
};

const directWorkById = new Map<string, DirectWorkOffer>();
const directWorkInbox = new Map<string, string[]>();
const agentCapabilities = new Map<
  string,
  {
    os: string;
    version: string;
    mode: "swarm-only" | "ide-enabled";
    localModelEnabled: boolean;
    localModelProvider: "edgecoder-local" | "ollama-local";
    localModelCatalog: string[];
    clientType: string;
    swarmEnabled: boolean;
    ideEnabled: boolean;
    maxConcurrentTasks: number;
    connectedPeers: Set<string>;
    ownerEmail?: string;
    sourceIp?: string;
    countryCode?: string;
    vpnDetected?: boolean;
    enrollmentReason?: string;
    powerTelemetry?: AgentPowerTelemetry;
    lastSeenMs: number;
  }
>();
const lastTaskAssignedByAgent = new Map<string, number>();
const ollamaRollouts = new Map<string, OllamaRolloutRecord>();
const pendingTunnelInvites = new Map<string, Array<{ fromAgentId: string; token: string }>>();
const activeTunnels = new Map<
  string,
  {
    fromAgentId: string;
    toAgentId: string;
    createdAtMs: number;
    lastRelayMs: number;
    relayCount: number;
    relayWindowStartMs: number;
    relayWindowCount: number;
  }
>();
const tunnelByPairKey = new Map<string, string>();
const TUNNEL_IDLE_TTL_MS = Number(process.env.TUNNEL_IDLE_TTL_MS ?? "90000");
const TUNNEL_MAX_RELAYS_PER_MIN = Number(process.env.TUNNEL_MAX_RELAYS_PER_MIN ?? "120");
const RELAY_RATE_LIMIT_PER_10S = Number(process.env.RELAY_RATE_LIMIT_PER_10S ?? "80");
const DIRECT_WORK_OFFERS_PER_10S = Number(process.env.DIRECT_WORK_OFFERS_PER_10S ?? "20");
const blacklistByAgent = new Map<string, BlacklistRecord>();
const blacklistAuditLog: BlacklistRecord[] = [];
let blacklistVersion = 0;
let lastBlacklistEventHash = "BLACKLIST_GENESIS";
const relayWindowByAgent = new Map<string, { windowMs: number; count: number }>();
const offerWindowByAgent = new Map<string, { windowMs: number; count: number }>();
const pendingTunnelCloseNotices = new Map<string, Array<{ peerAgentId: string; token: string; reason: string }>>();
const paymentIntents = new Map<string, PaymentIntent>();
const latestPriceEpochByResource = new Map<ResourceClass, PriceEpochRecord>();
const lightningProvider = createLightningProviderFromEnv();
let treasuryPolicy: TreasuryPolicy | null = null;
const keyCustodyEvents: KeyCustodyEvent[] = [];
const settledTxRefs = new Set<string>();
let smoothedLoadIndex: number | null = null;
const diagnosticsByAgentId = new Map<string, Array<{ eventAtMs: number; message: string }>>();
function appendAgentDiagnostic(agentId: string, message: string, eventAtMs = Date.now()): void {
  const text = String(message ?? "").trim();
  if (!text) return;
  const existing = diagnosticsByAgentId.get(agentId) ?? [];
  const merged = [...existing, { eventAtMs: Number(eventAtMs || Date.now()), message: text }].slice(-250);
  diagnosticsByAgentId.set(agentId, merged);
}

function requireMeshToken(req: { headers: Record<string, unknown> }, reply: { code: (n: number) => any }) {
  if (!MESH_AUTH_TOKEN) return true;
  const token = req.headers["x-mesh-token"];
  if (typeof token === "string" && token === MESH_AUTH_TOKEN) return true;
  reply.code(401);
  return false;
}

function hasMeshToken(headers: Record<string, unknown>): boolean {
  if (!MESH_AUTH_TOKEN) return true;
  const token = headers["x-mesh-token"];
  return typeof token === "string" && token === MESH_AUTH_TOKEN;
}

function hasPortalServiceToken(headers: Record<string, unknown>): boolean {
  if (!PORTAL_SERVICE_TOKEN) return true;
  const token = headers["x-portal-service-token"];
  return typeof token === "string" && token === PORTAL_SERVICE_TOKEN;
}

function parseRecordPayload(record: { payloadJson?: string }): Record<string, unknown> {
  if (!record.payloadJson) return {};
  try {
    return JSON.parse(record.payloadJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function applyStatsProjectionRecord(record: {
  eventType: string;
  taskId: string;
  actorId: string;
  issuedAtMs: number;
  payloadJson?: string;
}): Promise<void> {
  if (!pgStore) return;
  const payload = parseRecordPayload(record);
  if (record.eventType === "node_approval" || record.eventType === "node_validation") {
    const [kindRaw, nodeIdRaw] = record.taskId.split(":");
    const nodeId = nodeIdRaw || record.actorId;
    const nodeKind = kindRaw === "coordinator" ? "coordinator" : "agent";
    await pgStore.upsertNodeStatusProjection({
      nodeId,
      nodeKind,
      ownerEmail: typeof payload.ownerEmail === "string" ? payload.ownerEmail : undefined,
      emailVerified: typeof payload.emailVerified === "boolean" ? payload.emailVerified : undefined,
      nodeApproved:
        typeof payload.nodeApproved === "boolean"
          ? payload.nodeApproved
          : typeof payload.approved === "boolean"
            ? payload.approved
            : undefined,
      active: typeof payload.active === "boolean" ? payload.active : undefined,
      sourceIp: typeof payload.sourceIp === "string" ? payload.sourceIp : undefined,
      countryCode: typeof payload.countryCode === "string" ? payload.countryCode : undefined,
      vpnDetected: typeof payload.vpnDetected === "boolean" ? payload.vpnDetected : undefined,
      lastSeenMs: record.issuedAtMs,
      updatedAtMs: record.issuedAtMs
    });
    return;
  }
  if (record.eventType === "earnings_accrual") {
    const credits =
      typeof payload.credits === "number"
        ? payload.credits
        : typeof payload.estimatedCredits === "number"
          ? payload.estimatedCredits
          : 0;
    if (credits <= 0) return;
    await pgStore.incrementCoordinatorEarningsProjection({
      accountId: record.actorId,
      ownerEmail: typeof payload.ownerEmail === "string" ? payload.ownerEmail : undefined,
      credits,
      taskCountDelta: 1,
      updatedAtMs: record.issuedAtMs
    });
  }
}

async function persistStatsLedgerRecord(record: {
  id: string;
  eventType: any;
  taskId: string;
  subtaskId?: string;
  actorId: string;
  sequence: number;
  issuedAtMs: number;
  prevHash: string;
  coordinatorId?: string;
  checkpointHeight?: number;
  checkpointHash?: string;
  payloadJson?: string;
  hash: string;
  signature: string;
}): Promise<void> {
  await pgStore?.persistStatsLedgerRecord(record);
  await applyStatsProjectionRecord(record);
}

app.addHook("onRequest", async (req, reply) => {
  // Allow initial agent registration without mesh token; coordinator validates
  // portal enrollment token and returns mesh auth material in the response.
  const reqPath = (req as any).url as string | undefined;
  if (reqPath === "/register") return;
  if (
    hasPortalServiceToken(((req as any).headers ?? {}) as Record<string, unknown>) &&
    (reqPath?.startsWith("/stats/projections/summary") || reqPath?.startsWith("/agent/diagnostics/"))
  ) {
    return;
  }
  if (!requireMeshToken(req as any, reply)) {
    return reply.send({ error: "mesh_unauthorized" });
  }
});

function normalizeIpCandidate(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  if (value.toLowerCase() === "unknown") return undefined;
  if (value.startsWith("::ffff:")) return value.slice(7);
  if (value.startsWith("[") && value.includes("]")) return value.slice(1, value.indexOf("]"));
  const colonCount = (value.match(/:/g) ?? []).length;
  if (colonCount === 1 && /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) {
    return value.split(":")[0];
  }
  return value;
}

function readHeaderValue(headers: Record<string, unknown>, key: string): string | undefined {
  const raw = headers[key];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first = raw.find((item) => typeof item === "string");
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function extractClientIp(headers: Record<string, unknown>, fallbackIp?: string): string | undefined {
  const priorityHeaders = ["fly-client-ip", "cf-connecting-ip", "x-real-ip", "true-client-ip"];
  for (const key of priorityHeaders) {
    const headerValue = readHeaderValue(headers, key);
    const normalized = headerValue ? normalizeIpCandidate(headerValue) : undefined;
    if (normalized) return normalized;
  }
  const forwarded = readHeaderValue(headers, "x-forwarded-for");
  if (forwarded) {
    for (const part of forwarded.split(",")) {
      const normalized = normalizeIpCandidate(part);
      if (normalized) return normalized;
    }
  }
  if (typeof fallbackIp === "string") {
    return normalizeIpCandidate(fallbackIp);
  }
  return undefined;
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

async function readCachedPeerUrls(): Promise<string[]> {
  try {
    const raw = await readFile(COORDINATOR_PEER_CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as { peers?: string[] };
    if (!Array.isArray(parsed.peers)) return [];
    return parsed.peers.map((item) => normalizeUrl(item) ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

async function writeCachedPeerUrls(urls: string[]): Promise<void> {
  try {
    await mkdir(dirname(COORDINATOR_PEER_CACHE_FILE), { recursive: true });
    await writeFile(
      COORDINATOR_PEER_CACHE_FILE,
      JSON.stringify({ peers: urls, updatedAtMs: Date.now() }, null, 2),
      "utf8"
    );
  } catch {
    // Best-effort cache only.
  }
}

async function discoverCoordinatorUrlsFromRegistry(): Promise<string[]> {
  if (!COORDINATOR_DISCOVERY_URL) return [];
  try {
    const res = await request(COORDINATOR_DISCOVERY_URL, { method: "GET" });
    if (res.statusCode < 200 || res.statusCode >= 300) return [];
    const payload = (await res.body.json()) as {
      coordinators?: Array<{ coordinatorUrl?: string }>;
    };
    return (payload.coordinators ?? [])
      .map((item) => normalizeUrl(item.coordinatorUrl) ?? "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function discoverBootstrapPeers(): Promise<string[]> {
  const fromRegistry = await discoverCoordinatorUrlsFromRegistry();
  const fromCache = await readCachedPeerUrls();
  const candidates = [...fromRegistry, ...fromCache, ...COORDINATOR_BOOTSTRAP_URLS]
    .map((value) => normalizeUrl(value) ?? "")
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index)
    .filter((value) => value !== normalizeUrl(COORDINATOR_PUBLIC_URL));
  return candidates;
}

async function bootstrapPeerMesh(): Promise<void> {
  const candidates = await discoverBootstrapPeers();
  if (candidates.length === 0) return;

  const discoveredForCache = new Set<string>();
  for (const peerUrl of candidates) {
    try {
      const identityRes = await request(`${peerUrl}/identity`, {
        method: "GET",
        headers: MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : undefined
      });
      if (identityRes.statusCode < 200 || identityRes.statusCode >= 300) continue;
      const remote = (await identityRes.body.json()) as {
        peerId: string;
        publicKeyPem: string;
        coordinatorUrl: string;
        networkMode: NetworkMode;
      };
      if (!remote.peerId || remote.peerId === identity.peerId) continue;

      const normalizedRemoteUrl = normalizeUrl(remote.coordinatorUrl);
      if (!normalizedRemoteUrl || normalizedRemoteUrl === normalizeUrl(COORDINATOR_PUBLIC_URL)) continue;
      mesh.addPeer({
        peerId: remote.peerId,
        publicKeyPem: remote.publicKeyPem,
        coordinatorUrl: normalizedRemoteUrl,
        networkMode: remote.networkMode
      });
      peerScore.set(remote.peerId, peerScore.get(remote.peerId) ?? 100);
      discoveredForCache.add(normalizedRemoteUrl);

      const registerRes = await request(`${peerUrl}/mesh/register-peer`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : {})
        },
        body: JSON.stringify({
          peerId: identity.peerId,
          publicKeyPem: identity.publicKeyPem,
          coordinatorUrl: normalizeUrl(COORDINATOR_PUBLIC_URL),
          networkMode,
          registrationToken: COORDINATOR_REGISTRATION_TOKEN
        })
      });
      if (registerRes.statusCode >= 200 && registerRes.statusCode < 300) {
        discoveredForCache.add(peerUrl);
      }
    } catch {
      // Continue to next candidate.
    }
  }

  if (discoveredForCache.size > 0) {
    await writeCachedPeerUrls([...discoveredForCache]);
  }
}

async function validatePortalNode(input: {
  nodeId: string;
  nodeKind: "agent" | "coordinator";
  registrationToken?: string;
  deviceId?: string;
  sourceIp?: string;
}): Promise<{
  allowed: boolean;
  reason?: string;
  ownerEmail?: string;
  sourceIp?: string;
  countryCode?: string;
  vpnDetected?: boolean;
}> {
  const appendValidationEvent = async (outcome: { allowed: boolean; reason?: string; ownerEmail?: string }) => {
    try {
      const validationRecord = ordering.append({
        eventType: "node_validation",
        taskId: `${input.nodeKind}:${input.nodeId}`,
        actorId: input.nodeId,
        coordinatorId: identity.peerId,
        payloadJson: JSON.stringify({
          nodeKind: input.nodeKind,
          sourceIp: input.sourceIp,
          allowed: outcome.allowed,
          reason: outcome.reason ?? null,
          ownerEmail: outcome.ownerEmail ?? null
        })
      });
      const validationAuditTimeoutMs = 2_000;
      await Promise.race([
        Promise.all([pgStore?.persistLedgerRecord(validationRecord), persistStatsLedgerRecord(validationRecord)]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("validation_audit_persist_timeout")), validationAuditTimeoutMs)
        )
      ]);
    } catch {
      // Best-effort audit signal; validation path should not fail due to ledger write.
    }
  };
  const lookupPersistedApprovedAgent = async (): Promise<{
    ownerEmail?: string;
    sourceIp?: string;
    countryCode?: string;
    vpnDetected?: boolean;
  } | null> => {
    if (!pgStore || input.nodeKind !== "agent") return null;
    try {
      const projectionLookupTimeoutMs = 1_500;
      const nodes = await Promise.race([
        pgStore.listNodeStatusProjection(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("projection_lookup_timeout")), projectionLookupTimeoutMs)
        )
      ]);
      const matched = (nodes ?? []).find((node) => node.nodeId === input.nodeId && node.nodeApproved === true);
      if (!matched) return null;
      return {
        ownerEmail: matched.ownerEmail,
        sourceIp: matched.sourceIp,
        countryCode: matched.countryCode,
        vpnDetected: matched.vpnDetected
      };
    } catch {
      return null;
    }
  };
  const allowIfKnownAgent = async (reason: string): Promise<{
    allowed: boolean;
    reason?: string;
    ownerEmail?: string;
    sourceIp?: string;
    countryCode?: string;
    vpnDetected?: boolean;
  } | null> => {
    if (input.nodeKind !== "agent") return null;
    const existing = agentCapabilities.get(input.nodeId);
    if (existing) {
      return {
        allowed: true,
        reason,
        ownerEmail: existing.ownerEmail,
        sourceIp: existing.sourceIp,
        countryCode: existing.countryCode,
        vpnDetected: existing.vpnDetected
      };
    }
    const persisted = await lookupPersistedApprovedAgent();
    if (!persisted) return null;
    return {
      allowed: true,
      reason,
      ownerEmail: persisted.ownerEmail,
      sourceIp: persisted.sourceIp,
      countryCode: persisted.countryCode,
      vpnDetected: persisted.vpnDetected
    };
  };
  if (!PORTAL_SERVICE_URL) {
    const outcome = { allowed: true, reason: "portal_validation_disabled" };
    await appendValidationEvent(outcome);
    return outcome;
  }
  if (!input.registrationToken) {
    const cached = await allowIfKnownAgent("registration_token_missing_cached_agent");
    if (cached) {
      await appendValidationEvent(cached);
      return cached;
    }
    const outcome = { allowed: false, reason: "registration_token_required" };
    await appendValidationEvent(outcome);
    return outcome;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (PORTAL_SERVICE_TOKEN) headers["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;
  try {
    const portalValidationTimeoutMs = 5_000;
    const res = await request(`${PORTAL_SERVICE_URL}/internal/nodes/validate`, {
      method: "POST",
      headers,
      headersTimeout: portalValidationTimeoutMs,
      bodyTimeout: portalValidationTimeoutMs,
      body: JSON.stringify({
        nodeId: input.nodeId,
        nodeKind: input.nodeKind,
        registrationToken: input.registrationToken,
        deviceId: input.deviceId,
        sourceIp: input.sourceIp
      })
    });
    const payload = (await res.body.json()) as {
      allowed?: boolean;
      reason?: string;
      node?: {
        ownerEmail?: string;
        sourceIp?: string;
        countryCode?: string;
        vpnDetected?: boolean;
      };
    };
    if (res.statusCode < 200 || res.statusCode >= 300) {
      await appendValidationEvent({
        allowed: false,
        reason: payload.reason ?? `portal_validation_failed_${res.statusCode}`
      });
      return {
        allowed: false,
        reason: payload.reason ?? `portal_validation_failed_${res.statusCode}`
      };
    }
    await appendValidationEvent({
      allowed: payload.allowed === true,
      reason: payload.reason,
      ownerEmail: payload.node?.ownerEmail
    });
    return {
      allowed: payload.allowed === true,
      reason: payload.reason,
      ownerEmail: payload.node?.ownerEmail,
      sourceIp: payload.node?.sourceIp,
      countryCode: payload.node?.countryCode,
      vpnDetected: payload.node?.vpnDetected
    };
  } catch {
    // If portal validation is temporarily unavailable, allow agents we already know.
    // This avoids flapping registrations for long-running approved nodes.
    const cached = await allowIfKnownAgent("portal_validation_unreachable_cached_agent");
    if (cached) {
      await appendValidationEvent(cached);
      return cached;
    }
    const outcome = { allowed: false, reason: "portal_validation_unreachable" };
    await appendValidationEvent(outcome);
    return outcome;
  }
}

function coordinatorPublicKeyById(peerId: string): string | null {
  if (peerId === identity.peerId) return identity.publicKeyPem;
  const peer = mesh.listPeers().find((item) => item.peerId === peerId);
  return peer?.publicKeyPem ?? null;
}

function verifyStatsLedgerRecord(record: {
  eventType: any;
  taskId: string;
  subtaskId?: string;
  actorId: string;
  sequence: number;
  issuedAtMs: number;
  prevHash: string;
  coordinatorId?: string;
  checkpointHeight?: number;
  checkpointHash?: string;
  payloadJson?: string;
  hash: string;
  signature: string;
}): boolean {
  if (!record.coordinatorId) return false;
  const publicKeyPem = coordinatorPublicKeyById(record.coordinatorId);
  if (!publicKeyPem) return false;
  const expectedHash = hashRecordPayload({
    eventType: record.eventType,
    taskId: record.taskId,
    subtaskId: record.subtaskId,
    actorId: record.actorId,
    sequence: record.sequence,
    issuedAtMs: record.issuedAtMs,
    prevHash: record.prevHash,
    coordinatorId: record.coordinatorId,
    checkpointHeight: record.checkpointHeight,
    checkpointHash: record.checkpointHash,
    payloadJson: record.payloadJson
  });
  if (expectedHash !== record.hash) return false;
  return verifyPayload(record.hash, record.signature, publicKeyPem);
}

function statsQuorumThreshold(): number {
  const totalCoordinators = mesh.listPeers().length + 1;
  return Math.max(1, Math.floor(totalCoordinators / 2) + 1);
}

async function maybeFinalizeStatsCheckpoint(): Promise<void> {
  if (!pgStore) return;
  const head = await pgStore.latestStatsLedgerHead();
  if (!head) return;
  const checkpointHash = head.hash;
  const records = await pgStore.listStatsLedgerRecords(5000);
  const signatures = new Set<string>();
  let hasCommit = false;
  let hasLocalSignature = false;
  for (const record of records) {
    if (record.eventType === "stats_checkpoint_commit" && record.checkpointHash === checkpointHash) {
      hasCommit = true;
    }
    if (record.eventType === "stats_checkpoint_signature" && record.checkpointHash === checkpointHash) {
      signatures.add(record.coordinatorId ?? record.actorId);
      if ((record.coordinatorId ?? record.actorId) === identity.peerId) {
        hasLocalSignature = true;
      }
    }
  }

  const threshold = statsQuorumThreshold();
  if (!hasLocalSignature) {
    const signatureRecord = ordering.append({
      eventType: "stats_checkpoint_signature",
      taskId: "stats-ledger",
      actorId: identity.peerId,
      coordinatorId: identity.peerId,
      checkpointHeight: head.count,
      checkpointHash,
      payloadJson: JSON.stringify({ threshold, signerPeerId: identity.peerId })
    });
    await pgStore.persistLedgerRecord(signatureRecord);
    await persistStatsLedgerRecord(signatureRecord);
    signatures.add(identity.peerId);
  }

  if (!hasCommit && signatures.size >= threshold) {
    const commitRecord = ordering.append({
      eventType: "stats_checkpoint_commit",
      taskId: "stats-ledger",
      actorId: identity.peerId,
      coordinatorId: identity.peerId,
      checkpointHeight: head.count,
      checkpointHash,
      payloadJson: JSON.stringify({ threshold, signerSet: [...signatures] })
    });
    await pgStore.persistLedgerRecord(commitRecord);
    await persistStatsLedgerRecord(commitRecord);
  }
}

async function maybeAnchorLatestStatsCheckpoint(): Promise<BitcoinAnchorRecord | null> {
  if (!pgStore) return null;
  const head = await pgStore.latestStatsLedgerHead();
  if (!head) return null;
  const checkpointHash = head.hash;
  const existing = await pgStore.latestAnchorByCheckpoint(checkpointHash);
  if (existing && existing.status === "anchored") return existing;
  const now = Date.now();
  const record: BitcoinAnchorRecord = {
    anchorId: existing?.anchorId ?? randomUUID(),
    epochId: `stats:${head.count}`,
    checkpointHash,
    anchorNetwork: BITCOIN_NETWORK,
    txRef: existing?.txRef ?? `stats-anchor:${BITCOIN_NETWORK}:${checkpointHash.slice(0, 24)}`,
    status: "anchored",
    anchoredAtMs: now,
    createdAtMs: existing?.createdAtMs ?? now
  };
  await pgStore.upsertBitcoinAnchor(record);
  return record;
}

async function latestStatsFinality(): Promise<{
  checkpointHash?: string;
  checkpointHeight?: number;
  softFinalized: boolean;
  hardFinalized: boolean;
  finalityState: "soft_finalized" | "anchored_pending" | "anchored_confirmed" | "no_checkpoint";
  anchor?: {
    txRef: string;
    network: string;
    status: string;
    confirmations: number;
    anchoredAtMs?: number;
  };
}> {
  if (!pgStore) {
    return {
      softFinalized: false,
      hardFinalized: false,
      finalityState: "no_checkpoint"
    };
  }
  const records = await pgStore.listStatsLedgerRecords(5000);
  const latestCommit = [...records]
    .reverse()
    .find((record) => record.eventType === "stats_checkpoint_commit" && record.checkpointHash);
  if (!latestCommit || !latestCommit.checkpointHash) {
    return {
      softFinalized: false,
      hardFinalized: false,
      finalityState: "no_checkpoint"
    };
  }
  const anchor = await pgStore.latestAnchorByCheckpoint(latestCommit.checkpointHash);
  const confirmations = anchor?.status === "anchored" ? 1 : 0;
  const hardFinalized = confirmations >= STATS_ANCHOR_MIN_CONFIRMATIONS;
  return {
    checkpointHash: latestCommit.checkpointHash,
    checkpointHeight: latestCommit.checkpointHeight,
    softFinalized: true,
    hardFinalized,
    finalityState: hardFinalized ? "anchored_confirmed" : "anchored_pending",
    anchor: anchor
      ? {
          txRef: anchor.txRef,
          network: anchor.anchorNetwork,
          status: anchor.status,
          confirmations,
          anchoredAtMs: anchor.anchoredAtMs
        }
      : undefined
  };
}

async function ingestStatsLedgerRecords(records: QueueEventRecord[]): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0;
  let skipped = 0;
  for (const record of records) {
    if (!verifyStatsLedgerRecord(record)) {
      skipped += 1;
      continue;
    }
    await persistStatsLedgerRecord(record);
    ingested += 1;
  }
  if (ingested > 0) {
    await maybeFinalizeStatsCheckpoint();
  }
  return { ingested, skipped };
}

async function syncStatsLedgerFromPeer(peer: { peerId: string; coordinatorUrl: string }): Promise<void> {
  if (!pgStore) return;
  try {
    const headRes = await request(`${peer.coordinatorUrl}/stats/ledger/head`, {
      method: "GET",
      headers: MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : undefined
    });
    if (headRes.statusCode < 200 || headRes.statusCode >= 300) return;
    const remoteHead = (await headRes.body.json()) as { issuedAtMs?: number };
    if (!remoteHead.issuedAtMs) return;
    const localHead = await pgStore.latestStatsLedgerHead();
    const sinceIssuedAtMs = localHead?.issuedAtMs ?? 0;
    if (remoteHead.issuedAtMs <= sinceIssuedAtMs) return;
    const rangeRes = await request(
      `${peer.coordinatorUrl}/stats/ledger/range?sinceIssuedAtMs=${encodeURIComponent(String(sinceIssuedAtMs))}&limit=1000`,
      {
        method: "GET",
        headers: MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : undefined
      }
    );
    if (rangeRes.statusCode < 200 || rangeRes.statusCode >= 300) return;
    const payload = (await rangeRes.body.json()) as { records?: QueueEventRecord[] };
    if (!Array.isArray(payload.records) || payload.records.length === 0) return;
    await ingestStatsLedgerRecords(payload.records);
  } catch {
    // Best effort sync.
  }
}

function activeBlacklistRecord(agentId: string): BlacklistRecord | undefined {
  const record = blacklistByAgent.get(agentId);
  if (!record) return undefined;
  if (record.expiresAtMs && Date.now() > record.expiresAtMs) {
    blacklistByAgent.delete(agentId);
    blacklistVersion += 1;
    return undefined;
  }
  return record;
}

function appendBlacklistRecord(record: BlacklistRecord): void {
  blacklistByAgent.set(record.agentId, record);
  blacklistAuditLog.push(record);
  blacklistVersion += 1;
  lastBlacklistEventHash = record.eventHash;
  void pgStore?.persistBlacklistEvent(record).catch(() => undefined);
}

async function upsertRollout(record: OllamaRolloutRecord): Promise<void> {
  ollamaRollouts.set(record.rolloutId, record);
  try {
    const rolloutPersistTimeoutMs = 2_000;
    await Promise.race([
      pgStore?.upsertOllamaRollout(record),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("rollout_persist_timeout")), rolloutPersistTimeoutMs)
      )
    ]);
  } catch (error) {
    // Keep orchestration UX responsive even if Postgres is transiently unavailable.
    app.log.warn({ error, rolloutId: record.rolloutId, targetId: record.targetId }, "rollout_persist_failed");
  }
}

function isApprovedCoordinator(peerId: string): boolean {
  if (APPROVED_COORDINATOR_IDS.size === 0) return true;
  return APPROVED_COORDINATOR_IDS.has(peerId);
}

function weightedMedian(entries: Array<{ value: number; weight: number }>): number {
  if (entries.length === 0) return 0;
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (totalWeight <= 0) return sorted[Math.floor(sorted.length / 2)]?.value ?? 0;
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += Math.max(0, item.weight);
    if (cumulative >= totalWeight / 2) return item.value;
  }
  return sorted[sorted.length - 1]?.value ?? 0;
}

const issuancePoolConfig: IssuancePoolConfig = {
  baseDailyPoolTokens: ISSUANCE_BASE_DAILY_POOL_TOKENS,
  minDailyPoolTokens: ISSUANCE_MIN_DAILY_POOL_TOKENS,
  maxDailyPoolTokens: ISSUANCE_MAX_DAILY_POOL_TOKENS,
  loadCurveSlope: ISSUANCE_LOAD_CURVE_SLOPE,
  smoothingAlpha: ISSUANCE_SMOOTHING_ALPHA
};

function quorumThreshold(): number {
  if (!treasuryPolicy || treasuryPolicy.approvedCoordinatorIds.length === 0) return 1;
  return Math.max(1, Math.floor(treasuryPolicy.approvedCoordinatorIds.length / 2) + 1);
}

async function appendQuorumRecord(input: {
  recordType: QuorumLedgerRecord["recordType"];
  epochId: string;
  payload: Record<string, unknown>;
}): Promise<QuorumLedgerRecord> {
  const prev = await pgStore?.latestQuorumLedgerRecord();
  const payloadJson = JSON.stringify(input.payload);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        recordType: input.recordType,
        epochId: input.epochId,
        coordinatorId: identity.peerId,
        prevHash: prev?.hash ?? "GENESIS",
        payloadJson
      })
    )
    .digest("hex");
  const record: QuorumLedgerRecord = {
    recordId: randomUUID(),
    recordType: input.recordType,
    epochId: input.epochId,
    coordinatorId: identity.peerId,
    prevHash: prev?.hash ?? "GENESIS",
    hash,
    payloadJson,
    signature: signPayload(hash, coordinatorKeys.privateKeyPem),
    createdAtMs: Date.now()
  };
  await pgStore?.persistQuorumLedgerRecord(record);
  return record;
}

async function maybeFinalizeIssuanceEpoch(epoch: IssuanceEpochRecord): Promise<boolean> {
  const records = (await pgStore?.listQuorumLedgerByEpoch(epoch.issuanceEpochId)) ?? [];
  const approvals = new Set<string>();
  for (const record of records) {
    if (record.recordType === "issuance_proposal") approvals.add(record.coordinatorId);
    if (record.recordType === "issuance_vote") {
      const payload = JSON.parse(record.payloadJson) as { vote?: "approve" | "reject" };
      if (payload.vote === "approve") approvals.add(record.coordinatorId);
    }
  }
  if (approvals.size < quorumThreshold()) return false;
  const hasCommit = records.some((record) => record.recordType === "issuance_commit");
  if (!hasCommit) {
    await appendQuorumRecord({
      recordType: "issuance_commit",
      epochId: epoch.issuanceEpochId,
      payload: { approvals: [...approvals], threshold: quorumThreshold() }
    });
  }
  await pgStore?.upsertIssuanceEpoch({ ...epoch, finalized: true });
  return true;
}

async function runIssuanceTick(): Promise<{ epoch?: IssuanceEpochRecord; allocations: IssuanceAllocationRecord[] }> {
  if (!pgStore) return { allocations: [] };
  const now = Date.now();
  const windowEndMs = now;
  const windowStartMs = now - ISSUANCE_WINDOW_MS;
  const shares = await pgStore.rollingContributionShares(windowStartMs, windowEndMs);
  if (shares.length === 0) return { allocations: [] };
  const status = queue.status();
  const cpuCapacity = Math.max(
    1,
    [...agentCapabilities.values()].reduce((sum, item) => sum + Math.max(1, item.maxConcurrentTasks), 0)
  );
  const gpuCapacity = Math.max(
    1,
    [...agentCapabilities.values()].filter((item) => item.localModelProvider === "ollama-local").length
  );
  const rawLoadIndex = computeLoadIndex({
    queuedTasks: status.queued,
    activeAgents: status.agents,
    cpuCapacity,
    gpuCapacity
  });
  smoothedLoadIndex = smoothLoadIndex(smoothedLoadIndex, rawLoadIndex, issuancePoolConfig.smoothingAlpha);
  const dailyPoolTokens = computeDailyPoolTokens(smoothedLoadIndex, issuancePoolConfig);
  const allocationInputs = computeHourlyIssuanceAllocations(shares, dailyPoolTokens);
  const totalWeightedContribution = shares.reduce((sum, item) => sum + item.weightedContribution, 0);
  const epoch: IssuanceEpochRecord = {
    issuanceEpochId: randomUUID(),
    coordinatorId: identity.peerId,
    windowStartMs,
    windowEndMs,
    loadIndex: smoothedLoadIndex,
    dailyPoolTokens,
    hourlyTokens: Number((dailyPoolTokens / 24).toFixed(6)),
    totalWeightedContribution: Number(totalWeightedContribution.toFixed(6)),
    contributionCount: shares.length,
    finalized: false,
    createdAtMs: now
  };
  await pgStore.upsertIssuanceEpoch(epoch);
  const allocations: IssuanceAllocationRecord[] = allocationInputs.map((item) => ({
    allocationId: randomUUID(),
    issuanceEpochId: epoch.issuanceEpochId,
    accountId: item.accountId,
    weightedContribution: item.weightedContribution,
    allocationShare: item.allocationShare,
    issuedTokens: item.issuedTokens,
    createdAtMs: now
  }));
  await pgStore.replaceIssuanceAllocations(epoch.issuanceEpochId, allocations);
  await appendQuorumRecord({
    recordType: "issuance_proposal",
    epochId: epoch.issuanceEpochId,
    payload: {
      windowStartMs,
      windowEndMs,
      dailyPoolTokens,
      loadIndex: smoothedLoadIndex
    }
  });
  await appendQuorumRecord({
    recordType: "issuance_vote",
    epochId: epoch.issuanceEpochId,
    payload: { vote: "approve", voterCoordinatorId: identity.peerId }
  });
  const finalized = await maybeFinalizeIssuanceEpoch(epoch);
  return {
    epoch: finalized ? { ...epoch, finalized: true } : epoch,
    allocations
  };
}

async function maybeAnchorLatestFinalizedEpoch(): Promise<BitcoinAnchorRecord | null> {
  if (!pgStore) return null;
  const epoch = await pgStore.latestIssuanceEpoch(true);
  if (!epoch) return null;
  const latestAnchor = await pgStore.latestAnchor();
  if (latestAnchor?.epochId === epoch.issuanceEpochId && latestAnchor.status === "anchored") return latestAnchor;
  const allocations = await pgStore.listIssuanceAllocations(epoch.issuanceEpochId);
  const checkpointHash = createHash("sha256")
    .update(JSON.stringify({ epoch, allocations }))
    .digest("hex");
  await appendQuorumRecord({
    recordType: "issuance_checkpoint",
    epochId: epoch.issuanceEpochId,
    payload: { checkpointHash, allocationCount: allocations.length }
  });
  const anchor: BitcoinAnchorRecord = {
    anchorId: randomUUID(),
    epochId: epoch.issuanceEpochId,
    checkpointHash,
    anchorNetwork: BITCOIN_NETWORK,
    txRef: `anchor:${BITCOIN_NETWORK}:${checkpointHash.slice(0, 24)}`,
    status: "anchored",
    anchoredAtMs: Date.now(),
    createdAtMs: Date.now()
  };
  await pgStore.upsertBitcoinAnchor(anchor);
  return anchor;
}

async function enforceContributionFirstPolicy(accountId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!pgStore) return { ok: true };
  const stats = await pgStore.creditContributionStats(accountId);
  const balance = await pgStore.creditBalance(accountId);
  if (balance >= CONTRIBUTION_BURST_CREDITS) return { ok: true };
  const ratio = stats.spent <= 0 ? Number.POSITIVE_INFINITY : stats.earned / stats.spent;
  if (ratio < MIN_CONTRIBUTION_RATIO) {
    return {
      ok: false,
      reason: `contribute_first_policy: earned=${stats.earned.toFixed(3)} spent=${stats.spent.toFixed(3)} ratio=${ratio.toFixed(3)}`
    };
  }
  return { ok: true };
}

async function allocateIntentPayouts(intent: PaymentIntent): Promise<IssuancePayoutEvent[]> {
  if (!pgStore) return [];
  const store = pgStore;
  const epoch = await store.latestIssuanceEpoch(true);
  if (!epoch) return [];
  const allocations = await store.listIssuanceAllocations(epoch.issuanceEpochId);
  if (allocations.length === 0) return [];
  const coordinatorShare = Math.max(0, Math.min(0.5, ISSUANCE_COORDINATOR_SHARE));
  const reserveShare = Math.max(0, Math.min(0.5, ISSUANCE_RESERVE_SHARE));
  const contributorShare = Math.max(0, 1 - coordinatorShare - reserveShare);
  const contributorPool = intent.netSats * contributorShare;
  const payoutEvents: IssuancePayoutEvent[] = [];
  for (const allocation of allocations) {
    payoutEvents.push({
      payoutEventId: randomUUID(),
      issuanceEpochId: epoch.issuanceEpochId,
      accountId: allocation.accountId,
      payoutType: "contributor",
      tokens: Number((contributorPool * allocation.allocationShare).toFixed(6)),
      sourceIntentId: intent.intentId,
      createdAtMs: Date.now()
    });
  }
  payoutEvents.push({
    payoutEventId: randomUUID(),
    issuanceEpochId: epoch.issuanceEpochId,
    accountId: COORDINATOR_FEE_ACCOUNT,
    payoutType: "coordinator_service",
    tokens: Number((intent.netSats * coordinatorShare).toFixed(6)),
    sourceIntentId: intent.intentId,
    createdAtMs: Date.now()
  });
  payoutEvents.push({
    payoutEventId: randomUUID(),
    issuanceEpochId: epoch.issuanceEpochId,
    accountId: `reserve:${identity.peerId}`,
    payoutType: "reserve",
    tokens: Number((intent.netSats * reserveShare).toFixed(6)),
    sourceIntentId: intent.intentId,
    createdAtMs: Date.now()
  });
  await Promise.all(payoutEvents.map((event) => store.persistIssuancePayoutEvent(event)));
  return payoutEvents;
}

async function settleIntent(intent: PaymentIntent, txRef: string): Promise<{ intent: PaymentIntent; feeEvent: CoordinatorFeeEvent }> {
  if (settledTxRefs.has(txRef)) {
    throw new Error("duplicate_tx_ref_rejected");
  }
  settledTxRefs.add(txRef);
  await adjustCredits(intent.accountId, intent.quotedCredits, `credit_purchase:${intent.intentId}`);
  const settled: PaymentIntent = {
    ...intent,
    status: "settled",
    settledAtMs: Date.now(),
    txRef
  };
  paymentIntents.set(settled.intentId, settled);
  await pgStore?.upsertPaymentIntent(settled);
  const feeEvent: CoordinatorFeeEvent = {
    eventId: randomUUID(),
    coordinatorId: identity.peerId,
    intentId: settled.intentId,
    feeWalletAccountId: COORDINATOR_FEE_ACCOUNT,
    feeSats: settled.coordinatorFeeSats,
    createdAtMs: Date.now()
  };
  await pgStore?.persistCoordinatorFeeEvent(feeEvent);
  await allocateIntentPayouts(settled);
  return { intent: settled, feeEvent };
}

function pairKey(a: string, b: string): string {
  return [a, b].sort().join("::");
}

function cleanupStaleTunnels(): number {
  const now = Date.now();
  let removed = 0;
  for (const [token, tunnel] of activeTunnels.entries()) {
    const stale = now - tunnel.lastRelayMs > TUNNEL_IDLE_TTL_MS;
    const invalidAgent =
      !agentCapabilities.has(tunnel.fromAgentId) || !agentCapabilities.has(tunnel.toAgentId);
    if (stale || invalidAgent) {
      activeTunnels.delete(token);
      tunnelByPairKey.delete(pairKey(tunnel.fromAgentId, tunnel.toAgentId));
      agentCapabilities.get(tunnel.fromAgentId)?.connectedPeers.delete(tunnel.toAgentId);
      agentCapabilities.get(tunnel.toAgentId)?.connectedPeers.delete(tunnel.fromAgentId);
      removed += 1;
    }
  }
  return removed;
}

const defaultPolicy: ExecutionPolicy = {
  cpuCapPercent: 50,
  memoryLimitMb: 2048,
  idleOnly: true,
  maxConcurrentTasks: 1,
  allowedHours: { startHourUtc: 22, endHourUtc: 6 }
};

const registerSchema = z.object({
  agentId: z.string(),
  deviceId: z.string().min(3).max(128).optional(),
  os: z.string().min(2),
  version: z.string(),
  mode: z.enum(["swarm-only", "ide-enabled"]),
  registrationToken: z.string().optional(),
  localModelProvider: z.enum(["edgecoder-local", "ollama-local"]).default("edgecoder-local"),
  clientType: z.string().min(1).max(64).default("edgecoder-native"),
  maxConcurrentTasks: z.number().int().min(1).max(64).default(1),
  powerTelemetry: z
    .object({
      onExternalPower: z.boolean().optional(),
      batteryLevelPct: z.number().min(0).max(100).optional(),
      lowPowerMode: z.boolean().optional(),
      updatedAtMs: z.number().optional()
    })
    .optional()
});

const heartbeatSchema = z.object({
  agentId: z.string(),
  powerTelemetry: z
    .object({
      onExternalPower: z.boolean().optional(),
      batteryLevelPct: z.number().min(0).max(100).optional(),
      lowPowerMode: z.boolean().optional(),
      updatedAtMs: z.number().optional()
    })
    .optional()
});
const diagnosticsSchema = z.object({
  agentId: z.string(),
  events: z
    .array(
      z.object({
        eventAtMs: z.number().optional(),
        message: z.string().min(1).max(500)
      })
    )
    .max(40),
  source: z.string().optional(),
  runtimeState: z.string().optional(),
  modelState: z.string().optional()
});

const taskSchema = z.object({
  taskId: z.string(),
  prompt: z.string().min(1),
  language: z.enum(["python", "javascript"]).default("python"),
  snapshotRef: z.string().min(1),
  submitterAccountId: z.string().default("anonymous"),
  projectId: z.string().default("default"),
  tenantId: z.string().optional(),
  resourceClass: z.enum(["cpu", "gpu"]).default("cpu"),
  priority: z.number().min(0).max(100).default(50)
});

const pullSchema = z.object({ agentId: z.string() });
const resultSchema = z.object({
  subtaskId: z.string(),
  taskId: z.string(),
  agentId: z.string(),
  ok: z.boolean(),
  output: z.string(),
  error: z.string().optional(),
  durationMs: z.number(),
  reportNonce: z.string().optional(),
  reportSignature: z.string().optional()
});

app.post("/register", async (req, reply) => {
  const body = registerSchema.parse(req.body);
  const now = Date.now();
  const sourceIp = extractClientIp((req as any).headers, (req as any).ip);
  const activation = await validatePortalNode({
    nodeId: body.agentId,
    nodeKind: "agent",
    registrationToken: body.registrationToken,
    deviceId: body.deviceId,
    sourceIp
  });
  if (!activation.allowed) {
    app.log.warn({ agentId: body.agentId, reason: activation.reason }, "register_denied");
    return reply.code(403).send({ error: "node_not_activated", reason: activation.reason });
  }
  app.log.info({ agentId: body.agentId, reason: activation.reason }, "register_allowed");
  const blacklisted = activeBlacklistRecord(body.agentId);
  if (blacklisted) {
    return reply.code(403).send({ error: "agent_blacklisted", reason: blacklisted.reason });
  }
  queue.registerAgent(body.agentId, defaultPolicy, {
    os: body.os,
    version: body.version,
    mode: body.mode,
    localModelEnabled: true
  });
  agentCapabilities.set(body.agentId, {
    os: body.os,
    version: body.version,
    mode: body.mode,
    localModelEnabled: true,
    localModelProvider: body.localModelProvider,
    localModelCatalog: body.localModelProvider === "ollama-local" ? [OLLAMA_MODEL] : ["edgecoder-default"],
    clientType: body.clientType,
    swarmEnabled: true,
    ideEnabled: body.mode === "ide-enabled",
    maxConcurrentTasks: body.maxConcurrentTasks,
    connectedPeers: agentCapabilities.get(body.agentId)?.connectedPeers ?? new Set<string>(),
    ownerEmail: activation.ownerEmail,
    sourceIp: activation.sourceIp ?? sourceIp,
    countryCode: activation.countryCode,
    vpnDetected: activation.vpnDetected,
    enrollmentReason: activation.reason,
    powerTelemetry: body.powerTelemetry
      ? {
          ...body.powerTelemetry,
          updatedAtMs: body.powerTelemetry.updatedAtMs ?? now
        }
      : undefined,
    lastSeenMs: now
  });
  const approvalRecord = ordering.append({
    eventType: "node_approval",
    taskId: `agent:${body.agentId}`,
    actorId: body.agentId,
    coordinatorId: identity.peerId,
    payloadJson: JSON.stringify({
      approved: true,
      activationReason: activation.reason ?? null,
      ownerEmail: activation.ownerEmail ?? null,
      sourceIp: activation.sourceIp ?? sourceIp ?? null,
      countryCode: activation.countryCode ?? null,
      vpnDetected: activation.vpnDetected ?? null
    })
  });
  try {
    const registerAuditPersistTimeoutMs = 3_000;
    await Promise.race([
      Promise.all([
        pgStore?.persistLedgerRecord(approvalRecord),
        persistStatsLedgerRecord(approvalRecord)
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("register_audit_persist_timeout")), registerAuditPersistTimeoutMs)
      )
    ]);
  } catch (error) {
    app.log.warn({ error, agentId: body.agentId }, "register_audit_persist_failed");
  }
  return reply.send({
    accepted: true,
    policy: defaultPolicy,
    mode: body.mode,
    meshToken: MESH_AUTH_TOKEN || undefined
  });
});

app.post("/heartbeat", async (req, reply) => {
  const body = heartbeatSchema.parse(req.body);
  const now = Date.now();
  if (!agentCapabilities.has(body.agentId)) {
    return reply.code(401).send({ error: "mesh_unauthorized", reason: "agent_not_registered" });
  }
  const blacklisted = activeBlacklistRecord(body.agentId);
  if (blacklisted) {
    return reply.send({
      ok: false,
      blacklisted: true,
      reason: blacklisted.reason,
      blacklistVersion
    });
  }
  queue.heartbeat(body.agentId);
  if (body.powerTelemetry) {
    const existing = agentCapabilities.get(body.agentId);
    if (existing) {
      existing.powerTelemetry = {
        ...body.powerTelemetry,
        updatedAtMs: body.powerTelemetry.updatedAtMs ?? now
      };
      existing.lastSeenMs = now;
      agentCapabilities.set(body.agentId, existing);
    }
  } else {
    const existing = agentCapabilities.get(body.agentId);
    if (existing) {
      existing.lastSeenMs = now;
      agentCapabilities.set(body.agentId, existing);
    }
  }
  const requeued = queue.requeueStale(30_000);
  const tunnelInvites = pendingTunnelInvites.get(body.agentId) ?? [];
  pendingTunnelInvites.set(body.agentId, []);
  const tunnelCloseNotices = pendingTunnelCloseNotices.get(body.agentId) ?? [];
  pendingTunnelCloseNotices.set(body.agentId, []);
  const directOfferIds = directWorkInbox.get(body.agentId) ?? [];
  const directWorkOffers = directOfferIds
    .map((id) => directWorkById.get(id))
    .filter((offer): offer is DirectWorkOffer => Boolean(offer && offer.status === "offered"));
  return reply.send({
    ok: true,
    requeued,
    policy: defaultPolicy,
    orchestration: agentOrchestration.get(body.agentId) ?? null,
    tunnelInvites,
    tunnelCloseNotices,
    directWorkOffers,
    blacklist: {
      version: blacklistVersion,
      agents: [...blacklistByAgent.keys()]
    }
  });
});

app.post("/agent/diagnostics", async (req, reply) => {
  const body = diagnosticsSchema.parse(req.body);
  if (!agentCapabilities.has(body.agentId)) {
    return reply.code(401).send({ error: "mesh_unauthorized", reason: "agent_not_registered" });
  }
  const existing = diagnosticsByAgentId.get(body.agentId) ?? [];
  const normalizedEvents = body.events.map((event) => ({
    eventAtMs: Number(event.eventAtMs ?? Date.now()),
    message: event.message
  }));
  const merged = [...existing, ...normalizedEvents].slice(-200);
  diagnosticsByAgentId.set(body.agentId, merged);
  const last = normalizedEvents.at(-1);
  app.log.info(
    {
      agentId: body.agentId,
      source: body.source ?? "unknown",
      runtimeState: body.runtimeState,
      modelState: body.modelState,
      eventCount: normalizedEvents.length,
      lastEvent: last?.message
    },
    "agent_diagnostics"
  );
  return reply.send({ ok: true, stored: merged.length });
});

app.get("/agent/diagnostics/:agentId", async (req, reply) => {
  const meshAuthorized = hasMeshToken((req as any).headers ?? {});
  const portalAuthorized = hasPortalServiceToken((req as any).headers ?? {});
  if (!meshAuthorized && !portalAuthorized) {
    return reply.code(401).send({ error: "diagnostics_access_unauthorized" });
  }
  const params = z.object({ agentId: z.string().min(1) }).parse(req.params);
  const events = diagnosticsByAgentId.get(params.agentId) ?? [];
  const sorted = [...events].sort((a, b) => Number(b.eventAtMs) - Number(a.eventAtMs));
  return reply.send({
    ok: true,
    agentId: params.agentId,
    events: sorted.slice(0, 200),
    count: sorted.length,
    latestEventAtMs: sorted.length > 0 ? sorted[0].eventAtMs : undefined
  });
});

app.post("/submit", async (req, reply) => {
  const body = taskSchema.parse(req.body);
  if (body.submitterAccountId !== "anonymous") {
    const policy = await enforceContributionFirstPolicy(body.submitterAccountId);
    if (!policy.ok) {
      return reply.code(403).send({ error: "contribute_first_required", detail: policy.reason });
    }
    try {
      // Spend credits when using public mesh resources.
      await spendCredits(body.submitterAccountId, 1, "task_submit", body.taskId);
    } catch {
      return reply.code(402).send({ error: "insufficient_credits" });
    }
  }

  const decomposeBody = JSON.stringify(body);
  const decomposeBodySha256 = createHash("sha256").update(decomposeBody).digest("hex");
  const decomposeTimestampMs = Date.now();
  const decomposeNonce = randomUUID();
  const decomposeSignaturePayload = JSON.stringify({
    peerId: identity.peerId,
    method: "POST",
    path: "/decompose",
    timestampMs: decomposeTimestampMs,
    nonce: decomposeNonce,
    bodySha256: decomposeBodySha256
  });
  const decomposeSignature = signPayload(decomposeSignaturePayload, coordinatorKeys.privateKeyPem);

  const decomposeHeaders: Record<string, string> = {
    "content-type": "application/json"
  };
  if (INFERENCE_AUTH_TOKEN) {
    decomposeHeaders["x-inference-token"] = INFERENCE_AUTH_TOKEN;
  }
  decomposeHeaders["x-coordinator-peer-id"] = identity.peerId;
  decomposeHeaders["x-inference-timestamp-ms"] = String(decomposeTimestampMs);
  decomposeHeaders["x-inference-nonce"] = decomposeNonce;
  decomposeHeaders["x-inference-body-sha256"] = decomposeBodySha256;
  decomposeHeaders["x-inference-signature"] = decomposeSignature;
  const decompose = await request(`${INFERENCE_URL}/decompose`, {
    method: "POST",
    headers: decomposeHeaders,
    body: decomposeBody
  });

  if (decompose.statusCode < 200 || decompose.statusCode >= 300) {
    return reply.code(502).send({ error: "inference_service_unavailable" });
  }

  const payload = (await decompose.body.json()) as {
    subtasks: Array<{
      taskId: string;
      kind: "micro_loop" | "single_step";
      input: string;
      language: "python" | "javascript";
      timeoutMs: number;
      snapshotRef: string;
    }>;
  };

  const enqueueRecord = ordering.append({
    eventType: "task_enqueue",
    taskId: body.taskId,
    actorId: body.submitterAccountId
  });
  await pgStore?.persistLedgerRecord(enqueueRecord);
  await persistStatsLedgerRecord(enqueueRecord);

  const created = payload.subtasks.map((subtask) =>
    queue.enqueueSubtask({
      ...subtask,
      projectMeta: {
        projectId: body.projectId,
        tenantId: body.tenantId,
        resourceClass: body.resourceClass as ResourceClass,
        priority: body.priority
      }
    })
  );

  const message = protocol.createMessage(
    "queue_summary",
    identity.peerId,
    { taskId: body.taskId, queued: created.length, projectId: body.projectId },
    coordinatorKeys.privateKeyPem
  );
  void mesh.broadcast(message);

  return reply.send({ taskId: body.taskId, subtasks: created.map((s) => s.id) });
});

app.post("/pull", async (req, reply) => {
  const body = pullSchema.parse(req.body);
  if (!agentCapabilities.has(body.agentId)) {
    return reply.code(401).send({ error: "mesh_unauthorized", reason: "agent_not_registered" });
  }
  const blacklisted = activeBlacklistRecord(body.agentId);
  if (blacklisted) {
    return reply.send({ subtask: null, blocked: true, reason: blacklisted.reason });
  }
  const capability = agentCapabilities.get(body.agentId);
  if (capability) {
    const decision = evaluateAgentPowerPolicy({
      os: capability.os,
      telemetry: capability.powerTelemetry,
      nowMs: Date.now(),
      lastTaskAssignedAtMs: lastTaskAssignedByAgent.get(body.agentId),
      batteryPullMinIntervalMs: IOS_BATTERY_PULL_MIN_INTERVAL_MS,
      batteryTaskStopLevelPct: IOS_BATTERY_TASK_STOP_LEVEL_PCT
    });
    if (!decision.allowCoordinatorTasks) {
      return reply.send({ subtask: null, powerDeferred: true, reason: decision.reason });
    }
  }
  const task = queue.claim(body.agentId);
  if (task) {
    lastTaskAssignedByAgent.set(body.agentId, Date.now());
    const claimRecord = ordering.append({
      eventType: "task_claim",
      taskId: task.taskId,
      subtaskId: task.id,
      actorId: body.agentId
    });
    await pgStore?.persistLedgerRecord(claimRecord);
    await persistStatsLedgerRecord(claimRecord);
  }
  return reply.send({ subtask: task ?? null });
});

app.post("/result", async (req, reply) => {
  const body = resultSchema.parse(req.body);
  const blacklisted = activeBlacklistRecord(body.agentId);
  if (blacklisted) {
    return reply.code(403).send({ error: "agent_blacklisted", reason: blacklisted.reason });
  }
  const subtask = queue.getSubtask(body.subtaskId);
  queue.complete(body);
  const completeRecord = ordering.append({
    eventType: "task_complete",
    taskId: body.taskId,
    subtaskId: body.subtaskId,
    actorId: body.agentId
  });
  await pgStore?.persistLedgerRecord(completeRecord);
  await persistStatsLedgerRecord(completeRecord);

  if (subtask) {
    const rewardAccountId = await rewardAccountForAgent(body.agentId);
    const accrualCredits = body.ok ? 5 : 2;
    await accrueCredits(
      {
        reportId: randomUUID(),
        agentId: rewardAccountId,
        sourceAgentId: body.agentId,
        taskId: body.taskId,
        resourceClass: subtask.projectMeta.resourceClass,
        cpuSeconds: subtask.projectMeta.resourceClass === "cpu" ? body.durationMs / 1000 : 0,
        gpuSeconds: subtask.projectMeta.resourceClass === "gpu" ? body.durationMs / 1000 : 0,
        success: body.ok,
        qualityScore: body.ok ? 1.0 : 0.6,
        timestampMs: Date.now()
      },
      {
        queuedTasks: queue.status().queued,
        activeAgents: queue.status().agents
      }
    );
    const earningsRecord = ordering.append({
      eventType: "earnings_accrual",
      taskId: body.taskId,
      subtaskId: body.subtaskId,
      actorId: rewardAccountId,
      coordinatorId: identity.peerId,
      payloadJson: JSON.stringify({
        sourceAgentId: body.agentId,
        accountId: rewardAccountId,
        credits: accrualCredits,
        durationMs: body.durationMs,
        ok: body.ok,
        resourceClass: subtask.projectMeta.resourceClass
      })
    });
    await pgStore?.persistLedgerRecord(earningsRecord);
    await persistStatsLedgerRecord(earningsRecord);
  }

  const message = protocol.createMessage(
    "result_announce",
    identity.peerId,
    { taskId: body.taskId, subtaskId: body.subtaskId, ok: body.ok },
    coordinatorKeys.privateKeyPem
  );
  void mesh.broadcast(message);
  return reply.send({ ok: true });
});

app.get("/status", async () => queue.status());
app.get("/health/runtime", async () => {
  const status = queue.status();
  const ollamaHost = OLLAMA_HOST ?? "http://127.0.0.1:11434";
  let ollamaReachable = false;
  let ollamaVersion: string | null = null;
  let ollamaModelCount = 0;
  let ollamaError: string | null = null;

  try {
    const versionRes = await request(`${ollamaHost}/api/version`, { method: "GET" });
    if (versionRes.statusCode >= 200 && versionRes.statusCode < 300) {
      const payload = (await versionRes.body.json()) as { version?: string };
      ollamaReachable = true;
      ollamaVersion = payload.version ?? null;
    }
  } catch (error) {
    ollamaError = String(error);
  }

  try {
    const tagsRes = await request(`${ollamaHost}/api/tags`, { method: "GET" });
    if (tagsRes.statusCode >= 200 && tagsRes.statusCode < 300) {
      const payload = (await tagsRes.body.json()) as { models?: Array<{ name?: string }> };
      ollamaReachable = true;
      ollamaModelCount = payload.models?.length ?? 0;
    }
  } catch (error) {
    if (!ollamaError) ollamaError = String(error);
  }

  return {
    ok: true,
    coordinator: {
      provider: coordinatorProvider,
      queued: status.queued,
      agents: status.agents,
      results: status.results
    },
    ollama: {
      expectedProvider: PROVIDER,
      host: ollamaHost,
      reachable: ollamaReachable,
      version: ollamaVersion,
      modelCount: ollamaModelCount,
      error: ollamaError
    }
  };
});
app.get("/features", async () => ({
  public_mesh: networkMode === "public_mesh",
  enterprise_overlay: networkMode === "enterprise_overlay"
}));
app.get("/capacity", async () => {
  const agents = [...agentCapabilities.entries()].map(([agentId, info]) => {
    const powerDecision = evaluateAgentPowerPolicy({
      os: info.os,
      telemetry: info.powerTelemetry,
      nowMs: Date.now(),
      lastTaskAssignedAtMs: lastTaskAssignedByAgent.get(agentId),
      batteryPullMinIntervalMs: IOS_BATTERY_PULL_MIN_INTERVAL_MS,
      batteryTaskStopLevelPct: IOS_BATTERY_TASK_STOP_LEVEL_PCT
    });
    const orch = agentOrchestration.get(agentId);
    const recentDiagnostics = diagnosticsByAgentId.get(agentId) ?? [];
    const lastDiagnostic = recentDiagnostics.at(-1);
    return {
      agentId,
      ...info,
      connectedPeers: [...info.connectedPeers],
      blacklisted: Boolean(activeBlacklistRecord(agentId)),
      powerPolicy: powerDecision,
      lastSeenMs: info.lastSeenMs,
      orchestrationStatus: orch?.pending && orch?.status ? orch.status : undefined,
      diagnostics: lastDiagnostic
        ? {
            lastEventAtMs: lastDiagnostic.eventAtMs,
            lastEventMessage: lastDiagnostic.message,
            recentCount: recentDiagnostics.length
          }
        : undefined
    };
  });
  const totalCapacity = agents.reduce((sum, a) => sum + a.maxConcurrentTasks, 0);
  return {
    totals: {
      agentsConnected: agents.length,
      totalCapacity,
      swarmEnabledCount: agents.filter((a) => a.swarmEnabled).length,
      localOllamaCount: agents.filter((a) => a.localModelProvider === "ollama-local").length,
      ideEnabledCount: agents.filter((a) => a.ideEnabled).length,
      activeTunnels: activeTunnels.size,
      peerDirectAccepted: [...directWorkById.values()].filter((w) => w.status === "accepted").length,
      peerDirectCompleted: [...directWorkById.values()].filter((w) => w.status === "completed").length,
      blacklistedAgents: [...blacklistByAgent.keys()].filter((agentId) => Boolean(activeBlacklistRecord(agentId)))
        .length
    },
    agents
  };
});

app.get("/economy/price/current", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const cpu = latestPriceEpochByResource.get("cpu");
  const gpu = latestPriceEpochByResource.get("gpu");
  return { cpu, gpu };
});

app.get("/economy/credits/:accountId/quote", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const params = z.object({ accountId: z.string().min(1) }).parse(req.params);
  const currentCpu = latestPriceEpochByResource.get("cpu");
  const satsPerCredit = currentCpu?.pricePerComputeUnitSats ?? 30;
  const balance = pgStore ? await pgStore.creditBalance(params.accountId) : creditEngine.balance(params.accountId);
  return {
    accountId: params.accountId,
    credits: Number(balance.toFixed(3)),
    satsPerCredit,
    estimatedSats: satsForCredits(balance, satsPerCredit),
    quoteSource: currentCpu ? "price_epoch" : "default_floor",
    quotedAtMs: Date.now()
  };
});

app.get("/economy/price/quote", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const query = z
    .object({
      resourceClass: z.enum(["cpu", "gpu"]).default("cpu"),
      cpuCapacity: z.coerce.number().nonnegative().default(Math.max(1, queue.status().agents)),
      gpuCapacity: z.coerce.number().nonnegative().default(0),
      queuedTasks: z.coerce.number().nonnegative().default(queue.status().queued),
      activeAgents: z.coerce.number().nonnegative().default(queue.status().agents)
    })
    .parse(req.query);
  const computed = computeDynamicPricePerComputeUnitSats(query.resourceClass, {
    cpuCapacity: query.cpuCapacity,
    gpuCapacity: query.gpuCapacity,
    queuedTasks: query.queuedTasks,
    activeAgents: query.activeAgents
  });
  const payload = JSON.stringify({
    resourceClass: query.resourceClass,
    computed,
    coordinatorId: identity.peerId,
    createdAtMs: Date.now()
  });
  return {
    coordinatorId: identity.peerId,
    resourceClass: query.resourceClass,
    pricePerComputeUnitSats: computed,
    reputationWeight: peerScore.get(identity.peerId) ?? 120,
    signature: signPayload(payload, coordinatorKeys.privateKeyPem)
  };
});

app.post("/economy/price/propose", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z
    .object({
      coordinatorId: z.string(),
      cpuCapacity: z.number().nonnegative(),
      gpuCapacity: z.number().nonnegative(),
      queuedTasks: z.number().nonnegative(),
      activeAgents: z.number().nonnegative()
    })
    .parse(req.body);
  if (!isApprovedCoordinator(body.coordinatorId)) {
    return reply.code(403).send({ error: "coordinator_not_approved" });
  }
  const now = Date.now();
  const resources: ResourceClass[] = ["cpu", "gpu"];
  const created: PriceEpochRecord[] = [];
  for (const resourceClass of resources) {
    const pricePerComputeUnitSats = computeDynamicPricePerComputeUnitSats(resourceClass, {
      cpuCapacity: body.cpuCapacity,
      gpuCapacity: body.gpuCapacity,
      queuedTasks: body.queuedTasks,
      activeAgents: body.activeAgents
    });
    const payload = JSON.stringify({
      resourceClass,
      pricePerComputeUnitSats,
      coordinatorId: identity.peerId,
      createdAtMs: now
    });
    const epoch: PriceEpochRecord = {
      epochId: randomUUID(),
      coordinatorId: identity.peerId,
      resourceClass,
      pricePerComputeUnitSats,
      supplyIndex: resourceClass === "gpu" ? body.gpuCapacity : body.cpuCapacity,
      demandIndex: body.queuedTasks + body.activeAgents,
      negotiatedWith: [body.coordinatorId],
      signature: signPayload(payload, coordinatorKeys.privateKeyPem),
      createdAtMs: now
    };
    latestPriceEpochByResource.set(resourceClass, epoch);
    await pgStore?.upsertPriceEpoch(epoch);
    created.push(epoch);
  }
  return { ok: true, epochs: created };
});

app.post("/economy/price/consensus", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z
    .object({
      cpuCapacity: z.number().nonnegative(),
      gpuCapacity: z.number().nonnegative(),
      queuedTasks: z.number().nonnegative(),
      activeAgents: z.number().nonnegative()
    })
    .parse(req.body);
  const peers = mesh.listPeers().filter((p) => isApprovedCoordinator(p.peerId));
  const localWeight = Math.max(1, peerScore.get(identity.peerId) ?? 120);

  const negotiate = async (resourceClass: ResourceClass) => {
    const localPrice = computeDynamicPricePerComputeUnitSats(resourceClass, body);
    const quotes: Array<{ coordinatorId: string; value: number; weight: number }> = [
      { coordinatorId: identity.peerId, value: localPrice, weight: localWeight }
    ];
    await Promise.all(
      peers.map(async (peer) => {
        try {
          const url = new URL(`${peer.coordinatorUrl}/economy/price/quote`);
          url.searchParams.set("resourceClass", resourceClass);
          url.searchParams.set("cpuCapacity", String(body.cpuCapacity));
          url.searchParams.set("gpuCapacity", String(body.gpuCapacity));
          url.searchParams.set("queuedTasks", String(body.queuedTasks));
          url.searchParams.set("activeAgents", String(body.activeAgents));
          const res = await request(url.toString(), {
            method: "GET",
            headers: MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : undefined
          });
          if (res.statusCode < 200 || res.statusCode >= 300) return;
          const quote = (await res.body.json()) as {
            coordinatorId: string;
            pricePerComputeUnitSats: number;
            reputationWeight?: number;
          };
          quotes.push({
            coordinatorId: quote.coordinatorId,
            value: quote.pricePerComputeUnitSats,
            weight: Math.max(1, Math.min(500, quote.reputationWeight ?? (peerScore.get(peer.peerId) ?? 100)))
          });
        } catch {
          return;
        }
      })
    );
    const finalPrice = weightedMedian(quotes.map((q) => ({ value: q.value, weight: q.weight })));
    const now = Date.now();
    const payload = JSON.stringify({
      resourceClass,
      pricePerComputeUnitSats: finalPrice,
      coordinatorId: identity.peerId,
      createdAtMs: now
    });
    const epoch: PriceEpochRecord = {
      epochId: randomUUID(),
      coordinatorId: identity.peerId,
      resourceClass,
      pricePerComputeUnitSats: finalPrice,
      supplyIndex: resourceClass === "gpu" ? body.gpuCapacity : body.cpuCapacity,
      demandIndex: body.queuedTasks + body.activeAgents,
      negotiatedWith: [...new Set(quotes.map((q) => q.coordinatorId))],
      signature: signPayload(payload, coordinatorKeys.privateKeyPem),
      createdAtMs: now
    };
    latestPriceEpochByResource.set(resourceClass, epoch);
    await pgStore?.upsertPriceEpoch(epoch);
    return { epoch, quotes };
  };

  const [cpu, gpu] = await Promise.all([negotiate("cpu"), negotiate("gpu")]);
  return { ok: true, cpu, gpu };
});

app.post("/economy/payments/intents", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z
    .object({
      accountId: z.string(),
      walletType: z.enum(["lightning", "onchain"]).default("lightning"),
      amountSats: z.number().int().positive().max(100000000)
    })
    .parse(req.body);
  const currentCpu = latestPriceEpochByResource.get("cpu");
  const satsPerCredit = currentCpu?.pricePerComputeUnitSats ?? 30;
  const feeSats = Math.floor((body.amountSats * COORDINATOR_FEE_BPS) / 10000);
  const netSats = Math.max(0, body.amountSats - feeSats);
  const invoice = await lightningProvider.createInvoice({
    amountSats: body.amountSats,
    memo: `edgecoder_credits:${body.accountId}`,
    expiresInSeconds: Math.floor(PAYMENT_INTENT_TTL_MS / 1000)
  });
  const intent: PaymentIntent = {
    intentId: randomUUID(),
    accountId: body.accountId,
    coordinatorId: identity.peerId,
    walletType: body.walletType as WalletType,
    network: BITCOIN_NETWORK,
    invoiceRef: invoice.invoiceRef,
    amountSats: body.amountSats,
    coordinatorFeeBps: COORDINATOR_FEE_BPS,
    coordinatorFeeSats: feeSats,
    netSats,
    quotedCredits: creditsForSats(netSats, satsPerCredit),
    status: "created",
    createdAtMs: Date.now()
  };
  paymentIntents.set(intent.intentId, intent);
  await pgStore?.upsertPaymentIntent(intent);
  return { ok: true, intent };
});

app.get("/economy/payments/intents/:intentId", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const params = z.object({ intentId: z.string() }).parse(req.params);
  const inMemory = paymentIntents.get(params.intentId);
  const fromDb = await pgStore?.getPaymentIntent(params.intentId);
  const intent = inMemory ?? fromDb;
  if (!intent) return reply.code(404).send({ error: "intent_not_found" });
  return { intent };
});

app.post("/economy/payments/intents/:intentId/confirm", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const params = z.object({ intentId: z.string() }).parse(req.params);
  const body = z.object({ txRef: z.string().min(4) }).parse(req.body);
  const intent = paymentIntents.get(params.intentId) ?? (await pgStore?.getPaymentIntent(params.intentId));
  if (!intent) return reply.code(404).send({ error: "intent_not_found" });
  if (intent.status === "settled") return { ok: true, intent };
  if (intent.status === "expired") return reply.code(409).send({ error: "intent_expired" });

  const { intent: settled, feeEvent } = await settleIntent(intent, body.txRef);
  return { ok: true, intent: settled, feeEvent };
});

app.post("/economy/payments/webhook", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  if (PAYMENT_WEBHOOK_SECRET) {
    const provided = (req.headers as Record<string, unknown>)["x-payment-webhook-secret"];
    if (provided !== PAYMENT_WEBHOOK_SECRET) {
      return reply.code(401).send({ error: "webhook_signature_required" });
    }
  }
  const body = z
    .object({
      invoiceRef: z.string().min(8),
      settled: z.boolean(),
      txRef: z.string().optional()
    })
    .parse(req.body);
  const match =
    [...paymentIntents.values()].find((intent) => intent.invoiceRef === body.invoiceRef) ??
    (await (async () => {
      const pending = await pgStore?.listPendingPaymentIntents(500);
      return (pending ?? []).find((intent) => intent.invoiceRef === body.invoiceRef);
    })());
  if (!match) return reply.code(404).send({ error: "intent_not_found" });
  if (!body.settled) return reply.send({ ok: true, ignored: true });
  if (match.status === "settled") return reply.send({ ok: true, alreadySettled: true });
  const settled = await settleIntent(match, body.txRef ?? `webhook:${randomUUID()}`);
  return reply.send({ ok: true, intent: settled.intent, feeEvent: settled.feeEvent });
});

app.post("/economy/payments/reconcile", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const pending = pgStore ? await pgStore.listPendingPaymentIntents(500) : [...paymentIntents.values()];
  let settledCount = 0;
  let expiredCount = 0;
  for (const intent of pending) {
    if (intent.status !== "created") continue;
    const tooOld = Date.now() - intent.createdAtMs > PAYMENT_INTENT_TTL_MS;
    if (tooOld) {
      const expired: PaymentIntent = {
        ...intent,
        status: "expired"
      };
      paymentIntents.set(expired.intentId, expired);
      await pgStore?.upsertPaymentIntent(expired);
      expiredCount += 1;
      continue;
    }
    const settlement = await lightningProvider.checkSettlement(intent.invoiceRef).catch(() => ({ settled: false }));
    if (settlement.settled) {
      const txRef = "txRef" in settlement ? settlement.txRef : undefined;
      await settleIntent(intent, txRef ?? `reconcile:${randomUUID()}`);
      settledCount += 1;
    }
  }
  return reply.send({ ok: true, scanned: pending.length, settledCount, expiredCount });
});

app.post("/economy/treasury/policies", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z
    .object({
      treasuryAccountId: z.string().min(3),
      multisigDescriptor: z.string().min(12),
      quorumThreshold: z.number().int().positive(),
      totalCustodians: z.number().int().positive(),
      approvedCoordinatorIds: z.array(z.string()).default([]),
      keyRotationDays: z.number().int().positive().default(90),
      requestedBy: z.string().default(identity.peerId)
    })
    .parse(req.body);
  if (body.quorumThreshold > body.totalCustodians) {
    return reply.code(400).send({ error: "invalid_quorum_threshold" });
  }
  const created = createTreasuryPolicy(body);
  treasuryPolicy = created;
  await pgStore?.upsertTreasuryPolicy(created);
  const event = signKeyCustodyEvent({
    policyId: created.policyId,
    actorId: body.requestedBy,
    action: "create_policy",
    details: `treasury=${created.treasuryAccountId};quorum=${created.quorumThreshold}/${created.totalCustodians}`,
    privateKeyPem: coordinatorKeys.privateKeyPem
  });
  keyCustodyEvents.unshift(event);
  await pgStore?.persistKeyCustodyEvent(event);
  return reply.send({ ok: true, policy: created, event });
});

app.post("/economy/treasury/policies/:policyId/activate", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const params = z.object({ policyId: z.string() }).parse(req.params);
  const body = z.object({ requestedBy: z.string().default(identity.peerId) }).parse(req.body);
  if (!treasuryPolicy || treasuryPolicy.policyId !== params.policyId) {
    return reply.code(404).send({ error: "policy_not_found" });
  }
  treasuryPolicy = {
    ...treasuryPolicy,
    status: "active",
    updatedAtMs: Date.now()
  };
  await pgStore?.upsertTreasuryPolicy(treasuryPolicy);
  const event = signKeyCustodyEvent({
    policyId: treasuryPolicy.policyId,
    actorId: body.requestedBy,
    action: "activate_policy",
    details: `policy_activated`,
    privateKeyPem: coordinatorKeys.privateKeyPem
  });
  keyCustodyEvents.unshift(event);
  await pgStore?.persistKeyCustodyEvent(event);
  return reply.send({ ok: true, policy: treasuryPolicy, event });
});

app.get("/economy/treasury", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const policy = treasuryPolicy ?? (await pgStore?.latestTreasuryPolicy()) ?? null;
  const events =
    policy != null
      ? (await pgStore?.listKeyCustodyEvents(policy.policyId, 100)) ?? keyCustodyEvents.slice(0, 100)
      : [];
  return reply.send({ policy, events });
});

app.post("/economy/issuance/recalculate", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const result = await runIssuanceTick();
  return { ok: true, epoch: result.epoch ?? null, allocations: result.allocations.length };
});

app.get("/economy/issuance/current", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const epoch = await pgStore?.latestIssuanceEpoch(false);
  if (!epoch || !pgStore) return { epoch: null, allocations: [] };
  const allocations = await pgStore.listIssuanceAllocations(epoch.issuanceEpochId);
  return { epoch, allocations };
});

app.get("/economy/issuance/history", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(48) }).parse(req.query);
  const epochs = (await pgStore?.listIssuanceEpochs(query.limit)) ?? [];
  return { epochs };
});

app.get("/economy/issuance/rolling/:accountId", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  if (!pgStore) return { accountId: null, shares: [] };
  const params = z.object({ accountId: z.string().min(1) }).parse(req.params);
  const now = Date.now();
  const shares = await pgStore.rollingContributionShares(now - ISSUANCE_WINDOW_MS, now);
  const account = shares.find((item) => item.accountId === params.accountId) ?? null;
  return { accountId: params.accountId, windowMs: ISSUANCE_WINDOW_MS, account };
});

app.post("/economy/issuance/quorum/vote", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z
    .object({
      epochId: z.string(),
      vote: z.enum(["approve", "reject"])
    })
    .parse(req.body);
  const record = await appendQuorumRecord({
    recordType: "issuance_vote",
    epochId: body.epochId,
    payload: {
      vote: body.vote,
      voterCoordinatorId: identity.peerId
    }
  });
  const epoch = await pgStore?.getIssuanceEpoch(body.epochId);
  if (epoch) {
    await maybeFinalizeIssuanceEpoch(epoch);
  }
  return { ok: true, record };
});

app.get("/economy/issuance/quorum/:epochId", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const params = z.object({ epochId: z.string() }).parse(req.params);
  const records = (await pgStore?.listQuorumLedgerByEpoch(params.epochId)) ?? [];
  return { epochId: params.epochId, records };
});

app.post("/economy/issuance/anchor", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const anchor = await maybeAnchorLatestFinalizedEpoch();
  return { ok: true, anchor };
});

app.get("/economy/issuance/anchors", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const anchors = (await pgStore?.listAnchors(50)) ?? [];
  return { anchors };
});

app.post("/economy/issuance/reconcile", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  if (!pgStore) return { ok: true, scannedIntents: 0, payoutEvents: 0, drift: 0 };
  const intents = [...paymentIntents.values()];
  const payoutEvents = await pgStore.listIssuancePayoutEvents(undefined, 2000);
  const eventIntentIds = new Set(payoutEvents.map((item) => item.sourceIntentId).filter(Boolean));
  const settledIntentCount = intents.filter((item) => item.status === "settled").length;
  const drift = intents.filter((item) => item.status === "settled" && !eventIntentIds.has(item.intentId)).length;
  return { ok: true, scannedIntents: intents.length, settledIntentCount, payoutEvents: payoutEvents.length, drift };
});

app.get("/identity", async () => identity);
app.get("/mesh/peers", async () => ({ peers: mesh.listPeers() }));

const peerSchema = z.object({
  peerId: z.string(),
  publicKeyPem: z.string(),
  coordinatorUrl: z.string().url(),
  networkMode: z.enum(["public_mesh", "enterprise_overlay"]),
  registrationToken: z.string().optional()
});

app.post("/mesh/register-peer", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = peerSchema.parse(req.body);
  const sourceIp = extractClientIp((req as any).headers, (req as any).ip);
  const activation = await validatePortalNode({
    nodeId: body.peerId,
    nodeKind: "coordinator",
    registrationToken: body.registrationToken,
    sourceIp
  });
  if (!activation.allowed) {
    return reply.code(403).send({ error: "coordinator_not_activated", reason: activation.reason });
  }
  if (PORTAL_SERVICE_URL && !activation.ownerEmail) {
    return reply.code(403).send({ error: "coordinator_not_activated", reason: "owner_email_required" });
  }
  mesh.addPeer(body as MeshPeerIdentity);
  peerScore.set(body.peerId, 100);
  const approvalRecord = ordering.append({
    eventType: "node_approval",
    taskId: `coordinator:${body.peerId}`,
    actorId: body.peerId,
    coordinatorId: identity.peerId,
    payloadJson: JSON.stringify({
      approved: true,
      activationReason: activation.reason ?? null,
      ownerEmail: activation.ownerEmail ?? null,
      sourceIp: sourceIp ?? null
    })
  });
  await pgStore?.persistLedgerRecord(approvalRecord);
  await persistStatsLedgerRecord(approvalRecord);
  return reply.send({ ok: true, peerCount: mesh.listPeers().length });
});

app.post("/mesh/ingest", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const message = z
    .object({
      id: z.string(),
      type: z.enum([
        "peer_announce",
        "queue_summary",
        "task_offer",
        "task_claim",
        "result_announce",
        "ordering_snapshot",
        "blacklist_update",
        "issuance_proposal",
        "issuance_vote",
        "issuance_commit",
        "issuance_checkpoint"
      ]),
      fromPeerId: z.string(),
      issuedAtMs: z.number(),
      ttlMs: z.number(),
      payload: z.record(z.string(), z.unknown()),
      signature: z.string()
    })
    .parse(req.body);
  const peer = mesh.listPeers().find((p) => p.peerId === message.fromPeerId);
  if (!peer) return reply.code(404).send({ error: "peer_unknown" });

  const now = Date.now();
  const windowStart = now - (now % 10_000);
  const window = peerMessageWindow.get(peer.peerId);
  if (!window || window.windowMs !== windowStart) {
    peerMessageWindow.set(peer.peerId, { windowMs: windowStart, count: 1 });
  } else {
    window.count += 1;
    if (window.count > MESH_RATE_LIMIT_PER_10S) {
      peerScore.set(peer.peerId, Math.max(0, (peerScore.get(peer.peerId) ?? 100) - 10));
      return reply.code(429).send({ error: "peer_rate_limited" });
    }
  }

  const validation = protocol.validateMessage(message, peer.publicKeyPem);
  if (!validation.ok) {
    peerScore.set(peer.peerId, Math.max(0, (peerScore.get(peer.peerId) ?? 100) - 5));
    return reply.code(400).send({ error: validation.reason });
  }
  if (message.type === "blacklist_update") {
    const payload = z
      .object({
        eventId: z.string(),
        agentId: z.string(),
        reasonCode: z.enum([
          "abuse_spam",
          "abuse_malware",
          "policy_violation",
          "credential_abuse",
          "dos_behavior",
          "forged_results",
          "manual_review"
        ]),
        reason: z.string(),
        evidenceHashSha256: z.string(),
        reporterId: z.string(),
        reporterPublicKeyPem: z.string().optional(),
        reporterSignature: z.string().optional(),
        evidenceSignatureVerified: z.boolean(),
        evidenceRef: z.string().optional(),
        sourceCoordinatorId: z.string(),
        reportedBy: z.string(),
        timestampMs: z.number(),
        expiresAtMs: z.number().optional(),
        prevEventHash: z.string(),
        eventHash: z.string(),
        coordinatorSignature: z.string()
      })
      .safeParse(message.payload);
    if (!payload.success) {
      peerScore.set(peer.peerId, Math.max(0, (peerScore.get(peer.peerId) ?? 100) - 5));
      return reply.code(400).send({ error: "invalid_blacklist_payload" });
    }
    const data = payload.data;
    const incomingValidation = validateIncomingBlacklistRecord({
      record: data,
      peerPublicKeyPem: peer.publicKeyPem
    });
    if (!incomingValidation.ok) {
      peerScore.set(peer.peerId, Math.max(0, (peerScore.get(peer.peerId) ?? 100) - 10));
      return reply.code(400).send({ error: incomingValidation.reason });
    }
    const current = activeBlacklistRecord(data.agentId);
    if (!current || data.timestampMs >= current.timestampMs) {
      appendBlacklistRecord(data);
    }
  }
  peerScore.set(peer.peerId, Math.min(200, (peerScore.get(peer.peerId) ?? 100) + 1));
  return reply.send({ ok: true });
});

app.get("/ledger/snapshot", async () => ({ records: ordering.snapshot(), proof: ordering.latestProof() }));
app.get("/ledger/verify", async () => {
  const validation = verifyOrderingChain(ordering.snapshot(), coordinatorKeys.publicKeyPem);
  return { ok: validation.ok, reason: validation.reason };
});
app.get("/stats/ledger/head", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const head = await pgStore?.latestStatsLedgerHead();
  const records = (await pgStore?.listStatsLedgerRecords(5000)) ?? [];
  const latestCommit = [...records]
    .reverse()
    .find((record) => record.eventType === "stats_checkpoint_commit" && record.checkpointHash);
  return {
    coordinatorId: identity.peerId,
    head: head ?? { issuedAtMs: 0, hash: "GENESIS", count: 0 },
    checkpoint: latestCommit
      ? {
          hash: latestCommit.checkpointHash,
          height: latestCommit.checkpointHeight ?? null,
          issuedAtMs: latestCommit.issuedAtMs
        }
      : null,
    quorumThreshold: statsQuorumThreshold()
  };
});
app.get("/stats/ledger/range", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const query = z
    .object({
      sinceIssuedAtMs: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().positive().max(5000).default(1000)
    })
    .parse(req.query);
  const records = await pgStore?.listStatsLedgerSince(query.sinceIssuedAtMs, query.limit);
  return { records: records ?? [] };
});
app.post("/stats/ledger/ingest", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z
    .object({
      records: z.array(
        z.object({
          id: z.string(),
          eventType: z.string(),
          taskId: z.string(),
          subtaskId: z.string().optional(),
          actorId: z.string(),
          sequence: z.number().int().positive(),
          issuedAtMs: z.number().int().positive(),
          prevHash: z.string(),
          coordinatorId: z.string().optional(),
          checkpointHeight: z.number().int().optional(),
          checkpointHash: z.string().optional(),
          payloadJson: z.string().optional(),
          hash: z.string(),
          signature: z.string()
        })
      )
    })
    .parse(req.body);
  const { ingested, skipped } = await ingestStatsLedgerRecords(body.records as QueueEventRecord[]);
  return { ok: true, ingested, skipped };
});
app.post("/stats/anchors/anchor-latest", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const anchor = await maybeAnchorLatestStatsCheckpoint();
  const finality = await latestStatsFinality();
  return {
    ok: true,
    anchor,
    finality
  };
});
app.get("/stats/anchors/verify", async (req, reply) => {
  const meshAuthorized = hasMeshToken((req as any).headers ?? {});
  const portalAuthorized = hasPortalServiceToken((req as any).headers ?? {});
  if (!meshAuthorized && !portalAuthorized) {
    return reply.code(401).send({ error: "stats_access_unauthorized" });
  }
  const query = z
    .object({
      checkpointHash: z.string().min(8)
    })
    .parse(req.query);
  const anchor = await pgStore?.latestAnchorByCheckpoint(query.checkpointHash);
  const confirmations = anchor?.status === "anchored" ? 1 : 0;
  return {
    ok: true,
    checkpointHash: query.checkpointHash,
    verified: confirmations >= STATS_ANCHOR_MIN_CONFIRMATIONS,
    requiredConfirmations: STATS_ANCHOR_MIN_CONFIRMATIONS,
    anchor: anchor
      ? {
          txRef: anchor.txRef,
          network: anchor.anchorNetwork,
          status: anchor.status,
          confirmations,
          anchoredAtMs: anchor.anchoredAtMs
        }
      : null
  };
});
app.get("/stats/projections/summary", async (req, reply) => {
  const meshAuthorized = hasMeshToken((req as any).headers ?? {});
  const portalAuthorized = hasPortalServiceToken((req as any).headers ?? {});
  if (!meshAuthorized && !portalAuthorized) {
    return reply.code(401).send({ error: "stats_access_unauthorized" });
  }
  const query = z
    .object({
      ownerEmail: z.string().email().optional()
    })
    .parse(req.query);
  const projectionQueryTimeoutMs = 3_000;
  const timeoutReject = (label: string) =>
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_timeout`)), projectionQueryTimeoutMs)
    );
  let nodes: Array<Record<string, unknown>> | undefined;
  let earnings: unknown[] | undefined;
  let head: { issuedAtMs: number; hash: string; count: number } | null | undefined;
  let records: QueueEventRecord[] | undefined;
  if (pgStore) {
    try {
      [nodes, earnings, head, records] = await Promise.race([
        Promise.all([
          pgStore.listNodeStatusProjection(query.ownerEmail),
          pgStore.listCoordinatorEarningsProjection(query.ownerEmail),
          pgStore.latestStatsLedgerHead(),
          pgStore.listStatsLedgerRecords(5000)
        ]),
        timeoutReject("stats_projection_query")
      ]);
    } catch (error) {
      app.log.warn({ error }, "stats_projection_query_skipped");
    }
  }
  const latestCommit = [...(records ?? [])]
    .reverse()
    .find((record) => record.eventType === "stats_checkpoint_commit" && record.checkpointHash);
  let finality: Awaited<ReturnType<typeof latestStatsFinality>> = {
    softFinalized: false,
    hardFinalized: false,
    finalityState: "no_checkpoint"
  };
  try {
    finality = await Promise.race([latestStatsFinality(), timeoutReject("stats_projection_finality")]);
  } catch (error) {
    app.log.warn({ error }, "stats_projection_finality_skipped");
  }
  const mergedByNodeId = new Map<string, Record<string, unknown>>();
  for (const node of nodes ?? []) {
    const nodeId = String(node.nodeId ?? "").trim();
    if (!nodeId) continue;
    mergedByNodeId.set(nodeId, node as Record<string, unknown>);
  }
  const now = Date.now();
  for (const [agentId, cap] of agentCapabilities.entries()) {
    if (query.ownerEmail && cap.ownerEmail !== query.ownerEmail) continue;
    const existing = mergedByNodeId.get(agentId) ?? {};
    const existingLastSeenMs = Number(existing.lastSeenMs ?? 0);
    const mergedLastSeenMs = Math.max(existingLastSeenMs, cap.lastSeenMs ?? 0);
    mergedByNodeId.set(agentId, {
      nodeId: agentId,
      nodeKind: "agent",
      ownerEmail: cap.ownerEmail ?? existing.ownerEmail,
      emailVerified: (existing.emailVerified as boolean | undefined) ?? true,
      nodeApproved: (existing.nodeApproved as boolean | undefined) ?? true,
      active: now - mergedLastSeenMs <= 120_000,
      sourceIp: cap.sourceIp ?? existing.sourceIp,
      countryCode: cap.countryCode ?? existing.countryCode,
      vpnDetected: cap.vpnDetected ?? existing.vpnDetected,
      lastSeenMs: mergedLastSeenMs > 0 ? mergedLastSeenMs : undefined,
      updatedAtMs: Math.max(Number(existing.updatedAtMs ?? 0), mergedLastSeenMs)
    });
  }
  return {
    coordinatorId: identity.peerId,
    generatedAt: Date.now(),
    head: head ?? { issuedAtMs: 0, hash: "GENESIS", count: 0 },
    quorumThreshold: statsQuorumThreshold(),
    latestCheckpoint: latestCommit
      ? {
          hash: latestCommit.checkpointHash,
          height: latestCommit.checkpointHeight ?? null,
          issuedAtMs: latestCommit.issuedAtMs
        }
      : null,
    finality,
    nodes: [...mergedByNodeId.values()],
    earnings: earnings ?? []
  };
});
app.get("/mesh/reputation", async () => ({
  peers: mesh.listPeers().map((p) => ({ peerId: p.peerId, score: peerScore.get(p.peerId) ?? 100 }))
}));
app.get("/security/blacklist", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const records = [...blacklistByAgent.values()].filter((record) => Boolean(activeBlacklistRecord(record.agentId)));
  return { version: blacklistVersion, records, lastEventHash: lastBlacklistEventHash };
});

app.get("/security/blacklist/audit", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  return { version: blacklistVersion, chainHead: lastBlacklistEventHash, events: blacklistAuditLog };
});

app.get("/agent-mesh/direct-work/audit", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const limit = z
    .object({ limit: z.coerce.number().int().positive().max(500).default(100) })
    .parse(req.query);
  const events = [...directWorkById.values()]
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, limit.limit);
  return { events };
});

app.post("/security/blacklist", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z
    .object({
      agentId: z.string(),
      reasonCode: z.enum([
        "abuse_spam",
        "abuse_malware",
        "policy_violation",
        "credential_abuse",
        "dos_behavior",
        "forged_results",
        "manual_review"
      ]),
      reason: z.string().min(3),
      reportedBy: z.string().default("policy-engine"),
      reporterId: z.string().default("policy-engine"),
      reporterPublicKeyPem: z.string().optional(),
      reporterSignature: z.string().optional(),
      evidenceHashSha256: z.string().length(64),
      evidenceRef: z.string().optional(),
      expiresInMs: z.number().positive().optional()
    })
    .parse(req.body);
  const timestampMs = Date.now();
  const evidenceInput: BlacklistEvidenceInput = {
    agentId: body.agentId,
    reasonCode: body.reasonCode as BlacklistReasonCode,
    reason: body.reason,
    evidenceHashSha256: body.evidenceHashSha256,
    reporterId: body.reporterId,
    timestampMs
  };
  const evidenceSignatureVerified = verifyReporterEvidenceSignature({
    evidence: evidenceInput,
    reporterPublicKeyPem: body.reporterPublicKeyPem,
    reporterSignature: body.reporterSignature
  });
  if (!evidenceSignatureVerified && body.reasonCode !== "manual_review") {
    return reply.code(400).send({ error: "reporter_signature_invalid_for_reason_code" });
  }
  const eventId = randomUUID();
  const prevEventHash = lastBlacklistEventHash;
  const eventHash = buildBlacklistEventHash({
    eventId,
    agentId: body.agentId,
    reasonCode: body.reasonCode as BlacklistReasonCode,
    reason: body.reason,
    evidenceHashSha256: body.evidenceHashSha256,
    reporterId: body.reporterId,
    sourceCoordinatorId: identity.peerId,
    timestampMs,
    expiresAtMs: body.expiresInMs ? timestampMs + body.expiresInMs : undefined,
    prevEventHash,
    evidenceSignatureVerified
  });
  const coordinatorSignature = signPayload(eventHash, coordinatorKeys.privateKeyPem);
  const record: BlacklistRecord = {
    eventId,
    agentId: body.agentId,
    reasonCode: body.reasonCode as BlacklistReasonCode,
    reason: body.reason,
    evidenceHashSha256: body.evidenceHashSha256,
    reporterId: body.reporterId,
    reporterPublicKeyPem: body.reporterPublicKeyPem,
    reporterSignature: body.reporterSignature,
    evidenceSignatureVerified,
    evidenceRef: body.evidenceRef,
    sourceCoordinatorId: identity.peerId,
    reportedBy: body.reportedBy,
    timestampMs,
    expiresAtMs: body.expiresInMs ? timestampMs + body.expiresInMs : undefined,
    prevEventHash,
    eventHash,
    coordinatorSignature
  };
  appendBlacklistRecord(record);
  const gossipMessage = protocol.createMessage(
    "blacklist_update",
    identity.peerId,
    record as unknown as Record<string, unknown>,
    coordinatorKeys.privateKeyPem
  );
  void mesh.broadcast(gossipMessage);
  return { ok: true, record, version: blacklistVersion, chainHead: lastBlacklistEventHash };
});
app.get("/agent-mesh/peers/:agentId", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const params = z.object({ agentId: z.string() }).parse(req.params);
  if (activeBlacklistRecord(params.agentId)) return reply.code(403).send({ error: "agent_blacklisted" });
  const peers = [...agentCapabilities.keys()].filter(
    (id) => id !== params.agentId && !activeBlacklistRecord(id)
  );
  return { peers };
});

app.get("/agent-mesh/models/available", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const query = z
    .object({
      provider: z.enum(["edgecoder-local", "ollama-local"]).optional(),
      includeBlacklisted: z.coerce.boolean().optional().default(false)
    })
    .parse(req.query);
  const models = [...agentCapabilities.entries()]
    .filter(([agentId, info]) => {
      if (!query.includeBlacklisted && activeBlacklistRecord(agentId)) return false;
      if (!info.localModelEnabled) return false;
      if (query.provider && info.localModelProvider !== query.provider) return false;
      return true;
    })
    .map(([agentId, info]) => ({
      agentId,
      provider: info.localModelProvider,
      modelCatalog: info.localModelCatalog,
      maxConcurrentTasks: info.maxConcurrentTasks,
      connectedPeers: info.connectedPeers.size
    }));
  return { models, generatedAtMs: Date.now() };
});

app.post("/agent-mesh/connect", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z.object({ fromAgentId: z.string(), toAgentId: z.string() }).parse(req.body);
  if (activeBlacklistRecord(body.fromAgentId) || activeBlacklistRecord(body.toAgentId)) {
    return reply.code(403).send({ error: "agent_blacklisted" });
  }
  if (!agentCapabilities.has(body.fromAgentId) || !agentCapabilities.has(body.toAgentId)) {
    return reply.code(404).send({ error: "agent_not_found" });
  }
  const existing = tunnelByPairKey.get(pairKey(body.fromAgentId, body.toAgentId));
  if (existing) {
    const tunnel = activeTunnels.get(existing);
    if (tunnel) {
      tunnel.lastRelayMs = Date.now();
      activeTunnels.set(existing, tunnel);
      return { ok: true, token: existing, reused: true };
    }
    tunnelByPairKey.delete(pairKey(body.fromAgentId, body.toAgentId));
  }
  const token = randomUUID();
  activeTunnels.set(token, {
    fromAgentId: body.fromAgentId,
    toAgentId: body.toAgentId,
    createdAtMs: Date.now(),
    lastRelayMs: Date.now(),
    relayCount: 0,
    relayWindowStartMs: Date.now() - (Date.now() % 60_000),
    relayWindowCount: 0
  });
  tunnelByPairKey.set(pairKey(body.fromAgentId, body.toAgentId), token);
  const pending = pendingTunnelInvites.get(body.toAgentId) ?? [];
  pending.push({ fromAgentId: body.fromAgentId, token });
  pendingTunnelInvites.set(body.toAgentId, pending);
  return { ok: true, token };
});

app.post("/agent-mesh/accept", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z.object({ agentId: z.string(), token: z.string() }).parse(req.body);
  if (activeBlacklistRecord(body.agentId)) return reply.code(403).send({ error: "agent_blacklisted" });
  const tunnel = activeTunnels.get(body.token);
  if (!tunnel) return reply.code(404).send({ error: "tunnel_not_found" });
  if (tunnel.toAgentId !== body.agentId) return reply.code(403).send({ error: "tunnel_target_mismatch" });
  agentCapabilities.get(tunnel.fromAgentId)?.connectedPeers.add(tunnel.toAgentId);
  agentCapabilities.get(tunnel.toAgentId)?.connectedPeers.add(tunnel.fromAgentId);
  return { ok: true };
});

app.post("/agent-mesh/relay", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z.object({ token: z.string(), fromAgentId: z.string(), payload: z.string() }).parse(req.body);
  if (activeBlacklistRecord(body.fromAgentId)) return reply.code(403).send({ error: "agent_blacklisted" });
  const tunnel = activeTunnels.get(body.token);
  if (!tunnel) return reply.code(404).send({ error: "tunnel_not_found" });
  if (tunnel.fromAgentId !== body.fromAgentId && tunnel.toAgentId !== body.fromAgentId) {
    return reply.code(403).send({ error: "tunnel_peer_mismatch" });
  }
  if (body.payload.length > 16_384) {
    return reply.code(413).send({ error: "relay_payload_too_large" });
  }
  const now = Date.now();
  const relayWindowStart = now - (now % 10_000);
  const relayWindow = relayWindowByAgent.get(body.fromAgentId);
  if (!relayWindow || relayWindow.windowMs !== relayWindowStart) {
    relayWindowByAgent.set(body.fromAgentId, { windowMs: relayWindowStart, count: 1 });
  } else {
    relayWindow.count += 1;
    if (relayWindow.count > RELAY_RATE_LIMIT_PER_10S) {
      return reply.code(429).send({ error: "relay_rate_limited" });
    }
  }
  const relayMinuteWindowStart = now - (now % 60_000);
  if (tunnel.relayWindowStartMs !== relayMinuteWindowStart) {
    tunnel.relayWindowStartMs = relayMinuteWindowStart;
    tunnel.relayWindowCount = 0;
  }
  if (tunnel.relayWindowCount >= TUNNEL_MAX_RELAYS_PER_MIN) {
    return reply.code(429).send({ error: "tunnel_relay_cap_reached" });
  }
  tunnel.lastRelayMs = Date.now();
  tunnel.relayCount += 1;
  tunnel.relayWindowCount += 1;
  activeTunnels.set(body.token, tunnel);
  return { ok: true, relayCount: tunnel.relayCount };
});

app.post("/agent-mesh/close", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z.object({ fromAgentId: z.string(), token: z.string(), reason: z.string() }).parse(req.body);
  const tunnel = activeTunnels.get(body.token);
  if (!tunnel) return reply.code(404).send({ error: "tunnel_not_found" });
  if (tunnel.fromAgentId !== body.fromAgentId && tunnel.toAgentId !== body.fromAgentId) {
    return reply.code(403).send({ error: "tunnel_peer_mismatch" });
  }
  const peerAgentId = tunnel.fromAgentId === body.fromAgentId ? tunnel.toAgentId : tunnel.fromAgentId;
  activeTunnels.delete(body.token);
  tunnelByPairKey.delete(pairKey(tunnel.fromAgentId, tunnel.toAgentId));
  agentCapabilities.get(tunnel.fromAgentId)?.connectedPeers.delete(tunnel.toAgentId);
  agentCapabilities.get(tunnel.toAgentId)?.connectedPeers.delete(tunnel.fromAgentId);
  const notices = pendingTunnelCloseNotices.get(peerAgentId) ?? [];
  notices.push({ peerAgentId: body.fromAgentId, token: body.token, reason: body.reason });
  pendingTunnelCloseNotices.set(peerAgentId, notices);
  return { ok: true };
});

app.post("/agent-mesh/close-ack", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z.object({ agentId: z.string(), token: z.string() }).parse(req.body);
  const notices = (pendingTunnelCloseNotices.get(body.agentId) ?? []).filter((n) => n.token !== body.token);
  pendingTunnelCloseNotices.set(body.agentId, notices);
  return { ok: true };
});

app.post("/agent-mesh/direct-work/offer", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z
    .object({
      fromAgentId: z.string(),
      toAgentId: z.string(),
      workType: z.enum(["code_task", "model_inference"]).default("code_task"),
      language: z.enum(["python", "javascript"]).optional(),
      input: z.string().min(1)
    })
    .parse(req.body);
  if (activeBlacklistRecord(body.fromAgentId) || activeBlacklistRecord(body.toAgentId)) {
    return reply.code(403).send({ error: "agent_blacklisted" });
  }
  if (!agentCapabilities.has(body.fromAgentId) || !agentCapabilities.has(body.toAgentId)) {
    return reply.code(404).send({ error: "agent_not_found" });
  }
  const now = Date.now();
  const offerWindowStart = now - (now % 10_000);
  const offerWindow = offerWindowByAgent.get(body.fromAgentId);
  if (!offerWindow || offerWindow.windowMs !== offerWindowStart) {
    offerWindowByAgent.set(body.fromAgentId, { windowMs: offerWindowStart, count: 1 });
  } else {
    offerWindow.count += 1;
    if (offerWindow.count > DIRECT_WORK_OFFERS_PER_10S) {
      return reply.code(429).send({ error: "direct_work_offer_rate_limited" });
    }
  }
  const offer: DirectWorkOffer = {
    offerId: randomUUID(),
    fromAgentId: body.fromAgentId,
    toAgentId: body.toAgentId,
    workType: body.workType,
    language: body.workType === "code_task" ? (body.language ?? "python") : undefined,
    input: body.input,
    createdAtMs: Date.now(),
    status: "offered"
  };
  directWorkById.set(offer.offerId, offer);
  const inbox = directWorkInbox.get(body.toAgentId) ?? [];
  inbox.push(offer.offerId);
  directWorkInbox.set(body.toAgentId, inbox);
  return { ok: true, offerId: offer.offerId };
});

app.post("/agent-mesh/models/request", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z
    .object({
      fromAgentId: z.string(),
      toAgentId: z.string(),
      prompt: z.string().min(1).max(16_384)
    })
    .parse(req.body);
  if (activeBlacklistRecord(body.fromAgentId) || activeBlacklistRecord(body.toAgentId)) {
    return reply.code(403).send({ error: "agent_blacklisted" });
  }
  const fromInfo = agentCapabilities.get(body.fromAgentId);
  const toInfo = agentCapabilities.get(body.toAgentId);
  if (!fromInfo || !toInfo) {
    return reply.code(404).send({ error: "agent_not_found" });
  }
  if (!toInfo.localModelEnabled) {
    return reply.code(409).send({ error: "target_has_no_local_model" });
  }
  const now = Date.now();
  const offerWindowStart = now - (now % 10_000);
  const offerWindow = offerWindowByAgent.get(body.fromAgentId);
  if (!offerWindow || offerWindow.windowMs !== offerWindowStart) {
    offerWindowByAgent.set(body.fromAgentId, { windowMs: offerWindowStart, count: 1 });
  } else {
    offerWindow.count += 1;
    if (offerWindow.count > DIRECT_WORK_OFFERS_PER_10S) {
      return reply.code(429).send({ error: "direct_work_offer_rate_limited" });
    }
  }
  const offer: DirectWorkOffer = {
    offerId: randomUUID(),
    fromAgentId: body.fromAgentId,
    toAgentId: body.toAgentId,
    workType: "model_inference",
    input: body.prompt,
    createdAtMs: now,
    status: "offered"
  };
  directWorkById.set(offer.offerId, offer);
  const inbox = directWorkInbox.get(body.toAgentId) ?? [];
  inbox.push(offer.offerId);
  directWorkInbox.set(body.toAgentId, inbox);
  return { ok: true, offerId: offer.offerId, targetProvider: toInfo.localModelProvider };
});

app.get("/agent-mesh/models/request/:offerId", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const params = z.object({ offerId: z.string() }).parse(req.params);
  const offer = directWorkById.get(params.offerId);
  if (!offer) return reply.code(404).send({ error: "offer_not_found" });
  if (offer.workType !== "model_inference") {
    return reply.code(409).send({ error: "offer_not_model_request" });
  }
  return {
    offerId: offer.offerId,
    fromAgentId: offer.fromAgentId,
    toAgentId: offer.toAgentId,
    status: offer.status,
    acceptedAtMs: offer.acceptedAtMs,
    result: offer.result ?? null
  };
});

app.post("/agent-mesh/direct-work/accept", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z.object({ offerId: z.string(), byAgentId: z.string() }).parse(req.body);
  if (activeBlacklistRecord(body.byAgentId)) return reply.code(403).send({ error: "agent_blacklisted" });
  const offer = directWorkById.get(body.offerId);
  if (!offer) return reply.code(404).send({ error: "offer_not_found" });
  if (offer.toAgentId !== body.byAgentId) return reply.code(403).send({ error: "offer_target_mismatch" });
  if (offer.status !== "offered") return reply.code(409).send({ error: "offer_not_available" });
  offer.status = "accepted";
  offer.acceptedBy = body.byAgentId;
  offer.acceptedAtMs = Date.now();
  directWorkById.set(body.offerId, offer);
  const inbox = (directWorkInbox.get(body.byAgentId) ?? []).filter((id) => id !== body.offerId);
  directWorkInbox.set(body.byAgentId, inbox);
  return { ok: true, accepted: true, offer };
});

app.post("/agent-mesh/direct-work/result", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z
    .object({
      offerId: z.string(),
      byAgentId: z.string(),
      ok: z.boolean(),
      output: z.string(),
      error: z.string().optional(),
      durationMs: z.number()
    })
    .parse(req.body);
  if (activeBlacklistRecord(body.byAgentId)) return reply.code(403).send({ error: "agent_blacklisted" });
  const offer = directWorkById.get(body.offerId);
  if (!offer) return reply.code(404).send({ error: "offer_not_found" });
  if (offer.toAgentId !== body.byAgentId) return reply.code(403).send({ error: "offer_target_mismatch" });
  if (offer.status !== "accepted") return reply.code(409).send({ error: "offer_not_accepted" });
  offer.status = "completed";
  offer.result = {
    ok: body.ok,
    output: body.output,
    error: body.error,
    durationMs: body.durationMs,
    completedAtMs: Date.now()
  };
  directWorkById.set(body.offerId, offer);
  return { ok: true };
});

app.post("/orchestration/coordinator/ollama-install", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z
    .object({
      provider: z.enum(["edgecoder-local", "ollama-local"]).default("ollama-local"),
      model: z.string().default(OLLAMA_MODEL),
      autoInstall: z.boolean().default(true),
      requestedBy: z.string().default("control-plane")
    })
    .parse(req.body);
  const rolloutId = randomUUID();
  const requestedAtMs = Date.now();
  await upsertRollout({
    rolloutId,
    targetType: "coordinator",
    targetId: "coordinator-local",
    provider: body.provider,
    model: body.model,
    autoInstall: body.autoInstall,
    status: "in_progress",
    requestedBy: body.requestedBy,
    requestedAtMs,
    updatedAtMs: requestedAtMs
  });
  try {
    await ensureOllamaModelInstalled({
      enabled: body.provider === "ollama-local",
      autoInstall: body.autoInstall,
      model: body.model,
      role: "coordinator",
      host: OLLAMA_HOST
    });
    coordinatorProvider = body.provider;
    await upsertRollout({
      rolloutId,
      targetType: "coordinator",
      targetId: "coordinator-local",
      provider: body.provider,
      model: body.model,
      autoInstall: body.autoInstall,
      status: "applied",
      requestedBy: body.requestedBy,
      requestedAtMs,
      updatedAtMs: Date.now()
    });
    return reply.send({ ok: true, rolloutId, coordinatorProvider, model: body.model });
  } catch (error) {
    await upsertRollout({
      rolloutId,
      targetType: "coordinator",
      targetId: "coordinator-local",
      provider: body.provider,
      model: body.model,
      autoInstall: body.autoInstall,
      status: "failed",
      requestedBy: body.requestedBy,
      requestedAtMs,
      updatedAtMs: Date.now(),
      error: String(error)
    });
    return reply.code(500).send({ error: String(error), rolloutId });
  }
});

app.get("/orchestration/coordinator/status", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  return {
    provider: coordinatorProvider,
    ollamaAutoInstall: OLLAMA_AUTO_INSTALL
  };
});

const AGENT_ORCHESTRATION_ONLINE_WINDOW_MS = Number(process.env.AGENT_ORCHESTRATION_ONLINE_WINDOW_MS ?? "120000");

function canonicalNodeSuffix(nodeId: string): string {
  return String(nodeId)
    .toLowerCase()
    .replace(/^iphone-/, "")
    .replace(/^ios-/, "")
    .replace(/[^a-z0-9]/g, "");
}

function looksLikeIosAlias(agentIdA: string, agentIdB: string): boolean {
  const a = canonicalNodeSuffix(agentIdA);
  const b = canonicalNodeSuffix(agentIdB);
  if (!a || !b) return false;
  const aIosStyle = /^ios-|^iphone-/i.test(agentIdA);
  const bIosStyle = /^ios-|^iphone-/i.test(agentIdB);
  if (!aIosStyle || !bIosStyle) return false;
  return a.startsWith(b) || b.startsWith(a);
}

function resolveRecentOrchestrationAgentId(
  requestedAgentId: string
): { agentId: string | null; reason?: "agent_not_connected" | "agent_not_recently_seen" } {
  const now = Date.now();
  const exact = agentCapabilities.get(requestedAgentId);
  if (exact) {
    if (now - Number(exact.lastSeenMs ?? 0) <= AGENT_ORCHESTRATION_ONLINE_WINDOW_MS) {
      return { agentId: requestedAgentId };
    }
    return { agentId: null, reason: "agent_not_recently_seen" };
  }
  const aliasMatch = [...agentCapabilities.entries()]
    .filter(([agentId, cap]) =>
      looksLikeIosAlias(agentId, requestedAgentId) &&
      now - Number(cap.lastSeenMs ?? 0) <= AGENT_ORCHESTRATION_ONLINE_WINDOW_MS
    )
    .sort((a, b) => Number(b[1].lastSeenMs ?? 0) - Number(a[1].lastSeenMs ?? 0))[0];
  if (aliasMatch?.[0]) return { agentId: aliasMatch[0] };
  return { agentId: null, reason: "agent_not_connected" };
}

app.post("/orchestration/agents/:agentId/ollama-install", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const params = z.object({ agentId: z.string() }).parse(req.params);
  const body = z
    .object({
      provider: z.enum(["edgecoder-local", "ollama-local"]).default("ollama-local"),
      model: z.string().default(OLLAMA_MODEL),
      autoInstall: z.boolean().default(true),
      requestedBy: z.string().default("control-plane")
    })
    .parse(req.body);
  const requestedAgentId = params.agentId;
  const resolvedTarget = resolveRecentOrchestrationAgentId(requestedAgentId);
  if (!resolvedTarget.agentId) {
    appendAgentDiagnostic(
      requestedAgentId,
      `Model switch request rejected: ${resolvedTarget.reason ?? "agent_not_connected"}`
    );
    return reply.code(409).send({
      error: "agent_not_connected",
      reason: resolvedTarget.reason ?? "agent_not_connected",
      agentId: requestedAgentId
    });
  }
  const targetAgentId = resolvedTarget.agentId;
  if (targetAgentId !== requestedAgentId) {
    appendAgentDiagnostic(requestedAgentId, `Routing model switch request to active id ${targetAgentId}`);
  }
  const rolloutId = randomUUID();
  appendAgentDiagnostic(
    targetAgentId,
    `Model switch requested: ${body.provider} (${body.model}) autoInstall=${body.autoInstall ? "true" : "false"}`
  );
  agentOrchestration.set(targetAgentId, {
    rolloutId,
    provider: body.provider,
    model: body.model,
    autoInstall: body.autoInstall,
    pending: true,
    requestedAtMs: Date.now()
  });
  await upsertRollout({
    rolloutId,
    targetType: "agent",
    targetId: targetAgentId,
    provider: body.provider,
    model: body.model,
    autoInstall: body.autoInstall,
    status: "requested",
    requestedBy: body.requestedBy,
    requestedAtMs: Date.now(),
    updatedAtMs: Date.now()
  });
  return reply.send({ ok: true, agentId: targetAgentId, requestedAgentId, rolloutId });
});

app.post("/orchestration/agents/:agentId/status", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const params = z.object({ agentId: z.string() }).parse(req.params);
  const body = z
    .object({
      phase: z.string().max(64),
      message: z.string().max(512),
      progressPct: z.number().min(0).max(100).optional()
    })
    .parse(req.body);
  const current = agentOrchestration.get(params.agentId);
  if (!current) return reply.code(404).send({ error: "orchestration_not_found" });
  current.status = {
    phase: body.phase,
    message: body.message,
    progressPct: body.progressPct,
    updatedAtMs: Date.now()
  };
  appendAgentDiagnostic(
    params.agentId,
    `${body.phase}: ${body.message}${body.progressPct != null ? ` (${body.progressPct}%)` : ""}`,
    current.status.updatedAtMs
  );
  agentOrchestration.set(params.agentId, current);
  await upsertRollout({
    rolloutId: current.rolloutId,
    targetType: "agent",
    targetId: params.agentId,
    provider: current.provider,
    model: current.model ?? OLLAMA_MODEL,
    autoInstall: current.autoInstall,
    status: "in_progress",
    requestedBy: "control-plane",
    requestedAtMs: current.requestedAtMs,
    updatedAtMs: Date.now()
  });
  return reply.send({ ok: true });
});

app.post("/orchestration/agents/:agentId/ack", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const params = z.object({ agentId: z.string() }).parse(req.params);
  const body = z.object({ ok: z.boolean(), error: z.string().optional() }).parse(req.body);
  const current = agentOrchestration.get(params.agentId);
  if (!current) return reply.code(404).send({ error: "orchestration_not_found" });
  current.pending = false;
  agentOrchestration.set(params.agentId, current);
  appendAgentDiagnostic(
    params.agentId,
    body.ok ? "Model switch applied successfully." : `Model switch failed: ${body.error ?? "unknown error"}`
  );
  if (body.ok) {
    const cap = agentCapabilities.get(params.agentId);
    if (cap) {
      cap.localModelProvider = current.provider;
      cap.localModelCatalog = current.provider === "ollama-local" ? [current.model ?? OLLAMA_MODEL] : ["edgecoder-default"];
      agentCapabilities.set(params.agentId, cap);
    }
  }
  await upsertRollout({
    rolloutId: current.rolloutId,
    targetType: "agent",
    targetId: params.agentId,
    provider: current.provider,
    model: current.model ?? OLLAMA_MODEL,
    autoInstall: current.autoInstall,
    status: body.ok ? "applied" : "failed",
    requestedBy: "control-plane",
    requestedAtMs: current.requestedAtMs,
    updatedAtMs: Date.now(),
    error: body.error
  });
  return reply.send({ ok: body.ok, pending: current.pending, error: body.error });
});

app.get("/orchestration/rollouts", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  if (pgStore) {
    try {
      const rolloutsQueryTimeoutMs = 3_000;
      const rollouts = await Promise.race([
        pgStore.listOllamaRollouts(200),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("rollouts_query_timeout")), rolloutsQueryTimeoutMs)
        )
      ]);
      return { rollouts };
    } catch (error) {
      app.log.warn({ error }, "rollouts_query_fallback_in_memory");
    }
  }
  return { rollouts: [...ollamaRollouts.values()] };
});

// --- Escalation: mesh-based hard task routing ---

const escalationStore = new Map<string, EscalationResult & { request: EscalationRequest }>();

const escalationRequestSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  task: z.string().min(1),
  failedCode: z.string(),
  errorHistory: z.array(z.string()),
  language: z.enum(["python", "javascript"]),
  iterationsAttempted: z.number().int().min(1)
});

app.post("/escalate", async (req, reply) => {
  const body = escalationRequestSchema.parse(req.body);
  const taskId = body.taskId;

  escalationStore.set(taskId, {
    taskId,
    status: "processing",
    request: body
  });

  const ollamaHost = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  const coordinatorModel = process.env.OLLAMA_MODEL ?? "qwen2.5-coder:latest";
  const useLocalOllama = process.env.LOCAL_MODEL_PROVIDER === "ollama-local";

  const errorContext = body.errorHistory.length > 0
    ? `\n\nPrevious errors:\n${body.errorHistory.join("\n")}`
    : "";

  const escalationPrompt = `You are a senior coding assistant. A smaller model failed to solve this task after multiple attempts.

Task: ${body.task}

Failed code:
${body.failedCode}
${errorContext}

Write correct, working ${body.language} code that solves the task. Output ONLY executable code, no markdown fences, no explanation.`;

  // Try local Ollama first (coordinator has Ollama co-located on Fly)
  if (useLocalOllama) {
    try {
      const ollamaRes = await request(`${ollamaHost}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: coordinatorModel, prompt: escalationPrompt, stream: false })
      });
      const payload = (await ollamaRes.body.json()) as { response?: string };
      const raw = payload.response ?? "";
      const improvedCode = raw ? extractCode(raw, body.language) : "";

      if (improvedCode) {
        const result: EscalationResult & { request: EscalationRequest } = {
          taskId,
          status: "completed",
          improvedCode,
          explanation: "Escalated to coordinator-local Ollama model.",
          resolvedByModel: coordinatorModel,
          request: body
        };
        escalationStore.set(taskId, result);
        return reply.send({
          taskId,
          status: "completed",
          improvedCode,
          explanation: result.explanation,
          resolvedByModel: coordinatorModel
        });
      }
    } catch {
      // Local Ollama failed, fall through to inference service
    }
  }

  // Fallback: forward to inference service
  const inferenceUrl = process.env.INFERENCE_URL ?? "http://127.0.0.1:4302";
  try {
    const escalateHeaders: Record<string, string> = { "content-type": "application/json" };
    if (INFERENCE_AUTH_TOKEN) {
      escalateHeaders["x-inference-token"] = INFERENCE_AUTH_TOKEN;
    }
    const inferRes = await request(`${inferenceUrl}/escalate`, {
      method: "POST",
      headers: escalateHeaders,
      body: JSON.stringify({
        task: body.task,
        failedCode: body.failedCode,
        errorHistory: body.errorHistory,
        language: body.language
      })
    });

    if (inferRes.statusCode >= 200 && inferRes.statusCode < 300) {
      const inferResult = (await inferRes.body.json()) as {
        improvedCode?: string;
        explanation?: string;
      };
      const result: EscalationResult & { request: EscalationRequest } = {
        taskId,
        status: "completed",
        improvedCode: inferResult.improvedCode,
        explanation: inferResult.explanation,
        resolvedByModel: "coordinator-inference",
        request: body
      };
      escalationStore.set(taskId, result);
      return reply.send({
        taskId,
        status: "completed",
        improvedCode: inferResult.improvedCode,
        explanation: inferResult.explanation
      });
    }

    escalationStore.set(taskId, { taskId, status: "failed", request: body });
    return reply.send({ taskId, status: "failed" });
  } catch (error) {
    escalationStore.set(taskId, { taskId, status: "failed", request: body });
    return reply.code(502).send({ taskId, status: "failed", error: String(error) });
  }
});

app.get("/escalate/:taskId", async (req, reply) => {
  const params = z.object({ taskId: z.string() }).parse(req.params);
  const result = escalationStore.get(params.taskId);
  if (!result) return reply.code(404).send({ error: "escalation_not_found" });
  const { request: _req, ...rest } = result;
  return reply.send(rest);
});

const bleSyncSchema = z.object({
  transactions: z.array(z.object({
    txId: z.string(),
    requesterId: z.string(),
    providerId: z.string(),
    requesterAccountId: z.string(),
    providerAccountId: z.string(),
    credits: z.number().min(0),
    cpuSeconds: z.number().min(0),
    taskHash: z.string(),
    timestamp: z.number(),
    requesterSignature: z.string(),
    providerSignature: z.string()
  }))
});

const syncedBLETxIds = new Set<string>();

app.post("/credits/ble-sync", async (req, reply) => {
  const body = bleSyncSchema.parse(req.body);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const tx of body.transactions) {
    if (syncedBLETxIds.has(tx.txId)) {
      skipped.push(tx.txId);
      continue;
    }
    // TODO: verify requesterSignature and providerSignature with ed25519
    syncedBLETxIds.add(tx.txId);
    applied.push(tx.txId);
  }

  return reply.send({ applied, skipped, total: body.transactions.length });
});

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.resolve()
    .then(async () => {
      // Do not block coordinator readiness indefinitely on database recovery.
      if (pgStore) {
        const storeRef = pgStore;
        const initDbState = async () => {
          await storeRef.migrate();
          const persistedEvents = await storeRef.listBlacklistEvents();
          for (const event of persistedEvents) {
            blacklistAuditLog.push(event);
            blacklistByAgent.set(event.agentId, event);
            lastBlacklistEventHash = event.eventHash;
          }
          blacklistVersion = blacklistAuditLog.length;
          const latestCpu = await storeRef.latestPriceEpoch("cpu");
          const latestGpu = await storeRef.latestPriceEpoch("gpu");
          if (latestCpu) latestPriceEpochByResource.set("cpu", latestCpu);
          if (latestGpu) latestPriceEpochByResource.set("gpu", latestGpu);
          treasuryPolicy = await storeRef.latestTreasuryPolicy();
          const pendingIntents = await storeRef.listPendingPaymentIntents(500);
          for (const intent of pendingIntents) {
            paymentIntents.set(intent.intentId, intent);
          }
        };
        const startupDbInitTimeoutMs = 10_000;
        await Promise.race([
          initDbState(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("startup_db_init_timeout")), startupDbInitTimeoutMs)
          )
        ]).catch((error) => app.log.warn({ error }, "startup_db_init_skipped"));
      }
    })
    .then(async () => {
      setInterval(() => {
        cleanupStaleTunnels();
      }, 15_000);
      setInterval(async () => {
        try {
          const pending = pgStore ? await pgStore.listPendingPaymentIntents(500) : [...paymentIntents.values()];
          for (const intent of pending) {
            if (intent.status !== "created") continue;
            const tooOld = Date.now() - intent.createdAtMs > PAYMENT_INTENT_TTL_MS;
            if (tooOld) {
              const expired: PaymentIntent = { ...intent, status: "expired" };
              paymentIntents.set(expired.intentId, expired);
              await pgStore?.upsertPaymentIntent(expired);
              continue;
            }
            const settlement = await lightningProvider
              .checkSettlement(intent.invoiceRef)
              .catch(() => ({ settled: false }));
            if (settlement.settled) {
              const txRef = "txRef" in settlement ? settlement.txRef : undefined;
              await settleIntent(intent, txRef ?? `poller:${randomUUID()}`);
            }
          }
        } catch (error) {
          app.log.warn({ error }, "payment_reconcile_tick_failed");
        }
      }, 30_000);
      setInterval(() => {
        void runIssuanceTick().catch((error) => app.log.warn({ error }, "issuance_tick_failed"));
      }, ISSUANCE_RECALC_MS);
      setInterval(() => {
        void maybeAnchorLatestFinalizedEpoch().catch((error) => app.log.warn({ error }, "anchor_tick_failed"));
      }, ANCHOR_INTERVAL_MS);
      setInterval(() => {
        void bootstrapPeerMesh();
      }, 45_000);
      setInterval(() => {
        void (async () => {
          const peers = mesh.listPeers();
          for (const peer of peers) {
            await syncStatsLedgerFromPeer(peer);
          }
          await maybeFinalizeStatsCheckpoint();
        })().catch((error) => app.log.warn({ error }, "stats_ledger_sync_failed"));
      }, STATS_LEDGER_SYNC_INTERVAL_MS);
      setInterval(() => {
        void maybeAnchorLatestStatsCheckpoint().catch((error) => app.log.warn({ error }, "stats_anchor_tick_failed"));
      }, STATS_ANCHOR_INTERVAL_MS);
      await app.listen({ port: 4301, host: "0.0.0.0" });
      // Do not block coordinator readiness on model pull/install.
      // Fly health checks and agent registration should stay available while
      // Ollama warms up in the background.
      void ensureOllamaModelInstalled({
        enabled: PROVIDER === "ollama-local",
        autoInstall: OLLAMA_AUTO_INSTALL,
        model: OLLAMA_MODEL,
        role: "coordinator",
        host: OLLAMA_HOST
      }).catch((error) => app.log.warn({ error }, "coordinator_ollama_bootstrap_failed"));
      await bootstrapPeerMesh();
      await (async () => {
        const peers = mesh.listPeers();
        for (const peer of peers) {
          await syncStatsLedgerFromPeer(peer);
        }
        await maybeFinalizeStatsCheckpoint();
      })().catch(() => undefined);
      await runIssuanceTick().catch(() => undefined);
      await maybeAnchorLatestFinalizedEpoch().catch(() => undefined);
      await maybeAnchorLatestStatsCheckpoint().catch(() => undefined);
    })
    .catch((error) => {
      app.log.error(error);
      process.exit(1);
    });
}

export { app as coordinatorServer };
