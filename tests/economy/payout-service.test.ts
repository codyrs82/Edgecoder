import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryPayoutStore, PayoutService } from "../../src/economy/payout-service.js";
import { DEFAULT_PAYOUT_POLICY, distributeFeePool, hostWeight, lnurlPayEndpoint, requestLnurlInvoice, validatePayoutRequest } from "../../src/economy/payouts.js";
import type { LightningProvider, PayInvoiceInput, PayInvoiceResult } from "../../src/economy/lightning.js";
import { encodeTestBolt11 } from "./helpers/bolt11-encode.js";

const policy = { ...DEFAULT_PAYOUT_POLICY, network: "signet" as const };
function invoice(amountMsat: number | undefined, preimage = randomBytes(32).toString("hex")) {
  const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  return { bolt11: encodeTestBolt11({ network: "tbs", amountMsat, paymentHashHex: hash }), hash, preimage };
}
function provider(behaviour: (input: PayInvoiceInput) => PayInvoiceResult): LightningProvider {
  return { createInvoice: async () => { throw new Error("n/a"); }, checkSettlement: async () => ({ settled: false }), payInvoice: async (i) => behaviour(i) };
}

describe("validatePayoutRequest", () => {
  it("rejects wrong network, amountless, below minimum, over payable, over capacity; accepts a good invoice", () => {
    const good = invoice(2_000_000); // 2,000 sats
    expect(validatePayoutRequest({ bolt11: good.bolt11, payableMsat: 5_000_000, capacityMsat: 10_000_000 }, policy)).toMatchObject({ ok: true, amountMsat: 2_000_000 });
    expect(validatePayoutRequest({ bolt11: good.bolt11, payableMsat: 5_000_000, capacityMsat: 10_000_000 }, { ...policy, network: "bitcoin" })).toMatchObject({ ok: false, code: "wrong_network" });
    expect(validatePayoutRequest({ bolt11: invoice(undefined).bolt11, payableMsat: 5_000_000, capacityMsat: 10_000_000 }, policy)).toMatchObject({ ok: false, code: "amountless_invoice" });
    expect(validatePayoutRequest({ bolt11: invoice(500_000).bolt11, payableMsat: 5_000_000, capacityMsat: 10_000_000 }, policy)).toMatchObject({ ok: false, code: "below_minimum" });
    expect(validatePayoutRequest({ bolt11: good.bolt11, payableMsat: 1_000_000, capacityMsat: 10_000_000 }, policy)).toMatchObject({ ok: false, code: "insufficient_payable" });
    expect(validatePayoutRequest({ bolt11: good.bolt11, payableMsat: 5_000_000, capacityMsat: 2_005_000 }, policy)).toMatchObject({ ok: false, code: "coordinator_capacity" });
    expect(validatePayoutRequest({ bolt11: "nope", payableMsat: 1, capacityMsat: 1 }, policy)).toMatchObject({ ok: false, code: "invalid_invoice" });
    expect(validatePayoutRequest({ bolt11: good.bolt11, payableMsat: 5_000_000, capacityMsat: 10_000_000 }, { ...policy, enabled: false })).toMatchObject({ ok: false, code: "payouts_disabled" });
  });
  it("pays regtest invoices only when configured for regtest", () => {
    const bolt11 = encodeTestBolt11({ network: "bcrt", amountMsat: 2_000_000, paymentHashHex: "ab".repeat(32) });
    expect(validatePayoutRequest({ bolt11, payableMsat: 5_000_000, capacityMsat: 10_000_000 }, { ...policy, network: "regtest" })).toMatchObject({ ok: true });
    expect(validatePayoutRequest({ bolt11, payableMsat: 5_000_000, capacityMsat: 10_000_000 }, { ...policy, network: "testnet" })).toMatchObject({ ok: false, code: "wrong_network" });
  });
});

