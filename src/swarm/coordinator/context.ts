// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Coordinator configuration, the swarm queue, the mesh, identity keys and the shared
 * in-memory maps that the rest of the coordinator reads.
 */
import { tokenSet, type TokenSet } from "../../common/token-rotation.js";
import { adminOriginPolicyFromEnv, type AdminOriginPolicy } from "../../common/admin-origin.js";
import { parseVerifyKeys } from "../../security/portal-action.js";
import { loadConfigOrExit } from "../../common/config.js";
import { coordinatorConfigSchema } from "../coordinator-config.js";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { resolve } from "node:path";
import { homedir } from "node:os";
import {
  extractClientIp,
  clientIpTrustFromEnv,
  isLoopbackSocket,
  socketRemoteAddress,
  untrustedLocalProxy,
  loopbackSelfRegistrationAllowed,
  PreAuthFailureCounter
} from "../coordinator-utils.js";
import { hasSelfAgentProof } from "../self-agent-secret.js";
import { SwarmQueue, leaseConfigFromEnv } from "../queue.js";
import { RemoteGrantBook } from "../remote-grants.js";
import type { NetworkMode, Subtask, SubtaskResult } from "../../common/types.js";
import { createPeerIdentity, createPeerKeys } from "../../mesh/peer.js";
import {
  admitPeer,
  allowlistEnforced,
  parsePeerAllowlist,
  parsePeerUrlPins,
  assertUrlPinsForProduction,
  type PeerUrlPins,
  ReplayCache,
  peerKeyTrust,
  type PeerAllowlist,
  type PeerKeyTrust
} from "../../mesh/peer-trust.js";
import { requireAgentSignedForwards, type AgentResultEnvelope } from "../../mesh/forwarded-agent-envelope.js";
import { MeshProtocol } from "../../mesh/protocol.js";
import { GossipMesh } from "../../mesh/gossip.js";
import { meshTokenAllowedFor, meshTokenForUrl, parseMeshTokenScope, type MeshTokenScope } from "../../mesh/mesh-token-scope.js";
import { pgStore } from "../../db/store.js";
import type { ComputeClassId } from "../../economy/compute-classes.js";
import { MemoryUsageStore, type UsageRecord } from "../../economy/usage.js";
import { ReservationBook } from "../../economy/reservations.js";
import { coordinatorRequiredProdEnv, isProduction, requireCoordinatorPortalInbound, requireProdEnv } from "../../common/env-guard.js";
import { portalRequestAudiences, portalVerifyKeySource, type PortalInboundSignatureConfig, type PortalOutboundSigning } from "./portal-credentials.js";
import { economyPaymentsEnabled } from "../../economy/lightning.js";
import { reconcileConfigFromEnv, requiredConfirmationsFromEnv } from "../../economy/anchoring.js";
import { assertPaymentWebhookSecret } from "../../economy/payment-settlement.js";
import { FallbackNonceStore, InMemoryNonceStore, type NonceStore } from "../../security/nonce-verifier.js";
import { AgentRateLimiter } from "../../security/agent-rate-limiter.js";
import { SecurityEventLogger } from "../../audit/security-events.js";
import { PullTracker } from "../../model/pull-tracker.js";
import { createRegistryMirror } from "../../discovery/registry-mirror.js";
import { registryPublicKeysFromEnv } from "../../discovery/registry.js";
import { RegistryTrust } from "../../discovery/registry-trust.js";
import { app } from "./app.js";

// #15: numeric, boolean, enum and URL settings validated once at startup (see coordinator-config.ts).
export const CC = loadConfigOrExit("coordinator", coordinatorConfigSchema);
export const queue = new SwarmQueue(pgStore, leaseConfigFromEnv());

