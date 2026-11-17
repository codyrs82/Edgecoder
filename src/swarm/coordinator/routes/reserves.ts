// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * GET /economy/reserves: public, unauthenticated proof of reserves (src/economy/proof-of-reserves.ts,
 * docs/decentralization.md). Aggregate numbers only. Computed at most once per RESERVES_CACHE_MS
 * (default 60 s) and limited to RESERVES_RATE_LIMIT_PER_MIN requests per client IP per minute
 * (the portal, which caches the report itself, is not limited). Read-only: the node is asked for
 * its balances, nothing else.
 */
import { pgStore } from "../../../db/store.js";
import { creditEngine, NETWORK_FEE_POOL_ACCOUNT } from "../../../credits/store.js";
import { describeAnchor } from "../../../economy/anchor-status.js";
import {
  createFixedWindowLimiter,
  createReservesCache,
  readReservesReport,
  reservesCacheMsFromEnv,
  reservesRateLimitFromEnv,
  type ReserveLiabilitiesMsat
} from "../../../economy/proof-of-reserves.js";
import type { CoordinatorApp } from "../app.js";
import { ANCHOR_REQUIRED_CONFIRMATIONS, BITCOIN_NETWORK, requestOrigin } from "../context.js";
import { hasPortalServiceToken } from "../auth.js";
import { lightningProvider } from "../payouts.js";
import { currentAnchoringStatus } from "../stats-ledger.js";

/** Memory mode (no database): the engine's balances and the pool's sats; no task billing to read. */
function memoryLiabilities(): ReserveLiabilitiesMsat {
  const pool = creditEngine
    .history(NETWORK_FEE_POOL_ACCOUNT)
    .reduce((sum, tx) => sum + (tx.type === "spend" ? -1 : 1) * Math.floor(tx.msat ?? 0), 0);
  return {
    accountBalancesMsat: Math.round(creditEngine.positiveBalancesMicros(NETWORK_FEE_POOL_ACCOUNT) / 1000),
    feePoolMsat: Math.max(0, pool),
    heldForJobsMsat: 0
  };
}

export function registerReservesRoutes(app: CoordinatorApp): void {
  const cacheMs = reservesCacheMsFromEnv();
  const limiter = createFixedWindowLimiter({ max: reservesRateLimitFromEnv(), windowMs: 60_000 });
  const report = createReservesCache(
    () =>
      readReservesReport(
        {
          network: BITCOIN_NETWORK,
          liabilities: async () => (pgStore ? pgStore.reserveLiabilitiesMsat(NETWORK_FEE_POOL_ACCOUNT) : memoryLiabilities()),
          balances: async () => (lightningProvider.getBalances ? lightningProvider.getBalances() : { supported: false, reason: "unsupported" }),
          latestAnchor: async () => {
            const a = await pgStore?.latestAnchor();
            return a ? describeAnchor(a, ANCHOR_REQUIRED_CONFIRMATIONS) : null;
          },
          anchoring: () => currentAnchoringStatus().mode,
          onError: (side, err) => app.log.warn({ side, err: err instanceof Error ? err.message : String(err) }, "proof_of_reserves_unavailable")
        },
        cacheMs
      ),
    { ttlMs: cacheMs }
  );

  app.get("/economy/reserves", async (req, reply) => {
    if (!hasPortalServiceToken((req as any).headers ?? {})) {
      const ip = requestOrigin(req).clientIp ?? "unknown";
      const allowed = limiter.take(ip);
      if (!allowed.ok) return reply.code(429).header("retry-after", String(allowed.retryAfterSeconds)).send({ error: "rate_limited", retryAfterSeconds: allowed.retryAfterSeconds });
    }
    const body = await report();
    return reply
      .header("cache-control", `public, max-age=${Math.max(1, Math.round(cacheMs / 1000))}`)
      .header("access-control-allow-origin", "*")
      .send(body);
  });
}
