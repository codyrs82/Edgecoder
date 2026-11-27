// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The stats ledger: projection, checkpoints, anchoring and peer sync.
 */
import { request } from "undici";
import { parseRecordPayload } from "../coordinator-utils.js";
import type { BitcoinAnchorRecord, QueueEventRecord } from "../../common/types.js";
import { verifyPayload } from "../../mesh/peer.js";
import { hashRecordPayload } from "../../ledger/record.js";
import { finalizeStatsCheckpoint, statsCheckpointPeriodMs, statsFinalityState } from "../../ledger/stats-checkpoint.js";
import { pgStore } from "../../db/store.js";
import { createBitcoinAnchorProviderFromEnv, type BitcoinAnchorProvider } from "../../economy/bitcoin-rpc.js";
import { anchorCheckpoint, type AnchorDeps } from "../../economy/anchoring.js";
import { AnchorTracker, anchorEventLogger, anchorTrackerTuningFromEnv } from "../../economy/anchor-tracker.js";
import {
  anchoringStatus,
  checkpointAnchorFinality,
  resolveAnchoringMode,
  type AnchoringStatus,
  type AnchorView
} from "../../economy/anchor-status.js";
import { repointEpochAnchor } from "../../receipts/epochs.js";
import { app } from "./app.js";
import {
  mesh,
  STATS_LEDGER_SYNC_INTERVAL_MS,
  identity,
  BITCOIN_NETWORK,
  ANCHOR_REQUIRED_CONFIRMATIONS,
  ANCHOR_CONFIRM_POLL_MS,
  ANCHOR_RECONCILE_CONFIG,
  STATS_ANCHOR_MIN_CONFIRMATIONS
} from "./context.js";
import { peerRequestHeaders } from "./peer-auth.js";
import { agentCapabilities, ordering } from "./agent-state.js";
import { receiptStore } from "./services.js";
import { coordinatorPublicKeyById, isApprovedCoordinator } from "./peers.js";

async function applyStatsProjectionRecord(record: {
  eventType: string;
  taskId: string;
  actorId: string;
  issuedAtMs: number;
  payloadJson?: string;
}): Promise<void> {
  if (!pgStore) return;
  const payload = parseRecordPayload(record);
  if (record.eventType === "node_approval" || record.eventType === "node_validation") {
    const [kindRaw, nodeIdRaw] = record.taskId.split(":");
    const nodeId = nodeIdRaw || record.actorId;
    const nodeKind = kindRaw === "coordinator" ? "coordinator" : "agent";
    await pgStore.upsertNodeStatusProjection({
      nodeId,
      nodeKind,
      ownerEmail: typeof payload.ownerEmail === "string" ? payload.ownerEmail : undefined,
      emailVerified: typeof payload.emailVerified === "boolean" ? payload.emailVerified : undefined,
      nodeApproved:
        typeof payload.nodeApproved === "boolean"
          ? payload.nodeApproved
          : typeof payload.approved === "boolean"
            ? payload.approved
            : undefined,
      active: typeof payload.active === "boolean" ? payload.active : undefined,
      sourceIp: typeof payload.sourceIp === "string" ? payload.sourceIp : undefined,
      countryCode: typeof payload.countryCode === "string" ? payload.countryCode : undefined,
      vpnDetected: typeof payload.vpnDetected === "boolean" ? payload.vpnDetected : undefined,
      lastSeenMs: record.issuedAtMs,
      updatedAtMs: record.issuedAtMs
    });
    return;
  }
  if (record.eventType === "earnings_accrual") {
    const credits =
      typeof payload.credits === "number"
        ? payload.credits
        : typeof payload.estimatedCredits === "number"
          ? payload.estimatedCredits
          : 0;
    if (credits <= 0) return;
    await pgStore.incrementCoordinatorEarningsProjection({
      accountId: record.actorId,
      ownerEmail: typeof payload.ownerEmail === "string" ? payload.ownerEmail : undefined,
      credits,
      taskCountDelta: 1,
      updatedAtMs: record.issuedAtMs
    });
  }
}

