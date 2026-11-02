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
 * Model-size multiplier on the per-second rate. A second of a 30B model is worth more than a
 * second of a 2B model because it needs far more memory and a stronger machine, and because
 * the requester would pay far more for it anywhere else. Plain code execution (no model) is 1.0.
 *   <= 3B: 1.0   <= 10B: 1.5   <= 35B: 2.5   > 35B: 4.0
 */
export function modelSizeMultiplier(modelParamSizeB: number | undefined): number {
  const b = Number.isFinite(modelParamSizeB) ? (modelParamSizeB as number) : 0;
  if (b <= 3) return 1.0;
  if (b <= 10) return 1.5;
  if (b <= 35) return 2.5;
  return 4.0;
}

/** Credits per second for a compute class and model size (before quality and load). */
export function creditRatePerSecond(resourceClass: ResourceClass, modelParamSizeB?: number): number {
  return baseRatePerSecond(resourceClass) * modelSizeMultiplier(modelParamSizeB);
}

/**
 * Credits reserved from the requester at submit time: the expected run time at the task's rate
 * (`expectedSeconds` capped by the subtask timeout), minimum 1. Reconciled against actual
 * usage when results come in; unused reserve is refunded.
 */
export function estimateReserveCredits(input: {
  resourceClass: ResourceClass;
  modelParamSizeB?: number;
  timeoutMs: number;
  expectedSeconds: number;
  subtaskCount: number;
}): number {
  const perSubtaskSeconds = Math.max(1, Math.min(input.expectedSeconds, input.timeoutMs > 0 ? input.timeoutMs / 1000 : input.expectedSeconds));
  const credits = perSubtaskSeconds * creditRatePerSecond(input.resourceClass, input.modelParamSizeB) * Math.max(1, input.subtaskCount);
  return Math.max(1, Number(credits.toFixed(3)));
}

/**
 * #38: the one formula for compute credits, used for both the balance and the
 * earnings_accrual ledger payload. Failed results earn 0. `cpuSeconds`/`gpuSeconds`
 * must be server-measured (coordinator: creditedDurationMs, #44), never self-reported.
 */
export function contributionCredits(
  report: { resourceClass: ResourceClass; cpuSeconds: number; gpuSeconds: number; qualityScore: number; success: boolean; modelParamSizeB?: number },
  load: LoadSnapshot
): number {
  if (!report.success) return 0;
  const seconds = report.resourceClass === "gpu" ? report.gpuSeconds : report.cpuSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const quality = Math.max(0.5, Math.min(1.5, Number.isFinite(report.qualityScore) ? report.qualityScore : 1));
  return Number((seconds * creditRatePerSecond(report.resourceClass, report.modelParamSizeB) * quality * loadMultiplier(load)).toFixed(3));
}

/** Split gross credits into the worker's share and the network fee (basis points) that funds infrastructure hosts. */
export function splitNetworkFee(grossCredits: number, feeBps: number): { worker: number; fee: number } {
  const bps = Math.max(0, Math.min(10_000, Math.floor(feeBps)));
  const fee = Number(((grossCredits * bps) / 10_000).toFixed(6));
  return { worker: Number((grossCredits - fee).toFixed(6)), fee };
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
