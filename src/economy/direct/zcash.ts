// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Zcash (shielded) direct payments for reservations, blocks of time and server commitments.
 *
 * - Quote: the price in cSats (= sats) converted to zatoshi at quote time, with an expiry.
 * - The buyer pays the host's shielded address with the memo `edgecoder:r:<reservation id>` and
 *   the 5 % fee to EdgeCoder's address with `edgecoder:f:<reservation id>`.
 * - The host registers an incoming viewing key (read-only: shows incoming notes and memos, cannot
 *   spend). The coordinator imports it into a zcashd-compatible testnet wallet and reads notes with
 *   `z_listreceivedbyaddress` (JSON-RPC; lightwalletd's gRPC would need a new dependency).
 *
 * Nothing here holds keys that can spend.
 */

import { request } from "undici";

export type ZcashNet = "main" | "test";

export const MEMO_PREFIX = "edgecoder";

export function reservationMemo(kind: "host" | "fee", reservationId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(reservationId)) throw new Error("zcash_bad_reservation_id");
  return `${MEMO_PREFIX}:${kind === "host" ? "r" : "f"}:${reservationId}`;
}

/** A 512-byte memo field (hex) to text: UTF-8 when the first byte is ≤ 0xF4, zero padding trimmed. */
export function decodeMemoHex(hex: string | undefined): string | null {
  if (!hex || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length === 0 || bytes[0] > 0xf4) return null;
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const text = bytes.subarray(0, end).toString("utf8");
  return text.includes("�") ? null : text;
}

export function encodeMemoHex(text: string): string {
  const b = Buffer.from(text, "utf8");
  if (b.length > 512) throw new Error("zcash_memo_too_long");
  return Buffer.concat([b, Buffer.alloc(512 - b.length)]).toString("hex");
}

const ADDRESS_PREFIX: Record<ZcashNet, RegExp> = { main: /^(zs1|u1)[02-9ac-hj-np-z]{40,}$/, test: /^(ztestsapling1|utest1)[02-9ac-hj-np-z]{40,}$/ };
const IVK_PREFIX: Record<ZcashNet, RegExp> = { main: /^(zivks1|uivk1)[02-9ac-hj-np-z]{40,}$/, test: /^(zivktestsapling1|uivktest1)[02-9ac-hj-np-z]{40,}$/ };

/** Shape check only (prefix and bech32 charset); the node validates fully on import. */
export function validShieldedAddress(addr: string, net: ZcashNet): boolean {
  return ADDRESS_PREFIX[net].test(addr.trim());
}
export function validIncomingViewingKey(ivk: string, net: ZcashNet): boolean {
  return IVK_PREFIX[net].test(ivk.trim());
}

export interface ZecQuote {
  reservationId: string;
  priceSats: number;
  feeSats: number;
  zatoshi: number;
  feeZatoshi: number;
  /** BTC/ZEC used: zatoshi per sat. */
  zatPerSat: number;
  quotedAtMs: number;
  expiresAtMs: number;
  hostAddress: string;
  feeAddress: string;
  hostMemo: string;
  feeMemo: string;
}

/** zatoshi = sats × (BTC/USD ÷ ZEC/USD), rounded up so the host is never short. */
export function quoteZec(input: {
  reservationId: string; priceSats: number; feeSats: number; btcUsd: number; zecUsd: number; nowMs: number; ttlMs?: number; hostAddress: string; feeAddress: string;
}): ZecQuote {
  if (!(input.btcUsd > 0 && input.zecUsd > 0)) throw new Error("zcash_no_rate");
  const zatPerSat = input.btcUsd / input.zecUsd;
  return {
    reservationId: input.reservationId, priceSats: input.priceSats, feeSats: input.feeSats,
    zatoshi: Math.ceil(input.priceSats * zatPerSat), feeZatoshi: Math.ceil(input.feeSats * zatPerSat), zatPerSat,
    quotedAtMs: input.nowMs, expiresAtMs: input.nowMs + (input.ttlMs ?? 30 * 60_000),
    hostAddress: input.hostAddress, feeAddress: input.feeAddress,
    hostMemo: reservationMemo("host", input.reservationId), feeMemo: reservationMemo("fee", input.reservationId),
  };
}

