// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import { envBool, envInt, envNumber, envUrl } from "../common/config.js";

/*
 * #15: coordinator (port 4301) configuration. Every numeric, boolean, enum and URL setting the
 * coordinator reads at module load is validated here, so "abc" for an interval or "maybe" for a
 * flag fails startup with the variable named instead of becoming NaN or false.
 * Defaults are unchanged from the previous inline reads. Secrets and free-form strings
 * (tokens, peer keys, file paths, ID lists) are still read where they are used.
 * Documented in site-docs/reference/environment-variables.md.
 */
export const coordinatorConfigSchema = z.object({
  COORDINATOR_FEE_BPS: envInt(150, { min: 0 }),
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
  IOS_BATTERY_PULL_MIN_INTERVAL_MS: envInt(45000, { min: 1 }),
  IOS_BATTERY_TASK_STOP_LEVEL_PCT: envInt(20, { min: 0 }),
  STATS_LEDGER_SYNC_INTERVAL_MS: envInt(10000, { min: 1 }),
  STATS_ANCHOR_INTERVAL_MS: envInt(600000, { min: 1 }),
  STATS_ANCHOR_MIN_CONFIRMATIONS: envInt(1, { min: 0 }),
  AGENT_RATE_LIMIT_MAX: envInt(30, { min: 0 }),
  AGENT_RATE_LIMIT_WINDOW_MS: envInt(60000, { min: 1 }),
  SECURITY_NONCE_TTL_MS: envInt(300000, { min: 1 }),
  SECURITY_MAX_SKEW_MS: envInt(120000, { min: 1 }),
  TUNNEL_IDLE_TTL_MS: envInt(90000, { min: 1 }),
  TUNNEL_MAX_RELAYS_PER_MIN: envInt(120, { min: 0 }),
  RELAY_RATE_LIMIT_PER_10S: envInt(80, { min: 0 }),
  DIRECT_WORK_OFFERS_PER_10S: envInt(20, { min: 0 }),
  PAYMENT_INTENT_EXPIRY_GRACE_MS: envInt(120000, { min: 1 }),
  AGENT_ORCHESTRATION_ONLINE_WINDOW_MS: envInt(120000, { min: 1 }),
  ROBOT_QUEUE_ENABLED: envBool(false),
  OLLAMA_AUTO_INSTALL: envBool(false),
  REQUIRE_VERIFIED_AGENTS: envBool(false),
  BITCOIN_NETWORK: z.enum(["bitcoin", "testnet", "signet"], { message: "must be bitcoin, testnet or signet" }).default("testnet"),
  LOCAL_MODEL_PROVIDER: z.enum(["edgecoder-local", "ollama-local"], { message: "must be edgecoder-local or ollama-local" }).default("edgecoder-local"),
  COORDINATOR_PUBLIC_URL: envUrl("http://127.0.0.1:4301"),
  INFERENCE_URL: envUrl("http://127.0.0.1:4302"),
  CONTROL_PLANE_URL: envUrl(),
  PORTAL_SERVICE_URL: envUrl(),
});

export type CoordinatorConfig = z.infer<typeof coordinatorConfigSchema>;
