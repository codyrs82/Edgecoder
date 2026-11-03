import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PostgresStore } from "../../src/db/postgres.js";
import {
  ensureIssuanceEpoch,
  issuanceEpochIdFor,
  issuanceWindow,
  type IssuanceEpochStore
} from "../../src/economy/issuance-epoch.js";
import type { IssuanceEpochRecord } from "../../src/common/types.js";
import { PG_URL, twoCoordinatorsOneDatabase, type SharedDb } from "../helpers/shared-pg.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("issuance window", () => {
  it("is the same aligned window, and the same epoch id, for every seed within a recalc interval", () => {
    const base = 1_700_000_000_000 - (1_700_000_000_000 % HOUR);
    const a = issuanceWindow(base + 12 * 60_000, HOUR, DAY);
    const b = issuanceWindow(base + 47 * 60_000, HOUR, DAY);
    expect(a).toEqual({ windowStartMs: base - DAY, windowEndMs: base });
    expect(b).toEqual(a);
    expect(issuanceEpochIdFor(a)).toBe(issuanceEpochIdFor(b));
    expect(issuanceEpochIdFor(issuanceWindow(base + HOUR, HOUR, DAY))).not.toBe(issuanceEpochIdFor(a));
    expect(issuanceEpochIdFor(a, "testnet")).not.toBe(issuanceEpochIdFor(a, "mainnet"));
  });
});

function seed(name: string, store: IssuanceEpochStore, calls: { compute: number; proposals: string[] }) {
  return (nowMs: number) =>
    ensureIssuanceEpoch({
      store,
      nowMs,
      recalcMs: HOUR,
      windowMs: DAY,
      compute: async () => {
        calls.compute += 1;
        await new Promise((resolve) => setTimeout(resolve, 20)); // widen the race window
        return {
          epoch: {
            coordinatorId: name,
            loadIndex: 1,
            dailyPoolTokens: 2400,
            hourlyTokens: 100,
            totalWeightedContribution: 3,
            contributionCount: 2,
            createdAtMs: nowMs
          },
          allocations: [
            { accountId: "acct-1", weightedContribution: 2, allocationShare: 2 / 3, issuedTokens: 66.666667 },
            { accountId: "acct-2", weightedContribution: 1, allocationShare: 1 / 3, issuedTokens: 33.333333 }
          ]
        };
      },
      afterEpoch: async ({ epoch, created }) => {
        if (created) calls.proposals.push(`${name}:${epoch.issuanceEpochId}`);
      }
    });
}

describe.skipIf(!PG_URL)("issuance epochs on one Postgres shared by two coordinators", () => {
  let db: SharedDb;
  beforeAll(async () => { db = await twoCoordinatorsOneDatabase(); });
  afterAll(async () => { await db?.close(); });

  const counts = async () => {
    const epochs = await db.poolA.query(`SELECT count(*)::int AS n FROM issuance_epochs`);
    const allocations = await db.poolA.query(`SELECT count(*)::int AS n FROM issuance_allocations`);
    return { epochs: epochs.rows[0].n, allocations: allocations.rows[0].n };
  };

  const base = Math.floor(Date.now() / HOUR) * HOUR - 10 * HOUR;

  it("two seeds racing produce one epoch per window with one allocation set", async () => {
    const calls = { compute: 0, proposals: [] as string[] };
    const us = seed("coord-us", db.a, calls);
    const eu = seed("coord-eu", db.b, calls);
    const results = await Promise.all([us(base + 5 * 60_000), eu(base + 6 * 60_000), us(base + 7 * 60_000), eu(base + 8 * 60_000)]);

    expect(calls.compute).toBe(1);
    expect(calls.proposals).toHaveLength(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const ids = new Set(results.map((r) => r.epoch?.issuanceEpochId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe(issuanceEpochIdFor(issuanceWindow(base, HOUR, DAY)));
    for (const r of results) expect(r.allocations.map((a) => a.accountId).sort()).toEqual(["acct-1", "acct-2"]);
    expect(await counts()).toEqual({ epochs: 1, allocations: 2 });

    // The next window gets its own single epoch.
    await Promise.all([us(base + HOUR + 1_000), eu(base + HOUR + 2_000)]);
    expect(calls.compute).toBe(2);
    expect(await counts()).toEqual({ epochs: 2, allocations: 4 });
  });

  it("a restart within the same window reads the epoch back instead of writing a duplicate", async () => {
    const calls = { compute: 0, proposals: [] as string[] };
    const restarted = seed("coord-us", new PostgresStore(db.poolA), calls);
    const before = await counts();
    const result = await restarted(base + HOUR + 30 * 60_000);
    expect(result.created).toBe(false);
    expect(calls.compute).toBe(0);
    expect(result.allocations).toHaveLength(2);
    expect(await counts()).toEqual(before);
    const latest = await db.b.latestIssuanceEpoch(false, HOUR);
    expect(latest?.issuanceEpochId).toBe(issuanceEpochIdFor(issuanceWindow(base + HOUR, HOUR, DAY)));
  });

  it("read-side dedupe collapses legacy per-seed duplicates to the earliest row per window", async () => {
    // Legacy rows: each seed ticked hourly at its own offset and wrote a random-id epoch.
    const legacyBase = base - 100 * HOUR;
    const legacy = (offsetMs: number, coordinatorId: string, finalized: boolean): IssuanceEpochRecord => ({
      issuanceEpochId: randomUUID(),
      coordinatorId,
      windowStartMs: legacyBase + offsetMs - DAY,
      windowEndMs: legacyBase + offsetMs,
      loadIndex: 1,
      dailyPoolTokens: 2400,
      hourlyTokens: 100,
      totalWeightedContribution: 1,
      contributionCount: 1,
      finalized,
      createdAtMs: legacyBase + offsetMs
    });
    const rows: IssuanceEpochRecord[] = [];
    for (let h = 0; h < 3; h++) {
      rows.push(legacy(h * HOUR + 12 * 60_000, "coord-us", true));
      rows.push(legacy(h * HOUR + 47 * 60_000, "coord-eu", true));
    }
    const legacyDb = await twoCoordinatorsOneDatabase();
    try {
      for (const row of rows) await legacyDb.a.upsertIssuanceEpoch(row);
      const history = await legacyDb.b.listIssuanceEpochs(50, HOUR);
      expect(history.map((e) => e.issuanceEpochId)).toEqual([rows[4], rows[2], rows[0]].map((e) => e.issuanceEpochId));
      expect(history.every((e) => e.coordinatorId === "coord-us")).toBe(true);

      const latest = await legacyDb.a.latestIssuanceEpoch(true, HOUR);
      expect(latest?.issuanceEpochId).toBe(rows[4].issuanceEpochId);
      expect((await legacyDb.b.latestIssuanceEpoch(false, HOUR))?.issuanceEpochId).toBe(rows[4].issuanceEpochId);

      // New aligned epochs sit in their own bucket next to the legacy series.
      const calls = { compute: 0, proposals: [] as string[] };
      await seed("coord-us", legacyDb.a, calls)(legacyBase + 3 * HOUR + 5_000);
      const after = await legacyDb.b.listIssuanceEpochs(50, HOUR);
      expect(after).toHaveLength(4);
      expect(after[0].issuanceEpochId).toBe(issuanceEpochIdFor(issuanceWindow(legacyBase + 3 * HOUR, HOUR, DAY)));
    } finally {
      await legacyDb.close();
    }
  });
});
