// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * TEST NETWORKS ONLY. A minimal NIP-47 wallet service in front of an LND node, so a signet LND can
 * act as a *buyer's own wallet* for the direct-payment prototype (docs/design/noncustodial-payments.md).
 * It stands in for what a buyer would run themselves (Alby Hub, Zeus, …); EdgeCoder never runs it.
 *
 * - Listens on a Nostr relay for kind 23194 requests from ONE authorized client key.
 * - pay_invoice (with a daily budget), get_balance, get_info, lookup_invoice (outgoing payments).
 * - Refuses to start unless the node is on signet or regtest, and refuses mainnet invoices.
 * - The wallet-service secret and the client connection string are written to mode-600 files in
 *   NWC_STATE_DIR; nothing secret is printed.
 *
 * Env:
 *   LND_REST_URL          e.g. https://127.0.0.1:18080 (fly proxy 18080:8080 -a edgecoder-lnd-signet)
 *   LND_MACAROON_FILE     hex macaroon with offchain:read/write + info:read
 *   LND_TLS_CERT_FILE     the node's tls.cert (PEM), pinned
 *   NWC_RELAY             default wss://relay.getalby.com/v1
 *   NWC_STATE_DIR         where wallet.key and connection.uri live (created 0700)
 *   NWC_DAILY_BUDGET_SATS default 5000
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { Agent, request } from "undici";
import { defaultWsConnect, verifyNostrEvent, type NostrEvent, type WsLike } from "../../src/discovery/nostr.js";
import { decodeBolt11 } from "../../src/economy/bolt11.js";
import { LndRestProvider } from "../../src/economy/lightning.js";
import { buildNwcResponse, decodeNwcRequest, NWC_INFO_KIND, NWC_REQUEST_KIND, signEvent, type NwcResponse } from "../../src/economy/direct/nwc.js";

const env = process.env;
const stateDir = env.NWC_STATE_DIR ?? join(process.env.HOME ?? ".", ".config/edgecoder/nwc-signet");
const relay = env.NWC_RELAY ?? "wss://relay.getalby.com/v1";
const budgetSats = Number(env.NWC_DAILY_BUDGET_SATS ?? 5000);

function secretFile(name: string, make: () => string): string {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const p = join(stateDir, name);
  if (!existsSync(p)) writeFileSync(p, make(), { mode: 0o600 });
  chmodSync(p, 0o600);
  return readFileSync(p, "utf8").trim();
}

const walletSecret = new Uint8Array(Buffer.from(secretFile("wallet.key", () => randomBytes(32).toString("hex")), "hex"));
const walletPubkey = Buffer.from(schnorr.getPublicKey(walletSecret)).toString("hex");
const clientSecretHex = secretFile("client.key", () => randomBytes(32).toString("hex"));
const clientPubkey = Buffer.from(schnorr.getPublicKey(Buffer.from(clientSecretHex, "hex"))).toString("hex");
secretFile("connection.uri", () => `nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent(relay)}&secret=${clientSecretHex}`);

const macaroonHex = readFileSync(env.LND_MACAROON_FILE ?? join(stateDir, "lnd.macaroon.hex"), "utf8").trim();
const certPem = readFileSync(env.LND_TLS_CERT_FILE ?? join(stateDir, "lnd.tls.cert"), "utf8");
const baseUrl = env.LND_REST_URL ?? "https://127.0.0.1:18080";
const dispatcher = new Agent({ connect: { ca: certPem } });
const lnd = new LndRestProvider(baseUrl, macaroonHex, dispatcher, 30_000);

async function lndGet(path: string): Promise<any> {
  const res = await request(`${baseUrl}${path}`, { dispatcher, headers: { "Grpc-Metadata-macaroon": macaroonHex }, headersTimeout: 20_000, bodyTimeout: 20_000 });
  if (res.statusCode !== 200) throw new Error(`lnd_http_${res.statusCode}`);
  return res.body.json();
}

const spent: Array<{ atMs: number; msat: number }> = [];
const spentToday = () => spent.filter((s) => Date.now() - s.atMs < 86_400_000).reduce((a, s) => a + s.msat, 0);
const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));

