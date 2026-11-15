import { describe, expect, it } from "vitest";
import { MockOnchainWallet, ONCHAIN_VBYTES_PER_PAYOUT, onchainConfigFromEnv, taprootAddressFor, type OnchainConfig } from "../../src/economy/onchain.js";
import { MemoryOnchainPayoutStore, OnchainPayoutService, batchLabel, edgecoderFeeTxId } from "../../src/economy/onchain-payouts.js";
import { MemoryPayoutStore, PayoutService } from "../../src/economy/payout-service.js";
import { MemoryPayoutPauseStore, PayoutPauseControl, type PayoutLimits } from "../../src/economy/payout-safeguards.js";
import { DEFAULT_PAYOUT_POLICY, type PayoutPolicy } from "../../src/economy/payouts.js";

const POOL = "network:fee_pool";
const addr = (i: number) => taprootAddressFor("regtest", new Uint8Array(32).fill(i));

function setup(opts: { config?: Partial<OnchainConfig>; limits?: PayoutLimits; holdMs?: number; earned?: Record<string, number>; earnedAtMs?: number } = {}) {
  let now = 10_000_000;
  const earned = { ...(opts.earned ?? { "acct-a": 200_000_000, "acct-b": 120_000_000 }) }; // msat
  const earnedAt = opts.earnedAtMs ?? 0;
  // Earnings are also cSats (1 cSat = 1 sat) in this fake ledger.
  const payouts = new MemoryPayoutStore(
    (id, cutoff) => (cutoff === undefined || earnedAt <= cutoff ? earned[id] ?? 0 : 0),
    (id) => (earned[id] ?? 0) / 1000
  );
  payouts.received = 10_000_000_000;
  const policy: PayoutPolicy = { ...DEFAULT_PAYOUT_POLICY, reserveBps: 0, network: "regtest", earningsHoldMs: opts.holdMs ?? 0 };
  const pause = new PayoutPauseControl({ store: new MemoryPayoutPauseStore(), envPaused: false });
  const payoutService = new PayoutService({ store: payouts, provider: {} as never, policy, coordinatorId: "c1", feePoolAccountId: POOL, pause, now: () => now });
  const store = new MemoryOnchainPayoutStore(payouts);
  const wallet = new MockOnchainWallet("regtest");
  wallet.feeRateSatVb = 10;
  const config: OnchainConfig = { ...onchainConfigFromEnv("regtest", { ONCHAIN_ENABLED: "1" }), payoutMinSats: 50_000, payoutIntervalMs: 3_600_000, payoutMaxFeeRateSatVb: 50, ...opts.config };
  const events: string[] = [];
  const paused: string[] = [];
  const paid: string[] = [];
  const make = () =>
    new OnchainPayoutService({
      store, payouts, payoutService, wallet, config, policy, limits: opts.limits, pause, coordinatorId: "c1", feePoolAccountId: POOL,
      now: () => now,
      onSecurityEvent: (e) => events.push(e),
      pausePayouts: async (reason) => { paused.push(reason); await pause.pause(reason, "reconciliation", "c1"); },
      onPaid: async (p) => { paid.push(p.payoutId); }
    });
  return { payouts, payoutService, store, wallet, config, pause, events, paused, paid, svc: make(), make, advance: (ms: number) => (now += ms), earned };
}

async function destinations(t: ReturnType<typeof setup>, accounts: string[]) {
  for (const [i, a] of accounts.entries()) await t.store.setOnchainDestination(a, addr(i + 1), "regtest");
}

