// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { baseRatePerSecond } from "../../credits/pricing.js";
import { toMillis } from "../../credits/ble-tx-canonical.js";

/** Maps model param size to a credit quality multiplier */
export function modelQualityMultiplier(paramSize: number): number {
  if (paramSize >= 7) return 1.0;
  if (paramSize >= 3) return 0.7;
  if (paramSize >= 1.5) return 0.5;
  return 0.3;
}

/**
 * The one formula for offline BLE credits (requester computes it, provider
 * re-checks it before co-signing, #63): cpuSeconds * cpu base rate * model
 * quality multiplier, rounded to milli-credits.
 */
export function computeBleCredits(cpuSeconds: number, providerModelParamSize: number): number {
  return Number((cpuSeconds * baseRatePerSecond("cpu") * modelQualityMultiplier(providerModelParamSize)).toFixed(3));
}

/** computeBleCredits in integer milli-credits (what is actually signed). */
export function expectedBleCreditMillis(cpuSeconds: number, providerModelParamSize: number): number {
  return toMillis(computeBleCredits(cpuSeconds, providerModelParamSize));
}
