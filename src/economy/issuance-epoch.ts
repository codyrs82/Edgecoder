// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

// One issuance epoch per window across every coordinator seed sharing a database. The window is
// aligned to the recalc interval, so all seeds agree on it; the epoch id is derived from the window,
// so a second seed (or a restart) finds the existing epoch instead of starting a parallel series.

import type { IssuanceAllocationRecord, IssuanceEpochRecord } from "../common/types.js";

export interface IssuanceWindow {
  windowStartMs: number;
  windowEndMs: number;
}

/** The latest completed window boundary at or before nowMs: the same for every seed. */
export function issuanceWindow(nowMs: number, recalcMs: number, windowMs: number): IssuanceWindow {
  const step = Math.max(1, Math.floor(recalcMs));
  const windowEndMs = Math.floor(nowMs / step) * step;
  return { windowStartMs: windowEndMs - Math.max(1, Math.floor(windowMs)), windowEndMs };
}

/** Deterministic epoch id for a window. `namespace` keeps distinct networks apart. */
export function issuanceEpochIdFor(window: IssuanceWindow, namespace = "edgecoder"): string {
  return `iss:${namespace}:${window.windowStartMs}-${window.windowEndMs}`;
}

/** Deterministic allocation id: one row per account per epoch, however often it is written. */
export function issuanceAllocationIdFor(epochId: string, accountId: string): string {
  return `${epochId}:${accountId}`;
}

export interface IssuanceEpochStore {
  withIssuanceLock<T>(fn: () => Promise<T>): Promise<T>;
  getIssuanceEpoch(issuanceEpochId: string): Promise<IssuanceEpochRecord | null>;
  createIssuanceEpoch(record: IssuanceEpochRecord, allocations: IssuanceAllocationRecord[]): Promise<boolean>;
  listIssuanceAllocations(issuanceEpochId: string): Promise<IssuanceAllocationRecord[]>;
}

export type IssuanceEpochDraft = Omit<IssuanceEpochRecord, "issuanceEpochId" | "windowStartMs" | "windowEndMs" | "finalized">;
export type IssuanceAllocationDraft = Pick<IssuanceAllocationRecord, "accountId" | "weightedContribution" | "allocationShare" | "issuedTokens">;

export interface EnsureIssuanceEpochResult {
  epoch?: IssuanceEpochRecord;
  allocations: IssuanceAllocationRecord[];
  /** True only for the seed (and run) that wrote this window's epoch. */
  created: boolean;
}

/**
 * Under the shared issuance lock: return this window's epoch if any seed already wrote it,
 * otherwise compute it (compute returns null when there is nothing to issue) and write it with its
 * allocations exactly once. `afterEpoch` also runs under the lock (quorum records, finalization).
 */
export async function ensureIssuanceEpoch(input: {
  store: IssuanceEpochStore;
  nowMs: number;
  recalcMs: number;
  windowMs: number;
  namespace?: string;
  compute: (window: IssuanceWindow) => Promise<{ epoch: IssuanceEpochDraft; allocations: IssuanceAllocationDraft[] } | null>;
  afterEpoch?: (result: EnsureIssuanceEpochResult & { epoch: IssuanceEpochRecord }) => Promise<IssuanceEpochRecord | void>;
}): Promise<EnsureIssuanceEpochResult> {
  const { store } = input;
  const window = issuanceWindow(input.nowMs, input.recalcMs, input.windowMs);
  const epochId = issuanceEpochIdFor(window, input.namespace);
  return store.withIssuanceLock(async () => {
    let result: EnsureIssuanceEpochResult;
    const existing = await store.getIssuanceEpoch(epochId);
    if (existing) {
      result = { epoch: existing, allocations: await store.listIssuanceAllocations(epochId), created: false };
    } else {
      const computed = await input.compute(window);
      if (!computed) return { allocations: [], created: false };
      const epoch: IssuanceEpochRecord = { ...computed.epoch, ...window, issuanceEpochId: epochId, finalized: false };
      const allocations: IssuanceAllocationRecord[] = computed.allocations.map((item) => ({
        ...item,
        allocationId: issuanceAllocationIdFor(epochId, item.accountId),
        issuanceEpochId: epochId,
        createdAtMs: epoch.createdAtMs
      }));
      const created = await store.createIssuanceEpoch(epoch, allocations);
      result = created
        ? { epoch, allocations, created: true }
        : {
            epoch: (await store.getIssuanceEpoch(epochId)) ?? epoch,
            allocations: await store.listIssuanceAllocations(epochId),
            created: false
          };
    }
    const updated = await input.afterEpoch?.(result as EnsureIssuanceEpochResult & { epoch: IssuanceEpochRecord });
    return updated ? { ...result, epoch: updated } : result;
  });
}