describe("batched on-chain payouts", () => {
  it("pays every eligible account in one SendMany, then settles with the fee shared and the unused cap returned", async () => {
    const t = setup();
    await destinations(t, ["acct-a", "acct-b"]);
    const r = await t.svc.tick();
    expect(r).toMatchObject({ state: "broadcast", payouts: 2 });
    expect(t.wallet.sent).toHaveLength(1);
    const cap = 10 * ONCHAIN_VBYTES_PER_PAYOUT;
    // Host pays the fee: each output is payable minus its fee cap.
    expect(t.wallet.sent[0].outputs).toEqual({ [addr(1)]: 200_000 - cap, [addr(2)]: 120_000 - cap });
    expect(t.wallet.sent[0].satPerVbyte).toBe(10);
    expect(t.wallet.sent[0].label).toBe(batchLabel((r as { batchId: string }).batchId));
    const rows = await t.payouts.listPayouts("acct-a");
    expect(rows[0]).toMatchObject({ kind: "onchain", status: "pending", destination: addr(1), txid: t.wallet.sent[0].txid, maxFeeMsat: cap * 1000 });
    // Nothing more is payable while it is in flight.
    expect((await t.payoutService.balance("acct-a")).payableMsat).toBe(0);

    t.wallet.mine(1);
    t.advance(60_000);
    const r2 = await t.svc.tick();
    expect(r2.advanced).toMatchObject({ confirmed: 1 });
    const total = t.wallet.txs.find((x) => x.txid === t.wallet.sent[0].txid)!.totalFeesSats;
    const a = (await t.payouts.listPayouts("acct-a"))[0];
    const b = (await t.payouts.listPayouts("acct-b"))[0];
    expect(a.status).toBe("paid");
    expect(a.feeMsat + b.feeMsat).toBe(total * 1000);
    // Unused fee cap went back: the account's balance is down by amount + actual fee only.
    expect(await t.payouts.creditBalance("acct-a")).toBeCloseTo(200_000 - (200_000 - cap) - a.feeMsat / 1000, 6);
    expect(t.paid).toHaveLength(2);
    // No EdgeCoder fee when the hosts' caps covered the fee.
    expect(t.payouts.rows.find((x) => x.txId.startsWith("onchain_batch_fee:"))).toBeUndefined();
  });

  it("skips accounts below the minimum and does nothing until the interval passes", async () => {
    const t = setup({ earned: { "acct-a": 200_000_000, "acct-small": 40_000_000 } });
    await destinations(t, ["acct-a", "acct-small"]);
    expect(await t.svc.tick()).toMatchObject({ payouts: 1 });
    t.earned["acct-a"] = 400_000_000;
    t.wallet.mine(1);
    t.advance(60_000);
    expect(await t.svc.tick()).toMatchObject({ skipped: "not_due" });
    t.advance(3_600_000);
    expect(await t.svc.tick()).toMatchObject({ state: "broadcast", payouts: 1 });
  });

  it("waits while the fee estimate is above the cap", async () => {
    const t = setup({ config: { payoutMaxFeeRateSatVb: 20 } });
    await destinations(t, ["acct-a"]);
    t.wallet.feeRateSatVb = 21;
    expect(await t.svc.tick()).toMatchObject({ skipped: "fee_above_cap", feeRateSatVb: 21 });
    expect(t.wallet.sent).toHaveLength(0);
    expect(await t.payouts.listPayouts("acct-a")).toHaveLength(0);
  });

  it("with EdgeCoder paying the fee, outputs are the whole payable balance and the fee is a fee-pool spend", async () => {
    const t = setup({ config: { payoutFeePayer: "edgecoder" } });
    await destinations(t, ["acct-a"]);
    const r = await t.svc.tick();
    expect(t.wallet.sent[0].outputs).toEqual({ [addr(1)]: 200_000 });
    const fee = t.payouts.rows.find((x) => x.txId === edgecoderFeeTxId((r as { batchId: string }).batchId))!;
    expect(fee).toMatchObject({ accountId: POOL, type: "spend", credits: 0 });
    expect(fee.msat).toBe(t.wallet.txs[0].totalFeesSats * 1000);
    expect(await t.store.edgecoderFeeOutflowMsat()).toBe(fee.msat);
    t.wallet.mine(1);
    await t.svc.tick();
    expect((await t.payouts.listPayouts("acct-a"))[0]).toMatchObject({ status: "paid", feeMsat: 0 });
  });

  it("refuses invalid or wrong-network addresses and pays one account per address per batch", async () => {
    const t = setup({ earned: { "acct-a": 200_000_000, "acct-b": 200_000_000, "acct-c": 200_000_000 } });
    await t.store.setOnchainDestination("acct-a", addr(1), "regtest");
    await t.store.setOnchainDestination("acct-b", addr(1), "regtest");
    await t.store.setOnchainDestination("acct-c", taprootAddressFor("bitcoin", new Uint8Array(32).fill(3)), "regtest");
    expect(await t.svc.tick()).toMatchObject({ payouts: 1 });
    expect(Object.keys(t.wallet.sent[0].outputs)).toEqual([addr(1)]);
  });
});

