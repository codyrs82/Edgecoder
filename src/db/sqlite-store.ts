// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import Database from "better-sqlite3";

// Row types for query results
export interface TaskHistoryRow {
  subtaskId: string;
  taskId: string;
  prompt: string;
  language: string;
  status: string;
  output: string | null;
  error: string | null;
  durationMs: number | null;
  provider: string | null;
  coordinatorUrl: string | null;
  createdAt: number;
  completedAt: number | null;
}

export interface BLEPeerRow {
  agentId: string;
  model: string;
  modelParamSize: number;
  deviceType: string;
  rssi: number;
  lastSeenAt: number;
  taskSuccessCount: number;
  taskFailCount: number;
}

export interface HeartbeatRow {
  id: number;
  coordinatorUrl: string;
  status: string;
  latencyMs: number | null;
  creditsRemaining: number | null;
  createdAt: number;
}

export interface PendingResultRow {
  subtaskId: string;
  payload: string;
  attempts: number;
  createdAt: number;
  lastAttemptAt: number | null;
}

export interface BLECreditLedgerRow {
  txId: string;
  requesterId: string;
  providerId: string;
  credits: number;
  cpuSeconds: number;
  taskHash: string;
  createdAt: number;
  synced: number;
  requesterSig: string;
  providerSig: string;
}

export interface OutboundTaskRow {
  id: string;
  targetAgentId: string;
  prompt: string;
  language: string;
  status: string;
  responseOutput: string | null;
  createdAt: number;
  sentAt: number | null;
  completedAt: number | null;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_history (
  subtask_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'python',
  status TEXT NOT NULL DEFAULT 'pending',
  output TEXT,
  error TEXT,
  duration_ms INTEGER,
  provider TEXT,
  coordinator_url TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS ble_peers (
  agent_id TEXT PRIMARY KEY,
  model TEXT NOT NULL DEFAULT '',
  model_param_size REAL NOT NULL DEFAULT 0,
  device_type TEXT NOT NULL DEFAULT 'unknown',
  rssi INTEGER NOT NULL DEFAULT -100,
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
  task_success_count INTEGER NOT NULL DEFAULT 0,
  task_fail_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS heartbeat_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  coordinator_url TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  credits_remaining REAL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS kv_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS pending_results (
  subtask_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER
);

CREATE TABLE IF NOT EXISTS ble_credit_ledger (
  tx_id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  credits REAL NOT NULL,
  cpu_seconds REAL NOT NULL,
  task_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  synced INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outbound_task_queue (
  id TEXT PRIMARY KEY,
  target_agent_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'python',
  status TEXT NOT NULL DEFAULT 'queued',
  response_output TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  sent_at INTEGER,
  completed_at INTEGER
);
`;

export class SQLiteStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    // Idempotent migration: add signature columns to ble_credit_ledger
    try { this.db.exec("ALTER TABLE ble_credit_ledger ADD COLUMN requester_sig TEXT NOT NULL DEFAULT ''"); } catch {}
    try { this.db.exec("ALTER TABLE ble_credit_ledger ADD COLUMN provider_sig TEXT NOT NULL DEFAULT ''"); } catch {}
  }

  close(): void {
    this.db.close();
  }

  // ── Task History ──────────────────────────────────────────────

  recordTaskStart(
    subtaskId: string,
    taskId: string,
    prompt: string,
    language: string,
    provider: string,
    coordinatorUrl: string
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO task_history (subtask_id, task_id, prompt, language, status, provider, coordinator_url)
         VALUES (?, ?, ?, ?, 'running', ?, ?)`
      )
      .run(subtaskId, taskId, prompt, language, provider, coordinatorUrl);
  }

  recordTaskComplete(subtaskId: string, output: string, durationMs: number): void {
    this.db
      .prepare(
        `UPDATE task_history SET status = 'completed', output = ?, duration_ms = ?, completed_at = unixepoch()
         WHERE subtask_id = ?`
      )
      .run(output, durationMs, subtaskId);
  }

  recordTaskFailed(subtaskId: string, error: string, durationMs: number): void {
    this.db
      .prepare(
        `UPDATE task_history SET status = 'failed', error = ?, duration_ms = ?, completed_at = unixepoch()
         WHERE subtask_id = ?`
      )
      .run(error, durationMs, subtaskId);
  }

  recentTasks(limit = 50): TaskHistoryRow[] {
    return this.db
      .prepare(
        `SELECT subtask_id as subtaskId, task_id as taskId, prompt, language, status,
                output, error, duration_ms as durationMs, provider,
                coordinator_url as coordinatorUrl, created_at as createdAt, completed_at as completedAt
         FROM task_history ORDER BY created_at DESC LIMIT ?`
      )
      .all(limit) as TaskHistoryRow[];
  }

  taskStats(): { total: number; completed: number; failed: number; avgDurationMs: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                COALESCE(AVG(CASE WHEN status = 'completed' THEN duration_ms END), 0) as avgDurationMs
         FROM task_history`
      )
      .get() as { total: number; completed: number; failed: number; avgDurationMs: number };
    return row;
  }

  // ── BLE Peers ─────────────────────────────────────────────────

  upsertBLEPeer(
    agentId: string,
    model: string,
    modelParamSize: number,
    deviceType: string,
    rssi: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO ble_peers (agent_id, model, model_param_size, device_type, rssi, last_seen_at)
         VALUES (?, ?, ?, ?, ?, unixepoch())
         ON CONFLICT(agent_id) DO UPDATE SET
           model = excluded.model,
           model_param_size = excluded.model_param_size,
           device_type = excluded.device_type,
           rssi = excluded.rssi,
           last_seen_at = unixepoch()`
      )
      .run(agentId, model, modelParamSize, deviceType, rssi);
  }

