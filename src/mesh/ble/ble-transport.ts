// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { BLETaskRequest, BLETaskResponse, BLEPeerEntry, BLECosignRequest, BLECosignResponse } from "../../common/types.js";

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
export type CosignRequestHandler = (req: BLECosignRequest) => Promise<BLECosignResponse> | BLECosignResponse;

/** A co-sign answer for when the peer cannot be reached or has no co-sign handler. */
export function cosignUnavailable(req: BLECosignRequest, reason = "unavailable"): BLECosignResponse {
  return {
    type: "cosign_result",
    requestId: req.requestId,
    txId: req.tx?.txId ?? "",
    status: "rejected",
    providerSignature: "",
    reason
  };
}

export interface BLETransport {
  startAdvertising(advertisement: BLEAdvertisement): void;
  stopAdvertising(): void;
  startScanning(): void;
  stopScanning(): void;
  discoveredPeers(): BLEPeerEntry[];
  sendTaskRequest(peerId: string, request: BLETaskRequest): Promise<BLETaskResponse>;
  onTaskRequest(handler: TaskRequestHandler): void;
  /** #63: send the final transaction to the provider for its signature. */
  sendCosignRequest(peerId: string, request: BLECosignRequest): Promise<BLECosignResponse>;
  onCosignRequest(handler: CosignRequestHandler): void;
  updateAdvertisement(update: Partial<BLEAdvertisement>): void;
  currentAdvertisement(): BLEAdvertisement | null;
}

export class MockBLETransport implements BLETransport {
  private advertisement: BLEAdvertisement | null = null;
  private scanning = false;
  private handler: TaskRequestHandler | null = null;
  private cosignHandler: CosignRequestHandler | null = null;

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

  onCosignRequest(handler: CosignRequestHandler): void {
    this.cosignHandler = handler;
  }

  async sendCosignRequest(peerId: string, request: BLECosignRequest): Promise<BLECosignResponse> {
    const peer = this.network.get(peerId);
    if (!peer || !peer.cosignHandler) return cosignUnavailable(request);
    // Round-trip through JSON like the real transport, so nothing but the wire format crosses.
    return JSON.parse(JSON.stringify(await peer.cosignHandler(JSON.parse(JSON.stringify(request)))));
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
