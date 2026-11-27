// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { alertingEnv } from "../alerting/config.js";
import { envBool, envEnum, envFlag, envFlagWord, envInt, envNumber, envPort, envUrl } from "../common/config.js";
import {
  adminOriginEnv,
  rotationEnv,
  anchoringEnv,
  announceEnv,
  bitcoindEnv,
  bleSyncEnv,
  cloudModelsEnv,
  computeClassEnv,
  discoveryEnv,
  escalationEnv,
  hardwareVerificationEnv,
  leaseEnv,
  postgresPoolEnv,
  bestFitEnv,
  reservesEnv,
  lightningEnv,
  modelEnv,
  observabilityEnv,
  onchainEnv,
  payoutEnv,
  priceEpochEnv,
  rateOracleEnv,
  releaseEnv,
  sandboxEnv,
  serviceUrlsEnv,
  trustEnv,
  verificationEnv
} from "../config/shared.js";
import { parseRestrictedModels } from "./restricted-models.js";
import { parseVerifyKeys } from "../security/portal-action.js";

/*
 * #15: coordinator (port 4301) configuration. Every numeric, boolean, enum and URL setting the
 * coordinator reads at module load is validated here, so "abc" for an interval or "maybe" for a
 * flag fails startup with the variable named instead of becoming NaN or false.
 * Defaults are unchanged from the previous inline reads. The groups from src/config/shared.ts
 * cover the settings that library helpers read (payouts, anchoring, verification, discovery, ...).
 * Documented in site-docs/reference/environment-variables.md.
 */
const str = () => z.string().optional();

