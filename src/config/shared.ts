// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envEnum, envEnumCi, envFlag, envFlagWord, envInt, envJson, envNumber, envUrl } from "../common/config.js";

/*
 * #15: variables that more than one service reads, grouped by the library that reads them. A
 * service schema spreads in the groups it uses, so a variable has one validator everywhere.
 *
 * Most of these are still read by library helpers that take `env` as a parameter (the
 * `*FromEnv(env = process.env)` functions): they are unit-tested that way and keep their own
 * defaults, floors and clamps. The entries here validate the value at startup (number, sign,
 * boolean word, URL, enum) so a typo stops the service with a clear message instead of silently
 * falling back to the default. They add no defaults of their own.
 */

const str = () => z.string().optional();
/** Non-negative number; the reader applies its own default and floor. */
const amount = () => envNumber(undefined, { min: 0 });
/** Non-negative whole number. */
const count = () => envInt(undefined, { min: 0 });
/** Share of 1. */
const fraction = () => envNumber(undefined, { min: 0, max: 1 });

/** pino levels (the logger throws on anything else). */
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** Logging, metrics, error tracking and request-id forwarding (src/common), used by every HTTP service. */
export const observabilityEnv = {
  NODE_ENV: str(),
  HOST: str(),
  LOG_LEVEL: envEnum(LOG_LEVELS).optional(),
  METRICS_TOKEN: str(),
  SENTRY_DSN: str(),
  SENTRY_ENVIRONMENT: str(),
  SENTRY_RELEASE: str(),
  /** Comma-separated extra origins that receive the x-request-id header. */
  REQUEST_ID_FORWARD_ORIGINS: str(),
  ENABLE_DEBUG_ROUTES: envFlag({ on: ["1"] })
};

/** Where the other services live. Request ids are forwarded to these origins by every service. */
export const serviceUrlsEnv = {
  COORDINATOR_URL: envUrl(),
  COORDINATOR_PUBLIC_URL: envUrl(),
  CONTROL_PLANE_URL: envUrl(),
  INFERENCE_URL: envUrl(),
  PORTAL_SERVICE_URL: envUrl(),
  /** Comma-separated coordinator URLs. */
  COORDINATOR_DISCOVERY_URLS: str()
};

/** Ollama and model selection (src/model). */
export const modelEnv = {
  LOCAL_MODEL_PROVIDER: envEnum(["edgecoder-local", "ollama-local"]).optional(),
  OLLAMA_HOST: envUrl(),
  OLLAMA_MODEL: str(),
  OLLAMA_EDGE_MODEL: str(),
  OLLAMA_COORDINATOR_MODEL: str(),
  OLLAMA_GENERATE_ENDPOINT: envUrl(),
  OLLAMA_TAGS_ENDPOINT: envUrl(),
  OLLAMA_THINK: envFlag({ on: ["1"] }),
  /** Where a managed Ollama is installed. */
  EDGECODER_OLLAMA_DIR: str(),
  /** Comma-separated hosts model files may be downloaded from. */
  MODEL_DOWNLOAD_DOMAINS: str()
};

/** Task sandbox (src/executor, src/swarm/sandbox-enforcement.ts). */
export const sandboxEnv = {
  // Not an enum: an unsupported value is handled at runtime (warn, run without a sandbox, take no swarm tasks).
  SANDBOX_MODE: str(),
  SANDBOX_SECCOMP_PROFILE: str(),
  SANDBOX_MAX_OUTPUT_BYTES: amount(),
  DOCKER_PROBE_TIMEOUT_MS: amount(),
  EDGECODER_PYTHON: str(),
  EDGECODER_PYTHON_AST_TIMEOUT_MS: amount(),
  EDGECODER_UNSAFE_HOST_EXECUTION: envFlag({ on: ["1"] })
};

/** Release-integrity check of the running build (src/security/release-integrity.ts). */
export const releaseEnv = {
  EDGECODER_DEV: envFlag({ on: ["1"] }),
  EDGECODER_RELEASE: str()
};

/** Coordinator identity pinning and signed responses (src/trust). */
export const trustEnv = {
  EDGECODER_TRUST_MODE: envEnumCi(["tofu", "strict", "open"]),
  /** `<coordinator url or peer id>=<public key>` entries. */
  TRUSTED_COORDINATOR_KEYS: str(),
  EDGECODER_TRUST_FILE: str(),
  EDGECODER_IDENTITY_CHALLENGE: envEnumCi(["required", "optional"]),
  EDGECODER_RESPONSE_SIGNING: envEnumCi(["required", "optional"])
};

