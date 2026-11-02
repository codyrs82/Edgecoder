// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import { request } from "undici";
import {
  BASE_TIER,
  COMPUTE_CLASS_IDS,
  LEGACY_COMPUTE_CLASSES,
  computeClassesFromEnv,
  isLegacyComputeClassId,
  normalizeComputeClass,
  satsPerCreditForClass,
  tierSpec,
  type ComputeClassId,
  type ComputeClassSpec,
  type ComputeTierId
} from "./compute-classes.js";

/**
 * Daily rate oracle: what a CPU-hour (and GPU-hour) of swarm compute costs in sats.
 *
 *   satsPerCpuHour = usdPerCpuHour / btcUsd × 1e8 × (1 + networkMarkupBps / 10000)
 *   satsPerCredit  = satsPerCpuHour / 3600          (1 credit = 1 server-measured CPU-second)
 *
 * Two inputs, each from verifiable public APIs, each taken as the median of several sources
 * that must agree within `maxSourceSpreadPct`:
 *   - btcUsd: spot BTC/USD from exchanges (Coinbase, Kraken, Bitstamp) and mempool.space.
 *   - usdPerCpuHour / usdPerGpuHour: the fiat market rate for a vCPU-hour / GPU-hour. Defaults
 *     to a configured reference (cloud spot-class pricing); optional JSON sources can override it
 *     (RATE_COMPUTE_SOURCES_JSON), e.g. an internal price feed or a cloud pricing endpoint.
 *
 * Why not hashprice: hashprice is mining revenue per TH/s/day and tracks difficulty and block
 * fees, not the cost of general-purpose compute. It is computed here from public chain data and
 * reported on the epoch as a signal only; it never enters the CPU price.
 *
 * Safety: a new epoch may move at most `maxDailyMovePct` from the previous one (a bad source can
 * not reprice the network in one tick), needs `minSources` agreeing BTC/USD quotes, and quotes
 * are marked stale after `staleAfterMs` without a successful recalibration.
 */

export interface JsonNumberSource {
  name: string;
  url: string;
  /** Dot/bracket path into the JSON body, e.g. "data.amount", "result.XXBTZUSD.c[0]", "USD". */
  path: string;
  /** For compute sources: which resource class the number prices (USD per hour). */
  resourceClass?: "cpu" | "gpu";
  /**
   * For compute sources: the class whose reference this USD/hour sets (base-tier hour). A tier or
   * legacy id (e.g. "gpu.c24") prices that tier's hour instead and is divided by the tier weight.
   */
  computeClass?: string;
}

export const DEFAULT_BTC_USD_SOURCES: JsonNumberSource[] = [
  { name: "coinbase", url: "https://api.coinbase.com/v2/prices/BTC-USD/spot", path: "data.amount" },
  { name: "kraken", url: "https://api.kraken.com/0/public/Ticker?pair=XBTUSD", path: "result.XXBTZUSD.c[0]" },
  { name: "bitstamp", url: "https://www.bitstamp.net/api/v2/ticker/btcusd/", path: "last" },
  { name: "mempool.space", url: "https://mempool.space/api/v1/prices", path: "USD" }
];

export interface RateOracleConfig {
  /** Reference fiat price of one vCPU-hour of sandboxed compute (USD). */
  usdPerCpuHourReference: number;
  /** Reference fiat price of one GPU-hour (USD). */
  usdPerGpuHourReference: number;
  /** Optional live sources that override the references (median per resource class). */
  computeSources: JsonNumberSource[];
  btcUsdSources: JsonNumberSource[];
  /** Network take on top of the market reference, in basis points (2000 = 20 %). */
  networkMarkupBps: number;
  /** Max change of satsPerCpuHour per recalibration, in percent. */
  maxDailyMovePct: number;
  /** Max spread between the highest and lowest accepted BTC/USD quote, in percent of the median. */
  maxSourceSpreadPct: number;
  /** Minimum agreeing BTC/USD quotes for a fresh epoch. */
  minSources: number;
  /** After this long without a fresh epoch, quotes are flagged stale. */
  staleAfterMs: number;
  /** Used only when no epoch exists and every source failed (dev/offline). */
  btcUsdFallback?: number;
  /** Compute and report hashprice from mempool.space (informational). */
  hashpriceEnabled: boolean;
  mempoolBaseUrl: string;
  /** Per-class reference USD/hour and tier weights (src/economy/compute-classes.ts). */
  computeClasses: Record<ComputeClassId, ComputeClassSpec>;
}