export async function persistStatsLedgerRecord(record: {
  id: string;
  eventType: any;
  taskId: string;
  subtaskId?: string;
  actorId: string;
  sequence: number;
  issuedAtMs: number;
  prevHash: string;
  coordinatorId?: string;
  checkpointHeight?: number;
  checkpointHash?: string;
  payloadJson?: string;
  hash: string;
  signature: string;
}): Promise<void> {
  // Projections (earnings totals, node status) apply once per record: a row another coordinator on
  // this database already stored, or one sync re-ingests, is not counted again.
  const inserted = pgStore ? await pgStore.persistStatsLedgerRecord(record) : false;
  if (inserted) await applyStatsProjectionRecord(record);
}

function verifyStatsLedgerRecord(record: {
  eventType: any;
  taskId: string;
  subtaskId?: string;
  actorId: string;
  sequence: number;
  issuedAtMs: number;
  prevHash: string;
  coordinatorId?: string;
  checkpointHeight?: number;
  checkpointHash?: string;
  payloadJson?: string;
  hash: string;
  signature: string;
}): boolean {
  if (!record.coordinatorId) return false;
  const publicKeyPem = coordinatorPublicKeyById(record.coordinatorId);
  if (!publicKeyPem) return false;
  const expectedHash = hashRecordPayload({
    eventType: record.eventType,
    taskId: record.taskId,
    subtaskId: record.subtaskId,
    actorId: record.actorId,
    sequence: record.sequence,
    issuedAtMs: record.issuedAtMs,
    prevHash: record.prevHash,
    coordinatorId: record.coordinatorId,
    checkpointHeight: record.checkpointHeight,
    checkpointHash: record.checkpointHash,
    payloadJson: record.payloadJson
  });
  if (expectedHash !== record.hash) return false;
  return verifyPayload(record.hash, record.signature, publicKeyPem);
}

/**
 * Signers a checkpoint commit needs: a majority of the coordinators. Only coordinator peers count:
 * the mesh peer table also holds agents (they announce themselves over the mesh), and counting them
 * set the quorum out of reach on the coordinator with the most agents. The 2026-11-24 run: the US
 * seed (its 9 fleet agents in its peer table) never committed a checkpoint, while the EU seed
 * (2 agents) committed every one: each coordinator computed a different threshold.
 */
export function statsQuorumThreshold(
  peers: ReadonlyArray<{ peerId: string }> = mesh.listPeers(),
  isAgent: (peerId: string) => boolean = (id) => agentCapabilities.has(id),
  approved: (peerId: string) => boolean = isApprovedCoordinator,
): number {
  const coordinators = new Set(peers.map((p) => p.peerId).filter((id) => id !== identity.peerId && !isAgent(id) && approved(id)));
  return Math.max(1, Math.floor((coordinators.size + 1) / 2) + 1);
}

/** One checkpoint per period; the settle delay covers records still being written by any coordinator. */
const STATS_CHECKPOINT_PERIOD_MS = statsCheckpointPeriodMs(STATS_LEDGER_SYNC_INTERVAL_MS);
const STATS_CHECKPOINT_SETTLE_MS = Math.max(5_000, STATS_LEDGER_SYNC_INTERVAL_MS);

/**
 * Sign the shared checkpoint target (src/ledger/stats-checkpoint.ts) and commit once a quorum of
 * coordinators signed it. Signing never moves the target, so coordinators converge on one hash
 * instead of each signing the other's last signature.
 */
export async function maybeFinalizeStatsCheckpoint(): Promise<void> {
  if (!pgStore) return;
  const store = pgStore;
  const outcome = await finalizeStatsCheckpoint({
    store,
    selfId: identity.peerId,
    threshold: statsQuorumThreshold(),
    nowMs: Date.now(),
    periodMs: STATS_CHECKPOINT_PERIOD_MS,
    settleMs: STATS_CHECKPOINT_SETTLE_MS,
    writeSignature: async (target, threshold) => {
      const signatureRecord = ordering.append({
        eventType: "stats_checkpoint_signature",
        taskId: "stats-ledger",
        actorId: identity.peerId,
        coordinatorId: identity.peerId,
        checkpointHeight: target.height,
        checkpointHash: target.hash,
        payloadJson: JSON.stringify({ threshold, signerPeerId: identity.peerId, targetIssuedAtMs: target.issuedAtMs })
      });
      await store.persistLedgerRecord(signatureRecord);
      await persistStatsLedgerRecord(signatureRecord);
    },
    writeCommit: async (target, threshold, signers) => {
      const commitRecord = ordering.append({
        eventType: "stats_checkpoint_commit",
        taskId: "stats-ledger",
        actorId: identity.peerId,
        coordinatorId: identity.peerId,
        checkpointHeight: target.height,
        checkpointHash: target.hash,
        payloadJson: JSON.stringify({ threshold, signerSet: signers, targetIssuedAtMs: target.issuedAtMs })
      });
      await store.persistLedgerRecord(commitRecord);
      await persistStatsLedgerRecord(commitRecord);
    }
  });
  if (outcome.committed) app.log.info({ checkpointHash: outcome.target?.hash, signers: outcome.signers }, "stats_checkpoint_committed");
}

