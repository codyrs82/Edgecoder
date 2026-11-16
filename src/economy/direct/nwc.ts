// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Nostr Wallet Connect (NIP-47) client: ask a buyer's own wallet to pay an invoice.
 *
 * The connection string `nostr+walletconnect://<wallet pubkey>?relay=<wss url>&secret=<hex>` holds
 * a spending secret for that wallet (bounded by the budget the buyer set in the wallet). It is
 * stored encrypted (secret-box.ts) and never logged: `describeNwcConnection` is the only view of it
 * that may appear in logs or API answers.
 *
 * Requests are kind 23194 events signed with the connection secret, content encrypted to the
 * wallet (NIP-44 v2 when the wallet advertises it in its kind 13194 info event, else NIP-04);
 * replies are kind 23195 events from the wallet with an `e` tag of the request id.
 */

import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { defaultWsConnect, nostrEventId, verifyNostrEvent, type NostrEvent, type WsConnect, type WsLike } from "../../discovery/nostr.js";
import { nip04Decrypt, nip04Encrypt } from "./nip04.js";
import { nip44ConversationKey, nip44Decrypt, nip44Encrypt } from "./nip44.js";

export const NWC_INFO_KIND = 13194;
export const NWC_REQUEST_KIND = 23194;
export const NWC_RESPONSE_KIND = 23195;

export type NwcEncryption = "nip44_v2" | "nip04";

