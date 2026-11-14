// Only a failure the node itself reports as final frees a payout's balance; anything else keeps the
// row pending, since the HTLC may still settle. No Lightning node is contacted: HTTP is mocked.
import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { ClnRestProvider, LndRestProvider, payFailureIsFinal, type LightningProvider, type PayInvoiceResult } from "../../src/economy/lightning.js";
import { MemoryPayoutStore, PayoutService } from "../../src/economy/payout-service.js";
import { DEFAULT_PAYOUT_POLICY } from "../../src/economy/payouts.js";
import { encodeTestBolt11 } from "./helpers/bolt11-encode.js";

describe("payFailureIsFinal", () => {
  it("is true only for failures the node reported as final, or a payment never sent", () => {
    for (const e of ["payouts_paused", "lnd_pay_error:unable to find a path to destination", "lnd_pay_error:invoice expired", "lnd_pay_failed:FAILURE_REASON_NO_ROUTE", "lnd_pay_failed:FAILURE_REASON_TIMEOUT", "cln_pay_status:failed"]) {
      expect(payFailureIsFinal(e), e).toBe(true);
    }
    for (const e of [
      undefined,
      "",
      "lnd_pay_transport:timeout",
      "cln_pay_transport:socket hang up",
      "lnd_pay_http_504:",
      "lnd_pay_http_500:",
      "cln_pay_http_500:",
      "cln_pay_status:pending",
      "cln_pay_status:unknown",
      "cln_pay_status:complete",
      "lnd_pay_no_preimage",
      "lnd_pay_preimage_mismatch",
      "lnd_pay_unconfirmed:IN_FLIGHT",
      "lnd_pay_unconfirmed:no_final_status",
      "lnd_pay_stream_error:context canceled",
      "lnd_pay_failed:FAILURE_REASON_NONE",
      "lnd_pay_failed:unknown",
      "lnd_pay_error:invoice is already paid",
      "lnd_pay_error:payment is in transition",
      "pay_failed",
      "n/a"
    ]) {
      expect(payFailureIsFinal(e), String(e)).toBe(false);
    }
  });
});

describe("provider responses, classified", () => {
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
  const input = { bolt11: "lnbcrt1test", maxFeeSats: 10, timeoutSeconds: 1 };

  it("LND: a proxy 504 or an unreadable 2xx body stays unconfirmed; payment_error is final", async () => {
    const lnd = new LndRestProvider("https://lnd.test:8080", "mac");
    const pool = agent.get("https://lnd.test:8080");
    pool.intercept({ path: "/v2/router/send", method: "POST" }).reply(504, "Gateway Timeout");
    pool.intercept({ path: "/v2/router/send", method: "POST" }).reply(200, "<html>");
    pool.intercept({ path: "/v2/router/send", method: "POST" }).reply(200, JSON.stringify({ error: { code: 2, message: "unable to find a path to destination" } }) + "\n");
    const results = [await lnd.payInvoice(input), await lnd.payInvoice(input), await lnd.payInvoice(input)];
    expect(results.map((r) => r.status)).toEqual(["failed", "failed", "failed"]);
    expect(results.map((r) => payFailureIsFinal(r.error))).toEqual([false, false, true]);
  });

  it("CLN: status pending and HTTP errors stay unconfirmed; status failed is final", async () => {
    const cln = new ClnRestProvider("https://cln.test:3001", "tok");
    const pool = agent.get("https://cln.test:3001");
    pool.intercept({ path: "/v1/pay", method: "POST" }).reply(200, { status: "pending", payment_hash: "ab".repeat(32) });
    pool.intercept({ path: "/v1/pay", method: "POST" }).reply(500, { error: "something" });
    pool.intercept({ path: "/v1/pay", method: "POST" }).reply(200, { status: "failed" });
    const results = [await cln.payInvoice(input), await cln.payInvoice(input), await cln.payInvoice(input)];
    expect(results.map((r) => payFailureIsFinal(r.error))).toEqual([false, false, true]);
  });
});

describe("PayoutService keeps unconfirmed payouts pending", () => {
  const policy = { ...DEFAULT_PAYOUT_POLICY, network: "signet" as const };
  function setup(pay: (hash: string) => PayInvoiceResult) {
    const preimage = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    const bolt11 = encodeTestBolt11({ network: "tbs", amountMsat: 2_000_000, paymentHashHex: hash });
    const store = new MemoryPayoutStore(() => 10_000_000, () => 10_000);
    store.received = 1_000_000_000;
    const provider: LightningProvider = { createInvoice: async () => { throw new Error("n/a"); }, checkSettlement: async () => ({ settled: false }), payInvoice: async () => pay(hash) };
    const svc = new PayoutService({ store, provider, policy, coordinatorId: "c", feePoolAccountId: "pool" });
    return { store, svc, bolt11, preimage };
  }

  it("a CLN pending or a proxy 504 leaves the row pending and the balance held", async () => {
    for (const error of ["cln_pay_status:pending", "lnd_pay_http_504:", "cln_pay_http_502:"]) {
      const { store, svc, bolt11 } = setup(() => ({ status: "failed", error }));
      expect(await svc.withdraw("a", bolt11)).toMatchObject({ ok: false, code: "payout_unconfirmed" });
      expect([...store.payouts.values()][0].status).toBe("pending");
      expect((await svc.balance("a")).payableMsat).toBeLessThan(10_000_000 - 2_000_000 + 1);
    }
  });

  it("a final node failure, or a refusal before sending, frees the balance", async () => {
    for (const error of ["lnd_pay_error:unable to find a path to destination", "cln_pay_status:failed", "payouts_paused"]) {
      const { store, svc, bolt11 } = setup(() => ({ status: "failed", error }));
      expect(await svc.withdraw("a", bolt11)).toMatchObject({ ok: false, code: "payout_failed" });
      expect([...store.payouts.values()][0].status).toBe("failed");
      expect((await svc.balance("a")).payableMsat).toBe(10_000_000);
    }
  });

  it("a success for another payment hash is not accepted as paid", async () => {
    const { store, svc, bolt11, preimage } = setup(() => ({ status: "succeeded", paymentHash: "cd".repeat(32), preimage, feeMsat: 0 }));
    expect(await svc.withdraw("a", bolt11)).toMatchObject({ ok: false, code: "payout_unconfirmed" });
    expect([...store.payouts.values()][0].status).toBe("pending");
  });

  it("a success for the invoice's own hash (any case) is paid", async () => {
    const { store, svc, bolt11, preimage } = setup((hash) => ({ status: "succeeded", paymentHash: hash.toUpperCase(), preimage, feeMsat: 0 }));
    expect((await svc.withdraw("a", bolt11)).ok).toBe(true);
    expect([...store.payouts.values()][0].status).toBe("paid");
  });
});
