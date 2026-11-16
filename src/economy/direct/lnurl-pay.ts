// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * LNURL-pay resolution for direct payments (LUD-06 / LUD-16): a payee's Lightning address to a
 * BOLT11 invoice for an exact amount, checked before anyone pays it.
 *
 * Checks: the endpoint is a payRequest; amount within min/maxSendable; the invoice is for exactly
 * that amount, on the expected network, unexpired, and commits to the metadata
 * (description_hash = sha256(metadata)). The coordinator only resolves invoices; the buyer's
 * wallet pays the payee's node, so EdgeCoder never holds the sats.
 *
 * `devHttp` allows http://127.0.0.1 / localhost endpoints (the signet test harness);
 * `allowUncommittedDescription` skips the description-hash check for a test payee whose invoices
 * come from a wallet that cannot commit to metadata (the Mutinynet faucet). Both are for test
 * harnesses only and are refused on mainnet.
 */

import { createHash } from "node:crypto";
import { bolt11IsExpired, decodeBolt11, type DecodedBolt11 } from "../bolt11.js";
import { lnurlPayEndpoint } from "../payouts.js";

export type BitcoinNet = DecodedBolt11["network"];
export type JsonFetcher = (url: string) => Promise<unknown>;

export interface ResolveOptions {
  network: BitcoinNet;
  fetcher?: JsonFetcher;
  devHttp?: boolean;
  allowUncommittedDescription?: boolean;
  /** Payee comment (LUD-12), when the endpoint allows one. */
  comment?: string;
  nowMs?: number;
}

export interface ResolvedInvoice {
  bolt11: string;
  decoded: DecodedBolt11;
  callbackOrigin: string;
}

const LOCAL_HTTP = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i;

export const defaultJsonFetcher: JsonFetcher = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`lnurl_http_${res.status}`);
  return res.json();
};

function endpointFor(destination: string, devHttp: boolean): string {
  const d = destination.trim();
  if (devHttp && LOCAL_HTTP.test(d)) return d;
  return lnurlPayEndpoint(d);
}

function allowedUrl(url: string, devHttp: boolean): boolean {
  return /^https:\/\//i.test(url) || (devHttp && LOCAL_HTTP.test(url));
}

export async function resolveLnurlPayInvoice(destination: string, amountMsat: number, opts: ResolveOptions): Promise<ResolvedInvoice> {
  if (!Number.isInteger(amountMsat) || amountMsat <= 0) throw new Error("lnurl_bad_amount");
  const testOnly = opts.devHttp || opts.allowUncommittedDescription;
  if (testOnly && opts.network === "bitcoin") throw new Error("lnurl_test_options_on_mainnet");
  const devHttp = !!opts.devHttp;
  const fetcher = opts.fetcher ?? defaultJsonFetcher;
  const meta = (await fetcher(endpointFor(destination, devHttp))) as { tag?: string; callback?: string; minSendable?: number; maxSendable?: number; metadata?: unknown; commentAllowed?: number; status?: string; reason?: string };
  if (meta?.status === "ERROR") throw new Error(`lnurl_error:${meta.reason ?? "unknown"}`);
  if (meta?.tag !== "payRequest" || typeof meta.callback !== "string" || !allowedUrl(meta.callback, devHttp)) throw new Error("lnurl_not_pay_request");
  if (typeof meta.minSendable === "number" && amountMsat < meta.minSendable) throw new Error(`lnurl_below_min:${meta.minSendable}`);
  if (typeof meta.maxSendable === "number" && amountMsat > meta.maxSendable) throw new Error(`lnurl_above_max:${meta.maxSendable}`);
  if (typeof meta.metadata !== "string" || meta.metadata.length === 0) throw new Error("lnurl_missing_metadata");
  const cb = new URL(meta.callback);
  cb.searchParams.set("amount", String(amountMsat));
  if (opts.comment && typeof meta.commentAllowed === "number" && meta.commentAllowed > 0) cb.searchParams.set("comment", opts.comment.slice(0, meta.commentAllowed));
  const inv = (await fetcher(cb.toString())) as { pr?: string; status?: string; reason?: string };
  if (inv?.status === "ERROR" || typeof inv?.pr !== "string") throw new Error(`lnurl_invoice_error:${inv?.reason ?? "no pr"}`);
  const decoded = decodeBolt11(inv.pr);
  if (decoded.network !== opts.network) throw new Error(`lnurl_wrong_network:${decoded.network}`);
  if (decoded.amountMsat !== amountMsat) throw new Error(`lnurl_amount_mismatch:${decoded.amountMsat}`);
  if (bolt11IsExpired(decoded, opts.nowMs ?? Date.now(), 30)) throw new Error("lnurl_invoice_expired");
  const metadataHash = createHash("sha256").update(meta.metadata, "utf8").digest("hex");
  if (decoded.descriptionHash !== metadataHash && !opts.allowUncommittedDescription) throw new Error("lnurl_description_hash_mismatch");
  return { bolt11: inv.pr, decoded, callbackOrigin: cb.origin.toLowerCase() };
}

/** sha256(preimage) = payment hash: the payee's node released the preimage, so it was paid. */
export function preimageProves(paymentHashHex: string, preimageHex: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(preimageHex) || !/^[0-9a-f]{64}$/i.test(paymentHashHex)) return false;
  return createHash("sha256").update(Buffer.from(preimageHex, "hex")).digest("hex") === paymentHashHex.toLowerCase();
}
