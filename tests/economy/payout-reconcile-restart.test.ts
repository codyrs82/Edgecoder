import { describe, expect, it } from "vitest";
import { MemoryPayoutStore } from "../../src/economy/payout-service.js";
import { PayoutReconciler, type ReconcileLedger, type ReconcileSnapshot } from "../../src/economy/payout-reconcile.js";
import type { LightningProvider, NodePayment } from "../../src/economy/lightning.js";

// Live regtest finding (2026-11-15): an unknown node payment tripped reconciliation; an admin
// reviewed it and resumed payouts; the next deploy (several a day) started a fresh reconciler,
// which looked back 24 h again, found the same payment and paused payouts again. The window and
// baseline now come from the last run recorded in the shared store, so a restart continues where
// the previous run (on any seed) stopped, and the balance-drop check keeps its baseline.

const H = 3_600_000;
function provider(payments: NodePayment[], balanceSats: () => number): LightningProvider {
  return {
    createInvoice: async () => { throw new Error("n/a"); },
    checkSettlement: async () => ({ settled: false }),
    payInvoice: async () => ({ status: "failed", error: "n/a" }),
    getBalances: async () => ({ supported: true, onchainConfirmedSats: 0, onchainUnconfirmedSats: 0, channelLocalSats: balanceSats(), channelPendingSats: 0, totalSats: balanceSats() }),
    listPayments: async ({ sinceMs }) => ({ supported: true, payments: payments.filter((p) => p.createdAtMs >= sinceMs), truncated: false })
  };
}

describe("PayoutReconciler across restarts", () => {
  function world() {
    const store = new MemoryPayoutStore(() => 0);
    let saved: ReconcileSnapshot | null = null;
    const ledger: ReconcileLedger = {
      payoutsByPaymentHash: (h) => store.payoutsByPaymentHash(h),
      payoutsOutflowMsat: () => store.payoutsOutflowMsat(),
      receivedPurchaseMsat: () => store.receivedPurchaseMsat(),
      loadReconcileSnapshot: async () => saved,
      saveReconcileSnapshot: async (s) => { saved = s; }
    };
    return { ledger, saved: () => saved };
  }

  it("a payment already reviewed before a restart does not pause payouts again", async () => {
    const w = world();
    let now = 100 * H;
    let balance = 1_000_000;
    const payments: NodePayment[] = [{ paymentHash: "ab".repeat(32), status: "succeeded", valueMsat: 1_000_000_000, feeMsat: 0, createdAtMs: now - 2 * H }];
    const paused: string[] = [];
    const make = () => new PayoutReconciler({ provider: provider(payments, () => balance), ledger: w.ledger, config: { intervalMs: 600_000, toleranceSats: 1, lookbackMs: 24 * H }, coordinatorId: "c", pause: async (r) => { paused.push(r); }, now: () => now });

    expect((await make().run()).status).toBe("tripped"); // first sight of the unknown payment
    expect(paused).toHaveLength(1);
    now += 10 * 60_000;
    // ...admin reviews and resumes; then the seed is redeployed (a new reconciler) a few times.
    for (let i = 0; i < 3; i++) {
      now += 2 * H;
      expect((await make().run()).status).toBe("ok");
    }
    expect(paused).toHaveLength(1);

    // A payment made while the coordinator was down is still caught after the restart.
    now += H;
    payments.push({ paymentHash: "cd".repeat(32), status: "succeeded", valueMsat: 5_000_000, feeMsat: 0, createdAtMs: now - 30 * 60_000 });
    balance -= 5_000;
    const r = await make().run();
    expect(r.status).toBe("tripped");
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name).sort()).toEqual(["balance_drop", "unknown_payments"]);
  });

  it("without a stored snapshot the first run looks back the configured lookback", async () => {
    const w = world();
    const now = 100 * H;
    const payments: NodePayment[] = [{ paymentHash: "ef".repeat(32), status: "succeeded", valueMsat: 1_000, feeMsat: 0, createdAtMs: now - 20 * H }];
    const r = await new PayoutReconciler({ provider: provider(payments, () => 0), ledger: w.ledger, config: { intervalMs: 1, toleranceSats: 0, lookbackMs: 24 * H }, coordinatorId: "c", pause: async () => {}, now: () => now }).run();
    expect(r.status).toBe("tripped");
    expect(w.saved()?.atMs).toBe(now);
  });
});
