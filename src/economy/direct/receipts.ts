// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Signed settlement receipts: what a buyer paid a payee directly, with the proof (the preimage of
 * the invoice's payment hash for Lightning; txid + output for on-chain; txid + note for Zcash),
 * signed by the coordinator (Ed25519) so both sides hold the same record.
 */

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { preimageProves } from "./lnurl-pay.js";

export type ReceiptRail = "lightning" | "onchain" | "zcash";

export interface SettlementReceipt {
  id: string;
  rail: ReceiptRail;
  /** What it paid for: an NWC tally, or a reservation's host or fee payment. */
  purpose: "tally" | "reservation" | "reservation_fee";
  buyerAccountId: string;
  payeeKind: "host" | "edgecoder_fee";
  payeeAccountId: string;
  destination: string;
  amountMsat: number;
  /** Lightning */
  paymentHash?: string;
  preimage?: string;
  bolt11?: string;
  /** On-chain / Zcash */
  txid?: string;
  vout?: number;
  confirmations?: number;
  reservationId?: string;
  tallyBeforeMsat?: number;
  tallyAfterMsat?: number;
  settledAtMs: number;
  coordinatorKey: string;
  signature?: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function receiptSigningBytes(r: SettlementReceipt): Buffer {
  const { signature: _sig, ...rest } = r;
  void _sig;
  return Buffer.from(`edgecoder-settlement-v1\n${canonical(rest)}`, "utf8");
}

export class ReceiptSigner {
  readonly publicKeyHex: string;
  private constructor(private readonly key: KeyObject) {
    const der = createPublicKey(key).export({ format: "der", type: "spki" });
    this.publicKeyHex = Buffer.from(der.subarray(der.length - 32)).toString("hex");
  }
  static generate(): ReceiptSigner {
    return new ReceiptSigner(generateKeyPairSync("ed25519").privateKey);
  }
  static fromPem(pem: string): ReceiptSigner {
    return new ReceiptSigner(createPrivateKey(pem));
  }
  sign(r: Omit<SettlementReceipt, "coordinatorKey" | "signature">): SettlementReceipt {
    const full: SettlementReceipt = { ...r, coordinatorKey: this.publicKeyHex };
    return { ...full, signature: sign(null, receiptSigningBytes(full), this.key).toString("hex") };
  }
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Signature valid for the embedded key, and (Lightning) the preimage proves the payment hash. */
export function verifyReceipt(r: SettlementReceipt): { ok: boolean; reason?: string } {
  if (!r.signature) return { ok: false, reason: "unsigned" };
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(r.coordinatorKey, "hex")]), format: "der", type: "spki" });
    if (!verify(null, receiptSigningBytes(r), key, Buffer.from(r.signature, "hex"))) return { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "bad_key" };
  }
  if (r.rail === "lightning" && !(r.paymentHash && r.preimage && preimageProves(r.paymentHash, r.preimage))) return { ok: false, reason: "preimage_mismatch" };
  return { ok: true };
}
