import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { MemoryPayoutStore, PayoutService } from "../../src/economy/payout-service.js";
import { DEFAULT_PAYOUT_POLICY } from "../../src/economy/payouts.js";
import { MemoryCallbackPinStore, callbackOrigin, callbackPinStatus, type CallbackPinStore } from "../../src/economy/lnurl-callback-pin.js";
import type { LightningProvider, PayInvoiceInput } from "../../src/economy/lightning.js";
import { PostgresStore, SCHEMA_SQL } from "../../src/db/postgres.js";
import { encodeTestBolt11 } from "./helpers/bolt11-encode.js";

const policy = { ...DEFAULT_PAYOUT_POLICY, network: "signet" as const };
const ADDR = "alice@walletofsatoshi.com";
const ACCT = "acct-alice";

/** LNURL server for ADDR whose callback host can be switched between calls. */
function lnurlServer() {
  const state = { callbackHost: "https://livingroomofsatoshi.com", callbacksCalled: 0 };
  const metadata = JSON.stringify([["text/identifier", ADDR]]);
  const descriptionHashHex = createHash("sha256").update(metadata).digest("hex");
  const fetcher = async (url: string) => {
    if (url === "https://walletofsatoshi.com/.well-known/lnurlp/alice") return { tag: "payRequest", callback: `${state.callbackHost}/lnurlp/alice/cb`, minSendable: 1000, maxSendable: 1e12, metadata };
    state.callbacksCalled++;
    const amountMsat = Number(new URL(url).searchParams.get("amount"));
    return { pr: encodeTestBolt11({ network: "tbs", amountMsat, paymentHashHex: createHash("sha256").update(randomBytes(32)).digest("hex"), descriptionHashHex }) };
  };
  return { state, fetcher };
}

function setup(pins: CallbackPinStore = new MemoryCallbackPinStore()) {
  const earned: Record<string, number> = { [ACCT]: 50_000_000 };
  const store = new MemoryPayoutStore((a) => earned[a] ?? 0);
  store.received = 10_000_000_000;
  store.autoAccounts.set(ACCT, ADDR);
  const paid: PayInvoiceInput[] = [];
  const provider: LightningProvider = {
    createInvoice: async () => { throw new Error("n/a"); },
    checkSettlement: async () => ({ settled: false }),
    payInvoice: async (i) => { paid.push(i); return { status: "succeeded", feeMsat: 0 }; }
  };
  const server = lnurlServer();
  const notices: Array<{ accountId: string; destination: string; previousOrigin: string; newOrigin: string }> = [];
  let deliver = true;
  const svc = new PayoutService({
    store, provider, policy, coordinatorId: "c", feePoolAccountId: "pool", fetcher: server.fetcher, pins,
    onCallbackChanged: async (i) => { notices.push(i); return deliver; }
  });
  return { store, earned, paid, server, svc, pins, notices, setDeliver: (v: boolean) => { deliver = v; } };
}

