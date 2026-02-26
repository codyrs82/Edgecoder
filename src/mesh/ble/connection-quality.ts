// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

export interface RssiSample {
  rssi: number;
  timestampMs: number;
}

export interface PeerConnectionStats {
  peerId: string;
  rssiHistory: RssiSample[];
  connectionDropCount: number;
  lastDropTimestampMs: number;
  avgLatencyMs: number;
  taskSuccessRate: number;
  consecutiveFailures: number;
}

export type RssiTrend = "improving" | "stable" | "degrading";

const MAX_RSSI_HISTORY = 60;
const RSSI_TREND_WINDOW = 20;
const BLACKLIST_CONSECUTIVE_FAILURES = 5;
const BLACKLIST_SCORE_THRESHOLD = 10;

function defaultStats(peerId: string): PeerConnectionStats {
  return {
    peerId,
    rssiHistory: [],
    connectionDropCount: 0,
    lastDropTimestampMs: 0,
    avgLatencyMs: 0,
    taskSuccessRate: 1,
    consecutiveFailures: 0,
  };
}

/**
 * Computes the slope of a simple linear regression on (index, value) pairs.
 * Returns slope in dBm-per-sample units.
 */
function linearRegressionSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumXX += i * i;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

export class ConnectionQualityMonitor {
  private readonly stats = new Map<string, PeerConnectionStats>();
  private totalTaskCount = new Map<string, number>();

  private getOrCreate(peerId: string): PeerConnectionStats {
    let s = this.stats.get(peerId);
    if (!s) {
      s = defaultStats(peerId);
      this.stats.set(peerId, s);
      this.totalTaskCount.set(peerId, 0);
    }
    return s;
  }

  recordRssi(peerId: string, rssi: number): void {
    const s = this.getOrCreate(peerId);
    s.rssiHistory.push({ rssi, timestampMs: Date.now() });
    if (s.rssiHistory.length > MAX_RSSI_HISTORY) {
      s.rssiHistory = s.rssiHistory.slice(s.rssiHistory.length - MAX_RSSI_HISTORY);
    }
  }

  recordConnectionDrop(peerId: string): void {
    const s = this.getOrCreate(peerId);
    s.connectionDropCount++;
    s.lastDropTimestampMs = Date.now();
  }

  recordTaskResult(peerId: string, success: boolean, latencyMs: number): void {
    const s = this.getOrCreate(peerId);
    const total = (this.totalTaskCount.get(peerId) ?? 0) + 1;
    this.totalTaskCount.set(peerId, total);

    // Running average for latency
    s.avgLatencyMs = s.avgLatencyMs + (latencyMs - s.avgLatencyMs) / total;

    // Running success rate
    if (success) {
      s.taskSuccessRate = s.taskSuccessRate + (1 - s.taskSuccessRate) / total;
      s.consecutiveFailures = 0;
    } else {
      s.taskSuccessRate = s.taskSuccessRate + (0 - s.taskSuccessRate) / total;
      s.consecutiveFailures++;
    }
  }

  getStats(peerId: string): PeerConnectionStats | undefined {
    return this.stats.get(peerId);
  }

  /**
   * Returns a 0-100 connection score based on:
   *   - RSSI trend (25 points)
   *   - Connection drop rate (25 points)
   *   - Task success rate (25 points)
   *   - Average latency (25 points)
   */
  getConnectionScore(peerId: string): number {
    const s = this.stats.get(peerId);
    if (!s) return 50; // unknown peer gets a neutral score

    // RSSI component (25 pts): average RSSI mapped from [-100, -30] to [0, 25]
    let rssiScore = 25;
    if (s.rssiHistory.length > 0) {
      const avgRssi =
        s.rssiHistory.reduce((sum, sample) => sum + sample.rssi, 0) /
        s.rssiHistory.length;
      // -30 dBm or better = perfect, -100 dBm or worse = 0
      rssiScore = Math.max(0, Math.min(25, ((avgRssi + 100) / 70) * 25));
    }

    // Drop rate component (25 pts): fewer drops = higher score
    // 0 drops = 25, 10+ drops = 0
    const dropScore = Math.max(0, 25 - s.connectionDropCount * 2.5);

    // Success rate component (25 pts)
    const successScore = s.taskSuccessRate * 25;

    // Latency component (25 pts): 0ms = 25, 5000ms+ = 0
    const latencyScore = Math.max(0, 25 - (s.avgLatencyMs / 5000) * 25);

    return Math.round(rssiScore + dropScore + successScore + latencyScore);
  }

  shouldBlacklist(peerId: string): boolean {
    const s = this.stats.get(peerId);
    if (!s) return false;
    if (s.consecutiveFailures >= BLACKLIST_CONSECUTIVE_FAILURES) return true;
    if (this.getConnectionScore(peerId) < BLACKLIST_SCORE_THRESHOLD) return true;
    return false;
  }

  getRssiTrend(peerId: string): RssiTrend {
    const s = this.stats.get(peerId);
    if (!s || s.rssiHistory.length < 2) return "stable";

    const window = s.rssiHistory.slice(-RSSI_TREND_WINDOW);
    const values = window.map((sample) => sample.rssi);
    const slope = linearRegressionSlope(values);

    // Threshold: if slope > 0.3 dBm/sample, improving; < -0.3, degrading
    if (slope > 0.3) return "improving";
    if (slope < -0.3) return "degrading";
    return "stable";
  }
}
