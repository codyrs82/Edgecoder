// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import type { BitcoinAnchorRecord, BitcoinNetwork } from "../common/types.js";
import {
  encodeCheckpointForOpReturn,
  type AnchorConfirmationResult,
  type BitcoinAnchorProvider
} from "./bitcoin-rpc.js";

/**
 * #46: real ledger anchoring.
 *   broadcast OP_RETURN -> record { txRef: <txid>, status: "pending" }
 *   -> poll confirmations -> "anchored" once >= required
 *   -> a later check that finds the tx unconfirmed or in a different block (reorg) -> back to "pending".
 */

export const DEFAULT_REQUIRED_CONFIRMATIONS = 6;

export function requiredConfirmationsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  key = "BITCOIN_ANCHOR_CONFIRMATIONS",
  fallback = DEFAULT_REQUIRED_CONFIRMATIONS
): number {
  const n = Number(env[key]);
  return env[key] !== undefined && env[key] !== "" && Number.isInteger(n) && n >= 1 ? n : fallback;
}

export interface AnchorStore {
  upsertBitcoinAnchor(record: BitcoinAnchorRecord): Promise<void>;
  latestAnchorByCheckpoint(checkpointHash: string): Promise<BitcoinAnchorRecord | null>;
  listPendingAnchors(limit?: number): Promise<BitcoinAnchorRecord[]>;
  /** Cross-instance lock for one checkpoint (Postgres advisory lock). */
  withCheckpointLock?<T>(checkpointHash: string, fn: () => Promise<T>): Promise<T>;
  /** Broadcast attempts (real txids or in-flight "broadcasting" rows) created since `sinceMs`. */
  countAnchorBroadcastsSince?(sinceMs: number): Promise<number>;
}

/** #46 review: spend guards. Every broadcast can cost up to `maxFeeSats`. */
export interface AnchorPolicy {
  /** Daily budget in sats; a broadcast is refused when (broadcasts in the last 24h + 1) x maxFeeSats would exceed it. */
  dailyBudgetSats: number;
  maxFeeSats: number;
  /** Mainnet broadcasts need an explicit opt-in (BITCOIN_ANCHOR_MAINNET=1). */
  mainnetEnabled: boolean;
}

export function anchorPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): AnchorPolicy {
  const pos = (v: string | undefined, d: number) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
  };
  return {
    // 200k sats/day = 10 anchors/day at the default 20k-sat fee cap.
    dailyBudgetSats: pos(env.BITCOIN_ANCHOR_DAILY_BUDGET_SATS, 200_000),
    maxFeeSats: pos(env.BITCOIN_ANCHOR_MAX_FEE_SATS, 20_000),
    mainnetEnabled: env.BITCOIN_ANCHOR_MAINNET === "1"
  };
}

export interface AnchorDeps {
  provider: BitcoinAnchorProvider;
  store: AnchorStore;
  network: BitcoinNetwork;
  now?: () => number;
  /** Defaults to anchorPolicyFromEnv(). */
  policy?: AnchorPolicy;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** In-process serialisation per checkpoint (covers startup calls overlapping interval ticks). */
const localLocks = new Map<string, Promise<unknown>>();
/** Fallback broadcast log for stores without countAnchorBroadcastsSince. */
const localBroadcastTimes: number[] = [];

async function withLocalLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = localLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  localLocks.set(key, chained);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (localLocks.get(key) === chained) localLocks.delete(key);
  }
}

const TXID_RE = /^[0-9a-f]{64}$/;

/** A real Bitcoin txid (legacy simulated rows used `anchor:<net>:<hash>` / `stats-anchor:...`). */
export function isTxid(value: string | undefined): value is string {
  return typeof value === "string" && TXID_RE.test(value);
}

