// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { sign, verify } from "node:crypto";
import type { BLECreditTransaction } from "../common/types.js";

/**
 * #63: canonical signed-payload bytes for offline BLE credit transactions (v3).
 *
 * Both the requester and the provider sign EXACTLY these bytes, and the
 * coordinator (/credits/ble-sync) verifies against EXACTLY these bytes. The
 * format is deliberately not JSON so the TypeScript and Swift encoders cannot
 * drift on key order, float formatting or escaping:
 *
 *   "edgecoder-ble-tx-v3" "\n"
 *   txId "\n" requesterId "\n" requesterAccountId "\n" providerId "\n"
 *   providerAccountId "\n" taskHash "\n" cpuMillis "\n" creditMillis
 *
 * - UTF-8, fields joined by a single "\n", no trailing newline.
 * - Integer units only: cpuMillis = round(cpuSeconds * 1000),
 *   creditMillis = round(credits * 1000); base-10, no sign, no leading zeros,
 *   no exponent.
 * - String fields must not contain "\n" (they would move the field boundary);
 *   the server rejects such transactions before signature verification.
 *
 * The same rules are implemented in ios/.../Mesh/BleTxCanonical.swift and the
 * shared vectors in tests/vectors/ble-tx-v3.json are asserted on both sides.
 */

export const BLE_TX_V3_DOMAIN = "edgecoder-ble-tx-v3";

export interface BleTxV3Fields {
  txId: string;
  requesterId: string;
  requesterAccountId: string;
  providerId: string;
  providerAccountId: string;
  taskHash: string;
  /** round(cpuSeconds * 1000), non-negative safe integer */
  cpuMillis: number;
  /** round(credits * 1000), non-negative safe integer */
  creditMillis: number;
}

export type BleTxV3StringField = "txId" | "requesterId" | "requesterAccountId" | "providerId" | "providerAccountId" | "taskHash";

const STRING_FIELDS: BleTxV3StringField[] = ["txId", "requesterId", "requesterAccountId", "providerId", "providerAccountId", "taskHash"];

/** Lone UTF-16 surrogates cannot be encoded as UTF-8 (Buffer would substitute U+FFFD, silently changing the bytes). */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Convert a float unit amount (credits / seconds) to integer milli-units. */
export function toMillis(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`ble-tx-v3: amount must be a finite non-negative number, got ${String(value)}`);
  }
  const millis = Math.round(value * 1000);
  if (!Number.isSafeInteger(millis)) {
    throw new RangeError(`ble-tx-v3: amount out of range: ${String(value)}`);
  }
  return millis;
}

/** Inverse of toMillis for ledger storage / wire JSON (exact for all safe integers). */
export function fromMillis(millis: number): number {
  return millis / 1000;
}

/**
 * Returns a human-readable reason when `fields` cannot be canonically encoded,
 * or null when they are valid.
 */
export function validateBleTxV3Fields(fields: BleTxV3Fields): string | null {
  for (const key of STRING_FIELDS) {
    const v = fields[key];
    if (typeof v !== "string") return `${key} must be a string`;
    if (v.length === 0) return `${key} must not be empty`;
    if (v.includes("\n")) return `${key} must not contain a newline`;
    if (LONE_SURROGATE.test(v)) return `${key} must be valid UTF-8 (lone surrogate)`;
  }
  for (const key of ["cpuMillis", "creditMillis"] as const) {
    const v = fields[key];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
      return `${key} must be a non-negative safe integer`;
    }
  }
  return null;
}

/** Canonical UTF-8 string (see module doc). Throws on invalid fields. */
export function bleTxV3CanonicalString(fields: BleTxV3Fields): string {
  const problem = validateBleTxV3Fields(fields);
  if (problem) throw new Error(`ble-tx-v3: ${problem}`);
  return [
    BLE_TX_V3_DOMAIN,
    fields.txId,
    fields.requesterId,
    fields.requesterAccountId,
    fields.providerId,
    fields.providerAccountId,
    fields.taskHash,
    // Safe integers stringify in base-10 without sign, leading zeros or exponent.
    String(fields.cpuMillis),
    String(fields.creditMillis)
  ].join("\n");
}

/** Canonical bytes that are signed / verified. */
export function encodeBleTxV3(fields: BleTxV3Fields): Buffer {
  return Buffer.from(bleTxV3CanonicalString(fields), "utf8");
}

/** Project a wire/ledger transaction (float credits & seconds) onto the signed v3 fields. */
export function bleTxV3FieldsFromTx(
  tx: Pick<
    BLECreditTransaction,
    "txId" | "requesterId" | "requesterAccountId" | "providerId" | "providerAccountId" | "taskHash" | "cpuSeconds" | "credits"
  >
): BleTxV3Fields {
  return {
    txId: tx.txId,
    requesterId: tx.requesterId,
    requesterAccountId: tx.requesterAccountId,
    providerId: tx.providerId,
    providerAccountId: tx.providerAccountId,
    taskHash: tx.taskHash,
    cpuMillis: toMillis(tx.cpuSeconds),
    creditMillis: toMillis(tx.credits)
  };
}

/** ed25519 signature (base64) over the canonical v3 bytes. */
export function signBleTxV3(fields: BleTxV3Fields, privateKeyPem: string): string {
  return sign(null, encodeBleTxV3(fields), privateKeyPem).toString("base64");
}

/** Verify an ed25519 signature (base64) over the canonical v3 bytes. Never throws. */
export function verifyBleTxV3(fields: BleTxV3Fields, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    if (validateBleTxV3Fields(fields)) return false;
    const sig = Buffer.from(signatureBase64, "base64");
    if (sig.length !== 64) return false;
    return verify(null, encodeBleTxV3(fields), publicKeyPem, sig);
  } catch {
    return false;
  }
}
