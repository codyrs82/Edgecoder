// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Portal enrollment check for agents and coordinators that register with this node.
 */
import { request } from "undici";
import { pgStore } from "../../db/store.js";
import { app } from "./app.js";
import { identity, PORTAL_SERVICE_URL, PORTAL_OUTBOUND_TOKEN } from "./context.js";
import { ordering, agentCapabilities } from "./agent-state.js";
import { persistStatsLedgerRecord } from "./stats-ledger.js";

/**
 * The portal owns node enrollment, so a portal-validated agent's earnings and spending belong to
 * the enrolling user's account (acct-<userId>, as the portal names it). Linked on every validated
 * registration: re-enrolling a node is the owner's alone (portal upsertNodeEnrollment).
 */
async function linkPortalOwnership(agentId: string, ownerUserId: string): Promise<void> {
  if (!pgStore) return;
  const accountId = `acct-${ownerUserId}`;
  try {
    const existing = await pgStore.getAgentOwnership(agentId);
    if (existing?.accountId === accountId && existing.ownerUserId === ownerUserId) return;
    await pgStore.linkAgentOwnership({ agentId, accountId, ownerUserId });
  } catch (err) {
    app.log.warn({ err, agentId }, "agent_ownership_link_failed");
  }
}

export async function validatePortalNode(input: {
  nodeId: string;
  nodeKind: "agent" | "coordinator";
  registrationToken?: string;
  deviceId?: string;
  /** Client IP for the portal's geo/VPN checks and the audit record. Never used for trust. */
  sourceIp?: string;
  /** The TCP peer is this machine (embedded worker). Decided from the socket, never headers. */
  loopback?: boolean;
  /**
   * The request is signed by the public key this coordinator already holds for the agent, and does
   * not change that key. Only then may an agent re-register without a portal-validated token.
   */
  proofOfKey?: boolean;
}): Promise<{
  allowed: boolean;
  reason?: string;
  ownerEmail?: string;
  sourceIp?: string;
  countryCode?: string;
  vpnDetected?: boolean;
}> {
  const appendValidationEvent = async (outcome: { allowed: boolean; reason?: string; ownerEmail?: string }) => {
    try {
      const validationRecord = ordering.append({
        eventType: "node_validation",
        taskId: `${input.nodeKind}:${input.nodeId}`,
        actorId: input.nodeId,
        coordinatorId: identity.peerId,
        payloadJson: JSON.stringify({
          nodeKind: input.nodeKind,
          sourceIp: input.sourceIp,
          allowed: outcome.allowed,
          reason: outcome.reason ?? null,
          ownerEmail: outcome.ownerEmail ?? null
        })
      });
      const validationAuditTimeoutMs = 2_000;
      await Promise.race([
        Promise.all([pgStore?.persistLedgerRecord(validationRecord), persistStatsLedgerRecord(validationRecord)]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("validation_audit_persist_timeout")), validationAuditTimeoutMs)
        )
      ]);
    } catch {
      // Best-effort audit signal; validation path should not fail due to ledger write.
    }
  };
  // A known agent may skip the portal only by proving it holds the key already registered for it.
  // Knowing an agent ID is not enough to re-register it with a new key.
  const allowIfKnownAgent = (reason: string): {
    allowed: boolean;
    reason?: string;
    ownerEmail?: string;
    sourceIp?: string;
    countryCode?: string;
    vpnDetected?: boolean;
  } | null => {
    if (input.nodeKind !== "agent" || input.proofOfKey !== true) return null;
    const existing = agentCapabilities.get(input.nodeId);
    if (!existing?.publicKeyPem) return null;
    return {
      allowed: true,
      reason,
      ownerEmail: existing.ownerEmail,
      sourceIp: existing.sourceIp,
      countryCode: existing.countryCode,
      vpnDetected: existing.vpnDetected
    };
  };
  if (!PORTAL_SERVICE_URL) {
    const outcome = { allowed: true, reason: "portal_validation_disabled" };
    await appendValidationEvent(outcome);
    return outcome;
  }
  // Allow loopback registrations: the embedded worker self-registers against its own coordinator.
  // input.loopback comes from the socket address; a forwarded-IP header cannot set it.
  if (input.loopback === true) {
    const outcome = { allowed: true, reason: "loopback_self_registration" };
    await appendValidationEvent(outcome);
    return outcome;
  }
  if (!input.registrationToken) {
    const cached = allowIfKnownAgent("registration_token_missing_proven_key");
    if (cached) {
      await appendValidationEvent(cached);
      return cached;
    }
    const outcome = { allowed: false, reason: "registration_token_required" };
    await appendValidationEvent(outcome);
    return outcome;
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (PORTAL_OUTBOUND_TOKEN) headers["x-portal-service-token"] = PORTAL_OUTBOUND_TOKEN;
  try {
    const portalValidationTimeoutMs = 5_000;
    const res = await request(`${PORTAL_SERVICE_URL}/internal/nodes/validate`, {
      method: "POST",
      headers,
      headersTimeout: portalValidationTimeoutMs,
      bodyTimeout: portalValidationTimeoutMs,
      body: JSON.stringify({
        nodeId: input.nodeId,
        nodeKind: input.nodeKind,
        registrationToken: input.registrationToken,
        deviceId: input.deviceId,
        sourceIp: input.sourceIp
      })
    });
    const payload = (await res.body.json()) as {
      allowed?: boolean;
      reason?: string;
      node?: {
        ownerUserId?: string;
        ownerEmail?: string;
        sourceIp?: string;
        countryCode?: string;
        vpnDetected?: boolean;
      };
    };
    if (res.statusCode < 200 || res.statusCode >= 300) {
      await appendValidationEvent({
        allowed: false,
        reason: payload.reason ?? `portal_validation_failed_${res.statusCode}`
      });
      return {
        allowed: false,
        reason: payload.reason ?? `portal_validation_failed_${res.statusCode}`
      };
    }
    await appendValidationEvent({
      allowed: payload.allowed === true,
      reason: payload.reason,
      ownerEmail: payload.node?.ownerEmail
    });
    if (payload.allowed === true && input.nodeKind === "agent" && payload.node?.ownerUserId) {
      await linkPortalOwnership(input.nodeId, payload.node.ownerUserId);
    }
    return {
      allowed: payload.allowed === true,
      reason: payload.reason,
      ownerEmail: payload.node?.ownerEmail,
      sourceIp: payload.node?.sourceIp,
      countryCode: payload.node?.countryCode,
      vpnDetected: payload.node?.vpnDetected
    };
  } catch {
    // If portal validation is temporarily unavailable, allow agents we already know that prove
    // their registered key. This avoids flapping registrations for long-running approved nodes.
    const cached = allowIfKnownAgent("portal_validation_unreachable_proven_key");
    if (cached) {
      await appendValidationEvent(cached);
      return cached;
    }
    const outcome = { allowed: false, reason: "portal_validation_unreachable" };
    await appendValidationEvent(outcome);
    return outcome;
  }
}
