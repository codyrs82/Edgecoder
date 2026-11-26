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
 * INFERENCE_CLAIM_DECISION_MS (default 1.5 s since run 11) an Auto call is decided as a named call is, within
 * about 1.5 times that of its placement (run 12: within it, first at three quarters), a little more after a late re-placement (decideAuto):
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
 *
 * Run 11 (simple Auto bursts: 14 of 40 refused "every machine that runs qwen2.5-coder:1.5b is busy"
 * while the cloud host had 16/16 free). All 14 had been sent to the peer coordinator, which has no
 * cloud host (fixed in routing.ts peerAgentViews: a peer's free slot is spoken for by the calls sent
 * to it). Here too the overflow could be missed: best fit leaves the cloud out of a simple call while
 * a non-cloud machine in its band has a free slot by count (best-fit.ts cloudConsidered), and the
 * re-placement asked best fit with such machines still in its view (one excluded from the call, or
 * one not pulling), so every candidate failed "could claim it now" and the call was refused; and the
 * cloud was never tried at the decision bound or after the move limit. Now:
 *
 * - The re-placement leaves out the local hosts that could not claim the call now (nextPick): once
 *   no non-cloud host is ready, the cloud host is overflow as best fit means it, and the call moves
 *   there. Simple calls still stay off the cloud while a CPU/Mac host is ready (it is in the view).
 * - Onto the cloud only when the call's reserve covers the cloud's worst case (inferenceCallReserve
 *   for the cloud model); an Auto submit sets that much aside when a cloud host here could take its
 *   overflow (cloudOverflowReserveMsat; the unused part is refunded at settle as always).
 * - The cloud overflow is tried also at the decision bound and after AUTO_REPLACE_MAX moves (once):
 *   the call is refused only when the cloud cannot take it either.
 */

import type { JobDescriptor } from "../../inference-api/job-descriptor.js";
import { ACCEPTED_COMPUTE_CLASS_IDS, resolveRequestedClass, type ComputeClassId } from "../../economy/compute-classes.js";
import { msatToCSats } from "../../economy/job-pricing.js";
import { jobWantsPremiumCloud, type Candidate } from "./best-fit.js";
import { app } from "./app.js";
import type { Subtask } from "../../common/types.js";
import { CC, queue, taskBilling, usagePending } from "./context.js";
import { claimReadiness, couldClaimNow, preferAgent } from "./dispatch.js";
import { agentHeldBack } from "./start-eta.js";
import { inferenceCallReserve, MARKET_DEFAULT_BID_PREMIUM_BPS, orderBook, rateOracleConfig } from "./economy.js";
import { agentUnavailable, circuitOpenSince, noteAgentOutcome as noteCircuitOutcome } from "./memory-admission.js";
import { bestFitConfig, localAgentViews, noteAgentOutcome as noteRoutingOutcome, noteReplaced, resolveAuto } from "./routing.js";
import { classFamily } from "../../inference-api/auto-route.js";
import { cloudModelSpec } from "../../cloud-host/catalog.js";

const isPremiumCloudModel = (model: string) => cloudModelSpec(model)?.hint === "premium";

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
  /** Run 11: it was moved to the cloud host as overflow past its decision bound or its move limit (once). */
  overflowed?: boolean;
  /** Run 14: its decision bound from its (re)placement: a later move does not extend it (only the cloud overflow does). */
  boundAt?: number;
  /** Run 17: when this coordinator received the submit: the first window and the bound run from it. */
  receivedAtMs?: number;
}

