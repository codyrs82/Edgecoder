import { BLEPeerEntry } from "../../common/types.js";
import { ConnectionQualityMonitor } from "./connection-quality.js";

const EVICTION_MS = 60_000;
const COST_THRESHOLD = 200;

export interface NetworkHealthStats {
  totalPeers: number;
  activePeers: number;
  blacklistedPeers: number;
  avgConnectionScore: number;
}

export class BLERouter {
  private readonly peers = new Map<string, BLEPeerEntry>();
  private readonly qualityMonitor: ConnectionQualityMonitor;

  constructor(qualityMonitor?: ConnectionQualityMonitor) {
    this.qualityMonitor = qualityMonitor ?? new ConnectionQualityMonitor();
  }

  getQualityMonitor(): ConnectionQualityMonitor {
    return this.qualityMonitor;
  }

  updatePeer(peer: BLEPeerEntry): void {
    this.peers.set(peer.agentId, peer);
    this.qualityMonitor.recordRssi(peer.agentId, peer.rssi);
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
    const totalTasks = (peer.taskSuccessCount ?? 0) + (peer.taskFailCount ?? 0);
    const failRate = totalTasks > 0 ? (peer.taskFailCount ?? 0) / totalTasks : 0;
    const reliabilityPenalty = failRate * 60;

    // Augment with connection quality data: higher quality score reduces cost
    const qualityScore = this.qualityMonitor.getConnectionScore(peer.agentId);
    // qualityScore is 0-100; invert to penalty: 100 = 0 penalty, 0 = 30 penalty
    const qualityPenalty = Math.max(0, (100 - qualityScore) * 0.3);

    return modelPreferencePenalty + loadPenalty + batteryPenalty + signalPenalty + reliabilityPenalty + qualityPenalty;
  }

  selectBestPeers(limit: number, ownTokenHash?: string): BLEPeerEntry[] {
    this.evictStale();
    const candidates: { peer: BLEPeerEntry; cost: number }[] = [];
    for (const peer of this.peers.values()) {
      if (ownTokenHash && peer.meshTokenHash !== ownTokenHash) continue;
      // Skip blacklisted peers
      if (this.qualityMonitor.shouldBlacklist(peer.agentId)) continue;
      const cost = this.computeCost(peer);
      if (cost < COST_THRESHOLD) {
        candidates.push({ peer, cost });
      }
    }
    candidates.sort((a, b) => a.cost - b.cost);
    return candidates.slice(0, limit).map(c => c.peer);
  }

  selectBestPeer(requiredModelSize: number, ownTokenHash?: string): BLEPeerEntry | null {
    return this.selectBestPeers(1, ownTokenHash)[0] ?? null;
  }

  getNetworkHealth(): NetworkHealthStats {
    this.evictStale();
    const allPeers = [...this.peers.values()];
    let totalScore = 0;
    let blacklisted = 0;

    for (const peer of allPeers) {
      const score = this.qualityMonitor.getConnectionScore(peer.agentId);
      totalScore += score;
      if (this.qualityMonitor.shouldBlacklist(peer.agentId)) {
        blacklisted++;
      }
    }

    return {
      totalPeers: allPeers.length,
      activePeers: allPeers.length - blacklisted,
      blacklistedPeers: blacklisted,
      avgConnectionScore: allPeers.length > 0 ? Math.round(totalScore / allPeers.length) : 0,
    };
  }
}
