import { describe, expect, test } from "vitest";
import type { PaymentIntent } from "../../src/common/types.js";
import type { LightningProvider, SettlementResult } from "../../src/economy/lightning.js";
import {
  assertPaymentWebhookSecret,
  createPaymentSettler,
  mayExpireIntent,
  reconcilePaymentIntent,
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
  async getPaymentIntent(intentId: string) {
    return this.intents.get(intentId) ?? null;
  }
  async settlePaymentIntentAtomic(intentId: string, txRef: string, _hash?: string, opts?: { fromExpired?: boolean }) {
    const row = this.intents.get(intentId);
    if (!row || !(row.status === "created" || (opts?.fromExpired && row.status === "expired"))) return { status: "already" as const, intent: row };
    const settled = { ...row, status: "settled" as const, settledAtMs: Date.now(), txRef };
    this.intents.set(intentId, settled);
    // Like Postgres (#155): credit the stored row's account and amount.
    this.credits.push({ accountId: row.accountId, credits: row.quotedCredits, reason: `credit_purchase:${intentId}` });
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

  test("reconcile asks the node before expiring: paid-but-stale intent is settled, not expired", async () => {
    const stale = { ...makeIntent(), createdAtMs: Date.now() - 10 * 60 * 60 * 1000 };
    const intents = new Map([["intent-1", stale]]);
    const { settle, granted } = memorySettler(stubProvider(true), intents);
    let expired = 0;
    const out = await reconcilePaymentIntent(stale, settle, async () => {
      expired += 1;
      return true;
    });
    expect(out).toBe("settled");
    expect(expired).toBe(0);
    expect(granted).toEqual(["credit_purchase:intent-1"]);
  });

  test("reconcile expires only intents the node definitively reports unpaid", async () => {
    const stale = { ...makeIntent(), createdAtMs: 0 };
    const withState = (r: SettlementResult): LightningProvider => ({ ...stubProvider(false), checkSettlement: async () => r });
    const seen: Array<string | undefined> = [];
    const expire = async (_i: PaymentIntent, state: SettlementResult["invoiceState"]) => { seen.push(state); return true; };
    const canceled = memorySettler(withState({ settled: false, invoiceState: "canceled" }), new Map([["intent-1", stale]]));
    expect(await reconcilePaymentIntent(stale, canceled.settle, expire)).toBe("expired");
    expect(seen).toEqual(["canceled"]);
    // No definitive state in the answer: pending, expire is never asked.
    const vague = memorySettler(stubProvider(false), new Map([["intent-1", stale]]));
    expect(await reconcilePaymentIntent(stale, vague.settle, expire)).toBe("pending");
    expect(seen).toEqual(["canceled"]);
  });

  test("a failed node lookup is unknown, never unpaid, and never expires a (possibly paid) intent", async () => {
    const stale = { ...makeIntent(), createdAtMs: 0 };
    const down: LightningProvider = { ...stubProvider(false), checkSettlement: async () => { throw new Error("lnd_invoice_lookup_503"); } };
    const intents = new Map([["intent-1", stale]]);
    const { settle, granted } = memorySettler(down, intents);
    expect(await settle(stale)).toEqual({ status: "unknown", error: "lnd_invoice_lookup_503" });
    let asked = false;
    expect(await reconcilePaymentIntent(stale, settle, async () => { asked = true; return true; })).toBe("pending");
    expect(asked).toBe(false);
    expect(granted).toHaveLength(0);
    expect(intents.get("intent-1")!.status).toBe("created");
  });

  test("mayExpireIntent: canceled/expired past TTL + grace; open only well past it; accepted or unknown never", () => {
    const TTL = 900_000, GRACE = 120_000, MARGIN = 600_000;
    expect(mayExpireIntent("canceled", TTL + GRACE, TTL, GRACE, MARGIN)).toBe(false);
    expect(mayExpireIntent("canceled", TTL + GRACE + 1, TTL, GRACE, MARGIN)).toBe(true);
    expect(mayExpireIntent("expired", TTL + GRACE + 1, TTL, GRACE, MARGIN)).toBe(true);
    expect(mayExpireIntent("open", TTL + GRACE + 1, TTL, GRACE, MARGIN)).toBe(false);
    expect(mayExpireIntent("open", TTL + GRACE + MARGIN + 1, TTL, GRACE, MARGIN)).toBe(true);
    expect(mayExpireIntent("accepted", 10 * TTL, TTL, GRACE, MARGIN)).toBe(false);
    expect(mayExpireIntent(undefined, 10 * TTL, TTL, GRACE, MARGIN)).toBe(false);
  });

  test("late settlement: an intent marked expired that the node reports paid is credited once, only when asked to recover", async () => {
    const expired = { ...makeIntent(), status: "expired" as const, createdAtMs: 0 };
    // In memory.
    const intents = new Map([["intent-1", expired]]);
    const mem = memorySettler(stubProvider(true), intents);
    expect((await mem.settle(expired)).status).toBe("already");
    expect(mem.granted).toEqual([]);
    expect((await mem.settle(expired, { allowExpired: true })).status).toBe("settled");
    expect((await mem.settle(expired, { allowExpired: true })).status).toBe("already");
    expect(mem.granted).toEqual(["credit_purchase:intent-1"]);
    // Atomic store, concurrent recoveries.
    const db = new FakeDb();
    db.intents.set("intent-1", expired);
    const settle = createPaymentSettler({ provider: stubProvider(true), store: db, getIntent: () => undefined, saveIntent: () => undefined, grantCredits: async () => undefined });
    const out = await Promise.all([1, 2, 3].map(() => settle(expired, { allowExpired: true })));
    expect(out.filter((o) => o.status === "settled")).toHaveLength(1);
    expect(db.credits).toEqual([{ accountId: "acct-1", credits: 32, reason: "credit_purchase:intent-1" }]);
    // Still unpaid at the node: stays expired, nothing credited.
    const db2 = new FakeDb();
    db2.intents.set("intent-1", expired);
    const unpaid = createPaymentSettler({ provider: stubProvider(false), store: db2, getIntent: () => undefined, saveIntent: () => undefined, grantCredits: async () => undefined });
    expect((await unpaid(expired, { allowExpired: true })).status).toBe("unpaid");
    expect(db2.intents.get("intent-1")!.status).toBe("expired");
    expect(db2.credits).toEqual([]);
  });

  test("provider receives the stored payment hash", async () => {
    let seen: string | undefined;
    const provider = {
      async createInvoice() {
        return { invoiceRef: "x", paymentHash: "h", expiresAtMs: 0 };
      },
      async checkSettlement(_ref: string, hash?: string) {
        seen = hash;
        return { settled: false };
      }
    };
    const intent = { ...makeIntent(), paymentHash: "ab".repeat(32) };
    const { settle } = memorySettler(provider, new Map([["intent-1", intent]]));
    await settle(intent);
    expect(seen).toBe("ab".repeat(32));
  });
});

