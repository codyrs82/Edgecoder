// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { WorkReceipt } from "./receipt.js";

/** One closed Merkle epoch of a coordinator's receipts (see epochs.ts). */
export interface ReceiptEpoch {
  /** sha256 of the signed body: deterministic for a given (coordinator, window, root, previousRoot). */
  epochId: string;
  coordinatorId: string;
  /** Window the epoch covers; late receipts (finished before fromMs but stored after the previous close) are swept in too. */
  fromMs: number;
  toMs: number;
  count: number;
  merkleRoot: string;
  /** merkleRoot of this coordinator's previous epoch, or null for the first one: epochs form a chain. */
  previousRoot: string | null;
  closedAtMs: number;
  /** Coordinator Ed25519 signature over the canonical epoch body. */
  signature: string;
  /** Bitcoin txid once anchored (see anchorEpoch). */
  anchorTxRef?: string;
  anchorNetwork?: string;
}

export interface ReceiptPage {
  receipts: WorkReceipt[];
  /** Opaque cursor to pass back to listSince; equals the input cursor when nothing new was returned. */
  nextCursor: string;
}

export interface ReceiptStore {
  /** Idempotent by receiptId: resolves true when stored, false when it already existed. */
  append(receipt: WorkReceipt): Promise<boolean>;
  get(receiptId: string): Promise<WorkReceipt | null>;
  /** Receipts stored after `cursor` ("" or null = from the beginning) in storage order. */
  listSince(cursor: string | null, limit?: number): Promise<ReceiptPage>;
  /** This coordinator's receipts not yet assigned to an epoch, finished before `untilMs`. */
  listUnassigned(coordinatorId: string, untilMs: number, limit?: number): Promise<WorkReceipt[]>;
  listByEpoch(epochId: string): Promise<WorkReceipt[]>;
  /** Epoch a receipt was closed into, if any. */
  epochIdForReceipt(receiptId: string): Promise<string | null>;
  latestEpoch(coordinatorId: string): Promise<ReceiptEpoch | null>;
  getEpoch(epochId: string): Promise<ReceiptEpoch | null>;
  /** Upsert the epoch and (when receiptIds is given) mark those receipts as belonging to it. */
  persistEpoch(epoch: ReceiptEpoch, receiptIds?: string[]): Promise<void>;
}

export const DEFAULT_PAGE_LIMIT = 200;
export const MAX_PAGE_LIMIT = 1000;

export function clampLimit(limit: number | undefined, fallback = DEFAULT_PAGE_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(limit)));
}

/** Cursor is the storage sequence number as a decimal string; anything unparsable means "from the start". */
export function parseCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const n = Number(cursor);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export class MemoryReceiptStore implements ReceiptStore {
  private readonly byId = new Map<string, { seq: number; receipt: WorkReceipt; epochId: string | null }>();
  private readonly ordered: string[] = [];
  private readonly epochs = new Map<string, ReceiptEpoch>();
  private seq = 0;

  async append(receipt: WorkReceipt): Promise<boolean> {
    if (this.byId.has(receipt.receiptId)) return false;
    this.seq += 1;
    this.byId.set(receipt.receiptId, { seq: this.seq, receipt: { ...receipt }, epochId: null });
    this.ordered.push(receipt.receiptId);
    return true;
  }

  async get(receiptId: string): Promise<WorkReceipt | null> {
    const row = this.byId.get(receiptId);
    return row ? { ...row.receipt } : null;
  }

  async listSince(cursor: string | null, limit?: number): Promise<ReceiptPage> {
    const after = parseCursor(cursor);
    const max = clampLimit(limit);
    const receipts: WorkReceipt[] = [];
    let last = after;
    // ordered[] is in seq order and seq starts at 1, so the first candidate index is `after`.
    for (let i = after; i < this.ordered.length && receipts.length < max; i += 1) {
      const row = this.byId.get(this.ordered[i])!;
      receipts.push({ ...row.receipt });
      last = row.seq;
    }
    return { receipts, nextCursor: String(last) };
  }

  async listUnassigned(coordinatorId: string, untilMs: number, limit?: number): Promise<WorkReceipt[]> {
    const max = clampLimit(limit, MAX_PAGE_LIMIT * 10);
    const out: WorkReceipt[] = [];
    for (const id of this.ordered) {
      const row = this.byId.get(id)!;
      if (row.epochId !== null) continue;
      if (row.receipt.coordinatorId !== coordinatorId || row.receipt.finishedAtMs >= untilMs) continue;
      out.push({ ...row.receipt });
      if (out.length >= max) break;
    }
    return out;
  }

  async listByEpoch(epochId: string): Promise<WorkReceipt[]> {
    return this.ordered
      .map((id) => this.byId.get(id)!)
      .filter((row) => row.epochId === epochId)
      .map((row) => ({ ...row.receipt }));
  }

  async epochIdForReceipt(receiptId: string): Promise<string | null> {
    return this.byId.get(receiptId)?.epochId ?? null;
  }

  async latestEpoch(coordinatorId: string): Promise<ReceiptEpoch | null> {
    let latest: ReceiptEpoch | null = null;
    for (const epoch of this.epochs.values()) {
      if (epoch.coordinatorId !== coordinatorId) continue;
      if (!latest || epoch.toMs > latest.toMs || (epoch.toMs === latest.toMs && epoch.closedAtMs > latest.closedAtMs)) {
        latest = epoch;
      }
    }
    return latest ? { ...latest } : null;
  }

  async getEpoch(epochId: string): Promise<ReceiptEpoch | null> {
    const epoch = this.epochs.get(epochId);
    return epoch ? { ...epoch } : null;
  }

  async persistEpoch(epoch: ReceiptEpoch, receiptIds?: string[]): Promise<void> {
    this.epochs.set(epoch.epochId, { ...epoch });
    for (const id of receiptIds ?? []) {
      const row = this.byId.get(id);
      if (row) row.epochId = epoch.epochId;
    }
  }

  /** Test helper. */
  size(): number {
    return this.byId.size;
  }
}
