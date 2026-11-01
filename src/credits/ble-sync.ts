// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import type { BLECreditTransaction } from "../common/types.js";
import { verifyPayload } from "../mesh/peer.js";
import type { CreditEngine } from "./engine.js";
import { bleTxV3FieldsFromTx, validateBleTxV3Fields, verifyBleTxV3, type BleTxV3Fields } from "./ble-tx-canonical.js";

/**
 * #41: /credits/ble-sync settlement logic, kept free of coordinator globals so it
 * can be unit tested. #63: signatures are verified over the canonical v3 bytes
 * (see ble-tx-canonical.ts); v1/v2 payloads only behind non-production flags.
 */

export const BLE_SYNC_MAX_CREDITS_PER_TX = (() => {
  const n = Number(process.env.BLE_SYNC_MAX_CREDITS_PER_TX ?? "100");
  return Number.isFinite(n) && n > 0 ? n : 100;
})();

export function createBleSyncSchema(maxCreditsPerTx = BLE_SYNC_MAX_CREDITS_PER_TX) {
  return z.object({
    transactions: z
      .array(
        z.object({
          txId: z.string().min(1).max(200),
          requesterId: z.string().min(1),
          providerId: z.string().min(1),
          requesterAccountId: z.string().min(1),
          providerAccountId: z.string(),
          credits: z.number().positive().max(maxCreditsPerTx),
          cpuSeconds: z.number().min(0),
          taskHash: z.string(),
          timestamp: z.number(),
          requesterSignature: z.string(),
          providerSignature: z.string()
        })
      )
      .max(500)
  });
}

/**
 * Route-level auth for /credits/ble-sync: a valid agent request signature, or a
 * mesh token that is actually configured (an empty MESH_AUTH_TOKEN never counts).
 */
export function isBleSyncAuthorized(
  verified: { agentId: string } | "rejected" | null,
  meshTokenConfigured: boolean,
  meshTokenValid: boolean
): boolean {
  if (verified === "rejected") return false;
  if (verified) return true;
  return meshTokenConfigured && meshTokenValid;
}

export type BleSyncTx = BLECreditTransaction;

/**
 * Legacy v2 payload (#41): float JSON, signed by both parties. Superseded by the
 * canonical v3 bytes (#63, src/credits/ble-tx-canonical.ts). Only honoured with
 * BLE_SYNC_ALLOW_V2=1 outside production.
 */
export function bleTxSignedPayloadV2(tx: Pick<
  BLECreditTransaction,
  "txId" | "requesterId" | "requesterAccountId" | "providerId" | "taskHash" | "cpuSeconds" | "credits"
>): string {
  return JSON.stringify({
    v: 2,
    txId: tx.txId,
    requesterId: tx.requesterId,
    requesterAccountId: tx.requesterAccountId,
    providerId: tx.providerId,
    taskHash: tx.taskHash,
    cpuSeconds: tx.cpuSeconds,
    credits: tx.credits
  });
}

/** Legacy v1 payloads (credits unsigned). Only honoured when explicitly allowed outside production. */
function v1RequesterPayload(tx: BLECreditTransaction): string {
  return JSON.stringify({ requesterId: tx.requesterId, taskHash: tx.taskHash });
}
function v1ProviderPayload(tx: BLECreditTransaction): string {
  return JSON.stringify({ providerId: tx.providerId, status: "completed", cpuSeconds: tx.cpuSeconds, taskHash: tx.taskHash });
}

export function bleSyncAllowV1(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.BLE_SYNC_ALLOW_V1 === "1";
}

export function bleSyncAllowV2(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.BLE_SYNC_ALLOW_V2 === "1";
}

export type BleSkipReason =
  | "signature_required"
  | "invalid_signature"
  | "invalid_payload"
  | "account_mismatch"
  | "duplicate"
  | "insufficient";

export type BleTransferResult = "applied" | "duplicate" | "insufficient";

export interface BleSyncLegacyAllowances {
  /** Accept v1 (credits unsigned) payloads. Never in production. */
  v1?: boolean;
  /** Accept v2 (float JSON) payloads. Never in production. */
  v2?: boolean;
}

