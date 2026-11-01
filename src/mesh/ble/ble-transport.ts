// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { BLETaskRequest, BLETaskResponse, BLEPeerEntry } from "../../common/types.js";
import { BLE_COSIGN_MSG_TYPE, type BleCoSignRequest, type BleCoSignResponse } from "./ble-cosign.js";

export interface BLEAdvertisement {
  agentId: string;
  model: string;
  modelParamSize: number;
  memoryMB: number;
  batteryPct: number;
  currentLoad: number;
  deviceType: "phone" | "laptop" | "workstation";
  meshTokenHash?: string;
}

export type TaskRequestHandler = (req: BLETaskRequest) => Promise<BLETaskResponse>;
/** #63: provider-side handler for the co-sign step (see ble-cosign.ts). */
export type CoSignRequestHandler = (req: BleCoSignRequest) => Promise<BleCoSignResponse> | BleCoSignResponse;

export interface BLETransport {
  startAdvertising(advertisement: BLEAdvertisement): void;
  stopAdvertising(): void;
  startScanning(): void;
  stopScanning(): void;
  discoveredPeers(): BLEPeerEntry[];
  sendTaskRequest(peerId: string, request: BLETaskRequest): Promise<BLETaskResponse>;
  onTaskRequest(handler: TaskRequestHandler): void;
  /** #63: send the final transaction to the provider and get its signature back. */
  sendCoSignRequest(peerId: string, request: BleCoSignRequest): Promise<BleCoSignResponse>;
  onCoSignRequest(handler: CoSignRequestHandler): void;
  updateAdvertisement(update: Partial<BLEAdvertisement>): void;
  currentAdvertisement(): BLEAdvertisement | null;
}

export class MockBLETransport implements BLETransport {
  private advertisement: BLEAdvertisement | null = null;
  private scanning = false;
  private handler: TaskRequestHandler | null = null;
  private coSignHandler: CoSignRequestHandler | null = null;

  constructor(
    private readonly localId: string,
    private readonly network: Map<string, MockBLETransport>
  ) {
    this.network.set(localId, this);
  }

  startAdvertising(advertisement: BLEAdvertisement): void {
    this.advertisement = advertisement;
  }

  stopAdvertising(): void {
    this.advertisement = null;
  }

  startScanning(): void {
    this.scanning = true;
  }

  stopScanning(): void {
    this.scanning = false;
  }

  discoveredPeers(): BLEPeerEntry[] {
    const peers: BLEPeerEntry[] = [];
    for (const [id, transport] of this.network) {
      if (id === this.localId || !transport.advertisement) continue;
      const ad = transport.advertisement;
      peers.push({
        agentId: ad.agentId,
        meshTokenHash: ad.meshTokenHash ?? "",
        accountId: ad.agentId,
        model: ad.model,
        modelParamSize: ad.modelParamSize,
        memoryMB: ad.memoryMB,
        batteryPct: ad.batteryPct,
        currentLoad: ad.currentLoad,
        deviceType: ad.deviceType,
        rssi: -50,
        lastSeenMs: Date.now()
      });
    }
    return peers;
  }

  onTaskRequest(handler: TaskRequestHandler): void {
    this.handler = handler;
  }

  async sendTaskRequest(peerId: string, request: BLETaskRequest): Promise<BLETaskResponse> {
    const peer = this.network.get(peerId);
    if (!peer || !peer.handler) {
      return {
        requestId: request.requestId,
        providerId: peerId,
        status: "failed",
        cpuSeconds: 0,
        providerSignature: ""
      };
    }
    return peer.handler(request);
  }

  onCoSignRequest(handler: CoSignRequestHandler): void {
    this.coSignHandler = handler;
  }

  async sendCoSignRequest(peerId: string, request: BleCoSignRequest): Promise<BleCoSignResponse> {
    const peer = this.network.get(peerId);
    if (!peer || !peer.coSignHandler) {
      return { type: BLE_COSIGN_MSG_TYPE, txId: request.tx.txId, status: "rejected", reason: "no_cosign_handler" };
    }
    // Round-trip through JSON like the real GATT transport does.
    const wire = JSON.parse(JSON.stringify(request)) as BleCoSignRequest;
    return JSON.parse(JSON.stringify(await peer.coSignHandler(wire))) as BleCoSignResponse;
  }

  updateAdvertisement(update: Partial<BLEAdvertisement>): void {
    if (this.advertisement) {
      this.advertisement = { ...this.advertisement, ...update };
    }
  }

  currentAdvertisement(): BLEAdvertisement | null {
    return this.advertisement ?? null;
  }
}
