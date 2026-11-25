// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Pricing state: price epochs, the rate oracle, the order book and hardware verification.
 */
import { randomInt } from "node:crypto";
import type { PaymentIntent, PriceEpochRecord, ResourceClass } from "../../common/types.js";
import { cSatsToMsat, inferenceReserveMsat, reserveMsat, WORK_PROMPT_TOKEN_ALLOWANCE } from "../../economy/job-pricing.js";
import { paramsB } from "../../inference-api/auto-route.js";
import { configureCloudCatalog } from "../../cloud-host/catalog.js";
import { configureCloudPricing, modelTokenPrice } from "../../economy/cloud-pricing.js";
import { parseCloudHostOwners } from "./cloud-hosts.js";
import { OUTPUT_TOKEN_ALLOWANCE, PROMPT_TOKEN_ALLOWANCE } from "../inference-streams.js";
import { pgStore } from "../../db/store.js";
import { dynamicLoadMultiplier, LEGACY_BASE_SATS_PER_UNIT } from "../../economy/pricing.js";
import { priceEpochBoundsFromEnv } from "../../economy/price-epoch-guard.js";
import {
  isRateEpochStale,
  rateOracleConfigFromEnv,
  recalibrateRates,
  type RateEpoch
} from "../../economy/rate-oracle.js";
import {
  COMPUTE_CLASS_IDS,
  type ComputeClassId,
  type HardwareClassification,
  satsPerCreditForClass
} from "../../economy/compute-classes.js";
import { ComputeOrderBook, type AskCapability } from "../../economy/order-book.js";
import { MarketHistory, type MarketOrder } from "../../economy/market-history.js";
import {
  HardwareVerifier,
  ipNetworkPrefix,
  hardwareVerificationConfigFromEnv,
  type HardwareVerificationRecord
} from "../hardware-verification.js";
import { app } from "./app.js";
import { FALLBACK_BTC_USD, CC, queue } from "./context.js";
import { mutable } from "./mutable-state.js";
import { agentCapabilities, activeBlacklistRecord } from "./agent-state.js";

/** msat per credit (base-tier second) of a class: the oracle's rate, else its USD reference. */
export function classRefMsatPerCredit(cls: ComputeClassId): number {
  const oracle = mutable.latestRateEpoch?.classRates?.[cls]?.msatPerCredit;
  if (oracle && oracle > 0) return oracle;
  const spec = rateOracleConfig.computeClasses[cls];
  return satsPerCreditForClass(spec?.usdPerHourReference ?? 0.02, FALLBACK_BTC_USD, 0) * 1000;
}

/**
 * Worst-case msat to set aside for one subtask: CPU work is paid as CPU (settlementClassFor); GPU
 * work at the requested class, or the dearest GPU-type class for "any".
 */
export function subtaskReserveMsat(resourceClass: ResourceClass, taskClass: ComputeClassId | "any", timeoutMs: number, bidCeiling?: number): number {
  const classes: ComputeClassId[] =
    resourceClass === "cpu" ? ["cpu"] : taskClass === "any" ? (Object.keys(rateOracleConfig.computeClasses) as ComputeClassId[]).filter((c) => c !== "cpu") : [taskClass];
  return Math.max(
    ...classes.map((c) =>
      reserveMsat({
        timeoutMs,
        classRefMsatPerCredit: classRefMsatPerCredit(c),
        maxTierWeight: Math.max(1, ...(rateOracleConfig.computeClasses[c]?.tiers ?? []).map((t) => t.creditsPerSecond)),
        bidCeilingMsatPerCredit: bidCeiling,
      })
    )
  );
}

/**
 * What to set aside for one model call (job-pricing.ts inferenceReserveMsat): an upper bound on its
 * settled cost from its own size. Token bounds are the ones /inference/chunks applies to reported
 * counts (the queued input's bytes + PROMPT_TOKEN_ALLOWANCE in, maxTokens + OUTPUT_TOKEN_ALLOWANCE
 * out); the power floor is the requested class's (every class for "any") at its top tier for the
 * work those tokens take on a slow host there, at most the call's timeout: the most it can be billed
 * for (job-pricing.ts expectedWorkMs). `maxCSats` (the buyer's ceiling) caps it.
 */
