// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { WorkReceipt } from "../receipts/receipt.js";
import { clampLimit, parseCursor, type ReceiptEpoch, type ReceiptPage, type ReceiptStore } from "../receipts/store.js";
import type { RateEpoch } from "../economy/rate-oracle.js";
import type { Reservation } from "../economy/reservations.js";
import type { UsageRecord } from "../economy/usage.js";
import type { HardwareVerificationRecord } from "../swarm/hardware-verification.js";
import type { NonceStore } from "../security/nonce-verifier.js";
import type { FeePoolLockResult, ReservationLimits, ReserveResult } from "../economy/payout-service.js";
import type { PayoutPauseState } from "../economy/payout-safeguards.js";
import type { CallbackPin, CallbackPinStore } from "../economy/lnurl-callback-pin.js";
import { normalizeLegacyOrder, normalizeLegacyTicks, normalizeLegacyTrades, type MarketOrder, type MarketTick, type MarketTrade } from "../economy/market-history.js";

function rowToPayout(row: Record<string, unknown>): PayoutRecord {
  return {
    payoutId: String(row.payout_id),
    accountId: String(row.account_id),
    coordinatorId: String(row.coordinator_id),
    kind: row.kind as PayoutRecord["kind"],
    bolt11: String(row.bolt11),
    paymentHash: String(row.payment_hash),
    amountMsat: Number(row.amount_msat),
    feeMsat: Number(row.fee_msat ?? 0),
    maxFeeMsat: Number(row.max_fee_msat ?? 0),
    status: row.status as PayoutRecord["status"],
    preimage: (row.preimage as string | null) ?? undefined,
    error: (row.error as string | null) ?? undefined,
    destination: (row.destination as string | null) ?? undefined,
    createdAtMs: Number(row.created_at_ms),
    settledAtMs: row.settled_at_ms === null || row.settled_at_ms === undefined ? undefined : Number(row.settled_at_ms)
  };
}
import {
  AccountMembership,
  AgentOwnership,
  BitcoinAnchorRecord,
  BlacklistRecord,
  CoordinatorFeeEvent,
  CreditAccount,
  ComputeContributionReport,
  IssuanceAllocationRecord,
  IssuanceEpochRecord,
  IssuancePayoutEvent,
  KeyCustodyEvent,
  QuorumLedgerRecord,
  RollingContributionShare,
  PaymentIntent,
  PriceEpochRecord,
  OllamaRolloutRecord,
  RolloutPolicy,
  RolloutStage,
  AgentRolloutState,
  AgentRolloutStatus,
  TreasuryPolicy,
  QueueEventRecord,
  Subtask,
  SubtaskResult,
  CreditTransaction,
  WalletAccount,
  InfrastructureHost,
  PayoutRecord
} from "../common/types.js";

/**
 * #108: advisory-lock namespace for per-account credit locks. The two-key form
 * pg_advisory_xact_lock(namespace, hashtext(account)) keeps these locks from colliding
 * with any other single-key advisory locks.
 */
export const CREDIT_LOCK_NAMESPACE = 0x45430001;
/**
 * #108 review: migrate() takes this transaction-level lock first, so two instances starting
 * at once run SCHEMA_SQL one after the other (it is sent as one implicit transaction).
 */
export const SCHEMA_LOCK_NAMESPACE = 0x45430000;
export const SCHEMA_LOCK_KEY = 1;
/** Fee-pool distribution: one coordinator at a time across every instance on this database. */
export const FEE_POOL_LOCK_NAMESPACE = 0x45430002;
export const FEE_POOL_LOCK_KEY = 1;
/** Payout reservations: one at a time, so the global 24 h cap and node capacity are checked exactly. */
export const PAYOUT_LOCK_NAMESPACE = 0x45430003;
export const PAYOUT_GLOBAL_LOCK_KEY = 0;
/** Stats-ledger checkpoint signing: coordinators sharing a database sign and commit one at a time. */
export const STATS_CHECKPOINT_LOCK_NAMESPACE = 0x45430004;
export const STATS_CHECKPOINT_LOCK_KEY = 1;
/** Issuance epochs: coordinators sharing a database compute each window's epoch one at a time. */
export const ISSUANCE_LOCK_NAMESPACE = 0x45430005;
export const ISSUANCE_LOCK_KEY = 1;
/** Read-side dedupe bucket for issuance epochs when the caller does not pass its recalc interval. */
export const DEFAULT_ISSUANCE_BUCKET_MS = 3_600_000;
/** Event types that sign the stats ledger rather than record work; never a checkpoint target. */
export const STATS_CHECKPOINT_EVENT_TYPES = ["stats_checkpoint_signature", "stats_checkpoint_commit"] as const;
/** What a payout row has or may still move: pending rows count at their fee cap. */
const OUTFLOW_SQL = `amount_msat + CASE WHEN status = 'pending' THEN GREATEST(fee_msat, max_fee_msat) ELSE fee_msat END`;

export const SCHEMA_SQL = `
SELECT pg_advisory_xact_lock(${SCHEMA_LOCK_NAMESPACE}, ${SCHEMA_LOCK_KEY});
CREATE TABLE IF NOT EXISTS queue_tasks (
  subtask_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  project_id TEXT NOT NULL,
  tenant_id TEXT,
  resource_class TEXT NOT NULL,
  priority INT NOT NULL,
  claimed_by TEXT,
  claimed_at_ms BIGINT,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue_results (
  subtask_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  ok BOOLEAN NOT NULL,
  output TEXT NOT NULL,
  error TEXT,
  duration_ms INT NOT NULL,
  report_nonce TEXT,
  report_signature TEXT,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_records (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  task_id TEXT NOT NULL,
  subtask_id TEXT,
  actor_id TEXT NOT NULL,
  sequence INT NOT NULL,
  issued_at_ms BIGINT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  signature TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stats_ledger_records (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  task_id TEXT NOT NULL,
  subtask_id TEXT,
  actor_id TEXT NOT NULL,
  sequence INT NOT NULL,
  issued_at_ms BIGINT NOT NULL,
  prev_hash TEXT NOT NULL,
  coordinator_id TEXT,
  checkpoint_height BIGINT,
  checkpoint_hash TEXT,
  payload_json JSONB,
  hash TEXT NOT NULL UNIQUE,
  signature TEXT NOT NULL,
  ingested_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_status_projection (
  node_id TEXT PRIMARY KEY,
  node_kind TEXT NOT NULL,
  owner_email TEXT,
  email_verified BOOLEAN,
  node_approved BOOLEAN,
  active BOOLEAN,
  source_ip TEXT,
  country_code TEXT,
  vpn_detected BOOLEAN,
  last_seen_ms BIGINT,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS coordinator_earnings_projection (
  account_id TEXT PRIMARY KEY,
  owner_email TEXT,
  total_credits DOUBLE PRECISION NOT NULL DEFAULT 0,
  task_count BIGINT NOT NULL DEFAULT 0,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  tx_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  tx_type TEXT NOT NULL,
  -- #108: exact decimal, rounded to 6 places on write (was DOUBLE PRECISION; migrated below).
  credits NUMERIC(30, 6) NOT NULL,
  reason TEXT NOT NULL,
  related_task_id TEXT,
  timestamp_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_registry (
  agent_id TEXT PRIMARY KEY,
  os TEXT NOT NULL,
  version TEXT NOT NULL,
  mode TEXT NOT NULL,
  local_model_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_ms BIGINT NOT NULL,
  active_model TEXT,
  active_model_param_size DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS blacklist_events (
  event_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_hash_sha256 TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  reporter_public_key_pem TEXT,
  reporter_signature TEXT,
  evidence_signature_verified BOOLEAN NOT NULL,
  evidence_ref TEXT,
  source_coordinator_id TEXT NOT NULL,
  reported_by TEXT NOT NULL,
  timestamp_ms BIGINT NOT NULL,
  expires_at_ms BIGINT,
  prev_event_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  coordinator_signature TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credit_accounts (
  account_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_memberships (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY (account_id, user_id)
);

CREATE TABLE IF NOT EXISTS agent_ownership (
  agent_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  machine_label TEXT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS ollama_rollouts (
  rollout_id TEXT PRIMARY KEY,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  auto_install BOOLEAN NOT NULL,
  status TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS wallet_accounts (
  account_id TEXT PRIMARY KEY,
  wallet_type TEXT NOT NULL,
  network TEXT NOT NULL,
  xpub TEXT,
  ln_node_pubkey TEXT,
  payout_address TEXT,
  encrypted_secret_ref TEXT,
  created_at_ms BIGINT NOT NULL
);
ALTER TABLE wallet_accounts ADD COLUMN IF NOT EXISTS legacy_payout_address TEXT;
ALTER TABLE wallet_accounts ADD COLUMN IF NOT EXISTS payout_invalidated_at_ms BIGINT;

CREATE TABLE IF NOT EXISTS payment_intents (
  intent_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  wallet_type TEXT NOT NULL,
  network TEXT NOT NULL,
  invoice_ref TEXT NOT NULL,
  amount_sats BIGINT NOT NULL,
  coordinator_fee_bps INT NOT NULL,
  coordinator_fee_sats BIGINT NOT NULL,
  net_sats BIGINT NOT NULL,
  quoted_credits NUMERIC(30, 6) NOT NULL, -- #153 (was DOUBLE PRECISION; migrated below)
  status TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  settled_at_ms BIGINT,
  tx_ref TEXT
);

CREATE TABLE IF NOT EXISTS price_epochs (
  epoch_id TEXT PRIMARY KEY,
  coordinator_id TEXT NOT NULL,
  resource_class TEXT NOT NULL,
  price_per_compute_unit_sats DOUBLE PRECISION NOT NULL,
  supply_index DOUBLE PRECISION NOT NULL,
  demand_index DOUBLE PRECISION NOT NULL,
  negotiated_with_json JSONB NOT NULL,
  signature TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_epochs (
  epoch_id TEXT PRIMARY KEY,
  created_at_ms BIGINT NOT NULL,
  btc_usd DOUBLE PRECISION NOT NULL,
  usd_per_cpu_hour DOUBLE PRECISION NOT NULL,
  usd_per_gpu_hour DOUBLE PRECISION NOT NULL,
  sats_per_cpu_hour DOUBLE PRECISION NOT NULL,
  sats_per_gpu_hour DOUBLE PRECISION NOT NULL,
  msat_per_credit BIGINT NOT NULL,
  markup_bps INTEGER NOT NULL,
  status TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_epochs_created ON rate_epochs (created_at_ms DESC);

CREATE TABLE IF NOT EXISTS payouts (
  payout_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  bolt11 TEXT NOT NULL,
  payment_hash TEXT NOT NULL UNIQUE,
  amount_msat BIGINT NOT NULL,
  fee_msat BIGINT NOT NULL DEFAULT 0,
  max_fee_msat BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  preimage TEXT,
  error TEXT,
  destination TEXT,
  created_at_ms BIGINT NOT NULL,
  settled_at_ms BIGINT
);
CREATE INDEX IF NOT EXISTS idx_payouts_account ON payouts (account_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_payouts_created ON payouts (created_at_ms DESC);
-- Payout kill switch and other shared payout controls (one row per key; both seeds read it).
CREATE TABLE IF NOT EXISTS payout_controls (
  control_key TEXT PRIMARY KEY,
  value_json JSONB NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS infrastructure_hosts (
  host_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  coordinator_url TEXT,
  region TEXT,
  services_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  lightning_address TEXT,
  first_seen_ms BIGINT NOT NULL,
  last_seen_ms BIGINT NOT NULL,
  heartbeats_in_window INTEGER NOT NULL DEFAULT 0
);
-- Pentest (host weight self-reported): declared vs attested services, rate-limited uptime counting.
ALTER TABLE infrastructure_hosts ADD COLUMN IF NOT EXISTS declared_services_json JSONB;
ALTER TABLE infrastructure_hosts ADD COLUMN IF NOT EXISTS attested_at_ms BIGINT;
ALTER TABLE infrastructure_hosts ADD COLUMN IF NOT EXISTS last_counted_ms BIGINT;
ALTER TABLE infrastructure_hosts ADD COLUMN IF NOT EXISTS lightning_node_id TEXT;

CREATE TABLE IF NOT EXISTS market_ticks (
  at_ms BIGINT NOT NULL,
  compute_class TEXT NOT NULL,
  reference_msat BIGINT NOT NULL,
  best_ask_msat BIGINT,
  best_bid_msat BIGINT,
  mid_msat BIGINT NOT NULL,
  clearing_msat BIGINT NOT NULL,
  agents INTEGER NOT NULL DEFAULT 0,
  open_tasks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (compute_class, at_ms)
);
CREATE TABLE IF NOT EXISTS market_trades (
  subtask_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  compute_class TEXT NOT NULL,
  msat_per_credit BIGINT NOT NULL,
  credits DOUBLE PRECISION,
  at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_market_trades_class_at ON market_trades (compute_class, at_ms DESC);
CREATE TABLE IF NOT EXISTS market_orders (
  account_id TEXT NOT NULL,
  side TEXT NOT NULL,
  compute_class TEXT NOT NULL,
  msat_per_credit BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (account_id, side)
);
-- Hardware verification (src/swarm/hardware-verification.ts): one self-contained JSON record per
-- agent (claimed vs granted tier, last challenge measurement, rolling evidence score), publishable as is.
CREATE TABLE IF NOT EXISTS hardware_verifications (
  agent_id TEXT PRIMARY KEY,
  record_json JSONB NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
-- Usage (src/economy/usage.ts): one record per settled request, for the usage page.
CREATE TABLE IF NOT EXISTS usage_records (
  usage_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  at_ms BIGINT NOT NULL,
  record_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_records_account_at ON usage_records (account_id, at_ms);
-- Reserved capacity leases (src/economy/reservations.ts): one JSON record per lease.
CREATE TABLE IF NOT EXISTS compute_reservations (
  reservation_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  record_json JSONB NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS coordinator_fee_events (
  event_id TEXT PRIMARY KEY,
  coordinator_id TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  fee_wallet_account_id TEXT NOT NULL,
  fee_sats BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS treasury_policies (
  policy_id TEXT PRIMARY KEY,
  treasury_account_id TEXT NOT NULL,
  multisig_descriptor TEXT NOT NULL,
  quorum_threshold INT NOT NULL,
  total_custodians INT NOT NULL,
  approved_coordinator_ids_json JSONB NOT NULL,
  key_rotation_days INT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS key_custody_events (
  event_id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS compute_contribution_reports (
  report_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  resource_class TEXT NOT NULL,
  cpu_seconds DOUBLE PRECISION NOT NULL,
  gpu_seconds DOUBLE PRECISION NOT NULL,
  quality_score DOUBLE PRECISION NOT NULL,
  reliability_score DOUBLE PRECISION NOT NULL,
  weighted_contribution DOUBLE PRECISION NOT NULL,
  timestamp_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS issuance_epochs (
  issuance_epoch_id TEXT PRIMARY KEY,
  coordinator_id TEXT NOT NULL,
  window_start_ms BIGINT NOT NULL,
  window_end_ms BIGINT NOT NULL,
  load_index DOUBLE PRECISION NOT NULL,
  daily_pool_tokens DOUBLE PRECISION NOT NULL,
  hourly_tokens DOUBLE PRECISION NOT NULL,
  total_weighted_contribution DOUBLE PRECISION NOT NULL,
  contribution_count INT NOT NULL,
  finalized BOOLEAN NOT NULL,
  created_at_ms BIGINT NOT NULL
);

-- One epoch per window across seeds: the id is derived from window_end_ms; this index serves the
-- read-side dedupe of rows written before that (two seeds, two random-id series).
CREATE INDEX IF NOT EXISTS idx_issuance_epochs_window_end ON issuance_epochs (window_end_ms);

CREATE TABLE IF NOT EXISTS issuance_allocations (
  allocation_id TEXT PRIMARY KEY,
  issuance_epoch_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  weighted_contribution DOUBLE PRECISION NOT NULL,
  allocation_share DOUBLE PRECISION NOT NULL,
  issued_tokens DOUBLE PRECISION NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS quorum_ledger_records (
  record_id TEXT PRIMARY KEY,
  record_type TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  signature TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS bitcoin_anchor_records (
  anchor_id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  anchor_network TEXT NOT NULL,
  tx_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  anchored_at_ms BIGINT,
  created_at_ms BIGINT NOT NULL
);
-- #46: real anchoring (txid, confirmation depth, block for reorg detection).
ALTER TABLE bitcoin_anchor_records ADD COLUMN IF NOT EXISTS confirmations INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bitcoin_anchor_records ADD COLUMN IF NOT EXISTS block_hash TEXT;
ALTER TABLE bitcoin_anchor_records ADD COLUMN IF NOT EXISTS block_height INTEGER;
ALTER TABLE bitcoin_anchor_records ADD COLUMN IF NOT EXISTS last_checked_at_ms BIGINT;
-- #103: reconciliation attempts for broadcasting / stuck rows.
ALTER TABLE bitcoin_anchor_records ADD COLUMN IF NOT EXISTS reconcile_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bitcoin_anchor_records ADD COLUMN IF NOT EXISTS abandoned_at_ms BIGINT;
CREATE INDEX IF NOT EXISTS idx_anchor_records_status ON bitcoin_anchor_records (status);
-- #101: the epoch-anchor guard looks anchors up by epoch id and by checkpoint hash.
CREATE INDEX IF NOT EXISTS idx_anchor_records_epoch ON bitcoin_anchor_records (epoch_id, created_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_anchor_records_checkpoint ON bitcoin_anchor_records (checkpoint_hash, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS issuance_payout_events (
  payout_event_id TEXT PRIMARY KEY,
  issuance_epoch_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  payout_type TEXT NOT NULL,
  tokens DOUBLE PRECISION NOT NULL,
  source_intent_id TEXT,
  created_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rollout_policies (
  rollout_id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  target_provider TEXT NOT NULL,
  stage TEXT NOT NULL,
  canary_percent INT NOT NULL DEFAULT 10,
  batch_size INT NOT NULL DEFAULT 5,
  batch_interval_ms BIGINT NOT NULL DEFAULT 60000,
  health_check_required BOOLEAN NOT NULL DEFAULT true,
  auto_promote BOOLEAN NOT NULL DEFAULT false,
  rollback_on_failure_percent INT NOT NULL DEFAULT 30,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_rollout_states (
  rollout_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  model_version TEXT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  error TEXT,
  PRIMARY KEY (rollout_id, agent_id)
);

-- Performance indexes for hot-path queries
CREATE INDEX IF NOT EXISTS idx_stats_ledger_issued_at ON stats_ledger_records (issued_at_ms ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_stats_ledger_issued_at_desc ON stats_ledger_records (issued_at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_stats_ledger_checkpoint ON stats_ledger_records (checkpoint_hash, event_type) WHERE checkpoint_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stats_ledger_event_type ON stats_ledger_records (event_type, issued_at_ms DESC) WHERE event_type = 'stats_checkpoint_commit';
-- Checkpoint targets: the newest work record at or before a boundary (signature/commit rows excluded).
CREATE INDEX IF NOT EXISTS idx_stats_ledger_data_issued_at ON stats_ledger_records (issued_at_ms DESC, id DESC)
  WHERE event_type NOT IN ('stats_checkpoint_signature', 'stats_checkpoint_commit');
CREATE INDEX IF NOT EXISTS idx_credit_transactions_account ON credit_transactions (account_id, timestamp_ms DESC);
-- #41: persistent dedupe for /credits/ble-sync
CREATE TABLE IF NOT EXISTS ble_synced_tx (
  tx_id TEXT PRIMARY KEY,
  requester_account_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  credits NUMERIC NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- #108: credit amounts are exact NUMERIC(30,6). Float rows are rounded to 6 places, which removes
-- binary artefacts like 0.30000000000000004. Runs only while the column is not yet NUMERIC(30,6),
-- under the schema lock above. Takes an ACCESS EXCLUSIVE lock and rewrites the table; a view on
-- the column makes it fail (none ship with EdgeCoder). See docs/database-migrations.md.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'credit_transactions'
               AND column_name = 'credits'
               AND (data_type <> 'numeric' OR numeric_precision IS DISTINCT FROM 30 OR numeric_scale IS DISTINCT FROM 6)) THEN
    ALTER TABLE credit_transactions ALTER COLUMN credits TYPE NUMERIC(30, 6) USING round(credits::numeric, 6);
  END IF;
END $$;
-- #153: payment_intents.quoted_credits to NUMERIC(30,6), same rules as credit_transactions.credits.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = current_schema() AND table_name = 'payment_intents'
               AND column_name = 'quoted_credits'
               AND (data_type <> 'numeric' OR numeric_precision IS DISTINCT FROM 30 OR numeric_scale IS DISTINCT FROM 6)) THEN
    ALTER TABLE payment_intents ALTER COLUMN quoted_credits TYPE NUMERIC(30, 6) USING round(quoted_credits::numeric, 6);
  END IF;
END $$;
-- #42: payment hash proof per intent (additive migration)
ALTER TABLE payment_intents ADD COLUMN IF NOT EXISTS payment_hash TEXT;
-- Sats value locked on credit rows (earn: payable msat at accrual, at the market/oracle rate of that moment).
ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS msat BIGINT;
-- Unique indexes are created only when no duplicate rows exist, so migrate() can never
-- fail on legacy data; otherwise a WARNING is logged and the duplicates must be cleaned up.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_payment_intents_payment_hash') THEN
    IF EXISTS (SELECT payment_hash FROM payment_intents WHERE payment_hash IS NOT NULL
               GROUP BY payment_hash HAVING COUNT(*) > 1) THEN
      RAISE WARNING 'idx_payment_intents_payment_hash not created: duplicate payment_hash rows exist';
    ELSE
      CREATE UNIQUE INDEX idx_payment_intents_payment_hash ON payment_intents (payment_hash) WHERE payment_hash IS NOT NULL;
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_credit_tx_credit_purchase_once') THEN
    IF EXISTS (SELECT reason FROM credit_transactions WHERE reason LIKE 'credit_purchase:%'
               GROUP BY reason HAVING COUNT(*) > 1) THEN
      RAISE WARNING 'idx_credit_tx_credit_purchase_once not created: duplicate credit_purchase rows exist';
    ELSE
      CREATE UNIQUE INDEX idx_credit_tx_credit_purchase_once ON credit_transactions (reason) WHERE reason LIKE 'credit_purchase:%';
    END IF;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_ledger_records_issued_at ON ledger_records (issued_at_ms ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_blacklist_events_agent ON blacklist_events (agent_id, timestamp_ms DESC);
CREATE INDEX IF NOT EXISTS idx_queue_tasks_status ON queue_tasks (project_id, priority DESC, created_at_ms ASC);
-- Signed work receipts (architecture step 2): replicated between coordinators, batched into
-- Merkle epochs whose roots are anchored on Bitcoin. receipt_json keeps the full signed
-- receipt (PEM keys and both signatures); the columns are for indexing.
CREATE TABLE IF NOT EXISTS work_receipts (
  receipt_id TEXT PRIMARY KEY,
  seq BIGSERIAL,
  task_id TEXT NOT NULL,
  subtask_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL,
  compute_class TEXT NOT NULL,
  credits DOUBLE PRECISION NOT NULL,
  msat BIGINT NOT NULL,
  msat_per_credit BIGINT NOT NULL,
  started_at_ms BIGINT NOT NULL,
  finished_at_ms BIGINT NOT NULL,
  result_hash TEXT NOT NULL,
  receipt_json JSONB NOT NULL,
  epoch_id TEXT,
  stored_at_ms BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_receipts_seq ON work_receipts (seq);
CREATE INDEX IF NOT EXISTS idx_work_receipts_open ON work_receipts (coordinator_id, finished_at_ms) WHERE epoch_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_work_receipts_epoch ON work_receipts (epoch_id);
CREATE TABLE IF NOT EXISTS receipt_epochs (
  epoch_id TEXT PRIMARY KEY,
  coordinator_id TEXT NOT NULL,
  from_ms BIGINT NOT NULL,
  to_ms BIGINT NOT NULL,
  count INTEGER NOT NULL,
  merkle_root TEXT NOT NULL,
  previous_root TEXT,
  signature TEXT NOT NULL,
  closed_at_ms BIGINT NOT NULL,
  anchor_tx_ref TEXT,
  anchor_network TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipt_epochs_coordinator ON receipt_epochs (coordinator_id, to_ms DESC, closed_at_ms DESC);

-- Signed agent request nonces (replay protection), shared by every coordinator on this database.
-- The primary key is the atomic replay check; rows are pruned after expires_at_ms.
CREATE TABLE IF NOT EXISTS request_nonces (
  nonce TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_nonces_expiry ON request_nonces (expires_at_ms);

-- LNURL callback pins (src/economy/lnurl-callback-pin.ts): the callback origin a payout
-- destination resolved to on first use. changed_origin is set while a different origin waits for
-- the owner's emailed-code confirmation; notified_at_ms makes the owner notification one-shot.
CREATE TABLE IF NOT EXISTS payout_callback_pins (
  account_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  callback_origin TEXT NOT NULL,
  pinned_at_ms BIGINT NOT NULL,
  changed_origin TEXT,
  changed_at_ms BIGINT,
  notified_at_ms BIGINT,
  PRIMARY KEY (account_id, destination)
);
`;

