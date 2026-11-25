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
 *
 * Run 6 (inf-1795607918429-b8995549: a ~2.5k-token call not picked up on qwen3.5:9b within 12 s was
 * moved to a 1.5b CPU host and ran 193 s): a re-placement passes the same completion gate as a submit
 * (routes/inference.ts completionCheck), on the time the call has left. A candidate that would not
 * finish in that time is skipped; when none would, and the call's current placement would not either,
 * the call is ended now (no_capacity "busy", refunded in full) instead of waiting out its claim bound.
 *
 * Run 9 (three standard Auto calls refused 25-48 s after submit: placed on a host that did not take
 * them, re-placed after 12 s onto busy hosts, ended by the 45 s claim bound): with
 * INFERENCE_CLAIM_DECISION_MS (default 2 s) an Auto call is decided as a named call is, within
 * about 1.5 times that of its placement, a little more after a late re-placement (decideAuto):
 *
 * - at the decision time, still unclaimed: it waits once more (a quarter window) only while the host it
 *   was placed on could claim it now (dispatch.ts couldClaimNow: live, a free slot by count and by its
 *   report, not held back, the claim admission passes);
 * - otherwise it is re-placed on the next candidate whose host could claim it now (never onto a busy
 *   host: also for BEST_FIT_REPLACE_MS and the overrun re-placement), within its reserve and the
 *   completion gate;
 * - with no such candidate, or at its decision bound, it is refused now (no_capacity "busy", refunded
 *   in full: nothing was charged).
 *
 * INFERENCE_CLAIM_DECISION_MS=0 restores the fixed BEST_FIT_REPLACE_MS wait above.
 */

import type { JobDescriptor } from "../../inference-api/job-descriptor.js";
import { ACCEPTED_COMPUTE_CLASS_IDS, resolveRequestedClass, type ComputeClassId } from "../../economy/compute-classes.js";
import { msatToCSats } from "../../economy/job-pricing.js";
import type { Candidate } from "./best-fit.js";
import { app } from "./app.js";
import type { Subtask } from "../../common/types.js";
import { CC, queue, taskBilling, usagePending } from "./context.js";
import { couldClaimNow, preferAgent } from "./dispatch.js";
import { agentHeldBack } from "./start-eta.js";
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
  /** Run 9: by when it is claimed, or refused (decideAuto). */
  decideBy?: number;
  /** Run 9: it already waited once more on its current agent. */
  graced?: boolean;
}

/** Run 9: the Auto decision window (INFERENCE_CLAIM_DECISION_MS); 0: the fixed BEST_FIT_REPLACE_MS wait. */
export function autoDecisionMs(): number {
  return CC.INFERENCE_CLAIM_DECISION_MS;
}
/** Run 9: an Auto call is claimed or refused within this many decision windows of its placement. */
export const AUTO_DECISION_BOUND = 1.5;

export type ReplaceOutcome = "claimed" | "same" | "none" | "replaced" | "refused" | "waiting";

/**
 * Run 6: the completion gate for re-placements, registered by routes/inference.ts (which owns the
 * check and the refund): `fits`, the candidate would finish the call in the time it has left;
 * `currentFits`, its current placement still could; `refuse`, end the waiting call now (refunded).
 */
