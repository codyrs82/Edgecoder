import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryPayoutStore, PayoutService } from "../../src/economy/payout-service.js";
import { DEFAULT_PAYOUT_POLICY } from "../../src/economy/payouts.js";
import type { LightningProvider, NodePayment, PayInvoiceResult } from "../../src/economy/lightning.js";
import { encodeTestBolt11 } from "./helpers/bolt11-encode.js";

// A payout whose outcome the coordinator never learned (transport error, proxy 504, a hold
// invoice past the pay timeout, or a restart mid-payment) stays `pending` with its credit debit.
// Found on the live regtest money loop (2026-11-15): nothing ever looked at those rows again, so
// the sats stayed locked even after the node had paid (or definitively failed) the payment.
// resolvePendingPayouts settles them from the node's own payment record.

const policy = { ...DEFAULT_PAYOUT_POLICY, network: "signet" as const };
function invoice(amountMsat: number) {
  const preimage = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  return { bolt11: encodeTestBolt11({ network: "tbs", amountMsat, paymentHashHex: hash }), hash, preimage };
}

function setup(nodePayments: NodePayment[], opts: { truncated?: boolean; pay?: () => PayInvoiceResult } = {}) {
  let now = 1_000_000_000;
  const store = new MemoryPayoutStore(() => 10_000_000, () => 10_000);
  store.received = 100_000_000;
  const paid: string[] = [];
  const provider: LightningProvider = {
    createInvoice: async () => { throw new Error("n/a"); },
    checkSettlement: async () => ({ settled: false }),
    payInvoice: async () => opts.pay?.() ?? { status: "failed", error: "lnd_pay_transport:socket hang up" },
    listPayments: async () => ({ supported: true, payments: nodePayments, truncated: opts.truncated ?? false })
  };
  const svc = new PayoutService({ store, provider, policy, coordinatorId: "c", feePoolAccountId: "network:fee_pool", now: () => now, onPaid: async (p) => { paid.push(p.payoutId); } });
  return { store, svc, paid, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe("PayoutService.resolvePendingPayouts", () => {
  it("settles a stuck payout as paid when the node shows the payment succeeded (fee, preimage, refund of the unused fee cap)", async () => {
    const inv = invoice(2_000_000);
    const node: NodePayment[] = [];
    const t = setup(node);
    expect(await t.svc.withdraw("a", inv.bolt11)).toMatchObject({ ok: false, code: "payout_unconfirmed" });
    const row = [...t.store.payouts.values()][0];
    expect(row.status).toBe("pending");
    node.push({ paymentHash: inv.hash, status: "succeeded", valueMsat: 2_000_000, feeMsat: 1_000, createdAtMs: t.now(), preimage: inv.preimage });
    t.advance(15 * 60_000);
    const r = await t.svc.resolvePendingPayouts();
    expect(r).toEqual([expect.objectContaining({ payoutId: row.payoutId, outcome: "paid" })]);
    expect(t.store.payouts.get(row.payoutId)).toMatchObject({ status: "paid", feeMsat: 1_000, preimage: inv.preimage });
    expect(t.paid).toEqual([row.payoutId]);
    // debit was amount + 20 000 fee cap; 19 000 of the cap comes back
    expect(await t.store.creditBalance("a")).toBeCloseTo(10_000 - 2_001, 6);
    expect(await t.svc.resolvePendingPayouts()).toEqual([]);
  });

  it("marks it failed and frees the balance when the node shows the payment failed, so the next payout can go", async () => {
    const inv = invoice(2_000_000);
    const t = setup([{ paymentHash: inv.hash, status: "failed", valueMsat: 2_000_000, feeMsat: 0, createdAtMs: 1_000_000_000 }]);
    await t.svc.withdraw("a", inv.bolt11);
    t.advance(15 * 60_000);
    expect(await t.svc.resolvePendingPayouts()).toEqual([expect.objectContaining({ outcome: "failed" })]);
    expect([...t.store.payouts.values()][0]).toMatchObject({ status: "failed" });
    expect((await t.svc.balance("a")).payableMsat).toBe(10_000_000);
    expect(await t.store.creditBalance("a")).toBeCloseTo(10_000, 6);
  });

  it("keeps a payout pending while the node still has it in flight, while it is young, or when the node's list may be incomplete", async () => {
    const a = invoice(2_000_000);
    const t = setup([{ paymentHash: a.hash, status: "in_flight", valueMsat: 2_000_000, feeMsat: 0, createdAtMs: 1_000_000_000 }]);
    await t.svc.withdraw("a", a.bolt11);
    expect(await t.svc.resolvePendingPayouts()).toEqual([]); // too young
    t.advance(15 * 60_000);
    expect(await t.svc.resolvePendingPayouts()).toEqual([expect.objectContaining({ outcome: "in_flight" })]);
    expect([...t.store.payouts.values()][0].status).toBe("pending");

    const b = invoice(2_000_000);
    const u = setup([], { truncated: true });
    await u.svc.withdraw("a", b.bolt11);
    u.advance(60 * 60_000);
    expect(await u.svc.resolvePendingPayouts()).toEqual([expect.objectContaining({ outcome: "unknown" })]);
    expect([...u.store.payouts.values()][0].status).toBe("pending");
  });

  it("fails a payout the node never saw only after the not-sent grace, never one whose amount disagrees", async () => {
    const a = invoice(2_000_000);
    const t = setup([]);
    await t.svc.withdraw("a", a.bolt11);
    t.advance(15 * 60_000);
    expect(await t.svc.resolvePendingPayouts()).toEqual([expect.objectContaining({ outcome: "unknown" })]);
    t.advance(30 * 60_000);
    expect(await t.svc.resolvePendingPayouts()).toEqual([expect.objectContaining({ outcome: "failed", reason: "not_sent" })]);

    const b = invoice(2_000_000);
    const v = setup([{ paymentHash: b.hash, status: "succeeded", valueMsat: 1_000_000, feeMsat: 0, createdAtMs: 1_000_000_000 }]);
    await v.svc.withdraw("a", b.bolt11);
    v.advance(15 * 60_000);
    expect(await v.svc.resolvePendingPayouts()).toEqual([expect.objectContaining({ outcome: "mismatch" })]);
    expect([...v.store.payouts.values()][0].status).toBe("pending");
  });

  it("never touches an on-chain payout (pending while its transaction confirms, no Lightning payment)", async () => {
    const t = setup([]);
    t.store.payouts.set("oc-1", { payoutId: "oc-1", accountId: "a", coordinatorId: "c", kind: "onchain", bolt11: "", paymentHash: "onchain:oc-1", amountMsat: 50_000_000, feeMsat: 0, maxFeeMsat: 1_000_000, status: "pending", createdAtMs: t.now() });
    t.advance(24 * 60 * 60_000);
    expect(await t.svc.resolvePendingPayouts()).toEqual([]);
    expect(t.store.payouts.get("oc-1")?.status).toBe("pending");
  });
});
