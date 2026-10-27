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
    const body = (await res.body.json()) as { settled?: boolean; state?: string; r_hash?: string; r_preimage?: string };
    const settled = Boolean(body.settled) || body.state === "SETTLED";
    return {
      settled,
      txRef: settled ? `lnd:${hashHex}` : undefined,
      paymentHash: settled ? hashHex : undefined,
      preimage: settled && body.r_preimage ? Buffer.from(body.r_preimage, "base64").toString("hex") : undefined
    };
  }
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
