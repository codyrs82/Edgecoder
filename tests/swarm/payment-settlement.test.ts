import { describe, expect, test } from "vitest";
import type { PaymentIntent } from "../../src/common/types.js";
import type { LightningProvider, SettlementResult } from "../../src/economy/lightning.js";
import {
  assertPaymentWebhookSecret,
  createPaymentSettler,
  signPaymentWebhookBody,
  verifyPaymentWebhookSignature,
  type AtomicSettleStore
} from "../../src/economy/payment-settlement.js";

function stubProvider(paid: boolean): LightningProvider & { checks: number } {
  const p = {
    checks: 0,
    async createInvoice() {
      return { invoiceRef: "lnbc-test", paymentHash: "hash", expiresAtMs: Date.now() + 60_000 };
    },
    async checkSettlement(): Promise<SettlementResult> {
      p.checks += 1;
      await new Promise((r) => setTimeout(r, 5));
      return paid ? { settled: true, txRef: "node-tx-1", paymentHash: "hash-1" } : { settled: false };
    }
  };
  return p;
}

function makeIntent(id = "intent-1"): PaymentIntent {
  return {
    intentId: id,
    accountId: "acct-1",
    coordinatorId: "coord-1",
    walletType: "lightning",
    network: "signet",
    invoiceRef: "lnbc-test-invoice",
    amountSats: 1000,
    coordinatorFeeBps: 150,
    coordinatorFeeSats: 15,
    netSats: 985,
    quotedCredits: 32,
    status: "created",
    createdAtMs: Date.now()
  };
}

/** In-memory stand-in for the Postgres atomic CAS; survives "restarts" of the settler. */
class FakeDb implements AtomicSettleStore {
  intents = new Map<string, PaymentIntent>();
  credits: Array<{ accountId: string; credits: number; reason: string }> = [];
  async settlePaymentIntentAtomic(intentId: string, txRef: string, accountId: string, credits: number) {
    const row = this.intents.get(intentId);
    if (!row || row.status !== "created") return { status: "already" as const, intent: row };
    const settled = { ...row, status: "settled" as const, settledAtMs: Date.now(), txRef };
    this.intents.set(intentId, settled);
    this.credits.push({ accountId, credits, reason: `credit_purchase:${intentId}` });
    return { status: "settled" as const, intent: settled };
  }
}

function memorySettler(provider: LightningProvider, intents: Map<string, PaymentIntent>) {
  const granted: string[] = [];
  const settle = createPaymentSettler({
    provider,
    store: null,
    getIntent: (id) => intents.get(id),
    saveIntent: (i) => {
      intents.set(i.intentId, i);
    },
    grantCredits: async (_a, _c, reason) => {
      granted.push(reason);
    }
  });
  return { settle, granted };
}

describe("payment settlement (#42)", () => {
  test("unpaid invoice: confirm/webhook hints grant no credit", async () => {
    const intents = new Map([["intent-1", makeIntent()]]);
    const { settle, granted } = memorySettler(stubProvider(false), intents);
    const out = await settle(intents.get("intent-1")!);
    expect(out.status).toBe("unpaid");
    expect(granted).toHaveLength(0);
    expect(intents.get("intent-1")!.status).toBe("created");
  });

  test("webhook says settled:true but provider says unpaid -> no credit", async () => {
    // The settler takes no `settled` flag at all; only the provider decides.
    const intents = new Map([["intent-1", makeIntent()]]);
    const provider = stubProvider(false);
    const { settle, granted } = memorySettler(provider, intents);
    await settle(intents.get("intent-1")!);
    expect(provider.checks).toBe(1);
    expect(granted).toHaveLength(0);
  });

  test("3 concurrent calls on a paid intent (in-memory) -> exactly one credit", async () => {
    const intents = new Map([["intent-1", makeIntent()]]);
    const { settle, granted } = memorySettler(stubProvider(true), intents);
    const results = await Promise.all([1, 2, 3].map(() => settle(intents.get("intent-1")!)));
    expect(granted).toEqual(["credit_purchase:intent-1"]);
    expect(results.filter((r) => r.status === "settled")).toHaveLength(1);
    expect(intents.get("intent-1")!.status).toBe("settled");
  });

  test("3 concurrent calls on a paid intent (atomic store) -> exactly one credit", async () => {
    const db = new FakeDb();
    db.intents.set("intent-1", makeIntent());
    const onSettled: string[] = [];
    const settle = createPaymentSettler({
      provider: stubProvider(true),
      store: db,
      getIntent: () => undefined,
      saveIntent: () => undefined,
      grantCredits: async () => {
        throw new Error("atomic store must insert its own credit row");
      },
      onSettled: async (i) => {
        onSettled.push(i.intentId);
      }
    });
    const intent = makeIntent();
    await Promise.all([settle(intent), settle(intent), settle(intent)]);
    expect(db.credits).toHaveLength(1);
    expect(db.credits[0].reason).toBe("credit_purchase:intent-1");
    expect(onSettled).toEqual(["intent-1"]);
  });

  test("replay after restart (fresh settler, same DB) -> no second credit", async () => {
    const db = new FakeDb();
    db.intents.set("intent-1", makeIntent());
    const mk = () =>
      createPaymentSettler({
        provider: stubProvider(true),
        store: db,
        getIntent: () => undefined,
        saveIntent: () => undefined,
        grantCredits: async () => undefined
      });
    expect((await mk()(makeIntent())).status).toBe("settled");
    // "restart": new settler instance, stale caller copy of the intent still says "created"
    expect((await mk()(makeIntent())).status).toBe("already");
    expect(db.credits).toHaveLength(1);
  });

  test("webhook HMAC: missing / bad signature rejected, valid accepted", () => {
    const secret = "test-webhook-secret";
    const raw = JSON.stringify({ invoiceRef: "lnbc-test-invoice" });
    expect(verifyPaymentWebhookSignature(raw, undefined, secret)).toBe(false);
    expect(verifyPaymentWebhookSignature(raw, "sha256=deadbeef", secret)).toBe(false);
    expect(verifyPaymentWebhookSignature(raw, signPaymentWebhookBody(raw, "other"), secret)).toBe(false);
    expect(verifyPaymentWebhookSignature(raw + " ", signPaymentWebhookBody(raw, secret), secret)).toBe(false);
    expect(verifyPaymentWebhookSignature(raw, signPaymentWebhookBody(raw, secret), "")).toBe(false);
    expect(verifyPaymentWebhookSignature(raw, signPaymentWebhookBody(raw, secret), secret)).toBe(true);
  });

  test("production + empty PAYMENT_WEBHOOK_SECRET -> startup throws", () => {
    expect(() => assertPaymentWebhookSecret({ NODE_ENV: "production", PAYMENT_WEBHOOK_SECRET: "" })).toThrow(
      /PAYMENT_WEBHOOK_SECRET required/
    );
    expect(() => assertPaymentWebhookSecret({ NODE_ENV: "production" })).toThrow();
    expect(() => assertPaymentWebhookSecret({ NODE_ENV: "production", PAYMENT_WEBHOOK_SECRET: "s" })).not.toThrow();
    expect(() => assertPaymentWebhookSecret({ NODE_ENV: "development" })).not.toThrow();
  });
});
