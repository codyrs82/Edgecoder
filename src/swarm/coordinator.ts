// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { loadConfigOrExit } from "../common/config.js";
import { coordinatorConfigSchema } from "./coordinator-config.js";
import { pullSandboxRejection } from "./sandbox-enforcement.js";
import Fastify, { type FastifyReply } from "fastify";
import { exposeRequestId, serviceLoggerOptions } from "../common/http-logging.js";
import { registerMetrics } from "../common/metrics.js";
import { registerErrorTracking } from "../common/error-tracking.js";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { createHash, createPrivateKey, createPublicKey, randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { request } from "undici";
import { z } from "zod";
import {
  safeTokenEqual,
  normalizeIpCandidate,
  readHeaderValue,
  extractClientIp,
  clientIpTrustFromEnv,
  isLoopbackSocket,
  socketRemoteAddress,
  normalizeUrl,
  pairKey,
  weightedMedian,
  parseRecordPayload,
  computeIntentFee,
  contributionPolicyDecision,
  submitterAccountDecision,
} from "./coordinator-utils.js";
import { RobotQueue } from "./robot-queue.js";
import { registerRobotRoutes } from "./robot-routes.js";
import { registerDiscoveryRoutes, startCoordinatorAnnouncer } from "../discovery/announce.js";
import { createRegistryMirror } from "../discovery/registry-mirror.js";
import { extractCode } from "../model/extract.js";
import { SwarmQueue, leaseConfigFromEnv } from "./queue.js";
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
  WalletType,
  Subtask,
  CapabilitySummaryPayload,
  PeerExchangePayload,
  CapabilityAnnouncePayload,
  MeshPeerRole,
  SandboxMode,
  SubtaskResult
} from "../common/types.js";
import { createPeerIdentity, createPeerKeys, signPayload, verifyPayload } from "../mesh/peer.js";
import {
  admitPeer,
  allowlistEnforced,
  checkPeerRegistration,
  isAllowlistedKey,
  parsePeerAllowlist,
  parsePeerUrlPins,
  assertUrlPinsForProduction,
  type PeerUrlPins,
  ReplayCache,
  signForwardedResult,
  signRegistration,
  verifyForwardedResult,
  type PeerAllowlist
} from "../mesh/peer-trust.js";
import { MeshProtocol } from "../mesh/protocol.js";
import { MESH_WS_BIND_MAX_SKEW_MS, decideMeshWsBind, meshWsSenderMatches } from "../mesh/ws-auth.js";
import { legacyPemFingerprints, publicKeyFingerprint } from "../security/key-fingerprint.js";
import { IDENTITY_CHALLENGE_PATH, answerIdentityChallenge } from "../trust/identity-challenge.js";
import { RESPONSE_SIGNING_VERSION, registerResponseSigning } from "../trust/response-signing.js";
import { GossipMesh } from "../mesh/gossip.js";
import { OrderingChain } from "../ledger/chain.js";
import { verifyOrderingChain } from "../ledger/verify.js";
import { hashRecordPayload } from "../ledger/record.js";
import { finalizeStatsCheckpoint, statsCheckpointPeriodMs, statsFinalityState } from "../ledger/stats-checkpoint.js";
import { DuplicateDebitError, NETWORK_FEE_POOL_ACCOUNT, accruePricedJob, creditEngine, earnedMsat, grantCredits, grantCreditsIdempotent, refundTxId, rewardAccountForAgent, spendCredits } from "../credits/store.js";
import { clampToBand, cSatsPerMTokens, inferenceCostMsat, jobCostMsat, msatToCSats, ratePerSecondMsat, reserveMsat, splitJobCost } from "../economy/job-pricing.js";
import { paramsB } from "../inference-api/auto-route.js";
import { InferenceStreams } from "./inference-streams.js";
import { MemoryPayoutStore, PayoutService, type FeePoolDistribution, type PayoutStore } from "../economy/payout-service.js";
import { PayoutPauseControl, payoutLimitsFromEnv, payoutsPausedByEnv } from "../economy/payout-safeguards.js";
import { PayoutReconciler, payoutReconcileConfigFromEnv } from "../economy/payout-reconcile.js";
import { payoutPolicyFromEnv } from "../economy/payouts.js";
import { MemoryCallbackPinStore, callbackPinStatus, type CallbackPinStore } from "../economy/lnurl-callback-pin.js";
import { validateLightningAddress } from "../economy/payout-destination.js";
import { fetchPublicJson } from "../security/public-fetch.js";
import type { CreditTransaction, InfrastructureHost } from "../common/types.js";
import { ensureOllamaModelInstalled } from "../model/ollama-installer.js";
import { pgStore } from "../db/store.js";
import type { PostgresStore } from "../db/postgres.js";
import { computeDynamicPricePerComputeUnitSats, creditsForSats, dynamicLoadMultiplier, satsForCredits } from "../economy/pricing.js";
import { isRateEpochStale, normalizeRateEpoch, rateOracleConfigFromEnv, recalibrateRates, type RateEpoch } from "../economy/rate-oracle.js";
import {
  ACCEPTED_COMPUTE_CLASS_IDS,
  COMPUTE_CLASS_IDS,
  classifyHardware,
  modalityMultiplier,
  normalizeComputeClass,
  resolveRequestedClass,
  settlementClassFor,
  type ComputeClassId,
  type HardwareClassification,
  type HardwareProfile, satsPerCreditForClass } from "../economy/compute-classes.js";
import { MemoryUsageStore, summarizeUsage, type UsageRecord } from "../economy/usage.js";
import { ReservationBook, RESERVATION_MAX_MINUTES, RESERVATION_MIN_MINUTES, claimReservationEnd, dueReservations, reservationPriceMsat, syncReservations, type Reservation, type ReservationEndReason } from "../economy/reservations.js";
import { ComputeOrderBook, capabilityConstraints, clampToClassReference, meetsCapability, type AskCapability } from "../economy/order-book.js";
import { CANDLE_INTERVALS, MarketHistory, type MarketOrder } from "../economy/market-history.js";
import { catalogEntryForTag } from "../model/catalog.js";
import {
  computeDailyPoolTokens,
  computeHourlyIssuanceAllocations,
  computeLoadIndex,
  IssuancePoolConfig,
  smoothLoadIndex
} from "../economy/issuance.js";
import {
  ensureIssuanceEpoch,
  type IssuanceAllocationDraft,
  type IssuanceEpochDraft,
  type IssuanceWindow
} from "../economy/issuance-epoch.js";
import { checkSharedToken, debugRoutesEnabled, isProduction, LISTEN_HOST, requireProdEnv } from "../common/env-guard.js";
import {
  HOST_HEARTBEAT_MAX_SKEW_MS,
  HostServiceAttestor,
  attestSelfServices,
  heartbeatCounts,
  networkServiceProbes,
  normalizeServices,
  signHostHeartbeat,
  verifyHostHeartbeat,
  type AttestationResult
} from "../economy/host-attestation.js";
import { probeElectrum } from "../economy/service-probes.js";
import { createLightningProviderFromEnv, economyPaymentsEnabled, type LightningProvider } from "../economy/lightning.js";
import { createBitcoinAnchorProviderFromEnv, type BitcoinAnchorProvider } from "../economy/bitcoin-rpc.js";
import {
  anchorCheckpoint,
  reconcileAnchors,
  reconcileConfigFromEnv,
  isTxid,
  refreshAnchors,
  requiredConfirmationsFromEnv,
  type AnchorDeps
} from "../economy/anchoring.js";
// ── Work receipts + replication (architecture step 2; src/receipts) ──
import { MemoryReceiptStore, type ReceiptStore } from "../receipts/store.js";
import { registerReceiptRoutes, startReceiptReplication } from "../receipts/replication.js";
import { anchorEpoch, closeEpoch } from "../receipts/epochs.js";
import { agentReceiptClaimSchema, issueReceiptForAccrual } from "../receipts/issue.js";
import type { SignedAgentReceiptClaim } from "../receipts/receipt.js";
import {
  checkResultClaim,
  classifyResultAuth,
  creditedDurationMs,
  requireSignedAgentRequests,
  resultReportId,
  unsignedRequestDecision
} from "./result-integrity.js";
import {
  ResultVerifier,
  executorKey,
  payableWinners,
  verificationConfigFromEnv,
  verificationStartupWarning,
  type ExecutionResult,
  type PendingVerificationSnapshot,
  type ReplicaRequest,
  type VerificationOutcome
} from "./verification.js";
import { HardwareVerifier, hardwareVerificationConfigFromEnv, type HardwareVerificationRecord } from "./hardware-verification.js";
import type { ChallengeResponse } from "./benchmark.js";
import {
  applyBleSyncBatch,
  bleSyncAllowV1,
  createBleSyncSchema,
  createInMemoryBleTransfer,
  isBleSyncAuthorized
} from "../credits/ble-sync.js";
import {
  assertPaymentWebhookSecret,
  createPaymentSettler,
  reconcilePaymentIntent,
  verifyPaymentWebhookSignature
} from "../economy/payment-settlement.js";
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
import { EscalationResolver, createEscalationResolverFromEnv } from "../escalation/server.js";
import { buildCapabilitySummary, type AgentCapabilityInfo } from "../mesh/capability-gossip.js";
import { createTaskEnvelope, decryptResult as decryptEnvelopeResult, type TaskEnvelope, type EncryptedResult } from "../security/envelope.js";
import { installRawBodyCapture, rawBodyOf, verifySignedRequest, type SignedHeaders } from "../security/request-signing.js";
import { FallbackNonceStore, InMemoryNonceStore, verifyNonce, type NonceStore } from "../security/nonce-verifier.js";
import { AgentRateLimiter } from "../security/agent-rate-limiter.js";
import { SecurityEventLogger, type SecurityEventType } from "../audit/security-events.js";
import { startPruneScheduler, type PrunableStore } from "../audit/prune-scheduler.js";
import { AgentBehaviorTracker } from "../security/behavior-tracker.js";
import { AnomalyDetector } from "../security/anomaly-detector.js";
import { AutoBlacklister, type BlacklistAction } from "../security/auto-blacklister.js";
import { verifyBinaryIntegrity, type VerificationStatus, type BinaryIntegrityPayload } from "../security/release-verifier.js";
import { ReleaseManifestCache } from "../security/release-manifest-cache.js";
import { isValidSnapshotRef } from "./snapshot-resolver.js";
import { PullTracker } from "../model/pull-tracker.js";
import { buildChatSystemPrompt, type SystemPromptContext } from "../model/system-prompt.js";
import { ollamaTags, listModels } from "../model/swap.js";

const app = Fastify({ ...serviceLoggerOptions("coordinator") });
exposeRequestId(app);
registerMetrics(app, "coordinator");
await registerErrorTracking(app, "coordinator");
// #118 review: keep the exact request bytes so signed bodies (forwarded /result, agent requests)
// are verified against what was sent, not a re-serialization.
installRawBodyCapture(app);
await app.register(cors, {
  origin: ["tauri://localhost", "https://tauri.localhost", "http://localhost:1420"],
  credentials: true,
});
await app.register(websocket);
// #15: numeric, boolean, enum and URL settings validated once at startup (see coordinator-config.ts).
const CC = loadConfigOrExit("coordinator", coordinatorConfigSchema);
const queue = new SwarmQueue(pgStore, leaseConfigFromEnv());
// #51: subtasks failed at the retry cap go through finalizeFailedSubtask (declared below).
queue.onLeaseFailure((result) => {
  void finalizeFailedSubtask(result).catch((err) =>
    app.log.error({ err, subtaskId: result.subtaskId }, "subtask_failure_finalize_failed")
  );
});
const protocol = new MeshProtocol();
const mesh = new GossipMesh();
// #118 review: one admission rule for every way into the peer table.
mesh.setAdmission((peer, existing, opts) =>
  admitPeer({
    allowlist: MESH_PEER_ALLOWLIST,
    pins: MESH_PEER_URL_PINS,
    production: isProduction(),
    peer,
    existing,
    authoritative: opts.authoritative,
    source: opts.source
  })
);
mesh.onBroadcast((message) => {
  if (message.type !== "task_offer") return;
  const subtaskId = message.payload?.subtaskId;
  if (typeof subtaskId !== "string") return;
  const now = Date.now();
  for (const [id, exp] of offeredToPeers) if (exp <= now) offeredToPeers.delete(id);
  offeredToPeers.set(subtaskId, now + OFFERED_SUBTASK_TTL_MS);
});
if (process.env.MESH_AUTH_TOKEN) {
  mesh.setMeshToken(process.env.MESH_AUTH_TOKEN);
}
const peerScore = new Map<string, number>();
const peerMessageWindow = new Map<string, { windowMs: number; count: number }>();
const MESH_RATE_LIMIT_PER_10S = 50;

/** Tracks origin coordinator for tasks received via mesh gossip, so results can be forwarded back. */
const taskOriginMap = new Map<string, { coordinatorId: string; coordinatorUrl: string }>();
/** #51: what /submit charged per task, so a task that fails permanently is refunded once. */
/**
 * What a task's requester was charged: cSats set aside at submit (reservedMsat, the worst case),
 * the actual cost of its finished subtasks (costMsat, job-pricing.ts), and whether the difference
 * went back (refunded). Settled when the last subtask finishes; a failed task refunds what it
 * didn't use.
 */
interface TaskBilling {
  accountId: string;
  reservedMsat: number;
  /** Worst case per subtask; charged in full for a subtask run elsewhere (cost unknown here). */
  perSubtaskReserveMsat: number;
  costMsat: number;
  refunded: boolean;
}
const taskBilling = new Map<string, TaskBilling>();
/** Usage records being filled in (keyed by task) until the task settles; then saved. */
const usagePending = new Map<string, UsageRecord>();
const memoryUsage = new MemoryUsageStore();
async function saveUsage(r: UsageRecord): Promise<void> {
  if (pgStore) await pgStore.insertUsage(r).catch((err) => app.log.warn({ err, id: r.id }, "usage_save_failed"));
  else memoryUsage.add(r);
}
/** A result arrived: which agent and class ran it, for how long (summed over a task's subtasks). */
function noteUsageRun(taskId: string, agentId: string, ok: boolean, durationMs: number, computeClass?: string): void {
  const u = usagePending.get(taskId);
  if (!u) return;
  u.agentId = agentId;
  u.ok = ok;
  u.durationMs += Math.max(0, durationMs);
  if (computeClass) u.computeClass = computeClass;
}
/** Reserved-capacity leases: an account holds one agent for a set time, paid up front. */
const reservations = new ReservationBook();

/** Longest a subtask may run (the envelope default): the time the worst case is set aside for. */
const SUBTASK_RESERVE_TIMEOUT_MS = 60_000;

/** BTC price used for class references until the rate oracle has published. */
const FALLBACK_BTC_USD = 100_000;

/** msat per credit (base-tier second) of a class: the oracle's rate, else its USD reference. */
function classRefMsatPerCredit(cls: ComputeClassId): number {
  const oracle = latestRateEpoch?.classRates?.[cls]?.msatPerCredit;
  if (oracle && oracle > 0) return oracle;
  const spec = rateOracleConfig.computeClasses[cls];
  return satsPerCreditForClass(spec?.usdPerHourReference ?? 0.02, FALLBACK_BTC_USD, 0) * 1000;
}

/**
 * Worst-case msat to set aside for one subtask: CPU work is paid as CPU (settlementClassFor); GPU
 * work at the requested class, or the dearest GPU-type class for "any".
 */