/** Coordinator discovery: static lists, DNS, Nostr and the signed registry (src/discovery). */
export const discoveryEnv = {
  COORDINATOR_DISCOVERY_URL: str(),
  COORDINATOR_DISCOVERY_URLS: str(),
  COORDINATOR_BOOTSTRAP_URLS: str(),
  EDGECODER_DISCOVERY_DOMAIN: str(),
  EDGECODER_DISCOVERY_TIMEOUT_MS: amount(),
  EDGECODER_DISCOVERY_MARGIN: amount(),
  EDGECODER_COMPUTE_CLASS: str(),
  EDGECODER_COORDINATOR_PINS: str(),
  EDGECODER_NOSTR_RELAYS: str(),
  EDGECODER_NOSTR_AUTHORS: str(),
  EDGECODER_NOSTR_ALLOW_UNPINNED: envFlag({ on: ["1", "true", "yes"], ci: true }),
  EDGECODER_REGISTRY_PUBLIC_KEY: str(),
  EDGECODER_REGISTRY_PUBLIC_KEYS: str(),
  EDGECODER_REGISTRY_URL: str(),
  EDGECODER_REGISTRY_URLS: str()
};

/** A coordinator announcing itself over Nostr (src/discovery/announce.ts). */
export const announceEnv = {
  EDGECODER_NOSTR_ANNOUNCE: envFlag({ on: ["1"] }),
  EDGECODER_NOSTR_ANNOUNCE_INTERVAL_MS: amount(),
  // Not format-checked here: the announcer logs an invalid key and keeps the coordinator running.
  NOSTR_SECRET_KEY_HEX: str(),
  COORDINATOR_REGION: str(),
  EDGECODER_VERSION: str()
};

/** Compute classes and their reference prices (src/economy/compute-classes.ts). */
export const computeClassEnv = {
  COMPUTE_TIER_WEIGHTS_JSON: envJson(),
  COMPUTE_REFERENCE_USD_PER_VCPU_HOUR: amount(),
  COMPUTE_REFERENCE_USD_PER_GPU_HOUR: amount(),
  COMPUTE_REFERENCE_USD_PER_HOUR_JSON: envJson()
};

/** Rate oracle sources and guard rails (src/economy/rate-oracle.ts). */
export const rateOracleEnv = {
  RATE_COMPUTE_SOURCES_JSON: envJson(),
  RATE_BTC_USD_SOURCES_JSON: envJson(),
  BTC_USD_FALLBACK: amount(),
  RATE_NETWORK_MARKUP_BPS: amount(),
  RATE_MAX_DAILY_MOVE_PCT: amount(),
  RATE_MAX_SOURCE_SPREAD_PCT: amount(),
  RATE_MIN_SOURCES: amount(),
  RATE_STALE_AFTER_MS: amount(),
  RATE_HASHPRICE_ENABLED: envFlag({ off: ["false"], ci: true }),
  RATE_MEMPOOL_BASE_URL: envUrl()
};

/** Bounds a price epoch may move within (src/economy/price-epoch-guard.ts). */
export const priceEpochEnv = {
  PRICE_EPOCH_CPU_MIN_SATS: amount(),
  PRICE_EPOCH_CPU_MAX_SATS: amount(),
  PRICE_EPOCH_GPU_MIN_SATS: amount(),
  PRICE_EPOCH_GPU_MAX_SATS: amount(),
  PRICE_EPOCH_MAX_CHANGE_BPS: amount()
};

/** Lightning node access (src/economy/lightning.ts). */
export const lightningEnv = {
  ECONOMY_PAYMENTS_ENABLED: envFlag({ off: ["0", "false", "off", "no"], ci: true }),
  LIGHTNING_PROVIDER: envEnumCi(["lnd", "cln", "mock"]),
  LND_REST_URL: envUrl(),
  LND_MACAROON_HEX: str(),
  LND_TLS_CERT_BASE64: str(),
  CLN_REST_URL: envUrl(),
  CLN_API_TOKEN: str(),
  ALLOW_MOCK_LIGHTNING: envFlag({ on: ["1"] }),
  MOCK_LIGHTNING_BALANCE_SATS: amount()
};

/** Payout policy, hot-wallet limits and reconciliation (src/economy/payout*.ts). */
export const payoutEnv = {
  PAYOUTS_ENABLED: envFlag({ off: ["false"], ci: true }),
  PAYOUTS_PAUSED: envFlag({ on: ["1", "true", "yes", "on"], ci: true }),
  PAYOUT_MIN_SATS: amount(),
  PAYOUT_MAX_FEE_BPS: amount(),
  PAYOUT_MIN_FEE_FLOOR_SATS: amount(),
  PAYOUT_AUTO_MIN_SATS: amount(),
  PAYOUT_RESERVE_BPS: amount(),
  PAYOUT_MAX_SINGLE_SATS: amount(),
  PAYOUT_MAX_ACCOUNT_DAILY_SATS: amount(),
  PAYOUT_MAX_GLOBAL_DAILY_SATS: amount(),
  PAYOUT_RECONCILE_MS: amount(),
  PAYOUT_RECONCILE_TOLERANCE_SATS: amount(),
  PAYOUT_RECONCILE_LOOKBACK_MS: amount(),
  PAYOUT_SOLVENCY_ALLOWANCE_SATS: amount(),
  PAYOUT_ALERT_WEBHOOK_URL: envUrl()
};

