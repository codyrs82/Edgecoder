// LndRestProvider.payInvoice over SendPaymentV2 (POST /v2/router/send, NDJSON). Issue #261.
// No Lightning node is contacted: HTTP is mocked with undici's MockAgent.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { LndRestProvider, payFailureIsFinal } from "../../src/economy/lightning.js";

const BASE = "https://lnd.test:8080";
const PREIMAGE = Buffer.alloc(32, 9).toString("hex");
const HASH = createHash("sha256").update(Buffer.from(PREIMAGE, "hex")).digest("hex");
const input = { bolt11: "lnbcrt1test", maxFeeSats: 12, timeoutSeconds: 30 };

const ndjson = (...lines: unknown[]) => lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
const payment = (fields: Record<string, unknown>) => ({ result: { payment_hash: HASH, value_msat: "2000000", fee_msat: "0", ...fields } });

describe("LndRestProvider.payInvoice via /v2/router/send", () => {
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
  const lnd = () => new LndRestProvider(BASE, "mac");
  const reply = (status: number, body: string) => agent.get(BASE).intercept({ path: "/v2/router/send", method: "POST" }).reply(status, body);

  it("sends timeout_seconds, a msat fee cap and no_inflight_updates", async () => {
    let sent: Record<string, unknown> = {};
    agent
      .get(BASE)
      .intercept({ path: "/v2/router/send", method: "POST" })
      .reply(200, (opts) => {
        sent = JSON.parse(String(opts.body));
        return ndjson(payment({ status: "SUCCEEDED", payment_preimage: PREIMAGE }));
      });
    await lnd().payInvoice({ ...input, amountMsat: 5000 });
    expect(sent).toMatchObject({
      payment_request: "lnbcrt1test",
      timeout_seconds: 30,
      fee_limit_msat: "12000",
      amt_msat: "5000",
      allow_self_payment: false,
      no_inflight_updates: true
    });
  });

  it("SUCCEEDED returns fee, amount, hash and preimage", async () => {
    reply(200, ndjson(payment({ status: "SUCCEEDED", payment_preimage: PREIMAGE, fee_msat: "1234" })));
    expect(await lnd().payInvoice(input)).toEqual({ status: "succeeded", paymentHash: HASH, preimage: PREIMAGE, feeMsat: 1234, amountMsat: 2_000_000 });
  });

  it("takes the final update after earlier in-flight lines", async () => {
    reply(200, ndjson(payment({ status: "IN_FLIGHT" }), payment({ status: "SUCCEEDED", payment_preimage: PREIMAGE })));
    expect((await lnd().payInvoice(input)).status).toBe("succeeded");
  });

  it("SUCCEEDED without a preimage, or with one that does not hash to payment_hash, is not paid and not final", async () => {
    reply(200, ndjson(payment({ status: "SUCCEEDED", payment_preimage: "00".repeat(32) })));
    reply(200, ndjson(payment({ status: "SUCCEEDED", payment_preimage: "ab".repeat(32) })));
    const results = [await lnd().payInvoice(input), await lnd().payInvoice(input)];
    expect(results.map((r) => r.status)).toEqual(["failed", "failed"]);
    expect(results.map((r) => r.error)).toEqual(["lnd_pay_no_preimage", "lnd_pay_preimage_mismatch"]);
    expect(results.map((r) => payFailureIsFinal(r.error))).toEqual([false, false]);
  });

  for (const reason of [
    "FAILURE_REASON_TIMEOUT",
    "FAILURE_REASON_NO_ROUTE",
    "FAILURE_REASON_ERROR",
    "FAILURE_REASON_INCORRECT_PAYMENT_DETAILS",
    "FAILURE_REASON_INSUFFICIENT_BALANCE",
    "FAILURE_REASON_CANCELED"
  ]) {
    it(`FAILED with ${reason} is a final failure`, async () => {
      reply(200, ndjson(payment({ status: "FAILED", failure_reason: reason })));
      const r = await lnd().payInvoice(input);
      expect(r).toMatchObject({ status: "failed", paymentHash: HASH, error: `lnd_pay_failed:${reason}` });
      expect(payFailureIsFinal(r.error)).toBe(true);
    });
  }

  it("FAILED with FAILURE_REASON_NONE or no reason stays unconfirmed", async () => {
    reply(200, ndjson(payment({ status: "FAILED", failure_reason: "FAILURE_REASON_NONE" })));
    reply(200, ndjson(payment({ status: "FAILED" })));
    const results = [await lnd().payInvoice(input), await lnd().payInvoice(input)];
    expect(results.map((r) => payFailureIsFinal(r.error))).toEqual([false, false]);
  });

  it("an error line before any update is final, except already paid / in transition", async () => {
    reply(200, ndjson({ error: { code: 2, message: "invoice expired" } }));
    reply(200, ndjson({ error: { code: 6, message: "invoice is already paid" } }));
    reply(200, ndjson({ error: { code: 6, message: "payment is in transition" } }));
    const results = [await lnd().payInvoice(input), await lnd().payInvoice(input), await lnd().payInvoice(input)];
    expect(results.map((r) => r.error)).toEqual(["lnd_pay_error:invoice expired", "lnd_pay_error:invoice is already paid", "lnd_pay_error:payment is in transition"]);
    expect(results.map((r) => payFailureIsFinal(r.error))).toEqual([true, false, false]);
  });

  it("an error line after an in-flight update stays unconfirmed", async () => {
    reply(200, ndjson(payment({ status: "IN_FLIGHT" }), { error: { code: 1, message: "context canceled" } }));
    const r = await lnd().payInvoice(input);
    expect(r.error).toBe("lnd_pay_stream_error:context canceled");
    expect(payFailureIsFinal(r.error)).toBe(false);
  });

  it("a stream that ends in flight, or empty, stays unconfirmed", async () => {
    reply(200, ndjson(payment({ status: "IN_FLIGHT" })));
    reply(200, JSON.stringify(payment({ status: "IN_FLIGHT" }))); // truncated: no trailing newline
    reply(200, "");
    const results = [await lnd().payInvoice(input), await lnd().payInvoice(input), await lnd().payInvoice(input)];
    expect(results.map((r) => r.status)).toEqual(["failed", "failed", "failed"]);
    expect(results.map((r) => r.error)).toEqual(["lnd_pay_unconfirmed:IN_FLIGHT", "lnd_pay_unconfirmed:IN_FLIGHT", "lnd_pay_unconfirmed:no_final_status"]);
    expect(results[0].paymentHash).toBe(HASH);
    expect(results.map((r) => payFailureIsFinal(r.error))).toEqual([false, false, false]);
  });

  it("a stream cut mid-line stays unconfirmed", async () => {
    reply(200, JSON.stringify(payment({ status: "SUCCEEDED", payment_preimage: PREIMAGE })).slice(0, 40));
    const r = await lnd().payInvoice(input);
    expect(r.status).toBe("failed");
    expect(payFailureIsFinal(r.error)).toBe(false);
  });

  it("HTTP 5xx stays unconfirmed", async () => {
    reply(500, JSON.stringify({ code: 2, message: "internal" }));
    reply(503, "<html>Service Unavailable</html>");
    const results = [await lnd().payInvoice(input), await lnd().payInvoice(input)];
    expect(results.map((r) => r.error)).toEqual(["lnd_pay_http_500:internal", "lnd_pay_http_503:"]);
    expect(results.map((r) => payFailureIsFinal(r.error))).toEqual([false, false]);
  });

  it("malformed lines are skipped; alone they leave the payment unconfirmed", async () => {
    reply(200, ndjson("not json", "{\"result\":", "[1,2]", "null"));
    reply(200, ndjson("garbage{", payment({ status: "SUCCEEDED", payment_preimage: PREIMAGE })));
    const [bad, ok] = [await lnd().payInvoice(input), await lnd().payInvoice(input)];
    expect(bad.status).toBe("failed");
    expect(payFailureIsFinal(bad.error)).toBe(false);
    expect(ok.status).toBe("succeeded");
  });

  it("a transport error stays unconfirmed", async () => {
    agent.get(BASE).intercept({ path: "/v2/router/send", method: "POST" }).replyWithError(new Error("socket hang up"));
    const r = await lnd().payInvoice(input);
    expect(r.error).toMatch(/^lnd_pay_transport:/);
    expect(payFailureIsFinal(r.error)).toBe(false);
  });
});