/** See PostgresStore.invalidateServerSeedWallets. A Lightning wallet row holding an on-chain address is the same flow's output. */
export const INVALIDATE_SERVER_SEED_WALLETS_SQL = `UPDATE wallet_accounts
  SET legacy_payout_address = payout_address, payout_address = NULL, encrypted_secret_ref = NULL, payout_invalidated_at_ms = $1
  WHERE encrypted_secret_ref LIKE 'seed-sha256:%'
     OR (wallet_type = 'lightning' AND payout_address ~* '^(bc1|tb1|bcrt1)[a-z0-9]+$')`;

/** Balance and "enough to cover $2" computed in SQL on NUMERIC, so no float comparison (#108). */
const BALANCE_CHECK_SQL = `SELECT COALESCE(SUM(CASE WHEN tx_type = 'spend' THEN -credits ELSE credits END), 0) AS balance,
         COALESCE(SUM(CASE WHEN tx_type = 'spend' THEN -credits ELSE credits END), 0) >= round($2::numeric, 6) AS enough
         FROM credit_transactions WHERE account_id = $1`;

export class PostgresStore {
  constructor(private readonly pool: Pool) {}

  static fromEnv(): PostgresStore | null {
    const url = process.env.DATABASE_URL;
    if (!url) return null;
    const pool = new Pool({ connectionString: url });
    return new PostgresStore(pool);
  }

