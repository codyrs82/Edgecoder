// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash, randomUUID } from "node:crypto";
import { request } from "undici";

export interface CreateInvoiceInput {
  amountSats: number;
  memo: string;
  expiresInSeconds: number;
}

export interface CreateInvoiceResult {
  invoiceRef: string;
  paymentHash: string;
  expiresAtMs: number;
}

export interface SettlementResult {
  settled: boolean;
  txRef?: string;
  /** Payment hash reported by the node for the settled invoice (proof of payment). */
  paymentHash?: string;
  /** Preimage reported by the node, when available. */
  preimage?: string;
}

export interface LightningProvider {
  createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult>;
  /**
   * Ask the node whether the invoice is paid. `paymentHash` is the hash stored at
   * invoice creation (hex); LND looks invoices up by hash, not by bolt11.
   */
  checkSettlement(invoiceRef: string, paymentHash?: string): Promise<SettlementResult>;
}

class MockLightningProvider implements LightningProvider {
  async createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    const id = randomUUID();
    return {
      invoiceRef: `mockln:${id}:${input.amountSats}`,
      paymentHash: randomUUID().replace(/-/g, ""),
      expiresAtMs: Date.now() + input.expiresInSeconds * 1000
    };
  }

  async checkSettlement(invoiceRef: string): Promise<SettlementResult> {
    return {
      settled: true,
      txRef: `mock-settlement-${randomUUID()}`,
      paymentHash: createHash("sha256").update(invoiceRef).digest("hex")
    };
  }
}

/**
 * LND REST returns `r_hash` as base64; `GET /v1/invoice/{r_hash_str}` expects hex.
 * Accepts either encoding and returns lowercase hex (or undefined if invalid).
 */
export function lndHashToHex(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();
  const buf = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buf.length === 32 ? buf.toString("hex") : undefined;
}

export class LndRestProvider implements LightningProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly macaroonHex: string
  ) {}

  async createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    const res = await request(`${this.baseUrl}/v1/invoices`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Grpc-Metadata-macaroon": this.macaroonHex
      },
      body: JSON.stringify({
        value: String(input.amountSats),
        memo: input.memo,
        expiry: String(input.expiresInSeconds)
      })
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`lnd_invoice_create_failed:${res.statusCode}`);
    }
    const body = (await res.body.json()) as { payment_request?: string; r_hash?: string };
    if (!body.payment_request || !body.r_hash) {
      throw new Error("lnd_invoice_create_invalid_response");
    }
    const paymentHash = lndHashToHex(body.r_hash);
    if (!paymentHash) throw new Error("lnd_invoice_create_invalid_r_hash");
    return {
      invoiceRef: body.payment_request,
      // stored hex so settlement can look the invoice up by r_hash_str
      paymentHash,
      expiresAtMs: Date.now() + input.expiresInSeconds * 1000
    };
  }

  async checkSettlement(_invoiceRef: string, paymentHash?: string): Promise<SettlementResult> {
    // #42 review: LND's GET /v1/invoice/{r_hash_str} takes the hex payment hash, not the bolt11.
    const hashHex = lndHashToHex(paymentHash);
    if (!hashHex) return { settled: false };
    const res = await request(`${this.baseUrl}/v1/invoice/${hashHex}`, {
      method: "GET",
      headers: {
        "Grpc-Metadata-macaroon": this.macaroonHex
      }
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return { settled: false };
    }
    const body = (await res.body.json()) as LndInvoice;
    return interpretLndInvoice(body, hashHex);
  }
}

/** Subset of LND's `lnrpc.Invoice` REST JSON (int64 fields arrive as strings). */
export interface LndInvoice {
  settled?: boolean;
  state?: "OPEN" | "SETTLED" | "CANCELED" | "ACCEPTED" | string;
  r_hash?: string;
  r_preimage?: string;
  value_msat?: string;
  amt_paid_msat?: string;
}

/**
 * #47: decide settlement from an LND invoice response. Fails closed: anything
 * missing or inconsistent on a money path counts as unpaid.
 * - `state` is authoritative (`settled` is deprecated); only SETTLED counts, so an
 *   ACCEPTED hold invoice or a CANCELED one is unpaid.
 * - r_hash, r_preimage, value_msat and amt_paid_msat are all required: LND returns
 *   them for a settled invoice it created, so a body without them means a proxy,
 *   version mismatch or spoofed response.
 * - The returned r_hash must be the invoice we asked for, and the preimage must
 *   hash to it (proof of payment). AMP/keysend invoices would fail this check;
 *   that is intended, since we never create them.
 * - value_msat must be > 0 (we never create amountless invoices, where any
 *   payment would "cover" the value) and amt_paid_msat must cover it.
 */
