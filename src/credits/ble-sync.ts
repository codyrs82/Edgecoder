// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { z } from "zod";
import type { BLECreditTransaction } from "../common/types.js";
import { verifyPayload } from "../mesh/peer.js";
import type { CreditEngine } from "./engine.js";

/**
 * #41: /credits/ble-sync settlement logic, kept free of coordinator globals so it
 * can be unit tested.
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
 * Canonical v2 payload. BOTH requester and provider sign exactly this string, so
 * credits, txId and the requester account are covered by both signatures.
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

export type BleSkipReason =
  | "signature_required"
  | "invalid_signature"
  | "account_mismatch"
  | "duplicate"
  | "insufficient";

export type BleTransferResult = "applied" | "duplicate" | "insufficient";

export interface BleSyncDeps {
  getPublicKeyPem: (agentId: string) => string | undefined;
  rewardAccountForAgent: (agentId: string) => Promise<string>;
  /** Persistent dedupe + balance-checked debit/credit, atomically. */
  transfer: (tx: BleSyncTx, requesterAccountId: string, providerAccountId: string) => Promise<BleTransferResult>;
  allowV1?: boolean;
}

export function verifyBleTxSignatures(
  tx: BleSyncTx,
  requesterPem: string | undefined,
  providerPem: string | undefined,
  allowV1 = false
): "ok" | "signature_required" | "invalid_signature" {
  if (!requesterPem || !providerPem || !tx.requesterSignature || !tx.providerSignature) {
    return "signature_required";
  }
  const v2 = bleTxSignedPayloadV2(tx);
  if (verifyPayload(v2, tx.requesterSignature, requesterPem) && verifyPayload(v2, tx.providerSignature, providerPem)) {
    return "ok";
  }
  if (
    allowV1 &&
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
      deps.allowV1 ?? false
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
