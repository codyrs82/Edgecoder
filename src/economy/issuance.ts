// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { RollingContributionShare } from "../common/types.js";

export interface IssuancePoolConfig {
  baseDailyPoolTokens: number;
  minDailyPoolTokens: number;
  maxDailyPoolTokens: number;
  loadCurveSlope: number;
  smoothingAlpha: number;
}

export interface LoadInputs {
  queuedTasks: number;
  activeAgents: number;
  cpuCapacity: number;
  gpuCapacity: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeLoadIndex(inputs: LoadInputs): number {
  const capacity = Math.max(1, inputs.cpuCapacity + inputs.gpuCapacity * 2);
  const demand = Math.max(1, inputs.queuedTasks + inputs.activeAgents);
  const scarcity = demand / capacity;
  return Number(clamp(scarcity, 0.2, 6).toFixed(6));
}

export function smoothLoadIndex(previous: number | null, current: number, alpha: number): number {
  if (previous === null || !Number.isFinite(previous)) return current;
  const a = clamp(alpha, 0.01, 1);
  return Number((previous * (1 - a) + current * a).toFixed(6));
}

export function computeDailyPoolTokens(loadIndex: number, config: IssuancePoolConfig): number {
  const scaled = config.baseDailyPoolTokens * (1 + Math.max(0, loadIndex - 1) * config.loadCurveSlope);
  return Number(clamp(scaled, config.minDailyPoolTokens, config.maxDailyPoolTokens).toFixed(6));
}

export function computeHourlyIssuanceAllocations(
  shares: RollingContributionShare[],
  dailyPoolTokens: number
): Array<{ accountId: string; weightedContribution: number; allocationShare: number; issuedTokens: number }> {
  const totalWeighted = shares.reduce((sum, item) => sum + Math.max(0, item.weightedContribution), 0);
  const hourlyTokens = dailyPoolTokens / 24;
  if (totalWeighted <= 0 || hourlyTokens <= 0) return [];
  return shares
    .filter((item) => item.weightedContribution > 0)
    .map((item) => {
      const allocationShare = item.weightedContribution / totalWeighted;
      return {
        accountId: item.accountId,
        weightedContribution: Number(item.weightedContribution.toFixed(6)),
        allocationShare: Number(allocationShare.toFixed(9)),
        issuedTokens: Number((hourlyTokens * allocationShare).toFixed(6))
      };
    });
}
