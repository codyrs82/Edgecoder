// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createHash, randomUUID } from "node:crypto";
import { Agent, request, type Dispatcher } from "undici";
import { decodeBolt11 } from "./bolt11.js";
import { moduleLogger } from "../common/logger.js";

const logger = moduleLogger("lightning");

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

export interface PayInvoiceInput {
  bolt11: string;
  /** Absolute routing fee cap. The node must not spend more than this on top of the amount. */
  maxFeeSats: number;
  /** Amount for amountless invoices; ignored (must match) when the invoice carries one. */
  amountMsat?: number;
  timeoutSeconds?: number;
}

export interface PayInvoiceResult {
  status: "succeeded" | "failed";
  paymentHash?: string;
  /** Hex preimage returned by the node: proof the destination was paid. */
  preimage?: string;
  feeMsat?: number;
  amountMsat?: number;
  error?: string;
}

/** lnrpc.PaymentFailureReason values that come with a terminal FAILED status (NONE does not). */
const LND_FINAL_FAILURE_REASONS = new Set([
  "FAILURE_REASON_TIMEOUT",
  "FAILURE_REASON_NO_ROUTE",
  "FAILURE_REASON_ERROR",
  "FAILURE_REASON_INCORRECT_PAYMENT_DETAILS",
  "FAILURE_REASON_INSUFFICIENT_BALANCE",
  "FAILURE_REASON_CANCELED"
]);

/** The lnrpc.Payment fields read from a /v2/router/send update. */
interface LndRouterPayment {
  payment_hash?: string;
  payment_preimage?: string;
  value_msat?: string;
  fee_msat?: string;
  status?: string;
  failure_reason?: string;
}

/**
 * Whether a failed payInvoice result is a failure the node reported as final, so the payout can
 * be marked failed and its balance freed. Anything else (transport errors, HTTP errors that a
 * proxy may have produced, unreadable bodies, a CLN `pay` that is still pending, LND saying the
 * hash is already paid or in flight) is unconfirmed: the HTLC may still settle, so the payout
 * stays pending until the node's record of that payment hash says otherwise.
 */
export function payFailureIsFinal(error: string | undefined): boolean {
  if (!error) return false;
  // Refused before anything was sent (kill switch in front of the provider).
  if (error === "payouts_paused") return true;
  // LND SendPaymentV2 sent an error line before any payment update: the payment was not
  // dispatched, except when the error says an earlier payment of this hash succeeded or is in flight.
  if (error.startsWith("lnd_pay_error:")) return !/already paid|in transition|in.flight|already exists/i.test(error);
  // LND SendPaymentV2 reported status FAILED with one of its terminal failure reasons.
  if (error.startsWith("lnd_pay_failed:")) return LND_FINAL_FAILURE_REASONS.has(error.slice("lnd_pay_failed:".length));
  // Core Lightning answered 2xx with status "failed".
  if (error === "cln_pay_status:failed") return true;
  return false;
}

export interface LightningProvider {
  createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult>;
  /**
   * Ask the node whether the invoice is paid. `paymentHash` is the hash stored at
   * invoice creation (hex); LND looks invoices up by hash, not by bolt11.
   */
  checkSettlement(invoiceRef: string, paymentHash?: string): Promise<SettlementResult>;
  /** Pay a BOLT11 invoice from the node's wallet (payouts to workers and infrastructure hosts). */
  payInvoice(input: PayInvoiceInput): Promise<PayInvoiceResult>;
  /** Wallet + channel balances, for payout reconciliation. Optional: absent means unsupported. */
  getBalances?(): Promise<NodeBalances | ProviderUnsupported>;
  /** Outgoing payments created since `sinceMs`, for payout reconciliation. Optional: absent means unsupported. */
  listPayments?(input: { sinceMs: number; limit?: number }): Promise<NodePaymentList | ProviderUnsupported>;
  /** Sync state, channel activity and liquidity, for alerting (src/alerting). Optional: absent means unsupported. */
  getNodeHealth?(): Promise<LightningNodeHealth | ProviderUnsupported>;
}