function subtaskReserveMsat(resourceClass: ResourceClass, taskClass: ComputeClassId | "any", timeoutMs: number, bidCeiling?: number): number {
  const classes: ComputeClassId[] =
    resourceClass === "cpu" ? ["cpu"] : taskClass === "any" ? (Object.keys(rateOracleConfig.computeClasses) as ComputeClassId[]).filter((c) => c !== "cpu") : [taskClass];
  return Math.max(
    ...classes.map((c) =>
      reserveMsat({
        timeoutMs,
        classRefMsatPerCredit: classRefMsatPerCredit(c),
        maxTierWeight: Math.max(1, ...(rateOracleConfig.computeClasses[c]?.tiers ?? []).map((t) => t.creditsPerSecond)),
        bidCeilingMsatPerCredit: bidCeiling,
      })
    )
  );
}
/** Market price agreed at claim time per subtask (msat per credit on the agent's class) and the tier weight the credits mint at. */
const claimedTradePrice = new Map<string, { msatPerCredit: number; computeClass: ComputeClassId; creditsPerSecond: number }>();
const MESH_AUTH_TOKEN = process.env.MESH_AUTH_TOKEN ?? "";
// #52: coordinators trusted by key, not just by holding MESH_AUTH_TOKEN. Required in production.
const MESH_PEER_ALLOWLIST: PeerAllowlist = (() => {
  try {
    const parsed = parsePeerAllowlist(process.env.MESH_PEER_ALLOWLIST);
    assertUrlPinsForProduction(process.env.MESH_PEER_ALLOWLIST, isProduction());
    return parsed;
  } catch (error) {
    // Fail closed, but say why before the process exits.
    console.error(`[coordinator] FATAL: invalid MESH_PEER_ALLOWLIST: ${(error as Error).message}`);
    throw error;
  }
})();
// #118 review: optional `@url` on each allowlist entry pins that peer's endpoint.
const MESH_PEER_URL_PINS: PeerUrlPins = parsePeerUrlPins(process.env.MESH_PEER_ALLOWLIST);
const PEER_ALLOWLIST_ENFORCED = allowlistEnforced(MESH_PEER_ALLOWLIST, isProduction());
/** #118 review: forwarded-result replay protection and the subtasks we actually offered to peers. */
const forwardReplayCache = new ReplayCache();
const OFFERED_SUBTASK_TTL_MS = 24 * 60 * 60 * 1000;
const offeredToPeers = new Map<string, number>();
const PORTAL_SERVICE_URL = CC.PORTAL_SERVICE_URL ?? "";
/** Which forwarded-IP headers to believe (COORDINATOR_TRUST_PROXY, Fly-Client-IP on Fly). Display/geo only. */
const CLIENT_IP_TRUST = clientIpTrustFromEnv(process.env);
/** The request's network origin: the socket decides loopback; headers only feed the display IP. */
function requestOrigin(req: unknown): { clientIp?: string; loopback: boolean } {
  const r = req as { headers?: Record<string, unknown>; socket?: { remoteAddress?: string }; raw?: { socket?: { remoteAddress?: string } } };
  const socketIp = socketRemoteAddress(r);
  return {
    clientIp: extractClientIp(r.headers ?? {}, socketIp, CLIENT_IP_TRUST),
    loopback: isLoopbackSocket(socketIp, CLIENT_IP_TRUST)
  };
}
const PORTAL_SERVICE_TOKEN = process.env.PORTAL_SERVICE_TOKEN ?? "";
// What this coordinator presents to the portal's read/validate /internal routes. Defaults to
// PORTAL_SERVICE_TOKEN; once PORTAL_COORDINATOR_TOKEN is set here and on the portal, coordinators
// no longer need the portal's own service token for those calls.
const PORTAL_OUTBOUND_TOKEN = (process.env.PORTAL_COORDINATOR_TOKEN ?? "").trim() || PORTAL_SERVICE_TOKEN;
const COORDINATOR_FEE_BPS = CC.COORDINATOR_FEE_BPS;
const COORDINATOR_FEE_ACCOUNT = process.env.COORDINATOR_FEE_ACCOUNT ?? "coordinator-fee:default";
const BITCOIN_NETWORK = CC.BITCOIN_NETWORK;
const ROBOT_QUEUE_ENABLED = CC.ROBOT_QUEUE_ENABLED;
const ROBOT_COORDINATOR_FEE_BPS = CC.ROBOT_COORDINATOR_FEE_BPS;
const coordinatorPullTracker = new PullTracker();
const ROBOT_SWEEP_INTERVAL_MS = CC.ROBOT_SWEEP_INTERVAL_MS;
const ROBOT_MIN_SWEEP_SATS = CC.ROBOT_MIN_SWEEP_SATS;
const ROBOT_TASK_DEFAULT_TIMEOUT_MS = CC.ROBOT_TASK_DEFAULT_TIMEOUT_MS;
const ROBOT_AUTO_SETTLE_DELAY_MS = CC.ROBOT_AUTO_SETTLE_DELAY_MS;
const APPROVED_COORDINATOR_IDS = new Set(
  (process.env.APPROVED_COORDINATOR_IDS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);
const PAYMENT_INTENT_TTL_MS = CC.PAYMENT_INTENT_TTL_MS;
const CONTRIBUTION_BURST_CREDITS = CC.CONTRIBUTION_BURST_CREDITS;
const MIN_CONTRIBUTION_RATIO = CC.MIN_CONTRIBUTION_RATIO;
const ISSUANCE_WINDOW_MS = CC.ISSUANCE_WINDOW_MS;
const ISSUANCE_RECALC_MS = CC.ISSUANCE_RECALC_MS;
const ISSUANCE_BASE_DAILY_POOL_TOKENS = CC.ISSUANCE_BASE_DAILY_POOL_TOKENS;
const ISSUANCE_MIN_DAILY_POOL_TOKENS = CC.ISSUANCE_MIN_DAILY_POOL_TOKENS;
const ISSUANCE_MAX_DAILY_POOL_TOKENS = CC.ISSUANCE_MAX_DAILY_POOL_TOKENS;
const ISSUANCE_LOAD_CURVE_SLOPE = CC.ISSUANCE_LOAD_CURVE_SLOPE;
const ISSUANCE_SMOOTHING_ALPHA = CC.ISSUANCE_SMOOTHING_ALPHA;
const ISSUANCE_COORDINATOR_SHARE = CC.ISSUANCE_COORDINATOR_SHARE;
const ISSUANCE_RESERVE_SHARE = CC.ISSUANCE_RESERVE_SHARE;
const ANCHOR_INTERVAL_MS = CC.ANCHOR_INTERVAL_MS;
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "";
// #5: fail fast in production instead of silently running with auth disabled.
// LIGHTNING_PROVIDER is only required while payments are enabled (see #43 ECONOMY_PAYMENTS_ENABLED).
requireProdEnv("coordinator", [
  "MESH_AUTH_TOKEN",
  "PORTAL_SERVICE_URL",
  "PORTAL_SERVICE_TOKEN",
  "ADMIN_API_TOKEN",
  "PAYMENT_WEBHOOK_SECRET",
  ...(economyPaymentsEnabled() ? ["LIGHTNING_PROVIDER"] : [])
]);
const IS_PROD = isProduction();
// #42: production must verify webhook HMACs.
assertPaymentWebhookSecret();
const IOS_BATTERY_PULL_MIN_INTERVAL_MS = CC.IOS_BATTERY_PULL_MIN_INTERVAL_MS;
const IOS_BATTERY_TASK_STOP_LEVEL_PCT = CC.IOS_BATTERY_TASK_STOP_LEVEL_PCT;
const CONTROL_PLANE_URL = CC.CONTROL_PLANE_URL ?? "";
const COORDINATOR_PUBLIC_URL = CC.COORDINATOR_PUBLIC_URL;
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
const STATS_LEDGER_SYNC_INTERVAL_MS = CC.STATS_LEDGER_SYNC_INTERVAL_MS;
const STATS_ANCHOR_INTERVAL_MS = CC.STATS_ANCHOR_INTERVAL_MS;
const STATS_ANCHOR_MIN_CONFIRMATIONS = CC.STATS_ANCHOR_MIN_CONFIRMATIONS;
// #46: depth at which an anchor counts as "anchored", and how often pending anchors are polled.
const ANCHOR_REQUIRED_CONFIRMATIONS = requiredConfirmationsFromEnv();
/** #103: reconcile in-flight / stuck anchors on startup and on this interval. */
const ANCHOR_RECONCILE_MS = Math.max(60_000, Number(process.env.ANCHOR_RECONCILE_MS ?? "900000") || 900_000);
const ANCHOR_RECONCILE_CONFIG = reconcileConfigFromEnv();
const ANCHOR_CONFIRM_POLL_MS = Math.max(30_000, Number(process.env.ANCHOR_CONFIRM_POLL_MS ?? "600000") || 600_000);
const AGENT_RATE_LIMIT_MAX = CC.AGENT_RATE_LIMIT_MAX;
const AGENT_RATE_LIMIT_WINDOW_MS = CC.AGENT_RATE_LIMIT_WINDOW_MS;
const SECURITY_NONCE_TTL_MS = CC.SECURITY_NONCE_TTL_MS;
const SECURITY_MAX_SKEW_MS = CC.SECURITY_MAX_SKEW_MS;
const agentRateLimiter = new AgentRateLimiter({ maxRequests: AGENT_RATE_LIMIT_MAX, windowMs: AGENT_RATE_LIMIT_WINDOW_MS });
// Replay protection: Postgres when configured, so nonces survive restarts and are shared by every
// coordinator on the database (a replay to the other seed is caught); in memory otherwise.
const nonceStore: NonceStore = pgStore
  ? new FallbackNonceStore(pgStore.nonceStore(), (error) => app.log.warn({ error: String(error) }, "nonce_store_degraded_to_memory"))
  : new InMemoryNonceStore();
const securityLog = new SecurityEventLogger((event) => {
  const level = event.level === "CRITICAL" || event.level === "HIGH" ? "warn" : "info";
  app.log[level]({ securityEvent: event }, `security:${event.event}`);
});

function loadCoordinatorKeys() {
  // Derive a unique peerId from COORDINATOR_PUBLIC_URL so each coordinator
  // instance has a distinct identity in the mesh (avoids peerId collision
  // that prevents mutual peering).
  const explicitPeerId = process.env.COORDINATOR_PEER_ID;
  const peerId = explicitPeerId ??
    `coord-${createHash("sha256").update(COORDINATOR_PUBLIC_URL).digest("hex").slice(0, 12)}`;
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
const PROVIDER = CC.LOCAL_MODEL_PROVIDER;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
const OLLAMA_HOST = process.env.OLLAMA_HOST;
const OLLAMA_AUTO_INSTALL = CC.OLLAMA_AUTO_INSTALL;
const INFERENCE_URL = CC.INFERENCE_URL;
const INFERENCE_AUTH_TOKEN = process.env.INFERENCE_AUTH_TOKEN ?? "";
const identity = createPeerIdentity(coordinatorKeys, COORDINATOR_PUBLIC_URL, networkMode);
// Every response to an agent request (one carrying x-agent-nonce: register, heartbeat, pull, result,
// agent-mesh, inference, orchestration, errors included) is signed with the identity key, in headers
// or, for a streamed body, in a trailer (src/trust/response-signing.ts). Advertised as responseSigning.
registerResponseSigning(app, { peerId: identity.peerId, privateKeyPem: coordinatorKeys.privateKeyPem });
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
const envelopeSharedKeys = new Map<string, { key: Buffer; createdAtMs: number }>();
const ENVELOPE_KEY_TTL_MS = 60 * 60 * 1000; // 1 hour
const federatedCapabilities = new Map<string, CapabilitySummaryPayload>();
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
const TUNNEL_IDLE_TTL_MS = CC.TUNNEL_IDLE_TTL_MS;
const TUNNEL_MAX_RELAYS_PER_MIN = CC.TUNNEL_MAX_RELAYS_PER_MIN;
const RELAY_RATE_LIMIT_PER_10S = CC.RELAY_RATE_LIMIT_PER_10S;
const DIRECT_WORK_OFFERS_PER_10S = CC.DIRECT_WORK_OFFERS_PER_10S;
const blacklistByAgent = new Map<string, BlacklistRecord>();
const blacklistAuditLog: BlacklistRecord[] = [];
let blacklistVersion = 0;
let lastBlacklistEventHash = "BLACKLIST_GENESIS";

// ── Behavioral monitoring ──
const behaviorTracker = new AgentBehaviorTracker();
const anomalyDetector = new AnomalyDetector();
/** Append a blacklist record this coordinator issues itself (signed with its key) and gossip it. */
function issueCoordinatorBlacklistRecord(input: {
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
  const prevEventHash = lastBlacklistEventHash;
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

const autoBlacklister = new AutoBlacklister((action: BlacklistAction) => {
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

function evaluateAndEnforce(agentId: string): void {
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
    autoBlacklister.processAnomalies(agentId, anomalies);
  }
}

// ── Release manifest cache for code signing verification ──
const releaseManifestCache = new ReleaseManifestCache();
releaseManifestCache.start();
const REQUIRE_VERIFIED_AGENTS = CC.REQUIRE_VERIFIED_AGENTS;
// #44: signed agent requests are mandatory by default (always in production).
const REQUIRE_SIGNED_AGENT_REQUESTS = requireSignedAgentRequests();

const relayWindowByAgent = new Map<string, { windowMs: number; count: number }>();
const offerWindowByAgent = new Map<string, { windowMs: number; count: number }>();
const pendingTunnelCloseNotices = new Map<string, Array<{ peerAgentId: string; token: string; reason: string }>>();
const paymentIntents = new Map<string, PaymentIntent>();
const latestPriceEpochByResource = new Map<ResourceClass, PriceEpochRecord>();

// ── Rate oracle: sats per CPU-hour from market data, recalibrated daily ──
const RATE_RECALIBRATION_MS = CC.RATE_RECALIBRATION_MS;
const RATE_ORACLE_ENABLED = CC.RATE_ORACLE_ENABLED;
const rateOracleConfig = rateOracleConfigFromEnv();
let latestRateEpoch: RateEpoch | null = null;

/**
 * Compute market: agents' asks and tasks' bids per compute class, in msat per credit. The
 * oracle sets the reference each epoch; tracking asks follow it (see order-book.ts).
 */
const orderBook = new ComputeOrderBook();
/** Minute ticks + trade tape per class: candles, depth and the trade list for the market page. */
const marketHistory = new MarketHistory();
const MARKET_TICK_MS = 60_000;
/** Standing orders from the portal keyed by `${accountId}:${side}`. */
const marketOrders = new Map<string, MarketOrder>();
/**
 * Hardware verification (src/swarm/hardware-verification.ts): hardware is self-reported, so a tier
 * above the class base is paid only after the agent passes a coordinator-issued benchmark
 * challenge; until then (and for agents without benchmark support) it earns base weight 1.
 */
const hardwareVerifier = new HardwareVerifier({
  config: hardwareVerificationConfigFromEnv(),
  classes: rateOracleConfig.computeClasses,
  persist: (r) => pgStore?.upsertHardwareVerification(r)
});
/** The class, tier and weight an agent is paid and matched at (its verified grant); undefined for an unknown agent. */
function effectiveHardware(agentId: string, cap?: { hardwareClass?: HardwareClassification }): HardwareClassification | undefined {
  const c = cap ?? agentCapabilities.get(agentId);
  return c?.hardwareClass ? hardwareVerifier.effective(agentId, c.hardwareClass) : undefined;
}
/** What an agent's ask advertises to the matcher: verified tier and weight, capability (VRAM, memory), reliability. */
function askCapabilityOf(agentId: string, cap: { hardwareClass?: HardwareClassification } | undefined): AskCapability | undefined {
  const h = effectiveHardware(agentId, cap);
  const reliability = hardwareVerifier.reliability(agentId);
  return h ? { tier: h.tier, creditsPerSecond: h.creditsPerSecond, vramGb: h.vramGb, memoryGb: h.memoryGb, ...(reliability !== undefined ? { reliability } : {}) } : undefined;
}
/** Re-post an agent's ask after its grant changed; an explicit price survives only within the same class. */
function repostAsk(agentId: string, nowMs = Date.now()): void {
  const cap = agentCapabilities.get(agentId);
  const eff = effectiveHardware(agentId, cap);
  if (!cap || !eff) return;
  const prev = orderBook.askFor(agentId);
  const keepPrice = prev && !prev.tracking && prev.computeClass === eff.computeClass ? prev.msatPerCredit : undefined;
  orderBook.postAsk(agentId, eff.computeClass, keepPrice, nowMs, askCapabilityOf(agentId, cap));
}
/** Short verification state for the agent / portal. */
function verificationSummary(r: HardwareVerificationRecord | undefined): Record<string, unknown> | null {
  if (!r) return null;
  return { status: r.status, claimedTier: r.claimed.tier, grantedTier: r.granted.tier, grantedClass: r.granted.computeClass, measured: r.measured ?? null, reliability: hardwareVerifier.reliability(r.agentId) ?? null, flags: r.flags };
}
/** The Ollama model a GPU challenge runs on: the agent's active model, else the one it benchmarked. */
function benchmarkModelFor(agentId: string): string | undefined {
  const rec = hardwareVerifier.get(agentId);
  return agentCapabilities.get(agentId)?.activeModel || rec?.selfReport?.gpu?.model || rec?.selfReport?.loaded?.model || undefined;
}
/**
 * A second agent to run the same GPU challenge (cross-check): online, same model, not the subject's
 * owner or IP, preferring agents that are themselves cross-checked. Sybils across owners are the
 * residual risk; ongoing evidence and re-challenges with a fresh random witness bound it.
 */
function pickBenchmarkWitness(subjectId: string, model: string, nowMs: number): string | undefined {
  const subject = agentCapabilities.get(subjectId);
  const candidates: Array<{ id: string; rank: number }> = [];
  for (const [id, cap] of agentCapabilities) {
    if (id === subjectId || nowMs - cap.lastSeenMs > 2 * 60_000 || activeBlacklistRecord(id)) continue;
    if (subject?.ownerEmail && cap.ownerEmail === subject.ownerEmail) continue;
    if (subject?.sourceIp && cap.sourceIp === subject.sourceIp) continue;
    const rec = hardwareVerifier.get(id);
    if (!rec?.challengeKinds.includes("gpu") || benchmarkModelFor(id) !== model) continue;
    candidates.push({ id, rank: rec.measured?.crossChecked ? 2 : rec.status === "verified" ? 1 : 0 });
  }
  const best = Math.max(-1, ...candidates.map((c) => c.rank));
  const top = candidates.filter((c) => c.rank === best);
  return top.length ? top[randomInt(top.length)].id : undefined;
}

const MARKET_BID_MAX_AGE_MS = 24 * 60 * 60_000;
function recordMarketTicks(nowMs = Date.now()): void {
  // Bids are per task; drop any that outlived their task (failed, abandoned, lost on restart).
  orderBook.pruneBids((bid) => nowMs - bid.createdAtMs > MARKET_BID_MAX_AGE_MS || (queue.openSubtaskCount(bid.taskId) === 0 && nowMs - bid.createdAtMs > 10 * 60_000));
  for (const id of COMPUTE_CLASS_IDS) {
    if (!orderBook.hasReference(id)) continue; // no oracle rate yet: nothing meaningful to chart
    const snap = orderBook.snapshot(id, nowMs);
    const tick = {
      atMs: nowMs,
      computeClass: id,
      referenceMsat: snap.referenceMsatPerCredit,
      bestAskMsat: snap.bestAsk,
      bestBidMsat: snap.bestBid,
      midMsat: snap.midMsatPerCredit,
      clearingMsat: snap.clearingMsatPerCredit,
      agents: snap.agents,
      openTasks: snap.openTasks
    };
    marketHistory.recordTick(tick);
    void pgStore?.persistMarketTick(tick).catch(() => undefined);
  }
}

/** A seller's standing order applies to every agent the account owns; a buyer's becomes the default bid for its tasks. */
async function applyMarketOrder(order: MarketOrder): Promise<void> {
  marketOrders.set(`${order.accountId}:${order.side}`, order);
  await pgStore?.upsertMarketOrder(order);
  if (order.side === "sell") {
    const owned = (await pgStore?.listAgentOwnershipByAccount(order.accountId)) ?? [];
    const ids = new Set<string>([...owned.map((o) => o.agentId), order.accountId]);
    for (const agentId of ids) {
      const cap = agentCapabilities.get(agentId);
      const cls = cap ? (effectiveHardware(agentId, cap)?.computeClass ?? cap.computeClass) : undefined;
      if (cap && cls && (order.computeClass === "any" || order.computeClass === cls)) {
        orderBook.postAsk(agentId, cls, order.msatPerCredit > 0 ? order.msatPerCredit : undefined, Date.now(), askCapabilityOf(agentId, cap));
      }
    }
  }
}
const MARKET_DEFAULT_BID_PREMIUM_BPS = CC.MARKET_DEFAULT_BID_PREMIUM_BPS;
const NETWORK_FEE_BPS = CC.NETWORK_FEE_BPS;

function syncOrderBookReference(epoch: RateEpoch | null): void {
  if (!epoch) return;
  for (const id of COMPUTE_CLASS_IDS) {
    const r = epoch.classRates?.[id];
    if (r) orderBook.setReference(id, r.msatPerCredit);
  }
}

async function recalibrateRateEpoch(): Promise<RateEpoch> {
  const epoch = await recalibrateRates({ cfg: rateOracleConfig, previous: latestRateEpoch });
  latestRateEpoch = epoch;
  syncOrderBookReference(epoch);
  recordMarketTicks();
  await pgStore?.upsertRateEpoch(epoch);
  app.log.info(
    {
      epochId: epoch.epochId,
      status: epoch.status,
      btcUsd: epoch.btcUsd,
      satsPerCpuHour: epoch.satsPerCpuHour,
      satsPerGpuHour: epoch.satsPerGpuHour,
      msatPerCredit: epoch.msatPerCredit,
      clamped: Boolean(epoch.clamped),
      sources: epoch.btcUsdSources.map((s) => `${s.name}:${s.ok ? (s.outlier ? "outlier" : "ok") : "fail"}`)
    },
    "rate_epoch_recalibrated"
  );
  return epoch;
}

export interface CreditQuote {
  satsPerCredit: number;
  msatPerCredit: number;
  loadMultiplier: number;
  quoteSource: "rate_oracle" | "price_epoch" | "default_floor";
  rateEpochId?: string;
  rateEpochAtMs?: number;
  stale: boolean;
}

/**
 * What one credit (one CPU-second) costs right now: the oracle's market rate × the scarcity
 * multiplier. Falls back to the legacy mesh price epoch, then to the legacy 30-sat floor, when
 * the oracle has never produced an epoch (e.g. RATE_ORACLE_ENABLED=false or offline dev).
 */
function quoteSatsPerCredit(resourceClass: ResourceClass = "cpu"): CreditQuote {
  const status = queue.status();
  const cpuCapacity = Math.max(1, [...agentCapabilities.values()].reduce((sum, a) => sum + Math.max(1, a.maxConcurrentTasks), 0));
  const gpuCapacity = Math.max(1, [...agentCapabilities.values()].filter((a) => a.localModelProvider === "ollama-local").length);
  const loadMultiplier = Number(
    dynamicLoadMultiplier(resourceClass, { cpuCapacity, gpuCapacity, queuedTasks: status.queued, activeAgents: status.agents }).toFixed(4)
  );
  if (latestRateEpoch) {
    const classRate = latestRateEpoch.classRates?.[resourceClass === "gpu" ? "gpu" : "cpu"];
    const perCreditBase = classRate ? classRate.satsPerCredit : (resourceClass === "gpu" ? latestRateEpoch.satsPerGpuHour : latestRateEpoch.satsPerCpuHour) / 3600;
    const satsPerCredit = Number((perCreditBase * loadMultiplier).toFixed(6));
    return {
      satsPerCredit,
      msatPerCredit: Math.max(1, Math.round(satsPerCredit * 1000)),
      loadMultiplier,
      quoteSource: "rate_oracle",
      rateEpochId: latestRateEpoch.epochId,
      rateEpochAtMs: latestRateEpoch.createdAtMs,
      stale: isRateEpochStale(latestRateEpoch, rateOracleConfig)
    };
  }
  const legacy = latestPriceEpochByResource.get(resourceClass);
  const satsPerCredit = legacy?.pricePerComputeUnitSats ?? (resourceClass === "gpu" ? 120 : 30);
  return {
    satsPerCredit,
    msatPerCredit: Math.round(satsPerCredit * 1000),
    loadMultiplier,
    quoteSource: legacy ? "price_epoch" : "default_floor",
    stale: true
  };
}
/** Routes that need a Lightning provider: payment intents/webhook and robot task creation (invoices). */
function isPaymentGatedRequest(method: string, url: string): boolean {
  const path = url.split("?")[0];
  if (path.startsWith("/economy/payments")) return true;
  return method === "POST" && path === "/robot/tasks";
}
// ECONOMY_PAYMENTS_ENABLED=false lets a coordinator boot (including in production)
// without a Lightning node: payment routes return 503 and no provider is created.
const ECONOMY_PAYMENTS_ENABLED = economyPaymentsEnabled();
const disabledLightningProvider: LightningProvider = {
  async createInvoice() {
    throw new Error("economy_payments_disabled");
  },
  async checkSettlement() {
    return { settled: false };
  },
  async payInvoice() {
    return { status: "failed" as const, error: "economy_payments_disabled" };
  },
  async getBalances() {
    return { supported: false as const, reason: "economy_payments_disabled" };
  },
  async listPayments() {
    return { supported: false as const, reason: "economy_payments_disabled" };
  }
};
const lightningProvider: LightningProvider = ECONOMY_PAYMENTS_ENABLED
  ? createLightningProviderFromEnv()
  : disabledLightningProvider;

// ── Payouts and the network fee pool (docs/economy-math.md "Payouts") ──
// Earned sats leave the ledger only through PayoutService: a withdrawal pays a BOLT11 invoice from
// the coordinator's Lightning node, auto payouts pay Lightning addresses, and the fee pool (network
// fee on every accrual + the coordinator fee on every purchase) is distributed to infrastructure
// hosts by uptime. In-memory mode (no Postgres) keeps the same semantics without durability.
const payoutPolicy = payoutPolicyFromEnv(BITCOIN_NETWORK);
class EnginePayoutStore extends MemoryPayoutStore {
  constructor() {
    super((accountId) => creditEngine.earnedMsat(accountId));
  }
  override async creditBalance(accountId: string): Promise<number> {
    return creditEngine.balance(accountId) + (await super.creditBalance(accountId));
  }
  /** Engine-held earnings can't be totalled across accounts, so the liability check is skipped in memory mode. */
  override async liabilitiesMsat(): Promise<number | undefined> {
    return undefined;
  }
}
const memoryPayoutStore = pgStore ? null : new EnginePayoutStore();
const payoutStore: PayoutStore = pgStore ?? (memoryPayoutStore as PayoutStore);
let lastFeePoolDistribution: { atMs: number; distributedMsat: number; hosts: number } | null = null;
// Hot-wallet safeguards (docs/going-to-mainnet.md): caps, the kill switch and reconciliation.
const payoutLimits = payoutLimitsFromEnv(BITCOIN_NETWORK);
const payoutPause = new PayoutPauseControl({
  store: payoutStore,
  envPaused: payoutsPausedByEnv(),
  onChange: (state, previous) => {
    securityLog.log({
      level: securityLog.severity(state.paused ? "payouts_paused" : "payouts_resumed"),
      event: state.paused ? "payouts_paused" : "payouts_resumed",
      source: { type: state.source === "reconciliation" ? "system" : "coordinator", id: state.changedBy ?? identity.peerId },
      details: { reason: state.reason, source: state.source, wasPaused: previous.paused },
      action: state.paused ? "halt_outbound_payments" : "resume_outbound_payments",
      coordinatorId: identity.peerId
    });
    ordering.append({
      eventType: "payouts_pause_changed",
      taskId: `payouts_pause:${state.changedAtMs ?? Date.now()}`,
      actorId: state.changedBy ?? identity.peerId,
      coordinatorId: identity.peerId,
      payloadJson: JSON.stringify({ paused: state.paused, reason: state.reason, source: state.source, changedAtMs: state.changedAtMs })
    });
  }
});
// Defense in depth: even a caller that skipped PayoutService's checks cannot pay while paused.
const payoutProvider: LightningProvider = {
  createInvoice: (input) => lightningProvider.createInvoice(input),
  checkSettlement: (ref, hash) => lightningProvider.checkSettlement(ref, hash),
  async payInvoice(input) {
    if (await payoutPause.isPaused()) return { status: "failed", error: "payouts_paused" };
    return lightningProvider.payInvoice(input);
  },
  getBalances: lightningProvider.getBalances ? () => lightningProvider.getBalances!() : undefined,
  listPayments: lightningProvider.listPayments ? (input) => lightningProvider.listPayments!(input) : undefined
};
// LNURL callback pins (src/economy/lnurl-callback-pin.ts). A changed callback host holds the
// account's auto payouts and tells the portal once, which emails the owner (/internal/payouts/callback-changed).
const callbackPins: CallbackPinStore = pgStore ? pgStore.callbackPinStore() : new MemoryCallbackPinStore();
async function notifyPortalCallbackChanged(info: { accountId: string; destination: string; previousOrigin: string; newOrigin: string }): Promise<boolean> {
  if (!PORTAL_SERVICE_URL) return false;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (PORTAL_OUTBOUND_TOKEN) headers["x-portal-service-token"] = PORTAL_OUTBOUND_TOKEN;
  const res = await request(`${PORTAL_SERVICE_URL.replace(/\/+$/, "")}/internal/payouts/callback-changed`, {
    method: "POST",
    headers,
    headersTimeout: 5_000,
    bodyTimeout: 5_000,
    body: JSON.stringify(info)
  });
  await res.body.dump();
  return res.statusCode >= 200 && res.statusCode < 300;
}
const payoutService = new PayoutService({
  store: payoutStore,
  pins: callbackPins,
  onCallbackChanged: notifyPortalCallbackChanged,
  provider: payoutProvider,
  policy: payoutPolicy,
  limits: payoutLimits,
  pause: payoutPause,
  onSecurityEvent: (event, details) => {
    securityLog.log({
      level: securityLog.severity(event),
      event,
      source: { type: "system", id: String(details.accountId ?? "payouts") },
      details,
      action: "reject_payout",
      coordinatorId: identity.peerId
    });
  },
  coordinatorId: identity.peerId,
  feePoolAccountId: NETWORK_FEE_POOL_ACCOUNT,
  // LNURL hosts are user-chosen: public https only, checked again at connect, no redirects.
  fetcher: (url: string) => fetchPublicJson(url, { timeoutMs: 10_000 }),
  log: app.log,
  onPaid: async (p) => {
    ordering.append({
      eventType: "payout_settled",
      taskId: p.payoutId,
      subtaskId: p.paymentHash,
      actorId: p.accountId,
      coordinatorId: identity.peerId,
      payloadJson: JSON.stringify({ payoutId: p.payoutId, accountId: p.accountId, kind: p.kind, amountMsat: p.amountMsat, feeMsat: p.feeMsat, paymentHash: p.paymentHash, destination: p.destination, settledAtMs: p.settledAtMs })
    });
  },
  onDistributed: async (rows, hosts) => {
    lastFeePoolDistribution = { atMs: Date.now(), distributedMsat: hosts.reduce((a, h) => a + h.msat, 0), hosts: hosts.length };
    ordering.append({
      eventType: "fee_pool_distribution",
      taskId: rows[0]?.txId ?? randomUUID(),
      subtaskId: "",
      actorId: NETWORK_FEE_POOL_ACCOUNT,
      coordinatorId: identity.peerId,
      payloadJson: JSON.stringify({ hosts, totalMsat: hosts.reduce((a, h) => a + h.msat, 0) })
    });
  }
});

/**
 * Infrastructure hosts (this coordinator included) report uptime by heartbeat; weight = uptime ×
 * attested services (src/economy/host-attestation.ts). A heartbeat counts toward the window at
 * most once per ~HOST_HEARTBEAT_MS, and only attested services are stored in `services`.
 */
async function recordInfraHeartbeat(input: {
  hostId: string;
  accountId?: string;
  declaredServices: string[];
  attestation: AttestationResult;
  region?: string;
  coordinatorUrl?: string;
  lightningAddress?: string;
  lightningNodeId?: string;
}): Promise<{ host: InfrastructureHost; counted: boolean }> {
  const now = Date.now();
  const minCountIntervalMs = Math.floor(CC.HOST_HEARTBEAT_MS * 0.8);
  const host: InfrastructureHost = {
    hostId: input.hostId,
    accountId: input.accountId ?? `host:${input.hostId}`,
    coordinatorUrl: input.coordinatorUrl,
    region: input.region,
    services: input.attestation.attested,
    declaredServices: normalizeServices(input.declaredServices),
    attestedAtMs: input.attestation.atMs,
    lightningNodeId: input.lightningNodeId,
    lightningAddress: input.lightningAddress,
    firstSeenMs: now,
    lastSeenMs: now,
    lastCountedMs: now,
    heartbeatsInWindow: 1
  };
  if (pgStore) {
    const r = await pgStore.recordAttestedHostHeartbeat(host, now, minCountIntervalMs);
    return { host: { ...host, heartbeatsInWindow: r.heartbeatsInWindow }, counted: r.counted };
  }
  if (!memoryPayoutStore) return { host, counted: false };
  const existing = memoryPayoutStore.hosts.get(host.hostId);
  let counted = true;
  if (existing) {
    counted = heartbeatCounts(existing.lastCountedMs, now, CC.HOST_HEARTBEAT_MS);
    Object.assign(existing, {
      accountId: host.accountId,
      services: host.services,
      declaredServices: host.declaredServices,
      attestedAtMs: host.attestedAtMs,
      lastSeenMs: now,
      lastCountedMs: counted ? now : existing.lastCountedMs,
      heartbeatsInWindow: existing.heartbeatsInWindow + (counted ? 1 : 0),
      region: host.region ?? existing.region,
      coordinatorUrl: host.coordinatorUrl ?? existing.coordinatorUrl,
      lightningAddress: host.lightningAddress ?? existing.lightningAddress,
      lightningNodeId: host.lightningNodeId ?? existing.lightningNodeId
    });
  } else {
    memoryPayoutStore.hosts.set(host.hostId, host);
  }
  if (host.lightningAddress) memoryPayoutStore.autoAccounts.set(host.accountId, host.lightningAddress);
  return { host: memoryPayoutStore.hosts.get(host.hostId) ?? host, counted };
}
const INFRA_HOST_ENABLED = (process.env.INFRA_HOST_ENABLED ?? "1") !== "0";
const INFRA_HOST_SERVICES: string[] = (process.env.INFRA_HOST_SERVICES ?? "")
  .split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
if (INFRA_HOST_SERVICES.length === 0) {
  INFRA_HOST_SERVICES.push("coordinator");
  if (process.env.BITCOIN_ANCHOR_PROVIDER === "bitcoind") INFRA_HOST_SERVICES.push("bitcoind");
  if (["lnd", "cln"].includes((process.env.LIGHTNING_PROVIDER ?? "").toLowerCase())) INFRA_HOST_SERVICES.push("lightning");
}
/** Systems accounts a host record may never name as its payee. */
const RESERVED_HOST_ACCOUNTS = [NETWORK_FEE_POOL_ACCOUNT, COORDINATOR_FEE_ACCOUNT];
// Remote hosts: probes run against the host of the URL the mesh admitted (service-probes.ts).
// HOST_ATTEST_ALLOW_PRIVATE=1 lets local test networks probe private addresses.
const hostAttestor = new HostServiceAttestor({
  network: BITCOIN_NETWORK,
  probes: networkServiceProbes({ allowPrivate: process.env.HOST_ATTEST_ALLOW_PRIVATE === "1" })
});
/** Our own services: each counts only if the backend this process uses answers (cached 10 min). */
let selfAttestation: AttestationResult | null = null;
async function attestOwnServices(): Promise<AttestationResult> {
  if (selfAttestation && Date.now() - selfAttestation.atMs < 10 * 60_000) return selfAttestation;
  const electrs = (process.env.INFRA_HOST_ELECTRS_ENDPOINT || "electrs:50001").split(":");
  selfAttestation = await attestSelfServices(INFRA_HOST_SERVICES, {
    lightning: async () => {
      if (!ECONOMY_PAYMENTS_ENABLED || !lightningProvider.getBalances) return { ok: false, detail: "lightning_unavailable" };
      const b = await lightningProvider.getBalances();
      return b.supported ? { ok: true } : { ok: false, detail: b.reason };
    },
    bitcoind: async () => {
      const provider = process.env.BITCOIN_ANCHOR_PROVIDER === "bitcoind" ? anchorDeps()?.provider : undefined;
      if (!provider) return { ok: false, detail: "bitcoind_not_configured" };
      const h = await provider.healthCheck();
      return h.reachable ? { ok: true, detail: h.chain } : { ok: false, detail: h.error ?? "unreachable" };
    },
    electrs: () => probeElectrum(electrs[0], Number(electrs[1] ?? 50001))
  });
  const missing = normalizeServices(INFRA_HOST_SERVICES).filter((x) => !selfAttestation!.attested.includes(x));
  if (missing.length) app.log.warn({ missing, results: selfAttestation.results }, "infra_host_services_not_attested");
  return selfAttestation;
}
/** Other coordinators whose fee pool this host also reports to (signed POST /economy/hosts/heartbeat). */
const INFRA_HOST_REPORT_URLS = (process.env.INFRA_HOST_REPORT_URLS ?? "").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);
async function selfInfraHeartbeat(): Promise<void> {
  if (!INFRA_HOST_ENABLED) return;
  const fields = {
    hostId: identity.peerId,
    accountId: process.env.INFRA_HOST_ACCOUNT_ID || undefined,
    services: INFRA_HOST_SERVICES,
    region: process.env.INFRA_HOST_REGION || process.env.FLY_REGION || undefined,
    coordinatorUrl: COORDINATOR_PUBLIC_URL,
    lightningAddress: process.env.INFRA_HOST_LIGHTNING_ADDRESS || undefined,
    lightningNodeId: process.env.INFRA_HOST_LIGHTNING_NODE_ID || undefined
  };
  await recordInfraHeartbeat({ ...fields, declaredServices: fields.services, attestation: await attestOwnServices() });
  for (const url of INFRA_HOST_REPORT_URLS) {
    // Fresh signature per target: each heartbeat is single-use on the receiver.
    const body = signHostHeartbeat(fields, coordinatorKeys.privateKeyPem);
    void fetch(`${url}/economy/hosts/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    })
      .then(async (res) => {
        if (!res.ok) app.log.warn({ url, status: res.status, body: await res.text().catch(() => "") }, "infra_heartbeat_report_rejected");
      })
      .catch((error) => app.log.warn({ url, error: String(error) }, "infra_heartbeat_report_failed"));
  }
}
let feePoolDistributing: Promise<FeePoolDistribution> | null = null;
async function runFeePoolDistribution(opts: { manual?: boolean } = {}): Promise<FeePoolDistribution> {
  // Single-flight: concurrent callers (a flooded endpoint, overlapping timers) share one run so
  // the pool is not distributed twice for the same window (audit econ#3). Across instances sharing
  // one database, distributeFeePool holds a Postgres advisory lock (a second coordinator skips with
  // "locked"), and the timer skips a window another instance already distributed ("recent", at
  // 90% of FEE_POOL_DISTRIBUTION_MS). The admin route is a manual override of the latter only.
  if (feePoolDistributing) return feePoolDistributing;
  const expectedHeartbeats = Math.max(1, Math.floor(CC.FEE_POOL_DISTRIBUTION_MS / CC.HOST_HEARTBEAT_MS));
  const minIntervalMs = opts.manual ? 0 : Math.floor(CC.FEE_POOL_DISTRIBUTION_MS * 0.9);
  feePoolDistributing = payoutService.distributeFeePool(expectedHeartbeats, { minIntervalMs }).finally(() => { feePoolDistributing = null; });
  return feePoolDistributing;
}
const payoutReconcileConfig = payoutReconcileConfigFromEnv();
const payoutReconciler = new PayoutReconciler({
  provider: lightningProvider,
  ledger: payoutStore,
  config: payoutReconcileConfig,
  coordinatorId: identity.peerId,
  webhookUrl: process.env.PAYOUT_ALERT_WEBHOOK_URL?.trim() || undefined,
  log: app.log,
  pause: async (reason) => {
    await payoutPause.pause(reason, "reconciliation", identity.peerId);
  },
  onAlert: (r) => {
    const event = r.status === "error" ? "payout_reconciliation_error" : "payout_reconciliation_mismatch";
    securityLog.log({
      level: securityLog.severity(event),
      event,
      source: { type: "system", id: "payout_reconciler" },
      details: { status: r.status, failed: r.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail, msat: c.msat })), error: r.error },
      action: r.status === "tripped" ? "pause_payouts" : "alert",
      coordinatorId: identity.peerId
    });
  }
});
app.addHook("onRequest", async (req, reply) => {
  if (!ECONOMY_PAYMENTS_ENABLED && isPaymentGatedRequest(req.method, req.url)) {
    return reply.code(503).send({ error: "economy_payments_disabled" });
  }
});
let treasuryPolicy: TreasuryPolicy | null = null;
const keyCustodyEvents: KeyCustodyEvent[] = [];
let smoothedLoadIndex: number | null = null;
const diagnosticsByAgentId = new Map<string, Array<{ eventAtMs: number; message: string }>>();
function appendAgentDiagnostic(agentId: string, message: string, eventAtMs = Date.now()): void {
  const text = String(message ?? "").trim();
  if (!text) return;
  const existing = diagnosticsByAgentId.get(agentId) ?? [];
  const merged = [...existing, { eventAtMs: Number(eventAtMs || Date.now()), message: text }].slice(-250);
  diagnosticsByAgentId.set(agentId, merged);
}

// ── Subtask dependency tracking ─────────────────────────────────────────────
import { SubtaskDepTracker } from "./subtask-deps.js";
import { lateResultRejection } from "./lease-gate.js";
const depTracker = new SubtaskDepTracker();

// #5: an empty token means "open" only outside production; in production it is 503/denied.
function requireMeshToken(req: { headers: Record<string, unknown> }, reply: { code: (n: number) => any }) {
  const result = checkSharedToken(MESH_AUTH_TOKEN, req.headers["x-mesh-token"], IS_PROD);
  if (result === "ok") return true;
  reply.code(result === "not_configured" ? 503 : 401);
  return false;
}

function hasMeshToken(headers: Record<string, unknown>): boolean {
  return checkSharedToken(MESH_AUTH_TOKEN, headers["x-mesh-token"], IS_PROD) === "ok";
}

function hasPortalServiceToken(headers: Record<string, unknown>): boolean {
  return checkSharedToken(PORTAL_SERVICE_TOKEN, headers["x-portal-service-token"], IS_PROD) === "ok";
}

/*
 * Mesh token scope (docs/security-baseline.md, "Coordinator route authority"). Every enrolled agent
 * holds MESH_AUTH_TOKEN, so it is a transport gate only (the global onRequest hook). Routes that act
 * for one agent take the agent from its request signature (requireAgentSelf); operator routes need
 * authorizeAdmin; coordinator-to-coordinator routes verify an allowlisted peer signature.
 */

/**
 * Agent-self routes: the request must be signed by a registered agent key, and when the route
 * names an agent (`claimedAgentId`, from the body or path) it must be the signer. Sends 401/403
 * and returns null otherwise.
 */
async function requireAgentSelf(
  req: { headers?: unknown; url?: string; ip?: string },
  reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  claimedAgentId?: string
): Promise<string | null> {
  const routePath = String(req.url ?? "").split("?")[0];
  const verified = await verifyAgentRequest((req.headers ?? {}) as Record<string, unknown>, routePath, req.ip, {
    requireSigned: true,
    rawBody: rawBodyOf(req as any)
  });
  if (!verified || verified === "rejected") {
    reply.code(401).send({ error: "agent_signature_required" });
    return null;
  }
  if (claimedAgentId !== undefined && claimedAgentId !== verified.agentId) {
    reply.code(403).send({ error: "agent_identity_mismatch" });
    return null;
  }
  return verified.agentId;
}

/** Routes the portal proxies for logged-in users (market data and standing orders) accept either token. */
function requireMeshOrPortalToken(req: { headers: Record<string, unknown> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): boolean {
  const headers = ((req as any).headers ?? {}) as Record<string, unknown>;
  if (hasMeshToken(headers) || hasPortalServiceToken(headers)) return true;
  reply.code(401).send({ error: "mesh_unauthorized" });
  return false;
}

/**
 * The portal owns node enrollment, so a portal-validated agent's earnings and spending belong to
 * the enrolling user's account (acct-<userId>, as the portal names it). Linked on every validated
 * registration: re-enrolling a node is the owner's alone (portal upsertNodeEnrollment).
 */
async function linkPortalOwnership(agentId: string, ownerUserId: string): Promise<void> {
  if (!pgStore) return;
  const accountId = `acct-${ownerUserId}`;
  try {
    const existing = await pgStore.getAgentOwnership(agentId);
    if (existing?.accountId === accountId && existing.ownerUserId === ownerUserId) return;
    await pgStore.linkAgentOwnership({ agentId, accountId, ownerUserId });
  } catch (err) {
    app.log.warn({ err, agentId }, "agent_ownership_link_failed");
  }
}

/**
 * Account-scoped money routes (withdraw, set payout address, read a user's balance) require the
 * PORTAL service token specifically. The portal binds accountId = acct-<userId> from the session
 * before calling, so it is the only caller allowed to name an arbitrary accountId. Agents hold
 * only the shared mesh token and must NOT be able to move another account's funds (audit econ#1).
 */
function requirePortalServiceToken(req: { headers: Record<string, unknown> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): boolean {
  const headers = ((req as any).headers ?? {}) as Record<string, unknown>;
  if (hasPortalServiceToken(headers)) return true;
  reply.code(401).send({ error: "portal_service_unauthorized" });
  return false;
}

const robotQueue = ROBOT_QUEUE_ENABLED
  ? new RobotQueue({
      coordinatorFeeBps: ROBOT_COORDINATOR_FEE_BPS,
      defaultTimeoutMs: ROBOT_TASK_DEFAULT_TIMEOUT_MS,
      autoSettleDelayMs: ROBOT_AUTO_SETTLE_DELAY_MS,
      sweepIntervalMs: ROBOT_SWEEP_INTERVAL_MS,
      minSweepSats: ROBOT_MIN_SWEEP_SATS,
      bitcoinNetwork: BITCOIN_NETWORK
    })
  : null;

if (robotQueue) {
  registerRobotRoutes(app, robotQueue, {
    hasMeshToken: (headers) => hasMeshToken(headers),
    hasPortalServiceToken: (headers) => hasPortalServiceToken(headers),
    lightningProvider
  });
}

// ── Work receipts (architecture step 2): store, routes, epoch close + anchor, peer replication ──
// Receipts are issued in accrueResultCredits (recordWorkReceipt); everything else lives in src/receipts.
const receiptStore: ReceiptStore = pgStore ? pgStore.receiptStore() : new MemoryReceiptStore();
registerReceiptRoutes(app, {
  store: receiptStore,
  coordinatorId: identity.peerId,
  requireMeshToken: (req, reply) => requireMeshToken(req, reply),
  sign: (payload) => signPayload(payload, coordinatorKeys.privateKeyPem),
  coordinatorPublicKeyFor: (id) => coordinatorPublicKeyById(id),
  log: app.log
});
/**
 * `computeClass` is the class the credits were valued in (cpu | apple | gpu | gpu.dc) and
 * `msatPerCredit` the price locked on the earn row. Receipts issued before the four-class model
 * carry the resource class ("cpu" / "gpu") and the legacy price-epoch rate; they verify unchanged
 * because the field is a free string inside the signed body.
 */
async function recordWorkReceipt(r: ExecutionResult<ResultMeta>, credits: number, computeClass: ComputeClassId, msatPerCredit: number | undefined): Promise<void> {
  const resourceClass = r.meta.subtask.projectMeta.resourceClass;
  const legacyMsat = (latestPriceEpochByResource.get(resourceClass)?.pricePerComputeUnitSats ?? 30) * 1000;
  const outcome = issueReceiptForAccrual({
    claim: (r.meta.report as { receipt?: SignedAgentReceiptClaim }).receipt,
    result: { taskId: r.meta.taskId, subtaskId: r.subtaskId, agentId: r.agentId, output: r.output },
    registeredAgentPublicKeyPem: agentCapabilities.get(r.agentId)?.publicKeyPem,
    coordinator: { coordinatorId: identity.peerId, publicKeyPem: identity.publicKeyPem, privateKeyPem: coordinatorKeys.privateKeyPem },
    computeClass,
    credits,
    msatPerCredit: msatPerCredit ?? legacyMsat
  });
  if (!outcome.receipt) {
    app.log.debug({ subtaskId: r.subtaskId, agentId: r.agentId, reason: outcome.skipped }, "work_receipt_skipped");
    return;
  }
  await receiptStore.append(outcome.receipt);
  app.log.info({ receiptId: outcome.receipt.receiptId, subtaskId: r.subtaskId, agentId: r.agentId }, "work_receipt_issued");
}
app.addHook("onReady", async () => {
  const epochTimer = setInterval(() => {
    void (async () => {
      const closed = await closeEpoch(receiptStore, { coordinatorId: identity.peerId, coordinatorPrivateKeyPem: coordinatorKeys.privateKeyPem });
      if (!closed) return;
      app.log.info({ epochId: closed.epoch.epochId, count: closed.epoch.count, merkleRoot: closed.epoch.merkleRoot }, "receipt_epoch_closed");
      const deps = anchorDeps();
      if (!deps) return;
      const anchored = await anchorEpoch(closed.epoch, deps, receiptStore);
      app.log.info({ epochId: anchored.epoch.epochId, txRef: anchored.txRef }, "receipt_epoch_anchored");
    })().catch((error) => app.log.warn({ error }, "receipt_epoch_tick_failed"));
  }, CC.RECEIPT_EPOCH_MS);
  epochTimer.unref?.();
  startReceiptReplication({
    peers: () =>
      mesh
        .listPeers()
        .filter((p) => isApprovedCoordinator(p.peerId))
        .map((p) => ({ peerId: p.peerId, coordinatorUrl: p.coordinatorUrl, publicKeyPem: p.publicKeyPem })),
    store: receiptStore,
    intervalMs: CC.RECEIPT_REPLICATION_MS,
    fetch: (url, init) => fetch(url, init),
    selfId: identity.peerId,
    meshToken: MESH_AUTH_TOKEN || undefined,
    coordinatorPublicKeyFor: (id) => coordinatorPublicKeyById(id),
    log: app.log
  });
});
// ── end work receipts ──
// Architecture step 3: signed self-announcement + Nostr announcer (EDGECODER_NOSTR_ANNOUNCE=1), see docs/discovery.md.
const discoveryAnnouncer = startCoordinatorAnnouncer({ identity: coordinatorKeys, url: COORDINATOR_PUBLIC_URL, services: ["swarm", "mesh", "economy"], enabled: process.env.EDGECODER_NOSTR_ANNOUNCE === "1", log: (msg, meta) => app.log.info(meta ?? {}, msg) });
registerDiscoveryRoutes(app, discoveryAnnouncer);

function extractSignedHeaders(headers: Record<string, unknown>): SignedHeaders | null {
  const agentId = headers["x-agent-id"];
  const timestampMs = headers["x-timestamp-ms"];
  const nonce = headers["x-nonce"];
  const bodySha256 = headers["x-body-sha256"];
  const signature = headers["x-signature"];
  if (
    typeof agentId !== "string" ||
    typeof timestampMs !== "string" ||
    typeof nonce !== "string" ||
    typeof bodySha256 !== "string" ||
    typeof signature !== "string"
  ) {
    return null;
  }
  return {
    "x-agent-id": agentId,
    "x-timestamp-ms": timestampMs,
    "x-nonce": nonce,
    "x-body-sha256": bodySha256,
    "x-signature": signature,
  };
}

async function verifyAgentRequest(
  headers: Record<string, unknown>,
  routePath: string,
  sourceIp?: string,
  opts?: { allowUnsigned?: boolean; requireSigned?: boolean; rawBody?: string }
): Promise<{ agentId: string; nonce: string } | "rejected" | null> {
  const signed = extractSignedHeaders(headers);
  // #44: unsigned requests are rejected unless the policy is explicitly relaxed (non-prod),
  // or the route has its own alternative auth for unsigned callers (allowUnsigned).
  // requireSigned: the route acts on behalf of a named agent and has no other auth, so it is
  // signed-only whatever the policy (an unsigned caller could otherwise speak for any agent).
  if (!signed) return unsignedRequestDecision({ requireSignedPolicy: REQUIRE_SIGNED_AGENT_REQUESTS, ...opts });

  const agentId = signed["x-agent-id"];

  // 1. Skip rate limiting for loopback (embedded worker is trusted)
  const isLoopback = isLoopbackSocket(sourceIp, CLIENT_IP_TRUST);

  // 2. Rate limit (cheapest check first) — skip for loopback
  if (!isLoopback && !agentRateLimiter.check(agentId)) {
    securityLog.log({
      level: securityLog.severity("auth_rate_limit_hit"),
      event: "auth_rate_limit_hit",
      source: { type: "agent", id: agentId },
      details: { route: routePath },
      action: "reject_request",
      coordinatorId: identity.peerId,
    });
    behaviorTracker.recordProtocolViolation(agentId, "rate_limit_hit");
    return "rejected";
  }

  // 3. Look up agent public key — don't count as rate limit hit if key missing
  //    (agent needs to re-register, not a security threat)
  const cap = agentCapabilities.get(agentId);
  if (!cap?.publicKeyPem) {
    agentRateLimiter.reset(agentId);
    securityLog.log({
      level: securityLog.severity("invalid_signature"),
      event: "invalid_signature",
      source: { type: "agent", id: agentId },
      details: { reason: "no_public_key", route: routePath },
      action: "reject_request",
      coordinatorId: identity.peerId,
    });
    return "rejected";
  }

  // 3. Verify signature
  const sigResult = verifySignedRequest({
    method: "POST",
    path: routePath,
    headers: signed,
    publicKeyPem: cap.publicKeyPem,
    maxSkewMs: SECURITY_MAX_SKEW_MS,
    // Body binding: x-body-sha256 must be the hash of the bytes actually received. Every agent
    // build since signing shipped hashes JSON.stringify(body), the same bytes it sends.
    rawBody: opts?.rawBody ?? "",
  });

  if (!sigResult.valid) {
    // A valid signature over a different body is a captured request being replayed with a new payload.
    const replayLike = sigResult.reason === "timestamp_skew" || sigResult.reason === "body_hash_mismatch";
    const eventType: SecurityEventType = replayLike ? "replay_attempt" : "invalid_signature";
    securityLog.log({
      level: securityLog.severity(eventType),
      event: eventType,
      source: { type: "agent", id: agentId },
      details: { reason: sigResult.reason, route: routePath },
      action: "reject_request",
      coordinatorId: identity.peerId,
    });
    behaviorTracker.recordProtocolViolation(agentId, replayLike ? "replay_attempt" : "signature_failure");
    return "rejected";
  }

  // 4. Nonce replay detection
  const nonceResult = await verifyNonce(nonceStore, {
    nonce: sigResult.nonce!,
    sourceId: agentId,
    timestampMs: Number(signed["x-timestamp-ms"]),
    maxSkewMs: SECURITY_MAX_SKEW_MS,
    ttlMs: SECURITY_NONCE_TTL_MS,
  });

  if (!nonceResult.valid) {
    securityLog.log({
      level: securityLog.severity("replay_attempt"),
      event: "replay_attempt",
      source: { type: "agent", id: agentId },
      details: { nonce: sigResult.nonce, reason: nonceResult.reason, route: routePath },
      action: "reject_request",
      coordinatorId: identity.peerId,
    });
    behaviorTracker.recordProtocolViolation(agentId, "replay_attempt");
    return "rejected";
  }

  return { agentId: sigResult.agentId!, nonce: sigResult.nonce! };
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
  // Projections (earnings totals, node status) apply once per record: a row another coordinator on
  // this database already stored, or one sync re-ingests, is not counted again.
  const inserted = pgStore ? await pgStore.persistStatsLedgerRecord(record) : false;
  if (inserted) await applyStatsProjectionRecord(record);
}

app.addHook("onRequest", async (req, reply) => {
  // Allow initial agent registration without mesh token; coordinator validates
  // portal enrollment token and returns mesh auth material in the response.
  const reqPath = (req as any).url as string | undefined;
  if (reqPath === "/register") return;
  // Health check must be unauthenticated for Fly health probes
  if (reqPath === "/health/runtime") return;
  // #14: /metrics has its own METRICS_TOKEN check (src/common/metrics.ts)
  if (reqPath === "/metrics") return;
  // Public read-only endpoints (peer identity & model pull status)
  if (reqPath === "/identity" || reqPath === "/model/pull/progress") return;
  // Proof of key possession for agents verifying this coordinator (src/trust/identity-challenge.ts).
  if (reqPath === IDENTITY_CHALLENGE_PATH && (req as any).method === "POST") return;
  if (reqPath === "/discovery/announcement" || reqPath === "/discovery/peers") return;
  // Mirror of the signed coordinator registry (clients verify the signature; no auth needed).
  if (reqPath === "/network/registry") return;
  // #40: all /admin/* routes are behind authorizeAdmin (admin plugin), not the mesh token.
  // WARNING: register /admin/* routes ONLY inside the admin plugin below — a route added with
  // app.get("/admin/...") outside it would get no auth at all because of this skip.
  if (reqPath?.startsWith("/admin/")) return;
  // #40: blacklist writes are admin-only (route checks authorizeAdmin)
  if (reqPath === "/security/blacklist" && (req as any).method === "POST") return;
  // WebSocket upgrade: auth handled inside the WS handler via query params
  if (reqPath?.startsWith("/mesh/ws")) return;
  if (
    hasPortalServiceToken(((req as any).headers ?? {}) as Record<string, unknown>) &&
    (reqPath?.startsWith("/stats/projections/summary") || reqPath?.startsWith("/agent/diagnostics/") || reqPath === "/portal/chat" || reqPath?.startsWith("/account/") || reqPath === "/inference/submit" || reqPath === "/inference/stream" || reqPath === "/inference/models" || reqPath?.startsWith("/economy/market/") || reqPath === "/economy/rates/current" || reqPath?.startsWith("/economy/payouts") || reqPath?.startsWith("/economy/hosts") || reqPath?.startsWith("/economy/fee-pool"))
  ) {
    return;
  }
  if (!requireMeshToken(req as any, reply)) {
    return reply.send({ error: "mesh_unauthorized" });
  }
});

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

/** Whether `url` serves the coordinator identity `peerId` (so its announced URL is safe to use). */
async function peerAnswersAs(url: string, peerId: string): Promise<boolean> {
  try {
    const res = await request(`${url}/identity`, { method: "GET", headersTimeout: 5_000, bodyTimeout: 5_000 });
    if (res.statusCode !== 200) {
      await res.body.text().catch(() => undefined);
      return false;
    }
    return ((await res.body.json()) as { peerId?: string }).peerId === peerId;
  } catch {
    return false;
  }
}

async function bootstrapPeerMesh(): Promise<void> {
  const candidates = await discoverBootstrapPeers();
  app.log.info({ candidateCount: candidates.length, candidates }, "mesh_bootstrap_start");
  if (candidates.length === 0) return;

  const discoveredForCache = new Set<string>();
  for (const peerUrl of candidates) {
    try {
      const identityRes = await request(`${peerUrl}/identity`, {
        method: "GET",
        headers: MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : undefined,
        signal: AbortSignal.timeout(8_000)
      });
      if (identityRes.statusCode < 200 || identityRes.statusCode >= 300) {
        // Must consume the body to release the socket (undici requirement)
        await identityRes.body.text().catch(() => undefined);
        app.log.warn({ peerUrl, status: identityRes.statusCode }, "mesh_bootstrap_identity_failed");
        continue;
      }
      const remote = (await identityRes.body.json()) as {
        peerId: string;
        publicKeyPem: string;
        coordinatorUrl: string;
        networkMode: NetworkMode;
      };
      app.log.info({ peerUrl, remotePeerId: remote.peerId, localPeerId: identity.peerId }, "mesh_bootstrap_identity_fetched");
      if (!remote.peerId || remote.peerId === identity.peerId) {
        app.log.warn({ peerUrl, remotePeerId: remote.peerId }, "mesh_bootstrap_skip_same_peer");
        continue;
      }

      // Prefer the peer's self-reported coordinatorUrl, but fall back to the
      // actual URL we successfully reached it on (the bootstrap/discovery URL).
      // This handles cases where the self-reported URL (e.g. custom domain) is
      // unreachable but the direct URL (e.g. fly.dev) works.
      const normalizedRemoteUrl = normalizeUrl(remote.coordinatorUrl);
      const normalizedPeerUrl = normalizeUrl(peerUrl);
      const effectiveUrl = normalizedRemoteUrl ?? normalizedPeerUrl;
      if (!effectiveUrl || effectiveUrl === normalizeUrl(COORDINATOR_PUBLIC_URL)) {
        app.log.warn({ peerUrl, effectiveUrl, localUrl: normalizeUrl(COORDINATOR_PUBLIC_URL) }, "mesh_bootstrap_skip_same_url");
        continue;
      }
      // Gossip on the peer's own public URL (its domain) when it answers there as the same peer;
      // otherwise on the URL we reached it at (e.g. a bootstrap fly.dev host).
      let gossipUrl = normalizedPeerUrl ?? effectiveUrl;
      if (normalizedRemoteUrl && normalizedRemoteUrl !== normalizedPeerUrl && (await peerAnswersAs(normalizedRemoteUrl, remote.peerId))) gossipUrl = normalizedRemoteUrl;
      const admitted = mesh.addPeer(
        {
          peerId: remote.peerId,
          publicKeyPem: remote.publicKeyPem,
          coordinatorUrl: gossipUrl!,
          networkMode: remote.networkMode
        },
        // Dev without an allowlist keeps the old refresh-on-bootstrap behaviour.
        { authoritative: !PEER_ALLOWLIST_ENFORCED, source: "bootstrap" }
      );
      if (!admitted) {
        app.log.warn({ peerUrl, remotePeerId: remote.peerId }, "mesh_bootstrap_peer_not_allowlisted");
        continue;
      }
      peerScore.set(remote.peerId, peerScore.get(remote.peerId) ?? 100);
      discoveredForCache.add(gossipUrl!);

      const selfUrl = normalizeUrl(COORDINATOR_PUBLIC_URL) ?? COORDINATOR_PUBLIC_URL;
      const registerRes = await request(`${peerUrl}/mesh/register-peer`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : {})
        },
        body: JSON.stringify({
          peerId: identity.peerId,
          publicKeyPem: identity.publicKeyPem,
          coordinatorUrl: selfUrl,
          networkMode,
          registrationToken: COORDINATOR_REGISTRATION_TOKEN,
          // #52: prove we hold the key the peer's allowlist names.
          ...signRegistration(
            { peerId: identity.peerId, publicKeyPem: identity.publicKeyPem, coordinatorUrl: selfUrl, networkMode },
            coordinatorKeys.privateKeyPem
          )
        }),
        signal: AbortSignal.timeout(8_000)
      });
      await registerRes.body.text().catch(() => undefined);
      app.log.info({ peerUrl, registerStatus: registerRes.statusCode, remotePeerId: remote.peerId }, "mesh_bootstrap_registered");
      if (registerRes.statusCode >= 200 && registerRes.statusCode < 300) {
        discoveredForCache.add(peerUrl);
      }
    } catch (err) {
      app.log.warn({ peerUrl, error: (err as Error).message }, "mesh_bootstrap_peer_error");
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
  /** Client IP for the portal's geo/VPN checks and the audit record. Never used for trust. */
  sourceIp?: string;
  /** The TCP peer is this machine (embedded worker). Decided from the socket, never headers. */
  loopback?: boolean;
  /**
   * The request is signed by the public key this coordinator already holds for the agent, and does
   * not change that key. Only then may an agent re-register without a portal-validated token.
   */
  proofOfKey?: boolean;
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
  // A known agent may skip the portal only by proving it holds the key already registered for it.
  // Knowing an agent ID is not enough to re-register it with a new key.
  const allowIfKnownAgent = (reason: string): {
    allowed: boolean;
    reason?: string;
    ownerEmail?: string;
    sourceIp?: string;
    countryCode?: string;
    vpnDetected?: boolean;
  } | null => {
    if (input.nodeKind !== "agent" || input.proofOfKey !== true) return null;
    const existing = agentCapabilities.get(input.nodeId);
    if (!existing?.publicKeyPem) return null;
    return {
      allowed: true,
      reason,
      ownerEmail: existing.ownerEmail,
      sourceIp: existing.sourceIp,
      countryCode: existing.countryCode,
      vpnDetected: existing.vpnDetected
    };
  };
  if (!PORTAL_SERVICE_URL) {
    const outcome = { allowed: true, reason: "portal_validation_disabled" };
    await appendValidationEvent(outcome);
    return outcome;
  }
  // Allow loopback registrations: the embedded worker self-registers against its own coordinator.
  // input.loopback comes from the socket address; a forwarded-IP header cannot set it.
  if (input.loopback === true) {
    const outcome = { allowed: true, reason: "loopback_self_registration" };
    await appendValidationEvent(outcome);
    return outcome;
  }
  if (!input.registrationToken) {
    const cached = allowIfKnownAgent("registration_token_missing_proven_key");
    if (cached) {
      await appendValidationEvent(cached);
      return cached;
    }
    const outcome = { allowed: false, reason: "registration_token_required" };
    await appendValidationEvent(outcome);
    return outcome;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (PORTAL_OUTBOUND_TOKEN) headers["x-portal-service-token"] = PORTAL_OUTBOUND_TOKEN;
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
        ownerUserId?: string;
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
    if (payload.allowed === true && input.nodeKind === "agent" && payload.node?.ownerUserId) {
      await linkPortalOwnership(input.nodeId, payload.node.ownerUserId);
    }
    return {
      allowed: payload.allowed === true,
      reason: payload.reason,
      ownerEmail: payload.node?.ownerEmail,
      sourceIp: payload.node?.sourceIp,
      countryCode: payload.node?.countryCode,
      vpnDetected: payload.node?.vpnDetected
    };
  } catch {
    // If portal validation is temporarily unavailable, allow agents we already know that prove
    // their registered key. This avoids flapping registrations for long-running approved nodes.
    const cached = allowIfKnownAgent("portal_validation_unreachable_proven_key");
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

/** One checkpoint per period; the settle delay covers records still being written by any coordinator. */
const STATS_CHECKPOINT_PERIOD_MS = statsCheckpointPeriodMs(STATS_LEDGER_SYNC_INTERVAL_MS);
const STATS_CHECKPOINT_SETTLE_MS = Math.max(5_000, STATS_LEDGER_SYNC_INTERVAL_MS);

/**
 * Sign the shared checkpoint target (src/ledger/stats-checkpoint.ts) and commit once a quorum of
 * coordinators signed it. Signing never moves the target, so coordinators converge on one hash
 * instead of each signing the other's last signature.
 */
async function maybeFinalizeStatsCheckpoint(): Promise<void> {
  if (!pgStore) return;
  const store = pgStore;
  const outcome = await finalizeStatsCheckpoint({
    store,
    selfId: identity.peerId,
    threshold: statsQuorumThreshold(),
    nowMs: Date.now(),
    periodMs: STATS_CHECKPOINT_PERIOD_MS,
    settleMs: STATS_CHECKPOINT_SETTLE_MS,
    writeSignature: async (target, threshold) => {
      const signatureRecord = ordering.append({
        eventType: "stats_checkpoint_signature",
        taskId: "stats-ledger",
        actorId: identity.peerId,
        coordinatorId: identity.peerId,
        checkpointHeight: target.height,
        checkpointHash: target.hash,
        payloadJson: JSON.stringify({ threshold, signerPeerId: identity.peerId, targetIssuedAtMs: target.issuedAtMs })
      });
      await store.persistLedgerRecord(signatureRecord);
      await persistStatsLedgerRecord(signatureRecord);
    },
    writeCommit: async (target, threshold, signers) => {
      const commitRecord = ordering.append({
        eventType: "stats_checkpoint_commit",
        taskId: "stats-ledger",
        actorId: identity.peerId,
        coordinatorId: identity.peerId,
        checkpointHeight: target.height,
        checkpointHash: target.hash,
        payloadJson: JSON.stringify({ threshold, signerSet: signers, targetIssuedAtMs: target.issuedAtMs })
      });
      await store.persistLedgerRecord(commitRecord);
      await persistStatsLedgerRecord(commitRecord);
    }
  });
  if (outcome.committed) app.log.info({ checkpointHash: outcome.target?.hash, signers: outcome.signers }, "stats_checkpoint_committed");
}

/**
 * #46: anchoring needs a real provider. In production an unset BITCOIN_ANCHOR_PROVIDER
 * disables anchoring (no simulated records) instead of exiting; dev falls back to mock.
 */
let anchorProviderCache: BitcoinAnchorProvider | null | undefined;
function anchorDeps(): AnchorDeps | null {
  if (!pgStore) return null;
  if (anchorProviderCache === undefined) {
    if (IS_PROD && !process.env.BITCOIN_ANCHOR_PROVIDER) {
      app.log.warn("bitcoin_anchoring_disabled: set BITCOIN_ANCHOR_PROVIDER=bitcoind|anchor-proxy to anchor checkpoints");
      anchorProviderCache = null;
    } else {
      anchorProviderCache = createBitcoinAnchorProviderFromEnv(BITCOIN_NETWORK);
    }
  }
  return anchorProviderCache ? { provider: anchorProviderCache, store: pgStore, network: BITCOIN_NETWORK } : null;
}

/** Confirmations to report for an anchor: only real txids count (legacy simulated rows = 0). */
function anchorConfirmations(anchor: BitcoinAnchorRecord | null | undefined): number {
  return anchor && anchor.status !== "failed" && isTxid(anchor.txRef) ? anchor.confirmations ?? 0 : 0;
}

async function maybeAnchorLatestStatsCheckpoint(): Promise<BitcoinAnchorRecord | null> {
  const deps = anchorDeps();
  if (!deps || !pgStore) return null;
  // Anchor what the quorum committed (latestStatsFinality looks the anchor up by that hash).
  const checkpoint = await pgStore.latestStatsCheckpoint();
  if (!checkpoint) return null;
  return anchorCheckpoint(deps, { epochId: `stats:${checkpoint.height ?? 0}`, checkpointHash: checkpoint.hash });
}

/** #46: poll pending anchors (and re-verify the latest ones for reorgs). */
async function refreshAnchorConfirmations(): Promise<void> {
  const deps = anchorDeps();
  if (!deps || !pgStore) return;
  const recent = await pgStore.listAnchors(5);
  const events = await refreshAnchors(deps, ANCHOR_REQUIRED_CONFIRMATIONS, recent);
  for (const e of events) {
    if (e.event === "reorg") app.log.warn({ anchorId: e.anchorId }, "bitcoin_anchor_reorg_reverted_to_pending");
    else if (e.event === "confirmed") app.log.info({ anchorId: e.anchorId }, "bitcoin_anchor_confirmed");
    else if (e.event === "unknown") app.log.warn({ anchorId: e.anchorId }, "bitcoin_anchor_confirmation_unavailable");
    else if (e.event === "conflicted") app.log.warn({ anchorId: e.anchorId }, "bitcoin_anchor_conflicted_marked_failed");
  }
}

/** #103: resolve "broadcasting" rows (crash mid-broadcast) and stuck pending txs. */
async function reconcileAnchorRows(): Promise<void> {
  const deps = anchorDeps();
  if (!deps || !pgStore) return;
  const events = await reconcileAnchors(deps, ANCHOR_REQUIRED_CONFIRMATIONS, ANCHOR_RECONCILE_CONFIG);
  for (const e of events) {
    if (e.event === "needs_admin") app.log.error({ anchorId: e.anchorId }, "bitcoin_anchor_needs_admin_reconcile");
    else if (e.event === "recovered") app.log.info({ anchorId: e.anchorId }, "bitcoin_anchor_reconciled_txid_recovered");
    else if (e.event === "failed") app.log.warn({ anchorId: e.anchorId }, "bitcoin_anchor_reconciled_marked_failed");
    else if (e.event === "retry_later") app.log.warn({ anchorId: e.anchorId }, "bitcoin_anchor_reconcile_lookup_failed");
  }
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
  const latestCommit = await pgStore.latestStatsCheckpoint();
  if (!latestCommit || !latestCommit.hash) {
    return {
      softFinalized: false,
      hardFinalized: false,
      finalityState: "no_checkpoint"
    };
  }
  const anchor = await pgStore.latestAnchorByCheckpoint(latestCommit.hash);
  const confirmations = anchorConfirmations(anchor);
  const hardFinalized = Boolean(anchor) && confirmations >= STATS_ANCHOR_MIN_CONFIRMATIONS;
  return {
    checkpointHash: latestCommit.hash,
    checkpointHeight: latestCommit.height ?? undefined,
    softFinalized: true,
    hardFinalized,
    // Without an anchor provider (production default) the quorum commit is final: say so instead of
    // reporting an anchor that will never come.
    finalityState: statsFinalityState({ hasCommit: true, anchoringEnabled: anchorDeps() !== null, anchorExists: Boolean(anchor), hardFinalized }),
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
    const meshHeaders = MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : undefined;
    const headRes = await request(`${peer.coordinatorUrl}/stats/ledger/head`, {
      method: "GET",
      headers: meshHeaders,
      headersTimeout: 8_000,
      bodyTimeout: 8_000,
    });
    if (headRes.statusCode < 200 || headRes.statusCode >= 300) {
      await headRes.body.text().catch(() => "");
      return;
    }
    const remoteHead = (await headRes.body.json()) as { issuedAtMs?: number };
    if (!remoteHead.issuedAtMs) return;
    const localHead = await pgStore.latestStatsLedgerHead();
    const sinceIssuedAtMs = localHead?.issuedAtMs ?? 0;
    if (remoteHead.issuedAtMs <= sinceIssuedAtMs) return;
    const rangeRes = await request(
      `${peer.coordinatorUrl}/stats/ledger/range?sinceIssuedAtMs=${encodeURIComponent(String(sinceIssuedAtMs))}&limit=1000`,
      {
        method: "GET",
        headers: meshHeaders,
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
      }
    );
    if (rangeRes.statusCode < 200 || rangeRes.statusCode >= 300) {
      await rangeRes.body.text().catch(() => "");
      return;
    }
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

/** Call under the shared issuance lock (pgStore.withIssuanceLock) so the commit is written once. */
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
  if (!epoch.finalized) await pgStore?.markIssuanceEpochFinalized(epoch.issuanceEpochId);
  return true;
}

/**
 * One epoch per issuance window across every seed on this database: the window is aligned to
 * ISSUANCE_RECALC_MS and the epoch id derives from it, so the first seed to tick computes and writes
 * the epoch and its allocations; the others (and restarts) read it back. Only the computing seed
 * proposes and self-approves; other seeds vote through /economy/issuance/quorum/vote as before.
 */
async function runIssuanceTick(): Promise<{ epoch?: IssuanceEpochRecord; allocations: IssuanceAllocationRecord[]; created: boolean }> {
  if (!pgStore) return { allocations: [], created: false };
  const store = pgStore;
  return ensureIssuanceEpoch({
    store,
    nowMs: Date.now(),
    recalcMs: ISSUANCE_RECALC_MS,
    windowMs: ISSUANCE_WINDOW_MS,
    compute: (window) => computeIssuanceEpoch(store, window),
    afterEpoch: async ({ epoch, created }) => {
      if (created) {
        await appendQuorumRecord({
          recordType: "issuance_proposal",
          epochId: epoch.issuanceEpochId,
          payload: {
            windowStartMs: epoch.windowStartMs,
            windowEndMs: epoch.windowEndMs,
            dailyPoolTokens: epoch.dailyPoolTokens,
            loadIndex: epoch.loadIndex
          }
        });
        await appendQuorumRecord({
          recordType: "issuance_vote",
          epochId: epoch.issuanceEpochId,
          payload: { vote: "approve", voterCoordinatorId: identity.peerId }
        });
      }
      if (epoch.finalized) return epoch;
      return (await maybeFinalizeIssuanceEpoch(epoch)) ? { ...epoch, finalized: true } : epoch;
    }
  });
}

async function computeIssuanceEpoch(
  store: PostgresStore,
  { windowStartMs, windowEndMs }: IssuanceWindow
): Promise<{ epoch: IssuanceEpochDraft; allocations: IssuanceAllocationDraft[] } | null> {
  const shares = await store.rollingContributionShares(windowStartMs, windowEndMs);
  if (shares.length === 0) return null;
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
  // Smooth from the network's last epoch (whichever seed wrote it), so the one series stays continuous.
  const previous = (await store.latestIssuanceEpoch(false, ISSUANCE_RECALC_MS))?.loadIndex ?? smoothedLoadIndex;
  smoothedLoadIndex = smoothLoadIndex(previous, rawLoadIndex, issuancePoolConfig.smoothingAlpha);
  const dailyPoolTokens = computeDailyPoolTokens(smoothedLoadIndex, issuancePoolConfig);
  const totalWeightedContribution = shares.reduce((sum, item) => sum + item.weightedContribution, 0);
  return {
    epoch: {
      coordinatorId: identity.peerId,
      loadIndex: smoothedLoadIndex,
      dailyPoolTokens,
      hourlyTokens: Number((dailyPoolTokens / 24).toFixed(6)),
      totalWeightedContribution: Number(totalWeightedContribution.toFixed(6)),
      contributionCount: shares.length,
      createdAtMs: Date.now()
    },
    allocations: computeHourlyIssuanceAllocations(shares, dailyPoolTokens)
  };
}

async function maybeAnchorLatestFinalizedEpoch(): Promise<BitcoinAnchorRecord | null> {
  const deps = anchorDeps();
  if (!deps || !pgStore) return null;
  const epoch = await pgStore.latestIssuanceEpoch(true, ISSUANCE_RECALC_MS);
  if (!epoch) return null;
  const latestAnchor = await pgStore.latestAnchor();
  // #46: a real broadcast (pending or anchored) for this epoch is never re-sent.
  if (latestAnchor?.epochId === epoch.issuanceEpochId && latestAnchor.status !== "failed" && isTxid(latestAnchor.txRef)) {
    return latestAnchor;
  }
  const allocations = await pgStore.listIssuanceAllocations(epoch.issuanceEpochId);
  const checkpointHash = createHash("sha256")
    .update(JSON.stringify({ epoch, allocations }))
    .digest("hex");
  await appendQuorumRecord({
    recordType: "issuance_checkpoint",
    epochId: epoch.issuanceEpochId,
    payload: { checkpointHash, allocationCount: allocations.length }
  });
  return anchorCheckpoint(deps, { epochId: epoch.issuanceEpochId, checkpointHash });
}

async function enforceContributionFirstPolicy(accountId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!pgStore) return { ok: true };
  const stats = await pgStore.creditContributionStats(accountId);
  const balance = await pgStore.creditBalance(accountId);
  const decision = contributionPolicyDecision(stats, balance, {
    burstCredits: CONTRIBUTION_BURST_CREDITS,
    minRatio: MIN_CONTRIBUTION_RATIO
  });
  return decision.ok ? { ok: true } : decision;
}

async function allocateIntentPayouts(intent: PaymentIntent): Promise<IssuancePayoutEvent[]> {
  if (!pgStore) return [];
  const store = pgStore;
  const epoch = await store.latestIssuanceEpoch(true, ISSUANCE_RECALC_MS);
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

async function recordIntentSettlementSideEffects(settled: PaymentIntent): Promise<CoordinatorFeeEvent> {
  const feeEvent: CoordinatorFeeEvent = {
    eventId: randomUUID(),
    coordinatorId: identity.peerId,
    intentId: settled.intentId,
    feeWalletAccountId: COORDINATOR_FEE_ACCOUNT,
    feeSats: settled.coordinatorFeeSats,
    createdAtMs: Date.now()
  };
  await pgStore?.persistCoordinatorFeeEvent(feeEvent);
  // The coordinator fee on a purchase is network revenue: it goes to the fee pool as sats (no
  // compute credits attached) and reaches infrastructure hosts at the next distribution.
  if (settled.coordinatorFeeSats > 0) {
    const row: CreditTransaction = {
      txId: `purchase-fee:${settled.intentId}`,
      accountId: NETWORK_FEE_POOL_ACCOUNT,
      type: "earn",
      credits: 0,
      reason: `purchase_fee:${settled.intentId}`,
      timestampMs: Date.now(),
      msat: Math.round(settled.coordinatorFeeSats * 1000)
    };
    await payoutStore.recordCreditTransactions([row]);
  }
  await allocateIntentPayouts(settled);
  return feeEvent;
}

// #42: the only settlement path. Always asks the Lightning node; never trusts caller-supplied
// txRef/settled flags. Postgres mode uses an atomic CAS + credit insert; in-memory mode uses a
// per-intent mutex and a status check.
const settleIfPaid = createPaymentSettler({
  provider: lightningProvider,
  store: pgStore,
  getIntent: (intentId) => paymentIntents.get(intentId),
  saveIntent: (intent) => {
    paymentIntents.set(intent.intentId, intent);
  },
  grantCredits: (accountId, credits, reason) => grantCredits(accountId, credits, reason),
  onSettled: async (intent) => {
    await recordIntentSettlementSideEffects(intent);
  }
});

// Grace on top of the TTL so a payment made just before expiry is still picked up.
const PAYMENT_INTENT_EXPIRY_GRACE_MS = CC.PAYMENT_INTENT_EXPIRY_GRACE_MS;

/** #42 review: always ask the node first; expire only an unpaid intent past TTL + grace. */
function reconcileIntent(intent: PaymentIntent): Promise<"settled" | "expired" | "pending"> {
  return reconcilePaymentIntent(intent, settleIfPaid, expireIntentIfStale);
}

async function expireIntentIfStale(intent: PaymentIntent): Promise<boolean> {
  if (Date.now() - intent.createdAtMs <= PAYMENT_INTENT_TTL_MS + PAYMENT_INTENT_EXPIRY_GRACE_MS) return false;
  const expired: PaymentIntent = { ...intent, status: "expired" };
  paymentIntents.set(expired.intentId, expired);
  await pgStore?.upsertPaymentIntent(expired);
  return true;
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

const hardwareProfileSchema = z.object({
  cpuCores: z.number().int().min(1).max(4096).optional(),
  cpuModel: z.string().max(128).optional(),
  ramGb: z.number().min(0).max(65536).optional(),
  arch: z.string().max(16).optional(),
  platform: z.string().max(16).optional(),
  gpu: z
    .object({
      vendor: z.string().max(32).optional(),
      model: z.string().max(128).optional(),
      vramGb: z.number().min(0).max(8192).optional(),
      datacenter: z.boolean().optional()
    })
    .optional(),
  benchmarkScore: z.number().min(0).optional(),
  overridden: z.boolean().optional()
});

/** The agent's self-benchmark (src/swarm/benchmark.ts). Plausibility evidence only; a malformed one is dropped, never a 400. */
const benchmarkReportSchema = z
  .object({
    version: z.literal(1),
    ranAtMs: z.number().nonnegative(),
    durationMs: z.number().nonnegative().max(3_600_000),
    cpu: z
      .object({
        workUnitsPerSec: z.number().nonnegative().max(1e9),
        threads: z.number().int().min(1).max(4096),
        processed: z.number().int().nonnegative(),
        elapsedMs: z.number().nonnegative(),
        digest: z.string().max(64)
      })
      .optional(),
    gpu: z
      .object({
        model: z.string().max(128),
        tokensPerSec: z.number().nonnegative().max(1e6),
        evalTokens: z.number().int().nonnegative().max(1e7),
        weightsGb: z.number().nonnegative().max(4096).optional(),
        bandwidthGbps: z.number().nonnegative().max(1e6).optional()
      })
      .optional(),
    loaded: z.object({ model: z.string().max(128), vramGb: z.number().nonnegative().max(8192) }).optional(),
    errors: z.array(z.string().max(120)).max(8).optional()
  })
  .optional()
  .catch(undefined);
/** Challenge kinds the agent can answer; absent (older agents) = none, so they stay at base tier. */
const challengeKindsSchema = z.array(z.string().max(16)).max(8).optional().catch(undefined);

const registerSchema = z.object({
  agentId: z.string(),
  deviceId: z.string().min(3).max(128).optional(),
  os: z.string().min(2),
  version: z.string(),
  mode: z.enum(["swarm-only", "ide-enabled"]),
  registrationToken: z.string().optional(),
  localModelProvider: z.enum(["edgecoder-local", "ollama-local"]).default("edgecoder-local"),
  /** Models installed in the agent's Ollama (network inference runs only on agents that have the model). */
  installedModels: z.array(z.string().min(1).max(200)).max(200).optional(),
  activeModel: z.string().min(1).max(200).optional(),
  clientType: z.string().min(1).max(64).default("edgecoder-native"),
  maxConcurrentTasks: z.number().int().min(1).max(64).default(1),
  powerTelemetry: z
    .object({
      onExternalPower: z.boolean().optional(),
      batteryLevelPct: z.number().min(0).max(100).optional(),
      lowPowerMode: z.boolean().optional(),
      updatedAtMs: z.number().optional(),
      onACPower: z.boolean().optional(),
      batteryPct: z.number().min(0).max(100).optional(),
      thermalState: z.enum(["nominal", "fair", "serious", "critical"]).optional(),
      cpuUsagePct: z.number().min(0).max(100).optional(),
      memoryUsagePct: z.number().min(0).max(100).optional(),
      deviceType: z.enum(["desktop", "laptop", "phone", "tablet", "server"]).optional()
    })
    .optional(),
  publicKeyPem: z.string().optional(),
  x25519PublicKey: z.string().optional(),
  sandboxMode: z.enum(["none", "docker", "vm"]).default("none"),
  /** Hardware the agent runs on; classified into a compute class that prices its seconds. */
  hardwareProfile: hardwareProfileSchema.optional(),
  /** Minimum price the agent will work for (msat per credit). Omit to track the class reference. */
  askMsatPerCredit: z.number().positive().max(1e9).optional(),
  benchmark: benchmarkReportSchema,
  challengeKinds: challengeKindsSchema,
  binaryIntegrity: z
    .object({
      distHash: z.string(),
      releaseVersion: z.string(),
      releaseSignature: z.string(),
      distributionChannel: z.string(),
    })
    .optional()
});

const heartbeatSchema = z.object({
  agentId: z.string(),
  /** #51: renew claim leases only; don't drain tunnel invites/notices or offers. */
  leaseOnly: z.boolean().optional(),
  powerTelemetry: z
    .object({
      onExternalPower: z.boolean().optional(),
      batteryLevelPct: z.number().min(0).max(100).optional(),
      lowPowerMode: z.boolean().optional(),
      updatedAtMs: z.number().optional(),
      onACPower: z.boolean().optional(),
      batteryPct: z.number().min(0).max(100).optional(),
      thermalState: z.enum(["nominal", "fair", "serious", "critical"]).optional(),
      cpuUsagePct: z.number().min(0).max(100).optional(),
      memoryUsagePct: z.number().min(0).max(100).optional(),
      deviceType: z.enum(["desktop", "laptop", "phone", "tablet", "server"]).optional()
    })
    .optional(),
  activeModel: z.string().optional(),
  activeModelParamSize: z.number().optional(),
  modelSwapInProgress: z.boolean().optional(),
  sandboxMode: z.enum(["none", "docker", "vm"]).optional(),
  /** Update the agent's ask; omit to leave it, 0 to track the class reference again. */
  askMsatPerCredit: z.number().min(0).max(1e9).optional(),
  /** A new self-benchmark (periodic). */
  benchmark: benchmarkReportSchema
});
/** Answer to a benchmark challenge handed out in a heartbeat response. */
const benchmarkResponseSchema = z.object({
  agentId: z.string(),
  challengeId: z.string().min(1).max(128),
  kind: z.enum(["cpu", "gpu"]),
  solutions: z.array(z.number().int().nonnegative()).max(4096).optional(),
  output: z.string().max(16_000).optional(),
  evalCount: z.number().nonnegative().max(1e7).optional(),
  evalDurationMs: z.number().nonnegative().max(3_600_000).optional(),
  elapsedMs: z.number().nonnegative().max(3_600_000),
  declined: z.string().max(120).optional()
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

/**
 * API edge for a class parameter: the four current ids plus the nine legacy ones, which are mapped
 * (never rejected) so stale clients, scripts and bookmarked portal URLs keep working.
 */
const classParam = z
  .string()
  .refine((v) => normalizeComputeClass(v) !== undefined, { message: `computeClass must be one of ${COMPUTE_CLASS_IDS.join(", ")}` })
  .transform((v) => normalizeComputeClass(v) as ComputeClassId);
/** Capability constraint (GB): positive and bounded. */
const minGbParam = z.number().positive().max(4096).optional();

const taskSchema = z.object({
  taskId: z.string(),
  prompt: z.string().min(1),
  /** What sent it, for the usage page (a connection, "EdgeCoder chat", ...). */
  source: z.string().max(80).optional(),
  language: z.enum(["python", "javascript"]).default("python"),
  snapshotRef: z.string().min(1).refine(isValidSnapshotRef, {
    message: "snapshotRef must be a 40-char hex commit hash or an https:// tarball URL"
  }),
  submitterAccountId: z.string().default("anonymous"),
  projectId: z.string().default("default"),
  tenantId: z.string().optional(),
  resourceClass: z.enum(["cpu", "gpu"]).default("cpu"),
  priority: z.number().min(0).max(100).default(50),
  requestedModel: z.string().optional(),
  sandboxRequired: z.boolean().default(false),
  /**
   * Which class-market should run it (cpu | apple | gpu | gpu.dc), or "any". A legacy id
   * (gpu.c24, ...) is mapped onto its class with the capability it implied (see /submit).
   */
  computeClass: z.enum([...(ACCEPTED_COMPUTE_CLASS_IDS as [string, ...string[]]), "any"]).default("any"),
  /** Requester's ceiling in msat per credit. Default: class reference × (1 + MARKET_DEFAULT_BID_PREMIUM_BPS). */
  maxBidMsatPerCredit: z.number().positive().max(1e9).optional(),
  /** Only agents with at least this much discrete GPU VRAM may claim (e.g. 24 for a 30B model). Default: no constraint. */
  minVramGb: minGbParam,
  /** Only agents with at least this much system / unified memory may claim. Default: no constraint. */
  minMemoryGb: minGbParam,
  /** Only agents with a rolling reliability score (0..1) at least this high may claim; agents without enough evidence never do. */
  minReliability: z.number().positive().max(1).optional()
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
  reportSignature: z.string().optional(),
  receipt: agentReceiptClaimSchema.optional() // work receipt claim signed by the agent (src/receipts)
});

/**
 * Proof of key for /register: the request is signed (worker-runner signs /register) by the key
 * this coordinator already holds for the agent, and keeps that key. A key change never counts as
 * proof; it needs a portal-validated registration token (or the loopback exemption).
 */
async function registerProvesStoredKey(
  req: unknown,
  agentId: string,
  claimedKeyPem: string | undefined,
  storedKeyPem: string | undefined
): Promise<boolean> {
  if (!storedKeyPem) return false;
  if (claimedKeyPem !== undefined && claimedKeyPem !== storedKeyPem) return false;
  const r = req as { headers?: Record<string, unknown>; ip?: string };
  const headers = r.headers ?? {};
  if (!extractSignedHeaders(headers)) return false;
  const verified = await verifyAgentRequest(headers, "/register", r.ip, { requireSigned: true, rawBody: rawBodyOf(req as any) });
  return verified !== null && verified !== "rejected" && verified.agentId === agentId;
}

app.post("/register", async (req, reply) => {
  const parsedRegister = registerSchema.safeParse(req.body);
  if (!parsedRegister.success) {
    // A malformed registration is the agent's fault, not a server error: 400 with the
    // issues so the agent logs something actionable instead of retrying a 500 forever.
    return reply.code(400).send({ error: "invalid_registration", issues: parsedRegister.error.issues });
  }
  const body = parsedRegister.data;
  const now = Date.now();
  const hardwareClass = classifyHardware(body.hardwareProfile, rateOracleConfig.computeClasses);
  const origin = requestOrigin(req);
  const sourceIp = origin.clientIp;
  const previous = agentCapabilities.get(body.agentId);
  const proofOfKey = await registerProvesStoredKey(req, body.agentId, body.publicKeyPem, previous?.publicKeyPem);
  const activation = await validatePortalNode({
    nodeId: body.agentId,
    nodeKind: "agent",
    registrationToken: body.registrationToken,
    deviceId: body.deviceId,
    sourceIp,
    loopback: origin.loopback,
    proofOfKey
  });
  if (!activation.allowed) {
    app.log.warn({ agentId: body.agentId, reason: activation.reason }, "register_denied");
    return reply.code(403).send({ error: "node_not_activated", reason: activation.reason });
  }
  app.log.info({ agentId: body.agentId, reason: activation.reason }, "register_allowed");
  agentRateLimiter.reset(body.agentId);
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
    // What the agent reports it has installed; older agents don't say, so assume the default model.
    localModelCatalog: body.installedModels?.length ? body.installedModels : body.localModelProvider === "ollama-local" ? [OLLAMA_MODEL] : ["edgecoder-default"],
    ...(body.activeModel || body.installedModels?.length ? { activeModel: body.activeModel ?? body.installedModels![0] } : {}),
    clientType: body.clientType,
    swarmEnabled: true,
    ideEnabled: body.mode === "ide-enabled",
    maxConcurrentTasks: body.maxConcurrentTasks,
    connectedPeers: previous?.connectedPeers ?? new Set<string>(),
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
    // A body without a key keeps the registered one; a body without an envelope key keeps the
    // stored one only while the signing key is unchanged.
    publicKeyPem: body.publicKeyPem ?? previous?.publicKeyPem,
    x25519PublicKey:
      body.x25519PublicKey ??
      (previous?.publicKeyPem && (body.publicKeyPem ?? previous.publicKeyPem) === previous.publicKeyPem ? previous.x25519PublicKey : undefined),
    sandboxMode: body.sandboxMode as SandboxMode,
    hardwareProfile: body.hardwareProfile,
    computeClass: hardwareClass.computeClass,
    hardwareClass,
    lastSeenMs: now
  });
  // ── Binary integrity verification ──
  let verificationStatus: VerificationStatus = "unverified";
  if (body.binaryIntegrity) {
    const result = verifyBinaryIntegrity(
      body.binaryIntegrity as BinaryIntegrityPayload,
      releaseManifestCache.getAllManifests(),
      now
    );
    verificationStatus = result.status;
    const existing = agentCapabilities.get(body.agentId);
    if (existing) {
      (existing as any).verificationStatus = verificationStatus;
      agentCapabilities.set(body.agentId, existing);
    }
    if (result.status === "signature_mismatch" || result.status === "hash_mismatch") {
      securityLog.log({
        level: securityLog.severity("binary_integrity_failure"),
        event: "binary_integrity_failure",
        source: { type: "agent", id: body.agentId },
        details: { status: result.status, details: result.details, version: body.binaryIntegrity.releaseVersion, channel: body.binaryIntegrity.distributionChannel },
        action: "integrity_flag",
        coordinatorId: identity.peerId,
      });
      if (REQUIRE_VERIFIED_AGENTS) {
        return reply.code(403).send({ error: "binary_integrity_failed", status: result.status });
      }
    }
    app.log.info({ agentId: body.agentId, verificationStatus, version: body.binaryIntegrity.releaseVersion }, "binary_integrity_check");
  }
  // Verified-only policy: a missing attestation, an uncached manifest, or absent release keys all
  // leave verificationStatus "unverified" — reject those too, not just explicit mismatches, so the
  // policy actually guarantees a verified binary when enabled (audit mesh#2).
  if (REQUIRE_VERIFIED_AGENTS && verificationStatus !== "verified") {
    return reply.code(403).send({ error: "binary_integrity_required", status: verificationStatus });
  }

  behaviorTracker.recordRegistration(body.agentId, now);
  evaluateAndEnforce(body.agentId);
  // Hardware verification: the claim is paid at its class base tier until a challenge proves it.
  const hardwareRecord = hardwareVerifier.register({
    agentId: body.agentId,
    claimed: hardwareClass,
    profile: body.hardwareProfile,
    benchmark: body.benchmark,
    challengeKinds: body.challengeKinds,
    nowMs: now
  });
  // Market: post the agent's ask on its (verified) compute class (tracking the oracle reference unless explicit).
  {
    const ownerAccount = await rewardAccountForAgent(body.agentId);
    const standing = marketOrders.get(`${ownerAccount}:sell`);
    const cls = (effectiveHardware(body.agentId, { hardwareClass }) ?? hardwareClass).computeClass;
    const ask = body.askMsatPerCredit ?? (standing && (standing.computeClass === "any" || standing.computeClass === cls) && standing.msatPerCredit > 0 ? standing.msatPerCredit : undefined);
    orderBook.postAsk(body.agentId, cls, ask, now, askCapabilityOf(body.agentId, { hardwareClass }));
  }
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
    meshToken: MESH_AUTH_TOKEN || undefined,
    hardwareVerification: verificationSummary(hardwareRecord)
  });
});

app.post("/heartbeat", async (req, reply) => {
  const verified = await verifyAgentRequest((req as any).headers ?? {}, "/heartbeat", req.ip, { rawBody: rawBodyOf(req) });
  if (verified === "rejected") return reply.code(401).send({ error: "signature_invalid" });

  const parsedHeartbeat = heartbeatSchema.safeParse(req.body);
  if (!parsedHeartbeat.success) {
    return reply.code(400).send({ error: "invalid_heartbeat", issues: parsedHeartbeat.error.issues });
  }
  const body = parsedHeartbeat.data;
  if (verified && verified.agentId !== body.agentId) {
    return reply.code(401).send({ error: "agent_id_mismatch" });
  }
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
  // A busy agent is alive: without this a long job (a big prompt on a slow model) made it look
  // offline, which ended its reservation and hid it from the model list.
  const seen = agentCapabilities.get(body.agentId);
  if (seen) seen.lastSeenMs = now;
  if (body.leaseOnly) {
    // #51: mid-task lease renewal. Signature was checked above (unsigned is rejected
    // when REQUIRE_SIGNED_AGENT_REQUESTS is on, the production default); nothing is drained.
    return reply.send({ ok: true, leaseOnly: true });
  }
  behaviorTracker.recordHeartbeat(body.agentId);
  // A tier claim starts (or resets) hardware verification, so only a signed heartbeat may make one.
  if (body.benchmark && verified) hardwareVerifier.reportBenchmark(body.agentId, body.benchmark, now);
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
  if (body.activeModel !== undefined) {
    const existing = agentCapabilities.get(body.agentId);
    if (existing) {
      existing.activeModel = body.activeModel;
      existing.activeModelParamSize = body.activeModelParamSize ?? 0;
      existing.modelSwapInProgress = body.modelSwapInProgress ?? false;
    }
  }
  if (body.askMsatPerCredit !== undefined) {
    const existing = agentCapabilities.get(body.agentId);
    const cls = existing ? (effectiveHardware(body.agentId, existing)?.computeClass ?? existing.computeClass) : undefined;
    if (existing && cls) orderBook.postAsk(body.agentId, cls, body.askMsatPerCredit > 0 ? body.askMsatPerCredit : undefined, now, askCapabilityOf(body.agentId, existing));
  }
  if (body.sandboxMode !== undefined) {
    const existing = agentCapabilities.get(body.agentId);
    if (existing) {
      existing.sandboxMode = body.sandboxMode as SandboxMode;
    }
  }
  // #51: lease-based requeue (timeout + grace, renewed by heartbeat, retry cap).
  const leaseExpiry = queue.expireLeases();
  const requeued = leaseExpiry.requeued.length;
  if (leaseExpiry.failed.length > 0) {
    app.log.warn({ subtaskIds: leaseExpiry.failed }, "subtask_failed_max_attempts");
  }
  const tunnelInvites = pendingTunnelInvites.get(body.agentId) ?? [];
  pendingTunnelInvites.set(body.agentId, []);
  const tunnelCloseNotices = pendingTunnelCloseNotices.get(body.agentId) ?? [];
  pendingTunnelCloseNotices.set(body.agentId, []);
  const directOfferIds = directWorkInbox.get(body.agentId) ?? [];
  const directWorkOffers = directOfferIds
    .map((id) => directWorkById.get(id))
    .filter((offer): offer is DirectWorkOffer => Boolean(offer && offer.status === "offered"));
  // Hardware verification: hand out a benchmark challenge when one is due (the deadline runs from now).
  const benchmarkChallenge = hardwareVerifier.nextChallenge(body.agentId, {
    nowMs: now,
    model: benchmarkModelFor(body.agentId),
    pickWitness: (model) => pickBenchmarkWitness(body.agentId, model, now)
  });
  return reply.send({
    ok: true,
    ...(benchmarkChallenge ? { benchmarkChallenge } : {}),
    hardwareVerification: verificationSummary(hardwareVerifier.get(body.agentId)),
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

app.post("/benchmark/response", async (req, reply) => {
  // Signed-only (any trust policy): an answer settles that agent's tier, or a witness check on
  // another agent's, so an unsigned caller naming a registered agentId could demote it.
  const verified = await verifyAgentRequest((req as any).headers ?? {}, "/benchmark/response", req.ip, { requireSigned: true, rawBody: rawBodyOf(req) });
  if (verified === "rejected" || !verified) return reply.code(401).send({ error: "signature_invalid" });
  const parsed = benchmarkResponseSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_benchmark_response", issues: parsed.error.issues });
  const { agentId, ...response } = parsed.data;
  if (verified.agentId !== agentId) return reply.code(401).send({ error: "agent_id_mismatch" });
  if (!agentCapabilities.has(agentId)) return reply.code(401).send({ error: "mesh_unauthorized", reason: "agent_not_registered" });
  if (activeBlacklistRecord(agentId)) return reply.code(403).send({ error: "agent_blacklisted" });
  const result = hardwareVerifier.submit(agentId, response as ChallengeResponse, Date.now());
  if (!result.accepted) return reply.code(409).send({ ok: false, error: result.reason });
  // A witness's answer can settle the subject's cross-check: act on the record it changed.
  const subjectId = result.record?.agentId ?? agentId;
  if (result.invalid) {
    securityLog.log({
      level: securityLog.severity("hardware_challenge_invalid"),
      event: "hardware_challenge_invalid",
      source: { type: "agent", id: subjectId },
      details: { reason: result.invalid, claimedTier: result.record?.claimed.tier, reportedBy: agentId },
      action: "grant_base_tier",
      coordinatorId: identity.peerId
    });
  }
  if (result.changed) repostAsk(subjectId);
  if (result.record) {
    app.log.info({ agentId: subjectId, status: result.record.status, granted: result.record.granted.tier, measured: result.record.measured?.value, unit: result.record.measured?.unit }, "hardware_challenge_result");
  }
  return reply.send({ ok: true, verification: subjectId === agentId ? verificationSummary(result.record) : null });
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

/** Whose credits a submitted task spends: see submitterAccountDecision. */
async function resolveSubmitterAccount(
  req: { headers: Record<string, unknown>; ip: string },
  requested: string,
  routePath = "/submit"
): Promise<{ accountId: string } | { status: number; error: string }> {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  const portalService = hasPortalServiceToken(headers);
  const verified = portalService
    ? null
    : await verifyAgentRequest(headers, routePath, req.ip, { allowUnsigned: true, rawBody: rawBodyOf(req as any) });
  const signer = verified && verified !== "rejected" ? verified.agentId : null;
  return submitterAccountDecision({
    requested,
    portalService,
    signature: verified === "rejected" ? "rejected" : signer ? { agentId: signer } : null,
    ownerAccountId: signer ? (await pgStore?.getAgentOwnership(signer))?.accountId : undefined,
    loopback: req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1"
  });
}

app.post("/submit", async (req, reply) => {
  const body = taskSchema.parse(req.body);
  const submitter = await resolveSubmitterAccount(req as any, body.submitterAccountId);
  if ("error" in submitter) return reply.code(submitter.status).send({ error: submitter.error });
  body.submitterAccountId = submitter.accountId;
  if (body.submitterAccountId !== "anonymous") {
    const policy = await enforceContributionFirstPolicy(body.submitterAccountId);
    if (!policy.ok) {
      return reply.code(403).send({ error: "contribute_first_required", detail: policy.reason });
    }
    try {
      // Set aside the worst case for one subtask now (topped up once the task is split), settled
      // to the actual cost when it finishes (job-pricing.ts).
      const early = resolveRequestedClass(body.computeClass, body.maxBidMsatPerCredit, {}, rateOracleConfig.computeClasses);
      const perSubtask = subtaskReserveMsat(body.resourceClass as ResourceClass, (early.computeClass ?? "any") as ComputeClassId | "any", SUBTASK_RESERVE_TIMEOUT_MS, early.msatPerCredit);
      // One charge per task id network-wide: the same task sent again (retry, or to the other seed) is refused.
      await spendCredits(body.submitterAccountId, msatToCSats(perSubtask), "task_reserve", body.taskId, { idempotencyKey: `task_reserve:${body.taskId}` });
      taskBilling.set(body.taskId, { accountId: body.submitterAccountId, reservedMsat: perSubtask, perSubtaskReserveMsat: perSubtask, costMsat: 0, refunded: false });
      usagePending.set(body.taskId, { id: body.taskId, accountId: body.submitterAccountId, atMs: Date.now(), kind: "job", placement: "network", computeClass: early.computeClass ?? undefined, ok: false, durationMs: 0, costMsat: 0, ...(body.source ? { source: body.source } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof DuplicateDebitError) return reply.code(409).send({ error: "duplicate_task", taskId: body.taskId });
      if (message.startsWith("insufficient_credits")) {
        return reply.code(402).send({ error: "insufficient_credits" });
      }
      // DB/lock failures are not "insufficient credits" (#48 review): surface and log them.
      req.log.error({ err, taskId: body.taskId }, "task_submit_debit_failed");
      return reply.code(500).send({ error: "credit_debit_failed" });
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
    await refundTaskSubmit(body.taskId);
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
      dependsOn?: string[];
      subtaskIndex?: number;
    }>;
  };

  const enqueueRecord = ordering.append({
    eventType: "task_enqueue",
    taskId: body.taskId,
    actorId: body.submitterAccountId
  });
  await pgStore?.persistLedgerRecord(enqueueRecord);
  await persistStatsLedgerRecord(enqueueRecord);
  const billingEntry = taskBilling.get(body.taskId);
  if (billingEntry && payload.subtasks.length > 1) {
    const extra = billingEntry.perSubtaskReserveMsat * (payload.subtasks.length - 1);
    try {
      await spendCredits(billingEntry.accountId, msatToCSats(extra), "task_reserve", body.taskId, { idempotencyKey: `task_reserve_topup:${body.taskId}` });
      billingEntry.reservedMsat += extra;
    } catch (err) {
      await refundTaskSubmit(body.taskId);
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(message.startsWith("insufficient_credits") ? 402 : 500).send({ error: message.startsWith("insufficient_credits") ? "insufficient_credits" : "credit_debit_failed" });
    }
  }

  // If mesh peers exist, delay local claiming to give peers a chance to claim
  // via gossip first (prevents duplicate execution across coordinators).
  const hasMeshPeers = mesh.listPeers().length > 0;
  const GOSSIP_CLAIM_DELAY_MS = 3_000;

  // Market: register the requester's bid for this task (default = reference × premium). A legacy
  // class id maps onto its class, its explicit price into the current unit, and the capability it
  // implied (gpu.c24 => minVramGb 17) so an under-spec card cannot fill it; explicit constraints win.
  const resolved = resolveRequestedClass(body.computeClass, body.maxBidMsatPerCredit, { minVramGb: body.minVramGb, minMemoryGb: body.minMemoryGb, minReliability: body.minReliability }, rateOracleConfig.computeClasses);
  const taskClass = resolved.computeClass as ComputeClassId | "any"; // validated by taskSchema
  const explicitBid = resolved.msatPerCredit;
  const constraints = capabilityConstraints(resolved.constraints);
  const standingBuy = marketOrders.get(`${body.submitterAccountId}:buy`);
  const bidCeiling = explicitBid ?? (standingBuy && (standingBuy.computeClass === "any" || standingBuy.computeClass === taskClass) ? standingBuy.msatPerCredit : undefined);
  const marketBid = orderBook.postBid(body.taskId, taskClass, bidCeiling, MARKET_DEFAULT_BID_PREMIUM_BPS, Date.now(), constraints);

  // Assign stable IDs before scheduling so dependsOn references resolve
  const subtasksWithIds = payload.subtasks.map((s) => ({
    ...s,
    id: randomUUID(),
    requestedModel: body.requestedModel,
    projectMeta: {
      projectId: body.projectId,
      tenantId: body.tenantId,
      resourceClass: body.resourceClass as ResourceClass,
      priority: body.priority,
      computeClass: taskClass,
      maxBidMsatPerCredit: marketBid.maxMsatPerCredit,
      ...constraints
    }
  }));

  // Detect circular dependencies and warn (enqueue anyway to avoid deadlock)
  const circularIds = depTracker.detectCircularDeps(subtasksWithIds);
  if (circularIds.size > 0) {
    app.log.warn(
      { taskId: body.taskId, circularIds: [...circularIds] },
      "circular_subtask_dependencies_detected_enqueuing_anyway"
    );
  }

  const enqueueOpts = hasMeshPeers ? { claimDelayMs: GOSSIP_CLAIM_DELAY_MS } : undefined;
  const created: Subtask[] = [];
  const deferred: string[] = [];

  for (const subtask of subtasksWithIds) {
    const deps = subtask.dependsOn;
    const hasDeps = Array.isArray(deps) && deps.length > 0;
    const isCircular = circularIds.has(subtask.id);

    if (hasDeps && !isCircular) {
      // Hold until dependencies complete
      depTracker.hold({
        subtask,
        dependsOn: deps!,
        enqueueOpts
      });
      deferred.push(subtask.id);
    } else {
      // Enqueue immediately (no deps, or circular — enqueue to prevent deadlock)
      const enqueued = queue.enqueueSubtask(subtask, enqueueOpts);
      created.push(enqueued);
    }
  }

  // Gossip each immediately-enqueued subtask as a task_offer to peer coordinators
  for (const subtask of created) {
    const offerMsg = protocol.createMessage(
      "task_offer",
      identity.peerId,
      {
        subtaskId: subtask.id,
        taskId: subtask.taskId,
        kind: subtask.kind,
        language: subtask.language,
        input: subtask.input,
        timeoutMs: subtask.timeoutMs,
        snapshotRef: subtask.snapshotRef,
        projectMeta: subtask.projectMeta,
        originCoordinatorId: identity.peerId,
        originCoordinatorUrl: COORDINATOR_PUBLIC_URL,
      },
      coordinatorKeys.privateKeyPem,
      60_000
    );
    void mesh.broadcast(offerMsg);
  }

  const allIds = [...created.map((s) => s.id), ...deferred];
  const message = protocol.createMessage(
    "queue_summary",
    identity.peerId,
    { taskId: body.taskId, queued: created.length, deferred: deferred.length, projectId: body.projectId },
    coordinatorKeys.privateKeyPem
  );
  void mesh.broadcast(message);

  return reply.send({ taskId: body.taskId, subtasks: allIds });
});

app.post("/pull", async (req, reply) => {
  const verified = await verifyAgentRequest((req as any).headers ?? {}, "/pull", req.ip, { rawBody: rawBodyOf(req) });
  if (verified === "rejected") return reply.code(401).send({ error: "signature_invalid" });

  const body = pullSchema.parse(req.body);
  if (verified && verified.agentId !== body.agentId) {
    return reply.code(401).send({ error: "agent_id_mismatch" });
  }
  if (!agentCapabilities.has(body.agentId)) {
    return reply.code(401).send({ error: "mesh_unauthorized", reason: "agent_not_registered" });
  }
  const blacklisted = activeBlacklistRecord(body.agentId);
  if (blacklisted) {
    return reply.send({ subtask: null, blocked: true, reason: blacklisted.reason });
  }
  const capability = agentCapabilities.get(body.agentId);
  let powerDecisionForPull: ReturnType<typeof evaluateAgentPowerPolicy> | undefined;
  if (capability) {
    powerDecisionForPull = evaluateAgentPowerPolicy({
      os: capability.os,
      telemetry: capability.powerTelemetry,
      nowMs: Date.now(),
      lastTaskAssignedAtMs: lastTaskAssignedByAgent.get(body.agentId),
      batteryPullMinIntervalMs: IOS_BATTERY_PULL_MIN_INTERVAL_MS,
      batteryTaskStopLevelPct: IOS_BATTERY_TASK_STOP_LEVEL_PCT
    });
    if (!powerDecisionForPull.allowCoordinatorTasks) {
      return reply.send({ subtask: null, powerDeferred: true, reason: powerDecisionForPull.reason });
    }
    if (powerDecisionForPull.deferMs && powerDecisionForPull.deferMs > 0) {
      return reply.send({ subtask: null, powerDeferred: true, deferMs: powerDecisionForPull.deferMs, reason: powerDecisionForPull.reason });
    }
  }
  // #45: every swarm task requires a sandbox; check before claim so nothing is claimed/requeued.
  const sandboxRejection = pullSandboxRejection(capability);
  if (sandboxRejection) {
    app.log.warn({ agentId: body.agentId }, "sandbox_capability_mismatch");
    return reply.send(sandboxRejection);
  }
  const pullerAccount = await rewardAccountForAgent(body.agentId);
  // A reserved agent takes only its lease's jobs; a job for a lease or for its owner's own machines goes nowhere else.
  const lease = reservations.activeForAgent(body.agentId);
  const task = queue.claim(
    body.agentId,
    capability?.activeModel,
    pullerAccount,
    // The book enforces the bid's class, price and constraints. The subtask's own constraints are
    // checked too, so a task gossiped from a peer (no local bid) still cannot go to an under-spec agent.
    (subtask) => {
      // Inference runs the requested model as is: only an agent that has it may take the job.
      const hasModel = subtask.kind !== "inference" || agentHasModel(capability, subtask.requestedModel);
      const meta = subtask.projectMeta;
      if (lease) return meta.reservationId === lease.id && hasModel;
      if (meta.reservationId) return false;
      if (meta.onlyAccountId) return meta.onlyAccountId === pullerAccount && hasModel;
      return orderBook.canMatch(body.agentId, subtask.taskId).ok && meetsCapability(askCapabilityOf(body.agentId, capability), meta) && hasModel;
    }
  );
  if (task) {
    // Market: the trade prices at the agent's ask; remembered per subtask for accrual.
    const match = orderBook.canMatch(body.agentId, task.taskId);
    if (match.ok) {
      claimedTradePrice.set(task.id, { msatPerCredit: match.msatPerCredit, computeClass: match.computeClass, creditsPerSecond: effectiveHardware(body.agentId, capability)?.creditsPerSecond ?? 1 });
      const trade = { taskId: task.taskId, subtaskId: task.id, agentId: body.agentId, computeClass: match.computeClass, msatPerCredit: match.msatPerCredit, atMs: Date.now() };
      orderBook.recordTrade(trade);
      marketHistory.recordTrade(trade);
      void pgStore?.persistMarketTrade(trade).catch(() => undefined);
    }

    // ── Power policy: small-tasks-only check ──
    if (powerDecisionForPull?.allowSmallTasksOnly && task.timeoutMs > 10_000) {
      app.log.info({ subtaskId: task.id, agentId: body.agentId, reason: powerDecisionForPull.reason }, "power_small_task_filter");
      queue.requeue(task.id);
      return reply.send({ subtask: null, powerDeferred: true, reason: powerDecisionForPull.reason });
    }

    lastTaskAssignedByAgent.set(body.agentId, Date.now());
    behaviorTracker.recordTaskClaim(body.agentId);
    // #106: remember who took a verification replica, so abandoning it can't force an unverified payout.
    // #162: keyed on the reward account, so a new agent id on the same account is still the abandoner.
    if (resultVerifier.isReplica(task.id)) resultVerifier.markReplicaClaimed(task.id, body.agentId, pullerAccount);
    const claimRecord = ordering.append({
      eventType: "task_claim",
      taskId: task.taskId,
      subtaskId: task.id,
      actorId: body.agentId
    });
    await pgStore?.persistLedgerRecord(claimRecord);
    await persistStatsLedgerRecord(claimRecord);

    // Envelope encryption: if agent registered an X25519 key, encrypt the task
    const agentX25519 = capability?.x25519PublicKey;
    if (agentX25519) {
      try {
        const agentPubKey = Buffer.from(agentX25519, "base64");
        const { envelope, sharedKey } = createTaskEnvelope(
          { input: task.input, snapshotRef: task.snapshotRef, kind: task.language },
          agentPubKey,
          task.id,
          { taskId: task.taskId, resourceClass: task.projectMeta?.resourceClass, priority: task.projectMeta?.priority, language: task.language, timeoutMs: task.timeoutMs, kind: task.kind, requestedModel: task.requestedModel }
        );
        envelopeSharedKeys.set(task.id, { key: sharedKey, createdAtMs: Date.now() });
        // Expire stale shared keys
        const now = Date.now();
        for (const [sid, entry] of envelopeSharedKeys) {
          if (now - entry.createdAtMs > ENVELOPE_KEY_TTL_MS) envelopeSharedKeys.delete(sid);
        }
        app.log.info({ subtaskId: task.id, agentId: body.agentId }, "task_encrypted_with_envelope");
        return reply.send({ subtask: null, envelope });
      } catch (envelopeErr) {
        app.log.warn({ subtaskId: task.id, error: String(envelopeErr) }, "envelope_encryption_failed_falling_back");
        // Fall through to plaintext
      }
    }
  }
  return reply.send({ subtask: task ?? null });
});

/** Store a subtask's output and release (and gossip) the subtasks that depended on it. */
function releaseDependents(subtaskId: string, output: string): void {
  const released = depTracker.recordCompletionAndRelease(
    subtaskId,
    output,
    (s, opts) => queue.enqueueSubtask(s, opts)
  );
  for (const releasedSubtask of released) {
    app.log.info(
      { subtaskId: releasedSubtask.id, taskId: releasedSubtask.taskId },
      "dependent_subtask_released"
    );
    // Gossip released subtasks to peer coordinators
    const offerMsg = protocol.createMessage(
      "task_offer",
      identity.peerId,
      {
        subtaskId: releasedSubtask.id,
        taskId: releasedSubtask.taskId,
        kind: releasedSubtask.kind,
        language: releasedSubtask.language,
        input: releasedSubtask.input,
        timeoutMs: releasedSubtask.timeoutMs,
        snapshotRef: releasedSubtask.snapshotRef,
        projectMeta: releasedSubtask.projectMeta,
        originCoordinatorId: identity.peerId,
        originCoordinatorUrl: COORDINATOR_PUBLIC_URL,
      },
      coordinatorKeys.privateKeyPem,
      60_000
    );
    void mesh.broadcast(offerMsg);
  }
}

// ── #50: result verification (redundant execution) ──
interface ResultMeta {
  /** The result as reported; published (with the verified output) only once verification settles. */
  report: SubtaskResult;
  taskId: string;
  durationMs: number;
  reportedDurationMs: number;
  subtask: Subtask;
}
const verificationConfig = verificationConfigFromEnv();
const resultVerifier = new ResultVerifier<ResultMeta>(verificationConfig);
if (!hardwareVerifier.config.enabled) app.log.warn("HARDWARE_VERIFICATION=0: self-reported hardware tiers are paid unverified");
{
  const warning = verificationStartupWarning(verificationConfig);
  if (warning) app.log.warn({ rate: verificationConfig.rate, mintReplicaRewards: verificationConfig.mintReplicaRewards }, warning);
}

/*
 * #105: held verifications and per-account reputation are mirrored to Postgres. Writes run in
 * order on one chain (a held row is never re-saved after its delete); /result and the expiry
 * tick wait for it, so what they acknowledged survives a restart. Reputation is shared by both
 * seeds: deltas are applied atomically in the database and the stored value refreshes the cache.
 */
let verificationWrites: Promise<void> = Promise.resolve();
function queueVerificationWrite(write: () => Promise<unknown>): void {
  verificationWrites = verificationWrites
    .then(write)
    .then(
      () => undefined,
      (error) => app.log.warn({ error: String(error) }, "result_verification_persist_failed")
    );
}
resultVerifier.onChange((change) => {
  const store = pgStore;
  if (!store) return;
  if (change.kind === "reputation") {
    queueVerificationWrite(async () =>
      resultVerifier.primeReputation(change.key, await store.adjustVerificationReputation(change.key, change.delta, verificationConfig.initialReputation))
    );
  } else if (change.kind === "pending") {
    queueVerificationWrite(() => store.upsertPendingVerification(identity.peerId, change.originalSubtaskId, change.snapshot, change.snapshot.startedAtMs));
  } else {
    queueVerificationWrite(() => store.deletePendingVerification(identity.peerId, change.originalSubtaskId));
  }
});

/** #162: the key reputation and sampling use (the reward account), with its stored reputation loaded. */
async function verificationAccountFor(agentId: string): Promise<string> {
  const accountId = await rewardAccountForAgent(agentId);
  const stored = await pgStore?.getVerificationReputation(accountId).catch(() => undefined);
  if (stored !== undefined) resultVerifier.primeReputation(accountId, stored);
  return accountId;
}

/** #105: hold again the verifications this coordinator held before a restart, re-issuing their replicas. */
async function restorePendingVerifications(store: PostgresStore): Promise<number> {
  const snapshots = await store.listPendingVerifications<PendingVerificationSnapshot<ResultMeta>>(identity.peerId);
  let restored = 0;
  for (const snap of snapshots) {
    const next = resultVerifier.restore(snap);
    if (!next) continue;
    restored += 1;
    enqueueReplica(next);
  }
  await verificationWrites;
  if (restored > 0) app.log.info({ restored }, "result_verifications_restored");
  return restored;
}

/**
 * #50/#106/#117: one pass of the verification clock: penalize and reassign stalled replica
 * claims, then settle verifications past their deadline. Runs every minute (initCoordinator).
 */
export async function runResultVerificationTick(): Promise<void> {
  const stalled = resultVerifier.reassignStalled();
  for (const a of stalled.abandoned) {
    securityLog.log({
      level: securityLog.severity("result_verification_replica_abandoned"),
      event: "result_verification_replica_abandoned",
      source: { type: "agent", id: a.agentId },
      details: { originalSubtaskId: a.originalSubtaskId, accountId: a.accountId, reputation: resultVerifier.reputation(a.accountId) },
      action: "replica_reassigned",
      coordinatorId: identity.peerId,
    });
  }
  for (const r of stalled.replacements) {
    queue.removeHeld(r.replaces); // the abandoner's late report then fails the claim check
    enqueueReplica(r.request);
  }
  for (const outcome of resultVerifier.expire()) await settleVerification(outcome);
  await verificationWrites;
}

/** #105: a result outvoted by a verification majority is a strike towards an automatic blacklist. */
function recordVerificationMismatchStrike(loser: ExecutionResult<ResultMeta>, originalSubtaskId: string): void {
  autoBlacklister.processAnomalies(loser.agentId, [
    {
      ruleId: "VRF001",
      ruleName: "result_verification_mismatch",
      severity: "HIGH",
      blacklistReason: "forged_results",
      description: "result disagreed with a verified majority of independent executions",
      stats: { originalSubtaskId, executedSubtaskId: loser.subtaskId, accountId: executorKey(loser) }
    }
  ]);
}

function enqueueReplica(req: ReplicaRequest): void {
  queue.enqueueSubtask(req.subtask, { excludeAgents: req.excludeAgents, excludeAccounts: req.excludeAccounts });
  app.log.info(
    { replicaId: req.subtask.id, excludeAgents: req.excludeAgents, excludeAccounts: req.excludeAccounts },
    "verification_replica_enqueued"
  );
}

/** Accrue compute credits for one accepted execution (idempotent per executed subtask id, #44). */
async function accrueResultCredits(r: ExecutionResult<ResultMeta>): Promise<void> {
  const { subtask, durationMs, reportedDurationMs, taskId } = r.meta;
  const rewardAccountId = await rewardAccountForAgent(r.agentId);
  noteUsageRun(taskId, r.agentId, r.ok, durationMs, effectiveHardware(r.agentId)?.computeClass ?? agentCapabilities.get(r.agentId)?.computeClass);
  // #38: failed results earn nothing (no flat consolation credit), and the ledger payload
  // records the credits actually accrued by the pricing formula, so balances reconcile.
  if (!r.ok) return;
  // A reserved agent is paid by its lease (endReservation); your own machine isn't paid by you.
  if (subtask.projectMeta.reservationId || subtask.projectMeta.onlyAccountId) return;
  const cap = agentCapabilities.get(r.agentId);
  const eff = effectiveHardware(r.agentId, cap);
  const trade = claimedTradePrice.get(r.subtaskId);
  claimedTradePrice.delete(r.subtaskId);
  // Throughput: the agent's verified tier mints creditsPerSecond credits per measured second (weight
  // 1 on a class's base tier), so credits × the class's flat price per credit is the tier's hour price.
  // The trade carries the grant at claim time; a grant that moved since (demotion mid-task) wins, and
  // the weight never exceeds the current grant. CPU tasks are always paid as CPU work (settlementClassFor).
  let agentClass: ComputeClassId = trade?.computeClass ?? eff?.computeClass ?? "cpu";
  let agentWeight = trade?.creditsPerSecond ?? eff?.creditsPerSecond ?? 1;
  if (trade && eff) {
    if (eff.computeClass !== trade.computeClass) [agentClass, agentWeight] = [eff.computeClass, eff.creditsPerSecond];
    else agentWeight = Math.min(agentWeight, eff.creditsPerSecond);
  }
  const { computeClass, creditsPerSecond: hardwareWeight } = settlementClassFor(subtask.projectMeta.resourceClass, agentClass, agentWeight);
  const modelParamSizeB = subtask.requestedModel ? cap?.activeModelParamSize : undefined;
  const modality = modalityMultiplier(catalogEntryForTag(cap?.activeModel ?? "")?.capabilities);
  // Sats per credit: the market price agreed at claim (agent's ask), else the oracle's class rate.
  // The msat value locked on an earn row is withdrawable as real sats, so the trade price must not
  // be trustable to inflate it. Clamp it to [0.25x, 4x] the oracle class reference, which a
  // self-dealing ask/bid cannot move (audit econ#2). Falls back to the reference when no trade.
  // One reference per class (cpu | apple | gpu | gpu.dc); epochs persisted under the legacy ids
  // are normalized at load (normalizeRateEpoch), so the clamp always has a reference.
  // Per-second pricing by class (job-pricing.ts): the matched price kept within the class band
  // (a self-dealing ask/bid can't move the sats value, audit econ#2) times the tier weight.
  void modality;
  const perCredit = clampToBand(trade?.msatPerCredit, classRefMsatPerCredit(computeClass));
  const rateMsat = ratePerSecondMsat(perCredit, hardwareWeight);
  // Model calls are priced per token (tied to the market, with a power floor); code jobs per second.
  const perSecondCostMsat = jobCostMsat(durationMs, rateMsat);
  const usageForTask = usagePending.get(taskId);
  const priced =
    subtask.kind === "inference"
      ? inferenceCostMsat({
          promptTokens: usageForTask?.promptTokens,
          outputTokens: usageForTask?.outputTokens,
          paramsB: paramsB(subtask.requestedModel ?? ""),
          btcUsd: latestRateEpoch?.btcUsd ?? FALLBACK_BTC_USD,
          durationMs,
          computeClass,
          tierWeight: hardwareWeight,
          perSecondCostMsat,
        })
      : { costMsat: perSecondCostMsat, basis: "per_second" as const };
  const costMsat = priced.costMsat;
  const { agentMsat, feeMsat } = splitJobCost(costMsat, NETWORK_FEE_BPS);
  const valuation = { msatPerCredit: Math.round(perCredit), networkFeeBps: NETWORK_FEE_BPS };
  const accrued = await accruePricedJob(
    {
      reportId: resultReportId(r.subtaskId),
      agentId: rewardAccountId,
      sourceAgentId: r.agentId,
      taskId,
      resourceClass: subtask.projectMeta.resourceClass,
      cpuSeconds: subtask.projectMeta.resourceClass === "cpu" ? durationMs / 1000 : 0,
      gpuSeconds: subtask.projectMeta.resourceClass === "gpu" ? durationMs / 1000 : 0,
      success: r.ok,
      qualityScore: r.ok ? 1.0 : 0.6,
      timestampMs: Date.now(),
      modelParamSizeB,
      hardwareWeight
    },
    { agentMsat, feeMsat }
  );
  // Idempotent (#44): a re-posted result for the same subtask accrues nothing.
  if (accrued) {
    addTaskCost(taskId, costMsat);
    // Market volume stays in credits of work (base-tier seconds).
    marketHistory.settleTrade(r.subtaskId, Number(((durationMs / 1000) * hardwareWeight).toFixed(6)));
    const earningsRecord = ordering.append({
      eventType: "earnings_accrual",
      taskId,
      subtaskId: r.subtaskId,
      actorId: rewardAccountId,
      coordinatorId: identity.peerId,
      payloadJson: JSON.stringify({
        sourceAgentId: r.agentId,
        accountId: rewardAccountId,
        credits: accrued.credits,
        msat: accrued.msat,
        costMsat,
        feeMsat,
        pricingBasis: priced.basis,
        ratePerSecondMsat: rateMsat,
        msatPerCredit: valuation?.msatPerCredit,
        networkFeeBps: valuation?.networkFeeBps,
        computeClass,
        hardwareTier: eff?.tier ?? cap?.hardwareClass?.tier,
        claimedTier: cap?.hardwareClass?.tier,
        hardwareVerification: hardwareVerifier.get(r.agentId)?.status,
        creditsPerSecond: hardwareWeight,
        modelParamSizeB,
        durationMs,
        reportedDurationMs,
        ok: r.ok,
        resourceClass: subtask.projectMeta.resourceClass
      })
    });
    await pgStore?.persistLedgerRecord(earningsRecord);
    await persistStatsLedgerRecord(earningsRecord);
    // Work receipt (architecture step 2): countersign the agent's claim for what was just credited.
    await recordWorkReceipt(r, accrued.credits, computeClass, valuation?.msatPerCredit).catch((error) => app.log.warn({ error, subtaskId: r.subtaskId }, "work_receipt_failed"));
  }
}

/**
 * Make a subtask result visible: queue result, task_complete ledger record, forward to
 * the origin coordinator (gossiped subtasks) and result_announce. #50: for results held
 * for verification this runs only at settle time, with the verified output.
 */
async function publishResult(result: SubtaskResult): Promise<void> {
  queue.complete(result);
  // Market: a task's bid leaves the book once its last subtask has a result.
  if (queue.openSubtaskCount(result.taskId) === 0 && depTracker.heldCountForTask(result.taskId) === 0) orderBook.removeBid(result.taskId);
  const completeRecord = ordering.append({
    eventType: "task_complete",
    taskId: result.taskId,
    subtaskId: result.subtaskId,
    actorId: result.agentId
  });
  await pgStore?.persistLedgerRecord(completeRecord);
  await persistStatsLedgerRecord(completeRecord);

  const origin = taskOriginMap.get(result.subtaskId);
  if (origin && origin.coordinatorId !== identity.peerId) {
    taskOriginMap.delete(result.subtaskId);
    const forwardJson = JSON.stringify(result);
    void request(`${origin.coordinatorUrl}/result`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : {}),
        // #52: the origin checks this against our allowlisted key.
        ...signForwardedResult(identity.peerId, coordinatorKeys.privateKeyPem, forwardJson)
      },
      body: forwardJson
    })
      .then(() => app.log.info({ subtaskId: result.subtaskId, to: origin.coordinatorUrl }, "result_forwarded_to_origin"))
      .catch((e) => app.log.warn({ subtaskId: result.subtaskId, originUrl: origin.coordinatorUrl, err: String(e) }, "result_forward_failed"));
  }

  void mesh.broadcast(
    protocol.createMessage(
      "result_announce",
      identity.peerId,
      { taskId: result.taskId, subtaskId: result.subtaskId, ok: result.ok },
      coordinatorKeys.privateKeyPem
    )
  );
}

/**
 * #50: pay agreeing executions, penalize mismatches, then publish the original
 * subtask's result: the verified output when verified, a failure when unresolved,
 * and release dependents. Replica results are never published.
 */
async function settleVerification(outcome: VerificationOutcome<ResultMeta>): Promise<void> {
  // #114: winning replicas earn minted credits only when RESULT_VERIFICATION_MINT_REPLICA_REWARDS is on.
  const payable = payableWinners(outcome, verificationConfig);
  for (const w of payable) await accrueResultCredits(w);
  for (const w of outcome.winners) {
    if (!payable.includes(w)) {
      app.log.info({ originalSubtaskId: outcome.originalSubtaskId, executedSubtaskId: w.subtaskId }, "result_verification_replica_unpaid");
    }
  }
  for (const l of outcome.losers) {
    securityLog.log({
      level: securityLog.severity("result_verification_mismatch"),
      event: "result_verification_mismatch",
      source: { type: "agent", id: l.agentId },
      details: {
        originalSubtaskId: outcome.originalSubtaskId,
        executedSubtaskId: l.subtaskId,
        status: outcome.status,
        accountId: executorKey(l),
        reputation: resultVerifier.reputation(executorKey(l))
      },
      action: "credits_withheld",
      coordinatorId: identity.peerId,
    });
    // Only a loser outvoted by an agreeing majority: "unresolved" means no two executions agreed,
    // which honest agents on non-deterministic work hit too.
    if (outcome.status === "verified") recordVerificationMismatchStrike(l, outcome.originalSubtaskId);
  }
  const original = [...outcome.winners, ...outcome.losers].find((r) => r.subtaskId === outcome.originalSubtaskId);
  if (!original) {
    app.log.error({ subtaskId: outcome.originalSubtaskId }, "result_verification_original_missing");
    return;
  }
  if (outcome.status === "unresolved") {
    app.log.warn({ subtaskId: outcome.originalSubtaskId }, "result_verification_unresolved");
    for (const agentId of outcome.abandonedBy ?? []) {
      securityLog.log({
        level: securityLog.severity("result_verification_replica_abandoned"),
        event: "result_verification_replica_abandoned",
        source: { type: "agent", id: agentId },
        details: { originalSubtaskId: outcome.originalSubtaskId },
        action: "credits_withheld",
        coordinatorId: identity.peerId,
      });
    }
    // #107: the requester gets a failure, never an unverified output. Same terminal path
    // as the #51 retry cap: fail held dependents, ledger/forward/announce, refund once.
    await finalizeFailedSubtask(
      { ...original.meta.report, ok: false, output: "", error: "result_verification_unresolved" },
      { recordResult: true }
    );
    return;
  }
  if (outcome.status === "timeout") {
    app.log.warn({ subtaskId: outcome.originalSubtaskId }, "result_verification_timeout_accepted_unverified");
  }
  await publishResult({ ...original.meta.report, ok: outcome.ok, output: outcome.output });
  releaseDependents(outcome.originalSubtaskId, outcome.output);
}

/**
 * #51: terminal failure of a subtask the coordinator gave up on (retry cap). Does
 * what /result does for a failed result, minus any accrual (nobody earns, and
 * "coordinator" is never credited): ledger record, fail held dependents, forward
 * to the origin coordinator, announce, and refund the requester's submit charge.
 */
async function finalizeFailedSubtask(result: SubtaskResult, opts: { recordResult?: boolean } = {}): Promise<void> {
  // The retry-cap path already recorded `result` in the queue; other callers (#107) ask us to.
  if (opts.recordResult) queue.complete(result);
  const failedResults: SubtaskResult[] = [result];
  for (const dep of depTracker.dropDependents(result.subtaskId)) {
    const depResult: SubtaskResult = {
      subtaskId: dep.id,
      taskId: dep.taskId,
      agentId: "coordinator",
      ok: false,
      output: "",
      error: `dependency_failed:${result.subtaskId}`,
      durationMs: 0
    };
    queue.complete(depResult);
    failedResults.push(depResult);
  }
  for (const r of failedResults) {
    const record = ordering.append({
      eventType: "task_complete",
      taskId: r.taskId,
      subtaskId: r.subtaskId,
      actorId: "coordinator",
      payloadJson: JSON.stringify({ ok: false, error: r.error })
    });
    await pgStore?.persistLedgerRecord(record);
    await persistStatsLedgerRecord(record);

    const origin = taskOriginMap.get(r.subtaskId);
    if (origin && origin.coordinatorId !== identity.peerId) {
      taskOriginMap.delete(r.subtaskId);
      const forwardJson = JSON.stringify(r);
      void request(`${origin.coordinatorUrl}/result`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(MESH_AUTH_TOKEN ? { "x-mesh-token": MESH_AUTH_TOKEN } : {}),
          // #52: the origin checks this against our allowlisted key.
          ...signForwardedResult(identity.peerId, coordinatorKeys.privateKeyPem, forwardJson)
        },
        body: forwardJson
      }).catch((e) => app.log.warn({ subtaskId: r.subtaskId, err: String(e) }, "result_forward_failed"));
    }
    void mesh.broadcast(
      protocol.createMessage(
        "result_announce",
        identity.peerId,
        { taskId: r.taskId, subtaskId: r.subtaskId, ok: false },
        coordinatorKeys.privateKeyPem
      )
    );
  }
  const refunded = await refundTaskSubmit(result.taskId);
  app.log.warn(
    { taskId: result.taskId, subtaskIds: failedResults.map((r) => r.subtaskId), refunded },
    "task_failed_max_attempts"
  );
}

/**
 * #160: refund what /submit charged, exactly once, even if the credit store fails.
 * The tx id is derived from the task id, so a retry after a thrown grant dedupes on
 * the store's primary key instead of paying twice; `refunded` is only set after the
 * grant succeeded, and the entry is pruned once settled.
 */
/** Add a finished subtask's cost to its task's bill. */
function addTaskCost(taskId: string, costMsat: number): void {
  const billing = taskBilling.get(taskId);
  if (billing && !billing.refunded) billing.costMsat = Math.min(billing.reservedMsat, billing.costMsat + Math.max(0, costMsat));
}

/** Once a task has no open subtasks: return what was set aside but not used. */
async function settleTaskIfDone(taskId: string): Promise<void> {
  if (!taskBilling.has(taskId)) return;
  if (queue.openSubtaskCount(taskId) > 0 || depTracker.heldCountForTask(taskId) > 0) return;
  await refundTaskSubmit(taskId);
}

const REFUND_RETRY_DELAYS_MS = [250, 1_000, 4_000];
async function refundTaskSubmit(taskId: string): Promise<boolean> {
  const billing = taskBilling.get(taskId);
  if (!billing) return false;
  if (billing.refunded) return true;
  const txId = refundTxId(taskId);
  for (let attempt = 0; ; attempt++) {
    try {
      const unusedMsat = Math.max(0, billing.reservedMsat - billing.costMsat);
      if (unusedMsat > 0) await grantCreditsIdempotent(billing.accountId, msatToCSats(unusedMsat), `task_submit_refund:${taskId}`, txId);
      billing.refunded = true;
      const usage = usagePending.get(taskId);
      if (usage) {
        usagePending.delete(taskId);
        usage.costMsat = billing.costMsat;
        void saveUsage(usage);
      }
      taskBilling.delete(taskId);
      return true;
    } catch (err) {
      if (attempt >= REFUND_RETRY_DELAYS_MS.length) {
        // Left in taskBilling with refunded=false so a later failure event or an
        // operator replay (same deterministic tx id) can complete it.
        app.log.error({ err, taskId, accountId: billing.accountId, txId }, "task_submit_refund_failed");
        return false;
      }
      await new Promise((r) => setTimeout(r, REFUND_RETRY_DELAYS_MS[attempt]));
    }
  }
}

app.post("/result", async (req, reply) => {
  // allowUnsigned only so the mesh-token peer-forward path below can be evaluated; plain
  // unsigned agent results are still rejected when REQUIRE_SIGNED_AGENT_REQUESTS is on.
  const verified = await verifyAgentRequest((req as any).headers ?? {}, "/result", req.ip, { allowUnsigned: true, rawBody: rawBodyOf(req) });
  if (verified === "rejected") return reply.code(401).send({ error: "signature_invalid" });

  const rawBody = req.body as Record<string, unknown>;

  // Check if this is an encrypted envelope result
  const cachedKey = typeof rawBody.subtaskId === "string" ? envelopeSharedKeys.get(rawBody.subtaskId) : undefined;
  let body: z.infer<typeof resultSchema>;
  if (cachedKey && typeof rawBody.encryptedPayload === "string") {
    try {
      const decrypted = decryptEnvelopeResult(rawBody as unknown as EncryptedResult, cachedKey.key);
      envelopeSharedKeys.delete(rawBody.subtaskId as string);
      body = resultSchema.parse({
        ...decrypted,
        subtaskId: rawBody.subtaskId,
        taskId: rawBody.taskId,
        agentId: rawBody.agentId,
        reportNonce: rawBody.reportNonce,
        reportSignature: rawBody.reportSignature,
        receipt: rawBody.receipt,
      });
      app.log.info({ subtaskId: body.subtaskId }, "result_decrypted_from_envelope");
    } catch (decryptErr) {
      app.log.error({ subtaskId: rawBody.subtaskId, error: String(decryptErr) }, "envelope_result_decrypt_failed");
      return reply.code(400).send({ error: "envelope_decrypt_failed" });
    }
  } else {
    body = resultSchema.parse(rawBody);
  }

  if (verified && verified.agentId !== body.agentId) {
    return reply.code(401).send({ error: "agent_id_mismatch" });
  }
  const blacklisted = activeBlacklistRecord(body.agentId);
  if (blacklisted) {
    return reply.code(403).send({ error: "agent_blacklisted", reason: blacklisted.reason });
  }
  // ── #51: a result from a holder whose lease expired is late; reject before anything else ──
  const late = lateResultRejection(queue, body.subtaskId, body.agentId);
  if (late) return reply.code(late.statusCode).send(late.body);
  // ── #44: claim ownership, before anything is recorded ──
  const claim = queue.getClaim(body.subtaskId);
  // Results forwarded by a peer coordinator (gossip-offered subtask executed elsewhere) carry the
  // mesh token but no agent signature and have no local claim. They are accepted for bookkeeping
  // and dependency release only; no credits are accrued here.
  const resultAuth = classifyResultAuth({
    verified,
    // #44 review: "locally owned" only if a local agent actually claimed it; an unclaimed
    // queued copy of a gossiped subtask must still accept the relayed result.
    hasLocalClaim: Boolean(claim?.claimedBy),
    meshTokenConfigured: MESH_AUTH_TOKEN !== "",
    meshTokenValid: hasMeshToken((req as any).headers ?? {}),
    requireSigned: REQUIRE_SIGNED_AGENT_REQUESTS
  });
  if (resultAuth === "reject") return reply.code(401).send({ error: "signature_required" });
  const isPeerForward = resultAuth === "peer_forward";
  if (isPeerForward) {
    // #52: a forwarded result must be signed by an allowlisted peer coordinator.
    const fwd = verifyForwardedResult({
      headers: (req as any).headers ?? {},
      // #118 review: verify the exact bytes received, not a re-serialization.
      bodyJson: (req as unknown as { rawBody?: string }).rawBody ?? JSON.stringify(rawBody),
      allowlist: MESH_PEER_ALLOWLIST,
      production: isProduction(),
      publicKeyFor: (id) => (id === identity.peerId ? null : coordinatorPublicKeyById(id)),
      replay: forwardReplayCache
    });
    if (!fwd.ok) {
      app.log.warn({ subtaskId: body.subtaskId, error: fwd.error }, "forwarded_result_rejected");
      return reply.code(fwd.code).send({ error: fwd.error });
    }
    // #118 review: only results for subtasks we offered to peers, and only once each.
    if (PEER_ALLOWLIST_ENFORCED) {
      const exp = offeredToPeers.get(body.subtaskId);
      if (exp === undefined || exp <= Date.now()) {
        app.log.warn({ subtaskId: body.subtaskId, from: fwd.fromPeerId }, "forwarded_result_not_offered");
        return reply.code(403).send({ error: "subtask_not_offered" });
      }
      offeredToPeers.delete(body.subtaskId);
    }
  }
  if (!isPeerForward) {
    const claimCheck = checkResultClaim(claim, body.agentId);
    if (!claimCheck.ok) return reply.code(claimCheck.code).send({ error: claimCheck.error });
  }
  const subtask = isPeerForward ? undefined : claim?.subtask;
  // The claimed subtask says which task this result belongs to. Workers before 1.4.12 derived the
  // task id of an encrypted (envelope) task from the subtask id, so the requester's poll, which
  // matches on task id, never found the result.
  if (subtask && body.taskId !== subtask.taskId) body = { ...body, taskId: subtask.taskId };
  // Server-side duration: never more than measured since claim or the subtask timeout.
  const durationMs = claim ? creditedDurationMs(body.durationMs, claim) : 0;
  // Ongoing hardware evidence: real work against the verified tier (server clock, not the agent's).
  // The ask is re-posted every time so its reliability score (minReliability bids) stays current.
  if (!isPeerForward && claim?.claimedAt) {
    const nowMs = Date.now();
    // Model calls carry the model's real token count (reported with the last streamed piece).
    hardwareVerifier.recordTask(body.agentId, { ok: body.ok, outputChars: (body.output ?? "").length, elapsedMs: nowMs - claim.claimedAt, outputTokens: usagePending.get(body.taskId)?.outputTokens }, nowMs);
    repostAsk(body.agentId, nowMs);
  }

  // ── Behavioral monitoring ── (skipped for peer-forwarded results: body.agentId is unauthenticated there)
  if (!isPeerForward) {
    behaviorTracker.recordTaskResult(body.agentId, { ok: body.ok, output: body.output, durationMs: body.durationMs });
    evaluateAndEnforce(body.agentId);
  }

  // ── #50: sampled results are held for redundant verification ──
  // A held result (or a replica) doesn't release dependents or earn until the
  // verification settles (see settleVerification).
  let verificationHold = false;
  let verificationOutcome: VerificationOutcome<ResultMeta> | null = null;
  // Peer-forwarded results skip verification here: their agentId is unauthenticated and
  // they earn nothing on this coordinator; the coordinator that ran the claim verifies
  // (and holds) before paying or forwarding.
  if (!isPeerForward && subtask) {
    const execution: ExecutionResult<ResultMeta> = {
      subtaskId: body.subtaskId,
      agentId: body.agentId,
      accountId: await verificationAccountFor(body.agentId),
      ok: body.ok,
      output: body.output ?? "",
      meta: { report: body, taskId: body.taskId, durationMs, reportedDurationMs: body.durationMs, subtask }
    };
    if (resultVerifier.isReplica(body.subtaskId)) {
      verificationHold = true;
      const r = resultVerifier.recordReplica(body.subtaskId, execution);
      if (r && r.status === "pending") enqueueReplica(r.next);
      else if (r) verificationOutcome = r;
    } else if (resultVerifier.shouldVerify(executorKey(execution))) {
      verificationHold = true;
      enqueueReplica(resultVerifier.start(subtask, execution));
      app.log.info({ subtaskId: body.subtaskId, agentId: body.agentId }, "result_held_for_verification");
    }
  }

  if (verificationHold) {
    // #50: held original or replica. Nothing is visible to the requester or the origin
    // coordinator, and nothing is paid, until the verdict (settleVerification).
    queue.removeHeld(body.subtaskId);
    if (verificationOutcome) await settleVerification(verificationOutcome);
    await verificationWrites; // #105: the held state is stored before the agent is told
    return reply.send({ ok: true, held: true });
  }

  await publishResult(body);
  inferenceStreams.finish(body.subtaskId, body.ok ? undefined : body.error ?? "failed");
  // ── Dependency tracking: store output and release dependent subtasks ──
  releaseDependents(body.subtaskId, body.output ?? "");
  // Ran on another coordinator: its cost isn't measured here, so it is charged at the worst case.
  if (isPeerForward) addTaskCost(body.taskId, taskBilling.get(body.taskId)?.perSubtaskReserveMsat ?? 0);

  if (subtask) {
    await accrueResultCredits({
      subtaskId: body.subtaskId,
      agentId: body.agentId,
      ok: body.ok,
      output: body.output ?? "",
      meta: { report: body, taskId: body.taskId, durationMs, reportedDurationMs: body.durationMs, subtask }
    });
  }
  await settleTaskIfDone(body.taskId);
  return reply.send({ ok: true });
});

// ── Network inference (chat completions on agents' local models, streamed) ──────────────────
const inferenceStreams = new InferenceStreams();
setInterval(() => inferenceStreams.prune(), 60_000).unref?.();
const INFERENCE_MAX_TIMEOUT_MS = 300_000;

function agentHasModel(cap: { activeModel?: string; localModelCatalog?: string[] } | undefined, model: string | undefined): boolean {
  if (!cap || !model) return false;
  return cap.activeModel === model || (cap.localModelCatalog ?? []).includes(model);
}

const inferenceSubmitSchema = z.object({
  taskId: z.string().min(1).max(200),
  submitterAccountId: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  // Ollama chat format: tool calls on assistant turns, tool results as role "tool".
  messages: z
    .array(z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.string().max(400_000), tool_calls: z.array(z.unknown()).max(64).optional(), tool_name: z.string().max(200).optional() }))
    .min(1)
    .max(2000),
  tools: z.array(z.unknown()).max(256).optional(),
  maxTokens: z.number().int().positive().max(32_768).optional(),
  temperature: z.number().min(0).max(2).optional(),
  computeClass: z.enum([...(ACCEPTED_COMPUTE_CLASS_IDS as [string, ...string[]]), "any"]).default("any"),
  maxBidMsatPerCredit: z.number().positive().max(1e9).optional(),
  timeoutMs: z.number().int().min(10_000).max(INFERENCE_MAX_TIMEOUT_MS).default(180_000),
  /** network: any agent, billed per second; mine: only the requester's own machines, not billed. */
  target: z.enum(["network", "mine"]).default("network"),
  /** Run on the agent a reserved-capacity lease holds (the lease pays). */
  reservationId: z.string().min(1).max(100).optional(),
  /** What sent it, for the usage page (a connection, "EdgeCoder chat", ...). */
  source: z.string().max(80).optional(),
});

/**
 * Whose account an /account/* call is for: the portal (service token) names it; otherwise the
 * signing agent's owner (or the agent itself when it has no owner yet).
 */
async function callerAccount(req: any, routePath: string, requested?: string): Promise<{ accountId: string } | { status: number; error: string }> {
  const headers = (req.headers ?? {}) as Record<string, unknown>;
  // The portal path needs the header itself: with no token configured (development) every request
  // would otherwise count as the portal's.
  if (headers["x-portal-service-token"] !== undefined && hasPortalServiceToken(headers)) return requested ? { accountId: requested } : { status: 400, error: "account_required" };
  const verified = await verifyAgentRequest(headers, routePath, req.ip, { requireSigned: true, rawBody: rawBodyOf(req) });
  if (!verified || verified === "rejected") return { status: 401, error: "signature_invalid" };
  return { accountId: (await pgStore?.getAgentOwnership(verified.agentId))?.accountId ?? verified.agentId };
}

/** The signing agent's owner account: cSats balance, earnings and recent activity (for the app's Compute page). */
app.post("/account/summary", async (req, reply) => {
  const caller = await callerAccount(req, "/account/summary", (req.body as { accountId?: string } | undefined)?.accountId);
  if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
  const accountId = caller.accountId;
  const balance = pgStore ? await pgStore.creditBalance(accountId) : creditEngine.balance(accountId);
  const history = pgStore ? await pgStore.creditHistory(accountId) : creditEngine.history(accountId);
  const recent = [...history].sort((a, b) => b.timestampMs - a.timestampMs).slice(0, 25).map((t) => ({
    type: t.type, cSats: Number(t.credits), reason: t.reason, taskId: t.relatedTaskId, atMs: t.timestampMs,
  }));
  // Your machines as this coordinator sees them (the app's Mesh page and "My machines" in the compute picker).
  const owned = new Set([...((await pgStore?.listAgentOwnershipByAccount(accountId)) ?? []).map((o) => o.agentId), accountId]);
  const now = Date.now();
  const machines = [...owned]
    .map((agentId) => ({ agentId, cap: agentCapabilities.get(agentId) }))
    .filter((m) => m.cap)
    .map(({ agentId, cap }) => {
      const eff = effectiveHardware(agentId, cap);
      const lease = reservations.activeForAgent(agentId, now);
      // Hardware verification: what was claimed, what is paid (granted), and the evidence.
      const v = hardwareVerifier.get(agentId);
      return {
        agentId,
        ...(v
          ? {
              verification: {
                status: v.status, claimedTier: v.claimed.tier, grantedTier: v.granted.tier, reason: v.lastFailReason ?? null,
                lastPassAtMs: v.lastPassAtMs ?? null, score: v.evidence.score ?? null, tokensPerSec: v.evidence.tokensPerSec ?? null,
              },
            }
          : {}),
        online: now - cap!.lastSeenMs < 2 * 60_000,
        lastSeenMs: cap!.lastSeenMs,
        computeClass: eff?.computeClass ?? cap!.computeClass,
        tier: eff?.tier ?? null,
        activeModel: cap!.activeModel ?? null,
        models: [...(cap!.localModelCatalog ?? [])].filter((m) => m && m !== "edgecoder-default"),
        reservedUntilMs: lease?.endMs ?? null,
      };
    });
  let networkAgents = 0;
  for (const cap of agentCapabilities.values()) if (now - cap.lastSeenMs < 2 * 60_000) networkAgents++;
  return reply.send({ accountId, cSats: Number(balance.toFixed(3)), earnedSats: Math.floor((await earnedMsat(accountId)) / 1000), recent, machines, networkAgents, coordinator: { peerId: identity.peerId, url: COORDINATOR_PUBLIC_URL } });
});

// ── Reserved capacity (src/economy/reservations.ts) ──

const reserveSchema = z.object({
  accountId: z.string().max(200).optional(),
  computeClass: z.enum(["cpu", "apple", "gpu", "gpu.dc"]),
  minutes: z.number().int().min(RESERVATION_MIN_MINUTES).max(RESERVATION_MAX_MINUTES),
  /** Only an agent that has this model installed. */
  model: z.string().min(1).max(200).optional(),
  minVramGb: z.number().min(0).max(1024).optional(),
});

/** Agents that could be reserved now for an account: online, of the class, not held, not its own. */
async function reservableAgents(accountId: string, cls: ComputeClassId, model?: string, minVramGb?: number) {
  const now = Date.now();
  const out: Array<{ agentId: string; ownerAccountId: string; tier?: string; creditsPerSecond: number; vramGb?: number; models: string[] }> = [];
  for (const [id, cap] of agentCapabilities) {
    if (activeBlacklistRecord(id) || now - cap.lastSeenMs > 60_000 || reservations.isHeld(id, now)) continue;
    const eff = effectiveHardware(id, cap);
    if ((eff?.computeClass ?? "cpu") !== cls) continue;
    if (model && !agentHasModel(cap, model)) continue;
    if (minVramGb && (eff?.vramGb ?? 0) < minVramGb) continue;
    const owner = await rewardAccountForAgent(id);
    if (owner === accountId) continue;
    out.push({ agentId: id, ownerAccountId: owner, tier: eff?.tier, creditsPerSecond: eff?.creditsPerSecond ?? 1, vramGb: eff?.vramGb, models: [...(cap.localModelCatalog ?? [])].filter((m) => m && m !== "edgecoder-default") });
  }
  // Cheapest first (lowest tier weight), then most reliable.
  return out.sort((a, b) => a.creditsPerSecond - b.creditsPerSecond || (hardwareVerifier.reliability(b.agentId) ?? 0) - (hardwareVerifier.reliability(a.agentId) ?? 0));
}

function publicReservation(r: Reservation) {
  const cSats = (msat: number | undefined) => (msat === undefined ? undefined : msatToCSats(msat));
  return {
    id: r.id, computeClass: r.computeClass, tier: r.tier, model: r.model, agentId: r.agentId, startMs: r.startMs, endMs: r.endMs,
    status: r.status, endReason: r.endReason, cSatsPerSecond: cSats(r.ratePerSecondMsat), prepaidCSats: cSats(r.prepaidMsat),
    usedCSats: cSats(r.usedMsat), refundCSats: cSats(r.refundMsat), models: [...(agentCapabilities.get(r.agentId)?.localModelCatalog ?? [])].filter((m) => m && m !== "edgecoder-default"),
  };
}

/** End a lease: pay the agent's owner for the time held (minus the network fee) and refund the rest. */
async function endReservation(id: string, reason: ReservationEndReason, atMs = Date.now()): Promise<Reservation | undefined> {
  // Coordinators sharing the database race to end a lease; only the one that wins the stored
  // compare-and-set pays and refunds (the loser's book takes the stored copy).
  let r: Reservation | undefined;
  try {
    r = await claimReservationEnd(reservations, pgStore, id, atMs, reason);
  } catch (err) {
    app.log.warn({ err, reservationId: id }, "reservation_end_claim_failed");
    return undefined;
  }
  if (!r) return undefined;
  const used = r.usedMsat ?? 0;
  const { agentMsat, feeMsat } = splitJobCost(used, NETWORK_FEE_BPS);
  const heldSeconds = Math.max(0, ((r.endedAtMs ?? atMs) - r.startMs) / 1000);
  try {
    await accruePricedJob(
      {
        reportId: `reservation:${r.id}`, agentId: r.agentAccountId, sourceAgentId: r.agentId, taskId: `reservation:${r.id}`,
        resourceClass: r.computeClass === "cpu" ? "cpu" : "gpu", cpuSeconds: r.computeClass === "cpu" ? heldSeconds : 0, gpuSeconds: r.computeClass === "cpu" ? 0 : heldSeconds,
        success: true, qualityScore: 1, timestampMs: Date.now(), hardwareWeight: r.creditsPerSecond,
      },
      { agentMsat, feeMsat }
    );
    if ((r.refundMsat ?? 0) > 0) await grantCreditsIdempotent(r.accountId, msatToCSats(r.refundMsat!), `reservation_refund:${r.id}`, `reservation_refund:${r.id}`);
  } catch (err) {
    app.log.error({ err, reservationId: r.id }, "reservation_settle_failed");
  }
  app.log.info({ reservationId: r.id, reason, usedMsat: used, refundMsat: r.refundMsat }, "reservation_ended");
  void saveUsage({
    id: `usage-${r.id}`, accountId: r.accountId, atMs: r.startMs, kind: "reservation", placement: "reserved", computeClass: r.computeClass,
    agentId: r.agentId, ...(r.model ? { model: r.model } : {}), source: "Reservation", ok: true, durationMs: heldSeconds * 1000, costMsat: used,
  });
  return r;
}

setInterval(async () => {
  const now = Date.now();
  try {
    // Leases made or ended on another coordinator, and heartbeats it saw, come from the shared store.
    await syncReservations(reservations, pgStore);
    const due = await dueReservations(reservations, pgStore, now, (agentId) => agentCapabilities.get(agentId)?.lastSeenMs);
    for (const { r, reason } of due) await endReservation(r.id, reason, now);
  } catch (err) {
    app.log.warn({ err }, "reservation_tick_failed");
  }
  reservations.prune(now);
  // Usage records whose task never settled (lost, timed out without a result): drop after a day.
  for (const [id, u] of usagePending) if (now - u.atMs > 86_400_000) usagePending.delete(id);
}, 30_000).unref?.();

/** Your usage over the last N days: totals, per day, per model / class / source / placement, newest records. */
app.post("/account/usage", async (req, reply) => {
  const body = z.object({ accountId: z.string().max(200).optional(), days: z.number().int().min(1).max(90).default(30) }).parse(req.body ?? {});
  const caller = await callerAccount(req, "/account/usage", body.accountId);
  if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
  const now = Date.now();
  const since = now - body.days * 86_400_000;
  const records = pgStore ? await pgStore.listUsage(caller.accountId, since) : memoryUsage.forAccount(caller.accountId, since);
  return reply.send(summarizeUsage(records, since, now));
});

/** Your leases, and what you could reserve now per class (cheapest agent and how many are free). */
app.post("/account/reservations/list", async (req, reply) => {
  const caller = await callerAccount(req, "/account/reservations/list", (req.body as { accountId?: string } | undefined)?.accountId);
  if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
  await syncReservations(reservations, pgStore).catch((err) => req.log.warn({ err }, "reservation_sync_failed"));
  const options: Record<string, { available: number; cSatsPerSecond?: number; tiers: string[]; models: string[] }> = {};
  for (const cls of ["cpu", "apple", "gpu", "gpu.dc"] as ComputeClassId[]) {
    const free = await reservableAgents(caller.accountId, cls);
    options[cls] = {
      available: free.length,
      ...(free[0] ? { cSatsPerSecond: msatToCSats(ratePerSecondMsat(classRefMsatPerCredit(cls), free[0].creditsPerSecond)) } : {}),
      tiers: [...new Set(free.map((a) => a.tier).filter((t): t is string => !!t))],
      models: [...new Set(free.flatMap((a) => a.models))].sort(),
    };
  }
  return reply.send({ reservations: reservations.listForAccount(caller.accountId).map(publicReservation), options, minMinutes: RESERVATION_MIN_MINUTES, maxMinutes: RESERVATION_MAX_MINUTES });
});

/** Reserve one agent of a class for some minutes, paid now in cSats (unused time comes back). */
app.post("/account/reservations", async (req, reply) => {
  const body = reserveSchema.parse(req.body);
  const caller = await callerAccount(req, "/account/reservations", body.accountId);
  if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
  const accountId = caller.accountId;
  const [agent] = await reservableAgents(accountId, body.computeClass, body.model, body.minVramGb);
  if (!agent) return reply.code(409).send({ error: "no_agent_available", computeClass: body.computeClass });
  const rate = ratePerSecondMsat(classRefMsatPerCredit(body.computeClass), agent.creditsPerSecond);
  const prepaid = reservationPriceMsat(body.minutes, rate);
  const id = `res-${randomUUID()}`;
  try {
    await spendCredits(accountId, msatToCSats(prepaid), "compute_reservation", id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("insufficient_credits")) return reply.code(402).send({ error: "insufficient_credits", neededCSats: msatToCSats(prepaid) });
    req.log.error({ err }, "reservation_debit_failed");
    return reply.code(500).send({ error: "credit_debit_failed" });
  }
  const now = Date.now();
  const r: Reservation = {
    id, accountId, agentId: agent.agentId, agentAccountId: agent.ownerAccountId, computeClass: body.computeClass, tier: agent.tier,
    creditsPerSecond: agent.creditsPerSecond, ...(body.model ? { model: body.model } : {}), startMs: now, endMs: now + body.minutes * 60_000,
    ratePerSecondMsat: rate, prepaidMsat: prepaid, status: "active",
  };
  reservations.add(r);
  await pgStore?.upsertReservation(r).catch((err) => req.log.error({ err }, "reservation_persist_failed"));
  app.log.info({ reservationId: id, agentId: agent.agentId, computeClass: body.computeClass, minutes: body.minutes, prepaidMsat: prepaid }, "reservation_created");
  return reply.send({ reservation: publicReservation(r) });
});

/** End a lease early; the unused time is refunded. */
app.post("/account/reservations/cancel", async (req, reply) => {
  const body = z.object({ reservationId: z.string().min(1).max(100), accountId: z.string().max(200).optional() }).parse(req.body);
  const caller = await callerAccount(req, "/account/reservations/cancel", body.accountId);
  if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
  // Made on another coordinator (the portal moved seeds): read it from the shared store.
  if (!reservations.get(body.reservationId)) await syncReservations(reservations, pgStore).catch((err) => req.log.warn({ err }, "reservation_sync_failed"));
  const r = reservations.get(body.reservationId);
  if (!r || r.accountId !== caller.accountId) return reply.code(404).send({ error: "unknown_reservation" });
  const ended = r.status === "active" ? await endReservation(r.id, "cancelled") : r;
  // Lost the race to another coordinator: the book now holds the stored (already ended) copy.
  return reply.send({ reservation: publicReservation(ended ?? reservations.get(r.id) ?? r) });
});

/** Models agents on the network can run now, with how many agents and the price per class. */
app.get("/inference/models", async () => {
  const now = Date.now();
  const byModel = new Map<string, { agents: number; classes: Set<ComputeClassId> }>();
  for (const [id, cap] of agentCapabilities) {
    if (activeBlacklistRecord(id) || (cap.lastSeenMs !== undefined && now - cap.lastSeenMs > 3 * 60_000)) continue;
    const cls = (effectiveHardware(id, cap)?.computeClass ?? "cpu") as ComputeClassId;
    for (const m of new Set([...(cap.localModelCatalog ?? []), ...(cap.activeModel ? [cap.activeModel] : [])])) {
      if (!m || m === "edgecoder-default") continue;
      const e = byModel.get(m) ?? { agents: 0, classes: new Set<ComputeClassId>() };
      e.agents++;
      e.classes.add(cls);
      byModel.set(m, e);
    }
  }
  const classes = Object.fromEntries(
    (Object.keys(rateOracleConfig.computeClasses) as ComputeClassId[]).map((c) => [c, { label: rateOracleConfig.computeClasses[c].label, cSatsPerSecondBaseTier: msatToCSats(ratePerSecondMsat(classRefMsatPerCredit(c), 1)) }])
  );
  return {
    // Model calls are priced per token: cSats per million tokens in and out, by model size.
    models: [...byModel.entries()]
      .map(([model, e]) => ({ model, agents: e.agents, classes: [...e.classes], cSatsPerMTokens: cSatsPerMTokens(paramsB(model), latestRateEpoch?.btcUsd ?? FALLBACK_BTC_USD) }))
      .sort((a, b) => b.agents - a.agents || a.model.localeCompare(b.model)),
    classes,
  };
});

app.post("/inference/submit", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
  const body = inferenceSubmitSchema.parse(req.body);
  const submitter = await resolveSubmitterAccount(req as any, body.submitterAccountId, "/inference/submit");
  if ("error" in submitter) return reply.code(submitter.status).send({ error: submitter.error });
  if (submitter.accountId === "anonymous") return reply.code(403).send({ error: "account_required" });
  const accountId = submitter.accountId;
  const holders = [...agentCapabilities.entries()].filter(([id, cap]) => agentHasModel(cap, body.model) && !activeBlacklistRecord(id));
  // Unbilled targets: a lease you already paid for, or your own machines.
  let onlyAccountId: string | undefined;
  let reservationId: string | undefined;
  if (body.reservationId) {
    if (reservations.get(body.reservationId)?.status !== "active") await syncReservations(reservations, pgStore).catch((err) => req.log.warn({ err }, "reservation_sync_failed"));
    const lease = reservations.get(body.reservationId);
    if (!lease || lease.accountId !== accountId || lease.status !== "active" || Date.now() >= lease.endMs) return reply.code(404).send({ error: "reservation_not_active" });
    const cap = agentCapabilities.get(lease.agentId);
    if (!agentHasModel(cap, body.model)) return reply.code(409).send({ error: "reserved_agent_lacks_model", model: body.model, models: cap?.localModelCatalog ?? [] });
    reservationId = lease.id;
  } else if (body.target === "mine") {
    let own = 0;
    for (const [id] of holders) if ((await rewardAccountForAgent(id)) === accountId) own++;
    if (own === 0) return reply.code(409).send({ error: "no_own_agent_has_model", model: body.model });
    onlyAccountId = accountId;
  } else if (!holders.some(([id]) => !reservations.isHeld(id))) {
    return reply.code(409).send({ error: "no_agent_has_model", model: body.model });
  }
  const billed = !reservationId && !onlyAccountId;
  const resolved = resolveRequestedClass(body.computeClass, body.maxBidMsatPerCredit, {}, rateOracleConfig.computeClasses);
  const taskClass = (billed ? resolved.computeClass ?? "any" : "any") as ComputeClassId | "any";
  const resourceClass: ResourceClass = taskClass === "cpu" ? "cpu" : "gpu";
  const reserve = billed ? subtaskReserveMsat(resourceClass, taskClass, body.timeoutMs, resolved.msatPerCredit) : 0;
  if (reserve > 0) {
    try {
      await spendCredits(accountId, msatToCSats(reserve), "inference_reserve", body.taskId, { idempotencyKey: `inference_reserve:${body.taskId}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof DuplicateDebitError) return reply.code(409).send({ error: "duplicate_task", taskId: body.taskId });
      if (message.startsWith("insufficient_credits")) return reply.code(402).send({ error: "insufficient_credits", neededCSats: msatToCSats(reserve) });
      req.log.error({ err, taskId: body.taskId }, "inference_debit_failed");
      return reply.code(500).send({ error: "credit_debit_failed" });
    }
  }
  taskBilling.set(body.taskId, { accountId, reservedMsat: reserve, perSubtaskReserveMsat: reserve, costMsat: 0, refunded: false });
  usagePending.set(body.taskId, {
    id: body.taskId, accountId, atMs: Date.now(), kind: "inference", placement: reservationId ? "reserved" : onlyAccountId ? "mine" : "network",
    model: body.model, ...(taskClass !== "any" ? { computeClass: taskClass } : {}), ok: false, durationMs: 0, costMsat: 0, ...(body.source ? { source: body.source } : {}),
  });
  const marketBid = billed ? orderBook.postBid(body.taskId, taskClass, resolved.msatPerCredit, MARKET_DEFAULT_BID_PREMIUM_BPS, Date.now(), {}) : undefined;
  const subtask = queue.enqueueSubtask({
    taskId: body.taskId,
    kind: "inference",
    language: "python",
    input: JSON.stringify({ messages: body.messages, tools: body.tools, maxTokens: body.maxTokens, temperature: body.temperature }),
    timeoutMs: body.timeoutMs,
    snapshotRef: "inference",
    requestedModel: body.model,
    projectMeta: {
      projectId: `inference:${accountId}`, resourceClass, priority: 60, computeClass: taskClass,
      ...(marketBid ? { maxBidMsatPerCredit: marketBid.maxMsatPerCredit } : {}),
      ...(onlyAccountId ? { onlyAccountId } : {}),
      ...(reservationId ? { reservationId } : {}),
    },
  });
  inferenceStreams.open(subtask.id);
  app.log.info({ taskId: body.taskId, subtaskId: subtask.id, model: body.model, computeClass: taskClass, reserveMsat: reserve, holders: holders.length }, "inference_submitted");
  return reply.send({ taskId: body.taskId, subtaskId: subtask.id, reservedCSats: msatToCSats(reserve), billing: reservationId ? "reservation" : onlyAccountId ? "own_machine" : "per_second" });
});

app.post("/inference/chunks", async (req, reply) => {
  const verified = await verifyAgentRequest((req as any).headers ?? {}, "/inference/chunks", req.ip, { requireSigned: true, rawBody: rawBodyOf(req) });
  if (!verified || verified === "rejected") return reply.code(401).send({ error: "signature_invalid" });
  const body = z
    .object({
      subtaskId: z.string().min(1), seq: z.number().int().min(0), delta: z.string().max(1_000_000), done: z.boolean().default(false), error: z.string().max(2000).optional(),
      toolCalls: z.array(z.unknown()).max(64).optional(),
      // Token counts from the model, with the last piece (for the usage page; not billed on).
      promptTokens: z.number().int().min(0).max(10_000_000).optional(),
      outputTokens: z.number().int().min(0).max(10_000_000).optional(),
    })
    .parse(req.body);
  if (queue.getClaim(body.subtaskId)?.claimedBy !== verified.agentId) return reply.code(403).send({ error: "not_claimant" });
  const r = inferenceStreams.append(body.subtaskId, body.seq, body.delta, body.done, body.error, body.toolCalls);
  if (body.done && (body.promptTokens !== undefined || body.outputTokens !== undefined)) {
    const claimTask = queue.getClaim(body.subtaskId)?.subtask.taskId;
    const u = claimTask ? usagePending.get(claimTask) : undefined;
    if (u) {
      u.promptTokens = (u.promptTokens ?? 0) + (body.promptTokens ?? 0);
      u.outputTokens = (u.outputTokens ?? 0) + (body.outputTokens ?? 0);
    }
  }
  return reply.code(r === "ok" || r === "duplicate" ? 200 : 409).send({ status: r });
});

/** The requester reads the reply as it streams (long poll; signed by the requester's own agent). */
app.post("/inference/stream", async (req, reply) => {
  const body = z.object({ taskId: z.string().min(1), subtaskId: z.string().min(1), after: z.number().int().min(0).default(0), waitMs: z.number().int().min(0).max(25_000).default(15_000) }).parse(req.body);
  const billing = taskBilling.get(body.taskId);
  const reader = await resolveSubmitterAccount(req as any, billing?.accountId ?? "", "/inference/stream");
  if ("error" in reader || !billing || reader.accountId !== billing.accountId) return reply.code(403).send({ error: "not_requester" });
  const r = await inferenceStreams.read(body.subtaskId, body.after, body.waitMs);
  if (!r) return reply.code(404).send({ error: "unknown_stream" });
  // The agent's last piece arrives just before its result, which settles the cost: wait for it briefly.
  let result = r.done ? queue.getResult(body.subtaskId) : undefined;
  for (let i = 0; r.done && !result && i < 40; i++) {
    await new Promise((res) => setTimeout(res, 100));
    result = queue.getResult(body.subtaskId);
  }
  if (result) await settleTaskIfDone(body.taskId);
  return reply.send({ ...r, ...(result ? { creditsSpent: msatToCSats(billing.refunded ? billing.costMsat : billing.reservedMsat), durationMs: result.durationMs } : {}) });
});

app.get("/status", async () => queue.status());

/**
 * Requester-side result lookup for a submitted subtask (used by the IDE /run/swarm
 * route, which polls after POST /submit). Mesh-token protected by the global hook.
 * 404 while the subtask is still queued/running or when the ids don't match.
 */
app.get("/tasks/:taskId/subtasks/:subtaskId/result", async (req, reply) => {
  const { taskId, subtaskId } = req.params as { taskId: string; subtaskId: string };
  const result = queue.getResult(subtaskId);
  if (!result || result.taskId !== taskId) {
    return reply.code(404).send({ error: "result_not_ready", taskId, subtaskId });
  }
  const billing = taskBilling.get(taskId);
  return reply.send({
    taskId: result.taskId,
    subtaskId: result.subtaskId,
    ok: result.ok,
    output: result.output,
    error: result.error,
    durationMs: result.durationMs,
    // What /submit charged the submitter (0 once refunded or for anonymous tasks).
    // cSats: the settled cost once the task finished, else what is set aside for it.
    creditsSpent: billing ? msatToCSats(billing.refunded ? billing.costMsat : billing.reservedMsat) : 0
  });
});

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
app.get("/models/available", async (_req, reply) => {
  const modelMap: Record<string, { model: string; paramSize: number; agentCount: number; avgLoad: number }> = {};

  for (const [_agentId, cap] of agentCapabilities) {
    const model = cap.activeModel;
    if (!model) continue;
    if (!modelMap[model]) {
      modelMap[model] = { model, paramSize: cap.activeModelParamSize ?? 0, agentCount: 0, avgLoad: 0 };
    }
    modelMap[model].agentCount += 1;
    // agentCapabilities does not track per-agent load; default to 0
    modelMap[model].avgLoad += 0;
  }

  const models = Object.values(modelMap).map(m => ({
    ...m,
    avgLoad: m.agentCount > 0 ? m.avgLoad / m.agentCount : 0,
  }));

  return reply.send(models);
});
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
  return { cpu, gpu, quote: { cpu: quoteSatsPerCredit("cpu"), gpu: quoteSatsPerCredit("gpu") } };
});

