// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Run 7 (2026-11-25): the portal compares two hosts of one class by their own measured speeds
 * (#562), and those speeds had been measured while the hosts were throttled by their CPU credit
 * balance right after a fleet deploy (an lhr host "2160 ms" against iad "936 ms"; served locally,
 * lhr took about 1 s). Agents read their CPU steal (src/swarm/cpu-steal.ts, #563) and now say so
 * with each pull and each reply piece: the share of their busy CPU time stolen over the last
 * reading, and whether their guard holds them back. A speed sample from a call that ran while its
 * host was stolen from is not a measurement of the host (start-eta.ts leaves it out of every speed),
 * and the host's own speed counts only samples taken after its last stolen report, so a speed
 * measured during throttling does not linger once the throttling ends.
 *
 * INFERENCE_SPEED_STEAL_SHARE: a report at or above this share counts as stolen (default 0.2; the
 * guard itself holds a host back at 0.5, and shared-host noise outside throttling is a few percent).
 * "off" or 0: steal reports are ignored. A report with `throttled` true always counts.
 */

/** Share of busy CPU time stolen at which a host's speed samples are left out. */
export const SPEED_STEAL_SHARE = 0.2;
/** A call whose claim came at most this long after the host's last stolen report ran stolen from (the guard's reading spans ~5 s). */
export const STEAL_LOOKBACK_MS = 10_000;

/** INFERENCE_SPEED_STEAL_SHARE: unset, the default; "off" / 0, null (reports ignored); else the share (0..1]. */
export function parseStealShare(raw: string | undefined): number | null {
  const t = (raw ?? "").trim().toLowerCase();
  if (t === "") return SPEED_STEAL_SHARE;
  if (t === "off" || t === "false" || t === "none") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 1) return SPEED_STEAL_SHARE;
  return n === 0 ? null : n;
}

let shareCache: { raw: string | undefined; share: number | null } | undefined;
function stealShareLimit(): number | null {
  const raw = process.env.INFERENCE_SPEED_STEAL_SHARE;
  if (!shareCache || shareCache.raw !== raw) shareCache = { raw, share: parseStealShare(raw) };
  return shareCache.share;
}

/** When each agent last reported being stolen from. */
const lastStolenAt = new Map<string, number>();

/** What an agent says about its CPU steal (pull or reply piece). Fields it does not send are ignored. */
export function noteAgentSteal(agentId: string | undefined, report: { cpuStealShare?: unknown; cpuThrottled?: unknown } | null | undefined, nowMs = Date.now()): void {
  if (!agentId || !report) return;
  const limit = stealShareLimit();
  if (limit === null) return;
  const share = typeof report.cpuStealShare === "number" && Number.isFinite(report.cpuStealShare) ? report.cpuStealShare : undefined;
  if (report.cpuThrottled === true || (share !== undefined && share >= limit)) {
    lastStolenAt.set(agentId, nowMs);
    if (lastStolenAt.size > 10_000) lastStolenAt.delete(lastStolenAt.keys().next().value as string);
  }
}

/** When `agentId` last reported being stolen from; undefined when never (or not since a restart). */
export function agentStolenAt(agentId: string): number | undefined {
  return stealShareLimit() === null ? undefined : lastStolenAt.get(agentId);
}

/** Whether a call `agentId` ran from `claimedAtMs` on was stolen from (its host reported steal during it, or just before). */
export function stolenDuring(agentId: string, claimedAtMs: number): boolean {
  const at = agentStolenAt(agentId);
  return at !== undefined && at >= claimedAtMs - STEAL_LOOKBACK_MS;
}

export function clearAgentSteal(): void {
  lastStolenAt.clear();
}
