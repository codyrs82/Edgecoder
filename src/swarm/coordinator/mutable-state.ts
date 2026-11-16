// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Coordinator values that are reassigned at runtime and used by more than one module.
 *
 * An imported binding cannot be assigned to, so these live as properties of one object:
 * read and write them as `mutable.<name>`. Values that only one module reassigns stay
 * private `let`s in that module.
 */
import type { TreasuryPolicy } from "../../common/types.js";
import type { RateEpoch } from "../../economy/rate-oracle.js";
import { PROVIDER } from "./context.js";

export const mutable = {
  coordinatorProvider: PROVIDER,
  blacklistVersion: 0,
  lastBlacklistEventHash: "BLACKLIST_GENESIS",
  latestRateEpoch: null as RateEpoch | null,
  lastFeePoolDistribution: null as { atMs: number; distributedMsat: number; hosts: number } | null,
  treasuryPolicy: null as TreasuryPolicy | null,
  /*
   * #105: held verifications and per-account reputation are mirrored to Postgres. Writes run in
   * order on one chain (a held row is never re-saved after its delete); /result and the expiry
   * tick wait for it, so what they acknowledged survives a restart. Reputation is shared by both
   * seeds: deltas are applied atomically in the database and the stored value refreshes the cache.
   */
  verificationWrites: Promise.resolve() as Promise<void>
};
