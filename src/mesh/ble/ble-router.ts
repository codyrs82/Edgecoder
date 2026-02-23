import { BLEPeerEntry } from "../../common/types.js";

const EVICTION_MS = 60_000;
const COST_THRESHOLD = 200;

export class BLERouter {
  private readonly peers = new Map<string, BLEPeerEntry>();

  updatePeer(peer: BLEPeerEntry): void {
    this.peers.set(peer.agentId, peer);
  }

  removePeer(agentId: string): void {
    this.peers.delete(agentId);
  }

  listPeers(): BLEPeerEntry[] {
    return [...this.peers.values()];
  }

  evictStale(): void {
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeenMs > EVICTION_MS) {
        this.peers.delete(id);
      }
    }
  }

  computeCost(peer: BLEPeerEntry, _requiredModelSize?: number): number {
    // Graduated model preference: smaller models cost more but are never rejected
    const modelPreferencePenalty = Math.max(0, (7 - peer.modelParamSize) * 8);
    const loadPenalty = peer.currentLoad * 20;
    const batteryPenalty = peer.deviceType === "phone"
      ? (100 - peer.batteryPct) * 0.5
      : 0;
    const signalPenalty = Math.min(30, Math.max(0, (-peer.rssi - 30) * 0.5));
    return modelPreferencePenalty + loadPenalty + batteryPenalty + signalPenalty;
  }

  selectBestPeer(requiredModelSize: number): BLEPeerEntry | null {
    this.evictStale();
    let best: BLEPeerEntry | null = null;
    let bestCost = COST_THRESHOLD;
    for (const peer of this.peers.values()) {
      const cost = this.computeCost(peer, requiredModelSize);
      if (cost < bestCost) {
        bestCost = cost;
        best = peer;
      }
    }
    return best;
  }
}