describe("LNURL callback pinning", () => {
  it("callbackOrigin keeps scheme, host and port only", () => {
    expect(callbackOrigin("https://Pay.Example.com/lnurlp/x?y=1")).toBe("https://pay.example.com");
    expect(callbackOrigin("https://pay.example.com:8443/cb")).toBe("https://pay.example.com:8443");
  });

  it("first resolution pins the callback host and pays; the same host keeps paying", async () => {
    const t = setup();
    const r1 = await t.svc.runAutoPayouts();
    expect(r1[0].result.ok).toBe(true);
    const pin = await t.pins.getCallbackPin(ACCT, ADDR);
    expect(pin).toMatchObject({ origin: "https://livingroomofsatoshi.com", accountId: ACCT, destination: ADDR });
    expect(pin!.pinnedAtMs).toBeGreaterThan(0);
    t.earned[ACCT] += 50_000_000;
    const r2 = await t.svc.runAutoPayouts();
    expect(r2[0].result.ok).toBe(true);
    expect(t.paid).toHaveLength(2);
    expect(t.notices).toEqual([]);
  });

  it("a different callback host blocks the payout, keeps the earnings payable and marks callback_changed", async () => {
    const t = setup();
    await t.svc.pinDestination(ACCT, ADDR); // pinned at save time
    t.server.state.callbackHost = "https://evil.example";
    const before = await t.svc.balance(ACCT);
    const r = await t.svc.runAutoPayouts();
    expect(r[0].result).toMatchObject({ ok: false, code: "callback_changed", previousOrigin: "https://livingroomofsatoshi.com", newOrigin: "https://evil.example" });
    expect(t.paid).toHaveLength(0);
    expect(t.server.state.callbacksCalled).toBe(0); // the new host is never asked for an invoice
    expect(await t.store.listPayouts(ACCT)).toEqual([]);
    expect((await t.svc.balance(ACCT)).payableMsat).toBe(before.payableMsat);
    expect(callbackPinStatus(await t.pins.listCallbackPins(ACCT))).toEqual([
      expect.objectContaining({ destination: ADDR, origin: "https://livingroomofsatoshi.com", state: "callback_changed", changedOrigin: "https://evil.example" })
    ]);
  });

  it("notifies once per change, not on every payout cycle; a failed delivery is retried", async () => {
    const t = setup();
    await t.svc.runAutoPayouts(); // pins
    t.earned[ACCT] += 50_000_000;
    t.server.state.callbackHost = "https://evil.example";
    t.setDeliver(false);
    await t.svc.runAutoPayouts();
    expect(t.notices).toHaveLength(1); // tried, failed
    t.setDeliver(true);
    await t.svc.runAutoPayouts();
    await t.svc.runAutoPayouts();
    await t.svc.runAutoPayouts();
    expect(t.notices).toHaveLength(2); // retried once, then never again
    expect(t.notices[1]).toEqual({ accountId: ACCT, destination: ADDR, previousOrigin: "https://livingroomofsatoshi.com", newOrigin: "https://evil.example" });
    // A second, different change is a new notice.
    t.server.state.callbackHost = "https://evil2.example";
    await t.svc.runAutoPayouts();
    await t.svc.runAutoPayouts();
    expect(t.notices).toHaveLength(3);
  });

  it("stays held when the callback flips back to the pinned host, until the owner confirms", async () => {
    const t = setup();
    await t.svc.runAutoPayouts();
    t.earned[ACCT] += 50_000_000;
    t.server.state.callbackHost = "https://evil.example";
    await t.svc.runAutoPayouts();
    t.server.state.callbackHost = "https://livingroomofsatoshi.com";
    const r = await t.svc.runAutoPayouts();
    expect(r[0].result).toMatchObject({ ok: false, code: "callback_changed", newOrigin: "https://evil.example" });
    expect(t.paid).toHaveLength(1);
  });

  it("confirming re-pins to the new host and resumes payouts; only the recorded change can be confirmed", async () => {
    const t = setup();
    await t.svc.runAutoPayouts();
    t.earned[ACCT] += 50_000_000;
    t.server.state.callbackHost = "https://new.walletofsatoshi.com";
    await t.svc.runAutoPayouts();
    expect(t.paid).toHaveLength(1);
    expect(await t.pins.confirmCallbackChange(ACCT, ADDR, "https://other.example", 5)).toBe(false);
    expect(await t.pins.confirmCallbackChange(ACCT, ADDR, "https://new.walletofsatoshi.com", 5)).toBe(true);
    expect(await t.pins.getCallbackPin(ACCT, ADDR)).toEqual({ accountId: ACCT, destination: ADDR, origin: "https://new.walletofsatoshi.com", pinnedAtMs: 5 });
    const r = await t.svc.runAutoPayouts();
    expect(r[0].result.ok).toBe(true);
    expect(t.paid).toHaveLength(2);
  });

  it("changing the destination resets the pin", async () => {
    const t = setup();
    await t.svc.runAutoPayouts();
    t.server.state.callbackHost = "https://evil.example";
    await t.svc.runAutoPayouts();
    await t.pins.resetCallbackPins(ACCT, "bob@getalby.com");
    expect(await t.pins.listCallbackPins(ACCT)).toEqual([]);
    // Re-saving the same destination keeps its pin.
    await t.svc.pinDestination(ACCT, ADDR);
    await t.pins.resetCallbackPins(ACCT, ADDR);
    expect(await t.pins.getCallbackPin(ACCT, ADDR)).toMatchObject({ origin: "https://evil.example" });
  });

  it("existing destinations (no pin yet) pin on their next resolution without blocking", async () => {
    const t = setup();
    expect(await t.pins.listCallbackPins(ACCT)).toEqual([]);
    t.server.state.callbackHost = "https://whatever.example";
    const r = await t.svc.runAutoPayouts();
    expect(r[0].result.ok).toBe(true);
    expect(await t.pins.getCallbackPin(ACCT, ADDR)).toMatchObject({ origin: "https://whatever.example" });
  });

  it("pinDestination reports an unresolvable address as not pinned (pinned at first payout instead)", async () => {
    const t = setup();
    expect(await t.svc.pinDestination(ACCT, "nobody@nowhere.example")).toMatchObject({ ok: false, code: "not_pinned" });
    expect(await t.pins.listCallbackPins(ACCT)).toEqual([]);
  });
});

