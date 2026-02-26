// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

export type SecurityLevel = "INFO" | "WARN" | "HIGH" | "CRITICAL";

export type SecurityEventType =
  | "failed_auth"
  | "auth_rate_limit_hit"
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
  | "sandbox_seccomp_violation";

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
  sandbox_timeout: "WARN",
  sandbox_seccomp_violation: "HIGH",
};

export class SecurityEventLogger {
  private readonly sink: (event: SecurityEvent) => void;

  constructor(sink: (event: SecurityEvent) => void) {
    this.sink = sink;
  }

  severity(eventType: SecurityEventType): SecurityLevel {
    return SEVERITY_MAP[eventType] ?? "WARN";
  }

  log(params: Omit<SecurityEvent, "timestamp">): void {
    this.sink({
      ...params,
      timestamp: new Date().toISOString(),
    });
  }
}
