import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import {
  LndOnchainWallet,
  allocateBatchFee,
  bitcoinUri,
  interpretLndTransactions,
  onchainConfigFromEnv,
  satPerKwToSatPerVbyte,
  sendManyFailureIsFinal,
  taprootAddressFor,
  validateOnchainPayoutAddress
} from "../../src/economy/onchain.js";
import { evaluateReconciliation, PayoutReconciler, type ReconcileLedger } from "../../src/economy/payout-reconcile.js";
import type { LightningProvider, NodeBalances } from "../../src/economy/lightning.js";

// BIP 173 / BIP 350 vectors.
const MAIN_P2WPKH = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const MAIN_P2TR = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
const TEST_P2WPKH = "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx";
const REGTEST_P2TR = taprootAddressFor("regtest", new Uint8Array(32).fill(7));

describe("configuration", () => {
  it("is off unless ONCHAIN_ENABLED is set, on every network", () => {
    expect(onchainConfigFromEnv("bitcoin", {}).enabled).toBe(false);
    expect(onchainConfigFromEnv("regtest", {}).enabled).toBe(false);
    expect(onchainConfigFromEnv("regtest", { ONCHAIN_ENABLED: "1" }).enabled).toBe(true);
  });

  it("needs 3 confirmations and caps deposits on mainnet, 1 and no caps elsewhere; the host pays the fee by default", () => {
    expect(onchainConfigFromEnv("bitcoin", {})).toMatchObject({ depositConfirmations: 3, depositMaxSats: 1_000_000, depositMaxAccountDailySats: 2_000_000, payoutMaxFeeRateSatVb: 30, payoutFeePayer: "host", addressType: "p2tr" });
    expect(onchainConfigFromEnv("regtest", {})).toMatchObject({ depositConfirmations: 1, depositMaxSats: 0, depositMaxAccountDailySats: 0, payoutMaxFeeRateSatVb: 100 });
  });

  it("validates values and never lets a minimum go below dust", () => {
    expect(onchainConfigFromEnv("regtest", { ONCHAIN_DEPOSIT_MIN_SATS: "1", ONCHAIN_PAYOUT_MIN_SATS: "10" })).toMatchObject({ depositMinSats: 546, payoutMinSats: 546 });
    expect(() => onchainConfigFromEnv("regtest", { ONCHAIN_DEPOSIT_CONFIRMATIONS: "0" })).toThrow(/ONCHAIN_DEPOSIT_CONFIRMATIONS/);
    expect(() => onchainConfigFromEnv("regtest", { ONCHAIN_PAYOUT_FEE_PAYER: "nobody" })).toThrow(/FEE_PAYER/);
    expect(() => onchainConfigFromEnv("regtest", { ONCHAIN_ADDRESS_TYPE: "p2pkh" })).toThrow(/ADDRESS_TYPE/);
    expect(onchainConfigFromEnv("regtest", { ONCHAIN_PAYOUT_FEE_PAYER: "EdgeCoder" }).payoutFeePayer).toBe("edgecoder");
  });
});

