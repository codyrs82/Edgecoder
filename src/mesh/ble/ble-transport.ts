import { BLETaskRequest, BLETaskResponse, BLEPeerEntry } from "../../common/types.js";

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

export interface BLETransport {
  startAdvertising(advertisement: BLEAdvertisement): void;
  stopAdvertising(): void;
  startScanning(): void;
  stopScanning(): void;
  discoveredPeers(): BLEPeerEntry[];
  sendTaskRequest(peerId: string, request: BLETaskRequest): Promise<BLETaskResponse>;
  onTaskRequest(handler: TaskRequestHandler): void;
  updateAdvertisement(update: Partial<BLEAdvertisement>): void;
  currentAdvertisement(): BLEAdvertisement | null;
}

export class MockBLETransport implements BLETransport {
  private advertisement: BLEAdvertisement | null = null;
  private scanning = false;
  private handler: TaskRequestHandler | null = null;

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

  updateAdvertisement(update: Partial<BLEAdvertisement>): void {
    if (this.advertisement) {
      this.advertisement = { ...this.advertisement, ...update };
    }
  }

  currentAdvertisement(): BLEAdvertisement | null {
    return this.advertisement ?? null;
  }
}