/** Run 9: the Auto decision window (INFERENCE_CLAIM_DECISION_MS); 0: the fixed BEST_FIT_REPLACE_MS wait. */
export function autoDecisionMs(): number {
  return CC.INFERENCE_CLAIM_DECISION_MS;
}
/**
 * Run 12 (Auto refusals 2.3-2.6 s at the portal against a 2 s target, named ones ≤ 1.86 s): an Auto
 * call is first decided at AUTO_FIRST_DECISION of the window (1.125 s by default), so a host that
 * could claim it gets its quarter-window grace within the window, and a call nothing can take is
 * refused by then. Its bound is AUTO_DECISION_BOUND windows (a late move onto another host gets a
 * quarter window to pull; past the bound only the cloud overflow is tried).
 */
export const AUTO_FIRST_DECISION = 0.75;
/**
 * Run 9: an Auto call is claimed or refused within this many decision windows of its placement
 * (run 12: 1.25, was 1.5; run 14: 1.2, as named calls: a move onto another host late in the window
 * gets what is left of it, not a quarter window past it). Only the cloud overflow, tried last, may
 * run past it (its host claims at once).
 */
export const AUTO_DECISION_BOUND = 1.2;

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
    // Run 17: from the submit's receipt (what the submit took, e.g. the credit reserve under load, comes off the window).
    const startMs = p.decideBy === undefined ? Math.min(nowMs, p.receivedAtMs ?? nowMs) : nowMs;
    if (p.decideBy === undefined) p.decideBy = p.boundAt = startMs + Math.round(decision * AUTO_DECISION_BOUND);
    if (p.placedAtMs === undefined) p.placedAtMs = nowMs;
    const wait = Math.max(0, Math.min(ms ?? Math.round(decision * AUTO_FIRST_DECISION) - (nowMs - startMs), p.decideBy - nowMs));
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
function asPlacedOn(st: Subtask, pick: Pick<Candidate, "model" | "computeClass">): Subtask {
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
  const movesLeft = !final && (p.replaced ?? 0) < AUTO_REPLACE_MAX;
  // Run 11: past its bound or its move limit, still the cloud overflow (once) before a refusal.
  const pick = movesLeft ? await nextPick(p, nowMs) : !p.overflowed ? await nextPick(p, nowMs, { cloudOnly: true }) : undefined;
  const waitedS = Math.round(Math.max(0, nowMs - (p.placedAtMs ?? nowMs)) / 100) / 10;
  const out = pick ? moveTo(p, pick, nowMs, isCloudPick(pick) ? `re-placed: cloud overflow, no other host could start it within ${waitedS} s` : `re-placed: nobody picked it up within ${waitedS} s`) : "none";
  if (out === "replaced" || out === "same") {
    if (!movesLeft) p.overflowed = true;
    p.graced = false;
    p.placedAtMs = nowMs;
    // The new host is nudged first (preferAgent) and gets up to a quarter window to pull: within the
    // call's bound (run 14), except the cloud overflow tried last, which gets its quarter.
    p.decideBy = !movesLeft ? nowMs + quarter : Math.max(p.decideBy ?? nowMs, Math.min(nowMs + quarter, p.boundAt ?? Infinity));
    armAutoReplace(p, Math.max(1, Math.min(quarter, p.decideBy - nowMs)), nowMs);
    return out;
  }
  if (out === "claimed" || !queue.isUnclaimed(p.subtaskId)) return "claimed";
  // Before the refusal: it ends the call's pending usage, which holds its submit time.
  const elapsedMs = nowMs - (usagePending.get(p.taskId)?.atMs ?? nowMs);
  const currentReadiness = current ? claimReadiness(current, st, nowMs) : null;
  if (admission && (await admission.refuse(p))) {
    app.log.warn({ taskId: p.taskId, subtaskId: p.subtaskId, reason: final ? "not_claimed_in_time" : "no_host_can_claim", elapsedMs, tried: p.tried, current: current ?? null, currentReadiness, final }, "auto_call_refused_no_host");
    return "refused";
  }
  return "none";
}

const isCloudPick = (c: Pick<Candidate, "computeClass">) => c.computeClass === "cloud";