describe("PayoutService.withdraw", () => {
  function setup(earned: number, received: number, pay: (i: PayInvoiceInput) => PayInvoiceResult) {
    const store = new MemoryPayoutStore(() => earned);
    store.received = received;
    const paid: string[] = [];
    const svc = new PayoutService({ store, provider: provider(pay), policy, coordinatorId: "coord", feePoolAccountId: "network:fee_pool", onPaid: async (p) => { paid.push(p.payoutId); } });
    return { store, svc, paid };
  }

  it("pays a valid invoice once, records fee and preimage, and refuses the same invoice again", async () => {
    const inv = invoice(2_000_000);
    const { svc, store, paid } = setup(10_000_000, 100_000_000, () => ({ status: "succeeded", preimage: inv.preimage, feeMsat: 1_500 }));
    const r = await svc.withdraw("acct", inv.bolt11);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payout).toMatchObject({ status: "paid", amountMsat: 2_000_000, feeMsat: 1_500, preimage: inv.preimage });
    expect(paid).toHaveLength(1);
    expect((await svc.balance("acct")).payableMsat).toBe(10_000_000 - 2_001_500);
    expect(await svc.withdraw("acct", inv.bolt11)).toMatchObject({ ok: false, code: "duplicate_invoice" });
    expect(store.payouts.size).toBe(1);
  });

  it("never pays beyond what the node received from purchases (capacity with reserve)", async () => {
    const inv = invoice(2_000_000);
    const { svc } = setup(10_000_000, 2_000_000, () => ({ status: "succeeded" }));
    const r = await svc.withdraw("acct", inv.bolt11);
    expect(r).toMatchObject({ ok: false, code: "coordinator_capacity" });
  });

  it("a definite node failure marks the payout failed and frees the balance; a transport failure leaves it pending", async () => {
    const a = invoice(2_000_000);
    const { svc, store } = setup(10_000_000, 100_000_000, () => ({ status: "failed", error: "lnd_pay_error:no route" }));
    expect(await svc.withdraw("acct", a.bolt11)).toMatchObject({ ok: false, code: "payout_failed" });
    expect([...store.payouts.values()][0].status).toBe("failed");
    expect((await svc.balance("acct")).payableMsat).toBe(10_000_000);

    const b = invoice(2_000_000);
    const t = setup(10_000_000, 100_000_000, () => ({ status: "failed", error: "lnd_pay_transport:timeout" }));
    expect(await t.svc.withdraw("acct", b.bolt11)).toMatchObject({ ok: false, code: "payout_unconfirmed" });
    expect([...t.store.payouts.values()][0].status).toBe("pending");
    expect((await t.svc.balance("acct")).payableMsat).toBe(10_000_000 - 2_000_000 - 0); // pending counts against payable
  });

  it("a preimage that does not match the invoice is not accepted as paid", async () => {
    const inv = invoice(2_000_000);
    const { svc, store } = setup(10_000_000, 100_000_000, () => ({ status: "succeeded", preimage: "00".repeat(32) }));
    expect(await svc.withdraw("acct", inv.bolt11)).toMatchObject({ ok: false, code: "payout_unconfirmed" });
    expect([...store.payouts.values()][0].status).toBe("pending");
  });
});

