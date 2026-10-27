import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { LndRestProvider, lndHashToHex } from "../../src/economy/lightning.js";

const HASH_HEX = "a1".repeat(32);
const HASH_B64 = Buffer.from(HASH_HEX, "hex").toString("base64");
const BASE = "https://lnd.test:8080";

describe("LND settlement lookup (#42 review)", () => {
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

  test("lndHashToHex converts base64 r_hash to hex and keeps hex as-is", () => {
    expect(lndHashToHex(HASH_B64)).toBe(HASH_HEX);
    expect(lndHashToHex(HASH_HEX.toUpperCase())).toBe(HASH_HEX);
    expect(lndHashToHex("not-a-hash")).toBeUndefined();
    expect(lndHashToHex(undefined)).toBeUndefined();
  });

  test("createInvoice stores the hex payment hash", async () => {
    agent.get(BASE).intercept({ path: "/v1/invoices", method: "POST" }).reply(200, { payment_request: "lnbc1test", r_hash: HASH_B64 });
    const p = new LndRestProvider(BASE, "macaroon");
    const inv = await p.createInvoice({ amountSats: 10, memo: "m", expiresInSeconds: 60 });
    expect(inv.paymentHash).toBe(HASH_HEX);
  });

  test("checkSettlement GETs /v1/invoice/<hex r_hash>, not the bolt11", async () => {
    agent
      .get(BASE)
      .intercept({ path: `/v1/invoice/${HASH_HEX}`, method: "GET" })
      .reply(200, { settled: true, state: "SETTLED", r_hash: HASH_B64 });
    const p = new LndRestProvider(BASE, "macaroon");
    const s = await p.checkSettlement("lnbc1test", HASH_B64);
    expect(s).toMatchObject({ settled: true, paymentHash: HASH_HEX, txRef: `lnd:${HASH_HEX}` });
  });

  test("no stored hash -> not settled, no request", async () => {
    const p = new LndRestProvider(BASE, "macaroon");
    expect(await p.checkSettlement("lnbc1test")).toEqual({ settled: false });
  });
});
