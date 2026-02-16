import { Pool } from "pg";
import {
  AccountMembership,
  AgentOwnership,
  BlacklistRecord,
  CoordinatorFeeEvent,
  CreditAccount,
  KeyCustodyEvent,
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

const SCHEMA_SQL = `
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
  last_seen_ms BIGINT NOT NULL
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

  async upsertAgent(input: {
    agentId: string;
    os: string;
    version: string;
    mode: string;
    localModelEnabled: boolean;
    lastSeenMs: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_registry (agent_id, os, version, mode, local_model_enabled, last_seen_ms)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (agent_id) DO UPDATE SET
         os = EXCLUDED.os,
         version = EXCLUDED.version,
         mode = EXCLUDED.mode,
         local_model_enabled = EXCLUDED.local_model_enabled,
         last_seen_ms = EXCLUDED.last_seen_ms`,
      [input.agentId, input.os, input.version, input.mode, input.localModelEnabled, input.lastSeenMs]
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
    }>
  > {
    const result = await this.pool.query(
      `SELECT agent_id, os, version, mode, local_model_enabled, last_seen_ms
       FROM agent_registry
       ORDER BY last_seen_ms DESC`
    );
    return result.rows.map((row) => ({
      agentId: row.agent_id,
      os: row.os,
      version: row.version,
      mode: row.mode,
      localModelEnabled: Boolean(row.local_model_enabled),
      lastSeenMs: Number(row.last_seen_ms)
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

