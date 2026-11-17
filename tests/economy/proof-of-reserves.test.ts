import { describe, expect, it, vi } from "vitest";
import {
  RESERVES_METHOD,
  buildReservesReport,
  createFixedWindowLimiter,
  createReservesCache,
  readReservesReport,
  reservesCacheMsFromEnv,
  reservesRateLimitFromEnv,
  type ProofOfReservesReport,
  type ReservesSources
} from "../../src/economy/proof-of-reserves.js";
import type { NodeBalances } from "../../src/economy/lightning.js";
import type { AnchorView } from "../../src/economy/anchor-status.js";

const balances = (channelLocalSats: number, onchainConfirmedSats: number, pending = 0): NodeBalances => ({
  supported: true,
  channelLocalSats,
  onchainConfirmedSats,
  onchainUnconfirmedSats: pending,
  channelPendingSats: 0,
  totalSats: channelLocalSats + onchainConfirmedSats + pending
});

// Ledger fixture: three accounts (one negative, which must not offset the others), the fee pool, a running job.
const LEDGER = [
  { accountId: "buyer-1", balanceMsat: 120_000_000 },
  { accountId: "host-1", balanceMsat: 30_000_500 },
  { accountId: "broken", balanceMsat: -5_000_000 }
];
const ledgerTotals = () => ({
  accountBalancesMsat: LEDGER.reduce((s, a) => s + Math.max(0, a.balanceMsat), 0),
  feePoolMsat: 7_000_000,
  heldForJobsMsat: 2_000_000
});

const sources = (over: Partial<ReservesSources> = {}): ReservesSources => ({
  network: "bitcoin",
  liabilities: async () => ledgerTotals(),
  balances: async () => balances(100_000, 80_000, 5_000),
  anchoring: () => "disabled",
  now: () => Date.UTC(2026, 10, 17, 12, 0, 0),
  ...over
});

describe("proof of reserves report", () => {
  it("has the public shape: liabilities, reserves, ratio, timestamp, network", async () => {
    const r = await readReservesReport(sources(), 60_000);
    expect(Object.keys(r).sort()).toEqual(["anchor", "anchoring", "asOf", "asOfMs", "cacheSeconds", "liabilities", "method", "network", "ratio", "reserves"]);
    expect(r).toMatchObject({ network: "mainnet", asOf: "2026-11-17T12:00:00.000Z", anchor: null, anchoring: "disabled", cacheSeconds: 60, method: RESERVES_METHOD });
    // 120 000 + 30 000.5 (rounded up) sats; the negative account counts as 0.
    expect(r.liabilities).toEqual({ available: true, accountBalancesSats: 150_001, feePoolSats: 7_000, heldForJobsSats: 2_000, totalSats: 159_001 });
    expect(r.reserves).toEqual({ available: true, channelLocalSats: 100_000, onchainConfirmedSats: 80_000, totalSats: 180_000, pendingSats: 5_000 });
    expect(r.ratio).toBe(Math.floor((180_000 / 159_001) * 10_000) / 10_000);
  });

  it("names signet and other test networks as they are", async () => {
    expect((await readReservesReport(sources({ network: "signet" }), 60_000)).network).toBe("signet");
  });

  it("an LND failure makes reserves unavailable (no number, no ratio); the error is logged, not published", async () => {
    const onError = vi.fn();
    const r = await readReservesReport(sources({ balances: async () => { throw new Error("lnd_http_500: secret detail macaroon=abc"); }, onError }), 60_000);
    expect(r.reserves).toEqual({ available: false, reason: "node_unreachable" });
    expect(r.ratio).toBeNull();
    expect(r.liabilities.available).toBe(true);
    expect(onError).toHaveBeenCalledWith("reserves", expect.any(Error));
    expect(JSON.stringify(r)).not.toContain("macaroon");
  });

  it("a hung node read times out as unavailable", async () => {
    const r = await readReservesReport(sources({ balances: () => new Promise(() => undefined), timeoutMs: 20 }), 60_000);
    expect(r.reserves).toEqual({ available: false, reason: "node_unreachable" });
  });

  it("a provider that can't report balances, or a malformed answer, is unavailable", async () => {
    expect((await readReservesReport(sources({ balances: async () => ({ supported: false, reason: "economy_payments_disabled" }) }), 60_000)).reserves).toEqual({ available: false, reason: "node_balances_unsupported" });
    expect((await readReservesReport(sources({ balances: async () => balances(Number.NaN, 1) }), 60_000)).reserves).toEqual({ available: false, reason: "node_balances_malformed" });
  });

  it("a ledger failure or a store without totals makes liabilities unavailable", async () => {
    expect((await readReservesReport(sources({ liabilities: async () => { throw new Error("db down"); } }), 60_000)).liabilities).toEqual({ available: false, reason: "ledger_unreachable" });
    const none = await readReservesReport(sources({ liabilities: async () => undefined }), 60_000);
    expect(none.liabilities).toEqual({ available: false, reason: "ledger_totals_unsupported" });
    expect(none.ratio).toBeNull();
  });

  it("nothing owed: ratio is null, not infinity", async () => {
    const r = await readReservesReport(sources({ liabilities: async () => ({ accountBalancesMsat: 0, feePoolMsat: 0, heldForJobsMsat: 0 }) }), 60_000);
    expect(r.ratio).toBeNull();
  });

  it("shows only a real anchor on the same network", () => {
    const base: AnchorView = { anchorId: "a", epochId: "e", checkpointHash: "ab".repeat(32), network: "bitcoin", status: "anchored", simulated: false, txRef: "cd".repeat(32), confirmations: 7, requiredConfirmations: 6, createdAtMs: 1, anchoredAtMs: 2 };
    const at = (anchor: AnchorView) => buildReservesReport({ network: "bitcoin", liabilities: ledgerTotals(), balances: balances(1, 1), anchor, anchoring: "enabled", nowMs: 0, cacheMs: 60_000 }).anchor;
    expect(at(base)).toEqual({ txid: base.txRef, checkpointHash: base.checkpointHash, confirmations: 7, status: "anchored", createdAtMs: 1, anchoredAtMs: 2 });
    expect(at({ ...base, simulated: true, simulatedReason: "mock_provider" })).toBeNull();
    expect(at({ ...base, network: "signet" })).toBeNull();
    expect(at({ ...base, status: "failed" })).toBeNull();
    expect(at({ ...base, txRef: undefined, status: "broadcasting" })).toBeNull();
  });

  it("carries no per-account data: no account ids, only the aggregate fields", async () => {
    const r = await readReservesReport(sources(), 60_000);
    const json = JSON.stringify(r);
    for (const a of LEDGER) expect(json).not.toContain(a.accountId);
    expect(Object.keys(r.liabilities).sort()).toEqual(["accountBalancesSats", "available", "feePoolSats", "heldForJobsSats", "totalSats"]);
  });
});

