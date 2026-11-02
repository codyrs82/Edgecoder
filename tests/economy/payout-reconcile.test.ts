import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { randomBytes } from "node:crypto";
import {
  ClnRestProvider,
  LndRestProvider,
  MockLightningProvider,
  interpretClnBalances,
  interpretClnPays,
  interpretLndBalances,
  interpretLndPayments,
  type LightningProvider,
  type NodeBalances,
  type NodePayment
} from "../../src/economy/lightning.js";
import { PayoutReconciler, alertSummary, evaluateReconciliation, payoutReconcileConfigFromEnv, type ReconcileLedger } from "../../src/economy/payout-reconcile.js";
import { MemoryPayoutStore } from "../../src/economy/payout-service.js";
import type { PayoutRecord } from "../../src/common/types.js";
import { encodeTestBolt11 } from "./helpers/bolt11-encode.js";

const hash = () => randomBytes(32).toString("hex");
const bal = (totalSats: number): NodeBalances => ({ supported: true, onchainConfirmedSats: 0, onchainUnconfirmedSats: 0, channelLocalSats: totalSats, channelPendingSats: 0, totalSats });
const pay = (paymentHash: string, valueMsat: number, status: NodePayment["status"] = "succeeded", feeMsat = 0): NodePayment => ({ paymentHash, status, valueMsat, feeMsat, createdAtMs: 1 });
const row = (paymentHash: string, amountMsat: number, status: PayoutRecord["status"] = "paid", feeMsat = 0) => ({ paymentHash, status, amountMsat, feeMsat, maxFeeMsat: 0 });