/**
 * #46: anchoring needs a real provider. An unset (or unusable) BITCOIN_ANCHOR_PROVIDER disables
 * anchoring in every environment: nothing is broadcast and no anchor record is written. The
 * mock provider is used only when asked for by name, and its rows are reported as simulated.
 */
const ANCHORING_MODE = resolveAnchoringMode();
let anchorProviderCache: BitcoinAnchorProvider | null | undefined;
export function anchorDeps(): AnchorDeps | null {
  if (!pgStore) return null;
  if (anchorProviderCache === undefined) {
    if (ANCHORING_MODE.mode === "disabled") {
      app.log.warn(
        { problem: ANCHORING_MODE.problem },
        "bitcoin_anchoring_disabled: set BITCOIN_ANCHOR_PROVIDER=bitcoind|anchor-proxy to anchor checkpoints"
      );
      anchorProviderCache = null;
    } else {
      anchorProviderCache = createBitcoinAnchorProviderFromEnv(BITCOIN_NETWORK);
    }
  }
  return anchorProviderCache
    ? { provider: anchorProviderCache, store: pgStore, network: BITCOIN_NETWORK, providerName: ANCHORING_MODE.provider ?? undefined }
    : null;
}

export async function maybeAnchorLatestStatsCheckpoint(): Promise<BitcoinAnchorRecord | null> {
  const deps = anchorDeps();
  if (!deps || !pgStore) return null;
  // Anchor what the quorum committed (latestStatsFinality looks the anchor up by that hash).
  const checkpoint = await pgStore.latestStatsCheckpoint();
  if (!checkpoint) return null;
  return anchorCheckpoint(deps, { epochId: `stats:${checkpoint.height ?? 0}`, checkpointHash: checkpoint.hash });
}

/**
 * #46: confirmation loop (src/economy/anchor-tracker.ts). pending -> anchored at the required
 * depth, back to pending on a reorg, and a new broadcast when the transaction is gone.
 */
export const anchorTracker = new AnchorTracker({
  deps: anchorDeps,
  config: {
    requiredConfirmations: ANCHOR_REQUIRED_CONFIRMATIONS,
    pollMs: ANCHOR_CONFIRM_POLL_MS,
    reconcile: ANCHOR_RECONCILE_CONFIG,
    ...anchorTrackerTuningFromEnv()
  },
  onEvent: anchorEventLogger(app.log),
  // A receipt epoch keeps its own copy of the txid; follow a replacement or recovered broadcast.
  onTxidAssigned: async (record) => {
    if (await repointEpochAnchor(receiptStore, record)) {
      app.log.info({ epochId: record.epochId, txRef: record.txRef }, "receipt_epoch_anchor_repointed");
    }
  },
  onError: (error, where) => app.log.warn({ error, where }, "anchor_tracker_error")
});

/** #103: resolve "broadcasting" rows (crash mid-broadcast) and stuck pending txs; re-broadcast dropped ones. */
export async function reconcileAnchorRows(): Promise<void> {
  await anchorTracker.reconcile();
}

/** #46: whether this coordinator anchors at all, for the status endpoints. */
export function currentAnchoringStatus(): AnchoringStatus {
  return anchoringStatus({
    mode: ANCHORING_MODE,
    storeAvailable: Boolean(pgStore),
    network: BITCOIN_NETWORK,
    requiredConfirmations: ANCHOR_REQUIRED_CONFIRMATIONS,
    tracker: anchorTracker.status()
  });
}

