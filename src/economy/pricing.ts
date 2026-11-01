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

/**
 * Scarcity multiplier applied on top of the market rate (rate oracle): 1.0 at balanced load
 * (demand == capacity), 0.65 floor when idle, 4.0 cap under extreme demand.
 */
export function dynamicLoadMultiplier(resourceClass: ResourceClass, inputs: DynamicPriceInputs): number {
  const capacity = resourceClass === "gpu" ? Math.max(1, inputs.gpuCapacity) : Math.max(1, inputs.cpuCapacity);
  const demand = Math.max(1, inputs.queuedTasks + inputs.activeAgents);
  const scarcity = demand / capacity;
  return clamp(0.65 + scarcity * 0.35, 0.35, 4.0);
}

/** Legacy base prices (sats per compute unit) used before the rate oracle existed; kept for the mesh price-consensus protocol. */
export const LEGACY_BASE_SATS_PER_UNIT: Record<ResourceClass, number> = { cpu: 30, gpu: 120 };

export function computeDynamicPricePerComputeUnitSats(
  resourceClass: ResourceClass,
  inputs: DynamicPriceInputs
): number {
  const base = LEGACY_BASE_SATS_PER_UNIT[resourceClass];
  return Math.max(1, Math.round(base * dynamicLoadMultiplier(resourceClass, inputs)));
}

export function creditsForSats(netSats: number, satsPerCredit: number): number {
  if (satsPerCredit <= 0) return 0;
  return Number((netSats / satsPerCredit).toFixed(3));
}

export function satsForCredits(credits: number, satsPerCredit: number): number {
  if (satsPerCredit <= 0 || credits <= 0) return 0;
  return Math.floor(credits * satsPerCredit);
}
