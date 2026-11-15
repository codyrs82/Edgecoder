// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Security research tier on the coordinator (docs/security-research-tier.md): which models are
 * restricted (RESTRICTED_MODELS_JSON), who may call and host them (entitlements read from the
 * portal), where a restricted call may run, the per-account rate limit, and the call log.
 *
 * Routing guarantee. A restricted call runs only on the requester's own machines or on the agent a
 * lease it holds, and only on an agent whose owner opted in (signed pull with
 * allowRestrictedModels, AGENT_ALLOW_RESTRICTED_MODELS=1) and holds a host entitlement. The claim
 * gate (restrictedClaimAllowed, called from dispatch.ts claimRule) checks this against the
 * call as it was admitted at submit on this coordinator: a subtask that names a restricted model
 * but was not admitted here (gossiped, replayed, restored after a restart, forged placement
 * fields) is never claimable. A code subtask that names no model runs on the agent's active
 * model, so an agent whose active model is restricted takes no such work either.
 */
import { request } from "undici";
import { z } from "zod";
import type { Subtask } from "../../common/types.js";
import type { Reservation } from "../../economy/reservations.js";
import { pgStore } from "../../db/store.js";
import {
  ENTITLEMENT_KINDS,
  EntitlementBook,
  RestrictedCallLog,
  RestrictedCatalog,
  RestrictedRateLimiter,
  hostKindFor,
  normalizeModelTag,
  type RestrictedCallRecord,
  type RestrictedTier
} from "../restricted-models.js";
import { app } from "./app.js";
import { CC, PORTAL_OUTBOUND_TOKEN, PORTAL_SERVICE_URL, identity, securityLog } from "./context.js";

export const restrictedCatalog = RestrictedCatalog.fromEnv(CC.RESTRICTED_MODELS_JSON);
export const restrictedEntitlements = new EntitlementBook(CC.RESTRICTED_ACCESS_MAX_STALE_MS);
export const restrictedRateLimiter = new RestrictedRateLimiter(CC.RESTRICTED_MODEL_RATE_LIMIT_PER_MIN);
/** RESTRICTED_MODEL_LOG_PROMPTS: keep prompts and outputs with the call log (default off). */
export const RESTRICTED_LOG_PROMPTS = CC.RESTRICTED_MODEL_LOG_PROMPTS;

const callStore = pgStore?.restrictedCallStore();

export const restrictedCalls = new RestrictedCallLog((e) => {
  const r = e.record;
  securityLog.log({
    level: securityLog.severity("restricted_model_call"),
    event: "restricted_model_call",
    source: { type: r.agentId ? "agent" : "coordinator", id: r.agentId ?? identity.peerId },
    details: {
      phase: e.type, subtaskId: r.subtaskId, taskId: r.taskId, accountId: r.accountId, model: r.model, tier: r.tier, placement: r.placement,
      reservationId: r.reservationId, agentId: r.agentId, hostAccountId: r.hostAccountId, submittedAtMs: r.submittedAtMs, claimedAtMs: r.claimedAtMs,
      endedAtMs: r.endedAtMs, outcome: r.outcome, promptTokens: r.promptTokens, outputTokens: r.outputTokens,
    },
    action: `restricted_call_${e.type}`,
    coordinatorId: identity.peerId,
  });
  void callStore?.upsert(r).catch((err) => app.log.error({ err, subtaskId: r.subtaskId }, "restricted_call_log_persist_failed"));
});

// ── Agent opt-in (host side) ──

/** A signed pull says the agent opted in; it lapses when the agent stops saying so. */
const OPT_IN_FRESH_MS = 5 * 60_000;
const optIns = new Map<string, { accountId: string; atMs: number }>();

/** /pull: record whether this agent opted in (only a signed pull counts). */
export function noteRestrictedOptIn(agentId: string, signed: boolean, optIn: boolean | undefined, ownerAccountId: string, nowMs = Date.now()): void {
  if (signed && optIn === true) optIns.set(agentId, { accountId: ownerAccountId, atMs: nowMs });
  else optIns.delete(agentId);
}

/** The agent opted in and its owner holds the host entitlement for `tier`. */
export function agentMayHostTier(agentId: string, tier: RestrictedTier, ownerAccountId: string | undefined, nowMs = Date.now()): boolean {
  const o = optIns.get(agentId);
  if (!o || nowMs - o.atMs > OPT_IN_FRESH_MS) return false;
  if (ownerAccountId !== undefined && ownerAccountId !== o.accountId) return false;
  return restrictedEntitlements.valid(o.accountId, hostKindFor(tier), nowMs);
}

// ── Listing, submit and claim ──

