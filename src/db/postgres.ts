import { Pool } from "pg";
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
  TreasuryPolicy,
  QueueEventRecord,
  Subtask,
  SubtaskResult,
  CreditTransaction,
  WalletAccount
} from "../common/types.js";

export const SCHEMA_SQL = `
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
  credits DOUBLE PRECISION NOT NULL,
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
  quoted_credits DOUBLE PRECISION NOT NULL,
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

CREATE TABLE IF NOT EXISTS issuance_payout_events (
  payout_event_id TEXT PRIMARY KEY,
  issuance_epoch_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  payout_type TEXT NOT NULL,
  tokens DOUBLE PRECISION NOT NULL,
  source_intent_id TEXT,
  created_at_ms BIGINT NOT NULL
);
`;

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

  async persistStatsLedgerRecord(record: QueueEventRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO stats_ledger_records (
         id, event_type, task_id, subtask_id, actor_id, sequence, issued_at_ms, prev_hash,
         coordinator_id, checkpoint_height, checkpoint_hash, payload_json, hash, signature, ingested_at_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
        record.coordinatorId ?? null,
        record.checkpointHeight ?? null,
        record.checkpointHash ?? null,
        record.payloadJson ? JSON.parse(record.payloadJson) : null,
        record.hash,
        record.signature,
        Date.now()
      ]
    );
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

  async latestStatsLedgerHead(): Promise<{
    issuedAtMs: number;
    hash: string;
    count: number;
  } | null> {
    const latestResult = await this.pool.query(
      `SELECT issued_at_ms, hash
       FROM stats_ledger_records
       ORDER BY issued_at_ms DESC, id DESC
       LIMIT 1`
    );
    if (!latestResult.rows[0]) return null;
    const countResult = await this.pool.query(`SELECT COUNT(*)::BIGINT AS count FROM stats_ledger_records`);
    return {
      issuedAtMs: Number(latestResult.rows[0].issued_at_ms),
      hash: latestResult.rows[0].hash,
      count: Number(countResult.rows[0]?.count ?? 0)
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
         tx_id, account_id, tx_type, credits, reason, related_task_id, timestamp_ms
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tx_id) DO NOTHING`,
      [tx.txId, tx.accountId, tx.type, tx.credits, tx.reason, tx.relatedTaskId ?? null, tx.timestampMs]
    );
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

  async creditContributionStats(accountId: string): Promise<{ earned: number; spent: number }> {
    const result = await this.pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN tx_type = 'earn' AND reason = 'compute_contribution' THEN credits ELSE 0 END), 0) AS earned,
         COALESCE(SUM(CASE WHEN tx_type = 'spend' AND reason = 'task_submit' THEN credits ELSE 0 END), 0) AS spent
       FROM credit_transactions
       WHERE account_id = $1`,
      [accountId]
    );
    return {
      earned: Number(result.rows[0]?.earned ?? 0),
      spent: Number(result.rows[0]?.spent ?? 0)
    };
  }

  async persistComputeContributionReport(input: {
    report: ComputeContributionReport;
    accountId: string;
    sourceAgentId: string;
    reliabilityScore: number;
    weightedContribution: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO compute_contribution_reports (
        report_id, account_id, source_agent_id, task_id, resource_class, cpu_seconds, gpu_seconds,
        quality_score, reliability_score, weighted_contribution, timestamp_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (report_id) DO NOTHING`,
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

  async latestIssuanceEpoch(finalizedOnly = false): Promise<IssuanceEpochRecord | null> {
    const where = finalizedOnly ? "WHERE finalized = TRUE" : "";
    const result = await this.pool.query(
      `SELECT issuance_epoch_id, coordinator_id, window_start_ms, window_end_ms, load_index, daily_pool_tokens,
              hourly_tokens, total_weighted_contribution, contribution_count, finalized, created_at_ms
       FROM issuance_epochs
       ${where}
       ORDER BY created_at_ms DESC
       LIMIT 1`
    );
    const row = result.rows[0];
    if (!row) return null;
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

  async listIssuanceEpochs(limit = 50): Promise<IssuanceEpochRecord[]> {
    const result = await this.pool.query(
      `SELECT issuance_epoch_id, coordinator_id, window_start_ms, window_end_ms, load_index, daily_pool_tokens,
              hourly_tokens, total_weighted_contribution, contribution_count, finalized, created_at_ms
       FROM issuance_epochs
       ORDER BY created_at_ms DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({
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
    }));
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
        anchor_id, epoch_id, checkpoint_hash, anchor_network, tx_ref, status, anchored_at_ms, created_at_ms
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (anchor_id) DO UPDATE SET
        tx_ref = EXCLUDED.tx_ref,
        status = EXCLUDED.status,
        anchored_at_ms = EXCLUDED.anchored_at_ms`,
      [
        record.anchorId,
        record.epochId,
        record.checkpointHash,
        record.anchorNetwork,
        record.txRef,
        record.status,
        record.anchoredAtMs ?? null,
        record.createdAtMs
      ]
    );
  }

  async latestAnchor(): Promise<BitcoinAnchorRecord | null> {
    const result = await this.pool.query(
      `SELECT anchor_id, epoch_id, checkpoint_hash, anchor_network, tx_ref, status, anchored_at_ms, created_at_ms
       FROM bitcoin_anchor_records
       ORDER BY created_at_ms DESC
       LIMIT 1`
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      anchorId: row.anchor_id,
      epochId: row.epoch_id,
      checkpointHash: row.checkpoint_hash,
      anchorNetwork: row.anchor_network,
      txRef: row.tx_ref,
      status: row.status,
      anchoredAtMs: row.anchored_at_ms ? Number(row.anchored_at_ms) : undefined,
      createdAtMs: Number(row.created_at_ms)
    };
  }

  async listAnchors(limit = 100): Promise<BitcoinAnchorRecord[]> {
    const result = await this.pool.query(
      `SELECT anchor_id, epoch_id, checkpoint_hash, anchor_network, tx_ref, status, anchored_at_ms, created_at_ms
       FROM bitcoin_anchor_records
       ORDER BY created_at_ms DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      anchorId: row.anchor_id,
      epochId: row.epoch_id,
      checkpointHash: row.checkpoint_hash,
      anchorNetwork: row.anchor_network,
      txRef: row.tx_ref,
      status: row.status,
      anchoredAtMs: row.anchored_at_ms ? Number(row.anchored_at_ms) : undefined,
      createdAtMs: Number(row.created_at_ms)
    }));
  }

  async latestAnchorByCheckpoint(checkpointHash: string): Promise<BitcoinAnchorRecord | null> {
    const result = await this.pool.query(
      `SELECT anchor_id, epoch_id, checkpoint_hash, anchor_network, tx_ref, status, anchored_at_ms, created_at_ms
       FROM bitcoin_anchor_records
       WHERE checkpoint_hash = $1
       ORDER BY created_at_ms DESC
       LIMIT 1`,
      [checkpointHash]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      anchorId: row.anchor_id,
      epochId: row.epoch_id,
      checkpointHash: row.checkpoint_hash,
      anchorNetwork: row.anchor_network,
      txRef: row.tx_ref,
      status: row.status,
      anchoredAtMs: row.anchored_at_ms ? Number(row.anchored_at_ms) : undefined,
      createdAtMs: Number(row.created_at_ms)
    };
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

  async upsertWalletAccount(wallet: WalletAccount): Promise<void> {
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
        encrypted_secret_ref = EXCLUDED.encrypted_secret_ref`,
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
      `SELECT account_id, wallet_type, network, xpub, ln_node_pubkey, payout_address, encrypted_secret_ref, created_at_ms
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
      createdAtMs: Number(row.created_at_ms)
    };
  }

  async upsertPaymentIntent(intent: PaymentIntent): Promise<void> {
    await this.pool.query(
      `INSERT INTO payment_intents (
        intent_id, account_id, coordinator_id, wallet_type, network, invoice_ref, amount_sats,
        coordinator_fee_bps, coordinator_fee_sats, net_sats, quoted_credits, status, created_at_ms,
        settled_at_ms, tx_ref
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (intent_id) DO UPDATE SET
        status = EXCLUDED.status,
        settled_at_ms = EXCLUDED.settled_at_ms,
        tx_ref = EXCLUDED.tx_ref`,
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
        intent.txRef ?? null
      ]
    );
  }

  async getPaymentIntent(intentId: string): Promise<PaymentIntent | null> {
    const result = await this.pool.query(
      `SELECT intent_id, account_id, coordinator_id, wallet_type, network, invoice_ref, amount_sats,
              coordinator_fee_bps, coordinator_fee_sats, net_sats, quoted_credits, status, created_at_ms,
              settled_at_ms, tx_ref
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
      txRef: row.tx_ref ?? undefined
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
              settled_at_ms, tx_ref
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
      txRef: row.tx_ref ?? undefined
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