export interface ReplaceAdmission {
  fits(p: AutoPlacement, pick: Candidate, nowMs: number): boolean;
  currentFits(p: AutoPlacement, nowMs: number): boolean;
  refuse(p: AutoPlacement): Promise<boolean>;
}
let admission: ReplaceAdmission | undefined;
export function setReplaceAdmission(a: ReplaceAdmission | undefined): void {
  admission = a;
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** The Auto calls with a re-placement armed, by subtask id (replaceAutoNow). */
const placements = new Map<string, AutoPlacement>();

/**
 * Every Auto call's placement while it is on the queue, claimed or not (placements above holds only
 * the waiting ones with a timer): a call whose cloud host ran out of reasoning room is placed again
 * on another model (replaceAfterOverrun).
 */
const autoCalls = new Map<string, AutoPlacement>();
setInterval(() => {
  for (const id of autoCalls.keys()) if (!queue.getSubtask(id)) autoCalls.delete(id);
}, 60_000).unref?.();

/** The Auto placement of a call still on the queue (undefined: not an Auto call, or gone). */
export function autoPlacementOf(subtaskId: string): AutoPlacement | undefined {
  return autoCalls.get(subtaskId);
}

/**
 * Decide the call if nobody picked it up: run 9, within the decision window (autoDecisionMs,
 * decideAuto); with that off, re-place it after `ms` (bestFitConfig.replaceMs; 0: never).
 */
export function armAutoReplace(p: AutoPlacement, ms?: number, nowMs = Date.now()): void {
  autoCalls.set(p.subtaskId, p);
  const decision = autoDecisionMs();
  if (decision > 0) {
    if (p.decideBy === undefined) p.decideBy = nowMs + Math.round(decision * AUTO_DECISION_BOUND);
    if (p.placedAtMs === undefined) p.placedAtMs = nowMs;
    const wait = Math.max(0, Math.min(ms ?? decision, p.decideBy - nowMs));
    schedule(p, wait, () => decideAuto(p));
    return;
  }
  ms ??= bestFitConfig.replaceMs;
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

function schedule(p: AutoPlacement, ms: number, run: () => Promise<ReplaceOutcome>): void {
  const old = timers.get(p.subtaskId);
  if (old) clearTimeout(old);
  placements.set(p.subtaskId, p);
  const t = setTimeout(() => {
    timers.delete(p.subtaskId);
    placements.delete(p.subtaskId);
    void run().catch((err) => app.log.error({ err, subtaskId: p.subtaskId }, "auto_replace_failed"));
  }, ms);
  t.unref?.();
  timers.set(p.subtaskId, t);
}

/** The call as it would be on `pick` (its model and class), to ask whether pick's host could claim it. */
function asPlacedOn(st: Subtask, pick: Candidate): Subtask {
  const cls = ACCEPTED_COMPUTE_CLASS_IDS.includes(pick.computeClass) ? pick.computeClass : "any";
  return { ...st, requestedModel: pick.model, projectMeta: { ...st.projectMeta, computeClass: cls as ComputeClassId } };
}

/** Run 9: `agentId` could claim the call now (dispatch.ts couldClaimNow) and is not held back. */
function hostCanStart(agentId: string, st: Subtask, nowMs: number): boolean {
  return couldClaimNow(agentId, st, nowMs) && !agentHeldBack(agentId, queue.activeClaims().get(agentId)?.inference ?? 0, nowMs);
}

/** The host it waited on could have taken it, held nothing, and did not come: a pickup failure (circuit, routing). */
function notePickupFailure(p: AutoPlacement, nowMs: number): void {
  const waitedOn = p.tried[p.tried.length - 1];
  const since = p.placedAtMs ?? nowMs - bestFitConfig.replaceMs;
  if (waitedOn && (queue.activeClaims().get(waitedOn)?.all ?? 0) === 0 && !circuitOpenSince(waitedOn, since, nowMs) && !agentUnavailable(waitedOn, nowMs)) {
    noteCircuitOutcome(waitedOn, false, nowMs);
    noteRoutingOutcome(waitedOn, false);
  }
}

/**
 * Run 9: one decision on an unclaimed Auto call (armAutoReplace runs it at the decision time):
 * "waiting" (once, while its host could claim it now), "replaced" / "same" (onto a host that could),
 * or "refused" (nothing here can start it soon, or its decision bound is reached; refunded in full).
 */
export async function decideAuto(p: AutoPlacement, nowMs = Date.now()): Promise<ReplaceOutcome> {
  const st = queue.getSubtask(p.subtaskId);
  if (!st || !queue.isUnclaimed(p.subtaskId)) return "claimed";
  const decision = autoDecisionMs();
  const final = nowMs >= (p.decideBy ?? nowMs);
  const current = p.tried[p.tried.length - 1];
  const currentCan = !!current && hostCanStart(current, st, nowMs);
  const quarter = Math.max(1, Math.round(decision / 4));
  if (!final && currentCan && !p.graced) {
    p.graced = true;
    armAutoReplace(p, quarter, nowMs);
    return "waiting";
  }
  if (currentCan && p.graced) notePickupFailure(p, nowMs);
  const pick = !final && (p.replaced ?? 0) < AUTO_REPLACE_MAX ? await nextPick(p, nowMs) : undefined;
  const out = pick ? moveTo(p, pick, nowMs, `re-placed: nobody picked it up within ${Math.round(Math.max(0, nowMs - (p.placedAtMs ?? nowMs)) / 100) / 10} s`) : "none";
  if (out === "replaced" || out === "same") {
    p.graced = false;
    p.placedAtMs = nowMs;
    // The new host is nudged first (preferAgent) and gets at least a quarter window to pull.
    p.decideBy = Math.max(p.decideBy ?? nowMs, nowMs + quarter);
    armAutoReplace(p, quarter, nowMs);
    return out;
  }
  if (out === "claimed" || !queue.isUnclaimed(p.subtaskId)) return "claimed";
  if (admission && (await admission.refuse(p))) {
    app.log.warn({ taskId: p.taskId, subtaskId: p.subtaskId, tried: p.tried.length, final }, "auto_call_refused_no_host");
    return "refused";
  }
  return "none";
}

/** The first local candidate best fit gives for the call without the agents it tried, within its reserve. */
async function nextPick(p: AutoPlacement, nowMs: number): Promise<Candidate | undefined> {
  const { result } = await resolveAuto(p.job, { peers: false, requesterAccountId: p.accountId, excludeAgents: p.tried, clientRegion: p.clientRegion ?? null, ...(p.onlyClass ? { computeClass: p.onlyClass } : {}) }, nowMs);
  const billing = taskBilling.get(p.taskId);
  const budgetCSats = billing && billing.reservedMsat > 0 ? msatToCSats(billing.reservedMsat) : Infinity;
  const seen = new Set<Candidate>();
  const st = queue.getSubtask(p.subtaskId);
  return [result.chosen, ...result.candidates].find((c): c is Candidate => {
    if (!c || seen.has(c)) return false;
    seen.add(c);
    // Run 9: only onto a host that could claim it now (not a busy one).
    return c.local && c.estimate.cSats <= budgetCSats && (admission?.fits(p, c, nowMs) ?? true) && (!st || hostCanStart(c.agentId, asPlacedOn(st, c), nowMs));
  });
}

/**
 * #557 (run 5): a cloud host ran out of reasoning room on this Auto call (cloud_reasoning_overrun:
 * nothing was sent, nothing is charged). Another candidate without that host (best fit picks a
 * non-reasoning model elsewhere) exists within the call's reserve: true, and the caller releases the
 * call and runs placeAfterOverrun. False: nothing else could take it (the call ends now, uncharged).
 */
export async function overrunAlternativeExists(subtaskId: string, cloudAgentId: string, nowMs = Date.now()): Promise<boolean> {
  const p = autoCalls.get(subtaskId);
  if (!p) return false;
  return (await nextPick({ ...p, tried: [...new Set([...p.tried, cloudAgentId])] }, nowMs)) !== undefined;
}

/** After the release: move the (now unclaimed) call to the next candidate without `cloudAgentId`. */
export async function placeAfterOverrun(subtaskId: string, cloudAgentId: string, nowMs = Date.now()): Promise<ReplaceOutcome> {
  const p = autoCalls.get(subtaskId);
  if (!p) return "none";
  if (!p.tried.includes(cloudAgentId)) p.tried.push(cloudAgentId);
  return moveTo(p, await nextPick(p, nowMs), nowMs, "re-placed: the cloud host ran out of reasoning room");
}

/** One re-placement step (exported for tests; armAutoReplace runs it on its timer). */
export async function replaceUnclaimedAuto(p: AutoPlacement, nowMs = Date.now()): Promise<ReplaceOutcome> {
  if (!queue.isUnclaimed(p.subtaskId)) return "claimed";
  // A pickup timeout: the agent the call was placed on did not come although it held nothing, and
  // nothing on this side kept it away (its open circuit, memory pressure, a lost socket).
  notePickupFailure(p, nowMs);
  const pick = await nextPick(p, nowMs);
  // Run 6: nothing that would finish it in the time left, and its current placement would not either: end it now.
  if (!pick && admission && queue.isUnclaimed(p.subtaskId) && !admission.currentFits(p, nowMs)) {
    if (await admission.refuse(p)) {
      app.log.warn({ taskId: p.taskId, subtaskId: p.subtaskId, tried: p.tried.length }, "auto_call_refused_no_fit");
      return "refused";
    }
  }
  return moveTo(p, pick, nowMs, `re-placed: nobody picked it up within ${Math.round(bestFitConfig.replaceMs / 1000)} s`);
}

function moveTo(p: AutoPlacement, pick: Candidate | undefined, nowMs: number, why: string): ReplaceOutcome {
  const current = queue.getSubtask(p.subtaskId);
  if (!current || !queue.isUnclaimed(p.subtaskId)) return "claimed";
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
  noteReplaced(p.subtaskId, pick, why);
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
    if (r === "claimed" || r === "refused") {
      const t = timers.get(p.subtaskId);
      if (t) clearTimeout(t);
      timers.delete(p.subtaskId);
      placements.delete(p.subtaskId);
    } else if (r === "replaced" || r === "same") {
      moved++;
      p.graced = false;
      if (autoDecisionMs() > 0) p.decideBy = Math.max(p.decideBy ?? nowMs, nowMs + Math.round(autoDecisionMs() / 4));
      armAutoReplace(p, autoDecisionMs() > 0 ? Math.max(1, Math.round(autoDecisionMs() / 4)) : bestFitConfig.replaceMs, nowMs);
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
  autoCalls.clear();
}