// Real Postgres (CI sets TEST_DATABASE_URL).
const PG_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("LNURL callback pins against real Postgres", () => {
  it("pins, blocks a change, notifies once across two coordinators, confirms and resets", async () => {
    const a = new pg.Pool({ connectionString: PG_URL, max: 4 });
    const b = new pg.Pool({ connectionString: PG_URL, max: 4 });
    try {
      await a.query(SCHEMA_SQL);
      const acct = `acct-pin-${randomUUID()}`;
      const sa = new PostgresStore(a);
      const pa = sa.callbackPinStore();
      const pb = new PostgresStore(b).callbackPinStore();
      await sa.setLightningAddress(acct, ADDR, "signet");
      const t = setup(pa);
      t.store.autoAccounts.clear();
      t.store.autoAccounts.set(acct, ADDR);
      t.earned[acct] = 50_000_000;
      expect((await t.svc.runAutoPayouts())[0].result.ok).toBe(true);
      expect(await pb.getCallbackPin(acct, ADDR)).toMatchObject({ origin: "https://livingroomofsatoshi.com" });

      t.server.state.callbackHost = "https://evil.example";
      t.earned[acct] += 50_000_000;
      const r = await t.svc.runAutoPayouts();
      expect(r[0].result).toMatchObject({ ok: false, code: "callback_changed" });
      expect(t.notices).toHaveLength(1);
      // The other coordinator cannot claim the same notice again.
      expect(await pb.claimCallbackNotification(acct, ADDR, Date.now())).toBeNull();
      await t.svc.runAutoPayouts();
      expect(t.notices).toHaveLength(1);

      expect(await pb.confirmCallbackChange(acct, ADDR, "https://other.example", Date.now())).toBe(false);
      expect(await pb.confirmCallbackChange(acct, ADDR, "https://evil.example", Date.now())).toBe(true);
      expect(await pa.getCallbackPin(acct, ADDR)).toMatchObject({ origin: "https://evil.example" });
      expect((await pa.getCallbackPin(acct, ADDR))!.changedOrigin).toBeUndefined();
      expect((await t.svc.runAutoPayouts())[0].result.ok).toBe(true);

      // Changing the destination drops the old pin; re-saving the same one keeps it.
      await sa.setLightningAddress(acct, ADDR, "signet");
      expect(await pa.getCallbackPin(acct, ADDR)).not.toBeNull();
      await sa.setLightningAddress(acct, "bob@getalby.com", "signet");
      expect(await pa.listCallbackPins(acct)).toEqual([]);
      await a.query(`DELETE FROM wallet_accounts WHERE account_id = $1`, [acct]);
    } finally {
      await a.end();
      await b.end();
    }
  });
});