/** Soft launch (src/economy/launch-gate.ts): invite-only signups on the portal, low per-account caps on the coordinator. */
export const launchEnv = {
  LAUNCH_MODE: envEnumCi(["open", "invite"]),
  LAUNCH_MAX_BUY_SATS_PER_DAY: count(),
  LAUNCH_MAX_BALANCE_SATS: count(),
  LAUNCH_MAX_PAYOUT_SATS_PER_DAY: count()
};

/**
 * On-chain Bitcoin through the coordinator's LND wallet (src/economy/onchain*.ts): deposits credited
 * as cSats and batched on-chain payouts. Read by onchainConfigFromEnv, which applies the defaults
 * (network dependent) and floors.
 */
export const onchainEnv = {
  ONCHAIN_ENABLED: envFlag({ on: ["1", "true", "yes", "on"], ci: true }),
  ONCHAIN_ADDRESS_TYPE: envEnumCi(["p2tr", "p2wkh"]),
  ONCHAIN_DEPOSIT_CONFIRMATIONS: count(),
  ONCHAIN_DEPOSIT_MIN_SATS: count(),
  ONCHAIN_DEPOSIT_MAX_SATS: count(),
  ONCHAIN_DEPOSIT_MAX_ACCOUNT_DAILY_SATS: count(),
  ONCHAIN_POLL_MS: count(),
  ONCHAIN_PAYOUT_MIN_SATS: count(),
  ONCHAIN_PAYOUT_INTERVAL_MS: count(),
  ONCHAIN_PAYOUT_MAX_FEE_RATE: count(),
  ONCHAIN_PAYOUT_TARGET_CONF: count(),
  ONCHAIN_PAYOUT_FEE_PAYER: envEnumCi(["host", "edgecoder"]),
  ONCHAIN_PAYOUT_CONFIRMATIONS: count(),
  ONCHAIN_BROADCAST_GRACE_MS: count()
};

/** bitcoind JSON-RPC access, used by the anchor proxy and by a coordinator with BITCOIN_ANCHOR_PROVIDER=bitcoind. */
export const bitcoindEnv = {
  BITCOIND_RPC_URL: envUrl(),
  BITCOIND_RPC_USER: str(),
  BITCOIND_RPC_PASSWORD: str(),
  BITCOIND_WALLET_NAME: str()
};

/** Anchoring ledger checkpoints to Bitcoin from a coordinator (src/economy/anchoring.ts, bitcoin-rpc.ts). */
export const anchoringEnv = {
  // "blockstream" is accepted because existing deployments may still carry it: it is read-only,
  // so anchoring reports blockstream_cannot_anchor at the first attempt, as before.
  BITCOIN_ANCHOR_PROVIDER: envEnumCi(["anchor-proxy", "bitcoind", "mock", "blockstream"]),
  ANCHOR_PROXY_URL: envUrl(),
  ANCHOR_PROXY_TOKEN: str(),
  BITCOIN_ANCHOR_MAINNET: envFlag({ on: ["1"] }),
  BITCOIN_ANCHOR_CONFIRMATIONS: count(),
  BITCOIN_ANCHOR_DAILY_BUDGET_SATS: amount(),
  BITCOIN_ANCHOR_MAX_FEE_SATS: amount(),
  BITCOIN_ANCHOR_MIN_FEE_SAT_VB: amount(),
  ANCHOR_RECONCILE_MAX_ATTEMPTS: amount(),
  ANCHOR_STUCK_AFTER_MS: amount(),
  ANCHOR_ABANDON_WATCH_MS: amount()
};

/** Replicated execution and reputation (src/swarm/verification.ts). */
export const verificationEnv = {
  RESULT_VERIFICATION_RATE: fraction(),
  RESULT_VERIFICATION_MISMATCH_PENALTY: fraction(),
  RESULT_VERIFICATION_ABANDON_PENALTY: fraction(),
  RESULT_VERIFICATION_INITIAL_REPUTATION: fraction(),
  RESULT_VERIFICATION_MAX_EXECUTIONS: count(),
  RESULT_VERIFICATION_MAX_REASSIGNMENTS: count(),
  RESULT_VERIFICATION_REPUTATION_CACHE_MAX: count(),
  RESULT_VERIFICATION_TIMEOUT_MS: amount(),
  RESULT_VERIFICATION_REPLICA_CLAIM_TIMEOUT_MS: amount(),
  RESULT_VERIFICATION_MINT_REPLICA_REWARDS: envFlag({ on: ["1", "true", "yes"], ci: true }),
  /** Comma-separated task kinds to verify. */
  RESULT_VERIFICATION_KINDS: str()
};