/** Current rate-oracle epoch (market sats per CPU/GPU hour, sources, hashprice signal) and the live credit quote. */
app.get("/economy/rates/current", async (req, reply) => {
  if (!requireMeshOrPortalToken(req, reply)) return;
  return {
    enabled: RATE_ORACLE_ENABLED,
    recalibrationMs: RATE_RECALIBRATION_MS,
    epoch: latestRateEpoch,
    stale: isRateEpochStale(latestRateEpoch, rateOracleConfig),
    quote: { cpu: quoteSatsPerCredit("cpu"), gpu: quoteSatsPerCredit("gpu") },
    config: {
      usdPerCpuHourReference: rateOracleConfig.usdPerCpuHourReference,
      usdPerGpuHourReference: rateOracleConfig.usdPerGpuHourReference,
      networkMarkupBps: rateOracleConfig.networkMarkupBps,
      maxDailyMovePct: rateOracleConfig.maxDailyMovePct,
      maxSourceSpreadPct: rateOracleConfig.maxSourceSpreadPct,
      minSources: rateOracleConfig.minSources,
      btcUsdSources: rateOracleConfig.btcUsdSources.map((s) => s.name),
      computeSources: rateOracleConfig.computeSources.map((s) => `${s.name}(${s.resourceClass ?? "cpu"})`)
    }
  };
});