export function inferenceCallReserve(input: { model: string; taskClass: ComputeClassId | "any"; timeoutMs: number; inputBytes: number; maxTokens: number; maxCSats?: number }) {
  const classes = (input.taskClass === "any" ? Object.keys(rateOracleConfig.computeClasses) : [input.taskClass]) as ComputeClassId[];
  const own = modelTokenPrice(input.model);
  return inferenceReserveMsat({
    paramsB: paramsB(input.model),
    ...(own ? { price: own } : {}),
    btcUsd: mutable.latestRateEpoch?.btcUsd ?? FALLBACK_BTC_USD,
    promptTokensMax: Math.max(0, input.inputBytes) + PROMPT_TOKEN_ALLOWANCE,
    outputTokensMax: Math.max(0, input.maxTokens) + OUTPUT_TOKEN_ALLOWANCE,
    // The power floor's seconds: the work this many tokens take on a slow host of each class (C8).
    workPromptTokensMax: Math.max(0, input.inputBytes) + WORK_PROMPT_TOKEN_ALLOWANCE,
    maxDurationMs: input.timeoutMs,
    floorClasses: classes.map((c) => ({ computeClass: c, maxTierWeight: Math.max(1, ...(rateOracleConfig.computeClasses[c]?.tiers ?? []).map((t) => t.creditsPerSecond)) })),
    ...(input.maxCSats !== undefined ? { capMsat: cSatsToMsat(input.maxCSats) } : {}),
  });
}

export const paymentIntents = new Map<string, PaymentIntent>();
export const latestPriceEpochByResource = new Map<ResourceClass, PriceEpochRecord>();
/** #53: band and max step for the legacy price epoch, and how many signed coordinators a consensus round needs. */
export const PRICE_EPOCH_BOUNDS = { cpu: priceEpochBoundsFromEnv("cpu"), gpu: priceEpochBoundsFromEnv("gpu") } as const;
export const PRICE_CONSENSUS_QUORUM_OVERRIDE = CC.PRICE_CONSENSUS_QUORUM;
export function previousPriceEpochSats(resourceClass: ResourceClass): number {
  return latestPriceEpochByResource.get(resourceClass)?.pricePerComputeUnitSats ?? LEGACY_BASE_SATS_PER_UNIT[resourceClass];
}

// ── Rate oracle: sats per CPU-hour from market data, recalibrated daily ──
export const RATE_RECALIBRATION_MS = CC.RATE_RECALIBRATION_MS;
export const RATE_ORACLE_ENABLED = CC.RATE_ORACLE_ENABLED;
export const rateOracleConfig = rateOracleConfigFromEnv();

/**
 * Compute market: agents' asks and tasks' bids per compute class, in msat per credit. The
 * oracle sets the reference each epoch; tracking asks follow it (see order-book.ts).
 */
export const orderBook = new ComputeOrderBook();
/** Minute ticks + trade tape per class: candles, depth and the trade list for the market page. */
export const marketHistory = new MarketHistory();
export const MARKET_TICK_MS = 60_000;
/** Standing orders from the portal keyed by `${accountId}:${side}`. */
export const marketOrders = new Map<string, MarketOrder>();
/**
 * Hardware verification (src/swarm/hardware-verification.ts): hardware is self-reported, so a tier
 * above the class base is paid only after the agent passes a coordinator-issued benchmark
 * challenge; until then (and for agents without benchmark support) it earns base weight 1.
 */