export const coordinatorConfigSchema = z.object({
  ...alertingEnv,
  ...observabilityEnv,
  ...serviceUrlsEnv,
  ...modelEnv,
  ...sandboxEnv,
  ...releaseEnv,
  ...discoveryEnv,
  ...announceEnv,
  ...computeClassEnv,
  ...rateOracleEnv,
  ...priceEpochEnv,
  ...lightningEnv,
  ...payoutEnv,
  ...reservesEnv,
  ...onchainEnv,
  ...bitcoindEnv,
  ...anchoringEnv,
  ...verificationEnv,
  ...hardwareVerificationEnv,
  ...leaseEnv,
  ...bestFitEnv,
  ...escalationEnv,
  ...bleSyncEnv,
  ...cloudModelsEnv,
  /**
   * Cloud hosts (docs/cloud-host.md): margin over the provider's USD price for cloud-model calls
   * (src/economy/cloud-pricing.ts), percent. Never below what keeps the host's share after
   * NETWORK_FEE_BPS at the provider's cost (about 5.3 % at a 5 % fee).
   */
  CLOUD_MARGIN_PCT: envNumber(30, { min: 0, max: 1000 }),
  /**
   * Owner emails whose agents may register as cloud hosts (the `cloud` class) and serve cloud models.
   * Comma-separated; empty = none (a cloud-class registration is refused, cloud ids are dropped).
   */
  CLOUD_HOST_OWNER_EMAILS: str(),
  EDGECODER_RESPONSE_SIGNING: trustEnv.EDGECODER_RESPONSE_SIGNING,
  DATABASE_URL: str(),
  ...postgresPoolEnv,
  /**
   * Task privacy: agents without an envelope key (X25519) may not claim subtasks that carry user
   * data. Off by default so older agents and the iOS app keep working (src/swarm/envelope-policy.ts).
   */
  ENVELOPE_REQUIRED: envFlag({ on: ["1", "true"], ci: true }),
  /** 32 bytes (base64 or hex) encrypting queue payloads and results at rest; unset derives one from COORDINATOR_PRIVATE_KEY_PEM. */
  QUEUE_DATA_KEY: str(),
  /** Days a completed subtask's payload and output stay in Postgres; 0 keeps them. */
  QUEUE_RETENTION_DAYS: envNumber(30, { min: 0 }),
  // Days the admin Network page's 15 s samples stay in Postgres (src/swarm/network-history.ts).
  NETWORK_HISTORY_DAYS: envNumber(7, { min: 1, max: 90 }),
  // Tokens: required in production by requireProdEnv() in coordinator/context.ts (#5).
  MESH_AUTH_TOKEN: str(),
  ADMIN_API_TOKEN: str(),
  INFERENCE_AUTH_TOKEN: str(),
  PORTAL_SERVICE_TOKEN: str(),
  PORTAL_COORDINATOR_TOKEN: str(),
  COORDINATOR_REGISTRATION_TOKEN: str(),
  // Rotation (src/common/token-rotation.ts, docs/security/rotation.md): the previous value of a
  // token, accepted next to the current one until TOKEN_PREVIOUS_UNTIL (at most 7 days ahead).
  ADMIN_API_TOKEN_PREVIOUS: str(),
  MESH_AUTH_TOKEN_PREVIOUS: str(),
  PORTAL_SERVICE_TOKEN_PREVIOUS: str(),
  ...rotationEnv,
  ...adminOriginEnv,
  /** Optional internal-only listener for operator calls over Fly's private network (0 = off). */
  ADMIN_LISTEN_PORT: envPort(0),
  ADMIN_LISTEN_HOST: z.string().default("::"),
  // Portal action assertions on money routes (src/security/portal-action.ts).
  PORTAL_ACTION_VERIFY_KEYS: z
    .string()
    .optional()
    .superRefine((v, ctx) => {
      try {
        parseVerifyKeys(v);
      } catch (e) {
        ctx.addIssue({ code: "custom", message: e instanceof Error ? e.message : String(e) });
      }
    }),
  REQUIRE_PORTAL_ACTION_SIGNATURE: envBool(false),
  // HMAC key and identity keys: validated as present/absent only and read byte-for-byte where used.
  PAYMENT_WEBHOOK_SECRET: str(),
  COORDINATOR_PRIVATE_KEY_PEM: str(),
  COORDINATOR_PUBLIC_KEY_PEM: str(),
  COORDINATOR_PEER_ID: str(),
  COORDINATOR_PEER_CACHE_FILE: str(),
  /** `<peerId>=<public key>[@url]` entries (src/mesh/peer-allowlist.ts parses and rejects bad ones). */
  MESH_PEER_ALLOWLIST: str(),
  // Signed peer auth: true (default) keeps the mesh token required on peer routes; false also
  // admits a request signed by an allowlisted peer coordinator's key without the token.
  MESH_TOKEN_REQUIRED_FOR_PEERS: envBool(true),
  MESH_REQUIRE_AGENT_SIGNED_RESULTS: envFlagWord(),
  MESH_WS_REQUIRE_SIGNED: envFlag({ on: ["true"], ci: true }),
  /** WebSocket ping interval on each mesh socket, for the round trip in GET /network/world; 0 turns pings off. */
  MESH_WS_PING_INTERVAL_MS: envInt(20_000, { min: 0 }),
  /** On SIGTERM / SIGINT, how long running work may finish before the coordinator exits (coordinator/drain.ts). */
  COORDINATOR_DRAIN_MS: envInt(25_000, { min: 0 }),
  /** Outside production only; production always requires signed agent requests. */
  REQUIRE_SIGNED_AGENT_REQUESTS: envFlag({ off: ["false"], ci: true }),
  /** Comma-separated proxy addresses whose forwarded-IP headers are believed. */
  COORDINATOR_TRUST_PROXY: str(),
  COORDINATOR_FEE_ACCOUNT: z.string().default("coordinator-fee:default"),
  APPROVED_COORDINATOR_IDS: str(),
  NETWORK_MODE: envEnum(["public_mesh", "enterprise_overlay"]).default("public_mesh"),
  OLLAMA_MODEL: z.string().default("qwen3.5:9b"),
  // Floors (60 s / 30 s) are applied where these are read; 0 means "use the default".
  ANCHOR_RECONCILE_MS: envNumber(900_000, { min: 0 }),
  ANCHOR_CONFIRM_POLL_MS: envNumber(600_000, { min: 0 }),
  // #46: read by anchorTrackerTuningFromEnv (src/economy/anchor-tracker.ts); declared here so a bad value stops startup.
  ANCHOR_REORG_WATCH_CONFIRMATIONS: envInt(100, { min: 1 }),
  ANCHOR_POLL_RETRY_BASE_MS: envInt(30_000, { min: 1_000 }),
  ANCHOR_POLL_MAX_BACKOFF_MS: envInt(3_600_000, { min: 1_000 }),
  PRICE_CONSENSUS_QUORUM: envNumber(undefined, { min: 0 }),
  /** 0 turns the periodic ledger reconciliation off. */
  LEDGER_VERIFY_INTERVAL_MS: envNumber(6 * 3_600_000, { min: 0 }),
  INFRA_HOST_ENABLED: envFlag({ off: ["0"] }),
  INFRA_HOST_SERVICES: str(),
  INFRA_HOST_ELECTRS_ENDPOINT: z.string().default("electrs:50001"),
  INFRA_HOST_REPORT_URLS: str(),
  INFRA_HOST_ACCOUNT_ID: str(),
  INFRA_HOST_REGION: str(),
  INFRA_HOST_LIGHTNING_ADDRESS: str(),
  INFRA_HOST_LIGHTNING_NODE_ID: str(),
  HOST_ATTEST_ALLOW_PRIVATE: envFlag({ on: ["1"] }),
  PORTAL_PUBLIC_URL: envUrl("https://edgecoder.io"),
  REGISTRY_UPSTREAM_URL: envUrl(),
  // Owner decision 2026-11-15: buying cSats is free (1 sat = 1 cSat); EdgeCoder's revenue is the
  // NETWORK_FEE_BPS share of every compute payment. Set above 0 only to charge on purchases again.
  COORDINATOR_FEE_BPS: envInt(0, { min: 0 }),
  ROBOT_COORDINATOR_FEE_BPS: envInt(200, { min: 0 }),
  ROBOT_SWEEP_INTERVAL_MS: envInt(86400000, { min: 1 }),
  ROBOT_MIN_SWEEP_SATS: envInt(10000, { min: 0 }),
  ROBOT_TASK_DEFAULT_TIMEOUT_MS: envInt(3600000, { min: 1 }),
  ROBOT_AUTO_SETTLE_DELAY_MS: envInt(86400000, { min: 1 }),
  PAYMENT_INTENT_TTL_MS: envInt(900000, { min: 1 }),
  CONTRIBUTION_BURST_CREDITS: envInt(25, { min: 0 }),
  MIN_CONTRIBUTION_RATIO: envNumber(1, { min: 0 }),
  ISSUANCE_WINDOW_MS: envInt(86400000, { min: 1 }),
  ISSUANCE_RECALC_MS: envInt(3600000, { min: 1 }),
  ISSUANCE_BASE_DAILY_POOL_TOKENS: envInt(10000, { min: 0 }),
  ISSUANCE_MIN_DAILY_POOL_TOKENS: envInt(2500, { min: 0 }),
  ISSUANCE_MAX_DAILY_POOL_TOKENS: envInt(100000, { min: 0 }),
  ISSUANCE_LOAD_CURVE_SLOPE: envNumber(0.35, { min: 0 }),
  ISSUANCE_SMOOTHING_ALPHA: envNumber(0.35, { min: 0 }),
  ISSUANCE_COORDINATOR_SHARE: envNumber(0.05, { min: 0 }),
  ISSUANCE_RESERVE_SHARE: envNumber(0.05, { min: 0 }),
  ANCHOR_INTERVAL_MS: envInt(7200000, { min: 1 }),
  /** Rate oracle: how often sats-per-CPU-hour is recalibrated from market data (default daily). */
  RATE_RECALIBRATION_MS: envInt(86400000, { min: 60000 }),
  RATE_ORACLE_ENABLED: envBool(true),
  /** Default bid for tasks that don't set maxBidMsatPerCredit: class reference × (1 + premium). */
  MARKET_DEFAULT_BID_PREMIUM_BPS: envInt(1000, { min: 0 }),
  /** Share of every accrual (bps) moved to the network fee pool that pays infrastructure hosts. */
  NETWORK_FEE_BPS: envInt(500, { min: 0 }),
  /** Infrastructure hosts heartbeat this often; the fee pool is distributed by heartbeats per window. */
  HOST_HEARTBEAT_MS: envInt(60_000, { min: 1000 }),
  FEE_POOL_DISTRIBUTION_MS: envInt(86_400_000, { min: 60_000 }),
  // The NETWORK_FEE_BPS share of compute payments is EdgeCoder's (network:fee_pool). Paying it out to
  // infrastructure hosts by uptime is off unless this is set (third-party coordinator operators).
  FEE_POOL_HOST_DISTRIBUTION: envFlag({ on: ["1", "true"] }),
  /** Automatic Lightning-address payouts run this often. */
  PAYOUT_AUTO_INTERVAL_MS: envInt(21_600_000, { min: 60_000 }),
  /** Earnings hold before an earn row is withdrawable (ms). Unset: 24 h on mainnet, 0 elsewhere (earningsHoldFromEnv). */
  PAYOUT_EARNINGS_HOLD_MS: envInt(undefined, { min: 0 }),
  IOS_BATTERY_PULL_MIN_INTERVAL_MS: envInt(45000, { min: 1 }),
  IOS_BATTERY_TASK_STOP_LEVEL_PCT: envInt(20, { min: 0 }),
  STATS_LEDGER_SYNC_INTERVAL_MS: envInt(10000, { min: 1 }),
  STATS_ANCHOR_INTERVAL_MS: envInt(600000, { min: 1 }),
  STATS_ANCHOR_MIN_CONFIRMATIONS: envInt(1, { min: 0 }),
  // Signed requests per agent per window. An idle worker heartbeats and pulls every ~1.2 s
  // (~100/min), so the limit must sit well above that or healthy agents read as bad signatures.
  AGENT_RATE_LIMIT_MAX: envInt(300, { min: 0 }),
  // Added per reported parallel model slot (at most 16): a multi-slot host pulls once per call, so
  // a 16-slot host turning calls over every 2 s pulls ~480 times a minute.
  AGENT_RATE_LIMIT_PER_SLOT: envInt(40, { min: 0 }),
  // /result and lease-only heartbeats have their own budget, so pulls can never starve the requests
  // that keep claims alive and return their work (a starved lease lapses and the call is lost).
  // A 16-slot host on 2 s calls: ~480 results and ~64 lease heartbeats a minute, plus retries.
  AGENT_LEASE_RATE_LIMIT_MAX: envInt(300, { min: 0 }),
  AGENT_LEASE_RATE_LIMIT_PER_SLOT: envInt(50, { min: 0 }),
  // D6 (run 3c): /pull and non-lease heartbeats have their own budget too, so an agent's other
  // signed traffic (agent-mesh connect/relay pings, sent in bursts on every pass) cannot refuse a
  // pull while its slots are free. A 16-slot host on 2 s calls pulls ~480 times a minute plus a
  // heartbeat per pass. An agent that reports no slots gets the base only.
  AGENT_PULL_RATE_LIMIT_MAX: envInt(300, { min: 0 }),
  AGENT_PULL_RATE_LIMIT_PER_SLOT: envInt(40, { min: 0 }),
  AGENT_RATE_LIMIT_WINDOW_MS: envInt(60000, { min: 1 }),
  // Streamed reply pieces (/inference/chunks) have their own budget: a fast GPU serving several
  // calls at once flushes a piece every ~150 ms per call, far above the general limit.
  AGENT_CHUNK_RATE_LIMIT_MAX: envInt(3000, { min: 0 }),
  // Added per reported model slot (at most 16): ~400 pieces a minute per call streaming at once.
  AGENT_CHUNK_RATE_LIMIT_PER_SLOT: envInt(400, { min: 0 }),
  // A network inference call no agent has claimed by then is cancelled, its reserve refunded in
  // full, and the requester told 503 no_capacity: well under the 100 s a proxy in front of the
  // portal (Cloudflare) waits for a response, so an overloaded call fails cleanly instead.
  INFERENCE_CLAIM_TIMEOUT_MS: envInt(45_000, { min: 1_000, max: 600_000 }),
  // Run 9: a network call (a named model, not Auto, reserved or own-machine) nobody has claimed this
  // long after its submit is decided: refused now (503 busy, refunded in full) unless a host
  // with a free slot for it is about to take it, which gets one more such window. 0 turns it off.
  // Run 11: 1.5 s (was 2 s): refusals reached 3.44 s at the portal against a 2 s target; 87% of
  // claims came within 0.5 s and a call with a host ready to claim it still waits (the second window).
  INFERENCE_CLAIM_DECISION_MS: envInt(1_500, { min: 0, max: 60_000 }),
  // C9: a network call whose estimated start here (calls ahead / slots × typical service time) is
  // past this share of its timeout (and past the claim bound) is sent to a peer with a free slot
  // (route_elsewhere) or answered 503 no_capacity, before anything is reserved. 0 turns it off.
  INFERENCE_START_ETA_FRACTION: envNumber(0.5, { min: 0, max: 1 }),
  // Completion (run 4): a network call expected to finish (start estimate + the class's measured speed
  // × its work for the prompt and this share of its max_tokens) past this share of its timeout is not
  // given to that class; with no class here in time it goes to a peer or is refused (503), before
  // anything is reserved. 0 turns it off.
  INFERENCE_COMPLETION_ETA_FRACTION: envNumber(0.9, { min: 0, max: 1 }),
  INFERENCE_COMPLETION_OUTPUT_SHARE: envNumber(1, { min: 0.05, max: 1 }),
  // A call re-run after its agent was lost (or failed with nothing sent) gets a fresh timeout, but
  // never ends later than its submit + timeoutMs + this. 0: no re-run past the original deadline.
  INFERENCE_RERUN_BUDGET_MS: envInt(120_000, { min: 0, max: 600_000 }),
  /** #524: after a restart, calls for a model nobody holds yet wait this long for agents to re-register (0 = off). */
  COORDINATOR_STARTUP_GRACE_MS: envInt(90_000, { min: 0, max: 600_000 }),
  // The web tool (docs/web-tool.md): the Brave Search API key (a secret; unset = the tool is off),
  // what a search and a page read cost the caller in cSats, and how many each account may make an hour.
  BRAVE_SEARCH_API_KEY: str(),
  WEB_SEARCH_CSATS: envNumber(0.5, { min: 0, max: 1_000 }),
  WEB_READ_CSATS: envNumber(0.2, { min: 0, max: 1_000 }),
  WEB_SEARCH_PER_HOUR: envInt(60, { min: 1, max: 10_000 }),
  WEB_READ_PER_HOUR: envInt(120, { min: 1, max: 10_000 }),
  // Free web calls for a chat whose model runs on the account's own machine (no cSats needed),
  // per account per UTC day; past them the call is paid as usual. And free calls in all per day
  // on one coordinator, a cost circuit-breaker (0 turns free web off).
  WEB_FREE_OWN_MACHINE_SEARCHES_PER_DAY: envInt(100, { min: 0, max: 100_000 }),
  WEB_FREE_OWN_MACHINE_READS_PER_DAY: envInt(200, { min: 0, max: 100_000 }),
  WEB_FREE_GLOBAL_PER_DAY: envInt(5_000, { min: 0, max: 10_000_000 }),
  // Output cap (tokens) for a network model call that sets none: bounds what an agent can bill for
  // a reply (token padding) and so the worst case of every call. Matches the 4096 the context
  // sizing already assumed for such calls (contextNeeded). A call may still ask for up to 32768.
  INFERENCE_DEFAULT_MAX_TOKENS: envInt(4_096, { min: 16, max: 32_768 }),
  // Signed requests per client address per window whose signature fails before the signer is proven
  // (bad signature, clock skew). Past it the address is refused until the window passes.
  PREAUTH_FAILURE_MAX_PER_IP: envInt(120, { min: 1 }),
  // Behavioural auto-blacklists expire: they are usually a misbehaving client build, not an attacker,
  // and a permanent one leaves a legitimate machine with no way back. 0 makes them permanent.
  AUTO_BLACKLIST_TTL_MS: envInt(3600000, { min: 0 }),
  SECURITY_NONCE_TTL_MS: envInt(300000, { min: 1 }),
  SECURITY_MAX_SKEW_MS: envInt(120000, { min: 1 }),
  TUNNEL_IDLE_TTL_MS: envInt(90000, { min: 1 }),
  TUNNEL_MAX_RELAYS_PER_MIN: envInt(120, { min: 0 }),
  RELAY_RATE_LIMIT_PER_10S: envInt(80, { min: 0 }),
  DIRECT_WORK_OFFERS_PER_10S: envInt(20, { min: 0 }),
  // Agent failures from one submitter account that count toward an agent's failure-rate rules
  // (BHV004) per behaviour window (1 h): one buyer's failing jobs can't sink a worker.
  BEHAVIOR_SUBMITTER_FAILURE_CAP: envInt(3, { min: 1 }),
  // BHV006: abandoned claims (a lease that lapsed) that make a pattern within the window, either in
  // a row without returning any result or held past their deadline while heartbeating. A single
  // heartbeat gap (sleep, an update restart) is never one; see src/security/anomaly-detector.ts.
  BEHAVIOR_ABANDONED_CLAIM_THRESHOLD: envInt(5, { min: 1, max: 1000 }),
  BEHAVIOR_ABANDONED_CLAIM_WINDOW_MS: envInt(86_400_000, { min: 60_000, max: 7 * 86_400_000 }),
  PAYMENT_INTENT_EXPIRY_GRACE_MS: envInt(120000, { min: 1 }),
  AGENT_ORCHESTRATION_ONLINE_WINDOW_MS: envInt(120000, { min: 1 }),
  /** Agents not seen this long are dropped from the in-memory registry (they re-register as after a restart). */
  AGENT_CAPABILITY_TTL_MS: envInt(3_600_000, { min: 60_000 }),
  // Work receipts: epoch close/anchor cadence and peer replication pull interval (docs/receipts-and-trust.md).
  RECEIPT_EPOCH_MS: envInt(3600000, { min: 1 }),
  RECEIPT_REPLICATION_MS: envInt(60000, { min: 1 }),
  ROBOT_QUEUE_ENABLED: envBool(false),
  OLLAMA_AUTO_INSTALL: envBool(false),
  REQUIRE_VERIFIED_AGENTS: envBool(false),
  BITCOIN_NETWORK: z.enum(["bitcoin", "testnet", "signet", "regtest"], { message: "must be bitcoin, testnet, signet or regtest" }).default("testnet"),
  // Direct (non-custodial) payment paths, src/economy/direct/ and docs/design/noncustodial-payments.md.
  // Read raw by src/economy/direct/flags.ts and src/swarm/coordinator/direct-payments.ts; listed here
  // so they are declared and documented. None is set on a live coordinator.
  PAYMENTS_PREPAID: z.string().optional(),
  PAYMENTS_DIRECT_RESERVATIONS: z.string().optional(),
  PAYMENTS_NWC: z.string().optional(),
  SETTLE_MIN_SATS: z.string().optional(),
  MAX_UNSETTLED_SATS: z.string().optional(),
  SETTLE_INTERVAL_MS: z.string().optional(),
  SETTLE_MAX_FAILURES: z.string().optional(),
  NONCUSTODIAL_SECRET_KEY: z.string().optional(),
  EDGECODER_FEE_LIGHTNING_ADDRESS: z.string().optional(),
  EDGECODER_FEE_BTC_ADDRESS: z.string().optional(),
  EDGECODER_FEE_ZCASH_ADDRESS: z.string().optional(),
  EDGECODER_FEE_ZCASH_VIEWING_KEY: z.string().optional(),
  DIRECT_PAY_RECEIPT_KEY_PEM: z.string().optional(),
  DIRECT_PAY_ESPLORA_URL: z.string().optional(),
  DIRECT_PAY_ONCHAIN_MIN_CONF: z.string().optional(),
  DIRECT_PAY_DEV_HTTP: z.string().optional(),
  DIRECT_PAY_ALLOW_UNCOMMITTED: z.string().optional(),
  ZCASH_NETWORK: z.string().optional(),
  ZCASHD_RPC_URL: z.string().optional(),
  ZCASHD_RPC_USER: z.string().optional(),
  ZCASHD_RPC_PASSWORD: z.string().optional(),
  ZCASH_MIN_CONFIRMATIONS: z.string().optional(),
  ZEC_USD: z.string().optional(),
  LOCAL_MODEL_PROVIDER: z.enum(["edgecoder-local", "ollama-local"], { message: "must be edgecoder-local or ollama-local" }).default("edgecoder-local"),
  // Security research tier (docs/security-research-tier.md). RESTRICTED_MODELS_JSON is the operator's
  // list of restricted model tags, {"<tag>": "security_research"}; empty by default. A restricted model
  // is listed and served only to entitled accounts, only on their own or leased machines.
  RESTRICTED_MODELS_JSON: z
    .string()
    .optional()
    .superRefine((v, ctx) => {
      try {
        parseRestrictedModels(v);
      } catch (err) {
        ctx.addIssue({ code: "custom", message: err instanceof Error ? err.message : String(err) });
      }
    }),
  // Keep prompts and outputs of restricted-model calls in the call log (off: metadata only).
  RESTRICTED_MODEL_LOG_PROMPTS: envBool(false),
  RESTRICTED_MODEL_RATE_LIMIT_PER_MIN: envInt(20, { min: 1, max: 10_000 }),
  // How often the coordinator re-reads entitlements from the portal, and how long an unconfirmed one is honoured.
  RESTRICTED_ACCESS_SYNC_MS: envInt(60_000, { min: 5_000, max: 3_600_000 }),
  RESTRICTED_ACCESS_MAX_STALE_MS: envInt(600_000, { min: 30_000, max: 86_400_000 }),
  COORDINATOR_PUBLIC_URL: envUrl("http://127.0.0.1:4301"),
  INFERENCE_URL: envUrl("http://127.0.0.1:4302"),
  CONTROL_PLANE_URL: envUrl(),
  PORTAL_SERVICE_URL: envUrl(),
});

export type CoordinatorConfig = z.infer<typeof coordinatorConfigSchema>;
