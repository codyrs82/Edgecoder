import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { SwarmQueue } from "../../src/swarm/queue.js";
import { lateResultRejectionDurable } from "../../src/swarm/lease-gate.js";
import { resultReportId } from "../../src/swarm/result-integrity.js";
import { coordinatorRequiredProdEnv, requireProdEnv } from "../../src/common/env-guard.js";
import type { PostgresStore } from "../../src/db/postgres.js";
import type { Subtask } from "../../src/common/types.js";
import { PG_URL, twoCoordinatorsOneDatabase, type SharedDb } from "../helpers/shared-pg.js";

// #55 / #99: replay and lease state must outlive a coordinator restart and be shared by every
// coordinator on one database. "Restart" = a fresh SwarmQueue / PostgresStore on the same database.
const policy = { allowIdleOnly: false, maxCpuPercent: 100, maxMemoryMb: 4096 } as any;
const LEASE = { graceMs: 10_000, livenessMs: 20_000, maxAttempts: 3 };

function subtask(id = randomUUID()): Subtask {
  return {
    id,
    taskId: "task-1",
    kind: "micro_loop",
    language: "python",
    input: "print(1)",
    timeoutMs: 120_000,
    snapshotRef: "commit:test",
    projectMeta: { projectId: "p", resourceClass: "cpu", priority: 10 }
  };
}

const flush = () => new Promise((r) => setTimeout(r, 50));

describe("production coordinator requires Postgres (#55)", () => {
  it("refuses to start in production without DATABASE_URL", () => {
    const full = {
      NODE_ENV: "production", MESH_AUTH_TOKEN: "m", PORTAL_SERVICE_URL: "u", PORTAL_SERVICE_TOKEN: "p",
      ADMIN_API_TOKEN: "a", PAYMENT_WEBHOOK_SECRET: "w"
    };
    expect(() => requireProdEnv("coordinator", coordinatorRequiredProdEnv(false), full)).toThrow(/DATABASE_URL/);
    expect(() =>
      requireProdEnv("coordinator", coordinatorRequiredProdEnv(false), { ...full, DATABASE_URL: "postgresql://x" })
    ).not.toThrow();
    // Outside production the in-memory fallbacks stay available for local dev.
    expect(() => requireProdEnv("coordinator", coordinatorRequiredProdEnv(false), { NODE_ENV: "development" })).not.toThrow();
  });
});

describe("queue lease state goes through the store (#99, fake store)", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_000_000); });
  afterEach(() => vi.useRealTimers());

  function fakeStore(initial: { attempts: number; expiredHolders: string[] }) {
    const calls: unknown[][] = [];
    const store = {
      persistSubtask: async () => undefined,
      getSubtaskLeaseState: async () => initial,
      markSubtaskClaimed: async (...a: unknown[]) => void calls.push(["claimed", ...a]),
      markSubtaskReleased: async (...a: unknown[]) => void calls.push(["released", ...a]),
      persistResult: async () => undefined,
      isExpiredLeaseHolder: async (_s: string, agent: string) => initial.expiredHolders.includes(agent),
      upsertAgent: async () => undefined
    };
    return { store: store as unknown as PostgresStore, calls };
  }

  it("re-enqueue after restart keeps the retry count and the expired holders", async () => {
    const { store, calls } = fakeStore({ attempts: 2, expiredHolders: ["A"] });
    const q = new SwarmQueue(store, LEASE);
    q.registerAgent("B", policy);
    const st = q.enqueueSubtask(subtask());
    await flush();
    expect(q.leaseExpiredFor(st.id, "A")).toBe(true);
    expect(q.claim("B")?.id).toBe(st.id);
    await flush();
    expect(calls[0]).toEqual(["claimed", st.id, "B", 1_000_000, 3]);
    // Third attempt expires: the cap (3) is hit, so the subtask fails instead of being requeued.
    vi.setSystemTime(Date.now() + LEASE.livenessMs + 1);
    expect(q.expireLeases()).toEqual({ requeued: [], failed: [st.id] });
  });

  it("a requeued expiry records the holder; a coordinator hand-back records the decremented count", async () => {
    const { store, calls } = fakeStore({ attempts: 0, expiredHolders: [] });
    const q = new SwarmQueue(store, LEASE);
    q.registerAgent("A", policy);
    const st = q.enqueueSubtask(subtask());
    await flush();
    q.claim("A");
    q.requeue(st.id);
    await flush();
    expect(calls[1]).toEqual(["released", st.id, 0]);
    q.claim("A");
    vi.setSystemTime(Date.now() + LEASE.livenessMs + 1);
    expect(q.expireLeases().requeued).toEqual([st.id]);
    await flush();
    expect(calls[3]).toEqual(["released", st.id, 1, { agentId: "A", atMs: Date.now() }]);
  });
});

