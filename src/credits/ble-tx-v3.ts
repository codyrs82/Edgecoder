// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { sign, verify } from "node:crypto";

/**
 * #63: canonical signed bytes for a BLE credit transaction (v3).
 *
 * Both the requester and the provider sign exactly these bytes, and /credits/ble-sync verifies
 * exactly these bytes. The same encoding is implemented in Swift (ios/.../Mesh/OfflineLedger.swift,
 * `BLETxV3`) and pinned by tests/security/fixtures/ble-tx-v3-vectors.json, so no JSON encoder and
 * no float formatting is involved:
 *
 *   UTF-8 of  "edgecoder-ble-tx-v3" \n txId \n requesterId \n requesterAccountId \n providerId \n
 *             providerAccountId \n taskHash \n cpuMillis \n creditMillis      (no trailing newline)
 *
 * cpuMillis = round(cpuSeconds * 1000) and creditMillis = round(credits * 1000), written as base-10
 * integers with no sign, no leading zeros and no exponent. Strings must not contain "\n".
 */
export const BLE_TX_V3_DOMAIN = "edgecoder-ble-tx-v3";

export interface BleTxV3Fields {
  txId: string;
  requesterId: string;
  requesterAccountId: string;
  providerId: string;
  providerAccountId: string;
  taskHash: string;
  cpuMillis: number;
  creditMillis: number;
}

export class BleTxFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BleTxFieldError";
  }
}

const STRING_FIELDS = ["txId", "requesterId", "requesterAccountId", "providerId", "providerAccountId", "taskHash"] as const;

function canonicalInteger(name: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BleTxFieldError(`${name} must be a non-negative safe integer`);
  }
  // String() of a safe non-negative integer is plain base-10: no sign, no leading zeros, no exponent.
  return String(value);
}

/** The exact bytes both parties sign. Throws BleTxFieldError for a field that cannot be encoded. */
export function bleTxV3CanonicalBytes(fields: BleTxV3Fields): Buffer {
  const parts: string[] = [BLE_TX_V3_DOMAIN];
  for (const name of STRING_FIELDS) {
    const value = fields[name];
    if (typeof value !== "string") throw new BleTxFieldError(`${name} must be a string`);
    if (value.includes("\n")) throw new BleTxFieldError(`${name} must not contain a newline`);
    parts.push(value);
  }
  parts.push(canonicalInteger("cpuMillis", fields.cpuMillis));
  parts.push(canonicalInteger("creditMillis", fields.creditMillis));
  return Buffer.from(parts.join("\n"), "utf8");
}

export function signBleTxV3(fields: BleTxV3Fields, privateKeyPem: string): string {
  return sign(null, bleTxV3CanonicalBytes(fields), privateKeyPem).toString("base64");
}

export function verifyBleTxV3(fields: BleTxV3Fields, signatureBase64: string, publicKeyPem: string): boolean {
  try {
    return verify(null, bleTxV3CanonicalBytes(fields), publicKeyPem, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

/** round(x * 1000), for a requester building a new transaction. */
export function toMillis(x: number): number {
  return Math.round(x * 1000);
}

/**
 * Inverse check for a value received on the wire (credits / cpuSeconds): the integer milli-units it
 * stands for, or null when it is not an exact milli-unit amount (so it cannot be what was signed).
 */
export function exactMillis(x: number): number | null {
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0) return null;
  const m = Math.round(x * 1000);
  if (!Number.isSafeInteger(m)) return null;
  return Math.abs(x * 1000 - m) <= 1e-6 ? m : null;
}

/** Wire-format transaction fields -> v3 fields, or null when credits/cpuSeconds are not exact millis. */
export function bleTxV3FieldsFromWire(tx: {
  txId: string;
  requesterId: string;
  requesterAccountId: string;
  providerId: string;
  providerAccountId: string;
  taskHash: string;
  cpuSeconds: number;
  credits: number;
}): BleTxV3Fields | null {
  const cpuMillis = exactMillis(tx.cpuSeconds);
  const creditMillis = exactMillis(tx.credits);
  if (cpuMillis === null || creditMillis === null) return null;
  return {
    txId: tx.txId,
    requesterId: tx.requesterId,
    requesterAccountId: tx.requesterAccountId,
    providerId: tx.providerId,
    providerAccountId: tx.providerAccountId,
    taskHash: tx.taskHash,
    cpuMillis,
    creditMillis
  };
}

/** Maps model param size to a credit quality multiplier, in tenths (integer, so Swift and TS agree). */
export function modelQualityMultiplierTenths(paramSize: number): number {
  if (paramSize >= 7) return 10;
  if (paramSize >= 3) return 7;
  if (paramSize >= 1.5) return 5;
  return 3;
}

/**
 * Credits for a BLE task, in milli-units: cpuMillis x base CPU rate (1 credit/s) x quality multiplier.
 * Integer arithmetic, rounded half up; mirrored by BLETxV3.creditMillis in Swift.
 */
export function bleCreditMillis(cpuMillis: number, providerModelParamSize: number): number {
  return Math.floor((cpuMillis * modelQualityMultiplierTenths(providerModelParamSize) + 5) / 10);
}

/** How far the requester's creditMillis may be from the provider's own computation. */
export function bleCreditToleranceMillis(expectedMillis: number): number {
  return Math.max(1, Math.ceil(expectedMillis / 100));
}
