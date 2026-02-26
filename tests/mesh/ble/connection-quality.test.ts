import { describe, it, expect } from "vitest";
import { ConnectionQualityMonitor } from "../../../src/mesh/ble/connection-quality.js";

describe("ConnectionQualityMonitor", () => {
  describe("recordRssi", () => {
    it("records RSSI samples for a peer", () => {
      const monitor = new ConnectionQualityMonitor();
      monitor.recordRssi("peer-1", -50);
      monitor.recordRssi("peer-1", -55);
      const stats = monitor.getStats("peer-1");
      expect(stats).toBeDefined();
      expect(stats!.rssiHistory).toHaveLength(2);
      expect(stats!.rssiHistory[0].rssi).toBe(-50);
      expect(stats!.rssiHistory[1].rssi).toBe(-55);
    });

    it("trims RSSI history to sliding window of 60 entries", () => {
      const monitor = new ConnectionQualityMonitor();
      for (let i = 0; i < 80; i++) {
        monitor.recordRssi("peer-1", -40 - i);
      }
      const stats = monitor.getStats("peer-1");
      expect(stats!.rssiHistory).toHaveLength(60);
      // Should keep the most recent 60 entries (indices 20..79)
      expect(stats!.rssiHistory[0].rssi).toBe(-60);
      expect(stats!.rssiHistory[59].rssi).toBe(-119);
    });

    it("tracks separate histories per peer", () => {
      const monitor = new ConnectionQualityMonitor();
      monitor.recordRssi("peer-a", -50);
      monitor.recordRssi("peer-b", -70);
      expect(monitor.getStats("peer-a")!.rssiHistory).toHaveLength(1);
      expect(monitor.getStats("peer-b")!.rssiHistory).toHaveLength(1);
      expect(monitor.getStats("peer-a")!.rssiHistory[0].rssi).toBe(-50);
      expect(monitor.getStats("peer-b")!.rssiHistory[0].rssi).toBe(-70);
    });
  });

  describe("recordConnectionDrop", () => {
    it("increments drop count and sets timestamp", () => {
      const monitor = new ConnectionQualityMonitor();
      monitor.recordConnectionDrop("peer-1");
      const stats = monitor.getStats("peer-1");
      expect(stats!.connectionDropCount).toBe(1);
      expect(stats!.lastDropTimestampMs).toBeGreaterThan(0);
    });

    it("tracks multiple drops", () => {
      const monitor = new ConnectionQualityMonitor();
      monitor.recordConnectionDrop("peer-1");
      monitor.recordConnectionDrop("peer-1");
      monitor.recordConnectionDrop("peer-1");
      expect(monitor.getStats("peer-1")!.connectionDropCount).toBe(3);
    });
  });

  describe("recordTaskResult", () => {
    it("updates success rate for successful tasks", () => {
      const monitor = new ConnectionQualityMonitor();
      monitor.recordTaskResult("peer-1", true, 100);
      monitor.recordTaskResult("peer-1", true, 200);
      const stats = monitor.getStats("peer-1");
      expect(stats!.taskSuccessRate).toBe(1);
      expect(stats!.avgLatencyMs).toBe(150);
    });

    it("updates success rate for mixed results", () => {
      const monitor = new ConnectionQualityMonitor();
      monitor.recordTaskResult("peer-1", true, 100);
      monitor.recordTaskResult("peer-1", false, 200);
      const stats = monitor.getStats("peer-1");
      expect(stats!.taskSuccessRate).toBe(0.5);
    });

    it("tracks consecutive failures", () => {
      const monitor = new ConnectionQualityMonitor();
      monitor.recordTaskResult("peer-1", false, 100);
      monitor.recordTaskResult("peer-1", false, 100);
      monitor.recordTaskResult("peer-1", false, 100);
      expect(monitor.getStats("peer-1")!.consecutiveFailures).toBe(3);
    });

    it("resets consecutive failures on success", () => {
      const monitor = new ConnectionQualityMonitor();
      monitor.recordTaskResult("peer-1", false, 100);
      monitor.recordTaskResult("peer-1", false, 100);
      monitor.recordTaskResult("peer-1", true, 100);
      expect(monitor.getStats("peer-1")!.consecutiveFailures).toBe(0);
    });

    it("computes running average latency", () => {
      const monitor = new ConnectionQualityMonitor();
      monitor.recordTaskResult("peer-1", true, 100);
      monitor.recordTaskResult("peer-1", true, 300);
      monitor.recordTaskResult("peer-1", true, 200);
      const stats = monitor.getStats("peer-1");
      expect(stats!.avgLatencyMs).toBeCloseTo(200, 0);
    });
  });

  describe("getConnectionScore", () => {
    it("returns 50 for unknown peer", () => {
      const monitor = new ConnectionQualityMonitor();
      expect(monitor.getConnectionScore("unknown")).toBe(50);
    });

    it("returns high score for healthy peer", () => {
      const monitor = new ConnectionQualityMonitor();
      // Good RSSI
      for (let i = 0; i < 10; i++) {
        monitor.recordRssi("peer-1", -35);
      }
      // Good task results
      for (let i = 0; i < 10; i++) {
        monitor.recordTaskResult("peer-1", true, 50);
      }
      const score = monitor.getConnectionScore("peer-1");
      expect(score).toBeGreaterThan(80);
    });

    it("returns low score for unhealthy peer", () => {
      const monitor = new ConnectionQualityMonitor();
      // Bad RSSI
      for (let i = 0; i < 10; i++) {
        monitor.recordRssi("peer-1", -95);
      }
      // Many drops
      for (let i = 0; i < 10; i++) {
        monitor.recordConnectionDrop("peer-1");
      }
      // Bad task results
      for (let i = 0; i < 10; i++) {
        monitor.recordTaskResult("peer-1", false, 4000);
      }
      const score = monitor.getConnectionScore("peer-1");
      expect(score).toBeLessThan(20);
    });

    it("score is between 0 and 100", () => {
      const monitor = new ConnectionQualityMonitor();
      monitor.recordRssi("peer-1", -50);
      monitor.recordTaskResult("peer-1", true, 200);
      const score = monitor.getConnectionScore("peer-1");
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });

    it("penalizes high latency", () => {
      const monitor = new ConnectionQualityMonitor();
      // Same setup but different latencies
      monitor.recordRssi("peer-fast", -50);
      monitor.recordTaskResult("peer-fast", true, 100);

      monitor.recordRssi("peer-slow", -50);
      monitor.recordTaskResult("peer-slow", true, 4500);

      expect(monitor.getConnectionScore("peer-fast")).toBeGreaterThan(
        monitor.getConnectionScore("peer-slow")
      );
    });

    it("penalizes connection drops", () => {
      const monitor = new ConnectionQualityMonitor();
      monitor.recordRssi("stable", -50);
      monitor.recordTaskResult("stable", true, 100);

      monitor.recordRssi("unstable", -50);
      monitor.recordTaskResult("unstable", true, 100);
      for (let i = 0; i < 8; i++) {
        monitor.recordConnectionDrop("unstable");
      }

      expect(monitor.getConnectionScore("stable")).toBeGreaterThan(
        monitor.getConnectionScore("unstable")
      );
    });
  });

  describe("shouldBlacklist", () => {
    it("returns false for unknown peer", () => {
      const monitor = new ConnectionQualityMonitor();
      expect(monitor.shouldBlacklist("unknown")).toBe(false);
    });

    it("returns true after 5 consecutive failures", () => {
      const monitor = new ConnectionQualityMonitor();
      for (let i = 0; i < 5; i++) {
        monitor.recordTaskResult("peer-1", false, 100);
      }
      expect(monitor.shouldBlacklist("peer-1")).toBe(true);
    });

    it("returns false after 4 consecutive failures", () => {
      const monitor = new ConnectionQualityMonitor();
      for (let i = 0; i < 4; i++) {
        monitor.recordTaskResult("peer-1", false, 100);
      }
      expect(monitor.shouldBlacklist("peer-1")).toBe(false);
    });

    it("returns false when failures are not consecutive", () => {
      const monitor = new ConnectionQualityMonitor();
      monitor.recordTaskResult("peer-1", false, 100);
      monitor.recordTaskResult("peer-1", false, 100);
      monitor.recordTaskResult("peer-1", true, 100);
      monitor.recordTaskResult("peer-1", false, 100);
      monitor.recordTaskResult("peer-1", false, 100);
      expect(monitor.shouldBlacklist("peer-1")).toBe(false);
    });

    it("returns true when score drops below 10", () => {
      const monitor = new ConnectionQualityMonitor();
      // Extremely bad conditions
      for (let i = 0; i < 10; i++) {
        monitor.recordRssi("peer-1", -100);
      }
      for (let i = 0; i < 10; i++) {
        monitor.recordConnectionDrop("peer-1");
      }
      for (let i = 0; i < 4; i++) {
        monitor.recordTaskResult("peer-1", false, 5000);
      }
      expect(monitor.shouldBlacklist("peer-1")).toBe(true);
    });
  });

  describe("getRssiTrend", () => {
    it("returns stable for unknown peer", () => {
      const monitor = new ConnectionQualityMonitor();
      expect(monitor.getRssiTrend("unknown")).toBe("stable");
    });

    it("returns stable with single data point", () => {
      const monitor = new ConnectionQualityMonitor();
      monitor.recordRssi("peer-1", -50);
      expect(monitor.getRssiTrend("peer-1")).toBe("stable");
    });

    it("detects improving RSSI trend", () => {
      const monitor = new ConnectionQualityMonitor();
      // Simulate RSSI improving over time (getting less negative)
      for (let i = 0; i < 20; i++) {
        monitor.recordRssi("peer-1", -80 + i * 2);
      }
      expect(monitor.getRssiTrend("peer-1")).toBe("improving");
    });

    it("detects degrading RSSI trend", () => {
      const monitor = new ConnectionQualityMonitor();
      // Simulate RSSI degrading over time (getting more negative)
      for (let i = 0; i < 20; i++) {
        monitor.recordRssi("peer-1", -40 - i * 2);
      }
      expect(monitor.getRssiTrend("peer-1")).toBe("degrading");
    });

    it("detects stable RSSI with minor fluctuation", () => {
      const monitor = new ConnectionQualityMonitor();
      // Stable RSSI hovering around -50
      for (let i = 0; i < 20; i++) {
        monitor.recordRssi("peer-1", -50 + (i % 2 === 0 ? 1 : -1));
      }
      expect(monitor.getRssiTrend("peer-1")).toBe("stable");
    });

    it("uses only last 20 entries for trend", () => {
      const monitor = new ConnectionQualityMonitor();
      // First 40 entries: degrading
      for (let i = 0; i < 40; i++) {
        monitor.recordRssi("peer-1", -30 - i);
      }
      // Last 20 entries: improving
      for (let i = 0; i < 20; i++) {
        monitor.recordRssi("peer-1", -80 + i * 2);
      }
      expect(monitor.getRssiTrend("peer-1")).toBe("improving");
    });
  });
});
