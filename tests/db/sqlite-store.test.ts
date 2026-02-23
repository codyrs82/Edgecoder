import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SQLiteStore } from "../../src/db/sqlite-store.js";

let store: SQLiteStore;

beforeEach(() => {
  store = new SQLiteStore(":memory:");
});

afterEach(() => {
  store.close();
});

describe("SQLiteStore", () => {
  // ── Task History ──────────────────────────────────────────────

  describe("task history", () => {
    it("records a task start and retrieves it", () => {
      store.recordTaskStart("sub-1", "task-1", "print hello", "python", "ollama-local", "https://coord.test");
      const tasks = store.recentTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].subtaskId).toBe("sub-1");
      expect(tasks[0].status).toBe("running");
      expect(tasks[0].prompt).toBe("print hello");
      expect(tasks[0].provider).toBe("ollama-local");
    });

    it("completes a task with output and duration", () => {
      store.recordTaskStart("sub-2", "task-2", "add 1+1", "python", "ollama-local", "https://coord.test");
      store.recordTaskComplete("sub-2", "2", 150);
      const tasks = store.recentTasks();
      expect(tasks[0].status).toBe("completed");
      expect(tasks[0].output).toBe("2");
      expect(tasks[0].durationMs).toBe(150);
      expect(tasks[0].completedAt).toBeGreaterThan(0);
    });

    it("records a failed task", () => {
      store.recordTaskStart("sub-3", "task-3", "bad code", "python", "ollama-local", "https://coord.test");
      store.recordTaskFailed("sub-3", "SyntaxError", 50);
      const tasks = store.recentTasks();
      expect(tasks[0].status).toBe("failed");
      expect(tasks[0].error).toBe("SyntaxError");
    });

    it("taskStats returns correct aggregates", () => {
      store.recordTaskStart("s1", "t1", "p1", "python", "p", "c");
      store.recordTaskComplete("s1", "ok", 100);
      store.recordTaskStart("s2", "t2", "p2", "python", "p", "c");
      store.recordTaskComplete("s2", "ok", 200);
      store.recordTaskStart("s3", "t3", "p3", "python", "p", "c");
      store.recordTaskFailed("s3", "err", 50);

      const stats = store.taskStats();
      expect(stats.total).toBe(3);
      expect(stats.completed).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.avgDurationMs).toBe(150);
    });

    it("recentTasks respects limit", () => {
      for (let i = 0; i < 10; i++) {
        store.recordTaskStart(`s${i}`, `t${i}`, `p${i}`, "python", "p", "c");
      }
      expect(store.recentTasks(3)).toHaveLength(3);
    });
  });

  // ── BLE Peers ─────────────────────────────────────────────────

  describe("BLE peers", () => {
    it("inserts and lists a BLE peer", () => {
      store.upsertBLEPeer("iphone-abc", "qwen2.5-coder", 0.5, "phone", -42);
      const peers = store.listBLEPeers();
      expect(peers).toHaveLength(1);
      expect(peers[0].agentId).toBe("iphone-abc");
      expect(peers[0].model).toBe("qwen2.5-coder");
      expect(peers[0].rssi).toBe(-42);
    });

    it("upserts update existing peer", () => {
      store.upsertBLEPeer("iphone-abc", "qwen2.5-coder", 0.5, "phone", -42);
      store.upsertBLEPeer("iphone-abc", "qwen2.5-coder", 0.5, "phone", -55);
      const peers = store.listBLEPeers();
      expect(peers).toHaveLength(1);
      expect(peers[0].rssi).toBe(-55);
    });

    it("tracks task success/fail counts", () => {
      store.upsertBLEPeer("mac-1", "llama3", 7, "laptop", -30);
      store.recordBLETaskResult("mac-1", true);
      store.recordBLETaskResult("mac-1", true);
      store.recordBLETaskResult("mac-1", false);
      const peers = store.listBLEPeers();
      expect(peers[0].taskSuccessCount).toBe(2);
      expect(peers[0].taskFailCount).toBe(1);
    });

    it("evicts stale peers", () => {
      store.upsertBLEPeer("old-peer", "model", 0, "phone", -80);
      // Peer was just inserted (last_seen_at = now), so maxAge=0 won't evict.
      // Use a negative threshold to force eviction for testing.
      const notEvicted = store.evictStaleBLEPeers(9999);
      expect(notEvicted).toBe(0);
      expect(store.listBLEPeers()).toHaveLength(1);

      // Force last_seen_at to 1 hour ago by direct SQL, then evict
      store["db"].prepare("UPDATE ble_peers SET last_seen_at = unixepoch() - 3600 WHERE agent_id = ?").run("old-peer");
      const evicted = store.evictStaleBLEPeers(1800); // 30 minutes
      expect(evicted).toBe(1);
      expect(store.listBLEPeers()).toHaveLength(0);
    });
  });

  // ── Heartbeat Log ─────────────────────────────────────────────

  describe("heartbeat log", () => {
    it("records and retrieves heartbeats", () => {
      store.recordHeartbeat("https://coord.test", "ok", 45, 100.5);
      const hbs = store.recentHeartbeats();
      expect(hbs).toHaveLength(1);
      expect(hbs[0].coordinatorUrl).toBe("https://coord.test");
      expect(hbs[0].status).toBe("ok");
      expect(hbs[0].latencyMs).toBe(45);
      expect(hbs[0].creditsRemaining).toBe(100.5);
    });

    it("handles null credits", () => {
      store.recordHeartbeat("https://coord.test", "ok", 30);
      const hbs = store.recentHeartbeats();
      expect(hbs[0].creditsRemaining).toBeNull();
    });
  });

  // ── KV Config ─────────────────────────────────────────────────

  describe("kv config", () => {
    it("sets and gets a config value", () => {
      store.setConfig("coordinator_url", "https://coord.test");
      expect(store.getConfig("coordinator_url")).toBe("https://coord.test");
    });

    it("returns undefined for missing key", () => {
      expect(store.getConfig("nonexistent")).toBeUndefined();
    });

    it("overwrites existing value", () => {
      store.setConfig("key", "value1");
      store.setConfig("key", "value2");
      expect(store.getConfig("key")).toBe("value2");
    });
  });

  // ── Outbound Task Queue ───────────────────────────────────────

  describe("outbound task queue", () => {
    it("enqueues and claims a task", () => {
      store.enqueueOutboundTask("out-1", "iphone-abc", "write fibonacci", "python");
      const task = store.claimNextOutbound("iphone-abc");
      expect(task).not.toBeNull();
      expect(task!.id).toBe("out-1");
      expect(task!.prompt).toBe("write fibonacci");
      expect(task!.status).toBe("queued");
    });

    it("returns null when no tasks queued", () => {
      expect(store.claimNextOutbound("nobody")).toBeNull();
    });

    it("claim marks task as sent", () => {
      store.enqueueOutboundTask("out-2", "mac-1", "test prompt", "python");
      store.claimNextOutbound("mac-1");
      // Second claim returns null (already sent)
      expect(store.claimNextOutbound("mac-1")).toBeNull();
    });

    it("completes an outbound task", () => {
      store.enqueueOutboundTask("out-3", "mac-1", "test", "python");
      store.claimNextOutbound("mac-1");
      store.completeOutbound("out-3", "result output");
      // Verify by trying to claim again — nothing queued
      expect(store.claimNextOutbound("mac-1")).toBeNull();
    });

    it("fails an outbound task", () => {
      store.enqueueOutboundTask("out-4", "mac-1", "test", "python");
      store.claimNextOutbound("mac-1");
      store.failOutbound("out-4");
      expect(store.claimNextOutbound("mac-1")).toBeNull();
    });
  });
});
