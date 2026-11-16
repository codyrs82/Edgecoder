import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, test } from "vitest";
import { PostgresNetworkHistoryStore, type NetworkHistoryStore } from "../../src/db/network-history-store.js";
import { DAY_MS, MAX_PENDING, NetworkHistory } from "../../src/swarm/network-history.js";
import { RingBuffer, SAMPLE_CAPACITY, downsample, type NetworkSample } from "../../src/swarm/network-observer.js";

/*
 * The Network page's series survives a restart: samples are written in batches to the store, read
 * back into a fresh ring at start, pruned after NETWORK_HISTORY_DAYS; without a database nothing is
 * written and the ring works as before.
 */

const sample = (atMs: number, over: Partial<NetworkSample> = {}): NetworkSample => ({
  atMs, connectedAgents: 2, busyAgents: 1, totalSlots: 4, freeSlots: 2, queued: 0, claimed: 1, waitingInference: 0,
  started: 1, completed: 1, failed: 0, noCapacity: 0, noAgentHasModel: 0, pickupP50: 100, pickupP90: 200, ttftP50: null, ttftP90: null, ...over
});

/** In-memory stand-in for the Postgres table: rows by coordinator and time. */
class MemoryStore implements NetworkHistoryStore {
  rows = new Map<string, NetworkSample>();
  fail = false;
  inserts = 0;
  async insert(coordinatorId: string, samples: readonly NetworkSample[]) {
    if (this.fail) throw new Error("connection refused");
    this.inserts++;
    for (const s of samples) {
      const key = `${coordinatorId}|${s.atMs}`;
      if (!this.rows.has(key)) this.rows.set(key, JSON.parse(JSON.stringify(s)));
    }
  }
  async load(coordinatorId: string, sinceMs: number) {
    if (this.fail) throw new Error("connection refused");
    return [...this.rows.entries()].filter(([k, s]) => k.startsWith(`${coordinatorId}|`) && s.atMs >= sinceMs).map(([, s]) => s).sort((a, b) => a.atMs - b.atMs);
  }
  async prune(beforeMs: number) {
    if (this.fail) throw new Error("connection refused");
    let n = 0;
    for (const [k, s] of this.rows) if (s.atMs < beforeMs) { this.rows.delete(k); n++; }
    return n;
  }
}

function logger() {
  const lines: Array<{ level: string; msg: string; obj: object }> = [];
  return { lines, info: (obj: object, msg: string) => lines.push({ level: "info", msg, obj }), warn: (obj: object, msg: string) => lines.push({ level: "warn", msg, obj }) };
}

function coordinator(store: NetworkHistoryStore | null, id = "coord-a", retentionDays = 7) {
  const ring = new RingBuffer<NetworkSample>(SAMPLE_CAPACITY);
  const log = logger();
  const history = new NetworkHistory({ store, coordinatorId: id, ring, retentionDays, log });
  const take = (atMs: number, over: Partial<NetworkSample> = {}) => {
    const s = sample(atMs, over);
    ring.push(s);
    history.record(s);
  };
  return { ring, history, log, take };
}

