import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OrderingChain } from "../../src/ledger/chain.js";
import { createPeerKeys } from "../../src/mesh/peer.js";
import type { QueueEventRecord } from "../../src/common/types.js";
import type { PostgresStore } from "../../src/db/postgres.js";
import {
  finalizeStatsCheckpoint,
  statsCheckpointBoundaryMs,
  statsFinalityState,
  type StatsCheckpointStore,
  type StatsCheckpointTarget
} from "../../src/ledger/stats-checkpoint.js";
import { PG_URL, twoCoordinatorsOneDatabase, type SharedDb } from "../helpers/shared-pg.js";

const PERIOD = 60_000;
const SETTLE = 10_000;

/** In-memory stats ledger shared by "coordinators" (the shared-Postgres case without Postgres). */
function memoryLedger() {
  const rows: QueueEventRecord[] = [];
  const store: StatsCheckpointStore = {
    async latestStatsDataRecordAtOrBefore(ms) {
      const data = rows
        .filter((r) => r.eventType !== "stats_checkpoint_signature" && r.eventType !== "stats_checkpoint_commit" && r.issuedAtMs <= ms)
        .sort((x, y) => x.issuedAtMs - y.issuedAtMs);
      const last = data[data.length - 1];
      return last ? { hash: last.hash, issuedAtMs: last.issuedAtMs, height: rows.length } : null;
    },
    async checkpointSignatureStatus(hash) {
      const mine = rows.filter((r) => r.checkpointHash === hash);
      return {
        hasCommit: mine.some((r) => r.eventType === "stats_checkpoint_commit"),
        signers: [...new Set(mine.filter((r) => r.eventType === "stats_checkpoint_signature").map((r) => r.coordinatorId!))]
      };
    }
  };
  return { rows, store };
}

function coordinator(name: string, store: StatsCheckpointStore, persist: (r: QueueEventRecord) => Promise<unknown>) {
  const keys = createPeerKeys(name);
  const chain = new OrderingChain(name, keys.privateKeyPem);
  const write = (eventType: QueueEventRecord["eventType"], target: StatsCheckpointTarget, payload: object) =>
    persist(chain.append({ eventType, taskId: "stats-ledger", actorId: name, coordinatorId: name, checkpointHeight: target.height, checkpointHash: target.hash, payloadJson: JSON.stringify(payload) }));
  return {
    name,
    chain,
    work: (taskId: string) => persist(chain.append({ eventType: "task_enqueue", taskId, actorId: name })),
    tick: (nowMs: number, threshold = 2) =>
      finalizeStatsCheckpoint({
        store,
        selfId: name,
        threshold,
        nowMs,
        periodMs: PERIOD,
        settleMs: SETTLE,
        writeSignature: async (t, th) => { await write("stats_checkpoint_signature", t, { threshold: th }); },
        writeCommit: async (t, th, signers) => { await write("stats_checkpoint_commit", t, { threshold: th, signerSet: signers }); }
      })
  };
}

describe("stats checkpoint target", () => {
  it("is the same boundary for every coordinator within a period, lagging by the settle delay", () => {
    expect(statsCheckpointBoundaryMs(125_000, PERIOD, SETTLE)).toBe(60_000);
    expect(statsCheckpointBoundaryMs(179_999, PERIOD, SETTLE)).toBe(120_000);
    expect(statsCheckpointBoundaryMs(65_000, PERIOD, SETTLE)).toBe(0);
  });

  it("finality: a commit without an anchor provider is soft-final, not 'anchor pending'", () => {
    expect(statsFinalityState({ hasCommit: false, anchoringEnabled: false, anchorExists: false, hardFinalized: false })).toBe("no_checkpoint");
    expect(statsFinalityState({ hasCommit: true, anchoringEnabled: false, anchorExists: false, hardFinalized: false })).toBe("soft_finalized");
    expect(statsFinalityState({ hasCommit: true, anchoringEnabled: true, anchorExists: false, hardFinalized: false })).toBe("anchored_pending");
    expect(statsFinalityState({ hasCommit: true, anchoringEnabled: true, anchorExists: true, hardFinalized: true })).toBe("anchored_confirmed");
  });
});

