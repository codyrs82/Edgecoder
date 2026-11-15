// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Connected agents: capabilities, tunnels, direct work, the blacklist and behaviour tracking.
 */
import { randomUUID } from "node:crypto";
import { pairKey } from "../coordinator-utils.js";
import type {
  BlacklistRecord,
  BlacklistReasonCode,
  OllamaRolloutRecord,
  CapabilitySummaryPayload,
  SandboxMode
} from "../../common/types.js";
import { signPayload } from "../../mesh/peer.js";
import { OrderingChain } from "../../ledger/chain.js";
import { pgStore } from "../../db/store.js";
import type { ComputeClassId, HardwareClassification, HardwareProfile } from "../../economy/compute-classes.js";
import { requireSignedAgentRequests } from "../result-integrity.js";
import type { AgentPowerTelemetry } from "../power-policy.js";
import { buildBlacklistEventHash } from "../../security/blacklist.js";
import { AgentBehaviorTracker } from "../../security/behavior-tracker.js";
import { AnomalyDetector } from "../../security/anomaly-detector.js";
import { VerificationFlags, verificationConfigFromEnv } from "../verification.js";
import { AutoBlacklister, type BlacklistAction } from "../../security/auto-blacklister.js";
import { ReleaseManifestCache } from "../../security/release-manifest-cache.js";
import { app } from "./app.js";
import { identity, coordinatorKeys, CC, protocol, mesh, securityLog } from "./context.js";
import { mutable } from "./mutable-state.js";

export const ordering = new OrderingChain(identity.peerId, coordinatorKeys.privateKeyPem);

export const agentOrchestration = new Map<
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
export type DirectWorkOffer = {
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
  /** The verified account both agents share (direct work is same-account only); sent to the target. */
  fromAccountId?: string;
};

export const directWorkById = new Map<string, DirectWorkOffer>();
export const directWorkInbox = new Map<string, string[]>();
/** Pending direct-work offers expire; offers of any state are forgotten after DIRECT_WORK_RETAIN_MS. */
export const DIRECT_WORK_OFFER_TTL_MS = 10 * 60_000;
export const DIRECT_WORK_RETAIN_MS = 60 * 60_000;
/** Pending offers one agent may hold: another agent cannot fill its heartbeat or the coordinator's memory. */
export const DIRECT_WORK_INBOX_MAX = 16;
export const DIRECT_WORK_INPUT_MAX_CHARS = 64 * 1024;
let lastDirectWorkPruneMs = 0;
/** Drop expired pending offers from inboxes and forget old offers (at most once a minute unless forced). */
export function pruneDirectWork(nowMs = Date.now(), force = false): void {
  if (!force && nowMs - lastDirectWorkPruneMs < 60_000) return;
  lastDirectWorkPruneMs = nowMs;
  for (const [id, offer] of directWorkById) {
    if (offer.status === "offered" && nowMs - offer.createdAtMs > DIRECT_WORK_OFFER_TTL_MS) offer.status = "rejected";
    if (nowMs - offer.createdAtMs > DIRECT_WORK_RETAIN_MS) directWorkById.delete(id);
  }
  for (const [agentId, ids] of directWorkInbox) {
    const live = ids.filter((id) => directWorkById.get(id)?.status === "offered");
    if (live.length) directWorkInbox.set(agentId, live);
    else directWorkInbox.delete(agentId);
  }
}
export const agentCapabilities = new Map<
  string,
  {
    os: string;
    version: string;
    mode: "swarm-only" | "ide-enabled";
    localModelEnabled: boolean;
    localModelProvider: "edgecoder-local" | "ollama-local";
    localModelCatalog: string[];
    /** #54: localModelCatalog came from the agent's signed /api/tags report (not assumed or gossiped). */
    modelsReported?: boolean;
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
    activeModel?: string;
    activeModelParamSize?: number;
    modelSwapInProgress?: boolean;
    publicKeyPem?: string;
    x25519PublicKey?: string;
    sandboxMode: SandboxMode;
    lastSeenMs: number;
    hardwareProfile?: HardwareProfile;
    /** Derived from hardwareProfile at registration: the class-market whose flat price values the agent's credits. */
    computeClass: ComputeClassId;
    /** Tier, weight (credits per measured second) and capability (vramGb / memoryGb) from the same classification. */
    hardwareClass?: HardwareClassification;
  }
>();
/** Agents seen this recently count as connected (/metrics edgecoder_connected_agents, the account page). */
export const AGENT_CONNECTED_WINDOW_MS = 2 * 60_000;

