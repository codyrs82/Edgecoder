import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { createLightningProviderFromEnv, interpretClnInvoices, type ClnInvoice } from "../../src/economy/lightning.js";

// Core Lightning settlement detection, with the same fail-closed rules as the LND path.
const preimage = randomBytes(32).toString("hex");
const HASH = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
const BOLT11 = "lnbc100n1testinvoice";
const paid: ClnInvoice = {
  status: "paid",
  bolt11: BOLT11,
  payment_hash: HASH,
  payment_preimage: preimage,
  amount_msat: "100000msat",
  amount_received_msat: "100000msat"
};

describe("interpretClnInvoices", () => {
  test("a paid, fully received invoice with a matching preimage is settled", () => {
    expect(interpretClnInvoices([paid], { hashHex: HASH })).toEqual({ settled: true, txRef: `cln:${HASH}`, paymentHash: HASH, preimage });
    // numeric msat fields (newer CLN) are accepted too
    expect(interpretClnInvoices([{ ...paid, amount_msat: 100000, amount_received_msat: 100000 }], { hashHex: HASH }).settled).toBe(true);
  });

  test("unpaid / expired are not settled, and another invoice being paid does not count", () => {
    expect(interpretClnInvoices([{ ...paid, status: "unpaid" }], { hashHex: HASH }).settled).toBe(false);
    expect(interpretClnInvoices([{ ...paid, status: "expired" }], { hashHex: HASH }).settled).toBe(false);
    const other = { ...paid, payment_hash: "ab".repeat(32), bolt11: "lnbc1other" };
    expect(interpretClnInvoices([other], { hashHex: HASH }).settled).toBe(false);
    expect(interpretClnInvoices([other], { bolt11: BOLT11 }).settled).toBe(false);
  });

  test("falls back to the bolt11 when no payment hash is stored", () => {
    expect(interpretClnInvoices([paid], { bolt11: BOLT11 }).settled).toBe(true);
    expect(interpretClnInvoices([paid], {}).settled).toBe(false);
  });

  test("preimage must hash to the payment hash", () => {
    expect(interpretClnInvoices([{ ...paid, payment_preimage: "00".repeat(32) }], { hashHex: HASH }).settled).toBe(false);
    expect(interpretClnInvoices([{ ...paid, payment_preimage: undefined }], { hashHex: HASH }).settled).toBe(false);
  });

  test("underpaid, amountless or malformed amounts are rejected", () => {
    expect(interpretClnInvoices([{ ...paid, amount_received_msat: "99999msat" }], { hashHex: HASH }).settled).toBe(false);
    expect(interpretClnInvoices([{ ...paid, amount_msat: "0msat", amount_received_msat: "0msat" }], { hashHex: HASH }).settled).toBe(false);
    expect(interpretClnInvoices([{ ...paid, amount_msat: "lots" }], { hashHex: HASH }).settled).toBe(false);
    expect(interpretClnInvoices([{ ...paid, amount_received_msat: undefined }], { hashHex: HASH }).settled).toBe(false);
  });
});

describe("ClnRestProvider.checkSettlement over HTTP", () => {
  let original: Dispatcher;
  let agent: MockAgent;
  const BASE = "https://cln.test:3001";
  beforeEach(() => {
    original = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    process.env.LIGHTNING_PROVIDER = "cln";
    process.env.CLN_REST_URL = BASE;
    process.env.CLN_API_TOKEN = "tok";
  });
  afterEach(async () => {
    setGlobalDispatcher(original);
    await agent.close();
    delete process.env.LIGHTNING_PROVIDER;
    delete process.env.CLN_REST_URL;
    delete process.env.CLN_API_TOKEN;
  });

  test("looks the invoice up by payment hash with the bearer token; unpaid then paid", async () => {
    const pool = agent.get(BASE);
    pool.intercept({ path: `/v1/invoice/listInvoices?payment_hash=${HASH}`, method: "GET", headers: { authorization: "Bearer tok" } })
      .reply(200, { invoices: [{ ...paid, status: "unpaid", payment_preimage: undefined, amount_received_msat: undefined }] });
    pool.intercept({ path: `/v1/invoice/listInvoices?payment_hash=${HASH}`, method: "GET", headers: { authorization: "Bearer tok" } })
      .reply(200, { invoices: [paid] });
    const p = createLightningProviderFromEnv();
    expect((await p.checkSettlement(BOLT11, HASH)).settled).toBe(false);
    expect(await p.checkSettlement(BOLT11, HASH)).toMatchObject({ settled: true, paymentHash: HASH, preimage });
  });

  test("falls back to invstring without a hash; node errors are not settled", async () => {
    const pool = agent.get(BASE);
    pool.intercept({ path: `/v1/invoice/listInvoices?invstring=${encodeURIComponent(BOLT11)}`, method: "GET" }).reply(200, { invoices: [paid] });
    pool.intercept({ path: `/v1/invoice/listInvoices?payment_hash=${HASH}`, method: "GET" }).reply(500, { error: "boom" });
    const p = createLightningProviderFromEnv();
    expect((await p.checkSettlement(BOLT11)).settled).toBe(true);
    expect(await p.checkSettlement(BOLT11, HASH)).toEqual({ settled: false });
  });
});
