// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

export type SecurityLevel = "INFO" | "WARN" | "HIGH" | "CRITICAL";

export type SecurityEventType =
  | "failed_auth"
  | "auth_rate_limit_hit"
  | "agent_rate_limited"
  | "agent_lease_traffic_rate_limited"
  | "replay_attempt"
  | "invalid_signature"
  | "manifest_signature_failure"
  | "ledger_chain_break"
  | "blacklist_chain_tamper"
  | "agent_trust_violation"
  | "key_rotation"
  | "key_rotation_overdue"
  | "key_expired"
  | "ast_validation_rejection"
  | "sandbox_timeout"
  | "sandbox_seccomp_violation"
  | "binary_integrity_failure"
  | "behavioral_anomaly_detected"
  | "auto_blacklist_triggered"
  | "claim_abandoned"
  | "agent_went_offline"
  | "result_verification_mismatch"
  | "result_verification_replica_abandoned"
  | "hardware_challenge_invalid"
  | "hardware_witness_disagreement"
  | "inference_output_degenerate"
  | "host_heartbeat_rejected"
  | "payout_limit_exceeded"
  | "payout_blocked_paused"
  | "payout_callback_changed"
  | "payouts_paused"
  | "payouts_resumed"
  | "payout_reconciliation_mismatch"
  | "payout_reconciliation_error"
  | "ledger_reconciliation_mismatch"
  | "revenue_withdrawal"
  | "onchain_deposit_held"
  | "onchain_deposit_reversed"
  | "onchain_batch_resurfaced"
  | "onchain_batch_stuck"
  | "model_control_not_owner"
  | "bot_control_not_owner"
  | "code_control_not_owner"
  | "code_session_mode_change"
  | "restricted_model_call"
  | "restricted_model_refused"
  | "restricted_access_suspended";

export interface SecurityEvent {
  timestamp: string;
  level: SecurityLevel;
  event: SecurityEventType;
  source: { type: "agent" | "coordinator" | "system"; id: string; ip?: string };
  details?: Record<string, unknown>;
  action: string;
  coordinatorId: string;
}

const SEVERITY_MAP: Record<SecurityEventType, SecurityLevel> = {
  failed_auth: "WARN",
  auth_rate_limit_hit: "HIGH",
  // A proven agent over its own request budget: throttled with 429, not an attack signal.
  agent_rate_limited: "INFO",
  // Its /result or lease heartbeat was refused: its claims may lapse and their calls be lost. An
  // operations signal (the budget is too small for the host), logged at most once a minute per agent.
  agent_lease_traffic_rate_limited: "WARN",
  replay_attempt: "HIGH",
  invalid_signature: "HIGH",
  manifest_signature_failure: "CRITICAL",
  ledger_chain_break: "CRITICAL",
  blacklist_chain_tamper: "CRITICAL",
  agent_trust_violation: "HIGH",
  key_rotation: "INFO",
  key_rotation_overdue: "WARN",
  key_expired: "CRITICAL",
  ast_validation_rejection: "INFO",
  claim_abandoned: "INFO",
  agent_went_offline: "INFO",
  sandbox_timeout: "WARN",
  sandbox_seccomp_violation: "HIGH",
  binary_integrity_failure: "HIGH",
  result_verification_mismatch: "HIGH",
  result_verification_replica_abandoned: "HIGH",
  behavioral_anomaly_detected: "WARN",
  auto_blacklist_triggered: "CRITICAL",
  hardware_challenge_invalid: "WARN",
  hardware_witness_disagreement: "WARN",
  inference_output_degenerate: "WARN",
  host_heartbeat_rejected: "HIGH",
  payout_limit_exceeded: "HIGH",
  payout_blocked_paused: "WARN",
  payout_callback_changed: "HIGH",
  payouts_paused: "CRITICAL",
  payouts_resumed: "HIGH",
  payout_reconciliation_mismatch: "CRITICAL",
  payout_reconciliation_error: "WARN",
  ledger_reconciliation_mismatch: "HIGH",
  // EdgeCoder's fee revenue leaving the hot wallet (POST /admin/revenue/withdraw): always worth a look.
  revenue_withdrawal: "HIGH",
  // On-chain (src/economy/onchain*.ts): a deposit over a cap waits for an operator; a credited
  // deposit gone from the chain or a released batch found in the node is money at risk.
  onchain_deposit_held: "WARN",
  onchain_deposit_reversed: "CRITICAL",
  onchain_batch_resurfaced: "CRITICAL",
  onchain_batch_stuck: "HIGH",
  // A portal session asked to control a machine its account does not own (src/swarm/coordinator/model-control.ts).
  model_control_not_owner: "HIGH",
  bot_control_not_owner: "HIGH",
  code_control_not_owner: "HIGH",
  // The owner set a coding session to Auto or Full access from the web or the iPhone (routes/code-relay.ts).
  code_session_mode_change: "INFO",
  // Security research tier (docs/security-research-tier.md): every restricted-model call is recorded.
  restricted_model_call: "INFO",
  restricted_model_refused: "WARN",
  restricted_access_suspended: "HIGH"
};

export class SecurityEventLogger {
  private readonly sink: (event: SecurityEvent) => void;
  private readonly listeners: Array<(event: SecurityEvent) => void> = [];

  constructor(sink: (event: SecurityEvent) => void) {
    this.sink = sink;
  }

  severity(eventType: SecurityEventType): SecurityLevel {
    return SEVERITY_MAP[eventType] ?? "WARN";
  }

  /** Also hand every event to `listener` (production alerting, src/alerting). A listener that throws is ignored. */
  addListener(listener: (event: SecurityEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  log(params: Omit<SecurityEvent, "timestamp">): void {
    const event: SecurityEvent = { ...params, timestamp: new Date().toISOString() };
    this.sink(event);
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // Alerting never breaks the security log.
      }
    }
  }
}
