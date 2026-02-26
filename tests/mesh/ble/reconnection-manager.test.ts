import { describe, it, expect } from "vitest";
import { ReconnectionManager } from "../../../src/mesh/ble/reconnection-manager.js";

describe("ReconnectionManager", () => {
  describe("exponential backoff", () => {
    it("doubles delay with each attempt", () => {
      // Use a fixed seed approach: verify the base pattern ignoring jitter
      const mgr = new ReconnectionManager({ baseDelayMs: 500, maxDelayMs: 30_000 });
      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        delays.push(mgr.scheduleReconnect("peer-1"));
      }
      // Expected base delays: 500, 1000, 2000, 4000, 8000
      // With +/-10% jitter
      expect(delays[0]).toBeGreaterThanOrEqual(450);
      expect(delays[0]).toBeLessThanOrEqual(550);
      expect(delays[1]).toBeGreaterThanOrEqual(900);
      expect(delays[1]).toBeLessThanOrEqual(1100);
      expect(delays[2]).toBeGreaterThanOrEqual(1800);
      expect(delays[2]).toBeLessThanOrEqual(2200);
      expect(delays[3]).toBeGreaterThanOrEqual(3600);
      expect(delays[3]).toBeLessThanOrEqual(4400);
      expect(delays[4]).toBeGreaterThanOrEqual(7200);
      expect(delays[4]).toBeLessThanOrEqual(8800);
    });

    it("caps delay at maxDelayMs", () => {
      const mgr = new ReconnectionManager({ baseDelayMs: 500, maxDelayMs: 5000 });
      // Attempt 0: 500, 1: 1000, 2: 2000, 3: 4000, 4: 5000 (capped)
      for (let i = 0; i < 4; i++) {
        mgr.scheduleReconnect("peer-1");
      }
      const delay = mgr.scheduleReconnect("peer-1");
      // 500 * 2^4 = 8000 but capped to 5000, with +/-10% jitter
      expect(delay).toBeLessThanOrEqual(5500);
      expect(delay).toBeGreaterThanOrEqual(4500);
    });
  });

  describe("jitter", () => {
    it("applies jitter within +/-10% range", () => {
      const mgr = new ReconnectionManager({ baseDelayMs: 1000, maxDelayMs: 30_000 });
      // Run many times to check jitter is within bounds
      const delays: number[] = [];
      for (let i = 0; i < 100; i++) {
        const localMgr = new ReconnectionManager({ baseDelayMs: 1000, maxDelayMs: 30_000 });
        delays.push(localMgr.scheduleReconnect(`peer-${i}`));
      }
      // All should be within 900-1100 (1000 +/- 10%)
      for (const d of delays) {
        expect(d).toBeGreaterThanOrEqual(900);
        expect(d).toBeLessThanOrEqual(1100);
      }
    });

    it("produces varied delays (not all identical)", () => {
      const delays = new Set<number>();
      for (let i = 0; i < 50; i++) {
        const mgr = new ReconnectionManager({ baseDelayMs: 1000, maxDelayMs: 30_000 });
        delays.add(mgr.scheduleReconnect(`peer-${i}`));
      }
      // With random jitter, we should get multiple distinct values
      expect(delays.size).toBeGreaterThan(1);
    });
  });

  describe("max attempts", () => {
    it("reports gaveUp after maxAttempts", () => {
      const mgr = new ReconnectionManager({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10_000 });
      mgr.scheduleReconnect("peer-1");
      mgr.scheduleReconnect("peer-1");
      mgr.scheduleReconnect("peer-1");
      expect(mgr.shouldRetry("peer-1")).toBe(false);
    });

    it("shouldRetry is true before maxAttempts", () => {
      const mgr = new ReconnectionManager({ maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 10_000 });
      mgr.scheduleReconnect("peer-1");
      mgr.scheduleReconnect("peer-1");
      expect(mgr.shouldRetry("peer-1")).toBe(true);
    });

    it("returns -1 from scheduleReconnect after giving up", () => {
      const mgr = new ReconnectionManager({ maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 10_000 });
      mgr.scheduleReconnect("peer-1");
      mgr.scheduleReconnect("peer-1"); // this is attempt index 1, hits max
      const delay = mgr.scheduleReconnect("peer-1");
      expect(delay).toBe(-1);
    });

    it("defaults to 8 max attempts", () => {
      const mgr = new ReconnectionManager({ baseDelayMs: 100, maxDelayMs: 30_000 });
      for (let i = 0; i < 8; i++) {
        mgr.scheduleReconnect("peer-1");
      }
      expect(mgr.shouldRetry("peer-1")).toBe(false);
    });

    it("shouldRetry returns true for unknown peer", () => {
      const mgr = new ReconnectionManager();
      expect(mgr.shouldRetry("unknown")).toBe(true);
    });
  });

  describe("recordSuccess", () => {
    it("resets backoff state", () => {
      const mgr = new ReconnectionManager({ baseDelayMs: 100, maxDelayMs: 10_000 });
      mgr.scheduleReconnect("peer-1");
      mgr.scheduleReconnect("peer-1");
      mgr.scheduleReconnect("peer-1");
      expect(mgr.getAttemptCount("peer-1")).toBe(3);

      mgr.recordSuccess("peer-1");
      expect(mgr.getAttemptCount("peer-1")).toBe(0);
      expect(mgr.getBackoffMs("peer-1")).toBe(0);
      expect(mgr.shouldRetry("peer-1")).toBe(true);
    });

    it("allows retries after success resets gave-up state", () => {
      const mgr = new ReconnectionManager({ maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 10_000 });
      mgr.scheduleReconnect("peer-1");
      mgr.scheduleReconnect("peer-1");
      expect(mgr.shouldRetry("peer-1")).toBe(false);

      mgr.recordSuccess("peer-1");
      expect(mgr.shouldRetry("peer-1")).toBe(true);

      // Can schedule again from scratch
      const delay = mgr.scheduleReconnect("peer-1");
      expect(delay).toBeGreaterThan(0);
    });
  });

  describe("multiple peers", () => {
    it("tracks peers independently", () => {
      const mgr = new ReconnectionManager({ baseDelayMs: 100, maxDelayMs: 10_000, maxAttempts: 3 });

      mgr.scheduleReconnect("peer-a");
      mgr.scheduleReconnect("peer-a");
      mgr.scheduleReconnect("peer-b");

      expect(mgr.getAttemptCount("peer-a")).toBe(2);
      expect(mgr.getAttemptCount("peer-b")).toBe(1);
    });

    it("success on one peer does not affect another", () => {
      const mgr = new ReconnectionManager({ baseDelayMs: 100, maxDelayMs: 10_000 });

      mgr.scheduleReconnect("peer-a");
      mgr.scheduleReconnect("peer-a");
      mgr.scheduleReconnect("peer-b");

      mgr.recordSuccess("peer-a");
      expect(mgr.getAttemptCount("peer-a")).toBe(0);
      expect(mgr.getAttemptCount("peer-b")).toBe(1);
    });

    it("one peer giving up does not affect another", () => {
      const mgr = new ReconnectionManager({ maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 10_000 });

      mgr.scheduleReconnect("peer-a");
      mgr.scheduleReconnect("peer-a"); // gave up

      mgr.scheduleReconnect("peer-b");

      expect(mgr.shouldRetry("peer-a")).toBe(false);
      expect(mgr.shouldRetry("peer-b")).toBe(true);
    });
  });

  describe("resetAll", () => {
    it("clears all reconnection state", () => {
      const mgr = new ReconnectionManager({ baseDelayMs: 100, maxDelayMs: 10_000 });
      mgr.scheduleReconnect("peer-a");
      mgr.scheduleReconnect("peer-b");

      mgr.resetAll();

      expect(mgr.getAttemptCount("peer-a")).toBe(0);
      expect(mgr.getAttemptCount("peer-b")).toBe(0);
      expect(mgr.shouldRetry("peer-a")).toBe(true);
      expect(mgr.shouldRetry("peer-b")).toBe(true);
    });
  });

  describe("getBackoffMs", () => {
    it("returns 0 for unknown peer", () => {
      const mgr = new ReconnectionManager();
      expect(mgr.getBackoffMs("unknown")).toBe(0);
    });

    it("returns last computed delay", () => {
      const mgr = new ReconnectionManager({ baseDelayMs: 1000, maxDelayMs: 30_000 });
      const delay = mgr.scheduleReconnect("peer-1");
      expect(mgr.getBackoffMs("peer-1")).toBe(delay);
    });
  });
});