describe("safeguards", () => {
  it("the kill switch stops a batch from being built", async () => {
    const t = setup();
    await destinations(t, ["acct-a"]);
    await t.pause.pause("test", "admin", "op");
    expect(await t.svc.tick()).toMatchObject({ skipped: "payouts_paused" });
    expect(t.wallet.sent).toHaveLength(0);
  });

  it("a pause that lands after reservation fails the batch before broadcast and releases the payouts", async () => {
    const t = setup();
    await destinations(t, ["acct-a"]);
    const realReserve = t.payouts.reservePayout.bind(t.payouts);
    t.payouts.reservePayout = async (...args) => {
      const r = await realReserve(...args);
      await t.pause.pause("landed mid-batch", "admin", "op");
      return r;
    };
    expect(await t.svc.tick()).toMatchObject({ state: "failed", error: "payouts_paused" });
    expect(t.wallet.sent).toHaveLength(0);
    expect((await t.payouts.listPayouts("acct-a"))[0].status).toBe("failed");
    expect(await t.payouts.creditBalance("acct-a")).toBeCloseTo(200_000, 6);
    expect(t.events).toContain("payout_blocked_paused");
  });

  it("clamps to the single-payout cap and lets the daily cap refuse the reservation", async () => {
    const t = setup({ limits: { maxSingleSats: 100_000, maxAccountDailySats: 0, maxGlobalDailySats: 0 } });
    await destinations(t, ["acct-a"]);
    await t.svc.tick();
    expect(t.wallet.sent[0].outputs[addr(1)]).toBe(100_000 - 10 * ONCHAIN_VBYTES_PER_PAYOUT);

    const d = setup({ limits: { maxSingleSats: 0, maxAccountDailySats: 50_000, maxGlobalDailySats: 0 } });
    await destinations(d, ["acct-a"]);
    expect(await d.svc.tick()).toMatchObject({ state: "failed", error: "nothing reserved" });
    expect(d.events).toContain("payout_limit_exceeded");
    expect(d.wallet.sent).toHaveLength(0);
  });

  it("respects the earnings hold", async () => {
    const t = setup({ holdMs: 24 * 3_600_000, earnedAtMs: 10_000_000 });
    await destinations(t, ["acct-a"]);
    expect(await t.svc.tick()).toMatchObject({ skipped: "nothing_to_pay" });
    t.advance(24 * 3_600_000);
    expect(await t.svc.tick()).toMatchObject({ state: "broadcast" });
  });

  it("does nothing while disabled", async () => {
    const t = setup({ config: { enabled: false } });
    expect(await t.svc.tick()).toEqual({ skipped: "disabled" });
  });
});

