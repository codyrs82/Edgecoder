// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID, createHash } from "node:crypto";
import { BLETaskRequest, BLETaskResponse, BLECreditTransaction } from "../../common/types.js";
import { bleCreditMillis, modelQualityMultiplierTenths, signBleTxV3, toMillis, type BleTxV3Fields } from "../../credits/ble-tx-v3.js";
import { BLETransport } from "./ble-transport.js";
import { BLERouter } from "./ble-router.js";
import { OfflineLedger } from "./offline-ledger.js";
import type { SQLiteStore } from "../../db/sqlite-store.js";

/** Maps model param size to a credit quality multiplier */
export function modelQualityMultiplier(paramSize: number): number {
  return modelQualityMultiplierTenths(paramSize) / 10;
}

export interface BLEMeshManagerOptions {
  /** Ed25519 key the coordinator has registered for agentId; signs the requester side (#63). */
  privateKeyPem?: string;
}

export class BLEMeshManager {
  private offline = false;
  private readonly router = new BLERouter();
  private readonly ledger: OfflineLedger;
  private readonly transport: BLETransport;
  private readonly store: SQLiteStore | null;
  private readonly agentId: string;
  private accountId: string;
  private readonly privateKeyPem: string | undefined;
  private ownTokenHash = "";

  constructor(agentId: string, accountId: string, transport: BLETransport, store?: SQLiteStore, options: BLEMeshManagerOptions = {}) {
    this.agentId = agentId;
    this.accountId = accountId;
    this.transport = transport;
    this.store = store ?? null;
    this.ledger = new OfflineLedger(store);
    this.privateKeyPem = options.privateKeyPem;
  }

  /** The reward account the coordinator resolves for this agent (signed as requesterAccountId). */
  setAccountId(accountId: string): void {
    if (accountId) this.accountId = accountId;
  }

  setOwnTokenHash(hash: string): void {
    this.ownTokenHash = hash;
  }

  isOffline(): boolean {
    return this.offline;
  }

  setOffline(offline: boolean): void {
    this.offline = offline;
    if (offline) {
      this.transport.startScanning();
    } else {
      this.transport.stopScanning();
    }
  }

  refreshPeers(): void {
    const discovered = this.transport.discoveredPeers();
    const trustMap = new Map<string, { success: number; fail: number }>();
    if (this.store) {
      for (const row of this.store.listBLEPeers()) {
        trustMap.set(row.agentId, { success: row.taskSuccessCount, fail: row.taskFailCount });
      }
    }
    for (const peer of discovered) {
      const trust = trustMap.get(peer.agentId);
      if (trust) {
        peer.taskSuccessCount = trust.success;
        peer.taskFailCount = trust.fail;
      }
      this.router.updatePeer(peer);
    }
    this.router.evictStale();
  }

  async routeTask(
    request: BLETaskRequest,
    requiredModelSize: number,
    maxRetries = 3
  ): Promise<BLETaskResponse | null> {
    this.refreshPeers();
    const peers = this.router.selectBestPeers(maxRetries, this.ownTokenHash || undefined);
    if (peers.length === 0) return null;

    for (const peer of peers) {
      const response = await this.transport.sendTaskRequest(peer.agentId, request);

      if (response.status === "completed") {
        await this.settleCredits(request, response, peer);
        return response;
      }
      // Failed — try next peer
    }
    return null;
  }

  /**
   * #63 co-sign step: build the final transaction, have the provider sign its canonical bytes,
   * add our own signature, and only then write it to the offline ledger. Returns the recorded
   * transaction, or null when nothing was recorded (no key, zero credits, provider refused).
   */
  private async settleCredits(
    request: BLETaskRequest,
    response: BLETaskResponse,
    peer: { agentId: string; accountId: string; modelParamSize: number }
  ): Promise<BLECreditTransaction | null> {
    if (!this.privateKeyPem) {
      console.warn(`[BLE] no signing key; not recording credits for ${request.requestId}`);
      return null;
    }
    const cpuMillis = toMillis(response.cpuSeconds);
    const creditMillis = bleCreditMillis(cpuMillis, peer.modelParamSize);
    if (!Number.isSafeInteger(cpuMillis) || cpuMillis < 0 || creditMillis <= 0) return null;
    const fields: BleTxV3Fields = {
      txId: randomUUID(),
      requesterId: this.agentId,
      requesterAccountId: this.accountId,
      providerId: response.providerId,
      providerAccountId: response.providerAccountId || peer.accountId,
      taskHash: createHash("sha256").update(request.task).digest("hex"),
      cpuMillis,
      creditMillis
    };
    let requesterSignature: string;
    try {
      requesterSignature = signBleTxV3(fields, this.privateKeyPem);
    } catch (e) {
      console.warn(`[BLE] cannot sign credits for ${request.requestId}: ${String(e)}`);
      return null;
    }
    const cosign = await this.transport.sendCosignRequest(peer.agentId, { type: "cosign", requestId: request.requestId, tx: fields });
    if (cosign.status !== "signed" || cosign.txId !== fields.txId || !cosign.providerSignature) {
      console.warn(`[BLE] provider ${peer.agentId} did not co-sign ${request.requestId}: ${cosign.reason ?? cosign.status}`);
      return null;
    }
    const tx: BLECreditTransaction = {
      txId: fields.txId,
      requesterId: fields.requesterId,
      providerId: fields.providerId,
      requesterAccountId: fields.requesterAccountId,
      providerAccountId: fields.providerAccountId,
      credits: fields.creditMillis / 1000,
      cpuSeconds: fields.cpuMillis / 1000,
      taskHash: fields.taskHash,
      timestamp: Date.now(),
      requesterSignature,
      providerSignature: cosign.providerSignature
    };
    return this.ledger.record(tx) ? tx : null;
  }

  pendingTransactions(): BLECreditTransaction[] {
    return this.ledger.pending();
  }

  exportSyncBatch(): BLECreditTransaction[] {
    return this.ledger.exportBatch();
  }

  markSynced(txIds: string[]): void {
    this.ledger.markSynced(txIds);
  }

  async sendDirectToPeer(
    peerId: string,
    request: BLETaskRequest
  ): Promise<BLETaskResponse> {
    return this.transport.sendTaskRequest(peerId, request);
  }

  onModelSwapStart(): void {
    this.transport.updateAdvertisement({ currentLoad: -1 });
  }

  onModelChanged(model: string, paramSize: number): void {
    this.transport.updateAdvertisement({
      model,
      modelParamSize: paramSize,
      currentLoad: 0,
    });
  }
}