/**
 * Run 11: what an Auto call must have set aside to run on a cloud host here as overflow: the
 * largest call reserve (economy.ts inferenceCallReserve, the call's worst case) among the cloud
 * models best fit could move it to; 0 when no cloud host here could take it (none online, cloud
 * models off for Auto, or the call is limited to a class without the cloud).
 *
 * Run 18 (inf-1795706687095-618212e7): best fit keeps the standard cloud model (Flash) over a
 * premium one (GLM-5.3) unless the job asks for the best quality at top-tier complexity
 * (best-fit.ts cloudTier, jobWantsPremiumCloud). The reserve took every cloud model online, so a
 * complex Auto call placed on a GPU host held GLM's worst case (221.67 cSats) while the same call
 * placed on the cloud directly held Flash's (54.97 cSats), and a buyer with 95 cSats got a 402.
 * It now holds only the models of the tier best fit would pick: the premium tier only for a job
 * that wants it, or when no standard cloud model is online here (without a job: every model). A
 * premium pick the reserve does not cover is still kept off the call at re-placement
 * (reserveCoversCloud), as for a call placed on the cloud directly.
 */
export function cloudOverflowReserveMsat(call: { inputBytes: number; maxTokens: number; timeoutMs: number; maxCSats?: number; onlyClass?: string; job?: Pick<JobDescriptor, "job" | "complexity" | "quality"> }, nowMs = Date.now()): number {
  if (call.onlyClass && !classFamily(call.onlyClass).includes("cloud")) return 0;
  const online = new Set<string>();
  for (const a of localAgentViews(nowMs)) if (a.computeClass === "cloud") for (const model of a.models) online.add(model);
  const premium = [...online].filter(isPremiumCloudModel);
  const standard = [...online].filter((m) => !isPremiumCloudModel(m));
  const models = !call.job || !premium.length || !standard.length ? [...online] : jobWantsPremiumCloud(call.job) ? premium : standard;
  let most = 0;
  for (const model of models) {
    const r = inferenceCallReserve({ model, taskClass: "cloud", timeoutMs: call.timeoutMs, inputBytes: call.inputBytes, maxTokens: call.maxTokens, ...(call.maxCSats !== undefined ? { maxCSats: call.maxCSats } : {}) });
    most = Math.max(most, r.reserveMsat);
  }
  return most;
}

/** The call's reserve covers `pick`'s worst case on the cloud (always true for a non-cloud pick: its estimate is checked). */
function reserveCoversCloud(p: AutoPlacement, st: Subtask | undefined, pick: Candidate, reservedMsat: number): boolean {
  if (!isCloudPick(pick) || !st || !(reservedMsat > 0)) return true;
  let maxTokens = 0;
  try {
    maxTokens = Number(JSON.parse(st.input)?.maxTokens) || 0;
  } catch {
    maxTokens = 0;
  }
  const worst = inferenceCallReserve({ model: pick.model, taskClass: "cloud", timeoutMs: st.timeoutMs, inputBytes: Buffer.byteLength(st.input, "utf8"), maxTokens, ...(p.job.maxCSats !== undefined ? { maxCSats: p.job.maxCSats } : {}) });
  return worst.reserveMsat <= reservedMsat;
}

/**
 * Run 11: the local hosts that could not claim the call now on any model they hold (dispatch.ts
 * couldClaimNow, not held back). Best fit leaves them out of a re-placement, so a host that is free
 * by count but cannot start the call does not keep the cloud overflow out (cloudConsidered).
 */
function hostsNotReady(st: Subtask, skip: ReadonlySet<string>, nowMs: number): string[] {
  const out: string[] = [];
  for (const a of localAgentViews(nowMs)) {
    if (skip.has(a.agentId)) continue;
    if (!a.models.some((m) => hostCanStart(a.agentId, asPlacedOn(st, { model: m, computeClass: a.computeClass }), nowMs))) out.push(a.agentId);
  }
  return out;
}

