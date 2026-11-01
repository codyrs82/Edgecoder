// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID, createHash } from "node:crypto";
import { BLETaskRequest, BLETaskResponse, BLECreditTransaction } from "../../common/types.js";
import { bleTxV3FieldsFromTx, fromMillis, toMillis, type BleTxV3Fields } from "../../credits/ble-tx-canonical.js";
import { BLETransport } from "./ble-transport.js";
import { BLERouter } from "./ble-router.js";
import { BLE_COSIGN_MSG_TYPE, type BleCoSignResponse } from "./ble-cosign.js";
import { computeBleCredits, modelQualityMultiplier } from "./ble-pricing.js";
import { OfflineLedger, signBleTransactionV3 } from "./offline-ledger.js";
import type { SQLiteStore } from "../../db/sqlite-store.js";

export { modelQualityMultiplier, computeBleCredits };

export interface BLEMeshManagerOptions {
  /**
   * #63: this agent's ed25519 private key (PEM). Required to co-sign offline
   * credit transactions; without it tasks still route but nothing is written to
   * the offline ledger (the coordinator would reject it anyway).
   */
  privateKeyPem?: string;
  /** Called when a completed task could not be turned into a co-signed transaction. */
  onCoSignFailure?: (info: { peerId: string; requestId: string; reason: string }) => void;
}

export class BLEMeshManager {
  private offline = false;
  private readonly router = new BLERouter();
  private readonly ledger: OfflineLedger;
  private readonly transport: BLETransport;
  private readonly store: SQLiteStore | null;
  private readonly agentId: string;
  private readonly accountId: string;
  private readonly options: BLEMeshManagerOptions;
  private ownTokenHash = "";
  private warnedNoKey = false;

  constructor(agentId: string, accountId: string, transport: BLETransport, store?: SQLiteStore, options: BLEMeshManagerOptions = {}) {
    this.agentId = agentId;
    this.accountId = accountId;
    this.transport = transport;
    this.store = store ?? null;
    this.options = options;
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
        await this.settleOffline({
          peerId: peer.agentId,
          peerAccountId: peer.accountId,
          peerModelParamSize: peer.modelParamSize,
          requestId: request.requestId,
          taskHash,
          response
        });
        return response;
      }
      // Failed — try next peer
    }
    return null;
  }

  /**
   * #63 co-sign step: build the final tx, get the provider's signature over the
   * canonical v3 bytes, add ours, and only then record it in the offline ledger.
   */
  private async settleOffline(args: {
    peerId: string;
    peerAccountId: string;
    peerModelParamSize: number;
    requestId: string;
    taskHash: string;
    response: BLETaskResponse;
  }): Promise<void> {
    const fail = (reason: string) => {
      this.options.onCoSignFailure?.({ peerId: args.peerId, requestId: args.requestId, reason });
    };
    const privateKeyPem = this.options.privateKeyPem;
    if (!privateKeyPem) {
      if (!this.warnedNoKey) {
        this.warnedNoKey = true;
        console.warn("[BLE] no signing key configured: completed BLE tasks will not be settled offline (#63)");
      }
      fail("no_signing_key");
      return;
    }

    const credits = computeBleCredits(args.response.cpuSeconds, args.peerModelParamSize);
    let fields: BleTxV3Fields;
    try {
      fields = bleTxV3FieldsFromTx({
        txId: randomUUID(),
        requesterId: this.agentId,
        requesterAccountId: this.accountId,
        providerId: args.response.providerId,
        providerAccountId: args.peerAccountId || args.response.providerId,
        taskHash: args.taskHash,
        cpuSeconds: args.response.cpuSeconds,
        credits
      });
    } catch (e) {
      fail(`invalid_payload: ${String(e)}`);
      return;
    }
    const timestamp = Date.now();

    let cosign: BleCoSignResponse;
    try {
      cosign = await this.transport.sendCoSignRequest(args.peerId, { type: BLE_COSIGN_MSG_TYPE, tx: { ...fields, timestamp } });
    } catch (e) {
      fail(`transport_error: ${String(e)}`);
      return;
    }
    if (cosign.status !== "signed" || !cosign.providerSignature || cosign.txId !== fields.txId) {
      fail(cosign.reason ?? "rejected");
      return;
    }

    const tx: BLECreditTransaction = {
      txId: fields.txId,
      requesterId: fields.requesterId,
      providerId: fields.providerId,
      requesterAccountId: fields.requesterAccountId,
      providerAccountId: fields.providerAccountId,
      credits: fromMillis(fields.creditMillis),
      cpuSeconds: fromMillis(fields.cpuMillis),
      taskHash: fields.taskHash,
      timestamp,
      requesterSignature: signBleTransactionV3(fields, privateKeyPem),
      providerSignature: cosign.providerSignature
    };
    this.ledger.record(tx);
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

/** Milli-unit helpers re-exported for callers building transactions by hand. */
export { toMillis, fromMillis };