describe("settlement credits the stored intent, not the caller's copy (#155)", () => {
  const tampered = (): PaymentIntent => ({
    ...makeIntent(),
    accountId: "attacker",
    quotedCredits: 1_000_000,
    invoiceRef: "lnbc-someone-elses-paid-invoice",
    paymentHash: "ff".repeat(32)
  });
  function recordingProvider(paid: boolean) {
    const asked: Array<{ ref: string; hash?: string }> = [];
    const provider: LightningProvider = {
      async createInvoice() {
        return { invoiceRef: "x", paymentHash: "h", expiresAtMs: 0 };
      },
      async checkSettlement(ref: string, hash?: string): Promise<SettlementResult> {
        asked.push({ ref, hash });
        return paid ? { settled: true, txRef: "node-tx", paymentHash: "hash-1" } : { settled: false };
      }
    };
    return { provider, asked };
  }

  test("atomic store: stored account, amount and invoice are used", async () => {
    const db = new FakeDb();
    db.intents.set("intent-1", makeIntent());
    const { provider, asked } = recordingProvider(true);
    const settle = createPaymentSettler({
      provider,
      store: db,
      getIntent: () => undefined,
      saveIntent: () => undefined,
      grantCredits: async () => {
        throw new Error("atomic store must insert its own credit row");
      }
    });
    expect((await settle(tampered())).status).toBe("settled");
    expect(asked).toEqual([{ ref: "lnbc-test-invoice", hash: undefined }]);
    expect(db.credits).toEqual([{ accountId: "acct-1", credits: 32, reason: "credit_purchase:intent-1" }]);
  });

  test("in memory: stored account, amount and invoice are used", async () => {
    const intents = new Map([["intent-1", makeIntent()]]);
    const { provider, asked } = recordingProvider(true);
    const grants: Array<[string, number, string]> = [];
    const settle = createPaymentSettler({
      provider,
      store: null,
      getIntent: (id) => intents.get(id),
      saveIntent: (i) => {
        intents.set(i.intentId, i);
      },
      grantCredits: async (a, c, r) => {
        grants.push([a, c, r]);
      }
    });
    expect((await settle(tampered())).status).toBe("settled");
    expect(asked.map((a) => a.ref)).toEqual(["lnbc-test-invoice"]);
    expect(grants).toEqual([["acct-1", 32, "credit_purchase:intent-1"]]);
    expect(intents.get("intent-1")!.accountId).toBe("acct-1");
  });

  test("an intent that isn't stored is never settled, and the node isn't asked", async () => {
    const { provider, asked } = recordingProvider(true);
    const db = new FakeDb();
    const settle = createPaymentSettler({
      provider,
      store: db,
      getIntent: () => undefined,
      saveIntent: () => undefined,
      grantCredits: async () => undefined
    });
    expect((await settle({ ...tampered(), intentId: "made-up" })).status).toBe("unpaid");
    const mem = memorySettler(provider, new Map());
    expect((await mem.settle({ ...tampered(), intentId: "made-up" })).status).toBe("unpaid");
    expect(asked).toEqual([]);
    expect(db.credits).toEqual([]);
    expect(mem.granted).toEqual([]);
  });

  test("a stale 'created' copy of an already-settled stored intent is 'already'", async () => {
    const db = new FakeDb();
    db.intents.set("intent-1", { ...makeIntent(), status: "settled" });
    const { provider, asked } = recordingProvider(true);
    const settle = createPaymentSettler({ provider, store: db, getIntent: () => undefined, saveIntent: () => undefined, grantCredits: async () => undefined });
    expect((await settle(makeIntent())).status).toBe("already");
    expect(asked).toEqual([]);
    expect(db.credits).toEqual([]);
  });
});