describe("reserves cache", () => {
  const report = (n: number): ProofOfReservesReport => buildReservesReport({ network: "signet", liabilities: { accountBalancesMsat: n * 1000, feePoolMsat: 0, heldForJobsMsat: 0 }, balances: balances(n, 0), anchoring: "disabled", nowMs: n, cacheMs: 60_000 });

  it("computes at most once per TTL and shares one computation between concurrent callers", async () => {
    let t = 0;
    let calls = 0;
    const get = createReservesCache(async () => report(++calls), { ttlMs: 60_000, now: () => t });
    const [a, b] = await Promise.all([get(), get()]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    t = 59_999;
    await get();
    expect(calls).toBe(1);
    t = 60_000;
    expect((await get()).asOfMs).toBe(2);
    expect(calls).toBe(2);
  });

  it("caches an unavailable report too, so a failing node isn't asked on every request", async () => {
    let t = 0;
    const balancesRead = vi.fn(async () => { throw new Error("down"); });
    const get = createReservesCache(() => readReservesReport(sources({ balances: balancesRead, now: () => t }), 60_000), { ttlMs: 60_000, now: () => t });
    await get();
    await get();
    expect(balancesRead).toHaveBeenCalledTimes(1);
  });

  it("env: RESERVES_CACHE_MS has a 10 s floor; the rate limit defaults to 30/min", () => {
    expect(reservesCacheMsFromEnv({})).toBe(60_000);
    expect(reservesCacheMsFromEnv({ RESERVES_CACHE_MS: "1000" })).toBe(10_000);
    expect(reservesCacheMsFromEnv({ RESERVES_CACHE_MS: "120000" })).toBe(120_000);
    expect(reservesCacheMsFromEnv({ RESERVES_CACHE_MS: "x" })).toBe(60_000);
    expect(reservesRateLimitFromEnv({})).toBe(30);
    expect(reservesRateLimitFromEnv({ RESERVES_RATE_LIMIT_PER_MIN: "5" })).toBe(5);
    expect(reservesRateLimitFromEnv({ RESERVES_RATE_LIMIT_PER_MIN: "0" })).toBe(30);
  });
});

describe("fixed-window limiter", () => {
  it("allows max per window per key, then answers with the seconds to wait", () => {
    let t = 0;
    const l = createFixedWindowLimiter({ max: 2, windowMs: 60_000, now: () => t });
    expect(l.take("a").ok).toBe(true);
    expect(l.take("a").ok).toBe(true);
    expect(l.take("a")).toEqual({ ok: false, retryAfterSeconds: 60 });
    expect(l.take("b").ok).toBe(true);
    t = 60_000;
    expect(l.take("a").ok).toBe(true);
  });

  it("stays bounded in memory", () => {
    const l = createFixedWindowLimiter({ max: 1, windowMs: 60_000, now: () => 0, maxKeys: 3 });
    for (let i = 0; i < 10; i++) expect(l.take(`ip-${i}`).ok).toBe(true);
  });
});
