// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Proof of reserves (docs/decentralization.md, "Proof of reserves"): what EdgeCoder owes, next to
 * what its Lightning node holds, as aggregate numbers anyone can read.
 *
 *  liabilities  Σ positive credit balances of every account except the fee pool (customers'
 *               prepaid cSats and hosts' unpaid earnings live in the same ledger; 1 cSat = 1 sat),
 *               + the fee pool's undistributed sats (owed to infrastructure hosts or EdgeCoder),
 *               + cSats set aside for jobs still running (task reserves not yet paid or refunded).
 *  reserves     the node's spendable channel balance + its confirmed on-chain wallet balance.
 *               Unconfirmed and pending amounts are reported but not counted.
 *
 * What this is not: a cryptographic proof. The node reports its own balances and the ledger
 * reports its own totals. See reservesExplainer() and the page text.
 *
 * Privacy: only totals leave this module. Nothing per account is read into the report.
 * Robustness: a side that cannot be read is "unavailable" (with a generic reason code), never a
 * guess or a stale number, and the ratio is null unless both sides were read in the same run.
 */
import type { BitcoinNetwork } from "../common/types.js";
import type { NodeBalances, ProviderUnsupported } from "./lightning.js";
import type { AnchorView } from "./anchor-status.js";

/** Ledger-side totals in msat. Every field is an aggregate across accounts. */
export interface ReserveLiabilitiesMsat {
  /** Σ max(0, balance) over every account except the fee pool. */
  accountBalancesMsat: number;
  /** The fee pool's undistributed sats (never below 0). */
  feePoolMsat: number;
  /** cSats reserved for jobs that have not settled yet (paid out or refunded). */
  heldForJobsMsat: number;
}

export type Unavailable = { available: false; reason: string };

export interface LiabilitiesView {
  available: true;
  accountBalancesSats: number;
  feePoolSats: number;
  heldForJobsSats: number;
  totalSats: number;
}

export interface ReservesView {
  available: true;
  channelLocalSats: number;
  onchainConfirmedSats: number;
  totalSats: number;
  /** Reported, not counted: unconfirmed on-chain, channels still opening, HTLCs in flight. */
  pendingSats: number;
}

export interface ReservesAnchorView {
  txid: string;
  checkpointHash: string;
  confirmations: number;
  status: string;
  createdAtMs: number;
  anchoredAtMs?: number;
}

export interface ProofOfReservesReport {
  /** "mainnet" for BITCOIN_NETWORK=bitcoin, else the network name. */
  network: "mainnet" | "testnet" | "signet" | "regtest";
  asOfMs: number;
  asOf: string;
  liabilities: LiabilitiesView | Unavailable;
  reserves: ReservesView | Unavailable;
  /** reserves.totalSats / liabilities.totalSats (4 decimals); null when either side is unavailable or nothing is owed. */
  ratio: number | null;
  /** The latest real Bitcoin anchor of a ledger checkpoint; null while anchoring is off or none exists. */
  anchor: ReservesAnchorView | null;
  anchoring: "enabled" | "disabled" | "simulated";
  /** How long this report is cached (seconds). */
  cacheSeconds: number;
  /** What the numbers prove and what they don't. */
  method: string;
}

export const DEFAULT_RESERVES_CACHE_MS = 60_000;
export const MIN_RESERVES_CACHE_MS = 10_000;
export const DEFAULT_RESERVES_RATE_LIMIT_PER_MIN = 30;

export function reservesCacheMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.RESERVES_CACHE_MS);
  if (!env.RESERVES_CACHE_MS?.trim() || !Number.isFinite(n)) return DEFAULT_RESERVES_CACHE_MS;
  return Math.max(MIN_RESERVES_CACHE_MS, Math.floor(n));
}

export function reservesRateLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.RESERVES_RATE_LIMIT_PER_MIN);
  if (!env.RESERVES_RATE_LIMIT_PER_MIN?.trim() || !Number.isFinite(n) || n < 1) return DEFAULT_RESERVES_RATE_LIMIT_PER_MIN;
  return Math.floor(n);
}

export function publicNetworkName(network: BitcoinNetwork): ProofOfReservesReport["network"] {
  return network === "bitcoin" ? "mainnet" : network;
}