describe("evaluateReconciliation", () => {
  const base = { nowMs: 10, outflowMsat: 0, receivedMsat: 0, toleranceSats: 1 };

  it("all clear when every node payment matches a paid payout", () => {
    const h = hash();
    const { checks } = evaluateReconciliation({ ...base, balances: bal(100), payments: [pay(h, 5_000, "succeeded", 10)], ledgerRows: new Map([[h, row(h, 5_000, "paid", 10)]]) });
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("a node payment with no payout row beyond tolerance trips unknown_payments (failed node payments don't count)", () => {
    const h = hash();
    const { checks } = evaluateReconciliation({ ...base, balances: bal(100), payments: [pay(h, 5_000), pay(hash(), 9_000_000, "failed")], ledgerRows: new Map() });
    expect(checks.find((c) => c.name === "unknown_payments")).toMatchObject({ ok: false, pauses: true, msat: 5_000, paymentHashes: [h] });
    const small = evaluateReconciliation({ ...base, balances: bal(100), payments: [pay(hash(), 999)], ledgerRows: new Map() });
    expect(small.checks.find((c) => c.name === "unknown_payments")?.ok).toBe(true);
  });

  it("a payout marked failed that the node sent (or still has in flight) trips ledger_freed", () => {
    const h = hash();
    const { checks } = evaluateReconciliation({ ...base, balances: bal(100), payments: [pay(h, 5_000, "in_flight")], ledgerRows: new Map([[h, row(h, 5_000, "failed")]]) });
    expect(checks.find((c) => c.name === "ledger_freed")).toMatchObject({ ok: false, pauses: true });
  });

  it("node amount vs ledger amount for paid payouts beyond tolerance trips paid_mismatch", () => {
    const h = hash();
    const { checks } = evaluateReconciliation({ ...base, balances: bal(100), payments: [pay(h, 50_000)], ledgerRows: new Map([[h, row(h, 5_000)]]) });
    expect(checks.find((c) => c.name === "paid_mismatch")).toMatchObject({ ok: false, msat: 45_000 });
  });

  it("balance drop: explained by purchases in and payouts out, unexplained beyond tolerance trips", () => {
    const previous = { atMs: 1, nodeTotalMsat: 100_000_000, outflowMsat: 0, receivedMsat: 0 };
    // +50k sats purchases, -30k sats payouts: 120k expected.
    const fine = evaluateReconciliation({ ...base, balances: bal(120_000), payments: [], ledgerRows: new Map(), previous, receivedMsat: 50_000_000, outflowMsat: 30_000_000 });
    expect(fine.checks.find((c) => c.name === "balance_drop")?.ok).toBe(true);
    const drop = evaluateReconciliation({ ...base, balances: bal(110_000), payments: [], ledgerRows: new Map(), previous, receivedMsat: 50_000_000, outflowMsat: 30_000_000 });
    expect(drop.checks.find((c) => c.name === "balance_drop")).toMatchObject({ ok: false, pauses: true, msat: 10_000_000 });
    // First run: no baseline, no drop check.
    expect(evaluateReconciliation({ ...base, balances: bal(1), payments: [], ledgerRows: new Map() }).checks.some((c) => c.name === "balance_drop")).toBe(false);
  });

  it("a liability shortfall alerts without pausing", () => {
    const { checks } = evaluateReconciliation({ ...base, balances: bal(100), payments: [], ledgerRows: new Map(), liabilitiesMsat: 500_000 });
    expect(checks.find((c) => c.name === "liability_shortfall")).toMatchObject({ ok: false, pauses: false, msat: 400_000 });
  });
});

function fakeProvider(state: { balanceSats: number; payments: NodePayment[]; fail?: string }): LightningProvider {
  return {
    createInvoice: async () => { throw new Error("n/a"); },
    checkSettlement: async () => ({ settled: false }),
    payInvoice: async () => ({ status: "failed", error: "n/a" }),
    getBalances: async () => { if (state.fail) throw new Error(state.fail); return bal(state.balanceSats); },
    listPayments: async () => ({ supported: true, payments: state.payments, truncated: false })
  };
}

describe("PayoutReconciler", () => {
  function setup(state: { balanceSats: number; payments: NodePayment[]; fail?: string }, ledger?: Partial<ReconcileLedger>) {
    const store = new MemoryPayoutStore(() => 0);
    const paused: string[] = [];
    const alerts: string[] = [];
    const posted: unknown[] = [];
    const r = new PayoutReconciler({
      provider: fakeProvider(state),
      ledger: { ...ledgerOf(store), ...ledger },
      config: { intervalMs: 60_000, toleranceSats: 1, lookbackMs: 86_400_000 },
      coordinatorId: "coord-a",
      pause: async (reason) => { paused.push(reason); },
      onAlert: (res) => alerts.push(res.status),
      webhookUrl: "https://alerts.example/hook",
      postJson: async (_url, body) => { posted.push(body); }
    });
    return { r, store, paused, alerts, posted };
  }
  const ledgerOf = (s: MemoryPayoutStore): ReconcileLedger => ({
    payoutsByPaymentHash: (h) => s.payoutsByPaymentHash(h),
    payoutsOutflowMsat: () => s.payoutsOutflowMsat(),
    receivedPurchaseMsat: () => s.receivedPurchaseMsat(),
    liabilitiesMsat: () => s.liabilitiesMsat()
  });

  it("ok run: no pause, no alert, no webhook; result kept for admins", async () => {
    const { r, paused, alerts, posted } = setup({ balanceSats: 1_000, payments: [] });
    expect((await r.run()).status).toBe("ok");
    expect(r.last()?.status).toBe("ok");
    expect([paused, alerts, posted]).toEqual([[], [], []]);
  });

  it("an unknown node payment pauses payouts, raises an alert and posts a summary without secrets", async () => {
    const h = hash();
    const { r, paused, alerts, posted } = setup({ balanceSats: 1_000, payments: [pay(h, 50_000_000)] });
    const res = await r.run();
    expect(res.status).toBe("tripped");
    expect(paused).toEqual(["reconciliation: unknown_payments"]);
    expect(alerts).toEqual(["tripped"]);
    expect(posted).toHaveLength(1);
    const body = posted[0] as Record<string, unknown>;
    expect(body).toMatchObject({ event: "payout_reconciliation_alert", coordinatorId: "coord-a", status: "tripped", payoutsPaused: true });
    expect(JSON.stringify(body)).toContain(h);
    expect(JSON.stringify(body)).not.toMatch(/preimage|macaroon|bolt11|token|lnbc|lntb/i);
  });

  it("detects a balance drop on the second run against the first run's baseline", async () => {
    const state = { balanceSats: 100_000, payments: [] as NodePayment[] };
    const { r, paused } = setup(state);
    expect((await r.run()).status).toBe("ok");
    state.balanceSats = 40_000;
    expect((await r.run()).status).toBe("tripped");
    expect(paused[0]).toMatch(/balance_drop/);
  });

  it("an unreadable node is an error alert, not a pause; a webhook failure never throws", async () => {
    const { r, paused, alerts } = setup({ balanceSats: 0, payments: [], fail: "lnd_http_500:/v1/balance/blockchain" });
    const res = await r.run();
    expect(res).toMatchObject({ status: "error", error: "lnd_http_500:/v1/balance/blockchain" });
    expect(paused).toEqual([]);
    expect(alerts).toEqual(["error"]);

    const broken = new PayoutReconciler({
      provider: fakeProvider({ balanceSats: 1, payments: [pay(hash(), 9_000_000)] }),
      ledger: ledgerOf(new MemoryPayoutStore(() => 0)),
      config: { intervalMs: 0, toleranceSats: 0, lookbackMs: 1 },
      coordinatorId: "c",
      pause: async () => {},
      webhookUrl: "https://alerts.example/hook",
      postJson: async () => { throw new Error("webhook down"); }
    });
    await expect(broken.run()).resolves.toMatchObject({ status: "tripped" });
  });

  it("a provider without reconciliation queries is reported unsupported", async () => {
    const r = new PayoutReconciler({
      provider: { createInvoice: async () => { throw new Error(); }, checkSettlement: async () => ({ settled: false }), payInvoice: async () => ({ status: "failed" }) },
      ledger: ledgerOf(new MemoryPayoutStore(() => 0)),
      config: { intervalMs: 0, toleranceSats: 0, lookbackMs: 1 },
      coordinatorId: "c",
      pause: async () => { throw new Error("must not pause"); }
    });
    expect((await r.run()).status).toBe("unsupported");
  });

  it("alertSummary carries no payout invoices or preimages", () => {
    const s = alertSummary("c", { atMs: 0, status: "alert", checks: [{ name: "liability_shortfall", ok: false, pauses: false, detail: "d", msat: 1 }] }, false);
    expect(Object.keys(s).sort()).toEqual(["at", "atMs", "coordinatorId", "error", "event", "failedChecks", "ledger", "node", "payoutsPaused", "status"]);
  });

  it("config: defaults, minimum interval, 0 disables", () => {
    expect(payoutReconcileConfigFromEnv({})).toEqual({ intervalMs: 600_000, toleranceSats: 1_000, lookbackMs: 86_400_000 });
    expect(payoutReconcileConfigFromEnv({ PAYOUT_RECONCILE_MS: "5" }).intervalMs).toBe(60_000);
    expect(payoutReconcileConfigFromEnv({ PAYOUT_RECONCILE_MS: "0" }).intervalMs).toBe(0);
    expect(() => payoutReconcileConfigFromEnv({ PAYOUT_RECONCILE_TOLERANCE_SATS: "x" })).toThrow();
  });
});

describe("provider reconciliation reads", () => {
  it("LND balance and payment parsing fails closed on missing/garbage fields", () => {
    expect(interpretLndBalances({ confirmed_balance: "1000", unconfirmed_balance: "5" }, { local_balance: { sat: "2000" }, pending_open_local_balance: { sat: "7" }, unsettled_local_balance: { sat: "3" } })).toMatchObject({ totalSats: 3_015, channelPendingSats: 10 });
    expect(() => interpretLndBalances({}, { local_balance: { sat: "1" } })).toThrow(/confirmed_balance/);
    expect(() => interpretLndBalances({ confirmed_balance: "1" }, { local_balance: { sat: "-1" } })).toThrow(/local_balance/);
    const h = hash();
    expect(interpretLndPayments({ payments: [{ payment_hash: h, value_msat: "5000", fee_msat: "10", status: "SUCCEEDED", creation_time_ns: "2000000000" }, { payment_hash: h, value_msat: "1", status: "INITIATED" }] })).toEqual([
      { paymentHash: h, status: "succeeded", valueMsat: 5_000, feeMsat: 10, createdAtMs: 2_000 },
      { paymentHash: h, status: "in_flight", valueMsat: 1, feeMsat: 0, createdAtMs: 0 }
    ]);
    expect(() => interpretLndPayments({})).toThrow(/payments/);
    expect(() => interpretLndPayments({ payments: [{ payment_hash: "zz", value_msat: "1" }] })).toThrow(/payment_hash/);
  });

  it("CLN balance and listpays parsing", () => {
    expect(interpretClnBalances({ confBalance: 10, unconfBalance: 0 }, { localBalance: "20", pendingBalance: 5 }).totalSats).toBe(35);
    expect(() => interpretClnBalances({}, { localBalance: 1 })).toThrow();
    const h = hash();
    expect(interpretClnPays({ pays: [{ payment_hash: h, status: "complete", amount_msat: "1000msat", amount_sent_msat: "1010msat", created_at: 100 }, { payment_hash: hash(), status: "complete", amount_msat: 1, amount_sent_msat: 1, created_at: 1 }] }, 50_000)).toEqual([
      { paymentHash: h, status: "succeeded", valueMsat: 1_000, feeMsat: 10, createdAtMs: 100_000 }
    ]);
    expect(() => interpretClnPays({ pays: [{ payment_hash: h, status: "complete", created_at: 100 }] }, 0)).toThrow(/amount/);
  });

  it("mock provider tracks settled purchases and payouts", async () => {
    const m = new MockLightningProvider(1_000);
    const inv = await m.createInvoice({ amountSats: 500, memo: "m", expiresInSeconds: 60 });
    await m.checkSettlement(inv.invoiceRef);
    await m.checkSettlement(inv.invoiceRef); // settles once
    const h = hash();
    await m.payInvoice({ bolt11: encodeTestBolt11({ network: "tbs", amountMsat: 200_000, paymentHashHex: h }), maxFeeSats: 10 });
    expect((await m.getBalances()).totalSats).toBe(1_300);
    expect((await m.listPayments({ sinceMs: 0 })).payments).toEqual([expect.objectContaining({ paymentHash: h, valueMsat: 200_000, status: "succeeded" })]);
  });

  describe("over HTTP", () => {
    let original: Dispatcher;
    let agent: MockAgent;
    beforeEach(() => {
      original = getGlobalDispatcher();
      agent = new MockAgent();
      agent.disableNetConnect();
      setGlobalDispatcher(agent);
    });
    afterEach(async () => {
      setGlobalDispatcher(original);
      await agent.close();
    });

    it("LND: GETs the balance endpoints and /v1/payments with the macaroon; HTTP errors throw", async () => {
      const lnd = agent.get("https://lnd.test:8080");
      const mac = { headers: { "grpc-metadata-macaroon": "mac" } };
      lnd.intercept({ path: "/v1/balance/blockchain", method: "GET", ...mac }).reply(200, { confirmed_balance: "100", unconfirmed_balance: "0" });
      lnd.intercept({ path: "/v1/balance/channels", method: "GET", ...mac }).reply(200, { local_balance: { sat: "50" } });
      lnd.intercept({ path: (p) => p.startsWith("/v1/payments?") && ["include_incomplete=true", "max_payments=10", "creation_date_start=1700000000"].every((q) => p.includes(q)), method: "GET", ...mac }).reply(200, { payments: [] });
      const p = new LndRestProvider("https://lnd.test:8080", "mac");
      expect((await p.getBalances()).totalSats).toBe(150);
      expect(await p.listPayments({ sinceMs: 1_700_000_000_000, limit: 10 })).toEqual({ supported: true, payments: [], truncated: false });
      lnd.intercept({ path: "/v1/balance/blockchain", method: "GET" }).reply(500, {});
      lnd.intercept({ path: "/v1/balance/channels", method: "GET" }).reply(200, { local_balance: { sat: "50" } });
      await expect(p.getBalances()).rejects.toThrow(/lnd_http_500/);
    });

    it("CLN: c-lightning-REST balance and listPays", async () => {
      const cln = agent.get("https://cln.test:3001");
      cln.intercept({ path: "/v1/getBalance", method: "GET" }).reply(200, { confBalance: 10, unconfBalance: 0 });
      cln.intercept({ path: "/v1/channel/localremotebal", method: "GET" }).reply(200, { localBalance: 5, pendingBalance: 0 });
      cln.intercept({ path: "/v1/pay/listPays", method: "GET" }).reply(200, { pays: [] });
      const p = new ClnRestProvider("https://cln.test:3001", "tok");
      expect((await p.getBalances()).totalSats).toBe(15);
      expect((await p.listPayments({ sinceMs: 0 })).payments).toEqual([]);
    });
  });
});