export interface TierRate {
  tier: ComputeTierId;
  /** Credits per measured second on this tier (its weight). */
  creditsPerSecond: number;
  /** Sats for one hour of this tier: satsPerUnitHour × creditsPerSecond. */
  satsPerHour: number;
}

export interface ClassRate {
  computeClass: ComputeClassId;
  /** USD per credit-hour (base-tier hour) of the class. */
  usdPerHour: number;
  /** Sats per credit-hour (3600 credits; one hour of the base tier). */
  satsPerUnitHour: number;
  /** Flat within the class. */
  satsPerCredit: number;
  msatPerCredit: number;
  /** "reference" (configured) or the name of the live source that set usdPerHour. */
  source: string;
  /** Per-tier hour prices at this rate. Absent on epochs written before the four-class model. */
  tiers?: TierRate[];
}

export const DEFAULT_RATE_ORACLE_CONFIG: RateOracleConfig = {
  // Spot-class vCPU-hour. On-demand hyperscaler vCPUs run ~0.04-0.05 USD/h; spot and bare-metal
  // providers ~0.006-0.02 USD/h. Sandboxed containers on volunteer machines compete with the latter.
  usdPerCpuHourReference: 0.02,
  // Consumer GPU hour on open marketplaces (RTX 4090 class) in 2026.
  usdPerGpuHourReference: 0.35,
  computeSources: [],
  btcUsdSources: DEFAULT_BTC_USD_SOURCES,
  networkMarkupBps: 2000,
  maxDailyMovePct: 25,
  maxSourceSpreadPct: 5,
  minSources: 2,
  staleAfterMs: 48 * 60 * 60 * 1000,
  hashpriceEnabled: true,
  mempoolBaseUrl: "https://mempool.space",
  computeClasses: computeClassesFromEnv({})
};

export interface SourceQuote {
  name: string;
  value?: number;
  ok: boolean;
  error?: string;
  /** Excluded from the median because it disagreed with the others. */
  outlier?: boolean;
}

export interface HashpriceSignal {
  /** Mining revenue in sats per TH/s per day, from chain data (subsidy + 24h average fees). */
  satsPerThPerDay: number;
  networkHashrateThs: number;
  blockSubsidySats: number;
  avgFeesPerBlockSats: number;
  blockHeight: number;
  source: string;
}

export interface RateEpoch {
  epochId: string;
  createdAtMs: number;
  previousEpochId?: string;
  btcUsd: number;
  btcUsdSources: SourceQuote[];
  usdPerCpuHour: number;
  usdPerGpuHour: number;
  computeSources: SourceQuote[];
  markupBps: number;
  satsPerCpuHour: number;
  satsPerGpuHour: number;
  /** 1 credit = 1 CPU-second. Fractional sats are expected (see msatPerCredit). */
  satsPerCredit: number;
  msatPerCredit: number;
  /** Unclamped values when the daily-move clamp applied. */
  clamped?: { unclampedSatsPerCpuHour: number; unclampedSatsPerGpuHour: number };
  /** "ok": fresh market data. "carried": sources failed, previous epoch re-stamped. "fallback": static BTC_USD_FALLBACK. */
  status: "ok" | "carried" | "fallback";
  hashprice?: HashpriceSignal;
  /** Sats per credit for every compute class (cpu, apple, gpu, gpu.dc). See normalizeRateEpoch for epochs persisted under the legacy ids. */
  classRates: Partial<Record<ComputeClassId, ClassRate>>;
}

/* ------------------------------------------------------------------ */
/*  Pure math                                                          */
/* ------------------------------------------------------------------ */