async function handle(method: string, params: Record<string, unknown>): Promise<Omit<NwcResponse, "result_type">> {
  if (method === "get_info") {
    const info = await lndGet("/v1/getinfo");
    return { result: { alias: info.alias, pubkey: info.identity_pubkey, network: "signet", block_height: info.block_height, methods: ["pay_invoice", "get_balance", "get_info", "lookup_invoice"] } };
  }
  if (method === "get_balance") {
    const b = await lnd.getBalances();
    return { result: { balance: b.channelLocalSats * 1000 } };
  }
  if (method === "lookup_invoice") {
    const hash = String(params.payment_hash ?? "");
    const list = await lnd.listPayments({ sinceMs: Date.now() - 7 * 86_400_000, limit: 500 });
    const p = list.payments.find((x) => x.paymentHash === hash);
    if (!p) return { error: { code: "NOT_FOUND", message: "no such payment" } };
    return { result: { type: "outgoing", payment_hash: hash, amount: p.valueMsat, fees_paid: p.feeMsat, ...(p.status === "succeeded" ? { preimage: p.preimage, settled_at: Math.floor(p.createdAtMs / 1000), state: "settled" } : { state: p.status === "failed" ? "failed" : "pending" }) } };
  }
  if (method === "pay_invoice") {
    const invoice = String(params.invoice ?? "");
    let d;
    try {
      d = decodeBolt11(invoice);
    } catch {
      return { error: { code: "OTHER", message: "bad invoice" } };
    }
    if (d.network !== "signet" && d.network !== "regtest") return { error: { code: "RESTRICTED", message: "test networks only" } };
    const msat = d.amountMsat ?? Number(params.amount ?? 0);
    if (spentToday() + msat > budgetSats * 1000) return { error: { code: "QUOTA_EXCEEDED", message: "daily budget" } };
    const r = await lnd.payInvoice({ bolt11: invoice, maxFeeSats: Math.max(10, Math.ceil(msat / 1000 / 50)), timeoutSeconds: 45 });
    log("pay_invoice", { paymentHash: d.paymentHash, amountMsat: msat, status: r.status, feeMsat: r.feeMsat, error: r.error });
    if (r.status !== "succeeded" || !r.preimage) return { error: { code: /INSUFFICIENT_BALANCE/.test(r.error ?? "") ? "INSUFFICIENT_BALANCE" : "PAYMENT_FAILED", message: r.error ?? "failed" } };
    spent.push({ atMs: Date.now(), msat: msat + (r.feeMsat ?? 0) });
    return { result: { preimage: r.preimage, fees_paid: r.feeMsat ?? 0 } };
  }
  return { error: { code: "NOT_IMPLEMENTED", message: method } };
}

async function main() {
  const info = await lndGet("/v1/getinfo");
  const nets = (info.chains ?? []).map((c: { network: string }) => c.network);
  if (!nets.every((n: string) => n === "signet" || n === "regtest")) throw new Error(`refusing: node network ${nets.join(",")}`);
  log("wallet_service_ready", { alias: info.alias, walletPubkey, clientPubkey, relay, budgetSats, stateDir });
  const connect = await defaultWsConnect();
  const seen = new Set<string>();
  const run = () => {
    const ws: WsLike = connect(relay);
    const sub = `w-${randomBytes(4).toString("hex")}`;
    ws.onopen = () => {
      const infoEv = signEvent({ pubkey: walletPubkey, created_at: Math.floor(Date.now() / 1000), kind: NWC_INFO_KIND, tags: [["encryption", "nip44_v2 nip04"]], content: "pay_invoice get_balance get_info lookup_invoice" }, walletSecret);
      ws.send(JSON.stringify(["EVENT", infoEv]));
      ws.send(JSON.stringify(["REQ", sub, { kinds: [NWC_REQUEST_KIND], "#p": [walletPubkey], since: Math.floor(Date.now() / 1000) - 30 }]));
      log("relay_connected", { relay });
    };
    ws.onmessage = (ev) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString("utf8"));
      } catch {
        return;
      }
      if (msg[0] !== "EVENT" || msg[1] !== sub) return;
      const e = msg[2] as NostrEvent;
      if (!verifyNostrEvent(e) || seen.has(e.id)) return;
      seen.add(e.id);
      if (e.pubkey !== clientPubkey) return log("request_from_unknown_client_ignored", { pubkey: e.pubkey });
      const exp = e.tags.find((t) => t[0] === "expiration")?.[1];
      if (exp && Number(exp) * 1000 < Date.now()) return log("request_expired", { id: e.id });
      void (async () => {
        let decoded;
        try {
          decoded = decodeNwcRequest(e, walletSecret);
        } catch (err) {
          return log("request_undecodable", { error: String(err) });
        }
        const out = await handle(decoded.body.method, decoded.body.params).catch((err) => ({ error: { code: "INTERNAL", message: String(err) } }));
        ws.send(JSON.stringify(["EVENT", buildNwcResponse(walletSecret, decoded.request, { result_type: decoded.body.method, ...out }, decoded.encryption)]));
        log("request_answered", { method: decoded.body.method, encryption: decoded.encryption, ok: !("error" in out && out.error) });
      })();
    };
    ws.onclose = () => {
      log("relay_closed_reconnecting");
      setTimeout(run, 2000);
    };
    ws.onerror = () => undefined;
  };
  run();
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