export interface NwcConnection {
  walletPubkey: string;
  relays: string[];
  secret: Uint8Array;
  clientPubkey: string;
  lud16?: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function parseNwcUri(uri: string): NwcConnection {
  const trimmed = uri.trim();
  const m = /^nostr\+walletconnect:\/\/([0-9a-fA-F]{64})\?(.*)$/.exec(trimmed);
  if (!m) throw new Error("nwc_invalid_uri");
  const params = new URLSearchParams(m[2]);
  const relays = params.getAll("relay").map((r) => r.trim()).filter((r) => /^wss?:\/\//i.test(r));
  const secretHex = (params.get("secret") ?? "").trim().toLowerCase();
  if (relays.length === 0) throw new Error("nwc_missing_relay");
  if (!HEX64.test(secretHex)) throw new Error("nwc_invalid_secret");
  const secret = new Uint8Array(Buffer.from(secretHex, "hex"));
  const lud16 = params.get("lud16") ?? undefined;
  return { walletPubkey: m[1].toLowerCase(), relays, secret, clientPubkey: Buffer.from(schnorr.getPublicKey(secret)).toString("hex"), ...(lud16 ? { lud16 } : {}) };
}

/** What may be shown or logged about a connection: never the secret. */
export function describeNwcConnection(c: NwcConnection): { walletPubkey: string; clientPubkey: string; relays: string[]; lud16?: string } {
  return { walletPubkey: c.walletPubkey, clientPubkey: c.clientPubkey, relays: [...c.relays], ...(c.lud16 ? { lud16: c.lud16 } : {}) };
}

export function signEvent(unsigned: Omit<NostrEvent, "id" | "sig">, secret: Uint8Array, auxRand: Uint8Array = randomBytes(32)): NostrEvent {
  const id = nostrEventId(unsigned);
  const sig = Buffer.from(schnorr.sign(Buffer.from(id, "hex"), secret, auxRand)).toString("hex");
  return { id, ...unsigned, sig };
}

export function nwcEncrypt(plaintext: string, secret: Uint8Array, peerPubkey: string, encryption: NwcEncryption): string {
  return encryption === "nip44_v2" ? nip44Encrypt(plaintext, nip44ConversationKey(secret, peerPubkey)) : nip04Encrypt(plaintext, secret, peerPubkey);
}

export function nwcDecrypt(content: string, secret: Uint8Array, peerPubkey: string): string {
  // NIP-04 content carries "?iv="; anything else is a NIP-44 payload.
  return content.includes("?iv=") ? nip04Decrypt(content, secret, peerPubkey) : nip44Decrypt(content, nip44ConversationKey(secret, peerPubkey));
}

export interface NwcRequestBody {
  method: string;
  params: Record<string, unknown>;
}

/** A signed, encrypted kind 23194 request to the wallet. */
export function buildNwcRequest(
  conn: NwcConnection,
  body: NwcRequestBody,
  opts: { encryption?: NwcEncryption; createdAtSec?: number; expirationSec?: number } = {}
): NostrEvent {
  const encryption = opts.encryption ?? "nip44_v2";
  const createdAt = opts.createdAtSec ?? Math.floor(Date.now() / 1000);
  const tags: string[][] = [["p", conn.walletPubkey]];
  if (encryption === "nip44_v2") tags.push(["encryption", "nip44_v2"]);
  if (opts.expirationSec) tags.push(["expiration", String(opts.expirationSec)]);
  return signEvent(
    { pubkey: conn.clientPubkey, created_at: createdAt, kind: NWC_REQUEST_KIND, tags, content: nwcEncrypt(JSON.stringify(body), conn.secret, conn.walletPubkey, encryption) },
    conn.secret
  );
}

export interface NwcResponse {
  result_type: string;
  error?: { code: string; message?: string } | null;
  result?: Record<string, unknown> | null;
}

/** Check and decrypt a kind 23195 reply to `requestId`. Throws on anything not from the wallet. */
export function parseNwcResponse(event: unknown, conn: NwcConnection, requestId: string): NwcResponse {
  if (!verifyNostrEvent(event)) throw new Error("nwc_bad_event");
  if (event.kind !== NWC_RESPONSE_KIND || event.pubkey !== conn.walletPubkey) throw new Error("nwc_not_from_wallet");
  if (!event.tags.some((t) => t[0] === "e" && t[1] === requestId)) throw new Error("nwc_wrong_request");
  const body = JSON.parse(nwcDecrypt(event.content, conn.secret, conn.walletPubkey)) as NwcResponse;
  if (typeof body?.result_type !== "string") throw new Error("nwc_bad_response");
  return body;
}

/** Encryption schemes a wallet's kind 13194 info event advertises (none listed = NIP-04 only). */
export function infoEncryptions(info: NostrEvent | null | undefined): NwcEncryption[] {
  const tag = info?.tags.find((t) => t[0] === "encryption")?.[1];
  if (!tag) return ["nip04"];
  return tag.split(/\s+/).filter((s): s is NwcEncryption => s === "nip44_v2" || s === "nip04");
}

export class NwcError extends Error {
  constructor(readonly code: string, message?: string) {
    super(`${code}${message ? `: ${message}` : ""}`);
  }
}

export interface PayInvoiceOk {
  preimage: string;
  feesPaidMsat?: number;
}

/**
 * One relay connection per request: subscribe for the reply, publish the request, wait.
 * Errors from the wallet come back as NwcError(code), e.g. QUOTA_EXCEEDED, INSUFFICIENT_BALANCE,
 * PAYMENT_FAILED; a missing reply is NwcError("TIMEOUT").
 */
export class NwcClient {
  private encryption: NwcEncryption | undefined;
  constructor(
    private readonly conn: NwcConnection,
    private readonly opts: { connect?: WsConnect; timeoutMs?: number; encryption?: NwcEncryption } = {}
  ) {
    this.encryption = opts.encryption;
  }

  get walletPubkey(): string {
    return this.conn.walletPubkey;
  }

  /** Pick NIP-44 when the wallet's info event offers it. */
  async negotiate(): Promise<NwcEncryption> {
    if (this.encryption) return this.encryption;
    const info = await this.fetchInfo().catch(() => null);
    this.encryption = infoEncryptions(info).includes("nip44_v2") ? "nip44_v2" : "nip04";
    return this.encryption;
  }

  async fetchInfo(): Promise<NostrEvent | null> {
    const events = await this.roundTrip({ kinds: [NWC_INFO_KIND], authors: [this.conn.walletPubkey], limit: 1 }, null, (e) => e.kind === NWC_INFO_KIND && e.pubkey === this.conn.walletPubkey, true);
    return events;
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = this.opts.timeoutMs ?? 60_000): Promise<Record<string, unknown>> {
    const encryption = await this.negotiate();
    const event = buildNwcRequest(this.conn, { method, params }, { encryption, expirationSec: Math.floor((Date.now() + timeoutMs) / 1000) });
    const reply = await this.roundTrip(
      { kinds: [NWC_RESPONSE_KIND], authors: [this.conn.walletPubkey], "#e": [event.id] },
      event,
      (e) => e.kind === NWC_RESPONSE_KIND && e.tags.some((t) => t[0] === "e" && t[1] === event.id),
      false,
      timeoutMs
    );
    if (!reply) throw new NwcError("TIMEOUT", `no reply to ${method}`);
    const body = parseNwcResponse(reply, this.conn, event.id);
    if (body.error) throw new NwcError(body.error.code || "OTHER", body.error.message);
    return body.result ?? {};
  }

  async payInvoice(invoice: string, timeoutMs?: number): Promise<PayInvoiceOk> {
    const r = await this.request("pay_invoice", { invoice }, timeoutMs);
    const preimage = typeof r.preimage === "string" ? r.preimage.toLowerCase() : "";
    if (!HEX64.test(preimage)) throw new NwcError("PAYMENT_FAILED", "no preimage");
    return { preimage, ...(typeof r.fees_paid === "number" ? { feesPaidMsat: r.fees_paid } : {}) };
  }

  /** The preimage of a payment this wallet made, when lookup_invoice says it settled. */
  async lookupPaid(paymentHash: string): Promise<string | null> {
    const r = await this.request("lookup_invoice", { payment_hash: paymentHash }, 20_000);
    const pre = typeof r.preimage === "string" ? r.preimage.toLowerCase() : "";
    return HEX64.test(pre) && (r.settled_at || r.state === "settled") ? pre : null;
  }

  async getBalanceMsat(): Promise<number> {
    const r = await this.request("get_balance", {});
    return typeof r.balance === "number" ? r.balance : NaN;
  }

  /** Subscribe on the first relay that answers, publish `event` (if any), resolve with the first matching event. */
  private async roundTrip(filter: Record<string, unknown>, event: NostrEvent | null, match: (e: NostrEvent) => boolean, stopAtEose: boolean, timeoutMs = 10_000): Promise<NostrEvent | null> {
    const connect = this.opts.connect ?? (await defaultWsConnect());
    const attempts = this.conn.relays.map(
      (relay) =>
        new Promise<NostrEvent | null>((resolve) => {
          let ws: WsLike | null = null;
          let done = false;
          const subId = `nwc-${randomBytes(4).toString("hex")}`;
          const finish = (e: NostrEvent | null) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try {
              ws?.send(JSON.stringify(["CLOSE", subId]));
              ws?.close();
            } catch {
              /* closed */
            }
            resolve(e);
          };
          const timer = setTimeout(() => finish(null), timeoutMs);
          try {
            ws = connect(relay);
          } catch {
            finish(null);
            return;
          }
          ws.onopen = () => {
            ws?.send(JSON.stringify(["REQ", subId, { ...filter, since: Math.floor(Date.now() / 1000) - (stopAtEose ? 365 * 86400 : 60) }]));
            if (event) ws?.send(JSON.stringify(["EVENT", event]));
          };
          ws.onmessage = (ev) => {
            const text = typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8");
            let msg: unknown;
            try {
              msg = JSON.parse(text);
            } catch {
              return;
            }
            if (!Array.isArray(msg)) return;
            if (msg[0] === "EVENT" && msg[1] === subId && verifyNostrEvent(msg[2]) && match(msg[2])) finish(msg[2]);
            else if (msg[0] === "EOSE" && msg[1] === subId && stopAtEose) finish(null);
          };
          ws.onerror = () => finish(null);
          ws.onclose = () => finish(null);
        })
    );
    // First non-null answer wins; null only when every relay gave up.
    return new Promise((resolve) => {
      let pending = attempts.length;
      for (const a of attempts)
        void a.then((e) => {
          if (e) resolve(e);
          else if (--pending === 0) resolve(null);
        });
    });
  }
}

/* ── Wallet-service side (used by the signet test bridge and tests) ── */

/** Decrypt and check a request addressed to `walletSecret`'s pubkey. */
export function decodeNwcRequest(event: unknown, walletSecret: Uint8Array): { request: NostrEvent; body: NwcRequestBody; encryption: NwcEncryption } {
  if (!verifyNostrEvent(event) || event.kind !== NWC_REQUEST_KIND) throw new Error("nwc_bad_request_event");
  const walletPubkey = Buffer.from(schnorr.getPublicKey(walletSecret)).toString("hex");
  if (!event.tags.some((t) => t[0] === "p" && t[1] === walletPubkey)) throw new Error("nwc_not_for_this_wallet");
  const encryption: NwcEncryption = event.tags.some((t) => t[0] === "encryption" && t[1] === "nip44_v2") ? "nip44_v2" : "nip04";
  const body = JSON.parse(nwcDecrypt(event.content, walletSecret, event.pubkey)) as NwcRequestBody;
  if (typeof body?.method !== "string") throw new Error("nwc_bad_request_body");
  return { request: event, body: { method: body.method, params: body.params ?? {} }, encryption };
}

export function buildNwcResponse(walletSecret: Uint8Array, request: NostrEvent, response: NwcResponse, encryption: NwcEncryption): NostrEvent {
  const pubkey = Buffer.from(schnorr.getPublicKey(walletSecret)).toString("hex");
  const tags = [["p", request.pubkey], ["e", request.id]];
  if (encryption === "nip44_v2") tags.push(["encryption", "nip44_v2"]);
  return signEvent({ pubkey, created_at: Math.floor(Date.now() / 1000), kind: NWC_RESPONSE_KIND, tags, content: nwcEncrypt(JSON.stringify(response), walletSecret, request.pubkey, encryption) }, walletSecret);
}
