// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Portal enrollment check for agents and coordinators that register with this node.
 */
import { request } from "undici";
import { pgStore } from "../../db/store.js";
import { app } from "./app.js";
import { identity, COORDINATOR_REGISTRATION_TOKEN, PORTAL_SERVICE_URL, PORTAL_OUTBOUND_TOKEN } from "./context.js";
import { portalOutboundHeaders } from "./portal-credentials.js";
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

/**
 * Whether a portal-validated registration may (re)bind `requestedAgentId`. The portal can validate a
 * different node than the one named (its device-id fallback returns the device's canonical node),
 * and the coordinator links ownership to the agent id the caller named, so without this check a
 * user's own valid token could take over another user's agent id: its key, its in-flight claims and
 * every later accrual. Refused:
 *  - an agent already linked to another portal user (ownership never moves between users here);
 *  - a known agent bound through another node's token (the device fallback) without proof of the
 *    key this coordinator holds for it.
 */
export function portalBindDecision(input: {
  requestedAgentId: string;
  validatedNodeId?: string;
  validatedOwnerUserId?: string;
  existingOwnerUserId?: string;
  /** This coordinator already holds a key for the agent. */
  knownAgent: boolean;
  /** The request is signed by that stored key (registerProvesStoredKey). */
  proofOfKey: boolean;
}): { ok: true } | { ok: false; reason: string } {
  if (input.existingOwnerUserId && input.validatedOwnerUserId && input.existingOwnerUserId !== input.validatedOwnerUserId) {
    return { ok: false, reason: "agent_owned_by_another_account" };
  }
  // Another node's token speaks for a known agent only together with proof of its stored key.
  const otherNode = input.validatedNodeId !== undefined && input.validatedNodeId !== input.requestedAgentId;
  if (otherNode && input.knownAgent && !input.proofOfKey) return { ok: false, reason: "node_id_mismatch_for_known_agent" };
  return { ok: true };
}