describe("auto payouts over LNURL-pay", () => {
  it("resolves a Lightning address, fetches an invoice for the payable amount, and pays it", async () => {
    expect(lnurlPayEndpoint("cody@example.com")).toBe("https://example.com/.well-known/lnurlp/cody");
    expect(() => lnurlPayEndpoint("not an address")).toThrow(/invalid_lightning_address/);
    const preimage = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
    const seen: string[] = [];
    const fetcher = async (url: string): Promise<unknown> => {
      seen.push(url);
      if (url.endsWith("/.well-known/lnurlp/cody")) return { tag: "payRequest", callback: "https://example.com/lnurlp/cody/cb", minSendable: 1_000, maxSendable: 1e11 };
      const amount = Number(new URL(url).searchParams.get("amount"));
      return { pr: encodeTestBolt11({ network: "tbs", amountMsat: amount, paymentHashHex: hash }) };
    };
    const got = await requestLnurlInvoice("cody@example.com", 5_000_000, fetcher, "signet");
    expect(got.decoded.amountMsat).toBe(5_000_000);
    await expect(requestLnurlInvoice("cody@example.com", 5_000_000, fetcher, "bitcoin")).rejects.toThrow(/wrong_network/);

    const store = new MemoryPayoutStore(() => 50_000_000); // 50k sats earned
    store.received = 1_000_000_000;
    store.autoAccounts.set("acct", "cody@example.com");
    const svc = new PayoutService({ store, provider: provider(() => ({ status: "succeeded", preimage, feeMsat: 100 })), policy, coordinatorId: "c", feePoolAccountId: "pool", fetcher });
    const results = await svc.runAutoPayouts();
    expect(results).toHaveLength(1);
    expect(results[0].result.ok).toBe(true);
    const p = [...store.payouts.values()][0];
    expect(p.kind).toBe("auto");
    expect(p.destination).toBe("cody@example.com");
    // amount leaves room for the fee cap: (50,000,000 / 1.01) - 10,000 msat floor
    expect(p.amountMsat).toBe(Math.floor(50_000_000 / 1.01) - 10_000);
    // below the auto minimum nothing is paid
    const small = new MemoryPayoutStore(() => 1_000_000);
    small.autoAccounts.set("acct", "cody@example.com");
    const svc2 = new PayoutService({ store: small, provider: provider(() => ({ status: "succeeded" })), policy, coordinatorId: "c", feePoolAccountId: "pool", fetcher });
    expect(await svc2.runAutoPayouts()).toEqual([]);
  });
});

describe("fee pool distribution to infrastructure hosts", () => {
  it("weights by uptime and services; under half uptime earns nothing", () => {
    expect(hostWeight({ heartbeatsInWindow: 100, services: ["coordinator"] }, 100)).toBe(1);
    expect(hostWeight({ heartbeatsInWindow: 100, services: ["coordinator", "bitcoind", "lightning", "electrs"] }, 100)).toBe(3.5);
    expect(hostWeight({ heartbeatsInWindow: 80, services: ["coordinator", "bitcoind"] }, 100)).toBe(1.6);
    expect(hostWeight({ heartbeatsInWindow: 40, services: ["coordinator", "bitcoind"] }, 100)).toBe(0);
    const shares = distributeFeePool(
      1_000_000,
      [
        { hostId: "a", accountId: "host:a", heartbeatsInWindow: 100, services: ["coordinator"] },
        { hostId: "b", accountId: "host:b", heartbeatsInWindow: 100, services: ["coordinator", "bitcoind", "lightning"] },
        { hostId: "c", accountId: "host:c", heartbeatsInWindow: 10, services: ["coordinator"] }
      ],
      100
    );
    expect(shares.map((s) => [s.hostId, s.msat])).toEqual([["a", 250_000], ["b", 750_000]]);
  });

  it("moves the pool's msat to hosts as earn rows and clears the heartbeat window", async () => {
    const store = new MemoryPayoutStore(() => 0);
    await store.recordCreditTransactions([{ txId: "f1", accountId: "pool", type: "earn", credits: 10, reason: "network_fee:t", timestampMs: 1, msat: 1_000_000 }]);
    store.hosts.set("a", { hostId: "a", accountId: "host:a", services: ["coordinator"], firstSeenMs: 0, lastSeenMs: 0, heartbeatsInWindow: 100 });
    store.hosts.set("b", { hostId: "b", accountId: "host:b", services: ["coordinator", "lightning"], firstSeenMs: 0, lastSeenMs: 0, heartbeatsInWindow: 100 });
    let outFromPool = 0;
    const svc = new PayoutService({ store, provider: provider(() => ({ status: "failed" })), policy, coordinatorId: "c", feePoolAccountId: "pool", poolDistributedMsat: () => outFromPool, onPoolDistributed: (m) => { outFromPool += m; } });
    const r = await svc.distributeFeePool(100);
    expect(r.distributedMsat).toBe(999_999); // floors: 333,333 + 666,666
    expect(await store.earnedMsat("host:b")).toBe(666_666);
    expect(await store.creditBalance("pool")).toBeCloseTo(10 - 9.99999, 4);
    expect([...store.hosts.values()].every((h) => h.heartbeatsInWindow === 0)).toBe(true);
    // Nothing left to distribute on the next run.
    expect((await svc.distributeFeePool(100)).distributedMsat).toBe(0);
  });
});