export const hardwareVerifier = new HardwareVerifier({
  config: hardwareVerificationConfigFromEnv(),
  classes: rateOracleConfig.computeClasses,
  persist: (r) => pgStore?.upsertHardwareVerification(r),
  // Further witnesses: a second one after the first disagreed, two fresh ones for a confirmatory round.
  pickWitness: (subjectId, model, exclude, nowMs) => pickBenchmarkWitness(subjectId, model, nowMs, exclude)
});
/** The class, tier and weight an agent is paid and matched at (its verified grant); undefined for an unknown agent. */
export function effectiveHardware(agentId: string, cap?: { hardwareClass?: HardwareClassification }): HardwareClassification | undefined {
  const c = cap ?? agentCapabilities.get(agentId);
  return c?.hardwareClass ? hardwareVerifier.effective(agentId, c.hardwareClass) : undefined;
}
/** What an agent's ask advertises to the matcher: verified tier and weight, capability (VRAM, memory), reliability. */
export function askCapabilityOf(agentId: string, cap: { hardwareClass?: HardwareClassification } | undefined): AskCapability | undefined {
  const h = effectiveHardware(agentId, cap);
  const reliability = hardwareVerifier.reliability(agentId);
  return h ? { tier: h.tier, creditsPerSecond: h.creditsPerSecond, vramGb: h.vramGb, memoryGb: h.memoryGb, ...(reliability !== undefined ? { reliability } : {}) } : undefined;
}
/** Re-post an agent's ask after its grant changed; an explicit price survives only within the same class. */
export function repostAsk(agentId: string, nowMs = Date.now()): void {
  const cap = agentCapabilities.get(agentId);
  const eff = effectiveHardware(agentId, cap);
  if (!cap || !eff) return;
  const prev = orderBook.askFor(agentId);
  const keepPrice = prev && !prev.tracking && prev.computeClass === eff.computeClass ? prev.msatPerCredit : undefined;
  orderBook.postAsk(agentId, eff.computeClass, keepPrice, nowMs, askCapabilityOf(agentId, cap));
}
/** Short verification state for the agent / portal. */
export function verificationSummary(r: HardwareVerificationRecord | undefined): Record<string, unknown> | null {
  if (!r) return null;
  return { status: r.status, claimedTier: r.claimed.tier, grantedTier: r.granted.tier, grantedClass: r.granted.computeClass, measured: r.measured ?? null, reliability: hardwareVerifier.reliability(r.agentId) ?? null, flags: r.flags };
}
/** The Ollama model a GPU challenge runs on: the agent's active model, else the one it benchmarked. */
export function benchmarkModelFor(agentId: string): string | undefined {
  const rec = hardwareVerifier.get(agentId);
  return agentCapabilities.get(agentId)?.activeModel || rec?.selfReport?.gpu?.model || rec?.selfReport?.loaded?.model || undefined;
}
/**
 * A witness for a GPU cross-check, picked uniformly at random among the eligible agents:
 * - online, not blacklisted, and running the challenge's model on the same engine as the subject
 *   (Ollama, vLLM or MLX), and on vLLM / MLX the same served weights (engineModel: an AWQ and an
 *   FP8 build of one model give different greedy text, so comparing them would read an honest
 *   agent as a mismatch and strike an honest witness);
 * - eligible on its own verification record (hardwareVerifier.canWitness): a passed GPU challenge
 *   and a clean enough witness record (few disagreements, strikes under the threshold);
 * - independent of the subject and of every agent in `exclude` (earlier witnesses of the same
 *   check): a different agent, owner account and IP network (/24 for IPv4, /48 for IPv6).
 * Witnesses on separate accounts and networks can still collude; a demotion therefore needs a
 * confirmatory round with two more fresh witnesses (hardware-verification.ts), and witnesses it
 * overrules are struck.
 */