/** The portal's tokenNode on a node_not_enrolled answer, when both fields are well formed. */
export function rejectedAttemptTokenNode(raw: unknown): { nodeId: string; ownerEmail: string } | undefined {
  const t = raw as { nodeId?: unknown; ownerEmail?: unknown } | null | undefined;
  if (!t || typeof t.nodeId !== "string" || typeof t.ownerEmail !== "string") return undefined;
  if (!/^[A-Za-z0-9._-]{3,128}$/.test(t.nodeId) || !/^[^\s@]+@[^\s@]+$/.test(t.ownerEmail)) return undefined;
  return { nodeId: t.nodeId, ownerEmail: t.ownerEmail };
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
  /** false: loopback, but not allowed to skip the portal (production without proof or opt-in). */
  selfRegistration?: boolean;
  /**
   * The request is signed by the public key this coordinator already holds for the agent, and does
   * not change that key. Only then may an agent re-register without a portal-validated token.
   */
  proofOfKey?: boolean;
}): Promise<{
  allowed: boolean;
  reason?: string;
  ownerEmail?: string;
  /** The owner's portal user id; portals give it even when they withhold the email (coordinator token). */
  ownerUserId?: string;
  sourceIp?: string;
  countryCode?: string;
  vpnDetected?: boolean;
  /** The portal's host approval for the node's owner; undefined when the portal did not say. */
  hostApproved?: boolean;
  /** node_not_enrolled: the node id the presented registration token was issued for. */
  tokenNodeId?: string;
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
  // input.loopback comes from the socket address with no proxy headers; a header cannot set it.
  // In production a loopback caller also needs the embedded worker's secret or the operator's
  // opt-in (input.selfRegistration, requestOrigin); otherwise it registers like any agent.
  if (input.loopback === true && input.selfRegistration !== false) {
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
  const headers = portalOutboundHeaders(identity.peerId, COORDINATOR_REGISTRATION_TOKEN, PORTAL_OUTBOUND_TOKEN);
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
      /** node_not_enrolled with a token that belongs to another enrolment (portal /internal/nodes/validate). */
      tokenNode?: { nodeId?: string; ownerEmail?: string };
      node?: {
        nodeId?: string;
        ownerUserId?: string;
        ownerEmail?: string;
        sourceIp?: string;
        countryCode?: string;
        vpnDetected?: boolean;
        hostApproved?: boolean;
      };
    };
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const reason = payload.reason ?? `portal_validation_failed_${res.statusCode}`;
      // The machine presented a token of another node id (it named itself differently from the
      // enrolment): the attempt is recorded under the token owner's email, so their Nodes page can
      // say "a machine named X tried to connect" (node_status_projection). Only a token's own
      // owner is ever named: the portal matched the token's hash.
      const tokenNode = reason === "node_not_enrolled" ? rejectedAttemptTokenNode(payload.tokenNode) : undefined;
      await appendValidationEvent({ allowed: false, reason, ...(tokenNode ? { ownerEmail: tokenNode.ownerEmail } : {}) });
      return { allowed: false, reason, ...(tokenNode ? { tokenNodeId: tokenNode.nodeId } : {}) };
    }
    await appendValidationEvent({
      allowed: payload.allowed === true,
      reason: payload.reason,
      ownerEmail: payload.node?.ownerEmail
    });
    if (payload.allowed === true && input.nodeKind === "agent") {
      let existingOwnerUserId: string | undefined;
      try {
        existingOwnerUserId = (await pgStore?.getAgentOwnership(input.nodeId))?.ownerUserId;
      } catch {
        existingOwnerUserId = undefined;
      }
      const bind = portalBindDecision({
        requestedAgentId: input.nodeId,
        validatedNodeId: payload.node?.nodeId,
        validatedOwnerUserId: payload.node?.ownerUserId,
        existingOwnerUserId,
        knownAgent: Boolean(agentCapabilities.get(input.nodeId)?.publicKeyPem),
        proofOfKey: input.proofOfKey === true
      });
      if (!bind.ok) {
        app.log.warn({ agentId: input.nodeId, validatedNodeId: payload.node?.nodeId, reason: bind.reason }, "agent_bind_refused");
        await appendValidationEvent({ allowed: false, reason: bind.reason });
        return { allowed: false, reason: bind.reason };
      }
      if (payload.node?.ownerUserId) await linkPortalOwnership(input.nodeId, payload.node.ownerUserId);
    }
    return {
      allowed: payload.allowed === true,
      reason: payload.reason,
      ownerEmail: payload.node?.ownerEmail,
      ownerUserId: payload.node?.ownerUserId,
      sourceIp: payload.node?.sourceIp,
      countryCode: payload.node?.countryCode,
      vpnDetected: payload.node?.vpnDetected,
      ...(typeof payload.node?.hostApproved === "boolean" ? { hostApproved: payload.node.hostApproved } : {})
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

/** How often agents the portal reported as not approved hosts are looked up again. */
export const HOST_APPROVAL_REFRESH_MS = 2 * 60_000;

/**
 * Host approval changes (an admin approves or revokes a host in Settings > Admin) reach agents
 * that are already registered: every agent whose owner was not an approved host is looked up
 * again, and so is every approved one, in batches through the portal's /internal/nodes/lookup.
 * Returns the agents whose approval changed. Best effort: a failed lookup changes nothing.
 */
export async function refreshHostApprovals(
  lookup: (nodeIds: string[]) => Promise<Array<{ nodeId: string; hostApproved?: boolean }>> = portalLookup
): Promise<string[]> {
  const ids = [...agentCapabilities.entries()].filter(([, cap]) => typeof cap.hostApproved === "boolean").map(([id]) => id);
  const changed: string[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    let nodes: Array<{ nodeId: string; hostApproved?: boolean }>;
    try {
      nodes = await lookup(ids.slice(i, i + 200));
    } catch (err) {
      app.log.warn({ err: err instanceof Error ? err.message : String(err) }, "host_approval_refresh_failed");
      return changed;
    }
    for (const n of nodes) {
      const cap = agentCapabilities.get(n.nodeId);
      if (!cap || typeof n.hostApproved !== "boolean" || cap.hostApproved === n.hostApproved) continue;
      cap.hostApproved = n.hostApproved;
      changed.push(n.nodeId);
    }
  }
  if (changed.length) app.log.info({ agents: changed.length }, "host_approval_changed");
  return changed;
}

async function portalLookup(nodeIds: string[]): Promise<Array<{ nodeId: string; hostApproved?: boolean }>> {
  if (!PORTAL_SERVICE_URL || nodeIds.length === 0) return [];
  const headers = portalOutboundHeaders(identity.peerId, COORDINATOR_REGISTRATION_TOKEN, PORTAL_OUTBOUND_TOKEN);
  const res = await request(`${PORTAL_SERVICE_URL}/internal/nodes/lookup`, {
    method: "POST",
    headers,
    headersTimeout: 5_000,
    bodyTimeout: 5_000,
    body: JSON.stringify({ nodeIds })
  });
  const payload = (await res.body.json()) as { nodes?: Array<{ nodeId: string; hostApproved?: boolean }> };
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`portal_lookup_failed_${res.statusCode}`);
  return payload.nodes ?? [];
}
