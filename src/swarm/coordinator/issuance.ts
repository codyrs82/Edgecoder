// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Issuance epochs: pool sizing, quorum records, finalisation and anchoring.
 */
import { createHash, randomUUID } from "node:crypto";
import type {
  BitcoinAnchorRecord,
  IssuanceAllocationRecord,
  IssuanceEpochRecord,
  QuorumLedgerRecord
} from "../../common/types.js";
import { signPayload } from "../../mesh/peer.js";
import { pgStore } from "../../db/store.js";
import type { PostgresStore } from "../../db/postgres.js";
import {
  computeDailyPoolTokens,
  computeHourlyIssuanceAllocations,
  computeLoadIndex,
  type IssuancePoolConfig,
  smoothLoadIndex
} from "../../economy/issuance.js";
import {
  ensureIssuanceEpoch,
  type IssuanceAllocationDraft,
  type IssuanceEpochDraft,
  type IssuanceWindow
} from "../../economy/issuance-epoch.js";
import { anchorEpochOnce } from "../../economy/anchoring.js";
import { app } from "./app.js";
import {
  ISSUANCE_BASE_DAILY_POOL_TOKENS,
  ISSUANCE_MIN_DAILY_POOL_TOKENS,
  ISSUANCE_MAX_DAILY_POOL_TOKENS,
  ISSUANCE_LOAD_CURVE_SLOPE,
  ISSUANCE_SMOOTHING_ALPHA,
  identity,
  coordinatorKeys,
  ISSUANCE_RECALC_MS,
  ISSUANCE_WINDOW_MS,
  queue
} from "./context.js";
import { mutable } from "./mutable-state.js";
import { agentCapabilities } from "./agent-state.js";
import { anchorDeps } from "./stats-ledger.js";

let smoothedLoadIndex: number | null = null;

const issuancePoolConfig: IssuancePoolConfig = {
  baseDailyPoolTokens: ISSUANCE_BASE_DAILY_POOL_TOKENS,
  minDailyPoolTokens: ISSUANCE_MIN_DAILY_POOL_TOKENS,
  maxDailyPoolTokens: ISSUANCE_MAX_DAILY_POOL_TOKENS,
  loadCurveSlope: ISSUANCE_LOAD_CURVE_SLOPE,
  smoothingAlpha: ISSUANCE_SMOOTHING_ALPHA
};

function quorumThreshold(): number {
  if (!mutable.treasuryPolicy || mutable.treasuryPolicy.approvedCoordinatorIds.length === 0) return 1;
  return Math.max(1, Math.floor(mutable.treasuryPolicy.approvedCoordinatorIds.length / 2) + 1);
}

export async function appendQuorumRecord(input: {
  recordType: QuorumLedgerRecord["recordType"];
  epochId: string;
  payload: Record<string, unknown>;
}): Promise<QuorumLedgerRecord> {
  const prev = await pgStore?.latestQuorumLedgerRecord();
  const payloadJson = JSON.stringify(input.payload);
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        recordType: input.recordType,
        epochId: input.epochId,
        coordinatorId: identity.peerId,
        prevHash: prev?.hash ?? "GENESIS",
        payloadJson
      })
    )
    .digest("hex");
  const record: QuorumLedgerRecord = {
    recordId: randomUUID(),
    recordType: input.recordType,
    epochId: input.epochId,
    coordinatorId: identity.peerId,
    prevHash: prev?.hash ?? "GENESIS",
    hash,
    payloadJson,
    signature: signPayload(hash, coordinatorKeys.privateKeyPem),
    createdAtMs: Date.now()
  };
  await pgStore?.persistQuorumLedgerRecord(record);
  return record;
}

/** Call under the shared issuance lock (pgStore.withIssuanceLock) so the commit is written once. */
export async function maybeFinalizeIssuanceEpoch(epoch: IssuanceEpochRecord): Promise<boolean> {
  const records = (await pgStore?.listQuorumLedgerByEpoch(epoch.issuanceEpochId)) ?? [];
  const approvals = new Set<string>();
  for (const record of records) {
    if (record.recordType === "issuance_proposal") approvals.add(record.coordinatorId);
    if (record.recordType === "issuance_vote") {
      const payload = JSON.parse(record.payloadJson) as { vote?: "approve" | "reject" };
      if (payload.vote === "approve") approvals.add(record.coordinatorId);
    }
  }
  if (approvals.size < quorumThreshold()) return false;
  const hasCommit = records.some((record) => record.recordType === "issuance_commit");
  if (!hasCommit) {
    await appendQuorumRecord({
      recordType: "issuance_commit",
      epochId: epoch.issuanceEpochId,
      payload: { approvals: [...approvals], threshold: quorumThreshold() }
    });
  }
  if (!epoch.finalized) await pgStore?.markIssuanceEpochFinalized(epoch.issuanceEpochId);
  return true;
}