/** The model a subtask runs on this agent: the named one, or (code work) the agent's active model. */
export function subtaskRestrictedTier(subtask: Pick<Subtask, "kind" | "requestedModel">, capability: { activeModel?: string } | undefined): RestrictedTier | undefined {
  if (restrictedCatalog.size === 0) return undefined;
  const model = subtask.requestedModel ?? (subtask.kind !== "inference" ? capability?.activeModel : undefined);
  return restrictedCatalog.tierOf(model);
}

/** Whether `accountId` may see and call models of `tier` now. */
export function accountHoldsTier(accountId: string | undefined, tier: RestrictedTier, nowMs = Date.now()): boolean {
  return restrictedEntitlements.valid(accountId, tier, nowMs);
}

export type RestrictedGate = { ok: true; tier?: RestrictedTier } | { ok: false; status: number; body: Record<string, unknown> };

function refused(accountId: string, model: string, reason: string, status: number, body: Record<string, unknown>): RestrictedGate {
  securityLog.log({
    level: securityLog.severity("restricted_model_refused"),
    event: "restricted_model_refused",
    source: { type: "coordinator", id: identity.peerId },
    details: { accountId, model, reason },
    action: "refused",
    coordinatorId: identity.peerId,
  });
  return { ok: false, status, body };
}

/**
 * /inference/submit and /submit: may this account call `model` with this placement? An open model
 * passes untouched. A restricted one needs a valid entitlement (403 restricted_model), a placement
 * of the requester's own machines or a lease (403 restricted_model, reserved_placement_required),
 * and room under the per-account rate limit (429).
 */
export async function restrictedSubmitGate(accountId: string, model: string, placement: { target?: "network" | "mine"; reservationId?: string; codeTask?: boolean }, nowMs = Date.now()): Promise<RestrictedGate> {
  const tier = restrictedCatalog.tierOf(model);
  if (!tier) return { ok: true };
  if (!accountHoldsTier(accountId, tier, nowMs)) {
    // Granted a moment ago: read the portal's list once before refusing.
    await refreshRestrictedEntitlements({ minAgeMs: 5_000 }).catch(() => undefined);
    if (!accountHoldsTier(accountId, tier)) {
      return refused(accountId, model, "no_entitlement", 403, { error: "restricted_model", tier, message: "This model is restricted to accounts with security research access." });
    }
  }
  if (placement.codeTask || (!placement.reservationId && placement.target !== "mine")) {
    return refused(accountId, model, "placement", 403, {
      error: "restricted_model", tier, reason: "reserved_placement_required",
      message: "A restricted model runs only on your own machines (target mine) or a machine you reserved; it never runs on the open network.",
    });
  }
  if (!restrictedRateLimiter.take(accountId, nowMs)) {
    return refused(accountId, model, "rate_limited", 429, { error: "restricted_model_rate_limited", limitPerMinute: CC.RESTRICTED_MODEL_RATE_LIMIT_PER_MIN });
  }
  return { ok: true, tier };
}

/**
 * The claim gate for restricted work (dispatch.ts claimRule calls it first). `pullerAccount`
 * undefined (nudge targeting) uses the account the agent last pulled as.
 */
export function restrictedClaimAllowed(
  agentId: string,
  capability: { activeModel?: string } | undefined,
  pullerAccount: string | undefined,
  lease: Reservation | undefined,
  subtask: Subtask,
  nowMs = Date.now()
): boolean {
  const tier = subtaskRestrictedTier(subtask, capability);
  if (!tier) return true;
  // Only a call admitted by restrictedSubmitGate on this coordinator, for the model it names.
  const call = restrictedCalls.get(subtask.id);
  if (!call || call.tier !== tier || !subtask.requestedModel || normalizeModelTag(call.model) !== normalizeModelTag(subtask.requestedModel)) return false;
  if (!accountHoldsTier(call.accountId, tier, nowMs)) return false;
  const hostAccount = pullerAccount ?? optIns.get(agentId)?.accountId;
  if (!hostAccount || !agentMayHostTier(agentId, tier, hostAccount, nowMs)) return false;
  const meta = subtask.projectMeta;
  if (call.placement === "mine") return !lease && !meta.reservationId && meta.onlyAccountId === call.accountId && hostAccount === call.accountId;
  return !!lease && lease.id === call.reservationId && meta.reservationId === lease.id && lease.accountId === call.accountId && lease.status === "active" && nowMs < lease.endMs;
}

/** Record a restricted call admitted at submit (the claim gate reads it). */
export function admitRestrictedCall(r: Omit<RestrictedCallRecord, "submittedAtMs"> & { submittedAtMs?: number }): void {
  restrictedCalls.submitted({ ...r, submittedAtMs: r.submittedAtMs ?? Date.now() });
}

// ── Suspension: in-flight calls are cancelled ──

