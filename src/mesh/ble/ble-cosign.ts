// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { BLECosignRequest, BLECosignResponse } from "../../common/types.js";
import {
  BleTxFieldError,
  bleCreditMillis,
  bleCreditToleranceMillis,
  bleTxV3CanonicalBytes,
  signBleTxV3,
  type BleTxV3Fields
} from "../../credits/ble-tx-v3.js";

interface ServedTask {
  requesterId: string;
  taskHash: string;
  cpuMillis: number;
  servedAtMs: number;
  signed?: { txId: string; bytesHex: string; signature: string };
}

export interface BleCosignProviderOptions {
  agentId: string;
  /** The reward account the provider is paid into (what the coordinator resolves for agentId). */
  accountId: () => string;
  privateKeyPem: string;
  /** Param size of the model the provider advertises (drives the quality multiplier). */
  modelParamSize: () => number;
  /** How long a served task can still be co-signed. */
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * #63: provider side of the BLE co-sign step. It remembers the tasks it completed (requester,
 * task hash, cpu time it reported) and signs the requester's final transaction only when it matches
 * that record and the credits are within tolerance of its own calculation. One task is co-signed
 * for at most one txId; re-asking for the same tx returns the same signature.
 */
export class BleCosignProvider {
  private readonly served = new Map<string, ServedTask>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(private readonly opts: BleCosignProviderOptions) {
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.maxEntries = opts.maxEntries ?? 1000;
    this.now = opts.now ?? Date.now;
  }

  /** Call after a task completes; cpuMillis must be exactly what the response reports (cpuMillis / 1000). */
  recordServed(requestId: string, requesterId: string, taskHash: string, cpuMillis: number): void {
    this.evict();
    this.served.set(requestId, { requesterId, taskHash, cpuMillis, servedAtMs: this.now() });
  }

  handle(req: BLECosignRequest): BLECosignResponse {
    const tx = (req?.tx ?? {}) as BleTxV3Fields;
    const reject = (reason: string): BLECosignResponse => ({
      type: "cosign_result",
      requestId: String(req?.requestId ?? ""),
      txId: String(tx.txId ?? ""),
      status: "rejected",
      providerSignature: "",
      reason
    });
    this.evict();
    const served = this.served.get(req?.requestId);
    if (!served) return reject("unknown_request");
    if (tx.providerId !== this.opts.agentId) return reject("provider_mismatch");
    if (tx.providerAccountId !== this.opts.accountId()) return reject("provider_account_mismatch");
    if (tx.requesterId !== served.requesterId) return reject("requester_mismatch");
    if (tx.taskHash !== served.taskHash) return reject("task_hash_mismatch");
    if (tx.cpuMillis !== served.cpuMillis) return reject("cpu_mismatch");
    const expected = bleCreditMillis(served.cpuMillis, this.opts.modelParamSize());
    if (!Number.isSafeInteger(tx.creditMillis) || Math.abs(tx.creditMillis - expected) > bleCreditToleranceMillis(expected)) {
      return reject("credits_out_of_tolerance");
    }
    let bytesHex: string;
    try {
      bytesHex = bleTxV3CanonicalBytes(tx).toString("hex");
    } catch (err) {
      if (err instanceof BleTxFieldError) return reject("invalid_field");
      throw err;
    }
    if (served.signed) {
      if (served.signed.txId !== tx.txId || served.signed.bytesHex !== bytesHex) return reject("already_cosigned");
    } else {
      served.signed = { txId: tx.txId, bytesHex, signature: signBleTxV3(tx, this.opts.privateKeyPem) };
    }
    return {
      type: "cosign_result",
      requestId: req.requestId,
      txId: tx.txId,
      status: "signed",
      providerSignature: served.signed.signature
    };
  }

  private evict(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.served) {
      if (entry.servedAtMs < cutoff || this.served.size > this.maxEntries) this.served.delete(id);
      else break; // Map keeps insertion order, so the rest are newer
    }
  }
}