/**
 * One epoch per issuance window across every seed on this database: the window is aligned to
 * ISSUANCE_RECALC_MS and the epoch id derives from it, so the first seed to tick computes and writes
 * the epoch and its allocations; the others (and restarts) read it back. Only the computing seed
 * proposes and self-approves; other seeds vote through /economy/issuance/quorum/vote as before.
 */
export async function runIssuanceTick(): Promise<{ epoch?: IssuanceEpochRecord; allocations: IssuanceAllocationRecord[]; created: boolean }> {
  if (!pgStore) return { allocations: [], created: false };
  const store = pgStore;
  return ensureIssuanceEpoch({
    store,
    nowMs: Date.now(),
    recalcMs: ISSUANCE_RECALC_MS,
    windowMs: ISSUANCE_WINDOW_MS,
    compute: (window) => computeIssuanceEpoch(store, window),
    afterEpoch: async ({ epoch, created }) => {
      if (created) {
        await appendQuorumRecord({
          recordType: "issuance_proposal",
          epochId: epoch.issuanceEpochId,
          payload: {
            windowStartMs: epoch.windowStartMs,
            windowEndMs: epoch.windowEndMs,
            dailyPoolTokens: epoch.dailyPoolTokens,
            loadIndex: epoch.loadIndex
          }
        });
        await appendQuorumRecord({
          recordType: "issuance_vote",
          epochId: epoch.issuanceEpochId,
          payload: { vote: "approve", voterCoordinatorId: identity.peerId }
        });
      }
      if (epoch.finalized) return epoch;
      return (await maybeFinalizeIssuanceEpoch(epoch)) ? { ...epoch, finalized: true } : epoch;
    }
  });
}

async function computeIssuanceEpoch(
  store: PostgresStore,
  { windowStartMs, windowEndMs }: IssuanceWindow
): Promise<{ epoch: IssuanceEpochDraft; allocations: IssuanceAllocationDraft[] } | null> {
  const shares = await store.rollingContributionShares(windowStartMs, windowEndMs);
  if (shares.length === 0) return null;
  const status = queue.status();
  const cpuCapacity = Math.max(
    1,
    [...agentCapabilities.values()].reduce((sum, item) => sum + Math.max(1, item.maxConcurrentTasks), 0)
  );
  const gpuCapacity = Math.max(
    1,
    [...agentCapabilities.values()].filter((item) => item.localModelProvider === "ollama-local").length
  );
  const rawLoadIndex = computeLoadIndex({
    queuedTasks: status.queued,
    activeAgents: status.agents,
    cpuCapacity,
    gpuCapacity
  });
  // Smooth from the network's last epoch (whichever seed wrote it), so the one series stays continuous.
  const previous = (await store.latestIssuanceEpoch(false, ISSUANCE_RECALC_MS))?.loadIndex ?? smoothedLoadIndex;
  smoothedLoadIndex = smoothLoadIndex(previous, rawLoadIndex, issuancePoolConfig.smoothingAlpha);
  const dailyPoolTokens = computeDailyPoolTokens(smoothedLoadIndex, issuancePoolConfig);
  const totalWeightedContribution = shares.reduce((sum, item) => sum + item.weightedContribution, 0);
  return {
    epoch: {
      coordinatorId: identity.peerId,
      loadIndex: smoothedLoadIndex,
      dailyPoolTokens,
      hourlyTokens: Number((dailyPoolTokens / 24).toFixed(6)),
      totalWeightedContribution: Number(totalWeightedContribution.toFixed(6)),
      contributionCount: shares.length,
      createdAtMs: Date.now()
    },
    allocations: computeHourlyIssuanceAllocations(shares, dailyPoolTokens)
  };
}

export async function maybeAnchorLatestFinalizedEpoch(): Promise<BitcoinAnchorRecord | null> {
  const deps = anchorDeps();
  if (!deps || !pgStore) return null;
  const epoch = await pgStore.latestIssuanceEpoch(true, ISSUANCE_RECALC_MS);
  if (!epoch) return null;
  const store = pgStore;
  let allocationCount = 0;
  // #46/#101: looked up by epoch id (then checkpoint hash under the lock), never "newest row";
  // the ledger checkpoint record is appended only when this tick actually broadcast.
  const { record } = await anchorEpochOnce(deps, {
    epochId: epoch.issuanceEpochId,
    computeCheckpointHash: async () => {
      const allocations = await store.listIssuanceAllocations(epoch.issuanceEpochId);
      allocationCount = allocations.length;
      return createHash("sha256").update(JSON.stringify({ epoch, allocations })).digest("hex");
    },
    onBroadcast: async (anchor) => {
      await appendQuorumRecord({
        recordType: "issuance_checkpoint",
        epochId: epoch.issuanceEpochId,
        payload: { checkpointHash: anchor.checkpointHash, allocationCount, anchorTxRef: anchor.txRef }
      }).catch((error) => app.log.error({ error, epochId: epoch.issuanceEpochId, txRef: anchor.txRef }, "issuance_checkpoint_ledger_append_failed"));
    }
  });
  return record;
}