export interface BleSyncDeps {
  getPublicKeyPem: (agentId: string) => string | undefined;
  rewardAccountForAgent: (agentId: string) => Promise<string>;
  /** Persistent dedupe + balance-checked debit/credit, atomically. */
  transfer: (tx: BleSyncTx, requesterAccountId: string, providerAccountId: string) => Promise<BleTransferResult>;
  legacy?: BleSyncLegacyAllowances;
}

/**
 * #63: both signatures must verify over the canonical v3 bytes. Any tampering
 * with a signed field (including credits by one milli-unit) -> invalid_signature.
 * Fields that cannot be canonically encoded (newline in a string, bad amounts)
 * -> invalid_payload.
 */
export function verifyBleTxSignatures(
  tx: BleSyncTx,
  requesterPem: string | undefined,
  providerPem: string | undefined,
  allow: BleSyncLegacyAllowances = {}
): "ok" | "signature_required" | "invalid_signature" | "invalid_payload" {
  if (!requesterPem || !providerPem || !tx.requesterSignature || !tx.providerSignature) {
    return "signature_required";
  }
  let fields: BleTxV3Fields;
  try {
    fields = bleTxV3FieldsFromTx(tx);
  } catch {
    return "invalid_payload";
  }
  if (validateBleTxV3Fields(fields)) return "invalid_payload";
  if (verifyBleTxV3(fields, tx.requesterSignature, requesterPem) && verifyBleTxV3(fields, tx.providerSignature, providerPem)) {
    return "ok";
  }
  if (allow.v2) {
    const v2 = bleTxSignedPayloadV2(tx);
    if (verifyPayload(v2, tx.requesterSignature, requesterPem) && verifyPayload(v2, tx.providerSignature, providerPem)) {
      return "ok";
    }
  }
  if (
    allow.v1 &&
    verifyPayload(v1RequesterPayload(tx), tx.requesterSignature, requesterPem) &&
    verifyPayload(v1ProviderPayload(tx), tx.providerSignature, providerPem)
  ) {
    return "ok";
  }
  return "invalid_signature";
}

export async function applyBleSyncBatch(
  transactions: BleSyncTx[],
  deps: BleSyncDeps
): Promise<{ applied: string[]; skipped: Array<{ txId: string; reason: BleSkipReason }> }> {
  const applied: string[] = [];
  const skipped: Array<{ txId: string; reason: BleSkipReason }> = [];
  for (const tx of transactions) {
    const sig = verifyBleTxSignatures(
      tx,
      deps.getPublicKeyPem(tx.requesterId),
      deps.getPublicKeyPem(tx.providerId),
      deps.legacy ?? {}
    );
    if (sig !== "ok") {
      skipped.push({ txId: tx.txId, reason: sig });
      continue;
    }
    const requesterAccountId = await deps.rewardAccountForAgent(tx.requesterId);
    if (tx.requesterAccountId !== requesterAccountId) {
      skipped.push({ txId: tx.txId, reason: "account_mismatch" });
      continue;
    }
    const providerAccountId = await deps.rewardAccountForAgent(tx.providerId);
    const result = await deps.transfer(tx, requesterAccountId, providerAccountId);
    if (result === "applied") applied.push(tx.txId);
    else skipped.push({ txId: tx.txId, reason: result });
  }
  return { applied, skipped };
}

/** Non-Postgres transfer: in-process dedupe set + balance check before adjust. */
export function createInMemoryBleTransfer(engine: CreditEngine, synced: Set<string> = new Set()) {
  return async (tx: BleSyncTx, requesterAccountId: string, providerAccountId: string): Promise<BleTransferResult> => {
    if (synced.has(tx.txId)) return "duplicate";
    if (engine.balance(requesterAccountId) < tx.credits) return "insufficient";
    synced.add(tx.txId);
    engine.adjust(requesterAccountId, -tx.credits, "ble_compute");
    engine.adjust(providerAccountId, tx.credits, "ble_compute");
    return "applied";
  };
}
