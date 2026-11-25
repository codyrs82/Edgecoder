// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * #523: an Auto call that nobody picks up is re-placed on the next candidate instead of waiting out
 * the 45 s claim bound and failing.
 *
 * Best fit (routing.ts resolveAuto) chooses a model, a class and a preferred agent; the call then
 * asks for that model. When the only agent holding it never pulls (it heartbeats but takes no work),
 * the call used to sit until the no-capacity bound refunded it, although other models were free.
 *
 * Now, when the call is still unclaimed after bestFitConfig.replaceMs (BEST_FIT_REPLACE_MS, 12 s):
 *
 * - The agent it was placed on counts a failure on its circuit breaker and its routing fail rate
 *   when it holds nothing (an idle agent that does not come is failing; a busy one is just busy),
 *   unless its circuit was open during the wait (B4: the breaker kept it from pulling; that wait
 *   is not a new failure) or it is otherwise unavailable (memory pressure, socket lost).
 * - When an agent's circuit trips, its waiting Auto calls are re-placed at once (replaceAutoNow),
 *   not after the 12 s.
 * - Best fit runs again without the agents already tried (this coordinator's agents only: the
 *   requester is already waiting on this coordinator's stream). Cloud models are in it whenever
 *   policy allows (AUTO_CLOUD_MODELS and cloudConsidered), as for any Auto call.
 * - The first candidate whose estimated cost fits the reserve already set aside is taken: the call is
 *   changed in place (queue.reassignUnclaimed: its model, class and market bid), so there is still
 *   one reserve, settled once by whoever runs it, or refunded in full by the claim bound when nobody
 *   does. The call's cost is capped at that reserve as for every call.
 * - If best fit names the same model and class again (another holder), the call stays as it is and
 *   that agent is preferred.
 * - At most AUTO_REPLACE_MAX times per call; the original claim bound still ends it.
 */

import type { JobDescriptor } from "../../inference-api/job-descriptor.js";
import { ACCEPTED_COMPUTE_CLASS_IDS, resolveRequestedClass, type ComputeClassId } from "../../economy/compute-classes.js";
import { msatToCSats } from "../../economy/job-pricing.js";
import type { Candidate } from "./best-fit.js";
import { app } from "./app.js";
import { queue, taskBilling, usagePending } from "./context.js";
import { preferAgent } from "./dispatch.js";
import { MARKET_DEFAULT_BID_PREMIUM_BPS, orderBook, rateOracleConfig } from "./economy.js";
import { agentUnavailable, circuitOpenSince, noteAgentOutcome as noteCircuitOutcome } from "./memory-admission.js";
import { bestFitConfig, noteAgentOutcome as noteRoutingOutcome, noteReplaced, resolveAuto } from "./routing.js";

/** Re-placements per call. */
export const AUTO_REPLACE_MAX = 2;

export interface AutoPlacement {
  taskId: string;
  subtaskId: string;
  job: JobDescriptor;
  accountId: string;
  /** A class the client named (best fit stays within it). */
  onlyClass?: string;
  /** The client's own bid ceiling, if it sent one. */
  maxBidMsatPerCredit?: number;
  clientRegion?: string | null;
  /** Agents the call was placed on so far, newest last. */
  tried: string[];
  replaced?: number;
  /** When it was (re)placed on its current agent. */
  placedAtMs?: number;
}

export type ReplaceOutcome = "claimed" | "same" | "none" | "replaced";

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** The Auto calls with a re-placement armed, by subtask id (replaceAutoNow). */
const placements = new Map<string, AutoPlacement>();

/** Re-place the call if nobody picked it up within `ms` (bestFitConfig.replaceMs; 0: never). */
export function armAutoReplace(p: AutoPlacement, ms = bestFitConfig.replaceMs, nowMs = Date.now()): void {
  if (!(ms > 0) || (p.replaced ?? 0) >= AUTO_REPLACE_MAX) return;
  const old = timers.get(p.subtaskId);
  if (old) clearTimeout(old);
  p.placedAtMs = nowMs;
  placements.set(p.subtaskId, p);
  const t = setTimeout(() => {
    timers.delete(p.subtaskId);
    placements.delete(p.subtaskId);
    void replaceUnclaimedAuto(p)
      .then((r) => {
        if (r === "replaced" || r === "same") armAutoReplace(p, ms);
      })
      .catch((err) => app.log.error({ err, subtaskId: p.subtaskId }, "auto_replace_failed"));
  }, ms);
  t.unref?.();
  timers.set(p.subtaskId, t);
}

/** One re-placement step (exported for tests; armAutoReplace runs it on its timer). */
export async function replaceUnclaimedAuto(p: AutoPlacement, nowMs = Date.now()): Promise<ReplaceOutcome> {
  if (!queue.isUnclaimed(p.subtaskId)) return "claimed";
  const waitedOn = p.tried[p.tried.length - 1];
  // A pickup timeout: the agent the call was placed on did not come although it held nothing, and
  // nothing on this side kept it away (its open circuit, memory pressure, a lost socket).
  const since = p.placedAtMs ?? nowMs - bestFitConfig.replaceMs;
  if (waitedOn && (queue.activeClaims().get(waitedOn)?.all ?? 0) === 0 && !circuitOpenSince(waitedOn, since, nowMs) && !agentUnavailable(waitedOn, nowMs)) {
    noteCircuitOutcome(waitedOn, false, nowMs);
    noteRoutingOutcome(waitedOn, false);
  }
  const { result } = await resolveAuto(p.job, { peers: false, requesterAccountId: p.accountId, excludeAgents: p.tried, clientRegion: p.clientRegion ?? null, ...(p.onlyClass ? { computeClass: p.onlyClass } : {}) }, nowMs);
  const current = queue.getSubtask(p.subtaskId);
  if (!current || !queue.isUnclaimed(p.subtaskId)) return "claimed";
  const billing = taskBilling.get(p.taskId);
  const budgetCSats = billing && billing.reservedMsat > 0 ? msatToCSats(billing.reservedMsat) : Infinity;
  const seen = new Set<Candidate>();
  const pick = [result.chosen, ...result.candidates].find((c): c is Candidate => {
    if (!c || seen.has(c)) return false;
    seen.add(c);
    return c.local && c.estimate.cSats <= budgetCSats;
  });
  if (!pick) return "none";
  p.tried.push(pick.agentId);
  const preferMs = Math.max(bestFitConfig.preferMs, 1_000);
  const taskClass = (ACCEPTED_COMPUTE_CLASS_IDS.includes(pick.computeClass) ? pick.computeClass : "any") as ComputeClassId | "any";
  if (pick.model === current.requestedModel && taskClass === (current.projectMeta.computeClass ?? "any")) {
    preferAgent(p.subtaskId, pick.agentId, preferMs, nowMs);
    return "same";
  }
  const resolved = resolveRequestedClass(taskClass, p.maxBidMsatPerCredit, {}, rateOracleConfig.computeClasses);
  const cls = (resolved.computeClass ?? "any") as ComputeClassId | "any";
  const bid = orderBook.postBid(p.taskId, cls, resolved.msatPerCredit, MARKET_DEFAULT_BID_PREMIUM_BPS, nowMs, {});
  const moved = queue.reassignUnclaimed(p.subtaskId, {
    requestedModel: pick.model,
    projectMeta: { computeClass: cls, resourceClass: cls === "cpu" ? "cpu" : "gpu", maxBidMsatPerCredit: bid.maxMsatPerCredit },
  });
  if (!moved) return "claimed";
  const usage = usagePending.get(p.taskId);
  if (usage) {
    usage.model = pick.model;
    if (cls !== "any") usage.computeClass = cls;
    else delete usage.computeClass;
  }
  p.replaced = (p.replaced ?? 0) + 1;
  preferAgent(p.subtaskId, pick.agentId, preferMs, nowMs);
  const waitedS = Math.round(bestFitConfig.replaceMs / 1000);
  noteReplaced(p.subtaskId, pick, `re-placed: nobody picked it up within ${waitedS} s`);
  app.log.warn({ taskId: p.taskId, subtaskId: p.subtaskId, from: current.requestedModel, to: pick.model, computeClass: cls, agent: pick.agentLabel, replaced: p.replaced }, "auto_call_replaced");
  return "replaced";
}

/**
 * B4: re-place the waiting Auto calls placed on `agentId` now (its circuit just tripped), instead
 * of after the re-placement wait. Returns how many moved; the rest keep their timers.
 */
export async function replaceAutoNow(agentId: string, nowMs = Date.now()): Promise<number> {
  let moved = 0;
  for (const p of [...placements.values()]) {
    if (p.tried[p.tried.length - 1] !== agentId || (p.replaced ?? 0) >= AUTO_REPLACE_MAX) continue;
    const r = await replaceUnclaimedAuto(p, nowMs).catch((err) => {
      app.log.error({ err, subtaskId: p.subtaskId }, "auto_replace_failed");
      return "none" as const;
    });
    if (r === "claimed") {
      const t = timers.get(p.subtaskId);
      if (t) clearTimeout(t);
      timers.delete(p.subtaskId);
      placements.delete(p.subtaskId);
    } else if (r === "replaced" || r === "same") {
      moved++;
      armAutoReplace(p, bestFitConfig.replaceMs, nowMs);
    }
  }
  return moved;
}

/** Waiting Auto calls placed on `agentId` (tests, the trip handler). */
export function autoPlacedOn(agentId: string): string[] {
  return [...placements.values()].filter((p) => p.tried[p.tried.length - 1] === agentId).map((p) => p.subtaskId);
}

/** Tests. */
export function clearAutoReplaceTimers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  placements.clear();
}
