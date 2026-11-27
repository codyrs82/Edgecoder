// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Market routes: order book, candles, trades, orders, classes and hardware verifications.
 */
import { z } from "zod";
import { pgStore } from "../../../db/store.js";
import {
  ACCEPTED_COMPUTE_CLASS_IDS,
  COMPUTE_CLASS_IDS,
  resolveRequestedClass,
  type ComputeClassId
} from "../../../economy/compute-classes.js";
import { CANDLE_INTERVALS, MarketHistory, type MarketOrder } from "../../../economy/market-history.js";
import type { CoordinatorApp } from "../app.js";
import { mutable } from "../mutable-state.js";
import { agentCapabilities } from "../agent-state.js";
import { requireMeshOrPortalToken, callerAccount, isPortalCaller } from "../auth.js";
import {
  orderBook,
  MARKET_DEFAULT_BID_PREMIUM_BPS,
  NETWORK_FEE_BPS,
  marketHistory,
  rateOracleConfig,
  applyMarketOrder,
  marketOrders,
  effectiveHardware,
  hardwareVerifier
} from "../economy.js";
import { classParam } from "../schemas.js";
import { ownerVerificationView } from "../../hardware-verification.js";
import { COORDINATOR_FEE_BPS } from "../context.js";

export function registerMarketRoutes(app: CoordinatorApp): void {
  app.get("/economy/market/book", async (req, reply) => {
    if (!requireMeshOrPortalToken(req, reply)) return;
    const query = z.object({ computeClass: classParam.optional() }).parse(req.query);
    const classes = query.computeClass ? [query.computeClass] : COMPUTE_CLASS_IDS;
    // Both fees, read-only, so the apps can show what a purchase and an earning keep back (docs/economy-math.md).
    return { books: classes.map((c) => orderBook.snapshot(c)), defaultBidPremiumBps: MARKET_DEFAULT_BID_PREMIUM_BPS, networkFeeBps: NETWORK_FEE_BPS, purchaseFeeBps: COORDINATOR_FEE_BPS };
  });

  /** Candles (OHLC of the mid, trade volume) for one class; `interval` 1m|5m|15m|1h|4h|1d. Portal-token readable. */
  app.get("/economy/market/candles", async (req, reply) => {
    if (!requireMeshOrPortalToken(req, reply)) return;
    const query = z
      .object({
        computeClass: classParam.default("cpu"),
        interval: z.enum(Object.keys(CANDLE_INTERVALS) as [string, ...string[]]).default("5m"),
        limit: z.coerce.number().int().min(1).max(2000).default(500)
      })
      .parse(req.query);
    return {
      computeClass: query.computeClass,
      interval: query.interval,
      candles: marketHistory.candles(query.computeClass, CANDLE_INTERVALS[query.interval], query.limit),
      latest: marketHistory.latest(query.computeClass) ?? null
    };
  });

  app.get("/economy/market/trades", async (req, reply) => {
    if (!requireMeshOrPortalToken(req, reply)) return;
    const query = z
      .object({ computeClass: classParam.default("cpu"), limit: z.coerce.number().int().min(1).max(500).default(50) })
      .parse(req.query);
    return { computeClass: query.computeClass, trades: marketHistory.recentTrades(query.computeClass, query.limit) };
  });

  app.get("/economy/market/depth", async (req, reply) => {
    if (!requireMeshOrPortalToken(req, reply)) return;
    const query = z.object({ computeClass: classParam.default("cpu") }).parse(req.query);
    const snap = orderBook.snapshot(query.computeClass);
    return { computeClass: query.computeClass, ...MarketHistory.depth(snap.asks, snap.bids), snapshot: snap };
  });

  /**
   * Standing orders from the portal. buy: the account's default max bid for its tasks (msat per
   * credit). sell: the ask applied to every agent the account owns (0 = track the reference).
   */
  app.post("/economy/market/orders", async (req, reply) => {
    // The portal names the account (it binds acct-<userId> from the session); an agent may set
    // orders only for its own linked account. The mesh token alone is not enough.
    const headers = ((req as any).headers ?? {}) as Record<string, unknown>;
    const requestedAccount = (req.body as { accountId?: unknown } | undefined)?.accountId;
    if (!isPortalCaller(headers)) {
      const caller = await callerAccount(req, "/economy/market/orders", typeof requestedAccount === "string" ? requestedAccount : undefined);
      if ("error" in caller) return reply.code(caller.status).send({ error: caller.error });
      if (caller.accountId !== requestedAccount) return reply.code(403).send({ error: "account_mismatch" });
    }
    const body = z
      .object({
        accountId: z.string().min(1).max(128),
        side: z.enum(["buy", "sell"]),
        computeClass: z.enum([...(ACCEPTED_COMPUTE_CLASS_IDS as [string, ...string[]]), "any"]).default("any"),
        msatPerCredit: z.number().min(0).max(1e9)
      })
      .parse(req.body);
    // A legacy class id maps onto its class and its price into the current unit (0 = track stays 0).
    const resolved = resolveRequestedClass(body.computeClass, body.msatPerCredit, {}, rateOracleConfig.computeClasses);
    const order: MarketOrder = { ...body, computeClass: resolved.computeClass as ComputeClassId | "any", msatPerCredit: resolved.msatPerCredit ?? 0, updatedAtMs: Date.now() };
    await applyMarketOrder(order);
    return { ok: true, order };
  });

  app.get("/economy/market/orders/:accountId", async (req, reply) => {
    if (!requireMeshOrPortalToken(req, reply)) return;
    const params = z.object({ accountId: z.string().min(1) }).parse(req.params);
    const orders = ["buy", "sell"].map((side) => marketOrders.get(`${params.accountId}:${side}`)).filter(Boolean);
    const owned = (await pgStore?.listAgentOwnershipByAccount(params.accountId)) ?? [];
    const agents = [...new Set([...owned.map((o) => o.agentId), params.accountId])]
      .map((agentId) => ({ agentId, capability: agentCapabilities.get(agentId), ask: orderBook.askFor(agentId) }))
      .filter((a) => a.capability)
      .map((a) => {
        // tier / weight are what the agent is paid at (the verified grant); claimedTier is what it reported.
        const eff = effectiveHardware(a.agentId, a.capability);
        return {
          agentId: a.agentId,
          computeClass: eff?.computeClass ?? a.capability!.computeClass,
          tier: eff?.tier ?? null,
          creditsPerSecond: eff?.creditsPerSecond ?? 1,
          claimedTier: a.capability!.hardwareClass?.tier ?? null,
          verification: hardwareVerifier.get(a.agentId)?.status ?? "unverified",
          // Why it is not verified and what (if anything) the owner can do: the portal explains it.
          verificationDetail: (() => { const r = hardwareVerifier.get(a.agentId); return r ? ownerVerificationView(r) : null; })(),
          reliability: hardwareVerifier.reliability(a.agentId) ?? null,
          ask: a.ask?.msatPerCredit ?? null,
          tracking: a.ask?.tracking ?? true
        };
      });
    return { accountId: params.accountId, orders, agents };
  });

  /**
   * Compute class definitions (with the tier weight table) with the current oracle rate and
   * connected agents per class and per tier. `creditsPerSecond: 1` is the base tier, kept for
   * portal pages built before tiers existed.
   */
  app.get("/economy/market/classes", async (req, reply) => {
    if (!requireMeshOrPortalToken(req, reply)) return;
    const agentsByClass = new Map<string, number>();
    const agentsByTier = new Map<string, number>();
    /** Agents paid at the tier: verified there, or at a base tier with nothing to prove. */
    const verifiedByTier = new Map<string, number>();
    for (const [agentId, cap] of agentCapabilities) {
      agentsByClass.set(cap.computeClass, (agentsByClass.get(cap.computeClass) ?? 0) + 1);
      if (cap.hardwareClass) agentsByTier.set(cap.hardwareClass.tier, (agentsByTier.get(cap.hardwareClass.tier) ?? 0) + 1);
      const v = hardwareVerifier.get(agentId);
      if (v && (v.status === "verified" || v.status === "base")) verifiedByTier.set(v.granted.tier, (verifiedByTier.get(v.granted.tier) ?? 0) + 1);
    }
    return {
      rateEpochId: mutable.latestRateEpoch?.epochId ?? null,
      classes: COMPUTE_CLASS_IDS.map((id) => {
        const spec = rateOracleConfig.computeClasses[id];
        return {
          ...spec,
          creditsPerSecond: 1,
          tiers: spec.tiers.map((t) => ({ ...t, agents: agentsByTier.get(t.id) ?? 0, verifiedAgents: verifiedByTier.get(t.id) ?? 0 })),
          rate: mutable.latestRateEpoch?.classRates?.[id] ?? null,
          referenceMsatPerCredit: orderBook.referenceFor(id),
          agents: agentsByClass.get(id) ?? 0
        };
      })
    };
  });

  /**
   * Hardware verification records (claimed vs granted tier, last measurement, rolling evidence score):
   * the seed of the published SLA / reputation score.
   */
  app.get("/economy/hardware/verifications", async (req, reply) => {
    if (!requireMeshOrPortalToken(req, reply)) return;
    return { enabled: hardwareVerifier.config.enabled, records: hardwareVerifier.list() };
  });

  app.get("/economy/hardware/verifications/:agentId", async (req, reply) => {
    if (!requireMeshOrPortalToken(req, reply)) return;
    const params = z.object({ agentId: z.string().min(1).max(128) }).parse(req.params);
    const record = hardwareVerifier.get(params.agentId);
    if (!record) return reply.code(404).send({ error: "not_found" });
    return { record };
  });
}
