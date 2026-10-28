// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { ResourceClass } from "../common/types.js";

export interface LoadSnapshot {
  queuedTasks: number;
  activeAgents: number;
}

export function loadMultiplier(load: LoadSnapshot): number {
  const pressure = load.activeAgents === 0 ? 2 : load.queuedTasks / load.activeAgents;
  if (pressure <= 0.5) return 0.8;
  if (pressure <= 1.0) return 1.0;
  if (pressure <= 2.0) return 1.25;
  return 1.6;
}

export function baseRatePerSecond(resourceClass: ResourceClass): number {
  return resourceClass === "gpu" ? 4.0 : 1.0;
}

/**
 * #38: the one formula for compute credits, used for both the balance and the
 * earnings_accrual ledger payload. Failed results earn 0. `cpuSeconds`/`gpuSeconds`
 * must be server-measured (coordinator: creditedDurationMs, #44), never self-reported.
 */
export function contributionCredits(
  report: { resourceClass: ResourceClass; cpuSeconds: number; gpuSeconds: number; qualityScore: number; success: boolean },
  load: LoadSnapshot
): number {
  if (!report.success) return 0;
  const seconds = report.resourceClass === "gpu" ? report.gpuSeconds : report.cpuSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const quality = Math.max(0.5, Math.min(1.5, Number.isFinite(report.qualityScore) ? report.qualityScore : 1));
  return Number((seconds * baseRatePerSecond(report.resourceClass) * quality * loadMultiplier(load)).toFixed(3));
}

/**
 * Compute credits earned for seeding a model to a peer.
 * @param fileSizeBytes Size of the model file transferred
 * @param seederCount Number of active seeders for this model (rarity factor)
 * @returns Credits earned
 */
export function modelSeedCredits(fileSizeBytes: number, seederCount: number): number {
  const sizeGB = fileSizeBytes / 1e9;
  const baseCredits = sizeGB * 0.5;
  const rarityMultiplier = 1 / Math.max(1, seederCount);
  return Number((baseCredits * (1 + rarityMultiplier)).toFixed(3));
}

/**
 * Credit cost for a swarm request based on model parameter count.
 * @param paramSizeB Model size in billions of parameters (e.g. 7 for a 7B model)
 * @returns Credits to charge the requester (minimum 0.5)
 */
export function modelCostCredits(paramSizeB: number): number {
  return Math.max(0.5, paramSizeB);
}