export function interpretLndInvoice(body: LndInvoice, hashHex: string): SettlementResult {
  const settled = body.state !== undefined ? body.state === "SETTLED" : body.settled === true;
  if (!settled) return { settled: false };
  if (!body.r_hash || !body.r_preimage || body.value_msat === undefined || body.amt_paid_msat === undefined) {
    return { settled: false };
  }
  if (lndHashToHex(body.r_hash) !== hashHex) return { settled: false };
  const preimage = Buffer.from(body.r_preimage.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("hex");
  if (preimage.length !== 64 || createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") !== hashHex) {
    return { settled: false };
  }
  try {
    const value = BigInt(body.value_msat);
    if (value <= 0n || BigInt(body.amt_paid_msat) < value) return { settled: false };
  } catch {
    return { settled: false };
  }
  return { settled: true, txRef: `lnd:${hashHex}`, paymentHash: hashHex, preimage };
}

class ClnRestProvider implements LightningProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string
  ) {}

  async createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    const res = await request(`${this.baseUrl}/v1/invoice/genInvoice`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiToken}`
      },
      body: JSON.stringify({
        amountMsat: `${input.amountSats * 1000}msat`,
        description: input.memo,
        expiry: input.expiresInSeconds
      })
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`cln_invoice_create_failed:${res.statusCode}`);
    }
    const body = (await res.body.json()) as { bolt11?: string; paymentHash?: string };
    if (!body.bolt11 || !body.paymentHash) {
      throw new Error("cln_invoice_create_invalid_response");
    }
    return {
      invoiceRef: body.bolt11,
      paymentHash: body.paymentHash,
      expiresAtMs: Date.now() + input.expiresInSeconds * 1000
    };
  }

  async checkSettlement(invoiceRef: string): Promise<SettlementResult> {
    const res = await request(`${this.baseUrl}/v1/invoice/listInvoices?invstring=${encodeURIComponent(invoiceRef)}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.apiToken}`
      }
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return { settled: false };
    }
    const body = (await res.body.json()) as {
      invoices?: Array<{ status?: string; payment_hash?: string; payment_preimage?: string }>;
    };
    const paid = (body.invoices ?? []).find((i) => i.status === "paid");
    const settled = Boolean(paid);
    return {
      settled,
      txRef: settled ? `cln:${paid?.payment_hash ?? invoiceRef}` : undefined,
      paymentHash: paid?.payment_hash,
      preimage: paid?.payment_preimage
    };
  }
}

/**
 * ECONOMY_PAYMENTS_ENABLED switch. Default on; "0", "false", "off" or "no"
 * (case-insensitive, trimmed) turn payments off.
 */
export function economyPaymentsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.ECONOMY_PAYMENTS_ENABLED ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

export function createLightningProviderFromEnv(): LightningProvider {
  const raw = process.env.LIGHTNING_PROVIDER?.trim().toLowerCase() || undefined;
  const isProd = process.env.NODE_ENV === "production";
  const provider = raw ?? (isProd ? "" : "mock");
  if (provider === "lnd") {
    const baseUrl = process.env.LND_REST_URL;
    const macaroonHex = process.env.LND_MACAROON_HEX;
    if (!baseUrl || !macaroonHex) {
      throw new Error("lnd_provider_missing_env");
    }
    return new LndRestProvider(baseUrl, macaroonHex);
  }
  if (provider === "cln") {
    const baseUrl = process.env.CLN_REST_URL;
    const apiToken = process.env.CLN_API_TOKEN;
    if (!baseUrl || !apiToken) {
      throw new Error("cln_provider_missing_env");
    }
    return new ClnRestProvider(baseUrl, apiToken);
  }
  if (isProd) {
    throw new Error("lightning_provider_required: set LIGHTNING_PROVIDER=lnd|cln in production");
  }
  if (provider !== "mock") {
    throw new Error(`unknown_lightning_provider:${provider}`);
  }
  if (process.env.ALLOW_MOCK_LIGHTNING !== "1" && process.env.NODE_ENV !== "test") {
    throw new Error("mock_lightning_disabled: set ALLOW_MOCK_LIGHTNING=1 for local dev");
  }
  console.warn("[lightning] using MockLightningProvider — all invoices auto-settle");
  return new MockLightningProvider();
}