/** Read a dot/bracket path from parsed JSON and coerce to a finite positive number. */
export function readNumberAtPath(body: unknown, path: string): number | undefined {
  const parts = path.split(/\.|\[|\]/).filter((p) => p.length > 0);
  let cur: unknown = body;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  const n = typeof cur === "string" ? Number(cur.replace(/,/g, "")) : typeof cur === "number" ? cur : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Median of the quotes that agree. Quotes further than `maxSpreadPct` from the median are
 * dropped (marked outlier) and the median is recomputed once. Returns undefined when fewer
 * than `minSources` quotes remain.
 */
export function agreeingMedian(
  quotes: SourceQuote[],
  maxSpreadPct: number,
  minSources: number
): { value?: number; quotes: SourceQuote[] } {
  const good = quotes.filter((q) => q.ok && typeof q.value === "number" && q.value > 0);
  if (good.length === 0) return { quotes };
  const m0 = median(good.map((q) => q.value as number));
  const marked = quotes.map((q) => {
    if (!q.ok || typeof q.value !== "number") return q;
    const dev = (Math.abs(q.value - m0) / m0) * 100;
    return dev > maxSpreadPct ? { ...q, outlier: true } : { ...q, outlier: false };
  });
  const kept = marked.filter((q) => q.ok && q.outlier === false).map((q) => q.value as number);
  if (kept.length < minSources) return { quotes: marked };
  return { value: median(kept), quotes: marked };
}

export function satsPerHourFromUsd(usdPerHour: number, btcUsd: number, markupBps: number): number {
  const sats = (usdPerHour / btcUsd) * 1e8 * (1 + markupBps / 10_000);
  return Number(sats.toFixed(3));
}

function clampMove(next: number, previous: number | undefined, maxPct: number): { value: number; clamped: boolean } {
  if (previous === undefined || previous <= 0 || maxPct <= 0) return { value: next, clamped: false };
  const lo = previous * (1 - maxPct / 100);
  const hi = previous * (1 + maxPct / 100);
  if (next < lo) return { value: Number(lo.toFixed(3)), clamped: true };
  if (next > hi) return { value: Number(hi.toFixed(3)), clamped: true };
  return { value: next, clamped: false };
}

export interface RateInputs {
  btcUsdQuotes: SourceQuote[];
  computeQuotes: SourceQuote[];
  hashprice?: HashpriceSignal;
}

/** Build the next epoch from fetched inputs. Pure; the fetching lives in recalibrateRates(). */
export function computeRateEpoch(
  inputs: RateInputs,
  previous: RateEpoch | null,
  cfg: RateOracleConfig,
  nowMs: number = Date.now()
): RateEpoch {
  const btc = agreeingMedian(inputs.btcUsdQuotes, cfg.maxSourceSpreadPct, cfg.minSources);
  let status: RateEpoch["status"] = "ok";
  let btcUsd = btc.value;
  if (btcUsd === undefined) {
    if (previous) {
      btcUsd = previous.btcUsd;
      status = "carried";
    } else if (cfg.btcUsdFallback && cfg.btcUsdFallback > 0) {
      btcUsd = cfg.btcUsdFallback;
      status = "fallback";
    } else {
      throw new Error(`rate_oracle_no_btc_usd: ${inputs.btcUsdQuotes.filter((q) => !q.ok).map((q) => `${q.name}: ${q.error}`).join("; ") || "no sources"}`);
    }
  }

  // The resource-class medians price a vCPU-hour and a 4090-class GPU-hour (the legacy epoch fields).
  // A source tagged with another class or tier (e.g. gpu.dc) prices something else and only feeds its class below.
  const tagOf = (q: SourceQuote) => (q as SourceQuote & { computeClass?: string }).computeClass;
  const resOf = (q: SourceQuote) => (q as SourceQuote & { resourceClass?: string }).resourceClass;
  const cpuQuotes = inputs.computeQuotes.filter((q) => resOf(q) !== "gpu" && [undefined, "cpu", "cpu.std"].includes(tagOf(q)));
  const gpuQuotes = inputs.computeQuotes.filter((q) => resOf(q) === "gpu" && [undefined, "gpu.c24"].includes(tagOf(q)));
  const cpuLive = agreeingMedian(cpuQuotes, cfg.maxSourceSpreadPct * 4, 1).value;
  const gpuLive = agreeingMedian(gpuQuotes, cfg.maxSourceSpreadPct * 4, 1).value;
  const usdPerCpuHour = cpuLive ?? cfg.usdPerCpuHourReference;
  const usdPerGpuHour = gpuLive ?? cfg.usdPerGpuHourReference;

  const rawCpu = satsPerHourFromUsd(usdPerCpuHour, btcUsd, cfg.networkMarkupBps);
  const rawGpu = satsPerHourFromUsd(usdPerGpuHour, btcUsd, cfg.networkMarkupBps);
  // A carried epoch re-stamps the previous price; only fresh data is clamped against it.
  const cpu = status === "ok" ? clampMove(rawCpu, previous?.satsPerCpuHour, cfg.maxDailyMovePct) : { value: rawCpu, clamped: false };
  const gpu = status === "ok" ? clampMove(rawGpu, previous?.satsPerGpuHour, cfg.maxDailyMovePct) : { value: rawGpu, clamped: false };
  const satsPerCredit = cpu.value / 3600;

  // Per-class rates: a live source tagged with a computeClass overrides that class's reference.
  // Untagged cpu sources price the cpu class; untagged gpu sources price a 4090-class hour
  // (gpu.c24 tier), so the gpu class reference is that hour over the gpu.c24 weight.
  const classRates: Partial<Record<ComputeClassId, ClassRate>> = {};
  const classMoveFactor = previous && status === "ok" && rawCpu > 0 ? cpu.value / rawCpu : 1; // same clamp ratio as cpu
  for (const id of COMPUTE_CLASS_IDS) {
    const spec = cfg.computeClasses[id];
    if (!spec) continue;
    const live = inputs.computeQuotes
      .filter((q) => normalizeComputeClass((q as SourceQuote & { computeClass?: string }).computeClass) === id)
      .map((q) => {
        const tag = (q as SourceQuote & { computeClass?: string }).computeClass as string;
        const weight = tag === id ? 1 : (tierSpec(cfg.computeClasses, tag as ComputeTierId)?.creditsPerSecond ?? 1);
        return typeof q.value === "number" ? { ...q, value: q.value / weight } : q;
      });
    const liveValue = agreeingMedian(live, cfg.maxSourceSpreadPct * 4, 1).value;
    const c24 = tierSpec(cfg.computeClasses, "gpu.c24")?.creditsPerSecond ?? 1;
    const usdPerHour = Number((liveValue ?? (id === "cpu" ? usdPerCpuHour : id === "gpu" ? usdPerGpuHour / c24 : spec.usdPerHourReference)).toFixed(9));
    const perCredit = Number((satsPerCreditForClass(usdPerHour, btcUsd, cfg.networkMarkupBps) * classMoveFactor).toFixed(9));
    const satsPerUnitHour = Number((perCredit * 3600).toFixed(3));
    classRates[id] = {
      computeClass: id,
      usdPerHour,
      satsPerUnitHour,
      satsPerCredit: perCredit,
      msatPerCredit: Math.max(1, Math.round(perCredit * 1000)),
      source: liveValue !== undefined ? (live.find((q) => q.ok)?.name ?? "live") : "reference",
      tiers: tierRates(spec, satsPerUnitHour)
    };
  }

  return {
    epochId: randomUUID(),
    createdAtMs: nowMs,
    previousEpochId: previous?.epochId,
    btcUsd: Number(btcUsd.toFixed(2)),
    btcUsdSources: btc.quotes,
    usdPerCpuHour,
    usdPerGpuHour,
    computeSources: inputs.computeQuotes,
    markupBps: cfg.networkMarkupBps,
    satsPerCpuHour: cpu.value,
    satsPerGpuHour: gpu.value,
    satsPerCredit: Number(satsPerCredit.toFixed(6)),
    msatPerCredit: Math.max(1, Math.round(satsPerCredit * 1000)),
    ...(cpu.clamped || gpu.clamped ? { clamped: { unclampedSatsPerCpuHour: rawCpu, unclampedSatsPerGpuHour: rawGpu } } : {}),
    status,
    ...(inputs.hashprice ? { hashprice: inputs.hashprice } : {}),
    classRates
  };
}

function tierRates(spec: ComputeClassSpec, satsPerUnitHour: number): TierRate[] {
  return spec.tiers.map((t) => ({ tier: t.id, creditsPerSecond: t.creditsPerSecond, satsPerHour: Number((satsPerUnitHour * t.creditsPerSecond).toFixed(3)) }));
}

/**
 * Epochs persisted before the four-class model carry classRates keyed by the nine legacy ids,
 * priced per old credit. Derive the current classes from each class's legacy base tier (cpu.std,
 * apple.m, gpu.c8, gpu.dc40), whose hour is exactly the new class reference, so the accrual clamp
 * and the order book have a reference per current class from the moment the coordinator boots.
 * Pure: returns a copy, the stored row is never rewritten. Current epochs pass through.
 */
export function normalizeRateEpoch(epoch: RateEpoch, classes: Record<ComputeClassId, ComputeClassSpec> = DEFAULT_RATE_ORACLE_CONFIG.computeClasses): RateEpoch {
  const stored = (epoch.classRates ?? {}) as Record<string, ClassRate | undefined>;
  const hasLegacy = Object.keys(stored).some((k) => isLegacyComputeClassId(k));
  if (!hasLegacy) return epoch;
  const classRates: Partial<Record<ComputeClassId, ClassRate>> = {};
  for (const id of COMPUTE_CLASS_IDS) {
    const current = stored[id];
    if (current) {
      classRates[id] = current;
      continue;
    }
    const base = BASE_TIER[id];
    const old = isLegacyComputeClassId(base) ? stored[base] : undefined;
    if (!old || !Number.isFinite(old.satsPerCredit)) continue;
    // Old per-credit × old credits/s = sats per base-tier second = new per-credit (base weight 1).
    const perCredit = Number((old.satsPerCredit * LEGACY_COMPUTE_CLASSES[base as keyof typeof LEGACY_COMPUTE_CLASSES].creditsPerSecond).toFixed(9));
    const satsPerUnitHour = Number((perCredit * 3600).toFixed(3));
    classRates[id] = {
      computeClass: id,
      usdPerHour: old.usdPerHour,
      satsPerUnitHour,
      satsPerCredit: perCredit,
      msatPerCredit: Math.max(1, Math.round(perCredit * 1000)),
      source: old.source,
      tiers: classes[id] ? tierRates(classes[id], satsPerUnitHour) : undefined
    };
  }
  return { ...epoch, classRates };
}

export function isRateEpochStale(epoch: RateEpoch | null | undefined, cfg: RateOracleConfig, nowMs: number = Date.now()): boolean {
  if (!epoch) return true;
  return nowMs - epoch.createdAtMs > cfg.staleAfterMs;
}

/**
 * Hashprice from public chain data: 144 blocks/day × (subsidy + average fees per block) spread
 * over the network hashrate. Informational; see the module comment.
 */
export function computeHashprice(input: {
  blockHeight: number;
  networkHashrateHs: number;
  avgFeesPerBlockSats: number;
  source: string;
}): HashpriceSignal {
  const halvings = Math.floor(input.blockHeight / 210_000);
  const blockSubsidySats = halvings >= 64 ? 0 : Math.floor(50e8 / 2 ** halvings);
  const networkHashrateThs = input.networkHashrateHs / 1e12;
  const dailySats = 144 * (blockSubsidySats + Math.max(0, input.avgFeesPerBlockSats));
  return {
    satsPerThPerDay: networkHashrateThs > 0 ? Number((dailySats / networkHashrateThs).toFixed(6)) : 0,
    networkHashrateThs: Number(networkHashrateThs.toFixed(3)),
    blockSubsidySats,
    avgFeesPerBlockSats: Math.round(input.avgFeesPerBlockSats),
    blockHeight: input.blockHeight,
    source: input.source
  };
}

/* ------------------------------------------------------------------ */
/*  Fetching                                                           */
/* ------------------------------------------------------------------ */

export type JsonFetcher = (url: string) => Promise<unknown>;

export function undiciJsonFetcher(timeoutMs = 8_000): JsonFetcher {
  return async (url) => {
    const res = await request(url, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "edgecoder-rate-oracle/1" },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      await res.body.dump();
      throw new Error(`http_${res.statusCode}`);
    }
    return res.body.json();
  };
}

