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
}

export interface AnchorDeps {
  provider: BitcoinAnchorProvider;
  store: AnchorStore;
  network: BitcoinNetwork;
  now?: () => number;
}

const TXID_RE = /^[0-9a-f]{64}$/;

/** A real Bitcoin txid (legacy simulated rows used `anchor:<net>:<hash>` / `stats-anchor:...`). */
export function isTxid(value: string | undefined): value is string {
  return typeof value === "string" && TXID_RE.test(value);
}

/**
 * Anchor a checkpoint unless it already has a real (pending or anchored) anchor.
 * Legacy simulated rows for the same checkpoint are replaced by a real broadcast.
 */
export async function anchorCheckpoint(
  deps: AnchorDeps,
  input: { epochId: string; checkpointHash: string }
): Promise<BitcoinAnchorRecord> {
  const now = deps.now ?? Date.now;
  const existing = await deps.store.latestAnchorByCheckpoint(input.checkpointHash);
  if (existing && existing.status !== "failed" && isTxid(existing.txRef)) return existing;

  const dataHex = encodeCheckpointForOpReturn(input.checkpointHash);
  const { txid } = await deps.provider.broadcastOpReturn(dataHex);
  const normalized = String(txid ?? "").toLowerCase();
  if (!isTxid(normalized)) throw new Error(`anchor_broadcast_invalid_txid:${String(txid).slice(0, 80)}`);

  const record: BitcoinAnchorRecord = {
    anchorId: existing?.anchorId ?? randomUUID(),
    epochId: input.epochId,
    checkpointHash: input.checkpointHash,
    anchorNetwork: deps.network,
    txRef: normalized,
    status: "pending",
    anchoredAtMs: undefined,
    createdAtMs: existing?.createdAtMs ?? now(),
    confirmations: 0,
    blockHash: undefined,
    blockHeight: undefined,
    lastCheckedAtMs: now()
  };
  await deps.store.upsertBitcoinAnchor(record);
  return record;
}

export type ConfirmationEvent = "confirmed" | "progress" | "reorg" | "unchanged";

/** Pure state transition for one confirmation check. */
export function applyConfirmation(
  record: BitcoinAnchorRecord,
  conf: AnchorConfirmationResult,
  required: number,
  nowMs: number
): { record: BitcoinAnchorRecord; event: ConfirmationEvent } {
  if (record.status === "failed" || !isTxid(record.txRef)) return { record, event: "unchanged" };
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
  const conf = await deps.provider.getConfirmations(record.txRef);
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