describe("two coordinators signing one stats ledger", () => {
  it("converge on one checkpoint and commit it once; idle ticks write nothing", async () => {
    const { rows, store } = memoryLedger();
    const persist = async (r: QueueEventRecord) => { rows.push(r); };
    const us = coordinator("coord-us", store, persist);
    const eu = coordinator("coord-eu", store, persist);
    await us.work("t1");
    await eu.work("t2");
    const base = Date.now();
    const now = Math.ceil((base + SETTLE + 1) / PERIOD) * PERIOD + SETTLE; // a boundary after both records

    // Before the fix each signature became the next head, so the two kept signing each other's
    // signatures and never reached two signers on one hash. Now both sign the same work record.
    const first = await us.tick(now);
    expect(first).toMatchObject({ signed: true, committed: false });
    const second = await eu.tick(now + 10_000);
    expect(second).toMatchObject({ signed: true, committed: true, signers: ["coord-eu", "coord-us"] });
    expect(second.target!.hash).toBe(first.target!.hash);

    const before = rows.length;
    for (let i = 0; i < 5; i++) {
      await us.tick(now + 20_000 + i * 10_000);
      await eu.tick(now + 25_000 + i * 10_000);
    }
    expect(rows.length).toBe(before); // no unbounded growth
    expect(rows.filter((r) => r.eventType === "stats_checkpoint_commit")).toHaveLength(1);
  });

  it("a lone coordinator (threshold 1) commits each new target once", async () => {
    const { rows, store } = memoryLedger();
    const solo = coordinator("coord-solo", store, async (r) => { rows.push(r); });
    await solo.work("t1");
    const now = Math.ceil((Date.now() + SETTLE + 1) / PERIOD) * PERIOD + SETTLE;
    expect(await solo.tick(now, 1)).toMatchObject({ signed: true, committed: true });
    expect(await solo.tick(now + 10_000, 1)).toMatchObject({ signed: false, committed: false });
    expect(rows).toHaveLength(3);
  });
});

describe.skipIf(!PG_URL)("stats ledger on one Postgres shared by two coordinators", () => {
  let db: SharedDb;
  beforeAll(async () => { db = await twoCoordinatorsOneDatabase(); });
  afterAll(async () => { await db?.close(); });

  const node = (name: string, store: PostgresStore) => coordinator(name, store, (r) => store.persistStatsLedgerRecord(r));

  it("concurrent ticks from both seeds produce both signatures and exactly one commit", async () => {
    const us = node("coord-us", db.a);
    const eu = node("coord-eu", db.b);
    await us.work("task-1");
    await eu.work("task-2");
    const now = Math.ceil((Date.now() + SETTLE + 1) / PERIOD) * PERIOD + SETTLE;
    for (let round = 0; round < 3; round++) await Promise.all([us.tick(now + round * 10_000), eu.tick(now + round * 10_000)]);

    const counts = await db.poolA.query(
      `SELECT event_type, count(*)::int AS n, count(DISTINCT checkpoint_hash)::int AS hashes FROM stats_ledger_records GROUP BY 1 ORDER BY 1`
    );
    expect(counts.rows).toEqual([
      { event_type: "stats_checkpoint_commit", n: 1, hashes: 1 },
      { event_type: "stats_checkpoint_signature", n: 2, hashes: 1 },
      { event_type: "task_enqueue", n: 2, hashes: 0 }
    ]);
    const latest = await db.b.latestStatsCheckpoint();
    expect(latest?.hash).toBe((await db.a.latestStatsDataRecordAtOrBefore(now))!.hash);
    // Both seeds report the same checkpoint, so the portal's federation view is not "stale".
    expect((await db.a.latestStatsCheckpoint())?.hash).toBe(latest?.hash);
  });

  it("a record already stored by the other seed is not stored (or projected) twice", async () => {
    const keys = createPeerKeys("coord-us");
    const record = new OrderingChain("coord-us", keys.privateKeyPem).append({
      eventType: "earnings_accrual", taskId: "task-x", actorId: "acct-1", coordinatorId: "coord-us", payloadJson: JSON.stringify({ credits: 5 })
    });
    expect(await db.a.persistStatsLedgerRecord(record)).toBe(true);
    expect(await db.b.persistStatsLedgerRecord(record)).toBe(false);
    expect(await db.a.persistStatsLedgerRecord(record)).toBe(false);
  });
});
