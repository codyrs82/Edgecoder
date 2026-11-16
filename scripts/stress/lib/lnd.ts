// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Minimal LND REST client for the harness: the payee node pays top-up invoices and issues the
 * invoices providers withdraw to; the hub node (local only) is read by the invariant checker to
 * match ledger rows against what Lightning actually did.
 */
import { createHash } from "node:crypto";
import type { Recorder } from "./metrics.js";
import { call } from "./http.js";
import type { LndCred } from "./target.js";

export class LndClient {
  private readonly ca: string;
  constructor(private readonly cred: LndCred, private readonly rec: Recorder | null, private readonly servername?: string, private readonly label = "lnd") {
    this.ca = Buffer.from(cred.tlsCertBase64, "base64").toString("utf8");
  }

  private req(endpoint: string, path: string, body?: object, timeoutMs = 60_000) {
    return call(this.rec, `${this.label} ${endpoint}`, `${this.cred.restUrl.replace(/\/$/, "")}${path}`, {
      method: body ? "POST" : "GET",
      body,
      headers: { "Grpc-Metadata-macaroon": this.cred.macaroonHex },
      ca: this.ca,
      servername: this.servername,
      timeoutMs
    });
  }

  async getInfo(): Promise<{ identity_pubkey: string; synced_to_chain: boolean }> {
    const r = await this.req("getinfo", "/v1/getinfo");
    if (r.status !== 200) throw new Error(`lnd getinfo ${r.outcome}`);
    return r.json;
  }

  /** Pay a BOLT11 synchronously. Returns the preimage (hex) on success. */
  async payInvoice(bolt11: string, opts: { feeLimitSats?: number; timeoutSeconds?: number } = {}): Promise<{ ok: boolean; preimageHex?: string; paymentHashHex?: string; error?: string; ms: number }> {
    const r = await this.req(
      "pay",
      "/v1/channels/transactions",
      { payment_request: bolt11, fee_limit: { fixed: String(opts.feeLimitSats ?? 100) }, ...(opts.timeoutSeconds ? { timeout_seconds: opts.timeoutSeconds } : {}) },
      120_000
    );
    const j = r.json ?? {};
    const preimageHex = j.payment_preimage ? Buffer.from(j.payment_preimage, "base64").toString("hex") : undefined;
    const paymentHashHex = j.payment_hash ? Buffer.from(j.payment_hash, "base64").toString("hex") : undefined;
    const ok = r.status === 200 && !j.payment_error && Boolean(preimageHex);
    return { ok, preimageHex, paymentHashHex, error: ok ? undefined : j.payment_error || r.outcome, ms: r.ms };
  }

  /** A new invoice on this node. */
  async addInvoice(amountSats: number, memo: string, expirySec = 3600): Promise<{ bolt11: string; paymentHashHex: string }> {
    const r = await this.req("addinvoice", "/v1/invoices", { value: String(amountSats), memo, expiry: String(expirySec) });
    if (r.status !== 200 || !r.json?.payment_request) throw new Error(`lnd addinvoice ${r.outcome}`);
    return { bolt11: r.json.payment_request, paymentHashHex: Buffer.from(r.json.r_hash, "base64").toString("hex") };
  }

  /** Invoices on this node (paged by index). */
  async listInvoices(max = 10_000): Promise<Array<{ paymentHashHex: string; state: string; valueMsat: number; amtPaidMsat: number; bolt11: string; settleDate: number }>> {
    const out: Array<{ paymentHashHex: string; state: string; valueMsat: number; amtPaidMsat: number; bolt11: string; settleDate: number }> = [];
    let offset = 0;
    for (;;) {
      const r = await this.req("listinvoices", `/v1/invoices?num_max_invoices=1000&index_offset=${offset}`);
      if (r.status !== 200) throw new Error(`lnd listinvoices ${r.outcome}`);
      const items = (r.json?.invoices ?? []) as any[];
      for (const i of items) {
        out.push({
          paymentHashHex: Buffer.from(i.r_hash, "base64").toString("hex"),
          state: i.state,
          valueMsat: Number(i.value_msat ?? 0),
          amtPaidMsat: Number(i.amt_paid_msat ?? 0),
          bolt11: i.payment_request,
          settleDate: Number(i.settle_date ?? 0)
        });
      }
      if (items.length < 1000 || out.length >= max) break;
      offset = Number(r.json.last_index_offset);
    }
    return out;
  }

  /** Outgoing payments made by this node. */
  async listPayments(max = 10_000): Promise<Array<{ paymentHashHex: string; status: string; valueMsat: number; feeMsat: number; preimageHex: string }>> {
    const out: Array<{ paymentHashHex: string; status: string; valueMsat: number; feeMsat: number; preimageHex: string }> = [];
    let offset = 0;
    for (;;) {
      const r = await this.req("listpayments", `/v1/payments?include_incomplete=true&max_payments=1000&index_offset=${offset}`);
      if (r.status !== 200) throw new Error(`lnd listpayments ${r.outcome}`);
      const items = (r.json?.payments ?? []) as any[];
      for (const p of items) out.push({ paymentHashHex: p.payment_hash, status: p.status, valueMsat: Number(p.value_msat ?? 0), feeMsat: Number(p.fee_msat ?? 0), preimageHex: p.payment_preimage ?? "" });
      if (items.length < 1000 || out.length >= max) break;
      offset = Number(r.json.last_index_offset);
    }
    return out;
  }
}

export function preimageMatchesHash(preimageHex: string | null | undefined, paymentHashHex: string): boolean {
  if (!preimageHex || !/^[0-9a-f]{64}$/i.test(preimageHex)) return false;
  return createHash("sha256").update(Buffer.from(preimageHex, "hex")).digest("hex") === paymentHashHex.toLowerCase();
}