/**
 * Run 10: the call is back on the queue (taken back from its host, or re-run elsewhere after a
 * failure): decided again as at submit, from now (routes/inference.ts armRequeueDecision). Before, its
 * decision had ended with the first claim and the call waited out the 45 s claim bound.
 */
export function rearmAutoDecision(subtaskId: string, nowMs = Date.now()): boolean {
  const p = autoCalls.get(subtaskId);
  if (!p || autoDecisionMs() <= 0) return false;
  p.decideBy = undefined;
  p.placedAtMs = undefined;
  p.receivedAtMs = undefined;
  p.graced = false;
  armAutoReplace(p, undefined, nowMs);
  return true;
}

/**
 * The first local candidate best fit gives for the call without the agents it tried and (run 11)
 * without the hosts that could not claim it now, within its reserve (for a cloud host: the reserve
 * covers the cloud's worst case). `cloudOnly`: only a cloud host (the overflow past the call's
 * decision bound or move limit).
 */
async function nextPick(p: AutoPlacement, nowMs: number, opts: { cloudOnly?: boolean } = {}): Promise<Candidate | undefined> {
  const st = queue.getSubtask(p.subtaskId);
  const tried = new Set(p.tried);
  const excluded = st ? [...tried, ...hostsNotReady(st, tried, nowMs)] : [...tried];
  // Run 14 (inf-1795679848520-2a6a2a54: Mac, then the nrt CPU host, neither claimed; refused at
  // 1.88 s with the cloud 16/16 free): the overflow step asked best fit with the other CPU hosts in
  // its view, which kept the cloud out (cloudConsidered), and skipped every non-cloud candidate
  // without leaving it out: nothing was found. It now leaves every non-cloud host out at once.
  if (opts.cloudOnly) for (const a of localAgentViews(nowMs)) if (a.computeClass !== "cloud" && !excluded.includes(a.agentId)) excluded.push(a.agentId);
  const billing = taskBilling.get(p.taskId);
  const reservedMsat = billing?.reservedMsat ?? 0;
  const budgetCSats = reservedMsat > 0 ? msatToCSats(reservedMsat) : Infinity;
  // Run 12 (inf-1795660747963-7141aae5: a ~4.6k-token summary left on the Mac, refused while the
  // cloud host was 16/16 free): best fit's own estimate had a 1.5b CPU host finish in time, so it
  // kept the cloud out (cloudConsidered), but the completion gate (admission.fits) said it would
  // not: no candidate passed. A candidate that fails the gate or cannot claim the call now is left
  // out and best fit asked again, so the cloud overflow is reached.
  for (let pass = 0; pass < NEXT_PICK_PASSES; pass++) {
    const { result } = await resolveAuto(p.job, { peers: false, requesterAccountId: p.accountId, excludeAgents: excluded, clientRegion: p.clientRegion ?? null, ...(p.onlyClass ? { computeClass: p.onlyClass } : {}) }, nowMs);
    const seen = new Set<Candidate>();
    let more = false;
    for (const c of [result.chosen, ...result.candidates]) {
      if (!c || seen.has(c) || !c.local) continue;
      seen.add(c);
      if (opts.cloudOnly && !isCloudPick(c)) continue;
      if (!(c.estimate.cSats <= budgetCSats) || !reserveCoversCloud(p, st, c, reservedMsat)) continue;
      // Run 9: only onto a host that could claim it now (not a busy one), within the completion gate.
      if ((admission?.fits(p, c, nowMs) ?? true) && (!st || hostCanStart(c.agentId, asPlacedOn(st, c), nowMs))) return c;
      if (!isCloudPick(c) && !excluded.includes(c.agentId)) {
        excluded.push(c.agentId);
        more = true;
      }
    }
    if (!more) return undefined;
  }
  return undefined;
}

/** Times nextPick asks best fit again without the candidates that could not take the call. */
const NEXT_PICK_PASSES = 4;

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