describe("payout address validation per network", () => {
  it("accepts bech32 (v0) and bech32m (Taproot) with the network's HRP", () => {
    expect(validateOnchainPayoutAddress(MAIN_P2WPKH, "bitcoin")).toEqual({ ok: true, address: MAIN_P2WPKH });
    expect(validateOnchainPayoutAddress(MAIN_P2TR, "bitcoin")).toMatchObject({ ok: true });
    expect(validateOnchainPayoutAddress(MAIN_P2WPKH.toUpperCase(), "bitcoin")).toEqual({ ok: true, address: MAIN_P2WPKH });
    expect(validateOnchainPayoutAddress(TEST_P2WPKH, "signet")).toMatchObject({ ok: true });
    expect(validateOnchainPayoutAddress(TEST_P2WPKH, "testnet")).toMatchObject({ ok: true });
    expect(validateOnchainPayoutAddress(REGTEST_P2TR, "regtest")).toMatchObject({ ok: true });
  });

  it("refuses the wrong HRP for the network", () => {
    expect(validateOnchainPayoutAddress(MAIN_P2WPKH, "regtest")).toMatchObject({ ok: false, error: "address_network_mismatch" });
    expect(validateOnchainPayoutAddress(TEST_P2WPKH, "bitcoin")).toMatchObject({ ok: false, error: "address_network_mismatch" });
    expect(validateOnchainPayoutAddress(REGTEST_P2TR, "signet")).toMatchObject({ ok: false, error: "address_network_mismatch" });
  });

  it("refuses bad checksums, mixed case, bech32 used for Taproot, and legacy base58", () => {
    expect(validateOnchainPayoutAddress(MAIN_P2WPKH.slice(0, -1) + "5", "bitcoin")).toMatchObject({ ok: false, error: "invalid_onchain_address" });
    expect(validateOnchainPayoutAddress("bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "bitcoin")).toMatchObject({ ok: false, error: "invalid_onchain_address" });
    // BIP 350: a v1 program encoded with the bech32 (not bech32m) checksum.
    expect(validateOnchainPayoutAddress("bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7k7grplx", "bitcoin")).toMatchObject({ ok: false });
    expect(validateOnchainPayoutAddress("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "bitcoin")).toMatchObject({ ok: false, error: "unsupported_address_type" });
    expect(validateOnchainPayoutAddress("you@wallet.example", "bitcoin")).toMatchObject({ ok: false });
  });

  it("builds an upper-case bitcoin: URI for bech32 addresses", () => {
    expect(bitcoinUri(MAIN_P2WPKH)).toBe(`bitcoin:${MAIN_P2WPKH.toUpperCase()}`);
  });
});

describe("fees", () => {
  it("converts sat/kw to whole sat/vB, rounding up", () => {
    expect(satPerKwToSatPerVbyte(6250)).toBe(25);
    expect(satPerKwToSatPerVbyte(253)).toBe(2);
    expect(satPerKwToSatPerVbyte(0)).toBe(1);
  });

  it("splits a host-paid fee equally, capped per payout, with the rest on EdgeCoder", () => {
    expect(allocateBatchFee(1001, [1000, 1000], "host")).toEqual({ sharesSats: [501, 500], edgecoderSats: 0 });
    expect(allocateBatchFee(3000, [1000, 1000], "host")).toEqual({ sharesSats: [1000, 1000], edgecoderSats: 1000 });
    expect(allocateBatchFee(900, [100, 1000, 1000], "host")).toEqual({ sharesSats: [100, 300, 300], edgecoderSats: 200 });
    expect(allocateBatchFee(500, [1000], "edgecoder")).toEqual({ sharesSats: [0], edgecoderSats: 500 });
  });

  it("knows which SendMany errors mean nothing was sent", () => {
    expect(sendManyFailureIsFinal("lnd_sendmany_http_500:insufficient funds available to construct transaction")).toBe(true);
    expect(sendManyFailureIsFinal("onchain_paused")).toBe(true);
    expect(sendManyFailureIsFinal("lnd_sendmany_http_502:")).toBe(false);
    expect(sendManyFailureIsFinal("lnd_sendmany_http_500:")).toBe(false);
    expect(sendManyFailureIsFinal("UND_ERR_HEADERS_TIMEOUT")).toBe(false);
  });
});

describe("LND REST on-chain wallet", () => {
  let agent: MockAgent;
  let previous: Dispatcher;
  const BASE = "https://lnd.test:8080";
  beforeEach(() => {
    previous = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(() => setGlobalDispatcher(previous));

  it("calls NewAddress, GetTransactions, EstimateFee and SendMany with the macaroon", async () => {
    const pool = agent.get(BASE);
    const seen: Array<{ path: string; method: string; body?: string; mac?: string }> = [];
    const intercept = (method: string, path: string | ((p: string) => boolean), reply: unknown) =>
      pool.intercept({ method, path: path as never }).reply((opts) => {
        seen.push({ path: opts.path, method: opts.method, body: opts.body as string | undefined, mac: (opts.headers as Record<string, string>)["Grpc-Metadata-macaroon"] });
        return { statusCode: 200, data: JSON.stringify(reply) };
      });
    const w = new LndOnchainWallet(BASE, "abcd");
    intercept("GET", "/v1/newaddress?type=4", { address: REGTEST_P2TR });
    expect(await w.newAddress("p2tr")).toBe(REGTEST_P2TR);
    intercept("GET", "/v1/newaddress?type=0", { address: "bcrt1qxyz" });
    await w.newAddress("p2wkh");
    intercept("GET", "/v1/transactions?start_height=90&end_height=-1", { transactions: [{ tx_hash: "AA".repeat(32), amount: "5000", num_confirmations: 2, block_height: 101, time_stamp: "1700000000", total_fees: "0", label: "", output_details: [{ address: REGTEST_P2TR, output_index: "1", amount: "5000", is_our_address: true }] }] });
    expect(await w.listTransactions({ startHeight: 90 })).toEqual([
      { txid: "aa".repeat(32), amountSats: 5000, confirmations: 2, blockHeight: 101, totalFeesSats: 0, label: "", timestampMs: 1_700_000_000_000, outputs: [{ address: REGTEST_P2TR, outputIndex: 1, amountSats: 5000, isOurAddress: true }] }
    ]);
    intercept("GET", "/v2/wallet/estimatefee/6", { sat_per_kw: "6250" });
    expect(await w.estimateFeeRate(6)).toBe(25);
    intercept("POST", "/v1/transactions/many", { txid: "bb".repeat(32) });
    expect(await w.sendMany({ outputs: { [REGTEST_P2TR]: 60_000 }, satPerVbyte: 12, label: "edgecoder:onchain-batch:x" })).toEqual({ txid: "bb".repeat(32) });
    const send = seen.at(-1)!;
    expect(JSON.parse(send.body!)).toEqual({ AddrToAmount: { [REGTEST_P2TR]: "60000" }, sat_per_vbyte: "12", label: "edgecoder:onchain-batch:x", min_confs: 1, spend_unconfirmed: false });
    expect(seen.every((s) => s.mac === "abcd")).toBe(true);
  });

  it("reports SendMany refusals with LND's message, and fails closed on malformed transactions", async () => {
    agent.get(BASE).intercept({ method: "POST", path: "/v1/transactions/many" }).reply(500, JSON.stringify({ code: 2, message: "insufficient funds available to construct transaction" }));
    const w = new LndOnchainWallet(BASE, "abcd");
    const err = await w.sendMany({ outputs: { [REGTEST_P2TR]: 1000 }, satPerVbyte: 1, label: "l" }).catch((e: Error) => e.message);
    expect(err).toBe("lnd_sendmany_http_500:insufficient funds available to construct transaction");
    expect(sendManyFailureIsFinal(err as string)).toBe(true);
    expect(() => interpretLndTransactions({ transactions: [{ tx_hash: "nope" }] })).toThrow(/tx_hash/);
    expect(() => interpretLndTransactions({} as never)).toThrow(/transactions/);
  });
});

describe("reconciliation with on-chain", () => {
  const bal = (totalSats: number): NodeBalances => ({ supported: true, onchainConfirmedSats: totalSats, onchainUnconfirmedSats: 0, channelLocalSats: 0, channelPendingSats: 0, totalSats });
  const base = { nowMs: 10, payments: [], ledgerRows: new Map(), toleranceSats: 1 };

  it("a deposit that vanishes before it is credited is not a balance drop", () => {
    // Run 1: the node holds 100k, of which a 40k deposit is still unconfirmed (uncredited).
    const first = evaluateReconciliation({ ...base, balances: bal(100_000), outflowMsat: 0, receivedMsat: 60_000_000, onchainUncreditedMsat: 40_000_000 });
    // Run 2: the deposit was double-spent away.
    const second = evaluateReconciliation({ ...base, balances: bal(60_000), outflowMsat: 0, receivedMsat: 60_000_000, onchainUncreditedMsat: 0, previous: first.snapshot });
    expect(second.checks.find((c) => c.name === "balance_drop")).toMatchObject({ ok: true });
    // Without the on-chain input the same move would pause payouts.
    const legacy = evaluateReconciliation({ ...base, balances: bal(60_000), outflowMsat: 0, receivedMsat: 60_000_000, previous: { ...first.snapshot, receivedMsat: 60_000_000 } });
    expect(legacy.checks.find((c) => c.name === "balance_drop")).toMatchObject({ ok: false });
  });

  it("crediting a deposit moves it from uncredited to received without a change in expectations", () => {
    const first = evaluateReconciliation({ ...base, balances: bal(100_000), outflowMsat: 0, receivedMsat: 60_000_000, onchainUncreditedMsat: 40_000_000 });
    const second = evaluateReconciliation({ ...base, balances: bal(100_000), outflowMsat: 0, receivedMsat: 100_000_000, onchainUncreditedMsat: 0, previous: first.snapshot });
    expect(second.checks.find((c) => c.name === "balance_drop")).toMatchObject({ ok: true, msat: 0 });
  });

  it("skips balance_drop and keeps the baseline while a batch is in flight", async () => {
    let total = 100_000;
    const provider: LightningProvider = {
      createInvoice: async () => { throw new Error("x"); },
      checkSettlement: async () => ({ settled: false }),
      payInvoice: async () => ({ status: "failed" }),
      getBalances: async () => bal(total),
      listPayments: async () => ({ supported: true, payments: [], truncated: false })
    };
    const ledger: ReconcileLedger = { payoutsByPaymentHash: async () => new Map(), payoutsOutflowMsat: async () => 0, receivedPurchaseMsat: async () => 100_000_000 };
    let inFlight = false;
    let fee = 0;
    const paused: string[] = [];
    const r = new PayoutReconciler({ provider, ledger, config: { intervalMs: 0, toleranceSats: 1, lookbackMs: 60_000 }, coordinatorId: "c", pause: async (reason) => { paused.push(reason); } });
    let refreshed = 0;
    r.attachOnchain({ uncreditedDepositMsat: async () => 0, feeOutflowMsat: async () => fee * 1000, inFlight: async () => inFlight, beforeRun: async () => { refreshed += 1; } });
    expect((await r.run()).status).toBe("ok");
    // The batch left the node (amount is a payout row elsewhere; here only the fee EdgeCoder pays), not yet recorded.
    total = 99_000;
    inFlight = true;
    const mid = await r.run();
    expect(mid.checks.some((c) => c.name === "balance_drop")).toBe(false);
    // Recorded: the fee is outflow now, and the old baseline explains the drop.
    inFlight = false;
    fee = 1_000;
    expect((await r.run()).status).toBe("ok");
    expect(paused).toEqual([]);
    expect(refreshed).toBe(3);
  });
});
