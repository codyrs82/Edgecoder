import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { twoCoordinatorsOneDatabase, PG_URL, type SharedDb } from "../helpers/shared-pg.js";
import { anchorEpochOnce } from "../../src/economy/anchoring.js";
import type { BitcoinAnchorProvider } from "../../src/economy/bitcoin-rpc.js";
import type { BitcoinAnchorRecord } from "../../src/common/types.js";

// #101 against real Postgres: anchors looked up by epoch id, and the newest live anchor per kind.
const row = (anchorId: string, epochId: string, createdAtMs: number, over: Partial<BitcoinAnchorRecord> = {}): BitcoinAnchorRecord => ({
  anchorId,
  epochId,
  checkpointHash: anchorId.padEnd(64, "0").slice(0, 64),
  anchorNetwork: "signet",
  txRef: createdAtMs.toString(16).padStart(64, "a"),
  status: "pending",
  createdAtMs,
  confirmations: 0,
  ...over
});

describe.skipIf(!PG_URL)("anchor lookups (#101, Postgres)", () => {
  let db: SharedDb;
  beforeAll(async () => {
    db = await twoCoordinatorsOneDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  it("latestAnchorByEpoch and latestLiveAnchorPerKind", async () => {
    const s = db.a;
    await s.upsertBitcoinAnchor(row("iss1", "issuance-1", 100, { status: "anchored", confirmations: 6 }));
    await s.upsertBitcoinAnchor(row("rcp1", "receipts:r1", 150));
    // Many newer stats anchors push the issuance anchor out of the newest 5.
    for (let i = 0; i < 8; i++) await s.upsertBitcoinAnchor(row(`st${i}`, `stats:${i}`, 200 + i));
    // A failed and a legacy simulated row are never "live".
    await s.upsertBitcoinAnchor(row("iss2f", "issuance-2", 300, { status: "failed" }));
    await s.upsertBitcoinAnchor(row("iss3s", "issuance-3", 301, { txRef: "anchor:signet:legacy", status: "anchored" }));

    expect((await s.latestAnchorByEpoch("issuance-1"))?.anchorId).toBe("iss1");
    expect((await s.latestAnchorByEpoch("issuance-2"))?.status).toBe("failed");
    expect(await s.latestAnchorByEpoch("nope")).toBeNull();

    expect((await s.listAnchors(5)).map((a) => a.anchorId)).not.toContain("iss1");
    const perKind = await s.latestLiveAnchorPerKind();
    expect(perKind.map((a) => a.anchorId).sort()).toEqual(["iss1", "rcp1", "st7"]);
  });

  it("the epoch guard on Postgres broadcasts once despite newer stats rows", async () => {
    const s = db.b;
    const broadcasts: string[] = [];
    const provider: BitcoinAnchorProvider = {
      async broadcastOpReturn(d) { broadcasts.push(d); return { txid: "cd".repeat(32) }; },
      async getConfirmations() { return { confirmations: 0 }; },
      async healthCheck() { return { reachable: true, provider: "t" }; },
      async sendToMany() { throw new Error("n/a"); }
    };
    let clock = 10_000;
    const deps = { provider, store: s, network: "signet" as const, now: () => clock, policy: { dailyBudgetSats: 1_000_000, maxFeeSats: 1, mainnetEnabled: false } };
    let appends = 0;
    const input = { epochId: "issuance-pg", computeCheckpointHash: async () => "ef".repeat(32), onBroadcast: async () => { appends++; } };
    expect((await anchorEpochOnce(deps, input)).broadcast).toBe(true);
    for (let i = 0; i < 6; i++) await s.upsertBitcoinAnchor(row(`pgst${i}`, `stats:pg${i}`, 20_000 + i));
    clock = 30_000;
    expect((await anchorEpochOnce(deps, input)).broadcast).toBe(false);
    expect(broadcasts).toHaveLength(1);
    expect(appends).toBe(1);
  });
});

// #46 against real Postgres: the provider column and the rows the tracker re-verifies for reorgs.
describe.skipIf(!PG_URL)("anchor tracker queries (#46, Postgres)", () => {
  let db: SharedDb;
  beforeAll(async () => {
    db = await twoCoordinatorsOneDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  it("stores the provider and keeps it when a later write omits it", async () => {
    const s = db.a;
    await s.upsertBitcoinAnchor(row("prov1", "issuance-p", 100, { anchorProvider: "bitcoind" }));
    expect((await s.latestAnchorByEpoch("issuance-p"))?.anchorProvider).toBe("bitcoind");
    await s.upsertBitcoinAnchor(row("prov1", "issuance-p", 100, { status: "anchored", confirmations: 6 }));
    expect(await s.latestAnchorByEpoch("issuance-p")).toMatchObject({ status: "anchored", anchorProvider: "bitcoind" });
    // Rows written before the column existed read back without a provider.
    await s.upsertBitcoinAnchor(row("prov0", "issuance-old", 50));
    expect((await s.latestAnchorByEpoch("issuance-old"))?.anchorProvider).toBeUndefined();
  });

  it("listAnchorsToReverify: anchored real txids below the watch depth, least recently checked first", async () => {
    const s = db.b;
    const anchored = (id: string, confirmations: number, lastCheckedAtMs?: number, over: Partial<BitcoinAnchorRecord> = {}) =>
      row(id, `stats:${id}`, 1_000 + confirmations, { status: "anchored", confirmations, lastCheckedAtMs, ...over });
    await s.upsertBitcoinAnchor(anchored("rv-new", 6, 900));
    await s.upsertBitcoinAnchor(anchored("rv-old", 40, 100));
    await s.upsertBitcoinAnchor(anchored("rv-never", 7));
    await s.upsertBitcoinAnchor(anchored("rv-deep", 100, 50));
    await s.upsertBitcoinAnchor(anchored("rv-legacy", 0, 10, { txRef: "anchor:signet:legacy" }));
    await s.upsertBitcoinAnchor(row("rv-pending", "stats:rv-pending", 2_000, { confirmations: 2 }));
    await s.upsertBitcoinAnchor(row("rv-failed", "stats:rv-failed", 2_001, { status: "failed", confirmations: 3 }));

    const ids = (await s.listAnchorsToReverify(100)).map((a) => a.anchorId).filter((id) => id.startsWith("rv-"));
    expect(ids).toEqual(["rv-never", "rv-old", "rv-new"]);
    expect((await s.listAnchorsToReverify(100, 1)).map((a) => a.anchorId)).toHaveLength(1);
    expect((await s.listAnchorsToReverify(7)).map((a) => a.anchorId).filter((id) => id.startsWith("rv-"))).toEqual(["rv-new"]);
  });
});