type Canceller = (call: RestrictedCallRecord, reason: string) => Promise<void> | void;
let canceller: Canceller | undefined;

/** routes/inference.ts registers how a call is cancelled (stream closed, queue settled, refund). */
export function setRestrictedCanceller(fn: Canceller): void {
  canceller = fn;
}

/** Cancel every call in flight whose requester or host no longer holds its entitlement. */
export async function enforceRestrictedAccess(nowMs = Date.now()): Promise<number> {
  const victims = restrictedCalls.activeWhere(
    (r) => !accountHoldsTier(r.accountId, r.tier, nowMs) || (r.agentId !== undefined && !restrictedEntitlements.valid(r.hostAccountId, hostKindFor(r.tier), nowMs))
  );
  for (const v of victims) {
    securityLog.log({
      level: securityLog.severity("restricted_access_suspended"),
      event: "restricted_access_suspended",
      source: { type: "coordinator", id: identity.peerId },
      details: { subtaskId: v.subtaskId, taskId: v.taskId, accountId: v.accountId, agentId: v.agentId, hostAccountId: v.hostAccountId, model: v.model },
      action: "in_flight_call_cancelled",
      coordinatorId: identity.peerId,
    });
    try {
      await canceller?.(v, "restricted_access_suspended");
    } catch (err) {
      app.log.error({ err, subtaskId: v.subtaskId }, "restricted_call_cancel_failed");
    }
    // Ended here too, so a canceller that could not reach the call still takes it out of the gate.
    restrictedCalls.ended(v.subtaskId, "cancelled_suspended");
  }
  return victims.length;
}

/** One entitlement change pushed by the portal (or an operator); applied and enforced at once. */
export async function applyEntitlementChange(change: z.infer<typeof entitlementSchema>, nowMs = Date.now()): Promise<number> {
  restrictedEntitlements.apply(change, nowMs);
  return enforceRestrictedAccess(nowMs);
}

// ── Sync from the portal ──

export const entitlementSchema = z.object({
  accountId: z.string().min(1).max(200),
  kind: z.enum(ENTITLEMENT_KINDS),
  expiresAtMs: z.number().int().nullable(),
  active: z.boolean(),
});

let syncing: Promise<boolean> | undefined;

/**
 * Read every active entitlement from the portal (GET /internal/security-research/entitlements,
 * service token) and replace the local copy. `minAgeMs`: skip when the last sync is newer.
 * Returns true when the list was replaced.
 */
export function refreshRestrictedEntitlements(opts: { minAgeMs?: number } = {}): Promise<boolean> {
  if (!PORTAL_SERVICE_URL) return Promise.resolve(false);
  if (opts.minAgeMs !== undefined && Date.now() - restrictedEntitlements.lastSyncMs < opts.minAgeMs) return Promise.resolve(false);
  syncing ??= (async () => {
    const headers: Record<string, string> = {};
    if (PORTAL_OUTBOUND_TOKEN) headers["x-portal-service-token"] = PORTAL_OUTBOUND_TOKEN;
    const res = await request(`${PORTAL_SERVICE_URL.replace(/\/+$/, "")}/internal/security-research/entitlements`, {
      method: "GET", headers, headersTimeout: 5_000, bodyTimeout: 5_000,
    });
    const json = (await res.body.json().catch(() => null)) as { entitlements?: unknown } | null;
    if (res.statusCode !== 200 || !json || !Array.isArray(json.entitlements)) return false;
    const list = json.entitlements.map((e) => entitlementSchema.safeParse(e)).filter((p) => p.success).map((p) => p.data!);
    restrictedEntitlements.replaceAll(list);
    return true;
  })()
    .catch((err) => {
      app.log.warn({ err: String(err) }, "restricted_entitlement_sync_failed");
      return false;
    })
    .finally(() => {
      syncing = undefined;
    });
  return syncing;
}

/** Longer than any inference call may run (INFERENCE_MAX_TIMEOUT_MS, 5 min) plus its claim bound. */
const STALE_CALL_MS = 15 * 60_000;

// Only a coordinator with restricted models listed reads entitlements; the default (empty list) does nothing.
if (restrictedCatalog.size > 0) {
  const tick = () => {
    restrictedRateLimiter.prune();
    // A call that never reported its end (agent vanished, no final chunk) leaves the gate after the longest call time.
    const now = Date.now();
    for (const r of restrictedCalls.activeWhere((c) => now - c.submittedAtMs > STALE_CALL_MS)) restrictedCalls.ended(r.subtaskId, "failed");
    void refreshRestrictedEntitlements()
      .then(() => enforceRestrictedAccess())
      .catch(() => undefined);
  };
  setTimeout(tick, 0).unref?.();
  setInterval(tick, CC.RESTRICTED_ACCESS_SYNC_MS).unref?.();
}