/** Agents seen within the connected window. */
export function connectedAgentCount(nowMs = Date.now()): number {
  let n = 0;
  for (const cap of agentCapabilities.values()) if (nowMs - cap.lastSeenMs < AGENT_CONNECTED_WINDOW_MS) n++;
  return n;
}

/**
 * Stress finding 5: agentCapabilities was never pruned (233 entries with 40 live agents). Entries not
 * seen for `ttlMs` are dropped, except those `keep` says are still needed (an agent holding a
 * reservation). A dropped agent that comes back re-registers exactly as after a coordinator restart
 * (signed /register, portal validation). Returns the dropped ids so callers can drop their own state.
 */
export function pruneStaleAgentCapabilities(nowMs: number, ttlMs: number, keep: (agentId: string) => boolean = () => false): string[] {
  const dropped: string[] = [];
  for (const [agentId, cap] of agentCapabilities) {
    if (nowMs - cap.lastSeenMs <= ttlMs || keep(agentId)) continue;
    agentCapabilities.delete(agentId);
    lastTaskAssignedByAgent.delete(agentId);
    dropped.push(agentId);
  }
  return dropped;
}
export const envelopeSharedKeys = new Map<string, { key: Buffer; createdAtMs: number }>();
export const ENVELOPE_KEY_TTL_MS = 60 * 60 * 1000; // 1 hour
export const federatedCapabilities = new Map<string, CapabilitySummaryPayload>();
export const lastTaskAssignedByAgent = new Map<string, number>();
export const ollamaRollouts = new Map<string, OllamaRolloutRecord>();
export const pendingTunnelInvites = new Map<string, Array<{ fromAgentId: string; token: string }>>();
export const activeTunnels = new Map<
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
export const tunnelByPairKey = new Map<string, string>();
const TUNNEL_IDLE_TTL_MS = CC.TUNNEL_IDLE_TTL_MS;
export const TUNNEL_MAX_RELAYS_PER_MIN = CC.TUNNEL_MAX_RELAYS_PER_MIN;
export const RELAY_RATE_LIMIT_PER_10S = CC.RELAY_RATE_LIMIT_PER_10S;
export const DIRECT_WORK_OFFERS_PER_10S = CC.DIRECT_WORK_OFFERS_PER_10S;
export const blacklistByAgent = new Map<string, BlacklistRecord>();
export const blacklistAuditLog: BlacklistRecord[] = [];

// ── Behavioral monitoring ──
export const behaviorTracker = new AgentBehaviorTracker(undefined, { submitterFailureCap: CC.BEHAVIOR_SUBMITTER_FAILURE_CAP });
// BHV001 never strikes on speed for kinds this coordinator verifies by re-execution: it flags
// the agent (fastResultVerificationFlags) and verification decides. With verification off
// (RESULT_VERIFICATION_RATE=0) nothing is verifiable, so a sustained pattern can strike.
const behaviourVerification = verificationConfigFromEnv();
export const anomalyDetector = new AnomalyDetector({
  suspiciouslyFastVerifiableKinds: behaviourVerification.rate > 0 ? [...behaviourVerification.kinds] : [],
});
/** Agents whose next verifiable results are verified whatever the sampling draw (BHV001 flags). */
export const fastResultVerificationFlags = new VerificationFlags();
/** Append a blacklist record this coordinator issues itself (signed with its key) and gossip it. */
export function issueCoordinatorBlacklistRecord(input: {
  agentId: string;
  reasonCode: BlacklistReasonCode;
  reason: string;
  evidenceHashSha256: string;
  reportedBy: string;
  expiresAtMs?: number;
}): BlacklistRecord {
  const now = Date.now();
  const eventId = randomUUID();
  const evidenceSignatureVerified = false;
  const prevEventHash = mutable.lastBlacklistEventHash;
  const eventHash = buildBlacklistEventHash({
    eventId,
    agentId: input.agentId,
    reasonCode: input.reasonCode,
    reason: input.reason,
    evidenceHashSha256: input.evidenceHashSha256,
    reporterId: identity.peerId,
    sourceCoordinatorId: identity.peerId,
    timestampMs: now,
    expiresAtMs: input.expiresAtMs,
    prevEventHash,
    evidenceSignatureVerified,
  });
  const coordinatorSignature = signPayload(eventHash, coordinatorKeys.privateKeyPem);
  const record: BlacklistRecord = {
    eventId,
    agentId: input.agentId,
    reasonCode: input.reasonCode,
    reason: input.reason,
    evidenceHashSha256: input.evidenceHashSha256,
    reporterId: identity.peerId,
    evidenceSignatureVerified,
    sourceCoordinatorId: identity.peerId,
    reportedBy: input.reportedBy,
    timestampMs: now,
    expiresAtMs: input.expiresAtMs,
    prevEventHash,
    eventHash,
    coordinatorSignature,
  };
  appendBlacklistRecord(record);
  const gossipMessage = protocol.createMessage(
    "blacklist_update",
    identity.peerId,
    record as unknown as Record<string, unknown>,
    coordinatorKeys.privateKeyPem
  );
  void mesh.broadcast(gossipMessage);
  return record;
}

