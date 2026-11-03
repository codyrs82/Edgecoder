import { createHash } from "node:crypto";
import { request } from "undici";
import { describe, expect, it } from "vitest";
import { LndRestProvider, lndDispatcher } from "../../src/economy/lightning.js";

/*
 * #98 / #47 acceptance: a settled invoice is detected against a real (regtest) LND node.
 * Gated: runs only with LND_REGTEST=1 and the node details scripts/e2e/lnd-regtest.sh exports
 * after starting tests/e2e/docker-compose.lnd-regtest.yml and opening a bob -> alice channel.
 * `npm test` never includes tests/e2e, and `npm run test:integration` skips this without the gate.
 */
const enabled = process.env.LND_REGTEST === "1";

function nodeEnv(prefix: "ALICE" | "BOB"): { url: string; macaroon: string; cert: string } {
  const url = process.env[`LND_REGTEST_${prefix}_URL`];
  const macaroon = process.env[`LND_REGTEST_${prefix}_MACAROON`];
  const cert = process.env[`LND_REGTEST_${prefix}_TLS_CERT_BASE64`];
  if (!url || !macaroon || !cert) throw new Error(`LND_REGTEST_${prefix}_{URL,MACAROON,TLS_CERT_BASE64} must be set (run scripts/e2e/lnd-regtest.sh)`);
  return { url, macaroon, cert };
}

function node(prefix: "ALICE" | "BOB"): LndRestProvider {
  const { url, macaroon, cert } = nodeEnv(prefix);
  // The pinned tls.cert is the only CA trusted for the connection, as in production.
  return new LndRestProvider(url, macaroon, lndDispatcher(cert));
}

/**
 * Pay from bob with routerrpc.SendPaymentV2 (POST /v2/router/send). Not LndRestProvider.payInvoice:
 * that uses SendPaymentSync (POST /v1/channels/transactions), which LND v0.21 removed (404).
 * The response is newline-delimited JSON payment updates; the last one has the final status.
 */
async function payFromBob(bolt11: string): Promise<{ status: string; paymentHash: string; preimage: string; failureReason?: string }> {
  const { url, macaroon, cert } = nodeEnv("BOB");
  const res = await request(`${url}/v2/router/send`, {
    dispatcher: lndDispatcher(cert),
    method: "POST",
    headers: { "content-type": "application/json", "Grpc-Metadata-macaroon": macaroon },
    body: JSON.stringify({ payment_request: bolt11, timeout_seconds: 60, fee_limit_sat: "10", no_inflight_updates: true }),
    headersTimeout: 90_000,
    bodyTimeout: 90_000
  });
  const text = await res.body.text();
  if (res.statusCode !== 200) throw new Error(`bob /v2/router/send HTTP ${res.statusCode}: ${text}`);
  const updates = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { result?: { status: string; payment_hash: string; payment_preimage: string; failure_reason?: string }; error?: unknown });
  const last = updates.at(-1);
  if (!last?.result) throw new Error(`bob payment returned no result: ${text}`);
  return { status: last.result.status, paymentHash: last.result.payment_hash, preimage: last.result.payment_preimage, failureReason: last.result.failure_reason };
}

describe.skipIf(!enabled)("LND regtest settlement (#98)", { timeout: 120_000 }, () => {
  it("detects a settled invoice paid from a second node, with a preimage that hashes to the payment hash", async () => {
    const alice = node("ALICE");

    const invoice = await alice.createInvoice({ amountSats: 1_000, memo: "edgecoder #98 regtest", expiresInSeconds: 600 });
    expect(invoice.invoiceRef).toMatch(/^lnbcrt/);
    expect(invoice.paymentHash).toMatch(/^[0-9a-f]{64}$/);

    // Unpaid: an open invoice must not count as settled.
    expect(await alice.checkSettlement(invoice.invoiceRef, invoice.paymentHash)).toEqual({ settled: false });

    const paid = await payFromBob(invoice.invoiceRef);
    expect(paid.status, paid.failureReason).toBe("SUCCEEDED");
    expect(paid.paymentHash).toBe(invoice.paymentHash);

    // SendPaymentSync returns once the HTLC settles; poll briefly in case the invoice DB lags.
    let settlement = await alice.checkSettlement(invoice.invoiceRef, invoice.paymentHash);
    for (let i = 0; i < 20 && !settlement.settled; i++) {
      await new Promise((r) => setTimeout(r, 500));
      settlement = await alice.checkSettlement(invoice.invoiceRef, invoice.paymentHash);
    }
    expect(settlement.settled).toBe(true);
    expect(settlement.paymentHash).toBe(invoice.paymentHash);
    expect(settlement.preimage).toMatch(/^[0-9a-f]{64}$/);
    expect(createHash("sha256").update(Buffer.from(settlement.preimage!, "hex")).digest("hex")).toBe(invoice.paymentHash);
    // The payer's proof of payment is the same preimage.
    expect(paid.preimage).toBe(settlement.preimage);
  });

  it("does not report a different invoice as settled", async () => {
    const alice = node("ALICE");
    const other = await alice.createInvoice({ amountSats: 500, memo: "edgecoder #98 unpaid", expiresInSeconds: 600 });
    expect(await alice.checkSettlement(other.invoiceRef, other.paymentHash)).toEqual({ settled: false });
  });
});