describe("crash safety: never double-pays across restarts", () => {
  it("a batch interrupted while reserving is failed on restart and its payouts released", async () => {
    const t = setup();
    await destinations(t, ["acct-a"]);
    const now = 10_000_000;
    await t.store.createBatch({ batchId: "b-crash", coordinatorId: "c1", state: "building", feeRateSatVb: 10, feePayer: "host", label: batchLabel("b-crash"), outputs: [], txid: null, totalFeeSats: null, confirmations: 0, error: null, createdAtMs: now, sendAttemptedAtMs: null, broadcastAtMs: null, confirmedAtMs: null });
    await t.payouts.reservePayout({ payoutId: "p1", accountId: "acct-a", coordinatorId: "c1", kind: "onchain", bolt11: "", paymentHash: "onchain:p1", amountMsat: 100_000_000, feeMsat: 0, maxFeeMsat: 0, status: "pending", destination: addr(1), batchId: "b-crash", createdAtMs: now }, () => Number.MAX_SAFE_INTEGER);
    const restarted = t.make();
    const r = await restarted.tick();
    expect(r.advanced).toMatchObject({ failed: 1 });
    expect((await t.store.getBatch("b-crash"))!.state).toBe("failed");
    expect(t.payouts.payouts.get("p1")!.status).toBe("failed");
    // The released earnings go out in a new batch (the retry), once.
    t.advance(3_600_000);
    await restarted.tick();
    expect(t.wallet.sent).toHaveLength(1);
  });

  it("a send that timed out but reached the node is found by its label, not sent again", async () => {
    const t = setup();
    await destinations(t, ["acct-a"]);
    t.wallet.failNextSend = { error: "UND_ERR_HEADERS_TIMEOUT", broadcastAnyway: true };
    expect(await t.svc.tick()).toMatchObject({ state: "pending", error: "UND_ERR_HEADERS_TIMEOUT" });
    // Restart: the new instance asks the node instead of sending again.
    const restarted = t.make();
    t.advance(3_600_000 * 2);
    const r = await restarted.tick();
    expect(r.advanced).toMatchObject({ broadcast: 1 });
    // Nothing else is payable: the in-flight payout still holds the balance.
    expect(r).toMatchObject({ skipped: "nothing_to_pay" });
    expect(t.wallet.sent).toHaveLength(1);
    const p = (await t.payouts.listPayouts("acct-a"))[0];
    expect(p.txid).toBe(t.wallet.sent[0].txid);
    t.wallet.mine(1);
    await restarted.tick();
    expect((await t.payouts.listPayouts("acct-a"))[0].status).toBe("paid");
    expect(t.wallet.sent).toHaveLength(1);
  });

  it("an unknown send outcome stays pending through the grace period, then fails and releases if the node never had it", async () => {
    const t = setup({ config: { broadcastGraceMs: 600_000 } });
    await destinations(t, ["acct-a"]);
    t.wallet.failNextSend = { error: "socket hang up" };
    await t.svc.tick();
    t.advance(300_000);
    expect((await t.svc.tick()).skipped).toBe("batch_open");
    expect((await t.payouts.listPayouts("acct-a"))[0].status).toBe("pending");
    t.advance(400_000);
    const r = await t.svc.tick();
    expect(r.advanced).toMatchObject({ failed: 1 });
    expect((await t.payouts.listPayouts("acct-a")).map((p) => p.status)).toEqual(expect.arrayContaining(["failed"]));
  });

  it("a final refusal from the node fails the batch at once", async () => {
    const t = setup();
    await destinations(t, ["acct-a"]);
    t.wallet.failNextSend = { error: "lnd_sendmany_http_500:insufficient funds available to construct transaction" };
    expect(await t.svc.tick()).toMatchObject({ state: "failed" });
    expect((await t.payouts.listPayouts("acct-a"))[0].status).toBe("failed");
  });

  it("a released batch whose transaction turns up later pauses all payouts", async () => {
    const t = setup({ config: { broadcastGraceMs: 600_000 } });
    await destinations(t, ["acct-a"]);
    t.wallet.failNextSend = { error: "socket hang up" };
    const r = await t.svc.tick();
    t.advance(700_000);
    await t.svc.tick();
    expect((await t.store.getBatch((r as { batchId: string }).batchId))!.state).toBe("failed");
    // The node had it after all (e.g. LND was unreachable during the grace period).
    const batch = (await t.store.getBatch((r as { batchId: string }).batchId))!;
    t.wallet.txs.push({ txid: "f".repeat(64), amountSats: -1, confirmations: 0, blockHeight: 0, totalFeesSats: 100, label: batch.label, timestampMs: 0, outputs: [] });
    const r2 = await t.svc.tick();
    expect(r2.advanced).toMatchObject({ resurfaced: 1 });
    expect(t.paused).toHaveLength(1);
    expect(await t.pause.isPaused()).toBe(true);
    expect(t.events).toContain("onchain_batch_resurfaced");
    // Reported once.
    await t.svc.tick();
    expect(t.paused).toHaveLength(1);
  });

  it("only one runner at a time", async () => {
    const t = setup();
    await destinations(t, ["acct-a"]);
    const other = t.make();
    const [x, y] = await Promise.all([t.svc.tick(), other.tick()]);
    expect([x, y].filter((r) => r.skipped === "locked")).toHaveLength(1);
    expect(t.wallet.sent).toHaveLength(1);
  });

  it("reports in-flight while a send outcome is unrecorded (reconciliation waits)", async () => {
    const t = setup();
    await destinations(t, ["acct-a"]);
    t.wallet.failNextSend = { error: "socket hang up" };
    await t.svc.tick();
    expect(await t.svc.inFlight()).toBe(true);
  });
});
