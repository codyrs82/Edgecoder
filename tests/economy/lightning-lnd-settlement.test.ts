import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { LndRestProvider, interpretLndInvoice } from "../../src/economy/lightning.js";

// #47: settlement detection against LND REST invoice responses.
const fx = JSON.parse(readFileSync(join(__dirname, "fixtures/lnd-invoices.json"), "utf8"));
const HASH: string = fx.payment_hash_hex;
const BASE = "https://lnd.test:8080";

describe("interpretLndInvoice (#47)", () => {
  test("SETTLED invoice is settled, with hash-verified preimage", () => {
    expect(interpretLndInvoice(fx.settled, HASH)).toEqual({
      settled: true,
      txRef: `lnd:${HASH}`,
      paymentHash: HASH,
      preimage: fx.preimage_hex
    });
  });

  test("OPEN, CANCELED and ACCEPTED (hold) invoices are not settled", () => {
    expect(interpretLndInvoice(fx.open, HASH).settled).toBe(false);
    expect(interpretLndInvoice(fx.canceled, HASH).settled).toBe(false);
    expect(interpretLndInvoice(fx.accepted_hold, HASH).settled).toBe(false);
  });

  test("an unpaid invoice reports the node's definitive state (only for the invoice asked about)", () => {
    expect(interpretLndInvoice(fx.open, HASH).invoiceState).toBe("open");
    expect(interpretLndInvoice(fx.canceled, HASH).invoiceState).toBe("canceled");
    expect(interpretLndInvoice(fx.accepted_hold, HASH).invoiceState).toBe("accepted");
    expect(interpretLndInvoice(fx.canceled, "b2".repeat(32)).invoiceState).toBeUndefined();
    const { r_hash: _h, ...noHash } = fx.canceled;
    expect(interpretLndInvoice(noHash, HASH).invoiceState).toBeUndefined();
  });

  test("state is authoritative over the deprecated settled flag", () => {
    expect(interpretLndInvoice({ ...fx.open, settled: true }, HASH).settled).toBe(false);
    const { state: _s, ...legacy } = fx.settled;
    expect(interpretLndInvoice(legacy, HASH).settled).toBe(true);
  });

  test("a response for a different r_hash is rejected", () => {
    expect(interpretLndInvoice(fx.settled, "b2".repeat(32)).settled).toBe(false);
  });

  test("a preimage that doesn't hash to the payment hash is rejected", () => {
    const bad = { ...fx.settled, r_preimage: Buffer.alloc(32, 7).toString("base64") };
    expect(interpretLndInvoice(bad, HASH).settled).toBe(false);
  });

  test("underpaid (amt_paid_msat < value_msat) is rejected", () => {
    expect(interpretLndInvoice({ ...fx.settled, amt_paid_msat: "999999" }, HASH).settled).toBe(false);
    expect(interpretLndInvoice({ ...fx.settled, amt_paid_msat: "nope" }, HASH).settled).toBe(false);
  });

  test("fails closed when a SETTLED body is missing its proof fields", () => {
    for (const field of ["r_hash", "r_preimage", "value_msat", "amt_paid_msat"]) {
      const { [field]: _drop, ...partial } = fx.settled;
      expect(interpretLndInvoice(partial, HASH).settled, field).toBe(false);
    }
  });

  test("zero-amount (amountless) invoices are rejected", () => {
    expect(interpretLndInvoice({ ...fx.settled, value_msat: "0", amt_paid_msat: "0" }, HASH).settled).toBe(false);
    expect(interpretLndInvoice({ ...fx.settled, value_msat: "0" }, HASH).settled).toBe(false);
  });
});

describe("LndRestProvider.checkSettlement over HTTP (#47)", () => {
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

  test("OPEN then SETTLED: detected once paid, looked up by hex hash with the macaroon", async () => {
    const pool = agent.get(BASE);
    pool.intercept({ path: `/v1/invoice/${HASH}`, method: "GET", headers: { "grpc-metadata-macaroon": "mac" } }).reply(200, fx.open);
    pool.intercept({ path: `/v1/invoice/${HASH}`, method: "GET", headers: { "grpc-metadata-macaroon": "mac" } }).reply(200, fx.settled);
    const p = new LndRestProvider(BASE, "mac");
    expect((await p.checkSettlement(fx.settled.payment_request, fx.settled.r_hash)).settled).toBe(false);
    const s = await p.checkSettlement(fx.settled.payment_request, fx.settled.r_hash);
    expect(s).toMatchObject({ settled: true, paymentHash: HASH, preimage: fx.preimage_hex });
  });

  test("404 / 5xx from LND is a lookup failure, never \"unpaid\" (a paid intent must not be expired on it)", async () => {
    agent.get(BASE).intercept({ path: `/v1/invoice/${HASH}`, method: "GET" }).reply(404, { code: 5, message: "unable to locate invoice" });
    agent.get(BASE).intercept({ path: `/v1/invoice/${HASH}`, method: "GET" }).reply(503, "starting");
    const p = new LndRestProvider(BASE, "mac");
    await expect(p.checkSettlement("lnbc", HASH)).rejects.toThrow(/lnd_invoice_lookup_404/);
    await expect(p.checkSettlement("lnbc", HASH)).rejects.toThrow(/lnd_invoice_lookup_503/);
  });
});