app.get("/economy/rates/history", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const query = z.object({ limit: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
  const epochs = pgStore ? await pgStore.listRateEpochs(query.limit) : latestRateEpoch ? [latestRateEpoch] : [];
  return { epochs };
});

/** Order book per compute class: asks (agents), bids (open tasks), spread, clearing price, oracle reference. */
// ── Payouts, infrastructure hosts and the fee pool ──
app.get("/economy/payouts/:accountId", async (req, reply) => {
  if (!requirePortalServiceToken(req as any, reply)) return;
  const { accountId } = z.object({ accountId: z.string().min(1) }).parse(req.params);
  const [balance, payouts, pins] = await Promise.all([payoutService.balance(accountId), payoutStore.listPayouts(accountId, 100), callbackPins.listCallbackPins(accountId)]);
  return { accountId, balance, payouts, callbackPins: callbackPinStatus(pins), policy: { ...payoutPolicy, lightningEnabled: ECONOMY_PAYMENTS_ENABLED, limits: payoutLimits, paused: await payoutPause.isPaused() } };
});
app.post("/economy/payouts/withdraw", async (req, reply) => {
  if (!requirePortalServiceToken(req as any, reply)) return;
  const parsed = z.object({ accountId: z.string().min(1), bolt11: z.string().min(20).max(4096) }).safeParse(req.body ?? {});
  if (!parsed.success) return reply.code(400).send({ ok: false, code: "invalid_request", detail: parsed.error.issues.map((i) => i.message).join("; ") });
  const body = parsed.data;
  const result = await payoutService.withdraw(body.accountId, body.bolt11.trim());
  if (!result.ok) return reply.code(result.code === "payout_unconfirmed" ? 202 : result.code === "payouts_paused" ? 503 : 400).send(result);
  return result;
});
app.post("/economy/payouts/address", async (req, reply) => {
  if (!requirePortalServiceToken(req as any, reply)) return;
  const parsedAddr = z.object({ accountId: z.string().min(1), lightningAddress: z.string().max(256).nullable() }).safeParse(req.body ?? {});
  if (!parsedAddr.success) return reply.code(400).send({ error: "invalid_request" });
  const body = parsedAddr.data;
  const address = body.lightningAddress?.trim() || null;
  if (address && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) && !/^https:\/\//i.test(address) && !/^lnurl1/i.test(address)) {
    return reply.code(400).send({ error: "invalid_lightning_address" });
  }
  if (pgStore) await pgStore.setLightningAddress(body.accountId, address, BITCOIN_NETWORK); // resets the old destination's callback pin
  else if (memoryPayoutStore) {
    await callbackPins.resetCallbackPins(body.accountId, address);
    if (address) memoryPayoutStore.autoAccounts.set(body.accountId, address);
    else memoryPayoutStore.autoAccounts.delete(body.accountId);
  }
  // Pin the callback host now, in the background so the portal's save is not held up by the
  // wallet's server; if the address does not resolve, it is pinned at its first payout.
  if (address) {
    void payoutService.pinDestination(body.accountId, address)
      .then((r) => app.log.info({ accountId: body.accountId, result: r.ok ? r.pinned : r.code }, "payout_callback_pin_on_save"))
      .catch((error) => app.log.warn({ error: String(error) }, "payout_callback_pin_on_save_failed"));
  }
  return { accountId: body.accountId, lightningAddress: address };
});
// The owner confirmed (portal, emailed code) that the destination's new payment server is theirs:
// re-pin to it and resume payouts. Only the change on record can be confirmed.
app.post("/economy/payouts/callback/confirm", async (req, reply) => {
  if (!requirePortalServiceToken(req as any, reply)) return;
  const parsed = z.object({ accountId: z.string().min(1).max(128), destination: z.string().min(3).max(512), newOrigin: z.string().min(8).max(300) }).safeParse(req.body ?? {});
  if (!parsed.success) return reply.code(400).send({ ok: false, error: "invalid_request" });
  const { accountId, destination, newOrigin } = parsed.data;
  const ok = await callbackPins.confirmCallbackChange(accountId, destination, newOrigin, Date.now());
  if (!ok) return reply.code(409).send({ ok: false, error: "callback_change_not_pending" });
  app.log.info({ accountId, destination, newOrigin }, "payout_callback_change_confirmed");
  return { ok: true, callbackPins: callbackPinStatus(await callbackPins.listCallbackPins(accountId)) };
});
// Remote infrastructure hosts: signed by the host's coordinator key (the one the mesh admitted for
// hostId), single-use, and only attested services count (src/economy/host-attestation.ts).
app.post("/economy/hosts/heartbeat", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const parsed = z
    .object({
      hostId: z.string().min(3).max(128),
      accountId: z.string().min(1).max(128).optional(),
      services: z.array(z.string().min(1).max(32)).min(1).max(8),
      region: z.string().max(32).optional(),
      coordinatorUrl: z.string().url().optional(),
      lightningAddress: z.string().max(256).refine((v) => validateLightningAddress(v).ok, "invalid lightningAddress").optional(),
      lightningNodeId: z.string().regex(/^0[23][0-9a-fA-F]{64}$/).optional(),
      ports: z.object({ bitcoind: z.number().int().min(1).max(65535), lightning: z.number().int().min(1).max(65535), electrs: z.number().int().min(1).max(65535) }).partial().optional(),
      issuedAtMs: z.number().int(),
      signature: z.string().min(16).max(512)
    })
    .safeParse(req.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "invalid_heartbeat", detail: parsed.error.issues.map((i) => i.message).join("; ") });
  const body = parsed.data;
  // Our own heartbeat is recorded in-process; a remote one claiming our id is an impersonation.
  const peer = body.hostId === identity.peerId ? undefined : mesh.listPeers().find((p) => p.peerId === body.hostId);
  const verdict = verifyHostHeartbeat(body, peer?.publicKeyPem, { reservedAccounts: RESERVED_HOST_ACCOUNTS });
  const replayed = verdict.ok && !(await verifyNonce(nonceStore, { nonce: `host-hb:${body.signature}`, sourceId: body.hostId, timestampMs: body.issuedAtMs, maxSkewMs: HOST_HEARTBEAT_MAX_SKEW_MS, ttlMs: SECURITY_NONCE_TTL_MS })).valid;
  if (!verdict.ok || replayed || !peer) {
    const reason = !verdict.ok ? verdict.reason : replayed ? "replayed_heartbeat" : "host_unknown";
    securityLog.log({
      level: securityLog.severity("host_heartbeat_rejected"),
      event: "host_heartbeat_rejected",
      source: { type: "coordinator", id: body.hostId, ip: req.ip },
      details: { reason },
      action: "reject_request",
      coordinatorId: identity.peerId
    });
    return reply.code(reason === "host_unknown" ? 403 : 401).send({ ok: false, error: reason });
  }
  const attestation = await hostAttestor.attest({
    hostId: body.hostId,
    publicKeyPem: peer.publicKeyPem,
    coordinatorUrl: peer.coordinatorUrl,
    services: body.services,
    lightningNodeId: body.lightningNodeId,
    ports: body.ports
  });
  // Uptime means reachable: a host whose coordinator does not answer for its key earns nothing.
  if (!attestation.attested.includes("coordinator")) {
    return reply.code(409).send({ ok: false, error: "coordinator_unreachable", attestation: attestation.results });
  }
  const { host, counted } = await recordInfraHeartbeat({
    hostId: body.hostId,
    accountId: body.accountId,
    declaredServices: body.services,
    attestation,
    region: body.region,
    coordinatorUrl: peer.coordinatorUrl,
    lightningAddress: body.lightningAddress,
    lightningNodeId: body.lightningNodeId
  });
  return { ok: true, counted, host, attestation: attestation.results, heartbeatMs: CC.HOST_HEARTBEAT_MS };
});
app.get("/economy/hosts", async (req, reply) => {
  if (!requireMeshOrPortalToken(req as any, reply)) return;
  const hosts = await payoutStore.listInfrastructureHosts();
  const expectedHeartbeats = Math.max(1, Math.floor(CC.FEE_POOL_DISTRIBUTION_MS / CC.HOST_HEARTBEAT_MS));
  return { hosts, expectedHeartbeats, distributionMs: CC.FEE_POOL_DISTRIBUTION_MS };
});
app.get("/economy/fee-pool", async (req, reply) => {
  if (!requireMeshOrPortalToken(req as any, reply)) return;
  const [earnedMsat, distributedMsat, credits] = await Promise.all([
    payoutStore.earnedMsat(NETWORK_FEE_POOL_ACCOUNT),
    payoutStore.distributedMsat(NETWORK_FEE_POOL_ACCOUNT),
    payoutStore.creditBalance(NETWORK_FEE_POOL_ACCOUNT)
  ]);
  return { accountId: NETWORK_FEE_POOL_ACCOUNT, earnedMsat, distributedMsat, availableMsat: Math.max(0, earnedMsat - distributedMsat), credits, networkFeeBps: NETWORK_FEE_BPS, lastDistribution: lastFeePoolDistribution };
});
app.post("/economy/fee-pool/distribute", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return; // manual override; the daily timer runs it automatically (audit econ#3)
  return runFeePoolDistribution({ manual: true });
});

