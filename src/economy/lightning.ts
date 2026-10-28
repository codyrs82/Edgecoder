// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
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
}

export interface LightningProvider {
  createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult>;
  checkSettlement(invoiceRef: string): Promise<SettlementResult>;
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

  async checkSettlement(_invoiceRef: string): Promise<SettlementResult> {
    return { settled: true, txRef: `mock-settlement-${randomUUID()}` };
  }
}

class LndRestProvider implements LightningProvider {
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
    return {
      invoiceRef: body.payment_request,
      paymentHash: body.r_hash,
      expiresAtMs: Date.now() + input.expiresInSeconds * 1000
    };
  }

  async checkSettlement(invoiceRef: string): Promise<SettlementResult> {
    const res = await request(`${this.baseUrl}/v1/invoice/${encodeURIComponent(invoiceRef)}`, {
      method: "GET",
      headers: {
        "Grpc-Metadata-macaroon": this.macaroonHex
      }
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return { settled: false };
    }
    const body = (await res.body.json()) as { settled?: boolean };
    return { settled: Boolean(body.settled), txRef: body.settled ? `lnd:${invoiceRef}` : undefined };
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
    const body = (await res.body.json()) as { invoices?: Array<{ status?: string }> };
    const settled = (body.invoices ?? []).some((i) => i.status === "paid");
    return { settled, txRef: settled ? `cln:${invoiceRef}` : undefined };
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