  async migrate(): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
    await this.invalidateServerSeedWallets();
  }

  /**
   * Retire payout addresses the portal derived from seeds it generated itself (the removed
   * wallet onboarding flow registered them with a `seed-sha256:` secret ref). Nobody holds those
   * keys, so the address moves to legacy_payout_address and payout_address becomes NULL:
   * listAutoPayoutAccounts skips the account and its earnings stay payable until the user sets a
   * destination. Ledger and payout rows are untouched. Idempotent (the ref is cleared).
   */
  async invalidateServerSeedWallets(nowMs = Date.now()): Promise<number> {
    const r = await this.pool.query(INVALIDATE_SERVER_SEED_WALLETS_SQL, [nowMs]);
    return Number(r.rowCount ?? 0);
  }

  /** Work receipts and Merkle epochs (src/receipts) on the same pool. */
  receiptStore(): PostgresReceiptStore {
    return new PostgresReceiptStore(this.pool);
  }

  /** Request-signing nonces (src/security/nonce-verifier.ts) on the same pool. */
  nonceStore(): PostgresNonceStore {
    return new PostgresNonceStore(this.pool);
  }

  /** LNURL callback pins (src/economy/lnurl-callback-pin.ts) on the same pool. */
  callbackPinStore(): PostgresCallbackPinStore {
    return new PostgresCallbackPinStore(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async persistSubtask(subtask: Subtask): Promise<void> {
    await this.pool.query(
      `INSERT INTO queue_tasks (
         subtask_id, task_id, payload_json, project_id, tenant_id, resource_class, priority, created_at_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (subtask_id) DO UPDATE SET payload_json = EXCLUDED.payload_json`,
      [
        subtask.id,
        subtask.taskId,
        JSON.stringify(subtask),
        subtask.projectMeta.projectId,
        subtask.projectMeta.tenantId ?? null,
        subtask.projectMeta.resourceClass,
        subtask.projectMeta.priority,
        Date.now()
      ]
    );
  }

  async markSubtaskClaimed(subtaskId: string, agentId: string, claimedAtMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE queue_tasks SET claimed_by = $2, claimed_at_ms = $3 WHERE subtask_id = $1`,
      [subtaskId, agentId, claimedAtMs]
    );
  }

  async persistResult(result: SubtaskResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO queue_results (
         subtask_id, task_id, agent_id, ok, output, error, duration_ms, report_nonce, report_signature, created_at_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (subtask_id) DO UPDATE SET
         ok = EXCLUDED.ok,
         output = EXCLUDED.output,
         error = EXCLUDED.error,
         duration_ms = EXCLUDED.duration_ms,
         report_nonce = EXCLUDED.report_nonce,
         report_signature = EXCLUDED.report_signature`,
      [
        result.subtaskId,
        result.taskId,
        result.agentId,
        result.ok,
        result.output,
        result.error ?? null,
        result.durationMs,
        result.reportNonce ?? null,
        result.reportSignature ?? null,
        Date.now()
      ]
    );
  }

  async persistLedgerRecord(record: QueueEventRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO ledger_records (
         id, event_type, task_id, subtask_id, actor_id, sequence, issued_at_ms, prev_hash, hash, signature
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        record.id,
        record.eventType,
        record.taskId,
        record.subtaskId ?? null,
        record.actorId,
        record.sequence,
        record.issuedAtMs,
        record.prevHash,
        record.hash,
        record.signature
      ]
    );
  }

  /**
   * Returns true only when this call stored the row. A record already present (same id or hash:
   * written by another coordinator on this database, or re-ingested by sync) returns false, so
   * callers apply its projections exactly once.
   */
  async persistStatsLedgerRecord(record: QueueEventRecord): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO stats_ledger_records (
         id, event_type, task_id, subtask_id, actor_id, sequence, issued_at_ms, prev_hash,
         coordinator_id, checkpoint_height, checkpoint_hash, payload_json, hash, signature, ingested_at_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT DO NOTHING`,
      [
        record.id,
        record.eventType,
        record.taskId,
        record.subtaskId ?? null,
        record.actorId,
        record.sequence,
        record.issuedAtMs,
        record.prevHash,
        record.coordinatorId ?? null,
        record.checkpointHeight ?? null,
        record.checkpointHash ?? null,
        record.payloadJson ? JSON.parse(record.payloadJson) : null,
        record.hash,
        record.signature,
        Date.now()
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listStatsLedgerRecords(limit = 1000): Promise<QueueEventRecord[]> {
    const result = await this.pool.query(
      `SELECT
         id, event_type, task_id, subtask_id, actor_id, sequence, issued_at_ms, prev_hash,
         coordinator_id, checkpoint_height, checkpoint_hash, payload_json, hash, signature
       FROM stats_ledger_records
       ORDER BY issued_at_ms ASC, id ASC
       LIMIT $1`,
      [Math.max(1, Math.min(5000, limit))]
    );
    return result.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      taskId: row.task_id,
      subtaskId: row.subtask_id ?? undefined,
      actorId: row.actor_id,
      sequence: Number(row.sequence),
      issuedAtMs: Number(row.issued_at_ms),
      prevHash: row.prev_hash,
      coordinatorId: row.coordinator_id ?? undefined,
      checkpointHeight: row.checkpoint_height ? Number(row.checkpoint_height) : undefined,
      checkpointHash: row.checkpoint_hash ?? undefined,
      payloadJson: row.payload_json ? JSON.stringify(row.payload_json) : undefined,
      hash: row.hash,
      signature: row.signature
    }));
  }

  async checkpointSignatureStatus(checkpointHash: string): Promise<{ hasCommit: boolean; signers: string[] }> {
    const result = await this.pool.query(
      `SELECT event_type, COALESCE(coordinator_id, actor_id) AS signer
       FROM stats_ledger_records
       WHERE checkpoint_hash = $1
         AND event_type IN ('stats_checkpoint_commit', 'stats_checkpoint_signature')`,
      [checkpointHash]
    );
    let hasCommit = false;
    const signers = new Set<string>();
    for (const row of result.rows) {
      if (row.event_type === "stats_checkpoint_commit") hasCommit = true;
      if (row.event_type === "stats_checkpoint_signature") signers.add(row.signer);
    }
    return { hasCommit, signers: [...signers] };
  }

  async latestStatsCheckpoint(): Promise<{ hash: string; height: number | null; issuedAtMs: number } | null> {
    const result = await this.pool.query(
      `SELECT checkpoint_hash, checkpoint_height, issued_at_ms
       FROM stats_ledger_records
       WHERE event_type = 'stats_checkpoint_commit' AND checkpoint_hash IS NOT NULL
       ORDER BY issued_at_ms DESC, id DESC
       LIMIT 1`
    );
    if (!result.rows[0]) return null;
    return {
      hash: result.rows[0].checkpoint_hash,
      height: result.rows[0].checkpoint_height ? Number(result.rows[0].checkpoint_height) : null,
      issuedAtMs: Number(result.rows[0].issued_at_ms),
    };
  }

  async listStatsLedgerSince(sinceIssuedAtMs: number, limit = 1000): Promise<QueueEventRecord[]> {
    const result = await this.pool.query(
      `SELECT
         id, event_type, task_id, subtask_id, actor_id, sequence, issued_at_ms, prev_hash,
         coordinator_id, checkpoint_height, checkpoint_hash, payload_json, hash, signature
       FROM stats_ledger_records
       WHERE issued_at_ms > $1
       ORDER BY issued_at_ms ASC, id ASC
       LIMIT $2`,
      [sinceIssuedAtMs, Math.max(1, Math.min(5000, limit))]
    );
    return result.rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      taskId: row.task_id,
      subtaskId: row.subtask_id ?? undefined,
      actorId: row.actor_id,
      sequence: Number(row.sequence),
      issuedAtMs: Number(row.issued_at_ms),
      prevHash: row.prev_hash,
      coordinatorId: row.coordinator_id ?? undefined,
      checkpointHeight: row.checkpoint_height ? Number(row.checkpoint_height) : undefined,
      checkpointHash: row.checkpoint_hash ?? undefined,
      payloadJson: row.payload_json ? JSON.stringify(row.payload_json) : undefined,
      hash: row.hash,
      signature: row.signature
    }));
  }

  /**
   * The checkpoint target for a boundary: the newest work record issued at or before `atOrBeforeMs`.
   * Signature and commit rows are excluded, so signing never moves the target and every
   * coordinator on this database (or with this data synced) picks the same record.
   */
  async latestStatsDataRecordAtOrBefore(atOrBeforeMs: number): Promise<{ hash: string; issuedAtMs: number; height: number } | null> {
    const result = await this.pool.query(
      `SELECT s.hash, s.issued_at_ms, GREATEST(c.reltuples, 0)::BIGINT AS height
       FROM stats_ledger_records s, pg_class c
       WHERE c.oid = 'stats_ledger_records'::regclass
         AND s.event_type NOT IN ('stats_checkpoint_signature', 'stats_checkpoint_commit')
         AND s.issued_at_ms <= $1
       ORDER BY s.issued_at_ms DESC, s.id DESC
       LIMIT 1`,
      [atOrBeforeMs]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { hash: row.hash, issuedAtMs: Number(row.issued_at_ms), height: Number(row.height ?? 0) };
  }

  /**
   * Session advisory lock (blocking) on a dedicated connection: coordinators sharing this database
   * take turns signing, so the second one sees the first one's signature and commits.
   */
  async withStatsCheckpointLock<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1, $2)", [STATS_CHECKPOINT_LOCK_NAMESPACE, STATS_CHECKPOINT_LOCK_KEY]);
      try {
        return await fn();
      } finally {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [STATS_CHECKPOINT_LOCK_NAMESPACE, STATS_CHECKPOINT_LOCK_KEY]).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  async latestStatsLedgerHead(): Promise<{
    issuedAtMs: number;
    hash: string;
    count: number;
  } | null> {
    const result = await this.pool.query(
      `SELECT s.issued_at_ms, s.hash, GREATEST(c.reltuples, 0)::BIGINT AS count
       FROM stats_ledger_records s,
            pg_class c
       WHERE c.oid = 'stats_ledger_records'::regclass
       ORDER BY s.issued_at_ms DESC, s.id DESC
       LIMIT 1`
    );
    if (!result.rows[0]) return null;
    return {
      issuedAtMs: Number(result.rows[0].issued_at_ms),
      hash: result.rows[0].hash,
      count: Number(result.rows[0]?.count ?? 0)
    };
  }

  async upsertNodeStatusProjection(input: {
    nodeId: string;
    nodeKind: "agent" | "coordinator";
    ownerEmail?: string;
    emailVerified?: boolean;
    nodeApproved?: boolean;
    active?: boolean;
    sourceIp?: string;
    countryCode?: string;
    vpnDetected?: boolean;
    lastSeenMs?: number;
    updatedAtMs: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO node_status_projection (
        node_id, node_kind, owner_email, email_verified, node_approved, active, source_ip, country_code, vpn_detected, last_seen_ms, updated_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (node_id) DO UPDATE SET
        node_kind = EXCLUDED.node_kind,
        owner_email = COALESCE(EXCLUDED.owner_email, node_status_projection.owner_email),
        email_verified = COALESCE(EXCLUDED.email_verified, node_status_projection.email_verified),
        node_approved = COALESCE(EXCLUDED.node_approved, node_status_projection.node_approved),
        active = COALESCE(EXCLUDED.active, node_status_projection.active),
        source_ip = COALESCE(EXCLUDED.source_ip, node_status_projection.source_ip),
        country_code = COALESCE(EXCLUDED.country_code, node_status_projection.country_code),
        vpn_detected = COALESCE(EXCLUDED.vpn_detected, node_status_projection.vpn_detected),
        last_seen_ms = COALESCE(EXCLUDED.last_seen_ms, node_status_projection.last_seen_ms),
        updated_at_ms = EXCLUDED.updated_at_ms`,
      [
        input.nodeId,
        input.nodeKind,
        input.ownerEmail ?? null,
        input.emailVerified ?? null,
        input.nodeApproved ?? null,
        input.active ?? null,
        input.sourceIp ?? null,
        input.countryCode ?? null,
        input.vpnDetected ?? null,
        input.lastSeenMs ?? null,
        input.updatedAtMs
      ]
    );
  }

  async listNodeStatusProjection(ownerEmail?: string): Promise<
    Array<{
      nodeId: string;
      nodeKind: string;
      ownerEmail?: string;
      emailVerified?: boolean;
      nodeApproved?: boolean;
      active?: boolean;
      sourceIp?: string;
      countryCode?: string;
      vpnDetected?: boolean;
      lastSeenMs?: number;
      updatedAtMs: number;
    }>
  > {
    const where = ownerEmail ? "WHERE lower(owner_email) = lower($1)" : "";
    const args = ownerEmail ? [ownerEmail] : [];
    const result = await this.pool.query(
      `SELECT
         node_id, node_kind, owner_email, email_verified, node_approved, active,
         source_ip, country_code, vpn_detected, last_seen_ms, updated_at_ms
       FROM node_status_projection
       ${where}
       ORDER BY updated_at_ms DESC`,
      args
    );
    return result.rows.map((row) => ({
      nodeId: row.node_id,
      nodeKind: row.node_kind,
      ownerEmail: row.owner_email ?? undefined,
      emailVerified: row.email_verified === null ? undefined : Boolean(row.email_verified),
      nodeApproved: row.node_approved === null ? undefined : Boolean(row.node_approved),
      active: row.active === null ? undefined : Boolean(row.active),
      sourceIp: row.source_ip ?? undefined,
      countryCode: row.country_code ?? undefined,
      vpnDetected: row.vpn_detected === null ? undefined : Boolean(row.vpn_detected),
      lastSeenMs: row.last_seen_ms ? Number(row.last_seen_ms) : undefined,
      updatedAtMs: Number(row.updated_at_ms)
    }));
  }

  async incrementCoordinatorEarningsProjection(input: {
    accountId: string;
    ownerEmail?: string;
    credits: number;
    taskCountDelta?: number;
    updatedAtMs: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO coordinator_earnings_projection (
        account_id, owner_email, total_credits, task_count, updated_at_ms
      ) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (account_id) DO UPDATE SET
        owner_email = COALESCE(EXCLUDED.owner_email, coordinator_earnings_projection.owner_email),
        total_credits = coordinator_earnings_projection.total_credits + EXCLUDED.total_credits,
        task_count = coordinator_earnings_projection.task_count + EXCLUDED.task_count,
        updated_at_ms = EXCLUDED.updated_at_ms`,
      [input.accountId, input.ownerEmail ?? null, input.credits, input.taskCountDelta ?? 0, input.updatedAtMs]
    );
  }

  async listCoordinatorEarningsProjection(ownerEmail?: string): Promise<
    Array<{ accountId: string; ownerEmail?: string; totalCredits: number; taskCount: number; updatedAtMs: number }>
  > {
    const where = ownerEmail ? "WHERE lower(owner_email) = lower($1)" : "";
    const args = ownerEmail ? [ownerEmail] : [];
    const result = await this.pool.query(
      `SELECT account_id, owner_email, total_credits, task_count, updated_at_ms
       FROM coordinator_earnings_projection
       ${where}
       ORDER BY total_credits DESC, updated_at_ms DESC`,
      args
    );
    return result.rows.map((row) => ({
      accountId: row.account_id,
      ownerEmail: row.owner_email ?? undefined,
      totalCredits: Number(row.total_credits),
      taskCount: Number(row.task_count),
      updatedAtMs: Number(row.updated_at_ms)
    }));
  }

  async persistCreditTransaction(tx: CreditTransaction): Promise<void> {
    await this.pool.query(
      `INSERT INTO credit_transactions (
         tx_id, account_id, tx_type, credits, reason, related_task_id, timestamp_ms, msat
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tx_id) DO NOTHING`,
      [tx.txId, tx.accountId, tx.type, tx.credits, tx.reason, tx.relatedTaskId ?? null, tx.timestampMs, tx.msat ?? null]
    );
  }

  /** Several credit rows in one transaction (fee-pool distribution: pool spend + host earns). */
  async recordCreditTransactions(rows: CreditTransaction[]): Promise<void> {
    if (rows.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const tx of rows) {
        await client.query(
          `INSERT INTO credit_transactions (tx_id, account_id, tx_type, credits, reason, related_task_id, timestamp_ms, msat)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tx_id) DO NOTHING`,
          [tx.txId, tx.accountId, tx.type, tx.credits, tx.reason, tx.relatedTaskId ?? null, tx.timestampMs, tx.msat ?? null]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Lightning address (user@domain or LNURL) used for automatic payouts of an account. */
  async setLightningAddress(accountId: string, lightningAddress: string | null, network: string): Promise<void> {
    // A new destination starts unpinned; the old destination's pin (and any pending change) goes.
    await this.callbackPinStore().resetCallbackPins(accountId, lightningAddress);
    await this.pool.query(
      `INSERT INTO wallet_accounts (account_id, wallet_type, network, payout_address, created_at_ms)
       VALUES ($1, 'lightning', $3, $2, $4)
       ON CONFLICT (account_id) DO UPDATE SET payout_address = EXCLUDED.payout_address,
         payout_invalidated_at_ms = CASE WHEN EXCLUDED.payout_address IS NULL THEN wallet_accounts.payout_invalidated_at_ms ELSE NULL END`,
      [accountId, lightningAddress, network, Date.now()]
    );
  }

  /** msat moved out of an account by spend rows (the fee pool's past distributions). */
  async distributedMsat(accountId: string): Promise<number> {
    const r = await this.pool.query(`SELECT COALESCE(SUM(msat), 0) AS msat FROM credit_transactions WHERE account_id = $1 AND tx_type = 'spend'`, [accountId]);
    return Number(r.rows[0]?.msat ?? 0);
  }

  /** Sats (msat) earned by an account, as locked on its earn rows. */
  async earnedMsat(accountId: string): Promise<number> {
    const r = await this.pool.query(`SELECT COALESCE(SUM(msat), 0) AS msat FROM credit_transactions WHERE account_id = $1 AND tx_type = 'earn'`, [accountId]);
    return Number(r.rows[0]?.msat ?? 0);
  }

  /**
   * #48: atomic debit. The balance check and the spend row commit in one
   * transaction under the same per-account advisory lock as applyBleTransfer,
   * so concurrent debits of one account serialise and the balance can't go negative.
   */
  async debitCredits(tx: CreditTransaction): Promise<{ status: "applied" | "insufficient" | "duplicate"; balance: number }> {
    if (tx.type !== "spend") throw new Error("debitCredits requires a spend transaction");
    if (!Number.isFinite(tx.credits) || tx.credits <= 0) throw new Error("invalid_credit_amount");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [CREDIT_LOCK_NAMESPACE, tx.accountId]);
      // A deterministic tx id (spendCredits with an idempotency key) already charged, here or by
      // another coordinator on this database: charge nothing. Checked under the account lock, so
      // two coordinators debiting the same key at once serialise and only one row is written.
      const seen = await client.query("SELECT 1 FROM credit_transactions WHERE tx_id = $1", [tx.txId]);
      if ((seen.rowCount ?? 0) > 0) {
        await client.query("ROLLBACK");
        return { status: "duplicate", balance: 0 };
      }
      const bal = await client.query(BALANCE_CHECK_SQL, [tx.accountId, String(tx.credits)]);
      const balance = Number(bal.rows[0]?.balance ?? 0);
      if (bal.rows[0]?.enough !== true) {
        await client.query("ROLLBACK");
        return { status: "insufficient", balance };
      }
      await client.query(
        `INSERT INTO credit_transactions (tx_id, account_id, tx_type, credits, reason, related_task_id, timestamp_ms)
         VALUES ($1,$2,'spend',$3,$4,$5,$6)`,
        [tx.txId, tx.accountId, tx.credits, tx.reason, tx.relatedTaskId ?? null, tx.timestampMs]
      );
      await client.query("COMMIT");
      return { status: "applied", balance: balance - tx.credits };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * #41: atomic BLE transfer. Dedupe row, balance check and the spend/earn pair
   * commit together; a per-requester advisory lock serialises concurrent debits.
   */
  async applyBleTransfer(tx: {
    txId: string;
    requesterAccountId: string;
    providerAccountId: string;
    credits: number;
  }): Promise<"applied" | "duplicate" | "insufficient"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [CREDIT_LOCK_NAMESPACE, tx.requesterAccountId]);
      const ins = await client.query(
        `INSERT INTO ble_synced_tx (tx_id, requester_account_id, provider_account_id, credits)
         VALUES ($1,$2,$3,$4) ON CONFLICT (tx_id) DO NOTHING RETURNING tx_id`,
        [tx.txId, tx.requesterAccountId, tx.providerAccountId, tx.credits]
      );
      if ((ins.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return "duplicate";
      }
      const bal = await client.query(BALANCE_CHECK_SQL, [tx.requesterAccountId, String(tx.credits)]);
      if (bal.rows[0]?.enough !== true) {
        await client.query("ROLLBACK");
        return "insufficient";
      }
      const now = Date.now();
      await client.query(
        `INSERT INTO credit_transactions (tx_id, account_id, tx_type, credits, reason, related_task_id, timestamp_ms)
         VALUES ($1,$2,'spend',$3,'ble_compute',$4,$5), ($6,$7,'earn',$3,'ble_compute',$4,$5)`,
        [randomUUID(), tx.requesterAccountId, tx.credits, `ble:${tx.txId}`, now, randomUUID(), tx.providerAccountId]
      );
      await client.query("COMMIT");
      return "applied";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async creditBalance(accountId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COALESCE(
        SUM(CASE WHEN tx_type = 'spend' THEN -credits ELSE credits END), 0
      ) AS balance
      FROM credit_transactions
      WHERE account_id = $1`,
      [accountId]
    );
    return Number(result.rows[0]?.balance ?? 0);
  }

  async creditHistory(accountId: string): Promise<CreditTransaction[]> {
    const result = await this.pool.query(
      `SELECT tx_id, account_id, tx_type, credits, reason, related_task_id, timestamp_ms
       FROM credit_transactions
       WHERE account_id = $1
       ORDER BY timestamp_ms DESC`,
      [accountId]
    );
    return result.rows.map((row) => ({
      txId: row.tx_id,
      accountId: row.account_id,
      type: row.tx_type,
      credits: Number(row.credits),
      reason: row.reason,
      relatedTaskId: row.related_task_id ?? undefined,
      timestampMs: Number(row.timestamp_ms)
    }));
  }

  /** Inputs to the contribute-first policy: compute earnings, submit spend, and sats-purchased credits. */
  async creditContributionStats(accountId: string): Promise<{ earned: number; spent: number; purchased: number }> {
    const result = await this.pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tx_type = 'earn' AND reason = 'compute_contribution' THEN credits ELSE 0 END), 0) AS earned,
         COALESCE(SUM(CASE WHEN tx_type = 'spend' AND reason = 'task_submit' THEN credits ELSE 0 END), 0) AS spent,
         COALESCE(SUM(CASE WHEN tx_type = 'earn' AND reason LIKE 'credit_purchase:%' THEN credits ELSE 0 END), 0) AS purchased
       FROM credit_transactions
       WHERE account_id = $1`,
      [accountId]
    );
    return {
      earned: Number(result.rows[0]?.earned ?? 0),
      spent: Number(result.rows[0]?.spent ?? 0),
      purchased: Number(result.rows[0]?.purchased ?? 0)
    };
  }

  async persistComputeContributionReport(input: {
    report: ComputeContributionReport;
    accountId: string;
    sourceAgentId: string;
    reliabilityScore: number;
    weightedContribution: number;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO compute_contribution_reports (
        report_id, account_id, source_agent_id, task_id, resource_class, cpu_seconds, gpu_seconds,
        quality_score, reliability_score, weighted_contribution, timestamp_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (report_id) DO NOTHING
      RETURNING report_id`,
      [
        input.report.reportId,
        input.accountId,
        input.sourceAgentId,
        input.report.taskId,
        input.report.resourceClass,
        input.report.cpuSeconds,
        input.report.gpuSeconds,
        input.report.qualityScore,
        input.reliabilityScore,
        input.weightedContribution,
        input.report.timestampMs
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * #44 review: report row and its credit row in ONE transaction. Returns false (and writes
   * nothing) when the report id already exists, so a retry can never lose or double a credit.
   */
  async persistContributionWithCredit(
    input: {
      report: ComputeContributionReport;
      accountId: string;
      sourceAgentId: string;
      reliabilityScore: number;
      weightedContribution: number;
    },
    tx: CreditTransaction,
    feeTx?: CreditTransaction
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO compute_contribution_reports (
        report_id, account_id, source_agent_id, task_id, resource_class, cpu_seconds, gpu_seconds,
        quality_score, reliability_score, weighted_contribution, timestamp_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (report_id) DO NOTHING
      RETURNING report_id`,
        [
          input.report.reportId,
          input.accountId,
          input.sourceAgentId,
          input.report.taskId,
          input.report.resourceClass,
          input.report.cpuSeconds,
          input.report.gpuSeconds,
          input.report.qualityScore,
          input.reliabilityScore,
          input.weightedContribution,
          input.report.timestampMs
        ]
      );
      if ((result.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      for (const row of [tx, ...(feeTx ? [feeTx] : [])]) {
        if (row.credits <= 0) continue;
        await client.query(
          `INSERT INTO credit_transactions (
             tx_id, account_id, tx_type, credits, reason, related_task_id, timestamp_ms, msat
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [row.txId, row.accountId, row.type, row.credits, row.reason, row.relatedTaskId ?? null, row.timestampMs, row.msat ?? null]
        );
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async rollingContributionShares(windowStartMs: number, windowEndMs: number): Promise<RollingContributionShare[]> {
    const result = await this.pool.query(
      `SELECT
         account_id,
         COALESCE(SUM(cpu_seconds), 0) AS cpu_seconds,
         COALESCE(SUM(gpu_seconds), 0) AS gpu_seconds,
         COALESCE(AVG(quality_score), 0) AS avg_quality_score,
         COALESCE(AVG(reliability_score), 0) AS reliability_score,
         COALESCE(SUM(weighted_contribution), 0) AS weighted_contribution
       FROM compute_contribution_reports
       WHERE timestamp_ms >= $1 AND timestamp_ms <= $2
       GROUP BY account_id
       ORDER BY weighted_contribution DESC`,
      [windowStartMs, windowEndMs]
    );
    return result.rows.map((row) => ({
      accountId: row.account_id,
      cpuSeconds: Number(row.cpu_seconds),
      gpuSeconds: Number(row.gpu_seconds),
      avgQualityScore: Number(row.avg_quality_score),
      reliabilityScore: Number(row.reliability_score),
      weightedContribution: Number(row.weighted_contribution)
    }));
  }

  async upsertIssuanceEpoch(record: IssuanceEpochRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO issuance_epochs (
        issuance_epoch_id, coordinator_id, window_start_ms, window_end_ms, load_index, daily_pool_tokens,
        hourly_tokens, total_weighted_contribution, contribution_count, finalized, created_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (issuance_epoch_id) DO UPDATE SET
        load_index = EXCLUDED.load_index,
        daily_pool_tokens = EXCLUDED.daily_pool_tokens,
        hourly_tokens = EXCLUDED.hourly_tokens,
        total_weighted_contribution = EXCLUDED.total_weighted_contribution,
        contribution_count = EXCLUDED.contribution_count,
        finalized = EXCLUDED.finalized`,
      [
        record.issuanceEpochId,
        record.coordinatorId,
        record.windowStartMs,
        record.windowEndMs,
        record.loadIndex,
        record.dailyPoolTokens,
        record.hourlyTokens,
        record.totalWeightedContribution,
        record.contributionCount,
        record.finalized,
        record.createdAtMs
      ]
    );
  }

  async replaceIssuanceAllocations(epochId: string, rows: IssuanceAllocationRecord[]): Promise<void> {
    await this.pool.query(`DELETE FROM issuance_allocations WHERE issuance_epoch_id = $1`, [epochId]);
    for (const row of rows) {
      await this.pool.query(
        `INSERT INTO issuance_allocations (
          allocation_id, issuance_epoch_id, account_id, weighted_contribution, allocation_share, issued_tokens, created_at_ms
        ) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (allocation_id) DO NOTHING`,
        [
          row.allocationId,
          row.issuanceEpochId,
          row.accountId,
          row.weightedContribution,
          row.allocationShare,
          row.issuedTokens,
          row.createdAtMs
        ]
      );
    }
  }

  /**
   * The newest issuance window's epoch. Legacy duplicates (two seeds writing the same window with
   * random ids) are collapsed by bucketing window_end_ms on the recalc interval and keeping the
   * earliest row per bucket, so every seed reports the same "current" epoch.
   */
  async latestIssuanceEpoch(finalizedOnly = false, bucketMs = DEFAULT_ISSUANCE_BUCKET_MS): Promise<IssuanceEpochRecord | null> {
    const where = finalizedOnly ? "WHERE finalized = TRUE" : "";
    const result = await this.pool.query(
      `SELECT issuance_epoch_id, coordinator_id, window_start_ms, window_end_ms, load_index, daily_pool_tokens,
              hourly_tokens, total_weighted_contribution, contribution_count, finalized, created_at_ms
       FROM issuance_epochs
       ${where}
       ORDER BY window_end_ms / $1::bigint DESC, created_at_ms ASC, issuance_epoch_id ASC
       LIMIT 1`,
      [Math.max(1, Math.floor(bucketMs))]
    );
    const row = result.rows[0];
    if (!row) return null;
    return mapIssuanceEpochRow(row);
  }

  /** Session advisory lock: seeds sharing this database create (and finalize) epochs one at a time. */
  async withIssuanceLock<T>(fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1, $2)", [ISSUANCE_LOCK_NAMESPACE, ISSUANCE_LOCK_KEY]);
      try {
        return await fn();
      } finally {
        await client.query("SELECT pg_advisory_unlock($1, $2)", [ISSUANCE_LOCK_NAMESPACE, ISSUANCE_LOCK_KEY]).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Writes an epoch and its allocations in one transaction, only if no epoch with this id exists.
   * Returns false (and writes nothing) when another seed, or an earlier run, already created it.
   */
  async createIssuanceEpoch(record: IssuanceEpochRecord, allocations: IssuanceAllocationRecord[]): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO issuance_epochs (
          issuance_epoch_id, coordinator_id, window_start_ms, window_end_ms, load_index, daily_pool_tokens,
          hourly_tokens, total_weighted_contribution, contribution_count, finalized, created_at_ms
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (issuance_epoch_id) DO NOTHING`,
        [
          record.issuanceEpochId,
          record.coordinatorId,
          record.windowStartMs,
          record.windowEndMs,
          record.loadIndex,
          record.dailyPoolTokens,
          record.hourlyTokens,
          record.totalWeightedContribution,
          record.contributionCount,
          record.finalized,
          record.createdAtMs
        ]
      );
      if ((inserted.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      for (const row of allocations) {
        await client.query(
          `INSERT INTO issuance_allocations (
            allocation_id, issuance_epoch_id, account_id, weighted_contribution, allocation_share, issued_tokens, created_at_ms
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (allocation_id) DO NOTHING`,
          [row.allocationId, row.issuanceEpochId, row.accountId, row.weightedContribution, row.allocationShare, row.issuedTokens, row.createdAtMs]
        );
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markIssuanceEpochFinalized(issuanceEpochId: string): Promise<void> {
    await this.pool.query(`UPDATE issuance_epochs SET finalized = TRUE WHERE issuance_epoch_id = $1`, [issuanceEpochId]);
  }

  async getIssuanceEpoch(issuanceEpochId: string): Promise<IssuanceEpochRecord | null> {
    const result = await this.pool.query(
      `SELECT issuance_epoch_id, coordinator_id, window_start_ms, window_end_ms, load_index, daily_pool_tokens,
              hourly_tokens, total_weighted_contribution, contribution_count, finalized, created_at_ms
       FROM issuance_epochs
       WHERE issuance_epoch_id = $1
       LIMIT 1`,
      [issuanceEpochId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return mapIssuanceEpochRow(row);
  }

  /** Issuance history, one row per window (legacy duplicates collapse to the earliest per bucket). */
  async listIssuanceEpochs(limit = 50, bucketMs = DEFAULT_ISSUANCE_BUCKET_MS): Promise<IssuanceEpochRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM (
         SELECT DISTINCT ON (window_end_ms / $2::bigint)
                issuance_epoch_id, coordinator_id, window_start_ms, window_end_ms, load_index, daily_pool_tokens,
                hourly_tokens, total_weighted_contribution, contribution_count, finalized, created_at_ms
         FROM issuance_epochs
         ORDER BY window_end_ms / $2::bigint, created_at_ms ASC, issuance_epoch_id ASC
       ) deduped
       ORDER BY created_at_ms DESC
       LIMIT $1`,
      [limit, Math.max(1, Math.floor(bucketMs))]
    );
    return result.rows.map(mapIssuanceEpochRow);
  }

  async listIssuanceAllocations(epochId: string): Promise<IssuanceAllocationRecord[]> {
    const result = await this.pool.query(
      `SELECT allocation_id, issuance_epoch_id, account_id, weighted_contribution, allocation_share, issued_tokens, created_at_ms
       FROM issuance_allocations
       WHERE issuance_epoch_id = $1
       ORDER BY issued_tokens DESC`,
      [epochId]
    );
    return result.rows.map((row) => ({
      allocationId: row.allocation_id,
      issuanceEpochId: row.issuance_epoch_id,
      accountId: row.account_id,
      weightedContribution: Number(row.weighted_contribution),
      allocationShare: Number(row.allocation_share),
      issuedTokens: Number(row.issued_tokens),
      createdAtMs: Number(row.created_at_ms)
    }));
  }

  async persistQuorumLedgerRecord(record: QuorumLedgerRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO quorum_ledger_records (
        record_id, record_type, epoch_id, coordinator_id, prev_hash, hash, payload_json, signature, created_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (record_id) DO NOTHING`,
      [
        record.recordId,
        record.recordType,
        record.epochId,
        record.coordinatorId,
        record.prevHash,
        record.hash,
        record.payloadJson,
        record.signature,
        record.createdAtMs
      ]
    );
  }

  async listQuorumLedgerByEpoch(epochId: string): Promise<QuorumLedgerRecord[]> {
    const result = await this.pool.query(
      `SELECT record_id, record_type, epoch_id, coordinator_id, prev_hash, hash, payload_json, signature, created_at_ms
       FROM quorum_ledger_records
       WHERE epoch_id = $1
       ORDER BY created_at_ms ASC`,
      [epochId]
    );
    return result.rows.map((row) => ({
      recordId: row.record_id,
      recordType: row.record_type,
      epochId: row.epoch_id,
      coordinatorId: row.coordinator_id,
      prevHash: row.prev_hash,
      hash: row.hash,
      payloadJson: JSON.stringify(row.payload_json),
      signature: row.signature,
      createdAtMs: Number(row.created_at_ms)
    }));
  }

  async latestQuorumLedgerRecord(): Promise<QuorumLedgerRecord | null> {
    const result = await this.pool.query(
      `SELECT record_id, record_type, epoch_id, coordinator_id, prev_hash, hash, payload_json, signature, created_at_ms
       FROM quorum_ledger_records
       ORDER BY created_at_ms DESC
       LIMIT 1`
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      recordId: row.record_id,
      recordType: row.record_type,
      epochId: row.epoch_id,
      coordinatorId: row.coordinator_id,
      prevHash: row.prev_hash,
      hash: row.hash,
      payloadJson: JSON.stringify(row.payload_json),
      signature: row.signature,
      createdAtMs: Number(row.created_at_ms)
    };
  }

  async upsertBitcoinAnchor(record: BitcoinAnchorRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO bitcoin_anchor_records (
        anchor_id, epoch_id, checkpoint_hash, anchor_network, tx_ref, status, anchored_at_ms, created_at_ms, confirmations, block_hash, block_height, last_checked_at_ms, reconcile_attempts, abandoned_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (anchor_id) DO UPDATE SET
        tx_ref = EXCLUDED.tx_ref,
        status = EXCLUDED.status,
        anchored_at_ms = EXCLUDED.anchored_at_ms,
        confirmations = EXCLUDED.confirmations,
        block_hash = EXCLUDED.block_hash,
        block_height = EXCLUDED.block_height,
        last_checked_at_ms = EXCLUDED.last_checked_at_ms,
        reconcile_attempts = EXCLUDED.reconcile_attempts,
        abandoned_at_ms = EXCLUDED.abandoned_at_ms`,
      [
        record.anchorId,
        record.epochId,
        record.checkpointHash,
        record.anchorNetwork,
        record.txRef,
        record.status,
        record.anchoredAtMs ?? null,
        record.createdAtMs,
        record.confirmations ?? 0,
        record.blockHash ?? null,
        record.blockHeight ?? null,
        record.lastCheckedAtMs ?? null,
        record.reconcileAttempts ?? 0,
        record.abandonedAtMs ?? null
      ]
    );
  }

  private anchorFromRow(row: Record<string, any>): BitcoinAnchorRecord {
    return {
      anchorId: row.anchor_id,
      epochId: row.epoch_id,
      checkpointHash: row.checkpoint_hash,
      anchorNetwork: row.anchor_network,
      txRef: row.tx_ref,
      status: row.status,
      anchoredAtMs: row.anchored_at_ms ? Number(row.anchored_at_ms) : undefined,
      createdAtMs: Number(row.created_at_ms),
      confirmations: row.confirmations !== undefined && row.confirmations !== null ? Number(row.confirmations) : 0,
      blockHash: row.block_hash ?? undefined,
      blockHeight: row.block_height !== undefined && row.block_height !== null ? Number(row.block_height) : undefined,
      lastCheckedAtMs: row.last_checked_at_ms ? Number(row.last_checked_at_ms) : undefined,
      reconcileAttempts: row.reconcile_attempts !== undefined && row.reconcile_attempts !== null ? Number(row.reconcile_attempts) : 0,
      abandonedAtMs: row.abandoned_at_ms !== undefined && row.abandoned_at_ms !== null ? Number(row.abandoned_at_ms) : undefined
    };
  }

  async latestAnchor(): Promise<BitcoinAnchorRecord | null> {
    const result = await this.pool.query(
      `SELECT anchor_id, epoch_id, checkpoint_hash, anchor_network, tx_ref, status, anchored_at_ms, created_at_ms, confirmations, block_hash, block_height, last_checked_at_ms, reconcile_attempts, abandoned_at_ms
       FROM bitcoin_anchor_records
       ORDER BY created_at_ms DESC
       LIMIT 1`
    );
    const row = result.rows[0];
    return row ? this.anchorFromRow(row) : null;
  }

  async listAnchors(limit = 100): Promise<BitcoinAnchorRecord[]> {
    const result = await this.pool.query(
      `SELECT anchor_id, epoch_id, checkpoint_hash, anchor_network, tx_ref, status, anchored_at_ms, created_at_ms, confirmations, block_hash, block_height, last_checked_at_ms, reconcile_attempts, abandoned_at_ms
       FROM bitcoin_anchor_records
       ORDER BY created_at_ms DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => this.anchorFromRow(row));
  }

  /** #46 review: cross-instance lock so one checkpoint is broadcast at most once. */
  async withCheckpointLock<T>(checkpointHash: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(46, hashtext($1))", [checkpointHash]);
      try {
        return await fn();
      } finally {
        await client.query("SELECT pg_advisory_unlock(46, hashtext($1))", [checkpointHash]).catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  /** #46 review: broadcast attempts since `sinceMs`, for the daily anchoring budget. */
  async countAnchorBroadcastsSince(sinceMs: number): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM bitcoin_anchor_records
       WHERE (created_at_ms >= $1 AND (status IN ('broadcasting', 'needs_admin') OR tx_ref ~ '^[0-9a-f]{64}$'))
          -- #109 review: an abandoned tx that confirmed anyway spent its fee when it confirmed.
          OR (created_at_ms < $1 AND abandoned_at_ms IS NOT NULL AND status IN ('pending', 'anchored')
              AND COALESCE(anchored_at_ms, last_checked_at_ms, 0) >= $1)`,
      [sinceMs]
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  /** #103: rows to reconcile: in-flight broadcasts, and pending rows older than `pendingBeforeMs`. */
  async listAnchorsToReconcile(pendingBeforeMs: number, limit = 50, abandonedSinceMs?: number): Promise<BitcoinAnchorRecord[]> {
    const result = await this.pool.query(
      `SELECT anchor_id, epoch_id, checkpoint_hash, anchor_network, tx_ref, status, anchored_at_ms, created_at_ms, confirmations, block_hash, block_height, last_checked_at_ms, reconcile_attempts, abandoned_at_ms
       FROM bitcoin_anchor_records
       WHERE status = 'broadcasting' OR (status = 'pending' AND created_at_ms < $1)
          OR (status = 'failed' AND abandoned_at_ms IS NOT NULL AND abandoned_at_ms >= $3)
       ORDER BY created_at_ms ASC
       LIMIT $2`,
      [pendingBeforeMs, limit, abandonedSinceMs ?? Number.MAX_SAFE_INTEGER]
    );
    return result.rows.map((row) => this.anchorFromRow(row));
  }

  /** #46: anchors awaiting confirmation depth (or re-confirmation after a reorg). */
  async listPendingAnchors(limit = 50): Promise<BitcoinAnchorRecord[]> {
    const result = await this.pool.query(
      `SELECT anchor_id, epoch_id, checkpoint_hash, anchor_network, tx_ref, status, anchored_at_ms, created_at_ms, confirmations, block_hash, block_height, last_checked_at_ms, reconcile_attempts, abandoned_at_ms
       FROM bitcoin_anchor_records
       WHERE status = 'pending'
       ORDER BY created_at_ms ASC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => this.anchorFromRow(row));
  }

  /** #101: newest anchor row for an epoch id (issuance epochs, `stats:<h>`, `receipts:<id>`). */
  async latestAnchorByEpoch(epochId: string): Promise<BitcoinAnchorRecord | null> {
    const result = await this.pool.query(
      `SELECT anchor_id, epoch_id, checkpoint_hash, anchor_network, tx_ref, status, anchored_at_ms, created_at_ms, confirmations, block_hash, block_height, last_checked_at_ms, reconcile_attempts, abandoned_at_ms
       FROM bitcoin_anchor_records
       WHERE epoch_id = $1
       ORDER BY created_at_ms DESC
       LIMIT 1`,
      [epochId]
    );
    const row = result.rows[0];
    return row ? this.anchorFromRow(row) : null;
  }

  /**
   * #101: the newest live (non-failed, real txid) anchor of each kind (stats checkpoints,
   * receipt epochs, issuance epochs), so reorg re-checks cover every kind even when one kind
   * fills the newest rows.
   */
  async latestLiveAnchorPerKind(): Promise<BitcoinAnchorRecord[]> {
    const result = await this.pool.query(
      `SELECT DISTINCT ON (kind) anchor_id, epoch_id, checkpoint_hash, anchor_network, tx_ref, status, anchored_at_ms, created_at_ms, confirmations, block_hash, block_height, last_checked_at_ms, reconcile_attempts, abandoned_at_ms
       FROM (
         SELECT *, CASE WHEN epoch_id LIKE 'stats:%' THEN 'stats' WHEN epoch_id LIKE 'receipts:%' THEN 'receipts' ELSE 'issuance' END AS kind
         FROM bitcoin_anchor_records
         WHERE status <> 'failed' AND tx_ref ~ '^[0-9a-f]{64}$'
       ) a
       ORDER BY kind, created_at_ms DESC`
    );
    return result.rows.map((row) => this.anchorFromRow(row));
  }

  async latestAnchorByCheckpoint(checkpointHash: string): Promise<BitcoinAnchorRecord | null> {
    const result = await this.pool.query(
      `SELECT anchor_id, epoch_id, checkpoint_hash, anchor_network, tx_ref, status, anchored_at_ms, created_at_ms, confirmations, block_hash, block_height, last_checked_at_ms, reconcile_attempts, abandoned_at_ms
       FROM bitcoin_anchor_records
       WHERE checkpoint_hash = $1
       ORDER BY created_at_ms DESC
       LIMIT 1`,
      [checkpointHash]
    );
    const row = result.rows[0];
    return row ? this.anchorFromRow(row) : null;
  }

  async persistIssuancePayoutEvent(event: IssuancePayoutEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO issuance_payout_events (
        payout_event_id, issuance_epoch_id, account_id, payout_type, tokens, source_intent_id, created_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (payout_event_id) DO NOTHING`,
      [
        event.payoutEventId,
        event.issuanceEpochId,
        event.accountId,
        event.payoutType,
        event.tokens,
        event.sourceIntentId ?? null,
        event.createdAtMs
      ]
    );
  }

  async listIssuancePayoutEvents(epochId?: string, limit = 500): Promise<IssuancePayoutEvent[]> {
    const where = epochId ? "WHERE issuance_epoch_id = $1" : "";
    const args = epochId ? [epochId, limit] : [limit];
    const limitPosition = epochId ? "$2" : "$1";
    const result = await this.pool.query(
      `SELECT payout_event_id, issuance_epoch_id, account_id, payout_type, tokens, source_intent_id, created_at_ms
       FROM issuance_payout_events
       ${where}
       ORDER BY created_at_ms DESC
       LIMIT ${limitPosition}`,
      args
    );
    return result.rows.map((row) => ({
      payoutEventId: row.payout_event_id,
      issuanceEpochId: row.issuance_epoch_id,
      accountId: row.account_id,
      payoutType: row.payout_type,
      tokens: Number(row.tokens),
      sourceIntentId: row.source_intent_id ?? undefined,
      createdAtMs: Number(row.created_at_ms)
    }));
  }

  async upsertAgent(input: {
    agentId: string;
    os: string;
    version: string;
    mode: string;
    localModelEnabled: boolean;
    lastSeenMs: number;
    activeModel?: string;
    activeModelParamSize?: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_registry (agent_id, os, version, mode, local_model_enabled, last_seen_ms, active_model, active_model_param_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (agent_id) DO UPDATE SET
         os = EXCLUDED.os,
         version = EXCLUDED.version,
         mode = EXCLUDED.mode,
         local_model_enabled = EXCLUDED.local_model_enabled,
         last_seen_ms = EXCLUDED.last_seen_ms,
         active_model = EXCLUDED.active_model,
         active_model_param_size = EXCLUDED.active_model_param_size`,
      [input.agentId, input.os, input.version, input.mode, input.localModelEnabled, input.lastSeenMs, input.activeModel ?? null, input.activeModelParamSize ?? null]
    );
  }

  async listAgentRegistry(): Promise<
    Array<{
      agentId: string;
      os: string;
      version: string;
      mode: string;
      localModelEnabled: boolean;
      lastSeenMs: number;
      activeModel: string | null;
      activeModelParamSize: number | null;
    }>
  > {
    const result = await this.pool.query(
      `SELECT agent_id, os, version, mode, local_model_enabled, last_seen_ms, active_model, active_model_param_size
       FROM agent_registry
       ORDER BY last_seen_ms DESC`
    );
    return result.rows.map((row) => ({
      agentId: row.agent_id,
      os: row.os,
      version: row.version,
      mode: row.mode,
      localModelEnabled: Boolean(row.local_model_enabled),
      lastSeenMs: Number(row.last_seen_ms),
      activeModel: row.active_model ?? null,
      activeModelParamSize: row.active_model_param_size != null ? Number(row.active_model_param_size) : null
    }));
  }

  async persistBlacklistEvent(record: BlacklistRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO blacklist_events (
        event_id, agent_id, reason_code, reason, evidence_hash_sha256, reporter_id,
        reporter_public_key_pem, reporter_signature, evidence_signature_verified, evidence_ref,
        source_coordinator_id, reported_by, timestamp_ms, expires_at_ms, prev_event_hash,
        event_hash, coordinator_signature
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT (event_id) DO NOTHING`,
      [
        record.eventId,
        record.agentId,
        record.reasonCode,
        record.reason,
        record.evidenceHashSha256,
        record.reporterId,
        record.reporterPublicKeyPem ?? null,
        record.reporterSignature ?? null,
        record.evidenceSignatureVerified,
        record.evidenceRef ?? null,
        record.sourceCoordinatorId,
        record.reportedBy,
        record.timestampMs,
        record.expiresAtMs ?? null,
        record.prevEventHash,
        record.eventHash,
        record.coordinatorSignature
      ]
    );
  }

  async listBlacklistEvents(): Promise<BlacklistRecord[]> {
    const result = await this.pool.query(
      `SELECT
        event_id, agent_id, reason_code, reason, evidence_hash_sha256, reporter_id,
        reporter_public_key_pem, reporter_signature, evidence_signature_verified, evidence_ref,
        source_coordinator_id, reported_by, timestamp_ms, expires_at_ms, prev_event_hash,
        event_hash, coordinator_signature
       FROM blacklist_events
       ORDER BY timestamp_ms ASC`
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      agentId: row.agent_id,
      reasonCode: row.reason_code,
      reason: row.reason,
      evidenceHashSha256: row.evidence_hash_sha256,
      reporterId: row.reporter_id,
      reporterPublicKeyPem: row.reporter_public_key_pem ?? undefined,
      reporterSignature: row.reporter_signature ?? undefined,
      evidenceSignatureVerified: Boolean(row.evidence_signature_verified),
      evidenceRef: row.evidence_ref ?? undefined,
      sourceCoordinatorId: row.source_coordinator_id,
      reportedBy: row.reported_by,
      timestampMs: Number(row.timestamp_ms),
      expiresAtMs: row.expires_at_ms ? Number(row.expires_at_ms) : undefined,
      prevEventHash: row.prev_event_hash,
      eventHash: row.event_hash,
      coordinatorSignature: row.coordinator_signature
    }));
  }

  async upsertCreditAccount(account: CreditAccount): Promise<void> {
    await this.pool.query(
      `INSERT INTO credit_accounts (account_id, display_name, owner_user_id, created_at_ms)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (account_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         owner_user_id = EXCLUDED.owner_user_id`,
      [account.accountId, account.displayName, account.ownerUserId, account.createdAtMs]
    );
  }

  async upsertAccountMembership(membership: AccountMembership): Promise<void> {
    await this.pool.query(
      `INSERT INTO account_memberships (account_id, user_id, role, created_at_ms)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (account_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [membership.accountId, membership.userId, membership.role, membership.createdAtMs]
    );
  }

  async linkAgentOwnership(input: {
    agentId: string;
    accountId: string;
    ownerUserId: string;
    machineLabel?: string;
  }): Promise<AgentOwnership> {
    const now = Date.now();
    const result = await this.pool.query(
      `INSERT INTO agent_ownership (
        agent_id, account_id, owner_user_id, machine_label, created_at_ms, updated_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (agent_id) DO UPDATE SET
        account_id = EXCLUDED.account_id,
        owner_user_id = EXCLUDED.owner_user_id,
        machine_label = EXCLUDED.machine_label,
        updated_at_ms = EXCLUDED.updated_at_ms
      RETURNING agent_id, account_id, owner_user_id, machine_label, created_at_ms, updated_at_ms`,
      [input.agentId, input.accountId, input.ownerUserId, input.machineLabel ?? null, now, now]
    );
    const row = result.rows[0];
    return {
      agentId: row.agent_id,
      accountId: row.account_id,
      ownerUserId: row.owner_user_id,
      machineLabel: row.machine_label ?? undefined,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    };
  }

  async getAgentOwnership(agentId: string): Promise<AgentOwnership | null> {
    const result = await this.pool.query(
      `SELECT agent_id, account_id, owner_user_id, machine_label, created_at_ms, updated_at_ms
       FROM agent_ownership WHERE agent_id = $1`,
      [agentId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      agentId: row.agent_id,
      accountId: row.account_id,
      ownerUserId: row.owner_user_id,
      machineLabel: row.machine_label ?? undefined,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    };
  }

  async listAgentOwnershipByAccount(accountId: string): Promise<AgentOwnership[]> {
    const result = await this.pool.query(
      `SELECT agent_id, account_id, owner_user_id, machine_label, created_at_ms, updated_at_ms
       FROM agent_ownership WHERE account_id = $1 ORDER BY updated_at_ms DESC`,
      [accountId]
    );
    return result.rows.map((row) => ({
      agentId: row.agent_id,
      accountId: row.account_id,
      ownerUserId: row.owner_user_id,
      machineLabel: row.machine_label ?? undefined,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    }));
  }

  async listAccountsByUser(userId: string): Promise<CreditAccount[]> {
    const result = await this.pool.query(
      `SELECT ca.account_id, ca.display_name, ca.owner_user_id, ca.created_at_ms
       FROM credit_accounts ca
       INNER JOIN account_memberships am ON am.account_id = ca.account_id
       WHERE am.user_id = $1
       ORDER BY ca.created_at_ms DESC`,
      [userId]
    );
    return result.rows.map((row) => ({
      accountId: row.account_id,
      displayName: row.display_name,
      ownerUserId: row.owner_user_id,
      createdAtMs: Number(row.created_at_ms)
    }));
  }

  async upsertOllamaRollout(record: OllamaRolloutRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO ollama_rollouts (
        rollout_id, target_type, target_id, provider, model, auto_install, status,
        requested_by, requested_at_ms, updated_at_ms, error
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (rollout_id) DO UPDATE SET
        provider = EXCLUDED.provider,
        model = EXCLUDED.model,
        auto_install = EXCLUDED.auto_install,
        status = EXCLUDED.status,
        updated_at_ms = EXCLUDED.updated_at_ms,
        error = EXCLUDED.error`,
      [
        record.rolloutId,
        record.targetType,
        record.targetId,
        record.provider,
        record.model,
        record.autoInstall,
        record.status,
        record.requestedBy,
        record.requestedAtMs,
        record.updatedAtMs,
        record.error ?? null
      ]
    );
  }

  async listOllamaRollouts(limit = 100): Promise<OllamaRolloutRecord[]> {
    const result = await this.pool.query(
      `SELECT rollout_id, target_type, target_id, provider, model, auto_install, status,
              requested_by, requested_at_ms, updated_at_ms, error
       FROM ollama_rollouts
       ORDER BY updated_at_ms DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      rolloutId: row.rollout_id,
      targetType: row.target_type,
      targetId: row.target_id,
      provider: row.provider,
      model: row.model,
      autoInstall: Boolean(row.auto_install),
      status: row.status,
      requestedBy: row.requested_by,
      requestedAtMs: Number(row.requested_at_ms),
      updatedAtMs: Number(row.updated_at_ms),
      error: row.error ?? undefined
    }));
  }

  /* ── Staged Rollout Policies ──────────────────────────── */

  async upsertRolloutPolicy(policy: RolloutPolicy): Promise<void> {
    await this.pool.query(
      `INSERT INTO rollout_policies (
        rollout_id, model_id, target_provider, stage, canary_percent, batch_size,
        batch_interval_ms, health_check_required, auto_promote,
        rollback_on_failure_percent, created_at_ms, updated_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      ON CONFLICT (rollout_id) DO UPDATE SET
        stage = EXCLUDED.stage,
        canary_percent = EXCLUDED.canary_percent,
        batch_size = EXCLUDED.batch_size,
        batch_interval_ms = EXCLUDED.batch_interval_ms,
        health_check_required = EXCLUDED.health_check_required,
        auto_promote = EXCLUDED.auto_promote,
        rollback_on_failure_percent = EXCLUDED.rollback_on_failure_percent,
        updated_at_ms = EXCLUDED.updated_at_ms`,
      [
        policy.rolloutId,
        policy.modelId,
        policy.targetProvider,
        policy.stage,
        policy.canaryPercent,
        policy.batchSize,
        policy.batchIntervalMs,
        policy.healthCheckRequired,
        policy.autoPromote,
        policy.rollbackOnFailurePercent,
        policy.createdAtMs,
        policy.updatedAtMs
      ]
    );
  }

  async getRolloutPolicy(rolloutId: string): Promise<RolloutPolicy | null> {
    const result = await this.pool.query(
      `SELECT rollout_id, model_id, target_provider, stage, canary_percent, batch_size,
              batch_interval_ms, health_check_required, auto_promote,
              rollback_on_failure_percent, created_at_ms, updated_at_ms
       FROM rollout_policies WHERE rollout_id = $1`,
      [rolloutId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      rolloutId: row.rollout_id,
      modelId: row.model_id,
      targetProvider: row.target_provider,
      stage: row.stage as RolloutStage,
      canaryPercent: Number(row.canary_percent),
      batchSize: Number(row.batch_size),
      batchIntervalMs: Number(row.batch_interval_ms),
      healthCheckRequired: Boolean(row.health_check_required),
      autoPromote: Boolean(row.auto_promote),
      rollbackOnFailurePercent: Number(row.rollback_on_failure_percent),
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    };
  }

  async listRolloutPolicies(limit = 100): Promise<RolloutPolicy[]> {
    const result = await this.pool.query(
      `SELECT rollout_id, model_id, target_provider, stage, canary_percent, batch_size,
              batch_interval_ms, health_check_required, auto_promote,
              rollback_on_failure_percent, created_at_ms, updated_at_ms
       FROM rollout_policies
       ORDER BY updated_at_ms DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      rolloutId: row.rollout_id,
      modelId: row.model_id,
      targetProvider: row.target_provider,
      stage: row.stage as RolloutStage,
      canaryPercent: Number(row.canary_percent),
      batchSize: Number(row.batch_size),
      batchIntervalMs: Number(row.batch_interval_ms),
      healthCheckRequired: Boolean(row.health_check_required),
      autoPromote: Boolean(row.auto_promote),
      rollbackOnFailurePercent: Number(row.rollback_on_failure_percent),
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    }));
  }

  async updateRolloutStage(rolloutId: string, stage: RolloutStage): Promise<void> {
    await this.pool.query(
      `UPDATE rollout_policies SET stage = $1, updated_at_ms = $2 WHERE rollout_id = $3`,
      [stage, Date.now(), rolloutId]
    );
  }

  /* ── Agent Rollout States ─────────────────────────────── */

  async upsertAgentRolloutState(state: AgentRolloutState): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_rollout_states (
        rollout_id, agent_id, status, model_version, updated_at_ms, error
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (rollout_id, agent_id) DO UPDATE SET
        status = EXCLUDED.status,
        model_version = EXCLUDED.model_version,
        updated_at_ms = EXCLUDED.updated_at_ms,
        error = EXCLUDED.error`,
      [
        state.rolloutId,
        state.agentId,
        state.status,
        state.modelVersion,
        state.updatedAtMs,
        state.error ?? null
      ]
    );
  }

  async listAgentRolloutStates(rolloutId: string): Promise<AgentRolloutState[]> {
    const result = await this.pool.query(
      `SELECT rollout_id, agent_id, status, model_version, updated_at_ms, error
       FROM agent_rollout_states WHERE rollout_id = $1
       ORDER BY updated_at_ms DESC`,
      [rolloutId]
    );
    return result.rows.map((row) => ({
      rolloutId: row.rollout_id,
      agentId: row.agent_id,
      status: row.status as AgentRolloutStatus,
      modelVersion: row.model_version,
      updatedAtMs: Number(row.updated_at_ms),
      error: row.error ?? undefined
    }));
  }

  async upsertWalletAccount(wallet: WalletAccount): Promise<void> {
    await this.callbackPinStore().resetCallbackPins(wallet.accountId, wallet.payoutAddress ?? null);
    await this.pool.query(
      `INSERT INTO wallet_accounts (
        account_id, wallet_type, network, xpub, ln_node_pubkey, payout_address, encrypted_secret_ref, created_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (account_id) DO UPDATE SET
        wallet_type = EXCLUDED.wallet_type,
        network = EXCLUDED.network,
        xpub = EXCLUDED.xpub,
        ln_node_pubkey = EXCLUDED.ln_node_pubkey,
        payout_address = EXCLUDED.payout_address,
        encrypted_secret_ref = EXCLUDED.encrypted_secret_ref,
        payout_invalidated_at_ms = CASE WHEN EXCLUDED.payout_address IS NULL THEN wallet_accounts.payout_invalidated_at_ms ELSE NULL END`,
      [
        wallet.accountId,
        wallet.walletType,
        wallet.network,
        wallet.xpub ?? null,
        wallet.lnNodePubkey ?? null,
        wallet.payoutAddress ?? null,
        wallet.encryptedSecretRef ?? null,
        wallet.createdAtMs
      ]
    );
  }

  async getWalletAccount(accountId: string): Promise<WalletAccount | null> {
    const result = await this.pool.query(
      `SELECT account_id, wallet_type, network, xpub, ln_node_pubkey, payout_address, encrypted_secret_ref, created_at_ms, payout_invalidated_at_ms
       FROM wallet_accounts WHERE account_id = $1`,
      [accountId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      accountId: row.account_id,
      walletType: row.wallet_type,
      network: row.network,
      xpub: row.xpub ?? undefined,
      lnNodePubkey: row.ln_node_pubkey ?? undefined,
      payoutAddress: row.payout_address ?? undefined,
      encryptedSecretRef: row.encrypted_secret_ref ?? undefined,
      createdAtMs: Number(row.created_at_ms),
      payoutInvalidatedAtMs: row.payout_invalidated_at_ms ? Number(row.payout_invalidated_at_ms) : undefined
    };
  }

  async upsertPaymentIntent(intent: PaymentIntent): Promise<void> {
    await this.pool.query(
      `INSERT INTO payment_intents (
        intent_id, account_id, coordinator_id, wallet_type, network, invoice_ref, amount_sats,
        coordinator_fee_bps, coordinator_fee_sats, net_sats, quoted_credits, status, created_at_ms,
        settled_at_ms, tx_ref, payment_hash
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT (intent_id) DO UPDATE SET
        -- never move a settled intent back (settlement goes through settlePaymentIntentAtomic)
        status = CASE WHEN payment_intents.status = 'settled' THEN payment_intents.status ELSE EXCLUDED.status END,
        settled_at_ms = COALESCE(payment_intents.settled_at_ms, EXCLUDED.settled_at_ms),
        tx_ref = COALESCE(payment_intents.tx_ref, EXCLUDED.tx_ref),
        payment_hash = COALESCE(payment_intents.payment_hash, EXCLUDED.payment_hash)`,
      [
        intent.intentId,
        intent.accountId,
        intent.coordinatorId,
        intent.walletType,
        intent.network,
        intent.invoiceRef,
        intent.amountSats,
        intent.coordinatorFeeBps,
        intent.coordinatorFeeSats,
        intent.netSats,
        intent.quotedCredits,
        intent.status,
        intent.createdAtMs,
        intent.settledAtMs ?? null,
        intent.txRef ?? null,
        intent.paymentHash ?? null
      ]
    );
  }

  /**
   * #42: atomic settle. Status CAS (created -> settled) and the
   * `credit_purchase:<intentId>` credit row are written in one transaction, so
   * concurrent webhook/reconcile/confirm calls (or a replay after restart)
   * credit at most once.
   */
  async settlePaymentIntentAtomic(
    intentId: string,
    txRef: string,
    paymentHash?: string
  ): Promise<{ status: "settled" | "already"; intent?: PaymentIntent }> {
    const client = await this.pool.connect();
    const now = Date.now();
    try {
      await client.query("BEGIN");
      const upd = await client.query(
        `UPDATE payment_intents
            SET status = 'settled', settled_at_ms = $2, tx_ref = $3, payment_hash = COALESCE(payment_hash, $4)
          WHERE intent_id = $1 AND status = 'created'
          RETURNING account_id, quoted_credits`,
        [intentId, now, txRef, paymentHash ?? null]
      );
      if ((upd.rowCount ?? 0) === 0) {
        await client.query("COMMIT");
        return { status: "already", intent: (await this.getPaymentIntent(intentId)) ?? undefined };
      }
      // #155: credit the account and amount stored on the intent (quoted_credits stays NUMERIC
      // end to end), never caller-supplied values. A zero quote settles without a credit row.
      const { account_id: accountId, quoted_credits: credits } = upd.rows[0];
      await client.query(
        `INSERT INTO credit_transactions (
           tx_id, account_id, tx_type, credits, reason, related_task_id, timestamp_ms
         ) SELECT $1,$2,'earn',$3::numeric,$4,NULL,$5 WHERE $3::numeric > 0`,
        [randomUUID(), accountId, credits, `credit_purchase:${intentId}`, now]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { status: "settled", intent: (await this.getPaymentIntent(intentId)) ?? undefined };
  }

  async getPaymentIntent(intentId: string): Promise<PaymentIntent | null> {
    const result = await this.pool.query(
      `SELECT intent_id, account_id, coordinator_id, wallet_type, network, invoice_ref, amount_sats,
              coordinator_fee_bps, coordinator_fee_sats, net_sats, quoted_credits, status, created_at_ms,
              settled_at_ms, tx_ref, payment_hash
       FROM payment_intents WHERE intent_id = $1`,
      [intentId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      intentId: row.intent_id,
      accountId: row.account_id,
      coordinatorId: row.coordinator_id,
      walletType: row.wallet_type,
      network: row.network,
      invoiceRef: row.invoice_ref,
      amountSats: Number(row.amount_sats),
      coordinatorFeeBps: Number(row.coordinator_fee_bps),
      coordinatorFeeSats: Number(row.coordinator_fee_sats),
      netSats: Number(row.net_sats),
      quotedCredits: Number(row.quoted_credits),
      status: row.status,
      createdAtMs: Number(row.created_at_ms),
      settledAtMs: row.settled_at_ms ? Number(row.settled_at_ms) : undefined,
      txRef: row.tx_ref ?? undefined,
      paymentHash: row.payment_hash ?? undefined
    };
  }

  async listPaymentIntentsByAccount(accountId: string, limit = 50): Promise<PaymentIntent[]> {
    const result = await this.pool.query(
      `SELECT intent_id, account_id, coordinator_id, wallet_type, network, invoice_ref, amount_sats,
              coordinator_fee_bps, coordinator_fee_sats, net_sats, quoted_credits, status, created_at_ms,
              settled_at_ms, tx_ref
       FROM payment_intents
       WHERE account_id = $1
       ORDER BY created_at_ms DESC
       LIMIT $2`,
      [accountId, limit]
    );
    return result.rows.map((row) => ({
      intentId: row.intent_id,
      accountId: row.account_id,
      coordinatorId: row.coordinator_id,
      walletType: row.wallet_type,
      network: row.network,
      invoiceRef: row.invoice_ref,
      amountSats: Number(row.amount_sats),
      coordinatorFeeBps: Number(row.coordinator_fee_bps),
      coordinatorFeeSats: Number(row.coordinator_fee_sats),
      netSats: Number(row.net_sats),
      quotedCredits: Number(row.quoted_credits),
      status: row.status,
      createdAtMs: Number(row.created_at_ms),
      settledAtMs: row.settled_at_ms ? Number(row.settled_at_ms) : undefined,
      txRef: row.tx_ref ?? undefined
    }));
  }

  async upsertPriceEpoch(record: PriceEpochRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO price_epochs (
        epoch_id, coordinator_id, resource_class, price_per_compute_unit_sats, supply_index,
        demand_index, negotiated_with_json, signature, created_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (epoch_id) DO NOTHING`,
      [
        record.epochId,
        record.coordinatorId,
        record.resourceClass,
        record.pricePerComputeUnitSats,
        record.supplyIndex,
        record.demandIndex,
        JSON.stringify(record.negotiatedWith),
        record.signature,
        record.createdAtMs
      ]
    );
  }

  /** Daily rate oracle epochs (sats per CPU/GPU hour from market data). Full epoch kept as JSON. */
  async upsertRateEpoch(epoch: RateEpoch): Promise<void> {
    await this.pool.query(
      `INSERT INTO rate_epochs (
         epoch_id, created_at_ms, btc_usd, usd_per_cpu_hour, usd_per_gpu_hour, sats_per_cpu_hour,
         sats_per_gpu_hour, msat_per_credit, markup_bps, status, payload_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (epoch_id) DO NOTHING`,
      [
        epoch.epochId,
        epoch.createdAtMs,
        epoch.btcUsd,
        epoch.usdPerCpuHour,
        epoch.usdPerGpuHour,
        epoch.satsPerCpuHour,
        epoch.satsPerGpuHour,
        epoch.msatPerCredit,
        epoch.markupBps,
        epoch.status,
        JSON.stringify(epoch)
      ]
    );
  }

  async latestRateEpoch(): Promise<RateEpoch | null> {
    const result = await this.pool.query(`SELECT payload_json FROM rate_epochs ORDER BY created_at_ms DESC LIMIT 1`);
    const row = result.rows[0];
    return row ? (row.payload_json as RateEpoch) : null;
  }

  async listRateEpochs(limit = 30): Promise<RateEpoch[]> {
    const result = await this.pool.query(`SELECT payload_json FROM rate_epochs ORDER BY created_at_ms DESC LIMIT $1`, [limit]);
    return result.rows.map((r) => r.payload_json as RateEpoch);
  }

  // ── Payouts ──
  /** Sats (msat) the node received from settled purchases (gross; the fee share is credited to the fee pool separately). */
  async receivedPurchaseMsat(): Promise<number> {
    const r = await this.pool.query(`SELECT COALESCE(SUM(amount_sats), 0) AS sats FROM payment_intents WHERE status = 'settled'`);
    return Number(r.rows[0]?.sats ?? 0) * 1000;
  }

  async payoutsTotalMsat(filter: { accountId?: string; statuses: Array<PayoutRecord["status"]> }): Promise<number> {
    const params: unknown[] = [filter.statuses];
    let where = `status = ANY($1)`;
    if (filter.accountId) {
      params.push(filter.accountId);
      where += ` AND account_id = $2`;
    }
    const r = await this.pool.query(`SELECT COALESCE(SUM(amount_msat + fee_msat), 0) AS msat FROM payouts WHERE ${where}`, params);
    return Number(r.rows[0]?.msat ?? 0);
  }

  /**
   * Reserve a payout atomically: under a per-account advisory lock, recheck payable
   * (earned − paid/pending) and the coordinator's capacity, then insert the pending row.
   * A duplicate payment hash is rejected by the unique index, so one invoice is never paid twice.
   */
  async reservePayout(payout: PayoutRecord, capacityMsat: (paidOrPendingAllMsat: number) => number, limits?: ReservationLimits): Promise<ReserveResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Global first, then per account (fixed order, no deadlock). The global lock makes the capacity
      // and 24 h cap sums exact across concurrent requests and coordinators sharing this database.
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [PAYOUT_LOCK_NAMESPACE, PAYOUT_GLOBAL_LOCK_KEY]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`payout:${payout.accountId}`]);
      const earned = await client.query(`SELECT COALESCE(SUM(msat), 0) AS msat FROM credit_transactions WHERE account_id = $1 AND tx_type = 'earn'`, [payout.accountId]);
      const spent = await client.query(`SELECT COALESCE(SUM(amount_msat + fee_msat), 0) AS msat FROM payouts WHERE account_id = $1 AND status IN ('paid','pending')`, [payout.accountId]);
      const payable = Number(earned.rows[0]?.msat ?? 0) - Number(spent.rows[0]?.msat ?? 0);
      if (payout.amountMsat > payable) {
        await client.query("ROLLBACK");
        return { ok: false, code: "insufficient_payable", payableMsat: Math.max(0, payable) };
      }
      const all = await client.query(`SELECT COALESCE(SUM(amount_msat + fee_msat), 0) AS msat FROM payouts WHERE status IN ('paid','pending')`);
      if (payout.amountMsat + payout.maxFeeMsat > capacityMsat(Number(all.rows[0]?.msat ?? 0))) {
        await client.query("ROLLBACK");
        return { ok: false, code: "coordinator_capacity" };
      }
      if (limits) {
        const w = await client.query(
          `SELECT COALESCE(SUM(${OUTFLOW_SQL}) FILTER (WHERE account_id = $2), 0) AS account_msat, COALESCE(SUM(${OUTFLOW_SQL}), 0) AS global_msat
           FROM payouts WHERE status IN ('paid','pending') AND created_at_ms >= $1`,
          [limits.sinceMs, payout.accountId]
        );
        const violation = limits.check({ accountWindowMsat: Number(w.rows[0]?.account_msat ?? 0), globalWindowMsat: Number(w.rows[0]?.global_msat ?? 0) });
        if (violation) {
          await client.query("ROLLBACK");
          return { ok: false, code: violation.code, violation };
        }
      }
      const ins = await client.query(
        `INSERT INTO payouts (payout_id, account_id, coordinator_id, kind, bolt11, payment_hash, amount_msat, fee_msat, max_fee_msat, status, destination, created_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,'pending',$9,$10) ON CONFLICT (payment_hash) DO NOTHING RETURNING payout_id`,
        [payout.payoutId, payout.accountId, payout.coordinatorId, payout.kind, payout.bolt11, payout.paymentHash, payout.amountMsat, payout.maxFeeMsat, payout.destination ?? null, payout.createdAtMs]
      );
      if ((ins.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return { ok: false, code: "duplicate_invoice" };
      }
      await client.query("COMMIT");
      return { ok: true };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async settlePayout(payoutId: string, outcome: { status: "paid"; feeMsat: number; preimage?: string } | { status: "failed"; error: string }): Promise<void> {
    if (outcome.status === "paid") {
      await this.pool.query(`UPDATE payouts SET status = 'paid', fee_msat = $2, preimage = $3, settled_at_ms = $4, error = NULL WHERE payout_id = $1 AND status = 'pending'`, [
        payoutId,
        Math.max(0, Math.floor(outcome.feeMsat)),
        outcome.preimage ?? null,
        Date.now()
      ]);
    } else {
      await this.pool.query(`UPDATE payouts SET status = 'failed', error = $2, settled_at_ms = $3 WHERE payout_id = $1 AND status = 'pending'`, [payoutId, outcome.error.slice(0, 500), Date.now()]);
    }
  }

  async listPayouts(accountId: string, limit = 50): Promise<PayoutRecord[]> {
    const r = await this.pool.query(`SELECT * FROM payouts WHERE account_id = $1 ORDER BY created_at_ms DESC LIMIT $2`, [accountId, limit]);
    return r.rows.map(rowToPayout);
  }

  // ── Payout safeguards: kill switch, fee-pool lock, reconciliation reads ──
  async getPayoutPause(): Promise<PayoutPauseState | null> {
    const r = await this.pool.query(`SELECT value_json FROM payout_controls WHERE control_key = 'pause'`);
    return (r.rows[0]?.value_json as PayoutPauseState | undefined) ?? null;
  }

  async setPayoutPause(state: PayoutPauseState): Promise<void> {
    await this.pool.query(
      `INSERT INTO payout_controls (control_key, value_json, updated_at_ms) VALUES ('pause', $1, $2)
       ON CONFLICT (control_key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at_ms = EXCLUDED.updated_at_ms`,
      [JSON.stringify(state), Date.now()]
    );
  }

  /**
   * Session advisory lock on a dedicated connection; try-lock, so a second coordinator returns at
   * once instead of queueing a duplicate run. Released in finally (and by Postgres if the connection dies).
   */
  async withFeePoolLock<T>(fn: () => Promise<T>): Promise<FeePoolLockResult<T>> {
    const client = await this.pool.connect();
    let held = false;
    try {
      const r = await client.query("SELECT pg_try_advisory_lock($1, $2) AS got", [FEE_POOL_LOCK_NAMESPACE, FEE_POOL_LOCK_KEY]);
      held = r.rows[0]?.got === true;
      if (!held) return { acquired: false };
      return { acquired: true, value: await fn() };
    } finally {
      if (held) await client.query("SELECT pg_advisory_unlock($1, $2)", [FEE_POOL_LOCK_NAMESPACE, FEE_POOL_LOCK_KEY]).catch(() => undefined);
      client.release();
    }
  }

  async lastPoolDistributionMs(accountId: string): Promise<number | null> {
    const r = await this.pool.query(
      `SELECT MAX(timestamp_ms) AS ts FROM credit_transactions WHERE account_id = $1 AND tx_type = 'spend' AND reason LIKE 'fee_pool_distribution%'`,
      [accountId]
    );
    const ts = r.rows[0]?.ts;
    return ts === null || ts === undefined ? null : Number(ts);
  }

  async payoutsByPaymentHash(hashes: string[]): Promise<Map<string, PayoutRecord>> {
    const out = new Map<string, PayoutRecord>();
    if (hashes.length === 0) return out;
    const r = await this.pool.query(`SELECT * FROM payouts WHERE payment_hash = ANY($1)`, [hashes.map((h) => h.toLowerCase())]);
    for (const row of r.rows) out.set(String(row.payment_hash).toLowerCase(), rowToPayout(row));
    return out;
  }

  async payoutsOutflowMsat(): Promise<number> {
    const r = await this.pool.query(`SELECT COALESCE(SUM(${OUTFLOW_SQL}), 0) AS msat FROM payouts WHERE status IN ('paid','pending')`);
    return Number(r.rows[0]?.msat ?? 0);
  }

  /** Σ earn msat − Σ spend msat (pool distributions) − paid/pending payouts: sats the ledger still owes. */
  async liabilitiesMsat(): Promise<number> {
    const r = await this.pool.query(
      `SELECT (SELECT COALESCE(SUM(CASE WHEN tx_type = 'earn' THEN msat ELSE -msat END), 0) FROM credit_transactions WHERE msat IS NOT NULL)
            - (SELECT COALESCE(SUM(amount_msat + fee_msat), 0) FROM payouts WHERE status IN ('paid','pending')) AS msat`
    );
    return Math.max(0, Number(r.rows[0]?.msat ?? 0));
  }

  async listPendingPayouts(limit = 100): Promise<PayoutRecord[]> {
    const r = await this.pool.query(`SELECT * FROM payouts WHERE status = 'pending' ORDER BY created_at_ms ASC LIMIT $1`, [limit]);
    return r.rows.map(rowToPayout);
  }

  /** Accounts that registered a Lightning address (wallet payout_address or infrastructure host) for automatic payouts. */
  async listAutoPayoutAccounts(): Promise<Array<{ accountId: string; lightningAddress: string }>> {
    const r = await this.pool.query(
      `SELECT account_id, payout_address AS addr FROM wallet_accounts WHERE payout_address IS NOT NULL AND (payout_address LIKE '%@%' OR payout_address LIKE 'https://%')
       UNION SELECT account_id, lightning_address AS addr FROM infrastructure_hosts WHERE lightning_address IS NOT NULL`
    );
    return r.rows.map((row) => ({ accountId: row.account_id, lightningAddress: row.addr }));
  }

  // ── Infrastructure hosts ──
  async upsertInfrastructureHost(host: InfrastructureHost): Promise<void> {
    await this.pool.query(
      `INSERT INTO infrastructure_hosts (host_id, account_id, coordinator_url, region, services_json, lightning_address, first_seen_ms, last_seen_ms, heartbeats_in_window)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (host_id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         coordinator_url = COALESCE(EXCLUDED.coordinator_url, infrastructure_hosts.coordinator_url),
         region = COALESCE(EXCLUDED.region, infrastructure_hosts.region),
         services_json = EXCLUDED.services_json,
         lightning_address = COALESCE(EXCLUDED.lightning_address, infrastructure_hosts.lightning_address),
         last_seen_ms = GREATEST(EXCLUDED.last_seen_ms, infrastructure_hosts.last_seen_ms)`,
      [host.hostId, host.accountId, host.coordinatorUrl ?? null, host.region ?? null, JSON.stringify(host.services), host.lightningAddress ?? null, host.firstSeenMs, host.lastSeenMs, host.heartbeatsInWindow]
    );
  }

  async recordHostHeartbeat(hostId: string, nowMs: number): Promise<void> {
    await this.pool.query(`UPDATE infrastructure_hosts SET last_seen_ms = GREATEST(last_seen_ms, $2), heartbeats_in_window = heartbeats_in_window + 1 WHERE host_id = $1`, [hostId, nowMs]);
  }

  /**
   * One heartbeat, atomically: upsert the host with its attested services and add one to the
   * window only if the last counted heartbeat is at least `minCountIntervalMs` old (the row lock
   * of ON CONFLICT serialises concurrent heartbeats, including from two seeds on this database).
   */
  async recordAttestedHostHeartbeat(host: InfrastructureHost, nowMs: number, minCountIntervalMs: number): Promise<{ counted: boolean; heartbeatsInWindow: number }> {
    const r = await this.pool.query(
      `INSERT INTO infrastructure_hosts (host_id, account_id, coordinator_url, region, services_json, lightning_address, first_seen_ms, last_seen_ms,
         heartbeats_in_window, declared_services_json, attested_at_ms, last_counted_ms, lightning_node_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,1,$8,$9,$7,$10)
       ON CONFLICT (host_id) DO UPDATE SET
         account_id = EXCLUDED.account_id,
         coordinator_url = COALESCE(EXCLUDED.coordinator_url, infrastructure_hosts.coordinator_url),
         region = COALESCE(EXCLUDED.region, infrastructure_hosts.region),
         services_json = EXCLUDED.services_json,
         declared_services_json = EXCLUDED.declared_services_json,
         attested_at_ms = COALESCE(EXCLUDED.attested_at_ms, infrastructure_hosts.attested_at_ms),
         lightning_address = COALESCE(EXCLUDED.lightning_address, infrastructure_hosts.lightning_address),
         lightning_node_id = COALESCE(EXCLUDED.lightning_node_id, infrastructure_hosts.lightning_node_id),
         last_seen_ms = GREATEST(EXCLUDED.last_seen_ms, infrastructure_hosts.last_seen_ms),
         heartbeats_in_window = infrastructure_hosts.heartbeats_in_window
           + CASE WHEN infrastructure_hosts.last_counted_ms IS NULL OR EXCLUDED.last_seen_ms - infrastructure_hosts.last_counted_ms >= $11 THEN 1 ELSE 0 END,
         last_counted_ms = CASE WHEN infrastructure_hosts.last_counted_ms IS NULL OR EXCLUDED.last_seen_ms - infrastructure_hosts.last_counted_ms >= $11
           THEN EXCLUDED.last_seen_ms ELSE infrastructure_hosts.last_counted_ms END
       RETURNING heartbeats_in_window, last_counted_ms`,
      [
        host.hostId,
        host.accountId,
        host.coordinatorUrl ?? null,
        host.region ?? null,
        JSON.stringify(host.services),
        host.lightningAddress ?? null,
        nowMs,
        JSON.stringify(host.declaredServices ?? host.services),
        host.attestedAtMs ?? null,
        host.lightningNodeId ?? null,
        minCountIntervalMs
      ]
    );
    const row = r.rows[0] ?? {};
    return { counted: Number(row.last_counted_ms) === nowMs, heartbeatsInWindow: Number(row.heartbeats_in_window ?? 0) };
  }

  async resetHostHeartbeatWindow(): Promise<void> {
    await this.pool.query(`UPDATE infrastructure_hosts SET heartbeats_in_window = 0`);
  }

  async listInfrastructureHosts(): Promise<InfrastructureHost[]> {
    const r = await this.pool.query(`SELECT * FROM infrastructure_hosts ORDER BY first_seen_ms ASC`);
    return r.rows.map((row) => ({
      hostId: row.host_id,
      accountId: row.account_id,
      coordinatorUrl: row.coordinator_url ?? undefined,
      region: row.region ?? undefined,
      services: Array.isArray(row.services_json) ? row.services_json : [],
      declaredServices: Array.isArray(row.declared_services_json) ? row.declared_services_json : undefined,
      attestedAtMs: row.attested_at_ms != null ? Number(row.attested_at_ms) : undefined,
      lightningNodeId: row.lightning_node_id ?? undefined,
      lightningAddress: row.lightning_address ?? undefined,
      firstSeenMs: Number(row.first_seen_ms),
      lastSeenMs: Number(row.last_seen_ms),
      lastCountedMs: row.last_counted_ms != null ? Number(row.last_counted_ms) : undefined,
      heartbeatsInWindow: Number(row.heartbeats_in_window)
    }));
  }

  // ── Compute market history ──
  async persistMarketTick(t: MarketTick): Promise<void> {
    await this.pool.query(
      `INSERT INTO market_ticks (at_ms, compute_class, reference_msat, best_ask_msat, best_bid_msat, mid_msat, clearing_msat, agents, open_tasks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (compute_class, at_ms) DO NOTHING`,
      [t.atMs, t.computeClass, t.referenceMsat, t.bestAskMsat ?? null, t.bestBidMsat ?? null, t.midMsat, t.clearingMsat, t.agents, t.openTasks]
    );
  }

  /** Rows under legacy class ids are mapped (and merged per minute) onto the current classes at read time; see market-history.ts. */
  async listMarketTicks(limitPerClass = 10_080): Promise<MarketTick[]> {
    const r = await this.pool.query(
      `SELECT * FROM (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY compute_class ORDER BY at_ms DESC) AS rn FROM market_ticks
       ) x WHERE rn <= $1 ORDER BY at_ms ASC`,
      [limitPerClass]
    );
    return normalizeLegacyTicks(r.rows.map((row) => ({
      atMs: Number(row.at_ms),
      computeClass: row.compute_class,
      referenceMsat: Number(row.reference_msat),
      bestAskMsat: row.best_ask_msat === null ? undefined : Number(row.best_ask_msat),
      bestBidMsat: row.best_bid_msat === null ? undefined : Number(row.best_bid_msat),
      midMsat: Number(row.mid_msat),
      clearingMsat: Number(row.clearing_msat),
      agents: Number(row.agents),
      openTasks: Number(row.open_tasks)
    })));
  }

  async persistMarketTrade(t: MarketTrade): Promise<void> {
    await this.pool.query(
      `INSERT INTO market_trades (subtask_id, task_id, agent_id, compute_class, msat_per_credit, credits, at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (subtask_id) DO UPDATE SET credits = COALESCE(EXCLUDED.credits, market_trades.credits)`,
      [t.subtaskId, t.taskId, t.agentId, t.computeClass, t.msatPerCredit, t.credits ?? null, t.atMs]
    );
  }

  async listMarketTrades(limit = 5_000): Promise<MarketTrade[]> {
    const r = await this.pool.query(`SELECT * FROM market_trades ORDER BY at_ms DESC LIMIT $1`, [limit]);
    return normalizeLegacyTrades(r.rows.reverse().map((row) => ({
      subtaskId: row.subtask_id,
      taskId: row.task_id,
      agentId: row.agent_id,
      computeClass: row.compute_class,
      msatPerCredit: Number(row.msat_per_credit),
      credits: row.credits === null ? undefined : Number(row.credits),
      atMs: Number(row.at_ms)
    })));
  }

  async upsertMarketOrder(o: MarketOrder): Promise<void> {
    await this.pool.query(
      `INSERT INTO market_orders (account_id, side, compute_class, msat_per_credit, updated_at_ms) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (account_id, side) DO UPDATE SET compute_class = EXCLUDED.compute_class, msat_per_credit = EXCLUDED.msat_per_credit, updated_at_ms = EXCLUDED.updated_at_ms`,
      [o.accountId, o.side, o.computeClass, o.msatPerCredit, o.updatedAtMs]
    );
  }

  async listMarketOrders(): Promise<MarketOrder[]> {
    const r = await this.pool.query(`SELECT * FROM market_orders`);
    return r.rows
      .map((row) => normalizeLegacyOrder({ accountId: row.account_id, side: row.side, computeClass: row.compute_class, msatPerCredit: Number(row.msat_per_credit), updatedAtMs: Number(row.updated_at_ms) }))
      .filter((o): o is MarketOrder => o !== undefined);
  }

  // ── Hardware verification ──
  async upsertHardwareVerification(r: HardwareVerificationRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO hardware_verifications (agent_id, record_json, updated_at_ms) VALUES ($1,$2,$3)
       ON CONFLICT (agent_id) DO UPDATE SET record_json = EXCLUDED.record_json, updated_at_ms = EXCLUDED.updated_at_ms
       WHERE hardware_verifications.updated_at_ms <= EXCLUDED.updated_at_ms`,
      [r.agentId, JSON.stringify(r), r.updatedAtMs]
    );
  }

  async listHardwareVerifications(limit = 100_000): Promise<HardwareVerificationRecord[]> {
    const r = await this.pool.query(`SELECT record_json FROM hardware_verifications ORDER BY updated_at_ms DESC LIMIT $1`, [limit]);
    return r.rows.map((row) => (typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json) as HardwareVerificationRecord);
  }

  // ── Reserved capacity ──
  async upsertReservation(r: Reservation): Promise<void> {
    await this.pool.query(
      `INSERT INTO compute_reservations (reservation_id, account_id, record_json, updated_at_ms) VALUES ($1,$2,$3,$4)
       ON CONFLICT (reservation_id) DO UPDATE SET record_json = EXCLUDED.record_json, updated_at_ms = EXCLUDED.updated_at_ms`,
      [r.id, r.accountId, JSON.stringify(r), Date.now()]
    );
  }

  async insertUsage(r: UsageRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage_records (usage_id, account_id, at_ms, record_json) VALUES ($1,$2,$3,$4) ON CONFLICT (usage_id) DO UPDATE SET record_json = EXCLUDED.record_json`,
      [r.id, r.accountId, r.atMs, JSON.stringify(r)]
    );
  }

  async listUsage(accountId: string, sinceMs: number, limit = 20_000): Promise<UsageRecord[]> {
    const r = await this.pool.query(`SELECT record_json FROM usage_records WHERE account_id = $1 AND at_ms >= $2 ORDER BY at_ms DESC LIMIT $3`, [accountId, sinceMs, limit]);
    return r.rows.map((row) => (typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json) as UsageRecord);
  }

  async getReservation(id: string): Promise<Reservation | null> {
    const r = await this.pool.query(`SELECT record_json FROM compute_reservations WHERE reservation_id = $1`, [id]);
    const row = r.rows[0];
    if (!row) return null;
    return (typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json) as Reservation;
  }

  /**
   * Compare-and-set end of a lease: writes `ended` only while the stored row is still active (or
   * missing). Coordinators sharing this database race here; exactly one gets true and settles.
   */
  async endReservationIfActive(ended: Reservation): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO compute_reservations (reservation_id, account_id, record_json, updated_at_ms) VALUES ($1,$2,$3,$4)
       ON CONFLICT (reservation_id) DO UPDATE SET record_json = EXCLUDED.record_json, updated_at_ms = EXCLUDED.updated_at_ms
       WHERE compute_reservations.record_json->>'status' = 'active'
       RETURNING reservation_id`,
      [ended.id, ended.accountId, JSON.stringify(ended), Date.now()]
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Newest heartbeat any coordinator on this database recorded per agent (agent_registry). */
  async agentLastSeenMs(agentIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (agentIds.length === 0) return out;
    const r = await this.pool.query(`SELECT agent_id, last_seen_ms FROM agent_registry WHERE agent_id = ANY($1::text[])`, [agentIds]);
    for (const row of r.rows) out.set(row.agent_id, Number(row.last_seen_ms));
    return out;
  }

  /** Active leases and those ended in the last week. */
  async listReservations(): Promise<Reservation[]> {
    const r = await this.pool.query(`SELECT record_json FROM compute_reservations WHERE updated_at_ms > $1`, [Date.now() - 7 * 24 * 3_600_000]);
    return r.rows.map((row) => (typeof row.record_json === "string" ? JSON.parse(row.record_json) : row.record_json) as Reservation);
  }

  async latestPriceEpoch(resourceClass: "cpu" | "gpu"): Promise<PriceEpochRecord | null> {
    const result = await this.pool.query(
      `SELECT epoch_id, coordinator_id, resource_class, price_per_compute_unit_sats, supply_index,
              demand_index, negotiated_with_json, signature, created_at_ms
       FROM price_epochs
       WHERE resource_class = $1
       ORDER BY created_at_ms DESC
       LIMIT 1`,
      [resourceClass]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      epochId: row.epoch_id,
      coordinatorId: row.coordinator_id,
      resourceClass: row.resource_class,
      pricePerComputeUnitSats: Number(row.price_per_compute_unit_sats),
      supplyIndex: Number(row.supply_index),
      demandIndex: Number(row.demand_index),
      negotiatedWith: Array.isArray(row.negotiated_with_json) ? row.negotiated_with_json : [],
      signature: row.signature,
      createdAtMs: Number(row.created_at_ms)
    };
  }

  async persistCoordinatorFeeEvent(event: CoordinatorFeeEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO coordinator_fee_events (
        event_id, coordinator_id, intent_id, fee_wallet_account_id, fee_sats, created_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.coordinatorId, event.intentId, event.feeWalletAccountId, event.feeSats, event.createdAtMs]
    );
  }

  async listPendingPaymentIntents(limit = 200): Promise<PaymentIntent[]> {
    const result = await this.pool.query(
      `SELECT intent_id, account_id, coordinator_id, wallet_type, network, invoice_ref, amount_sats,
              coordinator_fee_bps, coordinator_fee_sats, net_sats, quoted_credits, status, created_at_ms,
              settled_at_ms, tx_ref, payment_hash
       FROM payment_intents
       WHERE status = 'created'
       ORDER BY created_at_ms ASC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      intentId: row.intent_id,
      accountId: row.account_id,
      coordinatorId: row.coordinator_id,
      walletType: row.wallet_type,
      network: row.network,
      invoiceRef: row.invoice_ref,
      amountSats: Number(row.amount_sats),
      coordinatorFeeBps: Number(row.coordinator_fee_bps),
      coordinatorFeeSats: Number(row.coordinator_fee_sats),
      netSats: Number(row.net_sats),
      quotedCredits: Number(row.quoted_credits),
      status: row.status,
      createdAtMs: Number(row.created_at_ms),
      settledAtMs: row.settled_at_ms ? Number(row.settled_at_ms) : undefined,
      txRef: row.tx_ref ?? undefined,
      paymentHash: row.payment_hash ?? undefined
    }));
  }

  async upsertTreasuryPolicy(policy: TreasuryPolicy): Promise<void> {
    await this.pool.query(
      `INSERT INTO treasury_policies (
        policy_id, treasury_account_id, multisig_descriptor, quorum_threshold, total_custodians,
        approved_coordinator_ids_json, key_rotation_days, status, created_at_ms, updated_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (policy_id) DO UPDATE SET
        multisig_descriptor = EXCLUDED.multisig_descriptor,
        quorum_threshold = EXCLUDED.quorum_threshold,
        total_custodians = EXCLUDED.total_custodians,
        approved_coordinator_ids_json = EXCLUDED.approved_coordinator_ids_json,
        key_rotation_days = EXCLUDED.key_rotation_days,
        status = EXCLUDED.status,
        updated_at_ms = EXCLUDED.updated_at_ms`,
      [
        policy.policyId,
        policy.treasuryAccountId,
        policy.multisigDescriptor,
        policy.quorumThreshold,
        policy.totalCustodians,
        JSON.stringify(policy.approvedCoordinatorIds),
        policy.keyRotationDays,
        policy.status,
        policy.createdAtMs,
        policy.updatedAtMs
      ]
    );
  }

  async latestTreasuryPolicy(): Promise<TreasuryPolicy | null> {
    const result = await this.pool.query(
      `SELECT policy_id, treasury_account_id, multisig_descriptor, quorum_threshold, total_custodians,
              approved_coordinator_ids_json, key_rotation_days, status, created_at_ms, updated_at_ms
       FROM treasury_policies
       ORDER BY updated_at_ms DESC
       LIMIT 1`
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      policyId: row.policy_id,
      treasuryAccountId: row.treasury_account_id,
      multisigDescriptor: row.multisig_descriptor,
      quorumThreshold: Number(row.quorum_threshold),
      totalCustodians: Number(row.total_custodians),
      approvedCoordinatorIds: Array.isArray(row.approved_coordinator_ids_json) ? row.approved_coordinator_ids_json : [],
      keyRotationDays: Number(row.key_rotation_days),
      status: row.status,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    };
  }

  async persistKeyCustodyEvent(event: KeyCustodyEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO key_custody_events (event_id, policy_id, actor_id, action, details, signature, created_at_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.policyId, event.actorId, event.action, event.details, event.signature, event.createdAtMs]
    );
  }

  async listKeyCustodyEvents(policyId: string, limit = 200): Promise<KeyCustodyEvent[]> {
    const result = await this.pool.query(
      `SELECT event_id, policy_id, actor_id, action, details, signature, created_at_ms
       FROM key_custody_events
       WHERE policy_id = $1
       ORDER BY created_at_ms DESC
       LIMIT $2`,
      [policyId, limit]
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      policyId: row.policy_id,
      actorId: row.actor_id,
      action: row.action,
      details: row.details,
      signature: row.signature,
      createdAtMs: Number(row.created_at_ms)
    }));
  }
}


/* ------------------------------------------------------------------ */
/*  Work receipts + Merkle epochs (architecture step 2)                */
/* ------------------------------------------------------------------ */

const RECEIPT_EPOCH_COLUMNS =
  "epoch_id, coordinator_id, from_ms, to_ms, count, merkle_root, previous_root, signature, closed_at_ms, anchor_tx_ref, anchor_network";

export class PostgresReceiptStore implements ReceiptStore {
  constructor(private readonly pool: Pool) {}

  private static receiptFromRow(row: Record<string, any>): WorkReceipt {
    const json = row.receipt_json;
    return (typeof json === "string" ? JSON.parse(json) : json) as WorkReceipt;
  }

  private static epochFromRow(row: Record<string, any>): ReceiptEpoch {
    return {
      epochId: row.epoch_id,
      coordinatorId: row.coordinator_id,
      fromMs: Number(row.from_ms),
      toMs: Number(row.to_ms),
      count: Number(row.count),
      merkleRoot: row.merkle_root,
      previousRoot: row.previous_root ?? null,
      signature: row.signature,
      closedAtMs: Number(row.closed_at_ms),
      anchorTxRef: row.anchor_tx_ref ?? undefined,
      anchorNetwork: row.anchor_network ?? undefined
    };
  }

  async append(receipt: WorkReceipt): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO work_receipts (
         receipt_id, task_id, subtask_id, agent_id, coordinator_id, compute_class, credits, msat, msat_per_credit,
         started_at_ms, finished_at_ms, result_hash, receipt_json, epoch_id, stored_at_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NULL,$14)
       ON CONFLICT (receipt_id) DO NOTHING`,
      [
        receipt.receiptId,
        receipt.taskId,
        receipt.subtaskId,
        receipt.agentId,
        receipt.coordinatorId,
        receipt.computeClass,
        receipt.credits,
        receipt.msat,
        receipt.msatPerCredit,
        receipt.startedAtMs,
        receipt.finishedAtMs,
        receipt.resultHash,
        JSON.stringify(receipt),
        Date.now()
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async get(receiptId: string): Promise<WorkReceipt | null> {
    const result = await this.pool.query(`SELECT receipt_json FROM work_receipts WHERE receipt_id = $1`, [receiptId]);
    const row = result.rows[0];
    return row ? PostgresReceiptStore.receiptFromRow(row) : null;
  }

  async listSince(cursor: string | null, limit?: number): Promise<ReceiptPage> {
    const after = parseCursor(cursor);
    const result = await this.pool.query(
      `SELECT seq, receipt_json FROM work_receipts WHERE seq > $1 ORDER BY seq ASC LIMIT $2`,
      [after, clampLimit(limit)]
    );
    const receipts = result.rows.map((row) => PostgresReceiptStore.receiptFromRow(row));
    const last = result.rows.length > 0 ? String(result.rows[result.rows.length - 1].seq) : String(after);
    return { receipts, nextCursor: last };
  }

  async listUnassigned(coordinatorId: string, untilMs: number, limit?: number): Promise<WorkReceipt[]> {
    const result = await this.pool.query(
      `SELECT receipt_json FROM work_receipts
       WHERE coordinator_id = $1 AND epoch_id IS NULL AND finished_at_ms < $2
       ORDER BY seq ASC LIMIT $3`,
      [coordinatorId, untilMs, clampLimit(limit, 10_000)]
    );
    return result.rows.map((row) => PostgresReceiptStore.receiptFromRow(row));
  }

  async listByEpoch(epochId: string): Promise<WorkReceipt[]> {
    const result = await this.pool.query(
      `SELECT receipt_json FROM work_receipts WHERE epoch_id = $1 ORDER BY seq ASC`,
      [epochId]
    );
    return result.rows.map((row) => PostgresReceiptStore.receiptFromRow(row));
  }

  async epochIdForReceipt(receiptId: string): Promise<string | null> {
    const result = await this.pool.query(`SELECT epoch_id FROM work_receipts WHERE receipt_id = $1`, [receiptId]);
    return result.rows[0]?.epoch_id ?? null;
  }

  async latestEpoch(coordinatorId: string): Promise<ReceiptEpoch | null> {
    const result = await this.pool.query(
      `SELECT ${RECEIPT_EPOCH_COLUMNS} FROM receipt_epochs WHERE coordinator_id = $1
       ORDER BY to_ms DESC, closed_at_ms DESC LIMIT 1`,
      [coordinatorId]
    );
    const row = result.rows[0];
    return row ? PostgresReceiptStore.epochFromRow(row) : null;
  }

  async getEpoch(epochId: string): Promise<ReceiptEpoch | null> {
    const result = await this.pool.query(`SELECT ${RECEIPT_EPOCH_COLUMNS} FROM receipt_epochs WHERE epoch_id = $1`, [epochId]);
    const row = result.rows[0];
    return row ? PostgresReceiptStore.epochFromRow(row) : null;
  }

  async persistEpoch(epoch: ReceiptEpoch, receiptIds?: string[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO receipt_epochs (${RECEIPT_EPOCH_COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (epoch_id) DO UPDATE SET
         anchor_tx_ref = COALESCE(EXCLUDED.anchor_tx_ref, receipt_epochs.anchor_tx_ref),
         anchor_network = COALESCE(EXCLUDED.anchor_network, receipt_epochs.anchor_network)`,
      [
        epoch.epochId,
        epoch.coordinatorId,
        epoch.fromMs,
        epoch.toMs,
        epoch.count,
        epoch.merkleRoot,
        epoch.previousRoot ?? null,
        epoch.signature,
        epoch.closedAtMs,
        epoch.anchorTxRef ?? null,
        epoch.anchorNetwork ?? null
      ]
    );
    if (receiptIds && receiptIds.length > 0) {
      await this.pool.query(`UPDATE work_receipts SET epoch_id = $1 WHERE receipt_id = ANY($2::text[])`, [epoch.epochId, receiptIds]);
    }
  }
}

/** Durable, cross-instance replay protection for signed agent requests (`request_nonces`). */
export class PostgresNonceStore implements NonceStore {
  constructor(private readonly pool: Pool) {}

  async exists(nonce: string): Promise<boolean> {
    const r = await this.pool.query(`SELECT 1 FROM request_nonces WHERE nonce = $1 AND expires_at_ms >= $2`, [nonce, Date.now()]);
    return (r.rowCount ?? 0) > 0;
  }

  async insert(nonce: string, sourceId: string, expiresAtMs: number): Promise<void> {
    await this.insertIfAbsent(nonce, sourceId, expiresAtMs);
  }

  /** One statement: a fresh nonce inserts (or takes over an expired row); a live duplicate does not. */
  async insertIfAbsent(nonce: string, sourceId: string, expiresAtMs: number): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO request_nonces (nonce, source_id, expires_at_ms) VALUES ($1, $2, $3)
       ON CONFLICT (nonce) DO UPDATE SET source_id = EXCLUDED.source_id, expires_at_ms = EXCLUDED.expires_at_ms
         WHERE request_nonces.expires_at_ms < $4
       RETURNING nonce`,
      [nonce, sourceId, expiresAtMs, Date.now()]
    );
    return (r.rowCount ?? 0) > 0;
  }

  async prune(): Promise<void> {
    await this.pool.query(`DELETE FROM request_nonces WHERE expires_at_ms < $1`, [Date.now()]);
  }
}

function rowToCallbackPin(row: any): CallbackPin {
  return {
    accountId: row.account_id,
    destination: row.destination,
    origin: row.callback_origin,
    pinnedAtMs: Number(row.pinned_at_ms),
    ...(row.changed_origin ? { changedOrigin: row.changed_origin, changedAtMs: Number(row.changed_at_ms) } : {}),
    ...(row.notified_at_ms != null ? { notifiedAtMs: Number(row.notified_at_ms) } : {})
  };
}

const PIN_COLUMNS = "account_id, destination, callback_origin, pinned_at_ms, changed_origin, changed_at_ms, notified_at_ms";

/** LNURL callback pins (`payout_callback_pins`), shared by every coordinator on this database. */
export class PostgresCallbackPinStore implements CallbackPinStore {
  constructor(private readonly pool: Pool) {}

  async getCallbackPin(accountId: string, destination: string): Promise<CallbackPin | null> {
    const r = await this.pool.query(`SELECT ${PIN_COLUMNS} FROM payout_callback_pins WHERE account_id = $1 AND destination = $2`, [accountId, destination]);
    return r.rows[0] ? rowToCallbackPin(r.rows[0]) : null;
  }

  async listCallbackPins(accountId: string): Promise<CallbackPin[]> {
    const r = await this.pool.query(`SELECT ${PIN_COLUMNS} FROM payout_callback_pins WHERE account_id = $1 ORDER BY pinned_at_ms`, [accountId]);
    return r.rows.map(rowToCallbackPin);
  }

  async pinCallbackOrigin(accountId: string, destination: string, origin: string, nowMs: number): Promise<CallbackPin> {
    await this.pool.query(
      `INSERT INTO payout_callback_pins (account_id, destination, callback_origin, pinned_at_ms) VALUES ($1,$2,$3,$4)
       ON CONFLICT (account_id, destination) DO NOTHING`,
      [accountId, destination, origin, nowMs]
    );
    return (await this.getCallbackPin(accountId, destination))!;
  }

  async markCallbackChanged(accountId: string, destination: string, changedOrigin: string, nowMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE payout_callback_pins SET changed_origin = $3, changed_at_ms = $4, notified_at_ms = NULL
       WHERE account_id = $1 AND destination = $2 AND changed_origin IS DISTINCT FROM $3`,
      [accountId, destination, changedOrigin, nowMs]
    );
  }

  async claimCallbackNotification(accountId: string, destination: string, nowMs: number): Promise<CallbackPin | null> {
    const r = await this.pool.query(
      `UPDATE payout_callback_pins SET notified_at_ms = $3
       WHERE account_id = $1 AND destination = $2 AND changed_origin IS NOT NULL AND notified_at_ms IS NULL
       RETURNING ${PIN_COLUMNS}`,
      [accountId, destination, nowMs]
    );
    return r.rows[0] ? rowToCallbackPin(r.rows[0]) : null;
  }

  async releaseCallbackNotification(accountId: string, destination: string): Promise<void> {
    await this.pool.query(`UPDATE payout_callback_pins SET notified_at_ms = NULL WHERE account_id = $1 AND destination = $2`, [accountId, destination]);
  }

  async confirmCallbackChange(accountId: string, destination: string, changedOrigin: string, nowMs: number): Promise<boolean> {
    const r = await this.pool.query(
      `UPDATE payout_callback_pins SET callback_origin = changed_origin, pinned_at_ms = $4, changed_origin = NULL, changed_at_ms = NULL, notified_at_ms = NULL
       WHERE account_id = $1 AND destination = $2 AND changed_origin = $3`,
      [accountId, destination, changedOrigin, nowMs]
    );
    return (r.rowCount ?? 0) > 0;
  }

  /** Infrastructure-host addresses of the same account keep their pins (they did not change). */
  async resetCallbackPins(accountId: string, keepDestination: string | null): Promise<void> {
    await this.pool.query(
      `DELETE FROM payout_callback_pins WHERE account_id = $1 AND destination IS DISTINCT FROM $2
         AND destination NOT IN (SELECT lightning_address FROM infrastructure_hosts WHERE account_id = $1 AND lightning_address IS NOT NULL)`,
      [accountId, keepDestination]
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mapIssuanceEpochRow(row: any): IssuanceEpochRecord {
  return {
    issuanceEpochId: row.issuance_epoch_id,
    coordinatorId: row.coordinator_id,
    windowStartMs: Number(row.window_start_ms),
    windowEndMs: Number(row.window_end_ms),
    loadIndex: Number(row.load_index),
    dailyPoolTokens: Number(row.daily_pool_tokens),
    hourlyTokens: Number(row.hourly_tokens),
    totalWeightedContribution: Number(row.total_weighted_contribution),
    contributionCount: Number(row.contribution_count),
    finalized: Boolean(row.finalized),
    createdAtMs: Number(row.created_at_ms)
  };
}
