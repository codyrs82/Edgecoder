// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import {
  signBleTxV3,
  toMillis,
  validateBleTxV3Fields,
  type BleTxV3Fields
} from "../../credits/ble-tx-canonical.js";
import { expectedBleCreditMillis } from "./ble-pricing.js";

/**
 * #63: BLE co-sign step. After the provider returns a task response, the
 * requester computes the credits, builds the FINAL transaction and sends it to
 * the provider over BLE as a `ble-tx-cosign-v3` message. The provider checks the
 * amounts against what it actually served (its own cpuSeconds and model
 * multiplier, within tolerance), signs the canonical v3 bytes and returns the
 * signature. The requester then adds its own signature; only a transaction
 * carrying both signatures is written to the offline ledger.
 *
 * On the wire (GATT task-request characteristic, JSON) the request is
 * distinguished from a task request by `type`. The response travels on the
 * task-response notify characteristic with the same chunk framing as task
 * responses. The iOS implementation lives in BLEMeshManager.swift.
 */
export const BLE_COSIGN_MSG_TYPE = "ble-tx-cosign-v3";

export interface BleCoSignRequest {
  type: typeof BLE_COSIGN_MSG_TYPE;
  tx: BleTxV3Fields & { timestamp: number };
}

export type BleCoSignRejectReason =
  | "invalid_payload"
  | "provider_mismatch"
  | "unknown_task"
  | "cpu_mismatch"
  | "credit_mismatch"
  | "already_cosigned"
  | "no_cosign_handler"
  | "transport_error";

export interface BleCoSignResponse {
  type: typeof BLE_COSIGN_MSG_TYPE;
  txId: string;
  status: "signed" | "rejected";
  providerSignature?: string;
  reason?: BleCoSignRejectReason;
}

export function isBleCoSignMessage(value: unknown): value is { type: typeof BLE_COSIGN_MSG_TYPE } {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === BLE_COSIGN_MSG_TYPE;
}

/** Validate a decoded co-sign request from an untrusted peer. */
export function parseBleCoSignRequest(value: unknown): BleCoSignRequest | null {
  if (!isBleCoSignMessage(value)) return null;
  const tx = (value as { tx?: unknown }).tx;
  if (typeof tx !== "object" || tx === null) return null;
  const t = tx as Record<string, unknown>;
  const fields: BleTxV3Fields = {
    txId: t.txId as string,
    requesterId: t.requesterId as string,
    requesterAccountId: t.requesterAccountId as string,
    providerId: t.providerId as string,
    providerAccountId: t.providerAccountId as string,
    taskHash: t.taskHash as string,
    cpuMillis: t.cpuMillis as number,
    creditMillis: t.creditMillis as number
  };
  if (validateBleTxV3Fields(fields)) return null;
  const timestamp = typeof t.timestamp === "number" && Number.isFinite(t.timestamp) ? t.timestamp : Date.now();
  return { type: BLE_COSIGN_MSG_TYPE, tx: { ...fields, timestamp } };
}

export interface BleServedTask {
  requestId: string;
  requesterId: string;
  taskHash: string;
  cpuSeconds: number;
}

interface ServedEntry extends BleServedTask {
  cpuMillis: number;
  servedAt: number;
  cosignedTxId?: string;
  cosignature?: string;
}

export interface BleProviderCoSignerOptions {
  agentId: string;
  accountId: string;
  privateKeyPem: string;
  /** The model size this provider currently advertises (what the requester priced against). */
  modelParamSize: () => number;
  /** Served tasks older than this can no longer be co-signed (default 15 min). */
  ttlMs?: number;
  /** Absolute credit tolerance in milli-credits on top of the 1% relative one (default 2). */
  toleranceMillis?: number;
  now?: () => number;
}

/**
 * Provider-side state for the co-sign step: remembers what this node served
 * (one co-signature per served task) and signs only transactions whose
 * amounts match its own measurement.
 */
export class BleProviderCoSigner {
  private readonly served: ServedEntry[] = [];
  private readonly ttlMs: number;
  private readonly toleranceMillis: number;
  private readonly now: () => number;

  constructor(private readonly opts: BleProviderCoSignerOptions) {
    this.ttlMs = opts.ttlMs ?? 15 * 60_000;
    this.toleranceMillis = opts.toleranceMillis ?? 2;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Call after a task completed successfully (before the response is sent). */
  recordServed(task: BleServedTask): void {
    this.prune();
    this.served.push({ ...task, cpuMillis: toMillis(task.cpuSeconds), servedAt: this.now() });
  }

  handle(request: BleCoSignRequest): BleCoSignResponse {
    const tx = request.tx;
    const reject = (reason: BleCoSignRejectReason): BleCoSignResponse => ({
      type: BLE_COSIGN_MSG_TYPE,
      txId: typeof tx?.txId === "string" ? tx.txId : "",
      status: "rejected",
      reason
    });
    if (validateBleTxV3Fields(tx)) return reject("invalid_payload");
    if (tx.providerId !== this.opts.agentId || tx.providerAccountId !== this.opts.accountId) {
      return reject("provider_mismatch");
    }
    this.prune();
    const candidates = this.served.filter((e) => e.requesterId === tx.requesterId && e.taskHash === tx.taskHash);
    if (candidates.length === 0) return reject("unknown_task");
    // Idempotent replay: same txId already co-signed -> same signature.
    const replay = candidates.find((e) => e.cosignedTxId === tx.txId);
    if (replay?.cosignature) {
      return { type: BLE_COSIGN_MSG_TYPE, txId: tx.txId, status: "signed", providerSignature: replay.cosignature };
    }
    const open = candidates.filter((e) => !e.cosignedTxId);
    if (open.length === 0) return reject("already_cosigned");
    const entry = open.find((e) => Math.abs(e.cpuMillis - tx.cpuMillis) <= 1);
    if (!entry) return reject("cpu_mismatch");
    const expected = expectedBleCreditMillis(entry.cpuSeconds, this.opts.modelParamSize());
    const tolerance = Math.max(this.toleranceMillis, Math.ceil(expected * 0.01));
    if (Math.abs(tx.creditMillis - expected) > tolerance) return reject("credit_mismatch");
    const fields: BleTxV3Fields = {
      txId: tx.txId,
      requesterId: tx.requesterId,
      requesterAccountId: tx.requesterAccountId,
      providerId: tx.providerId,
      providerAccountId: tx.providerAccountId,
      taskHash: tx.taskHash,
      cpuMillis: tx.cpuMillis,
      creditMillis: tx.creditMillis
    };
    const providerSignature = signBleTxV3(fields, this.opts.privateKeyPem);
    entry.cosignedTxId = tx.txId;
    entry.cosignature = providerSignature;
    return { type: BLE_COSIGN_MSG_TYPE, txId: tx.txId, status: "signed", providerSignature };
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (let i = this.served.length - 1; i >= 0; i--) {
      if (this.served[i].servedAt < cutoff) this.served.splice(i, 1);
    }
  }
}
