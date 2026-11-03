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

/**
 * What an agent route does with an unsigned request: "rejected", or null (proceed unsigned).
 * - requireSigned: the route speaks for a named agent with no other auth (e.g. /benchmark/response),
 *   so it is signed-only whatever the policy;
 * - allowUnsigned: the route has its own auth for unsigned callers (mesh-token peer forwards);
 * - otherwise the REQUIRE_SIGNED_AGENT_REQUESTS policy decides.
 */
export function unsignedRequestDecision(input: { requireSignedPolicy: boolean; allowUnsigned?: boolean; requireSigned?: boolean }): "rejected" | null {
  if (input.requireSigned) return "rejected";
  return input.requireSignedPolicy && !input.allowUnsigned ? "rejected" : null;
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

/** What an agent may POST to /result: Fastify's default body limit, unchanged by #122. */
export const AGENT_RESULT_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * #122: /result route limit. A peer forward holds the published output (at most the agent's
 * body) plus the agent's signed body as a JSON string, where re-escaping can at worst double it:
 * <= 1 + 2 MiB for a max-size agent result. 4 MiB leaves room for the envelope and headers.
 */
export const RESULT_ROUTE_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

/** Only unsigned mesh-token requests (peer forwards) may use the larger route limit. */
export function resultBodyTooLarge(bytes: number, peerForwardCandidate: boolean): boolean {
  return bytes > (peerForwardCandidate ? RESULT_ROUTE_BODY_LIMIT_BYTES : AGENT_RESULT_BODY_LIMIT_BYTES);
}