app.get("/economy/market/book", async (req, reply) => {
  if (!requireMeshOrPortalToken(req, reply)) return;
  const query = z.object({ computeClass: classParam.optional() }).parse(req.query);
  const classes = query.computeClass ? [query.computeClass] : COMPUTE_CLASS_IDS;
  return { books: classes.map((c) => orderBook.snapshot(c)), defaultBidPremiumBps: MARKET_DEFAULT_BID_PREMIUM_BPS, networkFeeBps: NETWORK_FEE_BPS };
});

/** Candles (OHLC of the mid, trade volume) for one class; `interval` 1m|5m|15m|1h|4h|1d. Portal-token readable. */
app.get("/economy/market/candles", async (req, reply) => {
  if (!requireMeshOrPortalToken(req, reply)) return;
  const query = z
    .object({
      computeClass: classParam.default("cpu"),
      interval: z.enum(Object.keys(CANDLE_INTERVALS) as [string, ...string[]]).default("5m"),
      limit: z.coerce.number().int().min(1).max(2000).default(500)
    })
    .parse(req.query);
  return {
    computeClass: query.computeClass,
    interval: query.interval,
    candles: marketHistory.candles(query.computeClass, CANDLE_INTERVALS[query.interval], query.limit),
    latest: marketHistory.latest(query.computeClass) ?? null
  };
});