export const autoBlacklister = new AutoBlacklister((action: BlacklistAction) => {
  issueCoordinatorBlacklistRecord({
    agentId: action.agentId,
    reasonCode: action.reasonCode,
    reason: action.reason,
    evidenceHashSha256: action.evidenceHashSha256,
    reportedBy: "behavioral_monitoring",
    expiresAtMs: CC.AUTO_BLACKLIST_TTL_MS > 0 ? Date.now() + CC.AUTO_BLACKLIST_TTL_MS : undefined,
  });
  securityLog.log({
    level: "CRITICAL",
    event: "auto_blacklist_triggered",
    source: { type: "system", id: identity.peerId },
    details: { agentId: action.agentId, reasonCode: action.reasonCode, reason: action.reason, rules: action.anomalyEvents.map(e => e.ruleId) },
    action: "agent_blacklisted",
    coordinatorId: identity.peerId,
  });
});

export function evaluateAndEnforce(agentId: string): void {
  const stats = behaviorTracker.getStats(agentId);
  if (!stats) return;
  const anomalies = anomalyDetector.evaluate(stats);
  if (anomalies.length > 0) {
    for (const anomaly of anomalies) {
      securityLog.log({
        level: anomaly.severity,
        event: "behavioral_anomaly_detected",
        source: { type: "agent", id: agentId },
        details: { ruleId: anomaly.ruleId, ruleName: anomaly.ruleName, ...anomaly.stats },
        action: "anomaly_recorded",
        coordinatorId: identity.peerId,
      });
    }
    // Flags are not strikes: BHV001's first stage and the output-content rules (BHV002, BHV003,
    // BHV010) send the agent's next results to verification.
    if (anomalies.some((a) => a.enforcement === "flag")) fastResultVerificationFlags.flag(agentId);
    autoBlacklister.processAnomalies(agentId, anomalies);
  }
}

// ── Release manifest cache for code signing verification ──
export const releaseManifestCache = new ReleaseManifestCache();
releaseManifestCache.start();
export const REQUIRE_VERIFIED_AGENTS = CC.REQUIRE_VERIFIED_AGENTS;
// #44: signed agent requests are mandatory by default (always in production).
export const REQUIRE_SIGNED_AGENT_REQUESTS = requireSignedAgentRequests();

export const relayWindowByAgent = new Map<string, { windowMs: number; count: number }>();
export const offerWindowByAgent = new Map<string, { windowMs: number; count: number }>();
export const pendingTunnelCloseNotices = new Map<string, Array<{ peerAgentId: string; token: string; reason: string }>>();

export function activeBlacklistRecord(agentId: string): BlacklistRecord | undefined {
  const record = blacklistByAgent.get(agentId);
  if (!record) return undefined;
  if (record.expiresAtMs && Date.now() > record.expiresAtMs) {
    blacklistByAgent.delete(agentId);
    mutable.blacklistVersion += 1;
    return undefined;
  }
  return record;
}

/** #122: blacklisted here or by any coordinator on the shared database. */
export async function meshBlacklistReason(agentId: string): Promise<string | null> {
  const local = activeBlacklistRecord(agentId);
  if (local) return local.reason;
  const shared = await pgStore?.latestBlacklistEvent(agentId);
  if (shared && !(shared.expiresAtMs && Date.now() > shared.expiresAtMs)) return shared.reason;
  return null;
}

export function appendBlacklistRecord(record: BlacklistRecord): void {
  blacklistByAgent.set(record.agentId, record);
  blacklistAuditLog.push(record);
  mutable.blacklistVersion += 1;
  mutable.lastBlacklistEventHash = record.eventHash;
  void pgStore?.persistBlacklistEvent(record).catch(() => undefined);
}

export async function upsertRollout(record: OllamaRolloutRecord): Promise<void> {
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

export function cleanupStaleTunnels(): number {
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