  recordBLETaskResult(agentId: string, success: boolean): void {
    if (success) {
      this.db
        .prepare(`UPDATE ble_peers SET task_success_count = task_success_count + 1 WHERE agent_id = ?`)
        .run(agentId);
    } else {
      this.db
        .prepare(`UPDATE ble_peers SET task_fail_count = task_fail_count + 1 WHERE agent_id = ?`)
        .run(agentId);
    }
  }

  listBLEPeers(): BLEPeerRow[] {
    return this.db
      .prepare(
        `SELECT agent_id as agentId, model, model_param_size as modelParamSize,
                device_type as deviceType, rssi, last_seen_at as lastSeenAt,
                task_success_count as taskSuccessCount, task_fail_count as taskFailCount
         FROM ble_peers ORDER BY last_seen_at DESC`
      )
      .all() as BLEPeerRow[];
  }

  evictStaleBLEPeers(maxAgeSeconds: number): number {
    const result = this.db
      .prepare(`DELETE FROM ble_peers WHERE last_seen_at < unixepoch() - ?`)
      .run(maxAgeSeconds);
    return result.changes;
  }

  // ── Heartbeat Log ─────────────────────────────────────────────

  recordHeartbeat(
    coordinatorUrl: string,
    status: string,
    latencyMs: number,
    creditsRemaining?: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO heartbeat_log (coordinator_url, status, latency_ms, credits_remaining)
         VALUES (?, ?, ?, ?)`
      )
      .run(coordinatorUrl, status, latencyMs, creditsRemaining ?? null);

    // Trim old entries (keep last 1000)
    this.db
      .prepare(
        `DELETE FROM heartbeat_log WHERE id NOT IN (SELECT id FROM heartbeat_log ORDER BY id DESC LIMIT 1000)`
      )
      .run();
  }

  recentHeartbeats(limit = 20): HeartbeatRow[] {
    return this.db
      .prepare(
        `SELECT id, coordinator_url as coordinatorUrl, status,
                latency_ms as latencyMs, credits_remaining as creditsRemaining,
                created_at as createdAt
         FROM heartbeat_log ORDER BY id DESC LIMIT ?`
      )
      .all(limit) as HeartbeatRow[];
  }

  // ── KV Config ─────────────────────────────────────────────────

  getConfig(key: string): string | undefined {
    const row = this.db
      .prepare(`SELECT value FROM kv_config WHERE key = ?`)
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setConfig(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO kv_config (key, value, updated_at) VALUES (?, ?, unixepoch())
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
      )
      .run(key, value);
  }

  getConfigWithTTL(key: string, maxAgeMs: number): string | undefined {
    const row = this.db
      .prepare(`SELECT value, updated_at FROM kv_config WHERE key = ?`)
      .get(key) as { value: string; updated_at: number } | undefined;
    if (!row) return undefined;
    const ageMs = (Date.now() / 1000 - row.updated_at) * 1000;
    if (ageMs > maxAgeMs) return undefined;
    return row.value;
  }

  deleteConfig(key: string): void {
    this.db.prepare(`DELETE FROM kv_config WHERE key = ?`).run(key);
  }

  // ── Outbound Task Queue ───────────────────────────────────────

  enqueueOutboundTask(id: string, targetAgentId: string, prompt: string, language: string): void {
    this.db
      .prepare(
        `INSERT INTO outbound_task_queue (id, target_agent_id, prompt, language)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, targetAgentId, prompt, language);
  }

  claimNextOutbound(targetAgentId: string): OutboundTaskRow | null {
    const row = this.db
      .prepare(
        `SELECT id, target_agent_id as targetAgentId, prompt, language, status,
                response_output as responseOutput, created_at as createdAt,
                sent_at as sentAt, completed_at as completedAt
         FROM outbound_task_queue
         WHERE status = 'queued' AND target_agent_id = ?
         ORDER BY created_at ASC LIMIT 1`
      )
      .get(targetAgentId) as OutboundTaskRow | undefined;

    if (!row) return null;

    this.db
      .prepare(`UPDATE outbound_task_queue SET status = 'sent', sent_at = unixepoch() WHERE id = ?`)
      .run(row.id);

    return row;
  }

  completeOutbound(id: string, output: string): void {
    this.db
      .prepare(
        `UPDATE outbound_task_queue SET status = 'completed', response_output = ?, completed_at = unixepoch()
         WHERE id = ?`
      )
      .run(output, id);
  }

  failOutbound(id: string): void {
    this.db
      .prepare(`UPDATE outbound_task_queue SET status = 'failed', completed_at = unixepoch() WHERE id = ?`)
      .run(id);
  }

  // ── Pending Results (offline buffer) ────────────────────────

  enqueuePendingResult(subtaskId: string, payload: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pending_results (subtask_id, payload)
         VALUES (?, ?)`
      )
      .run(subtaskId, payload);
  }

  listPendingResults(limit = 20): PendingResultRow[] {
    return this.db
      .prepare(
        `SELECT subtask_id as subtaskId, payload, attempts,
                created_at as createdAt, last_attempt_at as lastAttemptAt
         FROM pending_results ORDER BY created_at ASC LIMIT ?`
      )
      .all(limit) as PendingResultRow[];
  }

  markResultSynced(subtaskId: string): void {
    this.db
      .prepare(`DELETE FROM pending_results WHERE subtask_id = ?`)
      .run(subtaskId);
  }

  incrementResultAttempt(subtaskId: string): void {
    this.db
      .prepare(
        `UPDATE pending_results SET attempts = attempts + 1, last_attempt_at = unixepoch()
         WHERE subtask_id = ?`
      )
      .run(subtaskId);
  }

  // ── BLE Credit Ledger ───────────────────────────────────────

  recordBLECreditTx(
    txId: string,
    requesterId: string,
    providerId: string,
    credits: number,
    cpuSeconds: number,
    taskHash: string,
    requesterSig = "",
    providerSig = ""
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ble_credit_ledger (tx_id, requester_id, provider_id, credits, cpu_seconds, task_hash, requester_sig, provider_sig)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(txId, requesterId, providerId, credits, cpuSeconds, taskHash, requesterSig, providerSig);
  }

  listUnsyncedBLECredits(limit = 50): BLECreditLedgerRow[] {
    return this.db
      .prepare(
        `SELECT tx_id as txId, requester_id as requesterId, provider_id as providerId,
                credits, cpu_seconds as cpuSeconds, task_hash as taskHash,
                created_at as createdAt, synced,
                requester_sig as requesterSig, provider_sig as providerSig
         FROM ble_credit_ledger WHERE synced = 0 ORDER BY created_at ASC LIMIT ?`
      )
      .all(limit) as BLECreditLedgerRow[];
  }

  markBLECreditsSynced(txIds: string[]): void {
    if (txIds.length === 0) return;
    const placeholders = txIds.map(() => "?").join(",");
    this.db
      .prepare(`UPDATE ble_credit_ledger SET synced = 1 WHERE tx_id IN (${placeholders})`)
      .run(...txIds);
  }
}