app.get("/economy/market/trades", async (req, reply) => {
  if (!requireMeshOrPortalToken(req, reply)) return;
  const query = z
    .object({ computeClass: classParam.default("cpu"), limit: z.coerce.number().int().min(1).max(500).default(50) })
    .parse(req.query);
  return { computeClass: query.computeClass, trades: marketHistory.recentTrades(query.computeClass, query.limit) };
});

app.get("/economy/market/depth", async (req, reply) => {
  if (!requireMeshOrPortalToken(req, reply)) return;
  const query = z.object({ computeClass: classParam.default("cpu") }).parse(req.query);
  const snap = orderBook.snapshot(query.computeClass);
  return { computeClass: query.computeClass, ...MarketHistory.depth(snap.asks, snap.bids), snapshot: snap };
});

/**
 * Standing orders from the portal. buy: the account's default max bid for its tasks (msat per
 * credit). sell: the ask applied to every agent the account owns (0 = track the reference).
 */
app.post("/economy/market/orders", async (req, reply) => {
  // The portal names the account (it binds acct-<userId> from the session); an agent may set
  // orders only for its own linked account. The mesh token alone is not enough.
  const headers = ((req as any).headers ?? {}) as Record<string, unknown>;
  const requestedAccount = (req.body as { accountId?: unknown } | undefined)?.accountId;
  if (!(headers["x-portal-service-token"] !== undefined && hasPortalServiceToken(headers))) {
    const caller = await callerAccount(req, "/economy/market/orders", typeof requestedAccount === "string" ? requestedAccount : undefined);
    if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
    if (caller.accountId !== requestedAccount) return reply.code(403).send({ error: "account_mismatch" });
  }
  const body = z
    .object({
      accountId: z.string().min(1).max(128),
      side: z.enum(["buy", "sell"]),
      computeClass: z.enum([...(ACCEPTED_COMPUTE_CLASS_IDS as [string, ...string[]]), "any"]).default("any"),
      msatPerCredit: z.number().min(0).max(1e9)
    })
    .parse(req.body);
  // A legacy class id maps onto its class and its price into the current unit (0 = track stays 0).
  const resolved = resolveRequestedClass(body.computeClass, body.msatPerCredit, {}, rateOracleConfig.computeClasses);
  const order: MarketOrder = { ...body, computeClass: resolved.computeClass as ComputeClassId | "any", msatPerCredit: resolved.msatPerCredit ?? 0, updatedAtMs: Date.now() };
  await applyMarketOrder(order);
  return { ok: true, order };
});

app.get("/economy/market/orders/:accountId", async (req, reply) => {
  if (!requireMeshOrPortalToken(req, reply)) return;
  const params = z.object({ accountId: z.string().min(1) }).parse(req.params);
  const orders = ["buy", "sell"].map((side) => marketOrders.get(`${params.accountId}:${side}`)).filter(Boolean);
  const owned = (await pgStore?.listAgentOwnershipByAccount(params.accountId)) ?? [];
  const agents = [...new Set([...owned.map((o) => o.agentId), params.accountId])]
    .map((agentId) => ({ agentId, capability: agentCapabilities.get(agentId), ask: orderBook.askFor(agentId) }))
    .filter((a) => a.capability)
    .map((a) => {
      // tier / weight are what the agent is paid at (the verified grant); claimedTier is what it reported.
      const eff = effectiveHardware(a.agentId, a.capability);
      return {
        agentId: a.agentId,
        computeClass: eff?.computeClass ?? a.capability!.computeClass,
        tier: eff?.tier ?? null,
        creditsPerSecond: eff?.creditsPerSecond ?? 1,
        claimedTier: a.capability!.hardwareClass?.tier ?? null,
        verification: hardwareVerifier.get(a.agentId)?.status ?? "unverified",
        reliability: hardwareVerifier.reliability(a.agentId) ?? null,
        ask: a.ask?.msatPerCredit ?? null,
        tracking: a.ask?.tracking ?? true
      };
    });
  return { accountId: params.accountId, orders, agents };
});

/**
 * Compute class definitions (with the tier weight table) with the current oracle rate and
 * connected agents per class and per tier. `creditsPerSecond: 1` is the base tier, kept for
 * portal pages built before tiers existed.
 */
app.get("/economy/market/classes", async (req, reply) => {
  if (!requireMeshOrPortalToken(req, reply)) return;
  const agentsByClass = new Map<string, number>();
  const agentsByTier = new Map<string, number>();
  /** Agents paid at the tier: verified there, or at a base tier with nothing to prove. */
  const verifiedByTier = new Map<string, number>();
  for (const [agentId, cap] of agentCapabilities) {
    agentsByClass.set(cap.computeClass, (agentsByClass.get(cap.computeClass) ?? 0) + 1);
    if (cap.hardwareClass) agentsByTier.set(cap.hardwareClass.tier, (agentsByTier.get(cap.hardwareClass.tier) ?? 0) + 1);
    const v = hardwareVerifier.get(agentId);
    if (v && (v.status === "verified" || v.status === "base")) verifiedByTier.set(v.granted.tier, (verifiedByTier.get(v.granted.tier) ?? 0) + 1);
  }
  return {
    rateEpochId: latestRateEpoch?.epochId ?? null,
    classes: COMPUTE_CLASS_IDS.map((id) => {
      const spec = rateOracleConfig.computeClasses[id];
      return {
        ...spec,
        creditsPerSecond: 1,
        tiers: spec.tiers.map((t) => ({ ...t, agents: agentsByTier.get(t.id) ?? 0, verifiedAgents: verifiedByTier.get(t.id) ?? 0 })),
        rate: latestRateEpoch?.classRates?.[id] ?? null,
        referenceMsatPerCredit: orderBook.referenceFor(id),
        agents: agentsByClass.get(id) ?? 0
      };
    })
  };
});

/**
 * Hardware verification records (claimed vs granted tier, last measurement, rolling evidence score):
 * the seed of the published SLA / reputation score.
 */
app.get("/economy/hardware/verifications", async (req, reply) => {
  if (!requireMeshOrPortalToken(req, reply)) return;
  return { enabled: hardwareVerifier.config.enabled, records: hardwareVerifier.list() };
});

app.get("/economy/hardware/verifications/:agentId", async (req, reply) => {
  if (!requireMeshOrPortalToken(req, reply)) return;
  const params = z.object({ agentId: z.string().min(1).max(128) }).parse(req.params);
  const record = hardwareVerifier.get(params.agentId);
  if (!record) return reply.code(404).send({ error: "not_found" });
  return { record };
});