export async function fetchQuotes(sources: JsonNumberSource[], fetcher: JsonFetcher): Promise<SourceQuote[]> {
  return Promise.all(
    sources.map(async (src): Promise<SourceQuote> => {
      try {
        const body = await fetcher(src.url);
        const value = readNumberAtPath(body, src.path);
        if (value === undefined) return { name: src.name, ok: false, error: `no number at ${src.path}` };
        return {
          name: src.name,
          ok: true,
          value,
          ...(src.resourceClass ? { resourceClass: src.resourceClass } : {}),
          ...(src.computeClass ? { computeClass: src.computeClass } : {})
        } as SourceQuote;
      } catch (err) {
        return { name: src.name, ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    })
  );
}

export async function fetchHashprice(baseUrl: string, fetcher: JsonFetcher): Promise<HashpriceSignal | undefined> {
  try {
    const base = baseUrl.replace(/\/$/, "");
    const [height, hashrate, fees] = await Promise.all([
      fetcher(`${base}/api/blocks/tip/height`),
      fetcher(`${base}/api/v1/mining/hashrate/3d`),
      fetcher(`${base}/api/v1/mining/blocks/fees/24h`)
    ]);
    const blockHeight = Number(height);
    const networkHashrateHs = Number((hashrate as { currentHashrate?: unknown })?.currentHashrate);
    const feeRows = Array.isArray(fees) ? (fees as Array<{ avgFees?: unknown }>) : [];
    const feeValues = feeRows.map((r) => Number(r.avgFees)).filter((n) => Number.isFinite(n) && n >= 0);
    if (!Number.isFinite(blockHeight) || !Number.isFinite(networkHashrateHs) || networkHashrateHs <= 0 || feeValues.length === 0) return undefined;
    const avgFeesPerBlockSats = feeValues.reduce((a, b) => a + b, 0) / feeValues.length;
    return computeHashprice({ blockHeight, networkHashrateHs, avgFeesPerBlockSats, source: base });
  } catch {
    return undefined;
  }
}

export interface RecalibrateDeps {
  cfg: RateOracleConfig;
  previous: RateEpoch | null;
  fetcher?: JsonFetcher;
  now?: () => number;
}

/** Fetch every source and build the next epoch. Throws only when no BTC/USD is obtainable at all. */
export async function recalibrateRates(deps: RecalibrateDeps): Promise<RateEpoch> {
  const fetcher = deps.fetcher ?? undiciJsonFetcher();
  const [btcUsdQuotes, computeQuotes, hashprice] = await Promise.all([
    fetchQuotes(deps.cfg.btcUsdSources, fetcher),
    fetchQuotes(deps.cfg.computeSources, fetcher),
    deps.cfg.hashpriceEnabled ? fetchHashprice(deps.cfg.mempoolBaseUrl, fetcher) : Promise.resolve(undefined)
  ]);
  return computeRateEpoch({ btcUsdQuotes, computeQuotes, hashprice }, deps.previous, deps.cfg, (deps.now ?? Date.now)());
}

/* ------------------------------------------------------------------ */
/*  Env                                                                */
/* ------------------------------------------------------------------ */

export function rateOracleConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RateOracleConfig {
  const num = (key: string, def: number, min = 0): number => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === "") return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) throw new Error(`[rate-oracle] ${key} must be a number >= ${min}`);
    return n;
  };
  let computeSources: JsonNumberSource[] = [];
  if (env.RATE_COMPUTE_SOURCES_JSON?.trim()) {
    const parsed = JSON.parse(env.RATE_COMPUTE_SOURCES_JSON) as unknown;
    if (!Array.isArray(parsed)) throw new Error("[rate-oracle] RATE_COMPUTE_SOURCES_JSON must be a JSON array");
    computeSources = parsed.map((s: Partial<JsonNumberSource>, i) => {
      if (!s || typeof s.name !== "string" || typeof s.url !== "string" || typeof s.path !== "string" || !/^https:\/\//.test(s.url)) {
        throw new Error(`[rate-oracle] RATE_COMPUTE_SOURCES_JSON[${i}] needs name, https url and path`);
      }
      const cc = (s as { computeClass?: string }).computeClass;
      const isTier = cc !== undefined && cc !== normalizeComputeClass(cc) && tierSpec(DEFAULT_RATE_ORACLE_CONFIG.computeClasses, cc as ComputeTierId) !== undefined;
      if (cc !== undefined && !(COMPUTE_CLASS_IDS as string[]).includes(cc) && !isTier) {
        throw new Error(`[rate-oracle] RATE_COMPUTE_SOURCES_JSON[${i}].computeClass must be one of ${COMPUTE_CLASS_IDS.join(", ")} (or a tier id such as gpu.c24)`);
      }
      return { name: s.name, url: s.url, path: s.path, resourceClass: s.resourceClass === "gpu" ? "gpu" : "cpu", ...(cc ? { computeClass: cc } : {}) };
    });
  }
  let btcUsdSources = DEFAULT_BTC_USD_SOURCES;
  if (env.RATE_BTC_USD_SOURCES_JSON?.trim()) {
    const parsed = JSON.parse(env.RATE_BTC_USD_SOURCES_JSON) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("[rate-oracle] RATE_BTC_USD_SOURCES_JSON must be a non-empty JSON array");
    btcUsdSources = parsed.map((s: Partial<JsonNumberSource>, i) => {
      if (!s || typeof s.name !== "string" || typeof s.url !== "string" || typeof s.path !== "string" || !/^https:\/\//.test(s.url)) {
        throw new Error(`[rate-oracle] RATE_BTC_USD_SOURCES_JSON[${i}] needs name, https url and path`);
      }
      return { name: s.name, url: s.url, path: s.path };
    });
  }
  const fallback = env.BTC_USD_FALLBACK?.trim() ? num("BTC_USD_FALLBACK", 0, 1) : undefined;
  return {
    usdPerCpuHourReference: num("COMPUTE_REFERENCE_USD_PER_VCPU_HOUR", DEFAULT_RATE_ORACLE_CONFIG.usdPerCpuHourReference),
    usdPerGpuHourReference: num("COMPUTE_REFERENCE_USD_PER_GPU_HOUR", DEFAULT_RATE_ORACLE_CONFIG.usdPerGpuHourReference),
    computeSources,
    btcUsdSources,
    networkMarkupBps: num("RATE_NETWORK_MARKUP_BPS", DEFAULT_RATE_ORACLE_CONFIG.networkMarkupBps),
    maxDailyMovePct: num("RATE_MAX_DAILY_MOVE_PCT", DEFAULT_RATE_ORACLE_CONFIG.maxDailyMovePct),
    maxSourceSpreadPct: num("RATE_MAX_SOURCE_SPREAD_PCT", DEFAULT_RATE_ORACLE_CONFIG.maxSourceSpreadPct),
    minSources: Math.max(1, Math.floor(num("RATE_MIN_SOURCES", DEFAULT_RATE_ORACLE_CONFIG.minSources, 1))),
    staleAfterMs: num("RATE_STALE_AFTER_MS", DEFAULT_RATE_ORACLE_CONFIG.staleAfterMs, 60_000),
    btcUsdFallback: fallback,
    hashpriceEnabled: (env.RATE_HASHPRICE_ENABLED ?? "true").trim().toLowerCase() !== "false",
    mempoolBaseUrl: env.RATE_MEMPOOL_BASE_URL?.trim() || DEFAULT_RATE_ORACLE_CONFIG.mempoolBaseUrl,
    computeClasses: computeClassesFromEnv(env)
  };
}
