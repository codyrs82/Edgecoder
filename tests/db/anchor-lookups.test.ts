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