/**
 * Anchor a checkpoint unless it already has a real (pending or anchored) anchor.
 * Legacy simulated rows for the same checkpoint are replaced by a real broadcast.
 *
 * #46 review: at most one broadcast per checkpoint. The read-check-broadcast-write
 * runs under an in-process lock plus the store's cross-instance lock, and a
 * "broadcasting" row is written before the broadcast so a crash after
 * sendrawtransaction leaves a row to reconcile instead of a silent second spend.
 * A "broadcasting" row is never re-broadcast automatically.
 */
export async function anchorCheckpoint(
  deps: AnchorDeps,
  input: { epochId: string; checkpointHash: string }
): Promise<BitcoinAnchorRecord> {
  const run = () => anchorCheckpointLocked(deps, input);
  return withLocalLock(input.checkpointHash, () =>
    deps.store.withCheckpointLock ? deps.store.withCheckpointLock(input.checkpointHash, run) : run()
  );
}

async function anchorCheckpointLocked(
  deps: AnchorDeps,
  input: { epochId: string; checkpointHash: string }
): Promise<BitcoinAnchorRecord> {
  const now = deps.now ?? Date.now;
  const policy = deps.policy ?? anchorPolicyFromEnv();
  const existing = await deps.store.latestAnchorByCheckpoint(input.checkpointHash);
  if (existing && existing.status !== "failed" && isTxid(existing.txRef)) return existing;
  if (existing?.status === "broadcasting") {
    throw new Error(`anchor_broadcast_unreconciled:${existing.anchorId}`);
  }

  if (deps.network === "bitcoin" && !policy.mainnetEnabled) {
    throw new Error("anchor_mainnet_not_enabled: set BITCOIN_ANCHOR_MAINNET=1 to broadcast on mainnet");
  }
  const since = now() - DAY_MS;
  const recent = deps.store.countAnchorBroadcastsSince
    ? await deps.store.countAnchorBroadcastsSince(since)
    : localBroadcastTimes.filter((t) => t >= since).length;
  if ((recent + 1) * policy.maxFeeSats > policy.dailyBudgetSats) {
    throw new Error(`anchor_daily_budget_exceeded: ${recent} broadcasts in 24h x ${policy.maxFeeSats} sats, budget ${policy.dailyBudgetSats}`);
  }

  const base: BitcoinAnchorRecord = {
    anchorId: existing?.anchorId ?? randomUUID(),
    epochId: input.epochId,
    checkpointHash: input.checkpointHash,
    anchorNetwork: deps.network,
    txRef: `broadcasting:${randomUUID()}`,
    status: "broadcasting",
    anchoredAtMs: undefined,
    createdAtMs: now(),
    confirmations: 0,
    blockHash: undefined,
    blockHeight: undefined,
    lastCheckedAtMs: now()
  };
  await deps.store.upsertBitcoinAnchor(base);
  if (!deps.store.countAnchorBroadcastsSince) localBroadcastTimes.push(base.createdAtMs);

  const dataHex = encodeCheckpointForOpReturn(input.checkpointHash);
  let txid: string;
  try {
    ({ txid } = await deps.provider.broadcastOpReturn(dataHex));
  } catch (err) {
    // The provider reported failure: mark failed so a later tick may retry.
    await deps.store.upsertBitcoinAnchor({ ...base, status: "failed", lastCheckedAtMs: now() });
    throw err;
  }
  const normalized = String(txid ?? "").toLowerCase();
  if (!isTxid(normalized)) {
    // Something may have been sent; leave the "broadcasting" row for manual reconciliation.
    throw new Error(`anchor_broadcast_invalid_txid:${String(txid).slice(0, 80)}`);
  }

  const record: BitcoinAnchorRecord = { ...base, txRef: normalized, status: "pending", lastCheckedAtMs: now() };
  await deps.store.upsertBitcoinAnchor(record);
  return record;
}

export type ConfirmationEvent = "confirmed" | "progress" | "reorg" | "unchanged" | "unknown" | "conflicted";

