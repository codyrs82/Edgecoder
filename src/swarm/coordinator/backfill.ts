// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Reservation backfill on the coordinator (docs/reservation-backfill.md; the rules are pure in
 * src/economy/reservation-backfill.ts).
 *
 * - Claim: dispatch.ts claimRule asks backfillOpen() once per pull for a reserved agent, then
 *   backfillCallOk() per network subtask. The lease's own jobs are always taken first: while one is
 *   queued or running no backfill starts, and backfill never holds more than its slot cap.
 * - Billing: /pull records each backfill claim (noteBackfillClaim); accrueResultCredits asks
 *   backfillAccrualFor() and splits the host-side earnings with the holder (accruePricedJob).
 * - Preemption: a backfill call running past its cap while a lease job waits is handed to another
 *   agent if its requester has seen nothing yet (nothing is charged for the cut run); otherwise it
 *   finishes.
 * - Visibility: backfillStats() for the lease API (jobs and earnings from the ledger, the holder's
 *   measured extra wait from this coordinator's memory).
 */

import type { Subtask } from "../../common/types.js";
import { backfillConfigFromEnv, backfillGate, backfillCallEligible, backfillHolderReason, overrunBackfill, type BackfillConfig, type LeaseActivity } from "../../economy/reservation-backfill.js";
import type { Reservation } from "../../economy/reservations.js";
import { creditEngine } from "../../credits/store.js";
import { pgStore } from "../../db/store.js";
import { describeJob } from "../../inference-api/job-descriptor.js";
import { contextNeeded } from "../../inference-api/ollama.js";
import type { ChatMessage } from "../../inference-api/types.js";
import { decodeTps, prefillTps } from "./best-fit.js";
import { queue, reservations, taskBilling } from "./context.js";
import { effectiveHardware, hardwareVerifier } from "./economy.js";

export const backfillConfig: BackfillConfig = backfillConfigFromEnv();

interface BackfillClaim {
  reservationId: string;
  holderAccountId: string;
  agentId: string;
  claimedAtMs: number;
}

/** subtaskId -> the lease whose idle agent took it as backfill. */
const backfillClaims = new Map<string, BackfillClaim>();
/** reservationId -> when its agent last held a backfill call. */
const lastBackfillMs = new Map<string, number>();
/** reservationId -> wait (ms) of lease jobs that arrived while backfill ran on the agent. */
const holderWaits = new Map<string, number[]>();
/** reservationId -> backfill calls handed elsewhere for a waiting lease job. */
const preempted = new Map<string, number>();
const KEEP_MS = 2 * 24 * 3_600_000;
const WAIT_SAMPLES = 200;

/** The lease's state on its agent now (one queue pass). */
export function leaseActivity(lease: Reservation, healthy: boolean, slots: number, nowMs = Date.now()): LeaseActivity & { backfill: Array<{ subtask: Subtask; claimedAtMs: number }> } {
  const v = queue.leaseView(lease.agentId, lease.id);
  if (v.others.length) lastBackfillMs.set(lease.id, nowMs);
  return { optedIn: lease.backfill === true, healthy, leaseQueued: v.leaseQueued, leaseRunning: v.leaseRunning, backfillRunning: v.others.length, slots, backfill: v.others };
}

/** May the lease's agent start a backfill call now? */
export function backfillOpen(lease: Reservation, healthy: boolean, slots: number, nowMs = Date.now()): boolean {
  if (!backfillConfig.enabled || lease.backfill !== true) return false;
  return backfillGate(leaseActivity(lease, healthy, slots, nowMs), backfillConfig).open;
}

/** Size estimate of a model call (parsed once per subtask). */
const sizes = new Map<string, { tokensNeeded: number; promptTokens: number; expectedOutputTokens: number }>();
function sizeOf(subtask: Subtask): { tokensNeeded: number; promptTokens: number; expectedOutputTokens: number } {
  let s = sizes.get(subtask.id);
  if (!s) {
    try {
      const input = JSON.parse(subtask.input) as { messages?: ChatMessage[]; tools?: unknown[]; maxTokens?: number };
      if (!Array.isArray(input.messages)) throw new Error("no messages");
      const d = describeJob({ messages: input.messages, tools: input.tools, maxTokens: input.maxTokens });
      s = { tokensNeeded: contextNeeded(input.messages, input.tools, input.maxTokens), promptTokens: d.promptTokens, expectedOutputTokens: d.expectedOutputTokens };
    } catch {
      s = { tokensNeeded: Infinity, promptTokens: Infinity, expectedOutputTokens: Infinity };
    }
    sizes.set(subtask.id, s);
  }
  return s;
}

/** Expected run time (s) of a call on this agent: prefill of the prompt plus decode of the expected reply. */
export function expectedSecondsOn(agentId: string, capability: { activeModel?: string; computeClass?: string } | undefined, subtask: Subtask): number {
  const model = subtask.requestedModel ?? "";
  const size = sizeOf(subtask);
  const view = {
    computeClass: effectiveHardware(agentId)?.computeClass ?? capability?.computeClass ?? "cpu",
    tokensPerSec: hardwareVerifier.get(agentId)?.evidence.tokensPerSec,
    activeModel: capability?.activeModel ?? null,
  };
  return size.promptTokens / prefillTps(view, model) + size.expectedOutputTokens / decodeTps(view, model);
}

/** Is this network subtask small and plain enough for the reserved agent to take as backfill? */
export function backfillCallOk(
  agentId: string,
  capability: { activeModel?: string; computeClass?: string } | undefined,
  lease: Reservation,
  subtask: Subtask,
  ctx: { restricted: boolean; loadedModels: string[] | undefined }
): boolean {
  const model = subtask.requestedModel;
  // The model must already be in memory (or be the one the agent runs / the lease is for): a load
  // would evict the holder's model and their next job would wait for it.
  const modelLoaded = !!model && (ctx.loadedModels ? ctx.loadedModels.includes(model) : model === capability?.activeModel || model === lease.model);
  const meta = subtask.projectMeta;
  const size = subtask.kind === "inference" ? sizeOf(subtask) : undefined;
  return backfillCallEligible(
    {
      kind: subtask.kind,
      reservationId: meta.reservationId,
      onlyAccountId: meta.onlyAccountId,
      restricted: ctx.restricted,
      nwc: taskBilling.get(subtask.taskId)?.nwc === true,
      modelLoaded,
      tokensNeeded: size?.tokensNeeded ?? Infinity,
      expectedSeconds: size ? expectedSecondsOn(agentId, capability, subtask) : Infinity,
    },
    backfillConfig
  ).ok;
}

/** /pull handed a network subtask to a reserved agent: it runs as that lease's backfill. */
export function noteBackfillClaim(subtask: Subtask, lease: Reservation, agentId: string, nowMs = Date.now()): void {
  backfillClaims.set(subtask.id, { reservationId: lease.id, holderAccountId: lease.accountId, agentId, claimedAtMs: nowMs });
  lastBackfillMs.set(lease.id, nowMs);
}

/**
 * /pull handed a lease job out. When it became claimable while backfill ran on the agent (or in the
 * moment before), its wait is the holder's extra wait for backfill (an upper bound: it includes the
 * normal pickup time).
 */
export function noteLeaseJobClaim(lease: Reservation, readyAtMs: number | undefined, nowMs = Date.now()): void {
  if (readyAtMs === undefined) return;
  const last = lastBackfillMs.get(lease.id);
  if (last === undefined || last < readyAtMs - 1_000) return;
  const list = holderWaits.get(lease.id) ?? [];
  list.push(Math.max(0, nowMs - readyAtMs));
  if (list.length > WAIT_SAMPLES) list.splice(0, list.length - WAIT_SAMPLES);
  holderWaits.set(lease.id, list);
}

/**
 * The lease (and its holder) a settled network call ran as backfill for; undefined when it was not
 * backfill. Recorded at claim; after a coordinator restart, a call the agent ran wholly inside an
 * opted-in lease that is still active counts as that lease's backfill (a reserved agent takes no
 * other network work).
 */
export function backfillAccrualFor(subtask: Pick<Subtask, "id" | "projectMeta">, agentId: string, durationMs: number, nowMs = Date.now()): { reservationId: string; holderAccountId: string } | undefined {
  if (subtask.projectMeta.reservationId || subtask.projectMeta.onlyAccountId) return undefined;
  const c = backfillClaims.get(subtask.id);
  if (c) return c.agentId === agentId ? { reservationId: c.reservationId, holderAccountId: c.holderAccountId } : undefined;
  const lease = reservations.activeForAgent(agentId, nowMs);
  if (!lease || lease.backfill !== true || nowMs - Math.max(0, durationMs) < lease.startMs) return undefined;
  return { reservationId: lease.id, holderAccountId: lease.accountId };
}

/** The call settled (paid or not): forget its claim record. */
export function forgetBackfillClaim(subtaskId: string): void {
  backfillClaims.delete(subtaskId);
  sizes.delete(subtaskId);
}

type Retry = (subtask: Subtask, agentId: string, error: string | undefined, nowMs?: number) => Promise<boolean>;
let retry: Retry | undefined;
/** routes/inference.ts registers how a call is handed to another agent (retryInferenceElsewhere). */
export function setBackfillRetry(fn: Retry | undefined): void {
  retry = fn;
}

export const BACKFILL_PREEMPTED_ERROR = "reservation_backfill_preempted";

/**
 * Backfill calls running past the cap while a lease job waits: each is handed to another agent
 * when its requester has seen nothing yet (retryInferenceElsewhere: the reserved agent may not take
 * it back, its late result is refused, nothing is charged for the cut run). A call that already
 * streamed part of its reply finishes. Returns the subtask ids handed elsewhere.
 */
export async function preemptOverrunBackfill(nowMs = Date.now()): Promise<string[]> {
  if (!retry || !backfillConfig.enabled) return [];
  const out: string[] = [];
  for (const lease of activeBackfillLeases(nowMs)) {
    const v = queue.leaseView(lease.agentId, lease.id);
    if (v.others.length) lastBackfillMs.set(lease.id, nowMs);
    for (const o of overrunBackfill(v.others, v.leaseQueued, nowMs, backfillConfig)) {
      if (o.subtask.kind !== "inference") continue;
      if (await retry(o.subtask, lease.agentId, BACKFILL_PREEMPTED_ERROR, nowMs)) {
        backfillClaims.delete(o.subtask.id);
        preempted.set(lease.id, (preempted.get(lease.id) ?? 0) + 1);
        out.push(o.subtask.id);
      }
    }
  }
  return out;
}

function activeBackfillLeases(nowMs: number): Reservation[] {
  const out: Reservation[] = [];
  const seen = new Set<string>();
  for (const [, c] of backfillClaims) seen.add(c.reservationId);
  for (const id of seen) {
    const r = reservations.get(id);
    if (r && r.status === "active" && nowMs < r.endMs && r.backfill === true) out.push(r);
  }
  return out;
}

setInterval(() => {
  void preemptOverrunBackfill().catch(() => undefined);
}, 2_000).unref?.();

setInterval(() => {
  const now = Date.now();
  for (const [id, c] of backfillClaims) if (now - c.claimedAtMs > KEEP_MS) backfillClaims.delete(id);
  for (const id of sizes.keys()) if (!queue.getSubtask(id)) sizes.delete(id);
  for (const [id, at] of lastBackfillMs) {
    if (now - at <= KEEP_MS) continue;
    lastBackfillMs.delete(id);
    holderWaits.delete(id);
    preempted.delete(id);
  }
}, 60_000).unref?.();

export interface BackfillStats {
  enabled: boolean;
  jobs: number;
  /** What was credited to the holder for backfill on this lease (msat). */
  holderMsat: number;
  holderShare: number;
  /** Lease jobs that arrived while backfill ran, and their wait (ms; this coordinator's memory). */
  holderWait: { samples: number; p50Ms: number; maxMs: number };
  preempted: number;
}

/** Backfill on one lease: jobs and the holder's credits from the ledger, waits from memory. */
export async function backfillStats(r: Reservation): Promise<BackfillStats> {
  const reason = backfillHolderReason(r.id);
  let jobs = 0;
  let holderMsat = 0;
  if (pgStore) {
    const inc = await pgStore.earnIncome(r.accountId, reason, Date.now());
    jobs = inc.count;
    holderMsat = inc.totalMsat;
  } else {
    for (const t of creditEngine.history(r.accountId)) {
      if (t.type !== "earn" || t.reason !== reason) continue;
      jobs++;
      holderMsat += t.msat ?? 0;
    }
  }
  const waits = [...(holderWaits.get(r.id) ?? [])].sort((a, b) => a - b);
  return {
    enabled: r.backfill === true && backfillConfig.enabled,
    jobs,
    holderMsat,
    holderShare: backfillConfig.holderShareBps / 10_000,
    holderWait: { samples: waits.length, p50Ms: waits.length ? waits[Math.floor(waits.length / 2)] : 0, maxMs: waits.length ? waits[waits.length - 1] : 0 },
    preempted: preempted.get(r.id) ?? 0,
  };
}

/** Test hook: reset this coordinator's backfill memory. */
export function resetBackfillState(): void {
  backfillClaims.clear();
  lastBackfillMs.clear();
  holderWaits.clear();
  preempted.clear();
  sizes.clear();
}
