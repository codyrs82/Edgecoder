import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PaymentIntent } from "../../src/common/types.js";

/*
 * Late settlement recovery on the coordinator (memory mode; the dev Lightning provider reports
 * every invoice paid): purchases marked expired in the last 7 days are asked about again and
 * credited once if paid; older ones are left alone.
 */
let app: any;
let paymentIntents: Map<string, PaymentIntent>;
let recoverLateSettlements: typeof import("../../src/swarm/coordinator/payments.js")["recoverLateSettlements"];
let creditEngine: typeof import("../../src/credits/store.js")["creditEngine"];

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  ({ paymentIntents } = await import("../../src/swarm/coordinator/economy.js"));
  ({ recoverLateSettlements } = await import("../../src/swarm/coordinator/payments.js"));
  ({ creditEngine } = await import("../../src/credits/store.js"));
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const expiredIntent = (accountId: string, ageMs: number): PaymentIntent => {
  const id = randomUUID();
  return {
    intentId: id, accountId, coordinatorId: "c", walletType: "lightning", network: "signet", invoiceRef: `mockln:${id}:500`,
    amountSats: 500, coordinatorFeeBps: 0, coordinatorFeeSats: 0, netSats: 500, quotedCredits: 500, status: "expired", createdAtMs: Date.now() - ageMs
  };
};

describe("late settlement recovery", () => {
  test("credits a recently expired purchase the node reports paid, once; leaves old ones alone", async () => {
    const acct = `late-${randomUUID()}`;
    const recent = expiredIntent(acct, 60 * 60_000);
    const old = expiredIntent(acct, 8 * 24 * 60 * 60_000);
    paymentIntents.set(recent.intentId, recent);
    paymentIntents.set(old.intentId, old);
    const first = await recoverLateSettlements();
    expect(first.recovered).toBeGreaterThanOrEqual(1);
    expect(paymentIntents.get(recent.intentId)!.status).toBe("settled");
    expect(paymentIntents.get(old.intentId)!.status).toBe("expired");
    expect(creditEngine.balance(acct)).toBe(500);
    // Idempotent: a second run credits nothing more.
    await recoverLateSettlements();
    expect(creditEngine.balance(acct)).toBe(500);
  });
});
