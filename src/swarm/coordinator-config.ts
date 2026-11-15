// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envBool, envEnum, envFlag, envFlagWord, envInt, envNumber, envUrl } from "../common/config.js";
import {
  anchoringEnv,
  announceEnv,
  bitcoindEnv,
  bleSyncEnv,
  computeClassEnv,
  discoveryEnv,
  escalationEnv,
  hardwareVerificationEnv,
  leaseEnv,
  lightningEnv,
  modelEnv,
  observabilityEnv,
  payoutEnv,
  priceEpochEnv,
  rateOracleEnv,
  releaseEnv,
  sandboxEnv,
  serviceUrlsEnv,
  trustEnv,
  verificationEnv
} from "../config/shared.js";

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
  ...bitcoindEnv,
  ...anchoringEnv,
  ...verificationEnv,
  ...hardwareVerificationEnv,
  ...leaseEnv,
  ...escalationEnv,
  ...bleSyncEnv,
  EDGECODER_RESPONSE_SIGNING: trustEnv.EDGECODER_RESPONSE_SIGNING,
  DATABASE_URL: str(),
  // Tokens: required in production by requireProdEnv() in coordinator/context.ts (#5).
  MESH_AUTH_TOKEN: str(),
  ADMIN_API_TOKEN: str(),
  INFERENCE_AUTH_TOKEN: str(),
  PORTAL_SERVICE_TOKEN: str(),
  PORTAL_COORDINATOR_TOKEN: str(),
  COORDINATOR_REGISTRATION_TOKEN: str(),
  // HMAC key and identity keys: validated as present/absent only and read byte-for-byte where used.
  PAYMENT_WEBHOOK_SECRET: str(),
  COORDINATOR_PRIVATE_KEY_PEM: str(),
  COORDINATOR_PUBLIC_KEY_PEM: str(),
  COORDINATOR_PEER_ID: str(),
  COORDINATOR_PEER_CACHE_FILE: str(),
  /** `<peerId>=<public key>[@url]` entries (src/mesh/peer-allowlist.ts parses and rejects bad ones). */
  MESH_PEER_ALLOWLIST: str(),
  MESH_REQUIRE_AGENT_SIGNED_RESULTS: envFlagWord(),
  MESH_WS_REQUIRE_SIGNED: envFlag({ on: ["true"], ci: true }),
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
  AGENT_RATE_LIMIT_WINDOW_MS: envInt(60000, { min: 1 }),
  // A network inference call no agent has claimed by then is cancelled, its reserve refunded in
  // full, and the requester told 503 no_capacity: well under the 100 s a proxy in front of the
  // portal (Cloudflare) waits for a response, so an overloaded call fails cleanly instead.
  INFERENCE_CLAIM_TIMEOUT_MS: envInt(45_000, { min: 1_000, max: 600_000 }),
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
  LOCAL_MODEL_PROVIDER: z.enum(["edgecoder-local", "ollama-local"], { message: "must be edgecoder-local or ollama-local" }).default("edgecoder-local"),
  COORDINATOR_PUBLIC_URL: envUrl("http://127.0.0.1:4301"),
  INFERENCE_URL: envUrl("http://127.0.0.1:4302"),
  CONTROL_PLANE_URL: envUrl(),
  PORTAL_SERVICE_URL: envUrl(),
});

export type CoordinatorConfig = z.infer<typeof coordinatorConfigSchema>;