describe.skipIf(!PG_URL)("replay after restart / on a second coordinator, real Postgres (#55, #99)", () => {
  let db: SharedDb;
  beforeAll(async () => { db = await twoCoordinatorsOneDatabase(); });
  afterAll(async () => { await db?.close(); });

  it("a contribution report credited before a restart is not credited again (report_id unique)", async () => {
    const subtaskId = randomUUID();
    const report = {
      reportId: resultReportId(subtaskId), agentId: "acct-w", taskId: "t1", resourceClass: "cpu" as const,
      cpuSeconds: 2, gpuSeconds: 0, success: true, qualityScore: 1, timestampMs: Date.now()
    };
    const input = { report, accountId: "acct-w", sourceAgentId: "agent-w", reliabilityScore: 1, weightedContribution: 2 };
    const tx = () => ({ txId: randomUUID(), accountId: "acct-w", type: "earn" as const, credits: 1.5, reason: "compute_contribution", timestampMs: Date.now() });
    expect(await db.a.persistContributionWithCredit(input as any, tx())).toBe(true);
    // Restarted coordinator A, and coordinator B on the same database: both refuse the replay.
    expect(await db.b.persistContributionWithCredit(input as any, tx())).toBe(false);
    expect(await db.a.persistContributionWithCredit(input as any, tx())).toBe(false);
    expect(await db.a.creditBalance("acct-w")).toBeCloseTo(1.5, 6);
  });

  it("a BLE transfer synced before a restart is a duplicate afterwards (ble_synced_tx primary key)", async () => {
    await db.a.recordCreditTransactions([
      { txId: randomUUID(), accountId: "req", type: "earn", credits: 10, reason: "seed", timestampMs: Date.now() }
    ]);
    const t = { txId: `ble-${randomUUID()}`, requesterAccountId: "req", providerAccountId: "prov", credits: 3 };
    expect(await db.a.applyBleTransfer(t)).toBe("applied");
    expect(await db.b.applyBleTransfer(t)).toBe("duplicate");
    expect(await db.a.creditBalance("req")).toBeCloseTo(7, 6);
    expect(await db.a.creditBalance("prov")).toBeCloseTo(3, 6);
  });

  describe("lease state (#99)", () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.UTC(2026, 0, 1)); });
    afterEach(() => vi.useRealTimers());

    it("attempts and expired holders survive a restart; the retry cap is not reset", async () => {
      const st = subtask();
      const q1 = new SwarmQueue(db.a, LEASE);
      q1.registerAgent("A", policy);
      q1.registerAgent("B", policy);
      q1.enqueueSubtask(st);
      await flush();
      expect(q1.claim("A")?.id).toBe(st.id);
      vi.setSystemTime(Date.now() + LEASE.livenessMs + 1); // A goes silent; lease expires
      expect(q1.expireLeases().requeued).toEqual([st.id]);
      expect(q1.claim("B")?.id).toBe(st.id); // attempt 2
      await flush();
      expect(await db.a.getSubtaskLeaseState(st.id)).toEqual({ attempts: 2, expiredHolders: ["A"] });

      // Restart (or the subtask lands on coordinator B): the in-memory queue starts empty.
      const q2 = new SwarmQueue(db.b, LEASE);
      q2.registerAgent("C", policy);
      // A's late result is rejected by the durable check even before the subtask is re-enqueued.
      expect(await lateResultRejectionDurable(q2, st.id, "A")).toEqual({ statusCode: 409, body: { error: "lease_expired" } });
      expect(await lateResultRejectionDurable(q2, st.id, "B")).toBeNull();
      q2.enqueueSubtask(st);
      await flush();
      expect(q2.leaseExpiredFor(st.id, "A")).toBe(true);
      expect(q2.claim("C")?.id).toBe(st.id); // attempt 3, not 1
      await flush();
      expect((await db.b.getSubtaskLeaseState(st.id)).attempts).toBe(3);
      vi.setSystemTime(Date.now() + LEASE.livenessMs + 1);
      expect(q2.expireLeases()).toEqual({ requeued: [], failed: [st.id] });
    });

    it("a re-claim by a formerly expired holder clears its mark; a recorded result clears the rest", async () => {
      const st = subtask();
      const q = new SwarmQueue(db.a, LEASE);
      q.registerAgent("A", policy);
      q.enqueueSubtask(st);
      await flush();
      q.claim("A");
      vi.setSystemTime(Date.now() + LEASE.livenessMs + 1);
      q.expireLeases();
      await flush();
      expect(await db.b.isExpiredLeaseHolder(st.id, "A")).toBe(true);
      expect(q.claim("A")?.id).toBe(st.id);
      await flush();
      expect(await db.b.isExpiredLeaseHolder(st.id, "A")).toBe(false);
      expect(await lateResultRejectionDurable(q, st.id, "A")).toBeNull();
      q.complete({ subtaskId: st.id, taskId: st.taskId, agentId: "A", ok: true, output: "1", durationMs: 5 });
      await flush();
      expect((await db.a.getSubtaskLeaseState(st.id)).expiredHolders).toEqual([]);
    });
  });
});