export function pickBenchmarkWitness(subjectId: string, model: string, nowMs: number, exclude: string[] = [], pick: (n: number) => number = randomInt): string | undefined {
  const engineOf = (id: string) => {
    const cap = agentCapabilities.get(id);
    const engine = cap?.inferenceEngine ?? "ollama";
    return engine === "ollama" ? engine : `${engine}:${(cap?.engineModel ?? "").toLowerCase()}`;
  };
  const subjectEngine = engineOf(subjectId);
  const others = [subjectId, ...exclude].map((id) => {
    const cap = agentCapabilities.get(id);
    return { id, owner: cap?.ownerEmail, net: ipNetworkPrefix(cap?.sourceIp) };
  });
  const candidates: string[] = [];
  for (const [id, cap] of agentCapabilities) {
    if (nowMs - cap.lastSeenMs > 2 * 60_000 || activeBlacklistRecord(id)) continue;
    const net = ipNetworkPrefix(cap.sourceIp);
    if (others.some((o) => o.id === id || (o.owner && cap.ownerEmail === o.owner) || (o.net && net === o.net))) continue;
    if (benchmarkModelFor(id) !== model || engineOf(id) !== subjectEngine || !hardwareVerifier.canWitness(id, nowMs)) continue;
    candidates.push(id);
  }
  return candidates.length ? candidates[pick(candidates.length)] : undefined;
}

const MARKET_BID_MAX_AGE_MS = 24 * 60 * 60_000;
export function recordMarketTicks(nowMs = Date.now()): void {
  // Bids are per task; drop any that outlived their task (failed, abandoned, lost on restart).
  orderBook.pruneBids((bid) => nowMs - bid.createdAtMs > MARKET_BID_MAX_AGE_MS || (queue.openSubtaskCount(bid.taskId) === 0 && nowMs - bid.createdAtMs > 10 * 60_000));
  for (const id of COMPUTE_CLASS_IDS) {
    if (!orderBook.hasReference(id)) continue; // no oracle rate yet: nothing meaningful to chart
    const snap = orderBook.snapshot(id, nowMs);
    const tick = {
      atMs: nowMs,
      computeClass: id,
      referenceMsat: snap.referenceMsatPerCredit,
      bestAskMsat: snap.bestAsk,
      bestBidMsat: snap.bestBid,
      midMsat: snap.midMsatPerCredit,
      clearingMsat: snap.clearingMsatPerCredit,
      agents: snap.agents,
      openTasks: snap.openTasks
    };
    marketHistory.recordTick(tick);
    void pgStore?.persistMarketTick(tick).catch(() => undefined);
  }
}

/** A seller's standing order applies to every agent the account owns; a buyer's becomes the default bid for its tasks. */
export async function applyMarketOrder(order: MarketOrder): Promise<void> {
  marketOrders.set(`${order.accountId}:${order.side}`, order);
  await pgStore?.upsertMarketOrder(order);
  if (order.side === "sell") {
    const owned = (await pgStore?.listAgentOwnershipByAccount(order.accountId)) ?? [];
    const ids = new Set<string>([...owned.map((o) => o.agentId), order.accountId]);
    for (const agentId of ids) {
      const cap = agentCapabilities.get(agentId);
      const cls = cap ? (effectiveHardware(agentId, cap)?.computeClass ?? cap.computeClass) : undefined;
      if (cap && cls && (order.computeClass === "any" || order.computeClass === cls)) {
        orderBook.postAsk(agentId, cls, order.msatPerCredit > 0 ? order.msatPerCredit : undefined, Date.now(), askCapabilityOf(agentId, cap));
      }
    }
  }
}
export const MARKET_DEFAULT_BID_PREMIUM_BPS = CC.MARKET_DEFAULT_BID_PREMIUM_BPS;
export const NETWORK_FEE_BPS = CC.NETWORK_FEE_BPS;

// Cloud hosts (docs/cloud-host.md): the cloud-model price list (CLOUD_MODELS_JSON, validated by the
// config schema), the cost-plus margin and the owners allowed to run a cloud host.
configureCloudCatalog(CC.CLOUD_MODELS_JSON);
configureCloudPricing({ marginPct: CC.CLOUD_MARGIN_PCT, feeBps: NETWORK_FEE_BPS });
export const CLOUD_HOST_OWNERS = parseCloudHostOwners(CC.CLOUD_HOST_OWNER_EMAILS);

export function syncOrderBookReference(epoch: RateEpoch | null): void {
  if (!epoch) return;
  for (const id of COMPUTE_CLASS_IDS) {
    const r = epoch.classRates?.[id];
    if (r) orderBook.setReference(id, r.msatPerCredit);
  }
}