/** Admin: force a recalibration now (e.g. after changing sources). Daily-move clamp still applies. */
app.post("/economy/rates/recalibrate", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  try {
    const epoch = await recalibrateRateEpoch();
    return { ok: true, epoch };
  } catch (err) {
    return reply.code(502).send({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/economy/credits/:accountId/quote", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const params = z.object({ accountId: z.string().min(1) }).parse(req.params);
  const balance = pgStore ? await pgStore.creditBalance(params.accountId) : creditEngine.balance(params.accountId);
  // The balance is in cSats: 1 cSat = 1 sat of prepaid compute.
  return {
    accountId: params.accountId,
    credits: Number(balance.toFixed(3)),
    cSats: Number(balance.toFixed(3)),
    satsPerCredit: 1,
    msatPerCredit: 1000,
    estimatedSats: Math.floor(balance),
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
  if (!authorizeAdmin(req, reply)) return; // operator: sets this coordinator's price epoch
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
  if (!authorizeAdmin(req, reply)) return; // operator: sets this coordinator's price epoch
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
  // Operator: an invoice for any named account. Owners buy through /account/buy (callerAccount).
  if (!authorizeAdmin(req, reply)) return;
  const body = z
    .object({
      accountId: z.string(),
      walletType: z.enum(["lightning", "onchain"]).default("lightning"),
      amountSats: z.number().int().positive().max(100000000)
    })
    .parse(req.body);
  return { ok: true, intent: await createPaymentIntent(body.accountId, body.amountSats, body.walletType as WalletType) };
});

/** A Lightning invoice that buys cSats for an account: 1 cSat per sat, after the coordinator fee. */
async function createPaymentIntent(accountId: string, amountSats: number, walletType: WalletType = "lightning"): Promise<PaymentIntent> {
  const { feeSats, netSats } = computeIntentFee(amountSats, COORDINATOR_FEE_BPS);
  const invoice = await lightningProvider.createInvoice({
    amountSats,
    memo: `edgecoder_credits:${accountId}`,
    expiresInSeconds: Math.floor(PAYMENT_INTENT_TTL_MS / 1000)
  });
  const intent: PaymentIntent = {
    intentId: randomUUID(),
    accountId,
    coordinatorId: identity.peerId,
    walletType,
    network: BITCOIN_NETWORK,
    invoiceRef: invoice.invoiceRef,
    paymentHash: invoice.paymentHash,
    amountSats,
    coordinatorFeeBps: COORDINATOR_FEE_BPS,
    coordinatorFeeSats: feeSats,
    netSats,
    // 1 cSat = 1 sat of prepaid compute: the net sats, after the coordinator fee.
    quotedCredits: netSats,
    status: "created",
    createdAtMs: Date.now()
  };
  paymentIntents.set(intent.intentId, intent);
  await pgStore?.upsertPaymentIntent(intent);
  return intent;
}

/** Buy cSats for the signing agent's owner: returns the invoice to pay. */
app.post("/account/buy", async (req, reply) => {
  const { amountSats, accountId: requested } = z.object({ amountSats: z.number().int().min(100).max(1_000_000), accountId: z.string().max(200).optional() }).parse(req.body);
  const caller = await callerAccount(req, "/account/buy", requested);
  if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
  if (!ECONOMY_PAYMENTS_ENABLED) return reply.code(503).send({ error: "payments_disabled" });
  const accountId = caller.accountId;
  const intent = await createPaymentIntent(accountId, amountSats);
  return reply.send({ intentId: intent.intentId, invoice: intent.invoiceRef, amountSats: intent.amountSats, cSats: intent.quotedCredits, feeSats: intent.coordinatorFeeSats, network: intent.network, expiresInSeconds: Math.floor(PAYMENT_INTENT_TTL_MS / 1000) });
});

/** State of one of the owner's purchases; checks with the Lightning node while it is unpaid. */
app.post("/account/intent", async (req, reply) => {
  const { intentId, accountId: requested } = z.object({ intentId: z.string().min(1).max(100), accountId: z.string().max(200).optional() }).parse(req.body);
  const caller = await callerAccount(req, "/account/intent", requested);
  if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
  const accountId = caller.accountId;
  const intent = paymentIntents.get(intentId) ?? (await pgStore?.getPaymentIntent(intentId)) ?? undefined;
  if (!intent || intent.accountId !== accountId) return reply.code(404).send({ error: "unknown_intent" });
  if (intent.status === "created") await reconcileIntent(intent);
  const now = paymentIntents.get(intentId) ?? (await pgStore?.getPaymentIntent(intentId)) ?? intent;
  return reply.send({ intentId, status: now.status, cSats: now.quotedCredits });
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

// #42: admin-only; caller-supplied txRef is ignored and the node is always asked.
app.post("/economy/payments/intents/:intentId/confirm", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  const params = z.object({ intentId: z.string() }).parse(req.params);
  const intent = paymentIntents.get(params.intentId) ?? (await pgStore?.getPaymentIntent(params.intentId));
  if (!intent) return reply.code(404).send({ error: "intent_not_found" });
  if (intent.status === "settled") return { ok: true, intent };
  if (intent.status === "expired") return reply.code(409).send({ error: "intent_expired" });
  const outcome = await settleIfPaid(intent);
  if (outcome.status === "unpaid") return reply.code(402).send({ error: "invoice_unpaid", status: "unpaid" });
  return { ok: true, status: outcome.status, intent: outcome.intent };
});

// #42: the webhook body is a hint only. Authenticity is an HMAC of the raw body
// (`x-payment-signature: sha256=<hex>`); settlement is decided by the Lightning node.
app.register(async (scope) => {
  scope.removeContentTypeParser("application/json");
  scope.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody?: string }).rawBody = body as string;
    try {
      done(null, (body as string).length > 0 ? JSON.parse(body as string) : {});
    } catch (error) {
      (error as { statusCode?: number }).statusCode = 400;
      done(error as Error, undefined);
    }
  });
  scope.post("/economy/payments/webhook", async (req, reply) => {
    if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
    if (!PAYMENT_WEBHOOK_SECRET) {
      return reply.code(503).send({ error: "payment_webhook_not_configured" });
    }
    const rawBody = (req as unknown as { rawBody?: string }).rawBody;
    const signature = (req.headers as Record<string, unknown>)["x-payment-signature"];
    if (!verifyPaymentWebhookSignature(rawBody, signature, PAYMENT_WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: "webhook_signature_required" });
    }
    const body = z.object({ invoiceRef: z.string().min(8) }).passthrough().parse(req.body);
    const match =
      [...paymentIntents.values()].find((intent) => intent.invoiceRef === body.invoiceRef) ??
      (await (async () => {
        const pending = await pgStore?.listPendingPaymentIntents(500);
        return (pending ?? []).find((intent) => intent.invoiceRef === body.invoiceRef);
      })());
    if (!match) return reply.code(404).send({ error: "intent_not_found" });
    if (match.status === "settled") return reply.send({ ok: true, alreadySettled: true });
    const outcome = await settleIfPaid(match);
    if (outcome.status === "unpaid") return reply.send({ ok: true, ignored: true, status: "unpaid" });
    if (outcome.status === "already") return reply.send({ ok: true, alreadySettled: true });
    return reply.send({ ok: true, intent: outcome.intent });
  });
});

app.post("/economy/payments/reconcile", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return; // operator
  const pending = pgStore ? await pgStore.listPendingPaymentIntents(500) : [...paymentIntents.values()];
  let settledCount = 0;
  let expiredCount = 0;
  for (const intent of pending) {
    if (intent.status !== "created") continue;
    const result = await reconcileIntent(intent);
    if (result === "settled") settledCount += 1;
    if (result === "expired") expiredCount += 1;
  }
  return reply.send({ ok: true, scanned: pending.length, settledCount, expiredCount });
});

app.post("/economy/treasury/policies", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return; // operator: approvedCoordinatorIds drives the issuance quorum
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
  if (!authorizeAdmin(req, reply)) return; // operator
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
  if (!authorizeAdmin(req, reply)) return; // operator; the issuance timer runs it automatically
  const result = await runIssuanceTick();
  return { ok: true, epoch: result.epoch ?? null, allocations: result.allocations.length };
});

app.get("/economy/issuance/current", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const epoch = await pgStore?.latestIssuanceEpoch(false, ISSUANCE_RECALC_MS);
  if (!epoch || !pgStore) return { epoch: null, allocations: [] };
  const allocations = await pgStore.listIssuanceAllocations(epoch.issuanceEpochId);
  return { epoch, allocations };
});

app.get("/economy/issuance/history", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(48) }).parse(req.query);
  const epochs = (await pgStore?.listIssuanceEpochs(query.limit, ISSUANCE_RECALC_MS)) ?? [];
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
  if (!authorizeAdmin(req, reply)) return; // operator: the vote is cast with this coordinator's identity
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
  const store = pgStore;
  const epoch = await store?.getIssuanceEpoch(body.epochId);
  if (epoch && store) {
    await store.withIssuanceLock(() => maybeFinalizeIssuanceEpoch(epoch));
  }
  return { ok: true, record };
});

app.get("/economy/issuance/quorum/:epochId", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const params = z.object({ epochId: z.string() }).parse(req.params);
  const records = (await pgStore?.listQuorumLedgerByEpoch(params.epochId)) ?? [];
  return { epochId: params.epochId, records };
});

// #100: each call can spend real sats, so manual anchor triggers need the admin token
// (a mesh token is not enough). The #46 per-checkpoint lock and daily budget still apply.
app.post("/economy/issuance/anchor", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
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

// `fingerprint` (sha256 of the SPKI DER) is what operators list in TRUSTED_COORDINATOR_KEYS and
// MESH_PEER_ALLOWLIST; `legacyFingerprints` are the PEM-text forms older agent builds compare.
const IDENTITY_FINGERPRINT = publicKeyFingerprint(identity.publicKeyPem);
app.get("/identity", async () => ({
  ...identity,
  fingerprint: IDENTITY_FINGERPRINT,
  trustEntry: `${identity.peerId}:${IDENTITY_FINGERPRINT}`,
  legacyFingerprints: legacyPemFingerprints(identity.publicKeyPem),
  responseSigning: RESPONSE_SIGNING_VERSION
}));
// Agents send a fresh nonce; the answer is signed with this coordinator's identity key, so a
// replayed /identity does not pass their pinned-key check.
app.post(IDENTITY_CHALLENGE_PATH, async (req, reply) => {
  const answer = answerIdentityChallenge(req.body, {
    peerId: identity.peerId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: coordinatorKeys.privateKeyPem,
    publicUrl: COORDINATOR_PUBLIC_URL
  });
  if (!answer) return reply.code(400).send({ error: "invalid_challenge" });
  return { ...answer, responseSigning: RESPONSE_SIGNING_VERSION };
});
app.get("/mesh/peers", async () => ({ peers: mesh.listPeers() }));

// The portal's signed coordinator registry, mirrored so the one platform URL serves it too
// (src/discovery/registry-mirror.ts). REGISTRY_UPSTREAM_URL overrides the source.
const REGISTRY_PORTAL_URL = PORTAL_SERVICE_URL || (process.env.PORTAL_PUBLIC_URL ?? "https://edgecoder.io");
const registryMirror = createRegistryMirror({
  upstreamUrl: process.env.REGISTRY_UPSTREAM_URL?.trim() || `${REGISTRY_PORTAL_URL.replace(/\/+$/, "")}/network/registry`
});
app.get("/network/registry", async (_req, reply) => {
  const doc = await registryMirror.get();
  if (!doc) return reply.code(503).send({ error: "registry_unavailable" });
  return reply.header("cache-control", "public, max-age=30").send(doc);
});

const peerSchema = z.object({
  peerId: z.string(),
  publicKeyPem: z.string(),
  coordinatorUrl: z.string().url(),
  networkMode: z.enum(["public_mesh", "enterprise_overlay"]),
  role: z.enum(["coordinator", "agent", "phone"]).optional(),
  registrationToken: z.string().optional(),
  issuedAtMs: z.number().optional(),
  signature: z.string().optional()
});

app.post("/mesh/register-peer", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = peerSchema.parse(req.body);
  const origin = requestOrigin(req);
  const sourceIp = origin.clientIp;

  // Coordinators that authenticate with a valid mesh token are trusted peers —
  // skip portal validation (same pattern as loopback self-registration for agents).
  // The mesh token IS the shared secret that proves membership in this coordinator mesh.
  const meshTokenProvided = MESH_AUTH_TOKEN !== "" && hasMeshToken((req.headers ?? {}) as Record<string, unknown>);
  let activationReason = "mesh_token_peer";

  if (meshTokenProvided) {
    // #52: the shared token alone is not enough; the peer's key must be allowlisted.
    const trust = checkPeerRegistration({ body, allowlist: MESH_PEER_ALLOWLIST, production: isProduction() });
    if (!trust.ok) {
      app.log.warn({ peerId: body.peerId, error: trust.error }, "peer_registration_rejected");
      return reply.code(trust.code).send({ error: trust.error });
    }
    activationReason = trust.mode === "allowlist" ? "mesh_peer_allowlisted" : "mesh_token_peer_legacy";
  }

  if (!meshTokenProvided) {
    const activation = await validatePortalNode({
      nodeId: body.peerId,
      nodeKind: "coordinator",
      registrationToken: body.registrationToken,
      sourceIp,
      loopback: origin.loopback
    });
    if (!activation.allowed) {
      return reply.code(403).send({ error: "coordinator_not_activated", reason: activation.reason });
    }
    if (PORTAL_SERVICE_URL && !activation.ownerEmail) {
      return reply.code(403).send({ error: "coordinator_not_activated", reason: "owner_email_required" });
    }
    activationReason = activation.reason ?? "portal_validated";
  }

  const { issuedAtMs: _issuedAtMs, signature: _signature, ...peerIdentity } = body;
  // Proven key (or portal-validated): may replace a squatter or update its own URL.
  if (!mesh.addPeer(peerIdentity as MeshPeerIdentity, { authoritative: true, source: "register" })) {
    // #118 review: also refused when the URL disagrees with the pin or no endpoint is pinned/known.
    return reply.code(403).send({ error: "peer_not_allowlisted_or_url_unpinned" });
  }
  peerScore.set(body.peerId, 100);
  app.log.info({ peerId: body.peerId, reason: activationReason, url: body.coordinatorUrl }, "peer_registered");
  const approvalRecord = ordering.append({
    eventType: "node_approval",
    taskId: `coordinator:${body.peerId}`,
    actorId: body.peerId,
    coordinatorId: identity.peerId,
    payloadJson: JSON.stringify({
      approved: true,
      activationReason,
      sourceIp: sourceIp ?? null
    })
  });
  await pgStore?.persistLedgerRecord(approvalRecord);
  await persistStatsLedgerRecord(approvalRecord);
  return reply.send({ ok: true, peerCount: mesh.listPeers().length });
});

const meshIngestSchema = z.object({
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
    "issuance_checkpoint",
    "capability_summary",
    "peer_exchange",
    "capability_announce"
  ]),
  fromPeerId: z.string(),
  issuedAtMs: z.number(),
  ttlMs: z.number(),
  payload: z.record(z.string(), z.unknown()),
  signature: z.string()
});

async function handleMeshIngest(
  message: z.infer<typeof meshIngestSchema>
): Promise<{ ok: boolean; statusCode?: number; error?: string; [key: string]: unknown }> {
  const peer = mesh.listPeers().find((p) => p.peerId === message.fromPeerId);
  // #118 review: with the allowlist enforced, only registered allowlisted peers may send gossip.
  if (PEER_ALLOWLIST_ENFORCED) {
    if (!MESH_PEER_ALLOWLIST.has(message.fromPeerId)) return { ok: false, statusCode: 403, error: "peer_not_allowlisted" };
    if (!peer || !isAllowlistedKey(MESH_PEER_ALLOWLIST, peer.peerId, peer.publicKeyPem)) {
      return { ok: false, statusCode: 404, error: "peer_unknown" };
    }
  }
  // Allow peer_exchange and capability_announce from unknown peers — this is how
  // new peers introduce themselves to the mesh after registering.
  if (!peer && message.type !== "peer_exchange" && message.type !== "capability_announce") {
    return { ok: false, statusCode: 404, error: "peer_unknown" };
  }

  // Rate limiting and signature validation (only when peer is known)
  if (peer) {
    const now = Date.now();
    const windowStart = now - (now % 10_000);
    const window = peerMessageWindow.get(peer.peerId);
    if (!window || window.windowMs !== windowStart) {
      peerMessageWindow.set(peer.peerId, { windowMs: windowStart, count: 1 });
    } else {
      window.count += 1;
      if (window.count > MESH_RATE_LIMIT_PER_10S) {
        peerScore.set(peer.peerId, Math.max(0, (peerScore.get(peer.peerId) ?? 100) - 10));
        return { ok: false, statusCode: 429, error: "peer_rate_limited" };
      }
    }

    const validation = protocol.validateMessage(message, peer.publicKeyPem);
    if (!validation.ok) {
      peerScore.set(peer.peerId, Math.max(0, (peerScore.get(peer.peerId) ?? 100) - 5));
      return { ok: false, statusCode: 400, error: validation.reason };
    }
  }
  if (message.type === "blacklist_update" && peer) {
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
      return { ok: false, statusCode: 400, error: "invalid_blacklist_payload" };
    }
    const data = payload.data;
    const incomingValidation = validateIncomingBlacklistRecord({
      record: data,
      peerPublicKeyPem: peer.publicKeyPem
    });
    if (!incomingValidation.ok) {
      peerScore.set(peer.peerId, Math.max(0, (peerScore.get(peer.peerId) ?? 100) - 10));
      return { ok: false, statusCode: 400, error: incomingValidation.reason };
    }
    const current = activeBlacklistRecord(data.agentId);
    if (!current || data.timestampMs >= current.timestampMs) {
      appendBlacklistRecord(data);
    }
  }
  if (message.type === "capability_summary") {
    const payload = message.payload as unknown as CapabilitySummaryPayload;
    if (payload.coordinatorId && payload.timestamp) {
      federatedCapabilities.set(payload.coordinatorId, payload);
      app.log.info({ from: payload.coordinatorId, agents: payload.agentCount }, "capability_summary_received");
    }
    return { ok: true };
  }

  // ── Peer Exchange (BitTorrent-style peer table merge) ──
  if (message.type === "peer_exchange") {
    const payload = message.payload as unknown as PeerExchangePayload;
    let added = 0;
    for (const p of payload.peers ?? []) {
      if (p.peerId === identity.peerId) continue;
      // #118 review: admission (allowlist + squatter replacement) is enforced inside addPeer.
      const admitted = mesh.addPeer({
        peerId: p.peerId,
        publicKeyPem: p.publicKeyPem,
        coordinatorUrl: p.peerUrl,
        networkMode: p.networkMode,
      }, { source: "gossip" });
      if (admitted) {
        peerScore.set(p.peerId, peerScore.get(p.peerId) ?? 100);
        added++;
      } else {
        app.log.debug?.({ from: message.fromPeerId, peerId: p.peerId }, "peer_exchange_entry_dropped");
      }
    }
    if (added > 0) {
      app.log.info({ from: message.fromPeerId, added, total: mesh.listPeers().length }, "peer_exchange_merged");
    }
    return { ok: true, added };
  }

  // ── Capability Announce (individual peer capabilities) ──
  if (message.type === "capability_announce") {
    const payload = message.payload as unknown as CapabilityAnnouncePayload;
    if (payload.peerId && payload.role) {
      // Store mesh peer capabilities for agent/phone peers so the coordinator
      // knows they can accept task_offers via gossip (without full /register).
      if (payload.role === "agent" || payload.role === "phone") {
        const existing = agentCapabilities.get(payload.peerId);
        if (existing) {
          existing.activeModel = payload.models[0];
          existing.localModelCatalog = payload.models;
          existing.maxConcurrentTasks = payload.maxConcurrentTasks;
          existing.lastSeenMs = Date.now();
        } else {
          agentCapabilities.set(payload.peerId, {
            os: payload.deviceType === "phone" ? "ios" : "macos",
            version: "mesh-peer",
            mode: "swarm-only",
            localModelEnabled: true,
            localModelProvider: "ollama-local",
            localModelCatalog: payload.models,
            clientType: `mesh-${payload.deviceType}`,
            swarmEnabled: true,
            ideEnabled: false,
            maxConcurrentTasks: payload.maxConcurrentTasks,
            connectedPeers: new Set<string>(),
            activeModel: payload.models[0],
            activeModelParamSize: 0,
            computeClass: "cpu" as ComputeClassId,
            sandboxMode: "none" as SandboxMode,
            lastSeenMs: Date.now(),
          });
        }
      }
      app.log.info({ peerId: payload.peerId, role: payload.role, models: payload.models.length }, "capability_announce_received");
    }
    return { ok: true };
  }

  // ── P2P mesh task distribution ──
  if (message.type === "task_offer") {
    const payload = z.object({
      subtaskId: z.string(),
      taskId: z.string(),
      kind: z.enum(["micro_loop", "single_step"]),
      language: z.enum(["python", "javascript"]),
      input: z.string(),
      timeoutMs: z.number(),
      snapshotRef: z.string(),
      projectMeta: z.object({
        projectId: z.string(),
        tenantId: z.string().optional(),
        resourceClass: z.enum(["cpu", "gpu"]),
        priority: z.number(),
        // Capability constraints travel with the task so a peer cannot hand it to an under-spec agent.
        minVramGb: z.number().positive().max(4096).optional(),
        minMemoryGb: z.number().positive().max(4096).optional(),
      }),
      originCoordinatorId: z.string(),
      originCoordinatorUrl: z.string(),
    }).safeParse(message.payload);

    if (!payload.success) {
      return { ok: false, statusCode: 400, error: "invalid_task_offer_payload" };
    }

    const d = payload.data;
    // Don't re-enqueue our own tasks
    if (d.originCoordinatorId === identity.peerId) {
      return { ok: true, skipped: "own_task" };
    }
    // Only accept if we have alive agents (heartbeat in last 30s)
    const aliveAgents = [...agentCapabilities.values()].filter(
      a => a.lastSeenMs > Date.now() - 30_000
    );
    if (aliveAgents.length === 0) {
      return { ok: true, skipped: "no_agents" };
    }
    // Enqueue locally (dedup by subtaskId handled in queue)
    queue.enqueueSubtask({ ...d, id: d.subtaskId });
    // Track origin for result forwarding — prefer the actual reachable peer
    // URL from the mesh over the self-reported URL in the payload (which may
    // be an unreachable custom domain).
    const originPeer = mesh.listPeers().find(p => p.peerId === d.originCoordinatorId);
    taskOriginMap.set(d.subtaskId, {
      coordinatorId: d.originCoordinatorId,
      coordinatorUrl: originPeer?.coordinatorUrl ?? d.originCoordinatorUrl,
    });
    // Broadcast task_claim so origin coordinator knows we're handling it
    const claimMsg = protocol.createMessage(
      "task_claim",
      identity.peerId,
      { subtaskId: d.subtaskId, claimedByCoordinator: identity.peerId },
      coordinatorKeys.privateKeyPem,
    );
    void mesh.broadcast(claimMsg);
    app.log.info({ subtaskId: d.subtaskId, from: d.originCoordinatorId }, "task_offer_accepted");
    if (peer) peerScore.set(peer.peerId, Math.min(200, (peerScore.get(peer.peerId) ?? 100) + 2));
    return { ok: true, enqueued: true };
  }

  if (message.type === "task_claim") {
    const payload = z.object({
      subtaskId: z.string(),
      claimedByCoordinator: z.string(),
    }).safeParse(message.payload);

    if (payload.success && payload.data.claimedByCoordinator !== identity.peerId) {
      // Only remove from our queue if we don't have alive local agents who
      // could claim it.  When we *do* have agents (e.g. iPhone connected via
      // WS), keep the task so local agents can still race for it via /pull.
      const aliveLocalAgents = [...agentCapabilities.values()].filter(
        a => a.lastSeenMs > Date.now() - 30_000
      );
      if (aliveLocalAgents.length === 0) {
        const removed = queue.markRemoteClaimed(payload.data.subtaskId);
        if (removed) {
          app.log.info({ subtaskId: payload.data.subtaskId, by: payload.data.claimedByCoordinator }, "task_claim_remote");
        }
      } else {
        app.log.info(
          { subtaskId: payload.data.subtaskId, by: payload.data.claimedByCoordinator, localAgents: aliveLocalAgents.length },
          "task_claim_remote_kept_for_local"
        );
      }
    }
    return { ok: true };
  }

  // ── Result Announce from mesh peers (agent/phone executed a task) ──
  if (message.type === "result_announce") {
    const payload = z.object({
      taskId: z.string(),
      subtaskId: z.string(),
      ok: z.boolean(),
      output: z.string().optional(),
      error: z.string().optional(),
      durationMs: z.number().optional(),
    }).safeParse(message.payload);

    if (payload.success) {
      // Remove from our queue if still pending
      queue.markRemoteClaimed(payload.data.subtaskId);
      app.log.info(
        { subtaskId: payload.data.subtaskId, from: message.fromPeerId, ok: payload.data.ok },
        "result_announce_from_mesh"
      );
    }
    return { ok: true };
  }

  if (peer) {
    peerScore.set(peer.peerId, Math.min(200, (peerScore.get(peer.peerId) ?? 100) + 1));
  }
  return { ok: true };
}

app.post("/mesh/ingest", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const message = meshIngestSchema.parse(req.body);
  const result = await handleMeshIngest(message);
  if (result.ok) {
    // Fan-out: relay the message to WS-connected peers that haven't seen it.
    // This ensures NATed peers receive gossip even when the sender can't
    // reach them directly.
    relayToWsPeers(message);
  }
  return reply.code(result.statusCode ?? (result.ok ? 200 : 400)).send(result);
});

// ── Gossip relay for NATed peers ──
// When a peer can't reach another peer via HTTP (NAT/firewall), it asks a
// coordinator that has a WS connection to that peer to forward the message.
app.post("/mesh/relay-gossip", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const body = z.object({
    targetPeerId: z.string(),
    message: z.string(),
  }).parse(req.body);

  if (!mesh.hasWebSocket(body.targetPeerId)) {
    return reply.code(404).send({ ok: false, error: "no_ws_for_target" });
  }

  // Parse and validate the inner message before relaying
  try {
    const innerMsg = meshIngestSchema.parse(JSON.parse(body.message));
    // Validate it through normal ingest path first
    const result = await handleMeshIngest(innerMsg);
    if (!result.ok) {
      return reply.code(result.statusCode ?? 400).send(result);
    }
  } catch {
    return reply.code(400).send({ ok: false, error: "invalid_relay_message" });
  }

  // Push to the target peer's WS connection
  try {
    const ws = (mesh as any).wsPeers?.get(body.targetPeerId);
    if (ws && ws.readyState === 1) {
      ws.send(body.message);
      return reply.send({ ok: true, relayed: true });
    }
    return reply.code(404).send({ ok: false, error: "ws_not_open" });
  } catch (err) {
    return reply.code(500).send({ ok: false, error: (err as Error).message });
  }
});

/**
 * Relay a gossip message to all WS-connected peers except the sender.
 * This is the key mechanism for NAT traversal: when a coordinator receives
 * gossip, it pushes it to all WS-connected agents/peers, ensuring NATed
 * nodes stay in sync even when they can't be reached via HTTP.
 */
function relayToWsPeers(message: z.infer<typeof meshIngestSchema>): void {
  const serialized = JSON.stringify(message);
  const wsConnected = mesh.getWsConnectedPeerIds();
  for (const peerId of wsConnected) {
    if (peerId === message.fromPeerId) continue; // don't echo back to sender
    if (peerId === identity.peerId) continue;     // don't send to self
    try {
      const ws = (mesh as any).wsPeers?.get(peerId);
      if (ws && ws.readyState === 1) {
        ws.send(serialized);
      }
    } catch {
      // Non-fatal — peer may have disconnected
    }
  }
}

// ── WebSocket endpoint for NAT traversal ──
// Agents behind NAT open an outbound WebSocket to this endpoint.
// The coordinator pushes gossip messages down the persistent connection.
// Each connection is bound to one peerId (src/mesh/ws-auth.ts): signed binds prove the peer's
// key, unsigned (older agents) binds are allowed until MESH_WS_REQUIRE_SIGNED=true and never
// displace an authenticated one, and every message must come from the bound peer.
const MESH_WS_REQUIRE_SIGNED = (process.env.MESH_WS_REQUIRE_SIGNED ?? "false").trim().toLowerCase() === "true";
const meshWsBindings = new Map<string, { socket: unknown; authenticated: boolean }>();
app.get("/mesh/ws", { websocket: true }, async (socket, req) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  // Header first; the query parameter is kept for agents that predate it (it can end up in logs).
  const token = readHeaderValue(req.headers as Record<string, unknown>, "x-mesh-token") || url.searchParams.get("token");
  const peerId = url.searchParams.get("peerId");
  if (!peerId || (MESH_AUTH_TOKEN && (!token || !safeTokenEqual(token, MESH_AUTH_TOKEN)))) {
    socket.close(4001, "mesh_unauthorized");
    return;
  }
  const signature = readHeaderValue(req.headers as Record<string, unknown>, "x-mesh-ws-signature") || null;
  const issuedAtMs = readHeaderValue(req.headers as Record<string, unknown>, "x-mesh-ws-ts") || null;
  const bind = decideMeshWsBind({
    peerId,
    signature,
    issuedAtMs,
    knownPublicKeyPem: agentCapabilities.get(peerId)?.publicKeyPem ?? mesh.listPeers().find((p) => p.peerId === peerId)?.publicKeyPem,
    existingAuthenticated: meshWsBindings.get(peerId)?.authenticated === true,
    requireSigned: MESH_WS_REQUIRE_SIGNED
  });
  // A signed bind is single-use: the same headers cannot bind a second connection.
  const replayed =
    bind.ok && bind.authenticated &&
    !(await verifyNonce(nonceStore, { nonce: `mesh-ws:${signature}`, sourceId: peerId, timestampMs: Number(issuedAtMs), maxSkewMs: MESH_WS_BIND_MAX_SKEW_MS, ttlMs: SECURITY_NONCE_TTL_MS })).valid;
  if (!bind.ok || replayed) {
    const reason = bind.ok ? "replayed_bind" : bind.reason;
    securityLog.log({
      level: securityLog.severity("agent_trust_violation"),
      event: "agent_trust_violation",
      source: { type: "agent", id: peerId, ip: req.ip },
      details: { route: "/mesh/ws", reason },
      action: "reject_connection",
      coordinatorId: identity.peerId
    });
    socket.close(4003, reason);
    return;
  }
  const previous = meshWsBindings.get(peerId);
  meshWsBindings.set(peerId, { socket, authenticated: bind.authenticated });
  if (previous && previous.socket !== socket) {
    try {
      (previous.socket as { close: (code: number, reason: string) => void }).close(4004, "replaced_by_new_connection");
    } catch {
      /* already closed */
    }
  }

  console.log(`[ws] mesh peer connected: ${peerId}${bind.authenticated ? "" : " (unsigned bind)"}`);
  mesh.setWebSocketForPeer(peerId, socket);

  socket.on("message", async (data) => {
    try {
      const message = meshIngestSchema.parse(JSON.parse(data.toString()));
      // The socket speaks for its bound peer only.
      if (!meshWsSenderMatches(peerId, message)) {
        securityLog.log({
          level: securityLog.severity("agent_trust_violation"),
          event: "agent_trust_violation",
          source: { type: "agent", id: peerId },
          details: { route: "/mesh/ws", reason: "from_peer_mismatch", claimedFromPeerId: message.fromPeerId },
          action: "drop_message",
          coordinatorId: identity.peerId
        });
        return;
      }
      const result = await handleMeshIngest(message);
      // Fan-out WS-received gossip to other WS-connected peers.
      // This lets NATed agents gossip to each other through the coordinator.
      if (result.ok) relayToWsPeers(message);
    } catch (err) {
      console.warn(`[ws] ingest error from ${peerId}: ${(err as Error).message}`);
    }
  });

  // Only the connection that currently holds the binding may release it.
  const release = () => {
    if (meshWsBindings.get(peerId)?.socket !== socket) return;
    meshWsBindings.delete(peerId);
    mesh.removeWebSocketForPeer(peerId);
  };
  socket.on("close", () => {
    console.log(`[ws] mesh peer disconnected: ${peerId}`);
    release();
  });

  socket.on("error", (err) => {
    console.warn(`[ws] error from ${peerId}: ${err.message}`);
    release();
  });
});

app.get("/mesh/capabilities", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const model = (req.query as Record<string, string>).model;
  const entries = [...federatedCapabilities.values()];
  if (model) {
    const filtered = entries.filter(
      (c) => c.modelAvailability[model]?.agentCount > 0
    );
    return reply.send({ coordinators: filtered });
  }
  return reply.send({ coordinators: entries });
});