/** Pure state transition for one confirmation check. */
export function applyConfirmation(
  record: BitcoinAnchorRecord,
  conf: AnchorConfirmationResult,
  required: number,
  nowMs: number
): { record: BitcoinAnchorRecord; event: ConfirmationEvent } {
  if (record.status === "failed" || !isTxid(record.txRef)) return { record, event: "unchanged" };
  // bitcoind reports negative confirmations for a tx conflicted by another (e.g. RBF
  // replacement): it will never confirm, so mark it failed and let a later tick re-anchor.
  if (Number.isFinite(conf.confirmations) && conf.confirmations < 0) {
    return {
      event: "conflicted",
      record: { ...record, status: "failed", anchoredAtMs: undefined, confirmations: 0, lastCheckedAtMs: nowMs }
    };
  }
  const confirmations = conf.confirmed ? Math.max(0, Math.floor(conf.confirmations || 0)) : 0;
  const base = { ...record, lastCheckedAtMs: nowMs };

  const reorged =
    Boolean(record.blockHash) && (!conf.confirmed || (Boolean(conf.blockHash) && conf.blockHash !== record.blockHash));
  if (reorged) {
    return {
      event: "reorg",
      record: {
        ...base,
        status: "pending",
        anchoredAtMs: undefined,
        confirmations,
        blockHash: conf.confirmed ? conf.blockHash : undefined,
        blockHeight: conf.confirmed ? conf.blockHeight : undefined
      }
    };
  }

  const blockHash = conf.confirmed ? conf.blockHash ?? record.blockHash : undefined;
  const blockHeight = conf.confirmed ? conf.blockHeight ?? record.blockHeight : undefined;
  if (conf.confirmed && confirmations >= required) {
    const wasAnchored = record.status === "anchored";
    return {
      event: wasAnchored && record.confirmations === confirmations ? "unchanged" : wasAnchored ? "progress" : "confirmed",
      record: {
        ...base,
        status: "anchored",
        anchoredAtMs: record.anchoredAtMs ?? nowMs,
        confirmations,
        blockHash,
        blockHeight
      }
    };
  }
  return {
    event: confirmations !== (record.confirmations ?? 0) ? "progress" : "unchanged",
    record: { ...base, status: "pending", anchoredAtMs: undefined, confirmations, blockHash, blockHeight }
  };
}

export async function refreshAnchor(
  deps: AnchorDeps,
  record: BitcoinAnchorRecord,
  required: number
): Promise<{ record: BitcoinAnchorRecord; event: ConfirmationEvent }> {
  if (!isTxid(record.txRef) || record.status === "failed") return { record, event: "unchanged" };
  let conf: AnchorConfirmationResult;
  try {
    conf = await deps.provider.getConfirmations(record.txRef);
  } catch {
    // #46 review: node unreachable / RPC or auth error is not "left the chain".
    // Keep the last known state and don't write anything.
    return { record, event: "unknown" };
  }
  const next = applyConfirmation(record, conf, required, (deps.now ?? Date.now)());
  await deps.store.upsertBitcoinAnchor(next.record);
  return next;
}

/** Refresh every pending anchor plus the given recent anchored ones (reorg re-verification). */
export async function refreshAnchors(
  deps: AnchorDeps,
  required: number,
  alsoRecheck: Array<BitcoinAnchorRecord | null | undefined> = []
): Promise<Array<{ anchorId: string; event: ConfirmationEvent }>> {
  const pending = await deps.store.listPendingAnchors(50);
  const seen = new Set<string>();
  const out: Array<{ anchorId: string; event: ConfirmationEvent }> = [];
  for (const rec of [...pending, ...alsoRecheck]) {
    if (!rec || seen.has(rec.anchorId)) continue;
    seen.add(rec.anchorId);
    const { event } = await refreshAnchor(deps, rec, required);
    out.push({ anchorId: rec.anchorId, event });
  }
  return out;
}
