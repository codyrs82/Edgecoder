// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID, createHash } from "node:crypto";
import { BLETaskRequest, BLETaskResponse, BLECreditTransaction } from "../../common/types.js";
import { baseRatePerSecond } from "../../credits/pricing.js";
import { BLETransport } from "./ble-transport.js";
import { BLERouter } from "./ble-router.js";
import { OfflineLedger } from "./offline-ledger.js";
import type { SQLiteStore } from "../../db/sqlite-store.js";

/** Maps model param size to a credit quality multiplier */
export function modelQualityMultiplier(paramSize: number): number {
  if (paramSize >= 7) return 1.0;
  if (paramSize >= 3) return 0.7;
  if (paramSize >= 1.5) return 0.5;
  return 0.3;
}

export class BLEMeshManager {
  private offline = false;
  private readonly router = new BLERouter();
  private readonly ledger: OfflineLedger;
  private readonly transport: BLETransport;
  private readonly store: SQLiteStore | null;
  private readonly agentId: string;
  private readonly accountId: string;
  private ownTokenHash = "";

  constructor(agentId: string, accountId: string, transport: BLETransport, store?: SQLiteStore) {
    this.agentId = agentId;
    this.accountId = accountId;
    this.transport = transport;
    this.store = store ?? null;
    this.ledger = new OfflineLedger(store);
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
        const taskHash = createHash("sha256").update(request.task).digest("hex");
        const qualityMul = modelQualityMultiplier(peer.modelParamSize);
        const credits = response.cpuSeconds * baseRatePerSecond("cpu") * qualityMul;
        const tx: BLECreditTransaction = {
          txId: randomUUID(),
          requesterId: this.agentId,
          providerId: response.providerId,
          requesterAccountId: this.accountId,
          providerAccountId: peer.accountId,
          credits: Number(credits.toFixed(3)),
          cpuSeconds: response.cpuSeconds,
          taskHash,
          timestamp: Date.now(),
          requesterSignature: request.requesterSignature,
          providerSignature: response.providerSignature
        };
        this.ledger.record(tx);
        return response;
      }
      // Failed — try next peer
    }
    return null;
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