describe("network history", () => {
  test("samples are written in a batch and read back after a restart", async () => {
    const store = new MemoryStore();
    const now = Date.UTC(2026, 10, 15, 4, 18);
    const before = coordinator(store);
    for (let t = now - 6 * 3_600_000; t < now; t += 15_000) before.take(t, { queued: 3 });
    expect(store.rows.size).toBe(0);
    await before.history.flush();
    expect(store.inserts).toBe(1);
    expect(store.rows.size).toBe(6 * 240);
    expect(before.history.pendingCount).toBe(0);

    // Restart: a fresh ring that has already taken one sample of its own.
    const after = coordinator(store);
    after.take(now + 15_000, { queued: 9 });
    expect(await after.history.restore(now + 20_000)).toBe(6 * 240);
    const all = after.ring.toArray();
    expect(all).toHaveLength(6 * 240 + 1);
    expect(all.at(-1)).toMatchObject({ atMs: now + 15_000, queued: 9 });
    expect(all[0]).toMatchObject({ atMs: now - 6 * 3_600_000, queued: 3, ttftP50: null });
    // The 6 h series is full again, not just the points since the restart.
    expect(downsample(all, "6h", now + 20_000).length).toBeGreaterThanOrEqual(240);
    // Another coordinator's rows are not mixed in.
    const other = coordinator(store, "coord-b");
    expect(await other.history.restore(now)).toBe(0);
  });

  test("restore reads at most 7 days, or the retention if shorter", async () => {
    const store = new MemoryStore();
    const now = 20 * DAY_MS;
    const a = coordinator(store);
    for (let d = 10; d >= 1; d--) a.take(now - d * DAY_MS + 1_000);
    await a.history.flush();
    const seven = coordinator(store);
    expect(await seven.history.restore(now)).toBe(7);
    const two = coordinator(store, "coord-a", 2);
    expect(await two.history.restore(now)).toBe(2);
  });

  test("pruning deletes rows older than the retention, for every coordinator", async () => {
    const store = new MemoryStore();
    const now = 30 * DAY_MS;
    const a = coordinator(store, "coord-a", 7);
    const b = coordinator(store, "coord-b", 7);
    for (const c of [a, b]) {
      c.take(now - 8 * DAY_MS);
      c.take(now - 7 * DAY_MS - 1);
      c.take(now - 6 * DAY_MS);
      c.take(now - 60_000);
      await c.history.flush();
    }
    expect(store.rows.size).toBe(8);
    expect(await a.history.prune(now)).toBe(4);
    expect([...store.rows.values()].map((s) => s.atMs).sort()).toEqual([now - 6 * DAY_MS, now - 6 * DAY_MS, now - 60_000, now - 60_000]);
    expect(a.log.lines.find((l) => l.msg === "network_history_pruned")?.obj).toMatchObject({ removed: 4, days: 7 });
  });

  test("a failed write is logged, kept and written next time; failures never throw", async () => {
    const store = new MemoryStore();
    const c = coordinator(store);
    c.take(1_000);
    c.take(16_000);
    store.fail = true;
    await expect(c.history.flush()).resolves.toBeUndefined();
    await expect(c.history.restore(20_000)).resolves.toBe(0);
    await expect(c.history.prune(20_000)).resolves.toBe(0);
    expect(c.log.lines.map((l) => l.msg)).toEqual(["network_history_write_failed", "network_history_restore_failed", "network_history_prune_failed"]);
    expect(c.history.pendingCount).toBe(2);
    c.take(31_000);
    store.fail = false;
    await c.history.flush();
    expect([...store.rows.values()].map((s) => s.atMs)).toEqual([1_000, 16_000, 31_000]);
    expect(c.ring.size).toBe(3);
  });

  test("the write queue is bounded while the database is away", () => {
    const c = coordinator(new MemoryStore());
    for (let i = 0; i < MAX_PENDING + 10; i++) c.take(i * 15_000);
    expect(c.history.pendingCount).toBe(MAX_PENDING);
  });

  test("one write at a time: a flush during a flush waits for it", async () => {
    const store = new MemoryStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: NetworkHistoryStore = { ...store, load: store.load.bind(store), prune: store.prune.bind(store), insert: async (id, s) => { await gate; await store.insert(id, s); } };
    const c = coordinator(slow);
    c.take(1_000);
    const first = c.history.flush();
    c.take(16_000);
    const second = c.history.flush();
    expect(second).toBe(first);
    release();
    await first;
    expect(store.inserts).toBe(1);
    await c.history.stop();
    expect(store.rows.size).toBe(2);
  });

  test("without a database: memory only, nothing queued, nothing read", async () => {
    const c = coordinator(null);
    for (let i = 0; i < 10; i++) c.take(i * 15_000);
    expect(c.history.enabled).toBe(false);
    expect(c.history.pendingCount).toBe(0);
    await c.history.flush();
    expect(await c.history.restore(200_000)).toBe(0);
    expect(await c.history.prune(200_000)).toBe(0);
    c.history.start();
    await c.history.stop();
    expect(c.ring.size).toBe(10);
    expect(c.log.lines).toEqual([]);
  });
});

// The real table, when a test database is given (TEST_DATABASE_URL), like tests/db/ledger-network.test.ts.
const PG_URL = process.env.TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("network_samples in Postgres", () => {
  const pool = PG_URL ? new pg.Pool({ connectionString: PG_URL }) : null;
  const id = `test-${randomUUID()}`;
  afterAll(async () => {
    await pool?.query("DELETE FROM network_samples WHERE coordinator_id = $1", [id]).catch(() => undefined);
    await pool?.end();
  });

  test("insert skips duplicates, load returns this coordinator's rows in order, prune deletes old ones", async () => {
    const store = new PostgresNetworkHistoryStore(pool!);
    const now = Date.now();
    await store.insert(id, [sample(now - 2 * DAY_MS), sample(now - 30_000, { ttftP90: 1234 }), sample(now - 15_000)]);
    await store.insert(id, [sample(now - 15_000, { queued: 99 })]);
    const rows = await store.load(id, now - DAY_MS);
    expect(rows.map((r) => r.atMs)).toEqual([now - 30_000, now - 15_000]);
    expect(rows[0]).toMatchObject({ ttftP90: 1234, pickupP50: 100, ttftP50: null });
    expect(rows[1]!.queued).toBe(0);
    expect(await store.prune(now - DAY_MS)).toBeGreaterThanOrEqual(1);
    expect((await store.load(id, 0)).map((r) => r.atMs)).toEqual([now - 30_000, now - 15_000]);
  });
});