export const RESERVES_METHOD =
  "Liabilities are totals from EdgeCoder's ledger: every account's cSat balance (customers' prepaid cSats and hosts' unpaid earnings; 1 cSat = 1 sat), the network fee pool's undistributed sats and cSats reserved for running jobs. " +
  "Reserves are what EdgeCoder's Lightning node reports: spendable channel balance plus confirmed on-chain balance. " +
  "Both are self-reported, not a cryptographic proof: the node could misreport and the ledger could omit an account. Bitcoin anchors of the ledger let anyone check its history was not rewritten.";

const satsUp = (msat: number): number => Math.ceil(Math.max(0, msat) / 1000);
const isCount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

export function liabilitiesView(l: ReserveLiabilitiesMsat): LiabilitiesView | Unavailable {
  if (![l.accountBalancesMsat, l.feePoolMsat, l.heldForJobsMsat].every(isCount)) return { available: false, reason: "ledger_malformed" };
  // Each part is rounded up to whole sats: a liability is never understated by rounding.
  const accountBalancesSats = satsUp(l.accountBalancesMsat);
  const feePoolSats = satsUp(l.feePoolMsat);
  const heldForJobsSats = satsUp(l.heldForJobsMsat);
  return { available: true, accountBalancesSats, feePoolSats, heldForJobsSats, totalSats: accountBalancesSats + feePoolSats + heldForJobsSats };
}

export function reservesView(b: NodeBalances | ProviderUnsupported): ReservesView | Unavailable {
  if (!b.supported) return { available: false, reason: "node_balances_unsupported" };
  if (![b.channelLocalSats, b.onchainConfirmedSats, b.onchainUnconfirmedSats, b.channelPendingSats].every(isCount)) {
    return { available: false, reason: "node_balances_malformed" };
  }
  const channelLocalSats = Math.floor(b.channelLocalSats);
  const onchainConfirmedSats = Math.floor(b.onchainConfirmedSats);
  return {
    available: true,
    channelLocalSats,
    onchainConfirmedSats,
    totalSats: channelLocalSats + onchainConfirmedSats,
    pendingSats: Math.floor(b.onchainUnconfirmedSats + b.channelPendingSats)
  };
}

/** Only a real transaction counts as an anchor here: no simulated rows, no failed ones, same network. */
export function reservesAnchorView(anchor: AnchorView | null | undefined, network: BitcoinNetwork): ReservesAnchorView | null {
  if (!anchor || anchor.simulated || !anchor.txRef || anchor.network !== network) return null;
  if (anchor.status !== "pending" && anchor.status !== "anchored") return null;
  return {
    txid: anchor.txRef,
    checkpointHash: anchor.checkpointHash,
    confirmations: anchor.confirmations,
    status: anchor.status,
    createdAtMs: anchor.createdAtMs,
    ...(anchor.anchoredAtMs ? { anchoredAtMs: anchor.anchoredAtMs } : {})
  };
}

export interface ReservesInputs {
  network: BitcoinNetwork;
  /** Ledger totals, or the reason they could not be read. */
  liabilities: ReserveLiabilitiesMsat | Unavailable;
  /** Node balances, or the reason they could not be read. */
  balances: NodeBalances | ProviderUnsupported | Unavailable;
  anchor?: AnchorView | null;
  anchoring: ProofOfReservesReport["anchoring"];
  nowMs: number;
  cacheMs: number;
}

export function buildReservesReport(input: ReservesInputs): ProofOfReservesReport {
  const liabilities = "available" in input.liabilities ? input.liabilities : liabilitiesView(input.liabilities);
  const reserves = "available" in input.balances ? input.balances : reservesView(input.balances);
  let ratio: number | null = null;
  if (liabilities.available && reserves.available && liabilities.totalSats > 0) {
    ratio = Math.floor((reserves.totalSats / liabilities.totalSats) * 10_000) / 10_000;
  }
  return {
    network: publicNetworkName(input.network),
    asOfMs: input.nowMs,
    asOf: new Date(input.nowMs).toISOString(),
    liabilities,
    reserves,
    ratio,
    anchor: reservesAnchorView(input.anchor, input.network),
    anchoring: input.anchoring,
    cacheSeconds: Math.round(input.cacheMs / 1000),
    method: RESERVES_METHOD
  };
}