/** What production alerting checks on the node (src/alerting/monitors.ts lightningMonitor). */
export interface LightningNodeHealth {
  supported: true;
  syncedToChain: boolean;
  syncedToGraph: boolean;
  blockHeight: number | null;
  activeChannels: number;
  inactiveChannels: number;
  pendingChannels: number;
  /** Spendable (outbound) sats in active channels. */
  localSats: number;
  /** Receivable (inbound) sats in active channels. */
  remoteSats: number;
  /** Inactive channels (peer offline), at most 20. */
  inactive: Array<{ chanId: string; remotePubkey: string; localSats: number }>;
}

/** A provider (or provider build) that cannot answer a reconciliation query. Never an error. */
export interface ProviderUnsupported {
  supported: false;
  reason: string;
}

/** Sats the node holds. `totalSats` is what reconciliation compares between runs. */
export interface NodeBalances {
  supported: true;
  onchainConfirmedSats: number;
  onchainUnconfirmedSats: number;
  /** Spendable local channel balance. */
  channelLocalSats: number;
  /** Local balance in channels still opening plus outgoing HTLCs in flight. */
  channelPendingSats: number;
  totalSats: number;
}

export interface NodePayment {
  paymentHash: string;
  status: "succeeded" | "failed" | "in_flight";
  valueMsat: number;
  feeMsat: number;
  createdAtMs: number;
  /** Hex preimage of a succeeded payment, when the node reports it. */
  preimage?: string;
}

export interface NodePaymentList {
  supported: true;
  payments: NodePayment[];
  /** The node returned `limit` rows; older/newer payments may be missing from this page. */
  truncated: boolean;
}

/** Normalise LND's base64 hashes / preimages (also accepts hex). */
function lndBytesToHex(value: string | undefined, bytes: number): string | undefined {
  if (!value) return undefined;
  if (new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) return value.toLowerCase();
  const buf = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buf.length === bytes ? buf.toString("hex") : undefined;
}

export class MockLightningProvider implements LightningProvider {
  /** Dev only: a pretend wallet so reconciliation has something to compare. */
  private balanceMsat: number;
  private readonly payments: NodePayment[] = [];
  private readonly settledRefs = new Set<string>();

  constructor(startingBalanceSats = 0) {
    this.balanceMsat = Math.max(0, Math.floor(startingBalanceSats)) * 1000;
  }

  async payInvoice(input: PayInvoiceInput): Promise<PayInvoiceResult> {
    // Dev only: "pays" instantly. No preimage (none exists for a foreign invoice); callers
    // see status succeeded and a zero fee.
    let paymentHash: string | undefined;
    let amountMsat = input.amountMsat;
    try {
      const d = decodeBolt11(input.bolt11);
      paymentHash = d.paymentHash;
      amountMsat = d.amountMsat ?? amountMsat;
    } catch {
      /* foreign/garbage invoice in dev: still "pays" */
    }
    this.balanceMsat -= amountMsat ?? 0;
    if (paymentHash) this.payments.push({ paymentHash, status: "succeeded", valueMsat: amountMsat ?? 0, feeMsat: 0, createdAtMs: Date.now() });
    return { status: "succeeded", feeMsat: 0, amountMsat: input.amountMsat, error: undefined };
  }

  async getBalances(): Promise<NodeBalances> {
    const sats = Math.floor(this.balanceMsat / 1000);
    return { supported: true, onchainConfirmedSats: 0, onchainUnconfirmedSats: 0, channelLocalSats: sats, channelPendingSats: 0, totalSats: sats };
  }

  async listPayments(input: { sinceMs: number; limit?: number }): Promise<NodePaymentList> {
    const limit = input.limit ?? 1000;
    const rows = this.payments.filter((p) => p.createdAtMs >= input.sinceMs);
    return { supported: true, payments: rows.slice(0, limit), truncated: rows.length > limit };
  }

