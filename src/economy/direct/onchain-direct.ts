// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Direct on-chain BTC payments for large commitments: the buyer pays the host's address and the
 * coordinator checks the transaction, read-only. Two ways to tie a payment to a reservation:
 *
 * - xpub: the host registers an account-level extended public key (BIP84 zpub/vpub, or xpub/tpub
 *   treated as P2WPKH); each quote gets a fresh receive address m/0/i, so an output to it is the
 *   payment. The xpub can derive addresses, never spend.
 * - txid: the host registered a single address; the buyer submits the txid, and the coordinator
 *   checks an output pays that address at least the quoted amount and that the (txid, vout) has
 *   not paid for anything else.
 *
 * Confirmations come from an Esplora API (mutinynet.com/api on signet, mempool.space/api on
 * mainnet) or any ChainSource. Nothing here holds keys or funds.
 */

import { createHash, createHmac } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bech32, createBase58check } from "@scure/base";

export type BtcNet = "bitcoin" | "testnet" | "signet" | "regtest";

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const base58check = createBase58check(sha256);
const hash160 = (b: Uint8Array) => createHash("ripemd160").update(createHash("sha256").update(b).digest()).digest();

const HRP: Record<BtcNet, string> = { bitcoin: "bc", testnet: "tb", signet: "tb", regtest: "bcrt" };
/** Extended-public-key version bytes: xpub/zpub (mainnet), tpub/vpub (test networks). */
const VERSIONS: Record<string, "main" | "test"> = { "0488b21e": "main", "04b24746": "main", "043587cf": "test", "045f1cf6": "test" };

export interface ExtendedPubkey {
  publicKey: Uint8Array;
  chainCode: Uint8Array;
  depth: number;
  net: "main" | "test";
}

export function parseExtendedPubkey(s: string): ExtendedPubkey {
  const raw = base58check.decode(s.trim());
  if (raw.length !== 78) throw new Error("xpub_bad_length");
  const version = Buffer.from(raw.subarray(0, 4)).toString("hex");
  const net = VERSIONS[version];
  if (!net) throw new Error("xpub_unsupported_version");
  const publicKey = raw.subarray(45, 78);
  secp256k1.Point.fromHex(Buffer.from(publicKey).toString("hex")); // throws when not on the curve
  return { publicKey, chainCode: raw.subarray(13, 45), depth: raw[4], net };
}

/** BIP32 public (non-hardened) child derivation. */
export function deriveChild(parent: ExtendedPubkey, index: number): ExtendedPubkey {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) throw new Error("xpub_hardened_or_bad_index");
  const data = Buffer.alloc(37);
  Buffer.from(parent.publicKey).copy(data, 0);
  data.writeUInt32BE(index, 33);
  const I = createHmac("sha512", Buffer.from(parent.chainCode)).update(data).digest();
  const il = BigInt("0x" + I.subarray(0, 32).toString("hex"));
  if (il >= secp256k1.Point.CURVE().n) throw new Error("xpub_invalid_child");
  const child = secp256k1.Point.BASE.multiply(il).add(secp256k1.Point.fromHex(Buffer.from(parent.publicKey).toString("hex")));
  return { publicKey: child.toBytes(true), chainCode: new Uint8Array(I.subarray(32)), depth: parent.depth + 1, net: parent.net };
}

export function p2wpkhAddress(publicKey: Uint8Array, network: BtcNet): string {
  return bech32.encode(HRP[network], [0, ...bech32.toWords(hash160(publicKey))]);
}

/** Receive address `index` (m/0/index below the account key) as P2WPKH. */
export function receiveAddressFromXpub(xpub: string, index: number, network: BtcNet): string {
  const k = parseExtendedPubkey(xpub);
  if ((k.net === "main") !== (network === "bitcoin")) throw new Error("xpub_wrong_network");
  return p2wpkhAddress(deriveChild(deriveChild(k, 0), index).publicKey, network);
}

export interface ChainTx {
  txid: string;
  vout: Array<{ scriptpubkey_address?: string; value: number }>;
  status: { confirmed: boolean; block_height?: number };
}

export interface ChainSource {
  getTx(txid: string): Promise<ChainTx | null>;
  tipHeight(): Promise<number>;
}

export class EsploraChainSource implements ChainSource {
  constructor(private readonly baseUrl: string) {}
  async getTx(txid: string): Promise<ChainTx | null> {
    if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error("bad_txid");
    const res = await fetch(`${this.baseUrl}/tx/${txid}`, { signal: AbortSignal.timeout(15_000) });
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`esplora_http_${res.status}`);
    return (await res.json()) as ChainTx;
  }
  async tipHeight(): Promise<number> {
    const res = await fetch(`${this.baseUrl}/blocks/tip/height`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`esplora_http_${res.status}`);
    return Number(await res.text());
  }
}

export function defaultEsploraUrl(network: BtcNet): string | null {
  return network === "signet" ? "https://mutinynet.com/api" : network === "bitcoin" ? "https://mempool.space/api" : network === "testnet" ? "https://mempool.space/testnet4/api" : null;
}

export type OnchainCheck =
  | { status: "paid"; txid: string; vout: number; sats: number; confirmations: number }
  | { status: "unconfirmed"; txid: string; vout: number; sats: number; confirmations: number }
  | { status: "underpaid"; txid: string; vout: number; sats: number }
  | { status: "not_found" | "no_matching_output" | "output_already_used"; txid: string };

/**
 * Does `txid` pay `address` at least `minSats` with `minConfirmations`? `used` holds "txid:vout"
 * already credited to another reservation (one payment pays for one thing).
 */
export async function checkOnchainPayment(
  source: ChainSource,
  input: { txid: string; address: string; minSats: number; minConfirmations: number; used?: ReadonlySet<string> }
): Promise<OnchainCheck> {
  const tx = await source.getTx(input.txid);
  if (!tx) return { status: "not_found", txid: input.txid };
  const matches = tx.vout.map((o, vout) => ({ ...o, vout })).filter((o) => o.scriptpubkey_address === input.address);
  if (matches.length === 0) return { status: "no_matching_output", txid: input.txid };
  const fresh = matches.filter((o) => !input.used?.has(`${input.txid}:${o.vout}`));
  if (fresh.length === 0) return { status: "output_already_used", txid: input.txid };
  const best = fresh.sort((a, b) => b.value - a.value)[0];
  if (best.value < input.minSats) return { status: "underpaid", txid: input.txid, vout: best.vout, sats: best.value };
  const confirmations = tx.status.confirmed && tx.status.block_height !== undefined ? (await source.tipHeight()) - tx.status.block_height + 1 : 0;
  return { status: confirmations >= input.minConfirmations ? "paid" : "unconfirmed", txid: input.txid, vout: best.vout, sats: best.value, confirmations };
}