/** Hardware claims and their re-verification (src/swarm/hardware-verification.ts). */
export const hardwareVerificationEnv = {
  HARDWARE_VERIFICATION: envFlag({ off: ["0", "false"] }),
  HARDWARE_GPU_REQUIRE_CROSS_CHECK: envFlag({ off: ["0", "false"] }),
  HARDWARE_CROSS_CHECK_MIN_SIMILARITY: fraction(),
  HARDWARE_REVALIDATE_MS: amount(),
  HARDWARE_RETRY_MS: amount(),
  HARDWARE_WITNESS_STRIKE_THRESHOLD: count(),
  HARDWARE_WITNESS_STRIKE_WINDOW_MS: amount(),
  HARDWARE_TIER_MIN_JSON: envJson()
};

/** Best-fit routing for model "auto" (src/swarm/coordinator/best-fit.ts, src/inference-api/job-complexity.ts). */
export const bestFitEnv = {
  BEST_FIT_W_QUALITY: envNumber(undefined, { min: 0, max: 10 }),
  BEST_FIT_W_LATENCY: envNumber(undefined, { min: 0, max: 10 }),
  BEST_FIT_W_PRICE: envNumber(undefined, { min: 0, max: 10 }),
  BEST_FIT_W_RELIABILITY: envNumber(undefined, { min: 0, max: 10 }),
  BEST_FIT_COMPLEXITY_SHIFT: envNumber(undefined, { min: 0, max: 2 }),
  BEST_FIT_LATENCY_TARGET_MS: envNumber(undefined, { min: 100 }),
  BEST_FIT_BATCH_LATENCY_TARGET_MS: envNumber(undefined, { min: 100 }),
  BEST_FIT_PRICE_REF_CSATS: envNumber(undefined, { min: 0.001 }),
  BEST_FIT_PREFER_MS: envNumber(undefined, { min: 0, max: 10_000 }),
  BEST_FIT_SESSION_TTL_MS: amount(),
  BEST_FIT_OVERSIZE_PENALTY: fraction(),
  BEST_FIT_PEERS: envFlag({ off: ["0", "false"] }),
  BEST_FIT_COMPLEXITY_WEIGHTS_JSON: envJson()
};

/** Reservation backfill: idle reserved machines take small network calls (src/economy/reservation-backfill.ts). */
export const reservationBackfillEnv = {
  RESERVATION_BACKFILL: envFlagWord(),
  RESERVATION_BACKFILL_DEFAULT: envFlagWord(),
  RESERVATION_BACKFILL_HOLDER_SHARE: fraction(),
  RESERVATION_BACKFILL_MAX_TOKENS: envNumber(undefined, { min: 256, max: 1_000_000 }),
  RESERVATION_BACKFILL_MAX_SECONDS: envNumber(undefined, { min: 1, max: 600 }),
  RESERVATION_BACKFILL_SLOT_FRACTION: fraction()
};

/** Claim leases on queued subtasks (src/swarm/queue.ts). */
export const leaseEnv = {
  CLAIM_LEASE_GRACE_MS: amount(),
  CLAIM_LEASE_LIVENESS_MS: amount(),
  CLAIM_MAX_ATTEMPTS: amount(),
  CLAIM_MAX_TIMEOUT_MS: amount()
};

/** Postgres connection pools (src/db/pool.ts): coordinator and portal. */
export const postgresPoolEnv = {
  PG_POOL_MAX: envInt(undefined, { min: 1 }),
  PG_CONNECT_TIMEOUT_MS: count(),
  PG_IDLE_TIMEOUT_MS: count(),
  /** 0 keeps the server's own statement_timeout. */
  PG_STATEMENT_TIMEOUT_MS: count()
};

/** Escalating a task to a parent coordinator or to cloud inference (src/escalation/server.ts). */
export const escalationEnv = {
  PARENT_COORDINATOR_URL: envUrl(),
  PARENT_MESH_TOKEN: str(),
  CLOUD_INFERENCE_URL: envUrl(),
  CLOUD_INFERENCE_TOKEN: str(),
  ESCALATION_TIMEOUT_MS: count(),
  ESCALATION_MAX_RETRIES: count(),
  ESCALATION_RETRY_BASE_DELAY_MS: count(),
  ESCALATION_CALLBACK_URL: envUrl(),
  ESCALATION_CALLBACK_TOKEN: str()
};

/** Offline credit sync over Bluetooth (src/credits/ble-sync.ts). */
export const bleSyncEnv = {
  BLE_SYNC_MAX_CREDITS_PER_TX: amount(),
  BLE_SYNC_ALLOW_V1: envFlag({ on: ["1"] })
};