/** Resolve a promise within `ms`, else reject; used so a hung node read can't hold the report. */
export function withTimeout<T>(p: Promise<T>, ms: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.finally(() => timer && clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), ms);
      timer.unref?.();
    })
  ]);
}

export interface ReservesSources {
  network: BitcoinNetwork;
  /** Ledger totals; undefined when the store can't total them (no database). Throwing = unavailable. */
  liabilities: () => Promise<ReserveLiabilitiesMsat | undefined>;
  /** The node's balances. Throwing = unavailable. */
  balances: () => Promise<NodeBalances | ProviderUnsupported>;
  latestAnchor?: () => Promise<AnchorView | null>;
  anchoring: () => ProofOfReservesReport["anchoring"];
  /** Called with the underlying error when a side is unavailable (logged, never published). */
  onError?: (side: "liabilities" | "reserves" | "anchor", err: unknown) => void;
  timeoutMs?: number;
  now?: () => number;
}

/** Read both sides once and build the report. Never throws. */
export async function readReservesReport(src: ReservesSources, cacheMs: number): Promise<ProofOfReservesReport> {
  const timeoutMs = src.timeoutMs ?? 15_000;
  const [liabilities, balances, anchor] = await Promise.all([
    withTimeout(src.liabilities(), timeoutMs, "ledger_timeout").then(
      (l): ReserveLiabilitiesMsat | Unavailable => l ?? { available: false, reason: "ledger_totals_unsupported" },
      (err): Unavailable => {
        src.onError?.("liabilities", err);
        return { available: false, reason: "ledger_unreachable" };
      }
    ),
    withTimeout(src.balances(), timeoutMs, "node_timeout").then(
      (b): NodeBalances | ProviderUnsupported | Unavailable => b,
      (err): Unavailable => {
        src.onError?.("reserves", err);
        return { available: false, reason: "node_unreachable" };
      }
    ),
    src.latestAnchor
      ? withTimeout(src.latestAnchor(), timeoutMs, "anchor_timeout").catch((err) => {
          src.onError?.("anchor", err);
          return null;
        })
      : Promise.resolve(null)
  ]);
  return buildReservesReport({ network: src.network, liabilities, balances, anchor, anchoring: src.anchoring(), nowMs: (src.now ?? Date.now)(), cacheMs });
}

/**
 * Cached report: computed at most once per `ttlMs` (an unavailable report is cached too, so a
 * failing node is not asked on every request), concurrent callers share one computation.
 */
export function createReservesCache(compute: () => Promise<ProofOfReservesReport>, opts: { ttlMs: number; now?: () => number }): () => Promise<ProofOfReservesReport> {
  const now = opts.now ?? Date.now;
  let cached: ProofOfReservesReport | null = null;
  let fetchedAt = 0;
  let inflight: Promise<ProofOfReservesReport> | null = null;
  return async () => {
    if (cached && now() - fetchedAt < opts.ttlMs) return cached;
    if (inflight) return inflight;
    inflight = compute()
      .then((r) => {
        cached = r;
        fetchedAt = now();
        return r;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

/** Fixed-window per-key limiter for the public endpoint (the coordinator has no rate-limit plugin). */
export function createFixedWindowLimiter(opts: { max: number; windowMs: number; now?: () => number; maxKeys?: number }) {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  const hits = new Map<string, { windowStart: number; count: number }>();
  return {
    take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
      const t = now();
      let e = hits.get(key);
      if (!e || t - e.windowStart >= opts.windowMs) {
        if (!e && hits.size >= maxKeys) {
          for (const [k, v] of hits) if (t - v.windowStart >= opts.windowMs) hits.delete(k);
          // Still full: drop the oldest entries rather than grow without bound.
          while (hits.size >= maxKeys) hits.delete(hits.keys().next().value as string);
        }
        e = { windowStart: t, count: 0 };
        hits.set(key, e);
      }
      e.count++;
      if (e.count > opts.max) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((e.windowStart + opts.windowMs - t) / 1000)) };
      return { ok: true };
    }
  };
}