export async function recalibrateRateEpoch(): Promise<RateEpoch> {
  const epoch = await recalibrateRates({ cfg: rateOracleConfig, previous: mutable.latestRateEpoch });
  mutable.latestRateEpoch = epoch;
  syncOrderBookReference(epoch);
  recordMarketTicks();
  await pgStore?.upsertRateEpoch(epoch);
  app.log.info(
    {
      epochId: epoch.epochId,
      status: epoch.status,
      btcUsd: epoch.btcUsd,
      satsPerCpuHour: epoch.satsPerCpuHour,
      satsPerGpuHour: epoch.satsPerGpuHour,
      msatPerCredit: epoch.msatPerCredit,
      clamped: Boolean(epoch.clamped),
      sources: epoch.btcUsdSources.map((s) => `${s.name}:${s.ok ? (s.outlier ? "outlier" : "ok") : "fail"}`)
    },
    "rate_epoch_recalibrated"
  );
  return epoch;
}

export interface CreditQuote {
  satsPerCredit: number;
  msatPerCredit: number;
  loadMultiplier: number;
  quoteSource: "rate_oracle" | "price_epoch" | "default_floor";
  rateEpochId?: string;
  rateEpochAtMs?: number;
  stale: boolean;
}

/**
 * What one credit (one CPU-second) costs right now: the oracle's market rate × the scarcity
 * multiplier. Falls back to the legacy mesh price epoch, then to the legacy 30-sat floor, when
 * the oracle has never produced an epoch (e.g. RATE_ORACLE_ENABLED=false or offline dev).
 */
export function quoteSatsPerCredit(resourceClass: ResourceClass = "cpu"): CreditQuote {
  const status = queue.status();
  const cpuCapacity = Math.max(1, [...agentCapabilities.values()].reduce((sum, a) => sum + Math.max(1, a.maxConcurrentTasks), 0));
  const gpuCapacity = Math.max(1, [...agentCapabilities.values()].filter((a) => a.localModelProvider === "ollama-local").length);
  const loadMultiplier = Number(
    dynamicLoadMultiplier(resourceClass, { cpuCapacity, gpuCapacity, queuedTasks: status.queued, activeAgents: status.agents }).toFixed(4)
  );
  if (mutable.latestRateEpoch) {
    const classRate = mutable.latestRateEpoch.classRates?.[resourceClass === "gpu" ? "gpu" : "cpu"];
    const perCreditBase = classRate ? classRate.satsPerCredit : (resourceClass === "gpu" ? mutable.latestRateEpoch.satsPerGpuHour : mutable.latestRateEpoch.satsPerCpuHour) / 3600;
    const satsPerCredit = Number((perCreditBase * loadMultiplier).toFixed(6));
    return {
      satsPerCredit,
      msatPerCredit: Math.max(1, Math.round(satsPerCredit * 1000)),
      loadMultiplier,
      quoteSource: "rate_oracle",
      rateEpochId: mutable.latestRateEpoch.epochId,
      rateEpochAtMs: mutable.latestRateEpoch.createdAtMs,
      stale: isRateEpochStale(mutable.latestRateEpoch, rateOracleConfig)
    };
  }
  const legacy = latestPriceEpochByResource.get(resourceClass);
  const satsPerCredit = legacy?.pricePerComputeUnitSats ?? (resourceClass === "gpu" ? 120 : 30);
  return {
    satsPerCredit,
    msatPerCredit: Math.round(satsPerCredit * 1000),
    loadMultiplier,
    quoteSource: legacy ? "price_epoch" : "default_floor",
    stale: true
  };
}
/** Routes that need a Lightning provider: payment intents/webhook and robot task creation (invoices). */
export function isPaymentGatedRequest(method: string, url: string): boolean {
  const path = url.split("?")[0];
  if (path.startsWith("/economy/payments")) return true;
  return method === "POST" && path === "/robot/tasks";
}