/** A z_listreceivedbyaddress row (zcashd 5.x). */
export interface ReceivedNote {
  txid: string;
  amountZat: number;
  memo?: string;
  outindex?: number;
  confirmations: number;
  blockheight?: number;
  blocktime?: number;
  change?: boolean;
  pool?: string;
}

export type ZcashCheck =
  | { status: "paid"; zatoshi: number; confirmations: number; notes: Array<{ txid: string; outindex?: number }> }
  | { status: "unconfirmed" | "underpaid" | "late"; zatoshi: number; confirmations: number; notes: Array<{ txid: string; outindex?: number }> }
  | { status: "not_found" };

/**
 * Sum the notes carrying `memo` (change and already-used notes excluded). Paid when the sum covers
 * `minZatoshi`, the least-confirmed note has `minConfirmations`, and each note was mined before the
 * quote expired (a note without a block time counts as on time only while unconfirmed).
 */
export function matchMemoPayment(notes: ReceivedNote[], input: { memo: string; minZatoshi: number; minConfirmations: number; expiresAtMs: number; used?: ReadonlySet<string> }): ZcashCheck {
  const hits = notes.filter((n) => !n.change && decodeMemoHex(n.memo) === input.memo && !input.used?.has(`${n.txid}:${n.outindex ?? 0}`));
  if (hits.length === 0) return { status: "not_found" };
  const zatoshi = hits.reduce((s, n) => s + n.amountZat, 0);
  const confirmations = Math.min(...hits.map((n) => n.confirmations));
  const refs = hits.map((n) => ({ txid: n.txid, ...(n.outindex !== undefined ? { outindex: n.outindex } : {}) }));
  if (hits.some((n) => n.blocktime !== undefined && n.blocktime * 1000 > input.expiresAtMs)) return { status: "late", zatoshi, confirmations, notes: refs };
  if (zatoshi < input.minZatoshi) return { status: "underpaid", zatoshi, confirmations, notes: refs };
  if (confirmations < input.minConfirmations) return { status: "unconfirmed", zatoshi, confirmations, notes: refs };
  return { status: "paid", zatoshi, confirmations, notes: refs };
}

export interface ZcashRpc {
  call<T>(method: string, params: unknown[]): Promise<T>;
}

/** zcashd JSON-RPC over HTTP (basic auth). Credentials never appear in errors or logs. */
export class ZcashdRpc implements ZcashRpc {
  private seq = 0;
  constructor(private readonly url: string, private readonly auth?: { user: string; password: string }, private readonly timeoutMs = 20_000) {}
  async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await request(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.auth ? { authorization: `Basic ${Buffer.from(`${this.auth.user}:${this.auth.password}`).toString("base64")}` } : {}) },
      body: JSON.stringify({ jsonrpc: "1.0", id: ++this.seq, method, params }),
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs,
    });
    const body = (await res.body.json().catch(() => null)) as { result?: T; error?: { code: number; message: string } | null } | null;
    if (!body) throw new Error(`zcashd_http_${res.statusCode}`);
    if (body.error) throw new Error(`zcashd_rpc_${body.error.code}:${body.error.message}`);
    return body.result as T;
  }
}

/** Read-only verifier: import the host's viewing key once, then look for the memo's notes. */
export class ZcashViewingKeyVerifier {
  private readonly imported = new Set<string>();
  constructor(private readonly rpc: ZcashRpc, private readonly net: ZcashNet = "test") {}

  async ensureViewingKey(ivk: string, startHeight?: number): Promise<void> {
    if (this.imported.has(ivk)) return;
    if (!validIncomingViewingKey(ivk, this.net)) throw new Error("zcash_bad_viewing_key");
    // "whenkeyisnew": rescan from startHeight the first time this key is seen.
    await this.rpc.call("z_importviewingkey", [ivk, "whenkeyisnew", startHeight ?? 0]);
    this.imported.add(ivk);
  }

  async check(input: { address: string; viewingKey: string; memo: string; minZatoshi: number; minConfirmations: number; expiresAtMs: number; startHeight?: number; used?: ReadonlySet<string> }): Promise<ZcashCheck> {
    if (!validShieldedAddress(input.address, this.net)) throw new Error("zcash_bad_address");
    await this.ensureViewingKey(input.viewingKey, input.startHeight);
    const notes = await this.rpc.call<ReceivedNote[]>("z_listreceivedbyaddress", [input.address, 0]);
    return matchMemoPayment(notes, input);
  }
}
