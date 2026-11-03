// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/*
 * Stats-ledger checkpoints across coordinators.
 *
 * Every coordinator signs a checkpoint of the stats ledger; once a quorum of coordinators has
 * signed the same checkpoint hash, one of them writes a commit (soft finality), which may then be
 * anchored on Bitcoin (hard finality).
 *
 * The checkpoint target must be the same record for every coordinator, and signing must not move
 * it. So the target is the newest *work* record (signature and commit rows excluded) issued at or
 * before a time boundary that every coordinator derives from its clock the same way. The boundary
 * lags by a settle delay so records still being written are not raced. With nothing new since the
 * last commit the target does not change and a tick writes nothing.
 */

export interface StatsCheckpointTarget {
  hash: string;
  issuedAtMs: number;
  height: number;
}

export interface StatsCheckpointStore {
  latestStatsDataRecordAtOrBefore(atOrBeforeMs: number): Promise<StatsCheckpointTarget | null>;
  checkpointSignatureStatus(checkpointHash: string): Promise<{ hasCommit: boolean; signers: string[] }>;
  /** Serialises signing across coordinators sharing a database (optional for in-memory use). */
  withStatsCheckpointLock?<T>(fn: () => Promise<T>): Promise<T>;
}

export interface StatsCheckpointDeps {
  store: StatsCheckpointStore;
  selfId: string;
  /** Distinct signers needed for a commit. */
  threshold: number;
  nowMs: number;
  /** Checkpoint period: one target per period boundary. */
  periodMs: number;
  /** How long after a boundary records are assumed written. */
  settleMs: number;
  /** Append and persist this coordinator's signature record for `target`. */
  writeSignature(target: StatsCheckpointTarget, threshold: number): Promise<void>;
  /** Append and persist the commit record for `target`. */
  writeCommit(target: StatsCheckpointTarget, threshold: number, signers: string[]): Promise<void>;
}

export interface StatsCheckpointOutcome {
  target: StatsCheckpointTarget | null;
  signed: boolean;
  committed: boolean;
  signers: string[];
}

/** The boundary every coordinator agrees on at `nowMs`: the last period start at least `settleMs` ago. */
export function statsCheckpointBoundaryMs(nowMs: number, periodMs: number, settleMs: number): number {
  const period = Math.max(1, periodMs);
  return Math.floor((nowMs - Math.max(0, settleMs)) / period) * period;
}

/** Default period: several sync intervals, so each coordinator gets more than one tick per boundary. */
export function statsCheckpointPeriodMs(syncIntervalMs: number): number {
  return Math.max(60_000, syncIntervalMs * 6);
}

/** One signing round: sign the boundary's target if not yet signed here, commit once the quorum is reached. */
export async function finalizeStatsCheckpoint(deps: StatsCheckpointDeps): Promise<StatsCheckpointOutcome> {
  const run = async (): Promise<StatsCheckpointOutcome> => {
    const boundary = statsCheckpointBoundaryMs(deps.nowMs, deps.periodMs, deps.settleMs);
    const target = await deps.store.latestStatsDataRecordAtOrBefore(boundary);
    if (!target) return { target: null, signed: false, committed: false, signers: [] };
    const { hasCommit, signers } = await deps.store.checkpointSignatureStatus(target.hash);
    const signerSet = new Set(signers);
    let signed = false;
    if (!signerSet.has(deps.selfId)) {
      await deps.writeSignature(target, deps.threshold);
      signerSet.add(deps.selfId);
      signed = true;
    }
    let committed = false;
    if (!hasCommit && signerSet.size >= deps.threshold) {
      await deps.writeCommit(target, deps.threshold, [...signerSet].sort());
      committed = true;
    }
    return { target, signed, committed, signers: [...signerSet].sort() };
  };
  return deps.store.withStatsCheckpointLock ? deps.store.withStatsCheckpointLock(run) : run();
}

/**
 * Finality of the latest commit. Without an anchor provider the commit is the final state
 * ("soft_finalized"); "anchored_pending" means an anchor exists but is not yet confirmed (or
 * anchoring is on and has not run for this checkpoint yet).
 */
export function statsFinalityState(input: {
  hasCommit: boolean;
  anchoringEnabled: boolean;
  anchorExists: boolean;
  hardFinalized: boolean;
}): "soft_finalized" | "anchored_pending" | "anchored_confirmed" | "no_checkpoint" {
  if (!input.hasCommit) return "no_checkpoint";
  if (input.hardFinalized) return "anchored_confirmed";
  if (!input.anchoringEnabled && !input.anchorExists) return "soft_finalized";
  return "anchored_pending";
}