app.get("/ledger/snapshot", async () => ({ records: ordering.snapshot(), proof: ordering.latestProof() }));
app.get("/ledger/verify", async () => {
  const validation = verifyOrderingChain(ordering.snapshot(), coordinatorKeys.publicKeyPem);
  return { ok: validation.ok, reason: validation.reason };
});
app.get("/stats/ledger/head", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const [head, checkpoint] = await Promise.all([
    pgStore?.latestStatsLedgerHead(),
    pgStore?.latestStatsCheckpoint(),
  ]);
  return {
    coordinatorId: identity.peerId,
    head: head ?? { issuedAtMs: 0, hash: "GENESIS", count: 0 },
    checkpoint: checkpoint
      ? {
          hash: checkpoint.hash,
          height: checkpoint.height,
          issuedAtMs: checkpoint.issuedAtMs
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
  if (!authorizeAdmin(req, reply)) return; // #100

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
  const confirmations = anchorConfirmations(anchor);
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
  let latestCommit: { hash: string; height: number | null; issuedAtMs: number } | null | undefined;
  if (pgStore) {
    try {
      [nodes, earnings, head, latestCommit] = await Promise.race([
        Promise.all([
          pgStore.listNodeStatusProjection(query.ownerEmail),
          pgStore.listCoordinatorEarningsProjection(query.ownerEmail),
          pgStore.latestStatsLedgerHead(),
          pgStore.latestStatsCheckpoint()
        ]),
        timeoutReject("stats_projection_query")
      ]);
    } catch (error) {
      app.log.warn({ error }, "stats_projection_query_skipped");
    }
  }
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
          hash: latestCommit.hash,
          height: latestCommit.height ?? null,
          issuedAtMs: latestCommit.issuedAtMs
        }
      : null,
    finality,
    nodes: [...mergedByNodeId.values()],
    earnings: earnings ?? []
  };
});
app.get("/stats/network/summary", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  let portalCounts: { users: { total: number; verified: number }; nodes: { total: number; approved: number; active: number; agents: number; coordinators: number } } | null = null;
  if (PORTAL_SERVICE_URL) {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (PORTAL_OUTBOUND_TOKEN) headers["x-portal-service-token"] = PORTAL_OUTBOUND_TOKEN;
      const res = await request(`${PORTAL_SERVICE_URL}/internal/stats/counts`, {
        method: "GET",
        headers,
        headersTimeout: 5_000,
        bodyTimeout: 5_000
      });
      if (res.statusCode === 200) {
        portalCounts = (await res.body.json()) as { users: { total: number; verified: number }; nodes: { total: number; approved: number; active: number; agents: number; coordinators: number } };
      }
    } catch (err) {
      app.log.warn({ err }, "stats_network_summary_portal_unreachable");
    }
  }
  const allModels = new Set<string>();
  for (const cap of agentCapabilities.values()) {
    for (const m of cap.localModelCatalog) allModels.add(m);
  }
  return {
    timestamp: Date.now(),
    users: portalCounts?.users ?? null,
    nodes: portalCounts
      ? {
          enrolled: portalCounts.nodes.total,
          approved: portalCounts.nodes.approved,
          active: portalCounts.nodes.active,
          agents: portalCounts.nodes.agents,
          coordinators: portalCounts.nodes.coordinators
        }
      : null,
    live: {
      agentsConnected: agentCapabilities.size,
      queueDepth: [...directWorkById.values()].filter((w) => w.status === "offered").length,
      activeTunnels: activeTunnels.size,
      modelsAvailable: allModels.size
    }
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
  // #40: admin only (previously any mesh peer)
  if (!authorizeAdmin(req, reply)) return;
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
/** Lift an agent's blacklist (admin). Appends an already-expired record, which supersedes the
 *  earlier one here, on reload and on peers that receive the gossip. */
app.post("/security/blacklist/:agentId/lift", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  const params = z.object({ agentId: z.string().min(1) }).parse(req.params);
  const body = z.object({ reason: z.string().min(3).default("lifted by admin") }).parse(req.body ?? {});
  if (!activeBlacklistRecord(params.agentId)) return reply.code(404).send({ error: "not_blacklisted" });
  const record = issueCoordinatorBlacklistRecord({
    agentId: params.agentId,
    reasonCode: "manual_review",
    reason: `lifted: ${body.reason}`,
    evidenceHashSha256: createHash("sha256").update(`lift:${params.agentId}`).digest("hex"),
    reportedBy: "admin",
    expiresAtMs: Date.now(),
  });
  behaviorTracker.reset(params.agentId);
  autoBlacklister.clearStrikes(params.agentId);
  return { ok: true, record, version: blacklistVersion };
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
  const body = z.object({ fromAgentId: z.string(), toAgentId: z.string() }).parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
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
  const body = z.object({ agentId: z.string(), token: z.string() }).parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.agentId))) return;
  if (activeBlacklistRecord(body.agentId)) return reply.code(403).send({ error: "agent_blacklisted" });
  const tunnel = activeTunnels.get(body.token);
  if (!tunnel) return reply.code(404).send({ error: "tunnel_not_found" });
  if (tunnel.toAgentId !== body.agentId) return reply.code(403).send({ error: "tunnel_target_mismatch" });
  agentCapabilities.get(tunnel.fromAgentId)?.connectedPeers.add(tunnel.toAgentId);
  agentCapabilities.get(tunnel.toAgentId)?.connectedPeers.add(tunnel.fromAgentId);
  return { ok: true };
});

app.post("/agent-mesh/relay", async (req, reply) => {
  const body = z.object({ token: z.string(), fromAgentId: z.string(), payload: z.string() }).parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
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
  const body = z.object({ fromAgentId: z.string(), token: z.string(), reason: z.string() }).parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
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
  const body = z.object({ agentId: z.string(), token: z.string() }).parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.agentId))) return;
  const notices = (pendingTunnelCloseNotices.get(body.agentId) ?? []).filter((n) => n.token !== body.token);
  pendingTunnelCloseNotices.set(body.agentId, notices);
  return { ok: true };
});

app.post("/agent-mesh/direct-work/offer", async (req, reply) => {
  const body = z
    .object({
      fromAgentId: z.string(),
      toAgentId: z.string(),
      workType: z.enum(["code_task", "model_inference"]).default("code_task"),
      language: z.enum(["python", "javascript"]).optional(),
      input: z.string().min(1)
    })
    .parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
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
  const body = z
    .object({
      fromAgentId: z.string(),
      toAgentId: z.string(),
      prompt: z.string().min(1).max(16_384)
    })
    .parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.fromAgentId))) return;
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
  const body = z.object({ offerId: z.string(), byAgentId: z.string() }).parse(req.body);
  if (!(await requireAgentSelf(req, reply, body.byAgentId))) return;
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
  if (!(await requireAgentSelf(req, reply, body.byAgentId))) return;
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
  if (!authorizeAdmin(req, reply)) return; // operator: pulls a model onto this coordinator's volume
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

const AGENT_ORCHESTRATION_ONLINE_WINDOW_MS = CC.AGENT_ORCHESTRATION_ONLINE_WINDOW_MS;

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
  // Operator: a forced model rollout makes the target agent pull (and maybe install Ollama).
  if (!authorizeAdmin(req, reply)) return;
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
  const params = z.object({ agentId: z.string() }).parse(req.params);
  if (!(await requireAgentSelf(req, reply, params.agentId))) return;
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
  const params = z.object({ agentId: z.string() }).parse(req.params);
  if (!(await requireAgentSelf(req, reply, params.agentId))) return;
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
const escalationResolver = createEscalationResolverFromEnv();

const escalationRequestSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  task: z.string().min(1),
  failedCode: z.string(),
  errorHistory: z.array(z.string()),
  language: z.enum(["python", "javascript"]),
  iterationsAttempted: z.number().int().min(1)
});

// Portal model discovery — returns local Ollama models + swarm models
app.get("/portal/models", async (_req, reply) => {
  const ollamaHost = OLLAMA_HOST ?? "http://127.0.0.1:11434";
  let local: Array<{ name: string; parameterSize: string; quantization: string; running: boolean }> = [];
  let runningNames: Set<string> = new Set();

  // Get running models
  try {
    const psRes = await request(`${ollamaHost}/api/ps`, { method: "GET", headersTimeout: 3_000 });
    if (psRes.statusCode >= 200 && psRes.statusCode < 300) {
      const ps = (await psRes.body.json()) as { models?: Array<{ name: string }> };
      for (const m of ps.models ?? []) runningNames.add(m.name);
    } else {
      await psRes.body.text().catch(() => "");
    }
  } catch { /* ignore */ }

  // Get installed models
  try {
    const tagsRes = await request(`${ollamaHost}/api/tags`, { method: "GET", headersTimeout: 3_000 });
    if (tagsRes.statusCode >= 200 && tagsRes.statusCode < 300) {
      const tags = (await tagsRes.body.json()) as { models?: Array<{ name: string; details: { parameter_size: string; quantization_level: string } }> };
      local = (tags.models ?? []).map((m) => ({
        name: m.name,
        parameterSize: m.details.parameter_size ?? "",
        quantization: m.details.quantization_level ?? "",
        running: runningNames.has(m.name),
      }));
    } else {
      await tagsRes.body.text().catch(() => "");
    }
  } catch { /* Ollama not reachable */ }

  // Build swarm model list from agent capabilities
  const swarmModelMap: Record<string, number> = {};
  for (const [, cap] of agentCapabilities) {
    if (cap.activeModel) {
      swarmModelMap[cap.activeModel] = (swarmModelMap[cap.activeModel] ?? 0) + 1;
    }
  }
  const swarm = Object.entries(swarmModelMap).map(([model, agentCount]) => ({
    model,
    paramSize: 0,
    agentCount,
  }));

  return reply.send({ local, swarm });
});

// ── Mesh-peer chat failover helper ──
// Tries chat-capable mesh peers (from federatedCapabilities + bootstrap URLs).
// Streams the first successful response through `reply` and returns true.
// Returns false if all peers fail so the caller can send its own error.
async function tryMeshPeerChat(
  chatBody: { messages: Array<{ role: string; content: string }>; model?: string; temperature?: number; max_tokens?: number },
  reply: FastifyReply,
): Promise<boolean> {
  const chatPeerUrls: string[] = [];
  const meshPeers = mesh.listPeers();
  for (const cap of federatedCapabilities.values()) {
    if (!cap.chatEnabled) continue;
    if (cap.coordinatorId === identity.peerId) continue;
    const peer = meshPeers.find(p => p.peerId === cap.coordinatorId);
    if (peer?.coordinatorUrl) chatPeerUrls.push(peer.coordinatorUrl);
  }
  // Fallback: include bootstrap URLs in case mesh hasn't converged yet
  for (const url of COORDINATOR_BOOTSTRAP_URLS) {
    if (url !== COORDINATOR_PUBLIC_URL && !chatPeerUrls.includes(url)) {
      chatPeerUrls.push(url);
    }
  }

  for (const peerUrl of chatPeerUrls) {
    try {
      const fwdHeaders: Record<string, string> = { "content-type": "application/json" };
      if (PORTAL_SERVICE_TOKEN) fwdHeaders["x-portal-service-token"] = PORTAL_SERVICE_TOKEN;
      const peerRes = await request(`${peerUrl.replace(/\/$/, "")}/portal/chat`, {
        method: "POST",
        headers: fwdHeaders,
        body: JSON.stringify(chatBody),
        headersTimeout: 120_000,
        bodyTimeout: 0,
      });
      if (peerRes.statusCode >= 200 && peerRes.statusCode < 300) {
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        });
        for await (const chunk of peerRes.body) {
          reply.raw.write(chunk);
        }
        reply.raw.end();
        return true;
      }
      await peerRes.body.text().catch(() => "");
    } catch {
      // peer unreachable, try next
    }
  }

  return false;
}

// Portal chat completion — streams Ollama response for portal web chat
app.post("/portal/chat", async (req, reply) => {
  const body = z.object({
    messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
    model: z.string().optional(),
    temperature: z.number().optional(),
    max_tokens: z.number().optional()
  }).parse(req.body);

  const ollamaHost = OLLAMA_HOST ?? "http://127.0.0.1:11434";
  let chatModel = body.model ?? process.env.OLLAMA_MODEL ?? "qwen3.5:9b";

  // Auto-detect available model if configured one isn't available
  let ollamaHealthy = true;
  let installedModels: Array<{ name: string; paramSize: number }> = [];
  let activeModelQuantization: string | undefined;
  let activeModelParamSize = 0;
  try {
    const tagsRes = await request(`${ollamaHost}/api/tags`, { method: "GET", headersTimeout: 3_000 });
    if (tagsRes.statusCode >= 200 && tagsRes.statusCode < 300) {
      const tags = (await tagsRes.body.json()) as { models?: Array<{ name: string; size: number; details: { parameter_size: string; quantization_level: string } }> };
      const available = tags.models ?? [];
      installedModels = available.map((m) => ({
        name: m.name,
        paramSize: parseFloat(m.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0"),
      }));
      const activeEntry = available.find((m) => m.name === chatModel);
      if (activeEntry) {
        activeModelParamSize = parseFloat(activeEntry.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0");
        activeModelQuantization = activeEntry.details.quantization_level;
      }
      if (available.length > 0 && !available.some((m) => m.name === chatModel || m.name.startsWith(chatModel + ":"))) {
        chatModel = available[0].name;
        const fallback = available[0];
        activeModelParamSize = parseFloat(fallback.details.parameter_size.match(/([\d.]+)/)?.[1] ?? "0");
        activeModelQuantization = fallback.details.quantization_level;
      }
    }
  } catch {
    ollamaHealthy = false;
  }

  // ── Forward to mesh peer when local Ollama is down ──
  if (!ollamaHealthy) {
    app.log.warn("Local Ollama unavailable — failing over to mesh network");
    const handled = await tryMeshPeerChat(body, reply);
    if (handled) return;
    return reply.code(502).send({
      error: "no_models_available",
      detail: "No local Ollama running and no mesh peers with available models. Start Ollama locally or ensure at least one peer in the network has a model loaded."
    });
  }

  // Build swarm model list from agent capabilities
  const swarmModelMap: Record<string, number> = {};
  for (const [, cap] of agentCapabilities) {
    if (cap.activeModel) {
      swarmModelMap[cap.activeModel] = (swarmModelMap[cap.activeModel] ?? 0) + 1;
    }
  }
  const swarmModels = Object.entries(swarmModelMap).map(([model, agentCount]) => ({ model, agentCount }));

  const queueStatus = queue.status();
  const pullProgress = coordinatorPullTracker.getProgress();

  const systemPromptCtx: SystemPromptContext = {
    activeModel: chatModel,
    activeModelParamSize,
    activeModelQuantization,
    installedModels,
    swarmModels,
    ollamaHealthy,
    queueDepth: queueStatus.queued,
    connectedAgents: agentCapabilities.size,
    pullInProgress: pullProgress ? { model: pullProgress.model, progressPct: pullProgress.progressPct } : undefined,
  };

  const systemPrompt = buildChatSystemPrompt(systemPromptCtx);
  const messagesWithSystem = [
    { role: "system", content: systemPrompt },
    ...body.messages.filter((m) => m.role !== "system"),
  ];

  // Local Ollama is available — try calling it directly
  let ollamaRes;
  try {
    ollamaRes = await request(`${ollamaHost}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: chatModel,
        messages: messagesWithSystem,
        stream: true,
        options: {
          temperature: body.temperature ?? 0.7,
          num_predict: body.max_tokens ?? 4096
        }
      }),
      headersTimeout: 120_000,
      bodyTimeout: 0
    });
  } catch (localErr) {
    app.log.warn({ err: localErr }, "Local Ollama chat failed — falling over to mesh");
    ollamaRes = null;
  }

  if (!ollamaRes || ollamaRes.statusCode < 200 || ollamaRes.statusCode >= 300) {
    // Consume error body if present
    if (ollamaRes) await ollamaRes.body.text().catch(() => "");
    const handled = await tryMeshPeerChat(body, reply);
    if (handled) return;
    return reply.code(502).send({ error: "no_models_available", model: chatModel });
  }

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  for await (const chunk of ollamaRes.body) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        if (parsed.message?.content) {
          reply.raw.write(`data: ${JSON.stringify({ content: parsed.message.content })}\n\n`);
        }
        if (parsed.done) {
          reply.raw.write("data: [DONE]\n\n");
        }
      } catch {
        // skip unparseable lines
      }
    }
  }

  reply.raw.end();
});

// Pull progress endpoint on the coordinator
app.get("/model/pull/progress", async (_req, reply) => {
  const progress = coordinatorPullTracker.getProgress();
  return reply.send(progress ?? { status: "idle" });
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
  const coordinatorModel = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";
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

    // Inference service returned a non-2xx status — fall through to escalation resolver
  } catch {
    // Inference service unreachable — fall through to escalation resolver
  }

  // Fallback: escalation resolver (parent coordinator → cloud inference)
  try {
    const resolved = await escalationResolver.resolve(body);
    const storeEntry: EscalationResult & { request: EscalationRequest } = {
      ...resolved,
      request: body
    };
    escalationStore.set(taskId, storeEntry);
    return reply.send(resolved);
  } catch (resolveError) {
    escalationStore.set(taskId, { taskId, status: "failed", request: body });
    return reply.code(502).send({ taskId, status: "failed", error: String(resolveError) });
  }
});

app.get("/escalate/:taskId", async (req, reply) => {
  const params = z.object({ taskId: z.string() }).parse(req.params);
  const result = escalationStore.get(params.taskId);
  if (!result) return reply.code(404).send({ error: "escalation_not_found" });
  const { request: _req, ...rest } = result;
  return reply.send(rest);
});

/** Callback endpoint — the EscalationResolver posts resolved results here. */
app.post("/escalate/:taskId/result", async (req, reply) => {
  const params = z.object({ taskId: z.string() }).parse(req.params);
  const resultBody = z.object({
    taskId: z.string(),
    status: z.enum(["pending", "processing", "completed", "failed"]),
    improvedCode: z.string().optional(),
    explanation: z.string().optional(),
    resolvedByAgentId: z.string().optional(),
    resolvedByModel: z.string().optional()
  }).parse(req.body);

  const existing = escalationStore.get(params.taskId);
  if (!existing) return reply.code(404).send({ error: "escalation_not_found" });

  escalationStore.set(params.taskId, {
    ...resultBody,
    request: existing.request
  });
  return reply.send({ ok: true });
});

// #41: authenticated, double-signed, balance-checked, persistently deduped BLE settlement.
const bleSyncSchema = createBleSyncSchema();
const syncedBLETxIds = new Set<string>(); // non-PG mode only
const inMemoryBleTransfer = createInMemoryBleTransfer(creditEngine, syncedBLETxIds);

app.post("/credits/ble-sync", async (req, reply) => {
  // Unsigned callers fall through to the (configured) mesh-token check below.
  const verified = await verifyAgentRequest(req.headers as any, "/credits/ble-sync", req.ip, { allowUnsigned: true, rawBody: rawBodyOf(req) });
  if (!isBleSyncAuthorized(verified, MESH_AUTH_TOKEN !== "", hasMeshToken(req.headers as any))) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const parsed = bleSyncSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_ble_sync_body", detail: parsed.error.message });
  }
  const body = parsed.data;
  const { applied, skipped } = await applyBleSyncBatch(body.transactions, {
    getPublicKeyPem: (agentId) => agentCapabilities.get(agentId)?.publicKeyPem,
    rewardAccountForAgent,
    allowV1: bleSyncAllowV1(),
    transfer: (tx, requesterAccountId, providerAccountId) =>
      pgStore
        ? pgStore.applyBleTransfer({ txId: tx.txId, requesterAccountId, providerAccountId, credits: tx.credits })
        : inMemoryBleTransfer(tx, requesterAccountId, providerAccountId)
  });
  return reply.send({ applied, skipped, total: body.transactions.length });
});

// ── Debug: direct enqueue for E2E testing (no inference decomposition) ──
const debugEnqueueSchema = z.object({
  input: z.string().min(1).max(10_000),
  language: z.string().optional(),
  taskId: z.string().uuid().optional(),
});

// #40: debug routes are registered only outside production with ENABLE_DEBUG_ROUTES=1.
if (debugRoutesEnabled()) {
  app.post("/debug/enqueue", async (req, reply) => {
    if (!authorizeAdmin(req, reply)) return;
    const parsed = debugEnqueueSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_input", detail: parsed.error.message });
    const body = parsed.data;
    const taskId = body.taskId ?? randomUUID();
    const hasPeers = mesh.listPeers().length > 0;
    const subtask = queue.enqueueSubtask({
      taskId,
      kind: "single_step",
      language: (body.language as "python" | "javascript") ?? "python",
      input: body.input,
      timeoutMs: 30_000,
      snapshotRef: "debug",
      projectMeta: { projectId: "debug", resourceClass: "cpu" as any, priority: 50 }
    }, hasPeers ? { claimDelayMs: 3_000 } : undefined);
    // Gossip task_offer to peer coordinators
    const offerMsg = protocol.createMessage(
      "task_offer",
      identity.peerId,
      {
        subtaskId: subtask.id,
        taskId,
        kind: subtask.kind,
        language: subtask.language,
        input: subtask.input,
        timeoutMs: subtask.timeoutMs,
        snapshotRef: subtask.snapshotRef,
        projectMeta: subtask.projectMeta,
        originCoordinatorId: identity.peerId,
        originCoordinatorUrl: COORDINATOR_PUBLIC_URL,
      },
      coordinatorKeys.privateKeyPem,
      60_000
    );
    void mesh.broadcast(offerMsg);
    return reply.send({ taskId, subtaskId: subtask.id, queued: true });
  });
}

/** Initialize coordinator background tasks, intervals, and peer mesh.
 *  Call after the Fastify server is listening (either standalone or unified mode). */
export async function initCoordinator(): Promise<void> {
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
      const storedEpoch = await storeRef.latestRateEpoch();
      latestRateEpoch = storedEpoch ? normalizeRateEpoch(storedEpoch, rateOracleConfig.computeClasses) : null;
      syncOrderBookReference(latestRateEpoch);
      for (const t of await storeRef.listMarketTicks(7 * 24 * 60)) marketHistory.recordTick(t);
      for (const t of await storeRef.listMarketTrades(5_000)) marketHistory.recordTrade(t);
      for (const o of await storeRef.listMarketOrders()) marketOrders.set(`${o.accountId}:${o.side}`, o);
      hardwareVerifier.load(await storeRef.listHardwareVerifications());
      reservations.load(await storeRef.listReservations());
      treasuryPolicy = await storeRef.latestTreasuryPolicy();
      const pendingIntents = await storeRef.listPendingPaymentIntents(500);
      for (const intent of pendingIntents) {
        paymentIntents.set(intent.intentId, intent);
      }
      // #105: results held for verification before a restart are held again, not dropped.
      await restorePendingVerifications(storeRef).catch((error) => app.log.warn({ error: String(error) }, "result_verification_restore_failed"));
    };
    const startupDbInitTimeoutMs = 10_000;
    await Promise.race([
      initDbState(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("startup_db_init_timeout")), startupDbInitTimeoutMs)
      )
    ]).catch((error) => app.log.warn({ error }, "startup_db_init_skipped"));
  }

  {
      setInterval(() => {
        cleanupStaleTunnels();
      }, 15_000);
      // Hardware verification: expire unanswered challenges and missing witnesses, re-post changed asks.
      setInterval(() => {
        for (const agentId of hardwareVerifier.tick(Date.now())) repostAsk(agentId);
      }, 15_000);
      setInterval(async () => {
        try {
          const pending = pgStore ? await pgStore.listPendingPaymentIntents(500) : [...paymentIntents.values()];
          for (const intent of pending) {
            if (intent.status !== "created") continue;
            await reconcileIntent(intent);
          }
        } catch (error) {
          app.log.warn({ error }, "payment_reconcile_tick_failed");
        }
      }, 30_000);
      setInterval(() => {
        void runIssuanceTick().catch((error) => app.log.warn({ error }, "issuance_tick_failed"));
      }, ISSUANCE_RECALC_MS);
      // Rate oracle: recalibrate at startup when there is no fresh epoch, then on the daily timer.
      recordMarketTicks();
      setInterval(() => recordMarketTicks(), MARKET_TICK_MS);
      // Payouts: this host's uptime heartbeat, automatic Lightning-address payouts, fee-pool distribution.
      void selfInfraHeartbeat().catch((error) => app.log.warn({ error: String(error) }, "infra_heartbeat_failed"));
      setInterval(() => {
        void selfInfraHeartbeat().catch((error) => app.log.warn({ error: String(error) }, "infra_heartbeat_failed"));
      }, CC.HOST_HEARTBEAT_MS);
      if (ECONOMY_PAYMENTS_ENABLED && payoutPolicy.enabled) {
        setInterval(() => {
          void payoutService.runAutoPayouts().then((r) => { if (r.length) app.log.info({ results: r }, "auto_payouts"); }).catch((error) => app.log.warn({ error: String(error) }, "auto_payouts_failed"));
        }, CC.PAYOUT_AUTO_INTERVAL_MS);
      }
      setInterval(() => {
        void runFeePoolDistribution().catch((error) => app.log.warn({ error: String(error) }, "fee_pool_distribution_failed"));
      }, CC.FEE_POOL_DISTRIBUTION_MS);
      // Ledger vs Lightning node; a mismatch pauses payouts (payout-reconcile.ts).
      if (ECONOMY_PAYMENTS_ENABLED && payoutReconcileConfig.intervalMs > 0) {
        void payoutReconciler.run().catch((error) => app.log.warn({ error: String(error) }, "payout_reconcile_failed"));
        setInterval(() => {
          void payoutReconciler.run().catch((error) => app.log.warn({ error: String(error) }, "payout_reconcile_failed"));
        }, payoutReconcileConfig.intervalMs);
      }
      if (RATE_ORACLE_ENABLED) {
        if (isRateEpochStale(latestRateEpoch, rateOracleConfig)) {
          void recalibrateRateEpoch().catch((error) => app.log.warn({ error: String(error) }, "rate_recalibration_failed"));
        }
        setInterval(() => {
          void recalibrateRateEpoch().catch((error) => app.log.warn({ error: String(error) }, "rate_recalibration_failed"));
        }, RATE_RECALIBRATION_MS);
      }
      setInterval(() => {
        void maybeAnchorLatestFinalizedEpoch().catch((error) => app.log.warn({ error }, "anchor_tick_failed"));
      }, ANCHOR_INTERVAL_MS);
      setInterval(() => {
        void bootstrapPeerMesh();
      }, 45_000);
      // ── Peer Exchange: broadcast known peer table to all peers (BitTorrent-style) ──
      setInterval(() => {
        void (async () => {
          const peers = mesh.listPeers();
          if (peers.length === 0) return;
          const peerExchangePayload: PeerExchangePayload = {
            peers: peers.slice(0, 50).map(p => ({
              peerId: p.peerId,
              publicKeyPem: p.publicKeyPem,
              peerUrl: p.coordinatorUrl,
              networkMode: p.networkMode,
              role: "coordinator" as MeshPeerRole,
              lastSeenMs: Date.now(),
            })),
          };
          const msg = protocol.createMessage(
            "peer_exchange",
            identity.peerId,
            peerExchangePayload as unknown as Record<string, unknown>,
            coordinatorKeys.privateKeyPem,
            60_000,
          );
          await mesh.broadcast(msg);
        })().catch((error) => app.log.warn({ error }, "peer_exchange_broadcast_failed"));
      }, 30_000);
      setInterval(() => {
        void (async () => {
          const agents: AgentCapabilityInfo[] = [...agentCapabilities.entries()].map(
            ([agentId, cap]) => ({
              agentId,
              activeModel: cap.activeModel ?? cap.localModelCatalog[0] ?? "",
              activeModelParamSize: cap.activeModelParamSize ?? 0,
              currentLoad: 0,
            })
          );
          const summary = buildCapabilitySummary(identity.peerId, agents);
          // All mesh peers advertise chat capability — when local Ollama is down
          // the coordinator will failover to other mesh peers with available models
          summary.chatEnabled = true;
          const msg = protocol.createMessage(
            "capability_summary",
            identity.peerId,
            summary as unknown as Record<string, unknown>,
            coordinatorKeys.privateKeyPem,
            60_000
          );
          await mesh.broadcast(msg);
        })().catch((error) => app.log.warn({ error }, "capability_gossip_failed"));
      }, 60_000);
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
      // #50: reassign stalled replicas and release verifications whose replicas never reported.
      setInterval(() => {
        void runResultVerificationTick().catch((error) => app.log.warn({ error }, "result_verification_expire_failed"));
      }, 60_000);
      setInterval(() => {
        void refreshAnchorConfirmations().catch((error) => app.log.warn({ error }, "anchor_confirm_tick_failed"));
      }, ANCHOR_CONFIRM_POLL_MS);
      setInterval(() => {
        void reconcileAnchorRows().catch((error) => app.log.warn({ error }, "anchor_reconcile_tick_failed"));
      }, ANCHOR_RECONCILE_MS);
      // ── Security: nonce prune scheduler ──
      const pruneAdapter: PrunableStore = {
        async noncePrune() { await nonceStore.prune(); return 0; },
        async meshMessagePrune() { return 0; },
      };
    startPruneScheduler(pruneAdapter, 5 * 60_000);
    app.log.info("security: request signing verification, nonce replay detection, and rate limiting active");
  }
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
  // #103: reconcile before anchoring so a crash-left "broadcasting" row is resolved first.
  await reconcileAnchorRows().catch((error) => app.log.warn({ error }, "anchor_reconcile_startup_failed"));
  await maybeAnchorLatestFinalizedEpoch().catch(() => undefined);
  await maybeAnchorLatestStatsCheckpoint().catch(() => undefined);
}

/* ── Admin dashboard (token-gated) ── */
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN ?? "";

function authorizeAdmin(req: any, reply: any): boolean {
  if (!ADMIN_API_TOKEN) {
    reply.code(503).send({ error: "admin_dashboard_not_configured" });
    return false;
  }
  const headerToken = readHeaderValue(req.headers, "x-admin-token");
  if (!headerToken || !safeTokenEqual(headerToken, ADMIN_API_TOKEN)) {
    reply.code(401).send({ error: "invalid_admin_token" });
    return false;
  }
  return true;
}

// #40: every /admin/* route lives in this plugin behind authorizeAdmin (in addition to the
// per-route checks), so new admin routes can't forget it.
app.register(async (admin) => {
admin.addHook("onRequest", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return reply;
});

admin.get("/admin/dashboard", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  const status = queue.status();
  const agentList = [...agentCapabilities.entries()].map(([agentId, info]) => ({
    agentId,
    os: info.os,
    provider: info.localModelProvider,
    maxConcurrentTasks: info.maxConcurrentTasks,
    modelCatalog: info.localModelCatalog
  }));
  return reply.type("text/html").send(adminDashboardHtml(status, agentList));
});

admin.get("/admin/dashboard/api/overview", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  const status = queue.status();
  const agentList = [...agentCapabilities.entries()].map(([agentId, info]) => ({
    agentId,
    os: info.os,
    provider: info.localModelProvider,
    maxConcurrentTasks: info.maxConcurrentTasks,
    modelCatalog: info.localModelCatalog
  }));
  return reply.send({
    coordinator: { queued: status.queued, agents: status.agents, results: status.results },
    agents: agentList,
    uptimeSeconds: Math.floor(process.uptime()),
    memoryMB: Math.round(process.memoryUsage.rss() / 1_048_576),
    meshPeers: mesh.listPeers().length
  });
});

// Payout kill switch: halts withdrawals, auto payouts and fee-pool distribution (purchases keep working).
admin.get("/admin/payouts/pause", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  return { ...(await payoutPause.state()), envForced: payoutsPausedByEnv(), limits: payoutLimits };
});
admin.post("/admin/payouts/pause", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  const parsed = z.object({ paused: z.boolean(), reason: z.string().max(500).optional(), actor: z.string().max(128).optional() }).safeParse(req.body ?? {});
  if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
  const actor = `admin:${parsed.data.actor ?? "token"}@${req.ip}`;
  if (parsed.data.paused) return { ok: true, state: await payoutPause.pause(parsed.data.reason ?? "paused by operator", "admin", actor) };
  const resumed = await payoutPause.resume(actor, parsed.data.reason);
  if (!resumed.ok) return reply.code(409).send({ ok: false, code: resumed.code, state: resumed.state });
  return resumed;
});
admin.get("/admin/payouts/reconciliation", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  return { config: payoutReconcileConfig, webhookConfigured: Boolean(process.env.PAYOUT_ALERT_WEBHOOK_URL?.trim()), last: payoutReconciler.last() };
});
admin.post("/admin/payouts/reconciliation/run", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  return payoutReconciler.run();
});

admin.get("/admin/agents/:agentId/behavior", async (req, reply) => {
  if (!authorizeAdmin(req, reply)) return;
  const params = z.object({ agentId: z.string() }).parse(req.params);
  const stats = behaviorTracker.getStats(params.agentId);
  if (!stats) {
    return reply.code(404).send({ error: "agent_not_found", agentId: params.agentId });
  }
  const anomalies = anomalyDetector.evaluate(stats);
  const strikeCount = autoBlacklister.getStrikeCount(params.agentId);
  return reply.send({ agentId: params.agentId, stats, anomalies, strikeCount });
});
});

function adminDashboardHtml(status: { queued: number; agents: number; results: number }, agentList: Array<{ agentId: string; os?: string; provider?: string; maxConcurrentTasks?: number; modelCatalog?: string[] }>): string {
  const agentRows = agentList.map((a) =>
    `<tr><td>${esc(a.agentId)}</td><td>${esc(a.os ?? "-")}</td><td>${esc(a.provider ?? "-")}</td><td>${esc((a.modelCatalog ?? []).join(", ") || "-")}</td><td>${a.maxConcurrentTasks ?? 0}</td></tr>`
  ).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EdgeCoder Coordinator Admin</title>
<style>
  :root { --bg: #0d1117; --card: #161b22; --border: #30363d; --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff; --green: #3fb950; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  .container { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
  header { margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
  header h1 { font-size: 20px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .card h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); margin-bottom: 12px; }
  .stat { font-size: 28px; font-weight: 700; }
  .stat-label { font-size: 13px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; }
  #refresh-timer { font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>EdgeCoder Coordinator Admin</h1>
    <span id="refresh-timer">Auto-refresh: 10s</span>
  </header>
  <div class="grid">
    <div class="card"><h2>Connected Agents</h2><div class="stat" id="v-agents">${status.agents}</div></div>
    <div class="card"><h2>Queue Depth</h2><div class="stat" id="v-queued">${status.queued}</div></div>
    <div class="card"><h2>Results</h2><div class="stat" id="v-results">${status.results}</div></div>
    <div class="card"><h2>Uptime</h2><div class="stat" id="v-uptime">${Math.floor(process.uptime())}s</div></div>
    <div class="card"><h2>Memory</h2><div class="stat" id="v-mem">${Math.round(process.memoryUsage.rss() / 1_048_576)} MB</div></div>
    <div class="card"><h2>Mesh Peers</h2><div class="stat" id="v-peers">${mesh.listPeers().length}</div></div>
  </div>
  <div class="card" style="margin-bottom:24px;">
    <h2>Connected Agents</h2>
    <table>
      <thead><tr><th>Agent</th><th>OS</th><th>Provider</th><th>Models</th><th>Capacity</th></tr></thead>
      <tbody id="agent-body">${agentRows || "<tr><td colspan='5'>No agents connected.</td></tr>"}</tbody>
    </table>
  </div>
</div>
<script>
// #40 review: the admin token is sent only in the x-admin-token header, never in the URL.
const TOKEN_KEY = "edgecoder_admin_token";
let token = sessionStorage.getItem(TOKEN_KEY) || "";
if (!token) {
  token = window.prompt("Admin token") || "";
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
}
async function refresh() {
  try {
    const res = await fetch("/admin/dashboard/api/overview", { headers: { "x-admin-token": token } });
    if (res.status === 401) { sessionStorage.removeItem(TOKEN_KEY); return; }
    const d = await res.json();
    document.getElementById("v-agents").textContent = d.coordinator.agents;
    document.getElementById("v-queued").textContent = d.coordinator.queued;
    document.getElementById("v-results").textContent = d.coordinator.results;
    document.getElementById("v-uptime").textContent = d.uptimeSeconds + "s";
    document.getElementById("v-mem").textContent = d.memoryMB + " MB";
    document.getElementById("v-peers").textContent = d.meshPeers;
    const body = document.getElementById("agent-body");
    if (d.agents.length === 0) {
      body.innerHTML = "<tr><td colspan='5'>No agents connected.</td></tr>";
    } else {
      body.innerHTML = d.agents.map(function(a) {
        return "<tr><td>" + (a.agentId||"-") + "</td><td>" + (a.os||"-") + "</td><td>" + (a.provider||"-") + "</td><td>" + ((a.modelCatalog||[]).join(", ")||"-") + "</td><td>" + (a.maxConcurrentTasks||0) + "</td></tr>";
      }).join("");
    }
  } catch(e) { console.error("refresh failed", e); }
}
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    await app.listen({ port: 4301, host: LISTEN_HOST });
    await initCoordinator();
  })().catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

export { app as coordinatorServer };
