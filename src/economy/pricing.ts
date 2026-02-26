// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { ResourceClass } from "../common/types.js";

export interface DynamicPriceInputs {
  cpuCapacity: number;
  gpuCapacity: number;
  queuedTasks: number;
  activeAgents: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function computeDynamicPricePerComputeUnitSats(
  resourceClass: ResourceClass,
  inputs: DynamicPriceInputs
): number {
  const capacity = resourceClass === "gpu" ? Math.max(1, inputs.gpuCapacity) : Math.max(1, inputs.cpuCapacity);
  const demand = Math.max(1, inputs.queuedTasks + inputs.activeAgents);
  const scarcity = demand / capacity;
  const base = resourceClass === "gpu" ? 120 : 30;
  const multiplier = clamp(0.65 + scarcity * 0.35, 0.35, 4.0);
  return Math.max(1, Math.round(base * multiplier));
}

export function creditsForSats(netSats: number, satsPerCredit: number): number {
  if (satsPerCredit <= 0) return 0;
  return Number((netSats / satsPerCredit).toFixed(3));
}

export function satsForCredits(credits: number, satsPerCredit: number): number {
  if (satsPerCredit <= 0 || credits <= 0) return 0;
  return Math.floor(credits * satsPerCredit);
}