export const protocol = new MeshProtocol();
export const mesh = new GossipMesh();
// #118 review: one admission rule for every way into the peer table.
mesh.setAdmission((peer, existing, opts) =>
  admitPeer({
    allowlist: MESH_PEER_ALLOWLIST,
    trusted: trustedPeerKey,
    pins: peerUrlPins(),
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
/** Peer URLs that receive MESH_AUTH_TOKEN (null: every peer). Others get signed requests only. */
export const MESH_TOKEN_SCOPE: MeshTokenScope = parseMeshTokenScope(CC.MESH_TOKEN_PEER_URLS);
/** The mesh token for one outbound request to a peer at `url`, or "" when it must not go there. */
export function meshTokenFor(url: string): string {
  return meshTokenForUrl(CC.MESH_AUTH_TOKEN ?? "", MESH_TOKEN_SCOPE, url) ?? "";
}
if (CC.MESH_AUTH_TOKEN) {
  mesh.setMeshToken(CC.MESH_AUTH_TOKEN);
  mesh.setMeshTokenScope((url) => meshTokenAllowedFor(MESH_TOKEN_SCOPE, url));
}
export const peerScore = new Map<string, number>();
export const peerMessageWindow = new Map<string, { windowMs: number; count: number }>();
export const MESH_RATE_LIMIT_PER_10S = 50;

/** Tracks origin coordinator for tasks received via mesh gossip, so results can be forwarded back. */
export const taskOriginMap = new Map<string, { coordinatorId: string; coordinatorUrl: string }>();
/**
 * Most (msat) an agent here may earn for a subtask a peer coordinator offered: the worst case a
 * coordinator sets aside for one subtask (what the origin charges its requester for a subtask run
 * elsewhere). The requester is charged there, so this is the payer's limit.
 */
export const peerOfferBudgetMsat = new Map<string, number>();
export const PEER_OFFER_BUDGET_MAX_ENTRIES = 20_000;
/** Origin side: offered subtasks granted to one peer coordinator (src/swarm/remote-grants.ts). */
export const remoteGrants = new RemoteGrantBook();
/** Peer side: offered subtasks the origin granted to this coordinator, and until when the grant holds (local clock). */
export const peerGrants = new Map<string, { originId: string; deadlineMs: number }>();
export const LEASE_CONFIG = leaseConfigFromEnv();
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
  /**
   * Paid from the buyer's own wallet (PAYMENTS_NWC): nothing was debited at submit, so nothing is
   * refunded; each result's cost is added to the (buyer, host) tally instead of the cSats ledger.
   */
  nwc?: boolean;
  /** Token counts an inference call was billed on (bounded), returned to the requester with the result. */
  promptTokens?: number;
  outputTokens?: number;
  /** Of promptTokens, those a cloud model's provider served from its cache (priced at its cached-input rate). */
  cachedPromptTokens?: number;
  /** The agent's model-load time for the call (Ollama load_duration), left out of the power floor. */
  loadMs?: number;
  /** Where a model call ran, for the requester (served-by.ts): the agent, and how long each part took. */
  servedAgentId?: string;
  /** The model that agent ran (the subtask's model when it answered: Auto re-placement can change it after submit). */
  servedModel?: string;
  submittedAtMs?: number;
  pickupMs?: number;
  promptMs?: number;
  genMs?: number;
  /** Why the reply ended: "length" when it was cut at the call's max_tokens (the requester's finish_reason). */
  finishReason?: "stop" | "length";
  /**
   * A model call whose cost was past its reserve: what was taken from the buyer's balance at settle
   * time for it (also counted in reservedMsat and costMsat), and what the balance could not cover,
   * left unpaid to the host (results.ts accrueResultCredits).
   */
  overflowMsat?: number;
  unpaidMsat?: number;
  /**
   * A model call billed in cSats at submit: the most it may cost in all, past its reserve, from the
   * buyer's balance at settle (the buyer's maxCSats, else Number.MAX_SAFE_INTEGER). Unset (code jobs,
   * entries restored after a restart): settled at the reserve, never past it.
   */
  overflowCapMsat?: number;
}
export const taskBilling = new Map<string, TaskBilling>();
/**
 * Billing entries of tasks that settled, kept a while for the requester's last reads. A model call's
 * result settles (and drops) its billing entry as soon as it lands; a requester whose next
 * /inference/stream poll arrived just after that was refused as not_requester although the call had
 * finished (seen from the terminal agent, 2026-11-15). The owner, cost and token counts stay here
 * for SETTLED_KEEP_MS so that read still gets the reply's end.
 */
export const settledBilling = new Map<string, TaskBilling & { settledAtMs: number }>();
export const SETTLED_KEEP_MS = 10 * 60_000;
export function rememberSettled(taskId: string, b: TaskBilling, nowMs = Date.now()): void {
  for (const [id, e] of settledBilling) {
    if (nowMs - e.settledAtMs <= SETTLED_KEEP_MS && settledBilling.size < 20_000) break;
    settledBilling.delete(id);
  }
  settledBilling.set(taskId, { ...b, settledAtMs: nowMs });
}
/** Usage records being filled in (keyed by task) until the task settles; then saved. */
export const usagePending = new Map<string, UsageRecord>();
export const memoryUsage = new MemoryUsageStore();
/** Told of every usage record as it is saved (best-fit routing's decision log reads the cost). */
export const usageListeners: Array<(r: UsageRecord) => void> = [];
export async function saveUsage(r: UsageRecord): Promise<void> {
  for (const l of usageListeners) {
    try {
      l(r);
    } catch {
      // A listener never stops the save.
    }
  }
  if (pgStore) await pgStore.insertUsage(r).catch((err) => app.log.warn({ err, id: r.id }, "usage_save_failed"));
  else memoryUsage.add(r);
}
/** A result arrived: which agent and class ran it, for how long (summed over a task's subtasks). */
export function noteUsageRun(taskId: string, agentId: string, ok: boolean, durationMs: number, computeClass?: string): void {
  const u = usagePending.get(taskId);
  if (!u) return;
  u.agentId = agentId;
  u.ok = ok;
  u.durationMs += Math.max(0, durationMs);
  if (computeClass) u.computeClass = computeClass;
}
/** Reserved-capacity leases: an account holds one agent for a set time, paid up front. */
export const reservations = new ReservationBook();

/** Longest a subtask may run (the envelope default): the time the worst case is set aside for. */
export const SUBTASK_RESERVE_TIMEOUT_MS = 60_000;

/** BTC price used for class references until the rate oracle has published. */
export const FALLBACK_BTC_USD = 100_000;

/** Market price agreed at claim time per subtask (msat per credit on the agent's class) and the tier weight the credits mint at. */
export const claimedTradePrice = new Map<string, { msatPerCredit: number; computeClass: ComputeClassId; creditsPerSecond: number }>();
export const MESH_AUTH_TOKEN = CC.MESH_AUTH_TOKEN ?? "";
// #52: coordinators trusted by key, not just by holding MESH_AUTH_TOKEN. Required in production.
export const MESH_PEER_ALLOWLIST: PeerAllowlist = (() => {
  try {
    const parsed = parsePeerAllowlist(CC.MESH_PEER_ALLOWLIST);
    assertUrlPinsForProduction(CC.MESH_PEER_ALLOWLIST, isProduction());
    return parsed;
  } catch (error) {
    // Fail closed, but say why before the process exits.
    app.log.fatal({ error: (error as Error).message }, "invalid MESH_PEER_ALLOWLIST");
    throw error;
  }
})();
// #118 review: optional `@url` on each allowlist entry pins that peer's endpoint.
const MESH_PEER_URL_PINS: PeerUrlPins = parsePeerUrlPins(CC.MESH_PEER_ALLOWLIST);
export const PEER_ALLOWLIST_ENFORCED = allowlistEnforced(MESH_PEER_ALLOWLIST, isProduction());
// The portal's signed coordinator registry, mirrored so the one platform URL serves it too
// (src/discovery/registry-mirror.ts). REGISTRY_UPSTREAM_URL overrides the source.
export const registryMirror = createRegistryMirror({
  upstreamUrl: CC.REGISTRY_UPSTREAM_URL || `${(CC.PORTAL_SERVICE_URL || CC.PORTAL_PUBLIC_URL).replace(/\/+$/, "")}/network/registry`
});
/**
 * The verified registry, for peer trust (src/discovery/registry-trust.ts): pinned keys from
 * DEFAULT_REGISTRY_PUBLIC_KEYS plus EDGECODER_REGISTRY_PUBLIC_KEYS (none pinned: adds nothing).
 * Refreshed on its signed TTL; a peer that loses registry trust (suspended) and is not in the
 * allowlist is dropped from the peer table.
 */
export const registryTrust = new RegistryTrust({
  load: () => registryMirror.get(),
  publicKeys: registryPublicKeysFromEnv(process.env),
  onRevoked: (peerIds) => {
    for (const peerId of peerIds) {
      if (MESH_PEER_ALLOWLIST.has(peerId)) continue;
      mesh.removePeer(peerId);
      app.log.warn({ peerId }, "registry_peer_trust_removed");
    }
  },
  log: (msg, extra) => app.log.warn(extra ?? {}, msg)
});
if (registryTrust.enabled && !process.env.VITEST) registryTrust.start();
/**
 * Which coordinator keys this coordinator trusts for signed peer requests, registration and the
 * peer table: the static allowlist, or the signed registry's members on probation or active.
 */
export const trustedPeerKey: PeerKeyTrust = peerKeyTrust(MESH_PEER_ALLOWLIST, registryTrust.trusts);
/** Whether a peer is trusted at all by key (allowlist entries, or a pinned registry key). */
export const PEER_KEY_TRUST_CONFIGURED = (): boolean => MESH_PEER_ALLOWLIST.size > 0 || registryTrust.enabled;
/**
 * Whether a peer coordinator may take billed work from here (subtask grants). Registry members
 * that are not in the allowlist may peer and show in the world view, but get no billed calls
 * until outside billing exists. Without an allowlist (development) every peer may.
 */
export function peerMayTakeBilledWork(peerId: string): boolean {
  return MESH_PEER_ALLOWLIST.size === 0 || MESH_PEER_ALLOWLIST.has(peerId);
}
/** Endpoint pins: the allowlist's `@url` wins over the registry's verified URL. */
export function peerUrlPins(): PeerUrlPins {
  return new Map([...registryTrust.urlPins(), ...MESH_PEER_URL_PINS]);
}
/** false: a peer route also admits a request signed by a trusted peer key without the mesh token. */
export const MESH_TOKEN_REQUIRED_FOR_PEERS = CC.MESH_TOKEN_REQUIRED_FOR_PEERS;
/** #118 review: forwarded-result replay protection and the subtasks we actually offered to peers. */
export const forwardReplayCache = new ReplayCache();
const OFFERED_SUBTASK_TTL_MS = 24 * 60 * 60 * 1000;
export const offeredToPeers = new Map<string, number>();
/** #122: forwarded results with an output must carry the agent's own signed request (prod default). */
export const REQUIRE_AGENT_SIGNED_FORWARDS = requireAgentSignedForwards(process.env, isProduction());
export const PORTAL_SERVICE_URL = CC.PORTAL_SERVICE_URL ?? "";
/** Which forwarded-IP headers to believe (COORDINATOR_TRUST_PROXY, Fly-Client-IP on Fly). Display/geo only. */
export const CLIENT_IP_TRUST = clientIpTrustFromEnv(process.env);
/** COORDINATOR_LOOPBACK_SELF_REGISTRATION: production opt-in for a separately run agent on this machine. */
export const LOOPBACK_SELF_REGISTRATION_OPT_IN = CC.COORDINATOR_LOOPBACK_SELF_REGISTRATION;
let warnedUntrustedLocalProxy = false;
/**
 * The request's network origin. loopback: the socket is this machine and the request carries no
 * proxy headers (a same-host proxy relays every internet caller from 127.0.0.1). Headers otherwise
 * only feed the display IP. selfRegistration: loopback /register may skip the portal (see
 * loopbackSelfRegistrationAllowed).
 */
export function requestOrigin(req: unknown): { clientIp?: string; loopback: boolean; selfRegistration: boolean } {
  const r = req as { headers?: Record<string, unknown>; socket?: { remoteAddress?: string }; raw?: { socket?: { remoteAddress?: string } } };
  const socketIp = socketRemoteAddress(r);
  const headers = r.headers ?? {};
  if (!warnedUntrustedLocalProxy && untrustedLocalProxy(socketIp, headers, CLIENT_IP_TRUST)) {
    warnedUntrustedLocalProxy = true;
    app.log.warn(
      { socketIp },
      "coordinator is behind a reverse proxy on this machine but COORDINATOR_TRUST_PROXY is unset: relayed requests are treated as remote (never loopback) and logged with the proxy's address. Set COORDINATOR_TRUST_PROXY to the proxy's address (e.g. 127.0.0.1) to log client addresses."
    );
  }
  const loopback = isLoopbackSocket(socketIp, CLIENT_IP_TRUST, headers);
  return {
    clientIp: extractClientIp(headers, socketIp, CLIENT_IP_TRUST),
    loopback,
    selfRegistration: loopbackSelfRegistrationAllowed({
      loopback,
      selfAgentProof: loopback && hasSelfAgentProof(headers),
      production: isProduction(),
      optIn: LOOPBACK_SELF_REGISTRATION_OPT_IN
    })
  };
}
export const PORTAL_SERVICE_TOKEN = CC.PORTAL_SERVICE_TOKEN ?? "";
// Rotation (docs/security/rotation.md): each verifier accepts the current value and, until
// TOKEN_PREVIOUS_UNTIL, the previous one. Senders always send the current value.
export const MESH_AUTH_TOKENS: TokenSet = tokenSet(CC.MESH_AUTH_TOKEN, CC.MESH_AUTH_TOKEN_PREVIOUS, CC.TOKEN_PREVIOUS_UNTIL);
export const PORTAL_SERVICE_TOKENS: TokenSet = tokenSet(CC.PORTAL_SERVICE_TOKEN, CC.PORTAL_SERVICE_TOKEN_PREVIOUS, CC.TOKEN_PREVIOUS_UNTIL);
export const ADMIN_API_TOKENS: TokenSet = tokenSet(CC.ADMIN_API_TOKEN, CC.ADMIN_API_TOKEN_PREVIOUS, CC.TOKEN_PREVIOUS_UNTIL);
/** Socket origins allowed to use admin-token routes (src/common/admin-origin.ts). */
export const ADMIN_ORIGIN_POLICY: AdminOriginPolicy = adminOriginPolicyFromEnv(process.env);
/**
 * Portal action assertions and portal-signed calls: the portal's public keys. PORTAL_ACTION_VERIFY_KEYS
 * when set; otherwise the keys published in the verified signed registry (current and previous).
 */
export const portalActionKeys = portalVerifyKeySource(parseVerifyKeys(CC.PORTAL_ACTION_VERIFY_KEYS), () => registryTrust.portalActionKeys());
/** true: withdraw / payout destination routes refuse the service token without a portal assertion. */
export const REQUIRE_PORTAL_ACTION_SIGNATURE = CC.REQUIRE_PORTAL_ACTION_SIGNATURE;
/**
 * Inbound portal auth (coordinator/portal-credentials.ts): requests the portal signed for this
 * coordinator, checked with PORTAL_ACTION_VERIFY_KEYS against this coordinator's own origins.
 */
export const PORTAL_INBOUND_SIGNATURES: PortalInboundSignatureConfig = {
  get keys() {
    return portalActionKeys();
  },
  audiences: portalRequestAudiences(CC.COORDINATOR_PUBLIC_URL, CC.PORTAL_REQUEST_AUDIENCES, isProduction())
};
/** Migration flag (default true): the portal's PORTAL_SERVICE_TOKEN still counts as the portal inbound. */
export const PORTAL_SERVICE_TOKEN_INBOUND = CC.PORTAL_SERVICE_TOKEN_INBOUND;
/** What signs one outbound call to the portal: this coordinator's own identity key. */
export function portalOutboundSigning(method: string, url: string, body?: string | null): PortalOutboundSigning {
  return { privateKeyPem: coordinatorKeys.privateKeyPem, publicKeyPem: identity.publicKeyPem, method, url, body };
}
// What this coordinator presents to the portal's read/validate /internal routes. Defaults to
// PORTAL_SERVICE_TOKEN; once PORTAL_COORDINATOR_TOKEN is set here and on the portal, coordinators
// no longer need the portal's own service token for those calls.
export const PORTAL_OUTBOUND_TOKEN = CC.PORTAL_COORDINATOR_TOKEN || PORTAL_SERVICE_TOKEN;
/** Outbound only: never accepted inbound as the portal (src/swarm/coordinator/portal-credentials.ts). */
export const PORTAL_COORDINATOR_TOKEN = CC.PORTAL_COORDINATOR_TOKEN ?? "";
export const COORDINATOR_FEE_BPS = CC.COORDINATOR_FEE_BPS;
export const COORDINATOR_FEE_ACCOUNT = CC.COORDINATOR_FEE_ACCOUNT;
export const BITCOIN_NETWORK = CC.BITCOIN_NETWORK;
export const ROBOT_QUEUE_ENABLED = CC.ROBOT_QUEUE_ENABLED;
export const ROBOT_COORDINATOR_FEE_BPS = CC.ROBOT_COORDINATOR_FEE_BPS;
export const coordinatorPullTracker = new PullTracker();
export const ROBOT_SWEEP_INTERVAL_MS = CC.ROBOT_SWEEP_INTERVAL_MS;
export const ROBOT_MIN_SWEEP_SATS = CC.ROBOT_MIN_SWEEP_SATS;
export const ROBOT_TASK_DEFAULT_TIMEOUT_MS = CC.ROBOT_TASK_DEFAULT_TIMEOUT_MS;
export const ROBOT_AUTO_SETTLE_DELAY_MS = CC.ROBOT_AUTO_SETTLE_DELAY_MS;
export const APPROVED_COORDINATOR_IDS = new Set(
  (CC.APPROVED_COORDINATOR_IDS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
);
export const PAYMENT_INTENT_TTL_MS = CC.PAYMENT_INTENT_TTL_MS;
export const CONTRIBUTION_BURST_CREDITS = CC.CONTRIBUTION_BURST_CREDITS;
export const MIN_CONTRIBUTION_RATIO = CC.MIN_CONTRIBUTION_RATIO;
export const ISSUANCE_WINDOW_MS = CC.ISSUANCE_WINDOW_MS;
export const ISSUANCE_RECALC_MS = CC.ISSUANCE_RECALC_MS;
export const ISSUANCE_BASE_DAILY_POOL_TOKENS = CC.ISSUANCE_BASE_DAILY_POOL_TOKENS;
export const ISSUANCE_MIN_DAILY_POOL_TOKENS = CC.ISSUANCE_MIN_DAILY_POOL_TOKENS;
export const ISSUANCE_MAX_DAILY_POOL_TOKENS = CC.ISSUANCE_MAX_DAILY_POOL_TOKENS;
export const ISSUANCE_LOAD_CURVE_SLOPE = CC.ISSUANCE_LOAD_CURVE_SLOPE;
export const ISSUANCE_SMOOTHING_ALPHA = CC.ISSUANCE_SMOOTHING_ALPHA;
export const ISSUANCE_COORDINATOR_SHARE = CC.ISSUANCE_COORDINATOR_SHARE;
export const ISSUANCE_RESERVE_SHARE = CC.ISSUANCE_RESERVE_SHARE;
export const ANCHOR_INTERVAL_MS = CC.ANCHOR_INTERVAL_MS;
export const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET ?? "";
// #5: fail fast in production instead of silently running with auth disabled.
// LIGHTNING_PROVIDER is only required while payments are enabled (see #43 ECONOMY_PAYMENTS_ENABLED).
// #55: DATABASE_URL too, so replay/idempotency keys are never held only in memory in production.
requireProdEnv("coordinator", coordinatorRequiredProdEnv(economyPaymentsEnabled()));
// The portal is recognised by its signature (PORTAL_ACTION_VERIFY_KEYS, or the keys the pinned
// signed registry publishes) or, on the seeds during the migration, its service token.
requireCoordinatorPortalInbound(process.env, registryTrust.enabled);
export const IS_PROD = isProduction();
// #42: production must verify webhook HMACs.
assertPaymentWebhookSecret();
export const IOS_BATTERY_PULL_MIN_INTERVAL_MS = CC.IOS_BATTERY_PULL_MIN_INTERVAL_MS;
export const IOS_BATTERY_TASK_STOP_LEVEL_PCT = CC.IOS_BATTERY_TASK_STOP_LEVEL_PCT;
const CONTROL_PLANE_URL = CC.CONTROL_PLANE_URL ?? "";
export const COORDINATOR_PUBLIC_URL = CC.COORDINATOR_PUBLIC_URL;
export const COORDINATOR_DISCOVERY_URL =
  process.env.COORDINATOR_DISCOVERY_URL ??
  (CONTROL_PLANE_URL ? `${CONTROL_PLANE_URL.replace(/\/$/, "")}/network/coordinators` : "");
export const COORDINATOR_BOOTSTRAP_URLS = (CC.COORDINATOR_BOOTSTRAP_URLS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
export const COORDINATOR_REGISTRATION_TOKEN = CC.COORDINATOR_REGISTRATION_TOKEN ?? "";
export const COORDINATOR_PEER_CACHE_FILE = resolve(
  CC.COORDINATOR_PEER_CACHE_FILE ?? `${homedir()}/.edgecoder/coordinator-peer-cache.json`
);
export const STATS_LEDGER_SYNC_INTERVAL_MS = CC.STATS_LEDGER_SYNC_INTERVAL_MS;
export const STATS_ANCHOR_INTERVAL_MS = CC.STATS_ANCHOR_INTERVAL_MS;
export const STATS_ANCHOR_MIN_CONFIRMATIONS = CC.STATS_ANCHOR_MIN_CONFIRMATIONS;
// #46: depth at which an anchor counts as "anchored", and how often pending anchors are polled.
export const ANCHOR_REQUIRED_CONFIRMATIONS = requiredConfirmationsFromEnv();
/** #103: reconcile in-flight / stuck anchors on startup and on this interval. */
export const ANCHOR_RECONCILE_MS = Math.max(60_000, CC.ANCHOR_RECONCILE_MS || 900_000);
export const ANCHOR_RECONCILE_CONFIG = reconcileConfigFromEnv();
export const ANCHOR_CONFIRM_POLL_MS = Math.max(30_000, CC.ANCHOR_CONFIRM_POLL_MS || 600_000);
const AGENT_RATE_LIMIT_MAX = CC.AGENT_RATE_LIMIT_MAX;
const AGENT_RATE_LIMIT_WINDOW_MS = CC.AGENT_RATE_LIMIT_WINDOW_MS;
export const SECURITY_NONCE_TTL_MS = CC.SECURITY_NONCE_TTL_MS;
export const SECURITY_MAX_SKEW_MS = CC.SECURITY_MAX_SKEW_MS;
export const agentRateLimiter = new AgentRateLimiter({ maxRequests: AGENT_RATE_LIMIT_MAX, windowMs: AGENT_RATE_LIMIT_WINDOW_MS, perSlot: CC.AGENT_RATE_LIMIT_PER_SLOT });
/** /result and lease-only heartbeats: counted apart from pulls, so pull traffic cannot starve a claim's lease or its result. */
export const agentLeaseRateLimiter = new AgentRateLimiter({ maxRequests: CC.AGENT_LEASE_RATE_LIMIT_MAX, windowMs: AGENT_RATE_LIMIT_WINDOW_MS, perSlot: CC.AGENT_LEASE_RATE_LIMIT_PER_SLOT });
/** /pull and non-lease heartbeats: counted apart from the agent's other signed requests (agent-mesh pings, registration), so those cannot refuse a pull (D6). */
export const agentPullRateLimiter = new AgentRateLimiter({ maxRequests: CC.AGENT_PULL_RATE_LIMIT_MAX, windowMs: AGENT_RATE_LIMIT_WINDOW_MS, perSlot: CC.AGENT_PULL_RATE_LIMIT_PER_SLOT });
/** /inference/chunks only: streamed reply pieces, counted apart from the agent's other requests. */
export const agentChunkRateLimiter = new AgentRateLimiter({ maxRequests: CC.AGENT_CHUNK_RATE_LIMIT_MAX, windowMs: AGENT_RATE_LIMIT_WINDOW_MS, perSlot: CC.AGENT_CHUNK_RATE_LIMIT_PER_SLOT });
/** Signed requests that failed before the signer was proven, per client address. */
export const preAuthFailures = new PreAuthFailureCounter(CC.PREAUTH_FAILURE_MAX_PER_IP, AGENT_RATE_LIMIT_WINDOW_MS);
// Replay protection: Postgres when configured, so nonces survive restarts and are shared by every
// coordinator on the database (a replay to the other seed is caught); in memory otherwise.
export const nonceStore: NonceStore = pgStore
  ? new FallbackNonceStore(pgStore.nonceStore(), (error) => app.log.warn({ error: String(error) }, "nonce_store_degraded_to_memory"))
  : new InMemoryNonceStore();
export const securityLog = new SecurityEventLogger((event) => {
  const level = event.level === "CRITICAL" || event.level === "HIGH" ? "warn" : "info";
  app.log[level]({ securityEvent: event }, `security:${event.event}`);
});

function loadCoordinatorKeys() {
  // Derive a unique peerId from COORDINATOR_PUBLIC_URL so each coordinator
  // instance has a distinct identity in the mesh (avoids peerId collision
  // that prevents mutual peering).
  const explicitPeerId = CC.COORDINATOR_PEER_ID;
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

export const coordinatorKeys = loadCoordinatorKeys();
export const networkMode: NetworkMode = CC.NETWORK_MODE;
export const PROVIDER = CC.LOCAL_MODEL_PROVIDER;
export const OLLAMA_MODEL = CC.OLLAMA_MODEL;
export const OLLAMA_HOST = CC.OLLAMA_HOST;
export const OLLAMA_AUTO_INSTALL = CC.OLLAMA_AUTO_INSTALL;
export const INFERENCE_URL = CC.INFERENCE_URL;
export const INFERENCE_AUTH_TOKEN = CC.INFERENCE_AUTH_TOKEN ?? "";
export const identity = createPeerIdentity(coordinatorKeys, COORDINATOR_PUBLIC_URL, networkMode);

// ── #50: result verification (redundant execution) ──
export interface ResultMeta {
  /** The result as reported; published (with the verified output) only once verification settles. */
  report: SubtaskResult;
  taskId: string;
  durationMs: number;
  reportedDurationMs: number;
  subtask: Subtask;
  /** #122: the agent's signed request, forwarded to the origin coordinator with the result. */
  agentEnvelope?: AgentResultEnvelope;
  /** A failed result paid anyway: a program error the agent credibly ran (src/swarm/result-outcome.ts). */
  payableFailure?: boolean;
}