export async function latestStatsFinality(): Promise<{
  checkpointHash?: string;
  checkpointHeight?: number;
  softFinalized: boolean;
  hardFinalized: boolean;
  finalityState: "soft_finalized" | "anchored_pending" | "anchored_confirmed" | "no_checkpoint";
  anchoring: AnchoringStatus;
  /** Rows the old simulation or the mock provider wrote come back with status "simulated" and no txRef. */
  anchor?: AnchorView;
}> {
  const anchoring = currentAnchoringStatus();
  if (!pgStore) {
    return {
      softFinalized: false,
      hardFinalized: false,
      finalityState: "no_checkpoint",
      anchoring
    };
  }
  const latestCommit = await pgStore.latestStatsCheckpoint();
  if (!latestCommit || !latestCommit.hash) {
    return {
      softFinalized: false,
      hardFinalized: false,
      finalityState: "no_checkpoint",
      anchoring
    };
  }
  // #46: hard finality is a real transaction at the required depth, never a simulated row.
  const { hardFinalized, anchorInProgress, anchor } = checkpointAnchorFinality({
    anchor: await pgStore.latestAnchorByCheckpoint(latestCommit.hash),
    requiredConfirmations: ANCHOR_REQUIRED_CONFIRMATIONS,
    minConfirmations: STATS_ANCHOR_MIN_CONFIRMATIONS
  });
  return {
    checkpointHash: latestCommit.hash,
    checkpointHeight: latestCommit.height ?? undefined,
    softFinalized: true,
    hardFinalized,
    // Without a real anchor provider (production default) the quorum commit is final: say so instead of
    // reporting an anchor that will never come.
    finalityState: statsFinalityState({ hasCommit: true, anchoringEnabled: anchoring.enabled, anchorExists: anchorInProgress, hardFinalized }),
    anchoring,
    anchor
  };
}

export async function ingestStatsLedgerRecords(records: QueueEventRecord[]): Promise<{ ingested: number; skipped: number }> {
  let ingested = 0;
  let skipped = 0;
  for (const record of records) {
    if (!verifyStatsLedgerRecord(record)) {
      skipped += 1;
      continue;
    }
    await persistStatsLedgerRecord(record);
    ingested += 1;
  }
  if (ingested > 0) {
    await maybeFinalizeStatsCheckpoint();
  }
  return { ingested, skipped };
}

export async function syncStatsLedgerFromPeer(peer: { peerId: string; coordinatorUrl: string }): Promise<void> {
  if (!pgStore) return;
  try {
    const headUrl = `${peer.coordinatorUrl}/stats/ledger/head`;
    const headRes = await request(headUrl, {
      method: "GET",
      headers: peerRequestHeaders("GET", headUrl),
      headersTimeout: 8_000,
      bodyTimeout: 8_000,
    });
    if (headRes.statusCode < 200 || headRes.statusCode >= 300) {
      await headRes.body.text().catch(() => "");
      return;
    }
    const remoteHead = (await headRes.body.json()) as { issuedAtMs?: number };
    if (!remoteHead.issuedAtMs) return;
    const localHead = await pgStore.latestStatsLedgerHead();
    const sinceIssuedAtMs = localHead?.issuedAtMs ?? 0;
    if (remoteHead.issuedAtMs <= sinceIssuedAtMs) return;
    const rangeUrl = `${peer.coordinatorUrl}/stats/ledger/range?sinceIssuedAtMs=${encodeURIComponent(String(sinceIssuedAtMs))}&limit=1000`;
    const rangeRes = await request(
      rangeUrl,
      {
        method: "GET",
        headers: peerRequestHeaders("GET", rangeUrl),
        headersTimeout: 15_000,
        bodyTimeout: 15_000,
      }
    );
    if (rangeRes.statusCode < 200 || rangeRes.statusCode >= 300) {
      await rangeRes.body.text().catch(() => "");
      return;
    }
    const payload = (await rangeRes.body.json()) as { records?: QueueEventRecord[] };
    if (!Array.isArray(payload.records) || payload.records.length === 0) return;
    await ingestStatsLedgerRecords(payload.records);
  } catch {
    // Best effort sync.
  }
}