  async createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    const id = randomUUID();
    return {
      invoiceRef: `mockln:${id}:${input.amountSats}`,
      paymentHash: randomUUID().replace(/-/g, ""),
      expiresAtMs: Date.now() + input.expiresInSeconds * 1000
    };
  }

  async checkSettlement(invoiceRef: string): Promise<SettlementResult> {
    const amountSats = Number(/^mockln:[^:]+:(\d+)$/.exec(invoiceRef)?.[1] ?? 0);
    if (!this.settledRefs.has(invoiceRef)) {
      this.settledRefs.add(invoiceRef);
      this.balanceMsat += amountSats * 1000;
    }
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

/**
 * LND serves REST over a self-signed certificate. Pinning it (LND_TLS_CERT_BASE64: the node's
 * tls.cert, base64) makes it the only CA trusted for that connection, so the macaroon is never sent
 * to anything but the node. Without a pin the system CA store applies (e.g. a TLS-terminating proxy).
 */
export function lndDispatcher(certBase64: string | undefined): Dispatcher | undefined {
  const pem = certBase64?.trim() ? Buffer.from(certBase64.trim(), "base64").toString("utf8") : "";
  if (!pem) return undefined;
  if (!pem.includes("BEGIN CERTIFICATE")) throw new Error("lnd_tls_cert_invalid");
  return new Agent({ connect: { ca: pem } });
}

/**
 * Upper bound for the node calls that answer a user (create an invoice, look one up). An LND that
 * is unsynced or stuck can hold these open indefinitely; without a bound the coordinator held the
 * request for minutes and the portal gave up with a 502.
 */
export const LIGHTNING_RPC_TIMEOUT_MS = 15_000;

export class LndRestProvider implements LightningProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly macaroonHex: string,
    private readonly dispatcher?: Dispatcher,
    private readonly rpcTimeoutMs = LIGHTNING_RPC_TIMEOUT_MS
  ) {}

  async createInvoice(input: CreateInvoiceInput): Promise<CreateInvoiceResult> {
    const res = await request(`${this.baseUrl}/v1/invoices`, {
      dispatcher: this.dispatcher,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Grpc-Metadata-macaroon": this.macaroonHex
      },
      body: JSON.stringify({
        value: String(input.amountSats),
        memo: input.memo,
        expiry: String(input.expiresInSeconds)
      }),
      headersTimeout: this.rpcTimeoutMs,
      bodyTimeout: this.rpcTimeoutMs
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

  /**
   * LND SendPaymentV2 (`POST /v2/router/send`). The response is newline-delimited JSON, one
   * `{"result": Payment}` or `{"error": {...}}` per line; with `no_inflight_updates` LND sends
   * only the final update. Only a final SUCCEEDED with a preimage that hashes to the payment hash
   * counts as paid; only a final FAILED with a known failure_reason (or an error line before any
   * payment update) is a final failure. Everything else stays unconfirmed for reconciliation.
   */
  async payInvoice(input: PayInvoiceInput): Promise<PayInvoiceResult> {
    const timeoutSeconds = Math.max(1, Math.floor(input.timeoutSeconds ?? 60));
    const timeoutMs = Math.max(10_000, timeoutSeconds * 1000 + 5_000);
    let res;
    try {
      res = await request(`${this.baseUrl}/v2/router/send`, {
        dispatcher: this.dispatcher,
        method: "POST",
        headers: { "content-type": "application/json", "Grpc-Metadata-macaroon": this.macaroonHex },
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        body: JSON.stringify({
          payment_request: input.bolt11,
          timeout_seconds: timeoutSeconds,
          fee_limit_msat: String(Math.max(0, Math.floor(input.maxFeeSats)) * 1000),
          ...(input.amountMsat !== undefined ? { amt_msat: String(input.amountMsat) } : {}),
          allow_self_payment: false,
          no_inflight_updates: true
        })
      });
    } catch (err) {
      // Transport failure: the payment may be in flight. The caller must reconcile by
      // payment hash before retrying; never assume failed.
      return { status: "failed", error: `lnd_pay_transport:${err instanceof Error ? err.message : String(err)}` };
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const text = await res.body.text().catch(() => "");
      let message = "";
      try {
        const parsed = JSON.parse(text.split("\n")[0] ?? "") as { message?: string; error?: { message?: string } };
        message = parsed.message ?? parsed.error?.message ?? "";
      } catch {
        /* non-JSON error page */
      }
      return { status: "failed", error: `lnd_pay_http_${res.statusCode}:${message}` };
    }
    let last: LndRouterPayment | undefined;
    let sawUpdate = false;
    let buffered = "";
    try {
      for await (const chunk of res.body) {
        buffered += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        let nl;
        while ((nl = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, nl);
          buffered = buffered.slice(nl + 1);
          const outcome = this.routerLine(line, sawUpdate);
          if (outcome === undefined) continue;
          if ("final" in outcome) {
            res.body.destroy();
            return outcome.final;
          }
          sawUpdate = true;
          last = outcome.update;
        }
      }
    } catch (err) {
      // Stream dropped after the 200: the payment may still settle.
      return { status: "failed", error: `lnd_pay_transport:${err instanceof Error ? err.message : String(err)}` };
    }
    const outcome = this.routerLine(buffered, sawUpdate);
    if (outcome && "final" in outcome) return outcome.final;
    if (outcome) last = outcome.update;
    // The stream ended without a final status: unconfirmed, never success or final failure.
    return { status: "failed", paymentHash: lndBytesToHex(last?.payment_hash, 32), error: `lnd_pay_unconfirmed:${last?.status ?? "no_final_status"}` };
  }

  /** One NDJSON line of /v2/router/send: a final result, a non-final update, or undefined (blank/unparsable). */
  private routerLine(line: string, sawUpdate: boolean): { final: PayInvoiceResult } | { update: LndRouterPayment } | undefined {
    if (!line.trim()) return undefined;
    let parsed: { result?: LndRouterPayment; error?: { message?: string } };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      return undefined;
    }
    if (!parsed || typeof parsed !== "object") return undefined;
    if (parsed.error) {
      const message = parsed.error.message ?? "unknown";
      // Before any payment update, LND refused to dispatch the payment (bad invoice, no route at
      // send time, already paid / in flight - the last two payFailureIsFinal keeps unconfirmed).
      // After an update, the HTLC may already be out: unconfirmed.
      return { final: { status: "failed", error: sawUpdate ? `lnd_pay_stream_error:${message}` : `lnd_pay_error:${message}` } };
    }
    const payment = parsed.result;
    if (!payment || typeof payment !== "object") return undefined;
    const paymentHash = lndBytesToHex(payment.payment_hash, 32);
    if (payment.status === "SUCCEEDED") {
      const preimage = lndBytesToHex(payment.payment_preimage, 32);
      if (!preimage || /^0+$/.test(preimage)) return { final: { status: "failed", paymentHash, error: "lnd_pay_no_preimage" } };
      const preimageHash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
      if (!paymentHash || preimageHash !== paymentHash) return { final: { status: "failed", paymentHash, error: "lnd_pay_preimage_mismatch" } };
      const feeMsat = Number(payment.fee_msat ?? 0);
      const valueMsat = payment.value_msat !== undefined ? Number(payment.value_msat) : undefined;
      return {
        final: {
          status: "succeeded",
          paymentHash,
          preimage,
          feeMsat: Number.isFinite(feeMsat) ? feeMsat : 0,
          amountMsat: valueMsat !== undefined && Number.isFinite(valueMsat) ? valueMsat : undefined
        }
      };
    }
    if (payment.status === "FAILED") {
      return { final: { status: "failed", paymentHash, error: `lnd_pay_failed:${payment.failure_reason ?? "unknown"}` } };
    }
    return { update: payment };
  }

  /** GET /v1/balance/blockchain + /v1/balance/channels. Throws on HTTP errors or malformed bodies. */
  async getBalances(): Promise<NodeBalances> {
    const [chain, channels] = await Promise.all([this.getJson("/v1/balance/blockchain"), this.getJson("/v1/balance/channels")]);
    return interpretLndBalances(chain as LndWalletBalance, channels as LndChannelBalance);
  }

  /** GET /v1/getinfo + /v1/channels: sync flags, active/inactive channels and the liquidity in active ones. */
  async getNodeHealth(): Promise<LightningNodeHealth> {
    const [info, channels] = await Promise.all([this.getJson("/v1/getinfo"), this.getJson("/v1/channels")]);
    return interpretLndNodeHealth(info as LndGetInfo, channels as { channels?: LndChannel[] });
  }

  /** GET /v1/payments (incomplete included, so in-flight HTLCs are visible). */
  async listPayments(input: { sinceMs: number; limit?: number }): Promise<NodePaymentList> {
    const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit ?? 1000)));
    const start = Math.max(0, Math.floor(input.sinceMs / 1000));
    const body = (await this.getJson(`/v1/payments?include_incomplete=true&max_payments=${limit}&creation_date_start=${start}`)) as { payments?: LndPayment[] };
    const payments = interpretLndPayments(body);
    return { supported: true, payments, truncated: payments.length >= limit };
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await request(`${this.baseUrl}${path}`, {
      dispatcher: this.dispatcher,
      method: "GET",
      headers: { "Grpc-Metadata-macaroon": this.macaroonHex },
      headersTimeout: 15_000,
      bodyTimeout: 15_000
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      await res.body.dump();
      throw new Error(`lnd_http_${res.statusCode}:${path.split("?")[0]}`);
    }
    return res.body.json();
  }

  async checkSettlement(_invoiceRef: string, paymentHash?: string): Promise<SettlementResult> {
    // #42 review: LND's GET /v1/invoice/{r_hash_str} takes the hex payment hash, not the bolt11.
    const hashHex = lndHashToHex(paymentHash);
    if (!hashHex) return { settled: false };
    const res = await request(`${this.baseUrl}/v1/invoice/${hashHex}`, {
      dispatcher: this.dispatcher,
      method: "GET",
      headers: {
        "Grpc-Metadata-macaroon": this.macaroonHex
      },
      headersTimeout: this.rpcTimeoutMs,
      bodyTimeout: this.rpcTimeoutMs
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

/* ------------------------------------------------------------------ */
/*  Reconciliation reads (balances, outgoing payments)                  */
/* ------------------------------------------------------------------ */

/** Non-negative integer from an int64-as-string / number field; anything else is malformed. */
function satsField(value: unknown, what: string): number {
  const v = typeof value === "number" ? String(value) : value;
  if (typeof v !== "string" || !/^\d+$/.test(v.trim())) throw new Error(`balance_malformed:${what}`);
  const n = Number(v.trim());
  if (!Number.isSafeInteger(n)) throw new Error(`balance_malformed:${what}`);
  return n;
}

/**
 * LND's creation_time_ns as whole ms. A real timestamp in nanoseconds (~1.8e18) is far above
 * Number.MAX_SAFE_INTEGER, so it is parsed as a BigInt; only the ms value has to be a safe integer.
 */
function nsToMs(value: unknown): number {
  const v = typeof value === "number" ? String(value) : value;
  if (typeof v !== "string" || !/^\d+$/.test(v.trim())) throw new Error("balance_malformed:creation_time_ns");
  const ms = Number(BigInt(v.trim()) / 1_000_000n);
  if (!Number.isSafeInteger(ms)) throw new Error("balance_malformed:creation_time_ns");
  return ms;
}

function optionalSats(value: unknown, what: string): number {
  return value === undefined || value === null ? 0 : satsField(value, what);
}

/** Subsets of LND's WalletBalanceResponse / ChannelBalanceResponse REST JSON. */
export interface LndWalletBalance {
  confirmed_balance?: string;
  unconfirmed_balance?: string;
}
export interface LndChannelBalance {
  local_balance?: { sat?: string };
  pending_open_local_balance?: { sat?: string };
  unsettled_local_balance?: { sat?: string };
}

/** Fails closed: the fields every LND >= 0.13 returns must be present and numeric. */
export function interpretLndBalances(chain: LndWalletBalance, channels: LndChannelBalance): NodeBalances {
  const onchainConfirmedSats = satsField(chain?.confirmed_balance, "confirmed_balance");
  const onchainUnconfirmedSats = optionalSats(chain?.unconfirmed_balance, "unconfirmed_balance");
  const channelLocalSats = satsField(channels?.local_balance?.sat, "local_balance");
  const channelPendingSats =
    optionalSats(channels?.pending_open_local_balance?.sat, "pending_open_local_balance") + optionalSats(channels?.unsettled_local_balance?.sat, "unsettled_local_balance");
  return {
    supported: true,
    onchainConfirmedSats,
    onchainUnconfirmedSats,
    channelLocalSats,
    channelPendingSats,
    totalSats: onchainConfirmedSats + onchainUnconfirmedSats + channelLocalSats + channelPendingSats
  };
}

/** Subsets of LND's GetInfoResponse and ListChannelsResponse REST JSON. */
export interface LndGetInfo {
  synced_to_chain?: boolean;
  synced_to_graph?: boolean;
  block_height?: number;
  num_active_channels?: number;
  num_inactive_channels?: number;
  num_pending_channels?: number;
}
export interface LndChannel {
  active?: boolean;
  remote_pubkey?: string;
  chan_id?: string;
  local_balance?: string;
  remote_balance?: string;
}

/** Fails closed on a getinfo without the sync flags (an LND that is not answering properly). */
export function interpretLndNodeHealth(info: LndGetInfo, body: { channels?: LndChannel[] }): LightningNodeHealth {
  if (typeof info?.synced_to_chain !== "boolean") throw new Error("getinfo_malformed:synced_to_chain");
  const channels = Array.isArray(body?.channels) ? body.channels : [];
  let localSats = 0;
  let remoteSats = 0;
  const inactive: LightningNodeHealth["inactive"] = [];
  for (const c of channels) {
    const local = optionalSats(c.local_balance, "local_balance");
    if (c.active) {
      localSats += local;
      remoteSats += optionalSats(c.remote_balance, "remote_balance");
    } else if (inactive.length < 20) {
      inactive.push({ chanId: String(c.chan_id ?? ""), remotePubkey: String(c.remote_pubkey ?? ""), localSats: local });
    }
  }
  const active = channels.filter((c) => c.active).length;
  return {
    supported: true,
    syncedToChain: info.synced_to_chain,
    syncedToGraph: info.synced_to_graph === true,
    blockHeight: typeof info.block_height === "number" ? info.block_height : null,
    activeChannels: channels.length ? active : Number(info.num_active_channels ?? 0),
    inactiveChannels: channels.length ? channels.length - active : Number(info.num_inactive_channels ?? 0),
    pendingChannels: Number(info.num_pending_channels ?? 0),
    localSats,
    remoteSats,
    inactive
  };
}

/** Subset of LND's `lnrpc.Payment` REST JSON. */
export interface LndPayment {
  payment_hash?: string;
  value_msat?: string;
  fee_msat?: string;
  status?: string;
  creation_time_ns?: string;
  creation_date?: string;
  payment_preimage?: string;
}

function paymentHashField(value: unknown): string {
  const hex = typeof value === "string" ? lndHashToHex(value) : undefined;
  if (!hex) throw new Error("payments_malformed:payment_hash");
  return hex;
}

export function interpretLndPayments(body: { payments?: LndPayment[] }): NodePayment[] {
  if (!body || !Array.isArray(body.payments)) throw new Error("payments_malformed:payments");
  return body.payments.map((p) => {
    const status = p.status === "SUCCEEDED" ? "succeeded" : p.status === "FAILED" ? "failed" : "in_flight"; // IN_FLIGHT, INITIATED, UNKNOWN: money may still move
    const createdAtMs = p.creation_time_ns !== undefined ? nsToMs(p.creation_time_ns) : optionalSats(p.creation_date, "creation_date") * 1000;
    const preimage = status === "succeeded" ? lndBytesToHex(p.payment_preimage, 32) : undefined;
    return { paymentHash: paymentHashField(p.payment_hash), status, valueMsat: satsField(p.value_msat, "value_msat"), feeMsat: optionalSats(p.fee_msat, "fee_msat"), createdAtMs, ...(preimage && !/^0+$/.test(preimage) ? { preimage } : {}) };
  });
}

/** c-lightning-REST /v1/getBalance and /v1/channel/localremotebal (sats). */
export interface ClnWalletBalance {
  confBalance?: number | string;
  unconfBalance?: number | string;
}
export interface ClnChannelBalance {
  localBalance?: number | string;
  pendingBalance?: number | string;
}

export function interpretClnBalances(wallet: ClnWalletBalance, channels: ClnChannelBalance): NodeBalances {
  const onchainConfirmedSats = satsField(wallet?.confBalance, "confBalance");
  const onchainUnconfirmedSats = optionalSats(wallet?.unconfBalance, "unconfBalance");
  const channelLocalSats = satsField(channels?.localBalance, "localBalance");
  const channelPendingSats = optionalSats(channels?.pendingBalance, "pendingBalance");
  return {
    supported: true,
    onchainConfirmedSats,
    onchainUnconfirmedSats,
    channelLocalSats,
    channelPendingSats,
    totalSats: onchainConfirmedSats + onchainUnconfirmedSats + channelLocalSats + channelPendingSats
  };
}

/** Core Lightning `listpays` entry via c-lightning-REST /v1/pay/listPays. */
export interface ClnPay {
  payment_hash?: string;
  status?: "complete" | "failed" | "pending" | string;
  amount_msat?: string | number;
  amount_sent_msat?: string | number;
  created_at?: number | string;
}

export function interpretClnPays(body: { pays?: ClnPay[] }, sinceMs: number): NodePayment[] {
  if (!body || !Array.isArray(body.pays)) throw new Error("payments_malformed:pays");
  const out: NodePayment[] = [];
  for (const p of body.pays) {
    const hash = typeof p.payment_hash === "string" && /^[0-9a-fA-F]{64}$/.test(p.payment_hash) ? p.payment_hash.toLowerCase() : undefined;
    if (!hash) throw new Error("payments_malformed:payment_hash");
    const createdAtMs = optionalSats(p.created_at, "created_at") * 1000;
    if (createdAtMs < sinceMs) continue;
    const status = p.status === "complete" ? "succeeded" : p.status === "failed" ? "failed" : "in_flight";
    const value = clnMsat(p.amount_msat);
    const sent = clnMsat(p.amount_sent_msat);
    // A failed pay may carry no amounts; a complete or pending one must.
    if (status !== "failed" && (value === undefined || sent === undefined)) throw new Error("payments_malformed:amount");
    const valueMsat = Number(value ?? 0n);
    out.push({ paymentHash: hash, status, valueMsat, feeMsat: Math.max(0, Number(sent ?? 0n) - valueMsat), createdAtMs });
  }
  return out;
}

export class ClnRestProvider implements LightningProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    private readonly rpcTimeoutMs = LIGHTNING_RPC_TIMEOUT_MS
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
      }),
      headersTimeout: this.rpcTimeoutMs,
      bodyTimeout: this.rpcTimeoutMs
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

  /** Core Lightning `pay` via c-lightning-REST. */
  async payInvoice(input: PayInvoiceInput): Promise<PayInvoiceResult> {
    const timeoutMs = Math.max(10_000, (input.timeoutSeconds ?? 60) * 1000 + 5_000);
    let res;
    try {
      res = await request(`${this.baseUrl}/v1/pay`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiToken}` },
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
        body: JSON.stringify({
          invoice: input.bolt11,
          ...(input.amountMsat !== undefined ? { amount_msat: input.amountMsat } : {}),
          // CLN caps fees by percent + an absolute exemption; express the absolute cap as both.
          maxfee: `${Math.max(0, Math.floor(input.maxFeeSats)) * 1000}msat`,
          retry_for: input.timeoutSeconds ?? 60
        })
      });
    } catch (err) {
      return { status: "failed", error: `cln_pay_transport:${err instanceof Error ? err.message : String(err)}` };
    }
    const body = (await res.body.json().catch(() => ({}))) as {
      status?: string;
      payment_hash?: string;
      payment_preimage?: string;
      amount_msat?: string | number;
      amount_sent_msat?: string | number;
      message?: string;
      error?: string;
    };
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return { status: "failed", error: `cln_pay_http_${res.statusCode}:${body.message ?? body.error ?? ""}` };
    }
    if (body.status !== "complete" || !body.payment_preimage) return { status: "failed", error: `cln_pay_status:${body.status ?? "unknown"}` };
    const msat = (v: string | number | undefined) => (v === undefined ? undefined : Number(String(v).replace(/msat$/i, "")));
    const amount = msat(body.amount_msat);
    const sent = msat(body.amount_sent_msat);
    return {
      status: "succeeded",
      paymentHash: body.payment_hash?.toLowerCase(),
      preimage: body.payment_preimage.toLowerCase(),
      amountMsat: amount,
      feeMsat: amount !== undefined && sent !== undefined ? Math.max(0, sent - amount) : undefined
    };
  }

  async getBalances(): Promise<NodeBalances> {
    const [wallet, channels] = await Promise.all([this.getJson("/v1/getBalance"), this.getJson("/v1/channel/localremotebal")]);
    return interpretClnBalances(wallet as ClnWalletBalance, channels as ClnChannelBalance);
  }

  /** listpays has no server-side date filter; rows older than `sinceMs` are dropped here. */
  async listPayments(input: { sinceMs: number; limit?: number }): Promise<NodePaymentList> {
    const limit = Math.max(1, Math.floor(input.limit ?? 1000));
    const payments = interpretClnPays((await this.getJson("/v1/pay/listPays")) as { pays?: ClnPay[] }, input.sinceMs);
    return { supported: true, payments: payments.slice(-limit), truncated: payments.length > limit };
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await request(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.apiToken}` },
      headersTimeout: 15_000,
      bodyTimeout: 15_000
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      await res.body.dump();
      throw new Error(`cln_http_${res.statusCode}:${path}`);
    }
    return res.body.json();
  }

  async checkSettlement(invoiceRef: string, paymentHash?: string): Promise<SettlementResult> {
    // Look the invoice up by payment hash when we have it (exact match), else by bolt11.
    const hashHex = typeof paymentHash === "string" && /^[0-9a-fA-F]{64}$/.test(paymentHash) ? paymentHash.toLowerCase() : undefined;
    const query = hashHex ? `payment_hash=${hashHex}` : `invstring=${encodeURIComponent(invoiceRef)}`;
    const res = await request(`${this.baseUrl}/v1/invoice/listInvoices?${query}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.apiToken}`
      },
      headersTimeout: this.rpcTimeoutMs,
      bodyTimeout: this.rpcTimeoutMs
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      await res.body.dump();
      return { settled: false };
    }
    const body = (await res.body.json()) as { invoices?: ClnInvoice[] };
    return interpretClnInvoices(body.invoices ?? [], { hashHex, bolt11: invoiceRef });
  }
}

