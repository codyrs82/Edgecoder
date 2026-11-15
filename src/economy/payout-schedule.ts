// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Periodic payout jobs that must survive restarts (automatic Lightning-address payouts).
 *
 * The coordinator used to run auto payouts with setInterval(PAYOUT_AUTO_INTERVAL_MS = 6 h) and no
 * first run, so every restart pushed the next pass 6 h out. The seeds were deployed several times
 * a day (live regtest, 2026-11-15: two releases within the hour), so auto payouts never ran.
 * Now the last run is recorded in the shared payout_controls table and a short tick runs the job
 * once it is due: once per interval across restarts and across every seed on the database.
 */
export interface PayoutRunClaimStore {
  /**
   * Atomically record a run of `key` at `nowMs` if the previous one is at least `minIntervalMs` old
   * (or there is none). True when this caller claimed the run; false when it is not due yet.
   */
  claimPayoutRun(key: string, nowMs: number, minIntervalMs: number): Promise<boolean>;
}

export class MemoryPayoutRunClaimStore implements PayoutRunClaimStore {
  private readonly last = new Map<string, number>();
  async claimPayoutRun(key: string, nowMs: number, minIntervalMs: number): Promise<boolean> {
    const prev = this.last.get(key);
    if (prev !== undefined && nowMs - prev < minIntervalMs) return false;
    this.last.set(key, nowMs);
    return true;
  }
}

/** How often to check whether the job is due: often enough to be on time, never more than every 5 min. */
export function payoutTickMs(intervalMs: number): number {
  return Math.max(10_000, Math.min(intervalMs, 5 * 60_000));
}

/** One tick: run `job` if this caller claims the run. */
export async function runPayoutJobIfDue(
  store: PayoutRunClaimStore,
  key: string,
  intervalMs: number,
  job: () => Promise<unknown>,
  now: () => number = Date.now
): Promise<"ran" | "not_due"> {
  if (!(await store.claimPayoutRun(key, now(), intervalMs))) return "not_due";
  await job();
  return "ran";
}
