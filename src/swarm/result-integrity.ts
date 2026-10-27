// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * #44: /result integrity helpers (signature policy, claim ownership, server-side
 * duration, idempotent report ids). Pure functions so they can be unit tested
 * without booting the coordinator.
 */

/** Defaults to true; always true in production. */
export function requireSignedAgentRequests(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "production") return true;
  return (env.REQUIRE_SIGNED_AGENT_REQUESTS ?? "true").trim().toLowerCase() !== "false";
}

export interface ClaimRecord {
  subtask: { id: string; timeoutMs: number };
  claimedBy?: string;
  claimedAt?: number;
}

export type ClaimCheck =
  | { ok: true }
  | { ok: false; code: 409; error: "subtask_not_claimed_or_done" }
  | { ok: false; code: 403; error: "not_claimant" };

export function checkResultClaim(claim: ClaimRecord | undefined, agentId: string): ClaimCheck {
  if (!claim || !claim.claimedBy) return { ok: false, code: 409, error: "subtask_not_claimed_or_done" };
  if (claim.claimedBy !== agentId) return { ok: false, code: 403, error: "not_claimant" };
  return { ok: true };
}

/** Credited duration = min(reported, measured since claim, subtask timeout), never negative. */
export function creditedDurationMs(reportedMs: number, claim: ClaimRecord, now = Date.now()): number {
  const measuredMs = now - (claim.claimedAt ?? now);
  const reported = Number.isFinite(reportedMs) ? reportedMs : 0;
  const timeout = Number.isFinite(claim.subtask.timeoutMs) && claim.subtask.timeoutMs > 0 ? claim.subtask.timeoutMs : 0;
  return Math.max(0, Math.min(reported, measuredMs, timeout));
}

/** Deterministic report id so a re-posted result can never accrue twice. */
export function resultReportId(subtaskId: string): string {
  return `result:${subtaskId}`;
}

export type ResultAuth = "agent" | "peer_forward" | "unsigned_legacy" | "reject";

/**
 * Who may post a result:
 * - "agent": valid agent request signature (claim ownership checked by caller)
 * - "peer_forward": unsigned, configured+valid mesh token, and no local claim (gossip-offered
 *   subtask executed on another coordinator) — bookkeeping only, no credits
 * - "unsigned_legacy": unsigned while REQUIRE_SIGNED_AGENT_REQUESTS=false (non-prod only)
 * - "reject": everything else (401)
 */
export function classifyResultAuth(input: {
  verified: { agentId: string } | "rejected" | null;
  hasLocalClaim: boolean;
  meshTokenConfigured: boolean;
  meshTokenValid: boolean;
  requireSigned: boolean;
}): ResultAuth {
  if (input.verified === "rejected") return "reject";
  if (input.verified) return "agent";
  if (!input.hasLocalClaim && input.meshTokenConfigured && input.meshTokenValid) return "peer_forward";
  return input.requireSigned ? "reject" : "unsigned_legacy";
}