/** Subset of Core Lightning's `listinvoices` entry (via c-lightning-REST). Amounts arrive as "Nmsat" strings or numbers. */
export interface ClnInvoice {
  status?: "unpaid" | "paid" | "expired" | string;
  bolt11?: string;
  payment_hash?: string;
  payment_preimage?: string;
  amount_msat?: string | number;
  amount_received_msat?: string | number;
}

function clnMsat(value: string | number | undefined): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  const digits = String(value).trim().replace(/msat$/i, "");
  return /^\d+$/.test(digits) ? BigInt(digits) : undefined;
}

/**
 * Decide settlement from a Core Lightning listinvoices response. Same fail-closed rules as
 * the LND path: only status "paid" counts; the entry must be the invoice we asked about
 * (payment hash, or bolt11 when no hash is stored); the preimage must hash to the payment
 * hash; the invoice amount must be > 0 and fully received.
 */
export function interpretClnInvoices(
  invoices: ClnInvoice[],
  expected: { hashHex?: string; bolt11?: string }
): SettlementResult {
  const match = invoices.find((i) => {
    const h = i.payment_hash?.toLowerCase();
    if (expected.hashHex) return h === expected.hashHex;
    return Boolean(expected.bolt11) && i.bolt11 === expected.bolt11;
  });
  if (!match || match.status !== "paid") return { settled: false };
  const hashHex = match.payment_hash?.toLowerCase();
  if (!hashHex || !/^[0-9a-f]{64}$/.test(hashHex)) return { settled: false };
  const preimage = match.payment_preimage?.toLowerCase();
  if (!preimage || !/^[0-9a-f]{64}$/.test(preimage)) return { settled: false };
  if (createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex") !== hashHex) return { settled: false };
  const amount = clnMsat(match.amount_msat);
  const received = clnMsat(match.amount_received_msat);
  if (amount === undefined || received === undefined || amount <= 0n || received < amount) return { settled: false };
  return { settled: true, txRef: `cln:${hashHex}`, paymentHash: hashHex, preimage };
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
    return new LndRestProvider(baseUrl, macaroonHex, lndDispatcher(process.env.LND_TLS_CERT_BASE64));
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
  logger.warn("using MockLightningProvider — all invoices auto-settle");
  return new MockLightningProvider(Number(process.env.MOCK_LIGHTNING_BALANCE_SATS ?? 0) || 0);
}
