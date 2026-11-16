// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * TEST NETWORKS ONLY. Local LNURL-pay endpoints for test payees on Mutinynet (signet):
 *   http://127.0.0.1:<port>/.well-known/lnurlp/<name>
 * Each name stands for a payee that is not EdgeCoder's node: a test host ("host1", "host2") and
 * the fee recipient ("edgecoder-fee"). Invoices are minted by the Mutinynet faucet's node
 * (faucet.mutinynet.com/api/bolt11), so every payment lands on a third-party node; the faucet can't
 * commit to LNURL metadata, so the resolver runs with DIRECT_PAY_ALLOW_UNCOMMITTED (test only).
 * Prints one JSON line per invoice minted (name, amount, payment hash).
 */

import { createServer } from "node:http";
import { decodeBolt11 } from "../../src/economy/bolt11.js";

const port = Number(process.env.TEST_LNURL_PORT ?? 18787);
const names = new Set((process.env.TEST_LNURL_NAMES ?? "host1,host2,edgecoder-fee").split(","));

async function faucetInvoice(sats: number): Promise<string> {
  const res = await fetch("https://faucet.mutinynet.com/api/bolt11", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount_sats: sats }), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`faucet_http_${res.status}`);
  return ((await res.json()) as { bolt11: string }).bolt11;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  let m = /^\/\.well-known\/lnurlp\/([a-z0-9-]+)$/.exec(url.pathname);
  if (m && names.has(m[1])) {
    return send(200, { tag: "payRequest", callback: `http://127.0.0.1:${port}/cb/${m[1]}`, minSendable: 1000, maxSendable: 1_000_000_000, metadata: JSON.stringify([["text/plain", `EdgeCoder signet test payee ${m[1]}`]]) });
  }
  m = /^\/cb\/([a-z0-9-]+)$/.exec(url.pathname);
  if (m && names.has(m[1])) {
    const msat = Number(url.searchParams.get("amount"));
    if (!Number.isInteger(msat) || msat % 1000 !== 0 || msat <= 0) return send(200, { status: "ERROR", reason: "whole sats only" });
    try {
      const pr = await faucetInvoice(msat / 1000);
      console.log(JSON.stringify({ event: "invoice_minted", payee: m[1], amountMsat: msat, paymentHash: decodeBolt11(pr).paymentHash, payeeNode: decodeBolt11(pr).payeePubkey ?? null }));
      return send(200, { pr, routes: [] });
    } catch (err) {
      return send(200, { status: "ERROR", reason: String(err) });
    }
  }
  send(404, { status: "ERROR", reason: "not found" });
}).listen(port, "127.0.0.1", () => console.log(JSON.stringify({ event: "test_lnurl_ready", port, names: [...names] })));
