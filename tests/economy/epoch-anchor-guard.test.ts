import { describe, expect, it } from "vitest";
import { anchorEpochOnce, type AnchorStore } from "../../src/economy/anchoring.js";
import { AnchorBroadcastRejectedError, type BitcoinAnchorProvider } from "../../src/economy/bitcoin-rpc.js";
import type { BitcoinAnchorRecord } from "../../src/common/types.js";

// #101: the issuance-epoch anchor guard looks the anchor up by epoch id / checkpoint hash (not
// "newest row", usually a stats anchor) and appends the ledger record only after a broadcast.
const CHECKPOINT = "ab".repeat(32);
const TXID = "cd".repeat(32);
const POLICY = { dailyBudgetSats: 1_000_000, maxFeeSats: 20_000, mainnetEnabled: false };

function memStore(initial: BitcoinAnchorRecord[] = [], withEpochLookup = true) {
  const rows = new Map(initial.map((r) => [r.anchorId, r]));
  const newest = (pred: (r: BitcoinAnchorRecord) => boolean) =>
    [...rows.values()].filter(pred).sort((a, b) => b.createdAtMs - a.createdAtMs)[0] ?? null;
  const store: AnchorStore & { rows: Map<string, BitcoinAnchorRecord> } = {
    rows,
    async upsertBitcoinAnchor(r) { rows.set(r.anchorId, { ...r }); },
    async latestAnchorByCheckpoint(h) { return newest((r) => r.checkpointHash === h); },
    async listPendingAnchors() { return [...rows.values()].filter((r) => r.status === "pending"); }
  };
  if (withEpochLookup) store.latestAnchorByEpoch = async (epochId) => newest((r) => r.epochId === epochId);
  return store;
}

function provider(opts: { failFirst?: boolean } = {}) {
  const broadcasts: string[] = [];
  let n = 0;
  const p: BitcoinAnchorProvider = {
    async broadcastOpReturn(dataHex) {
      broadcasts.push(dataHex);
      if (opts.failFirst && n++ === 0) throw new AnchorBroadcastRejectedError("bitcoind_rpc_error: -6 Insufficient funds");
      return { txid: TXID };
    },
    async getConfirmations() { return { confirmations: 0 }; },
    async healthCheck() { return { reachable: true, provider: "test" }; },
    async sendToMany() { throw new Error("n/a"); }
  };
  return { provider: p, broadcasts };
}

let clock = 1_000;
const deps = (p: BitcoinAnchorProvider, store: AnchorStore) => ({ provider: p, store, network: "signet" as const, now: () => clock, policy: POLICY });

const statsRow = (createdAtMs: number): BitcoinAnchorRecord => ({
  anchorId: `stats-${createdAtMs}`,
  epochId: `stats:${createdAtMs}`,
  checkpointHash: String(createdAtMs).padStart(64, "0"),
  anchorNetwork: "signet",
  txRef: "ef".repeat(32),
  status: "pending",
  createdAtMs,
  confirmations: 0
});

function counters() {
  const c = { hashes: 0, ledgerAppends: 0 };
  return {
    c,
    input: (epochId: string) => ({
      epochId,
      computeCheckpointHash: async () => { c.hashes++; return CHECKPOINT; },
      onBroadcast: async () => { c.ledgerAppends++; }
    })
  };
}

describe("anchorEpochOnce (#101)", () => {
  it("an anchored epoch is found by epoch id after newer stats anchors: no hash, no ledger append, no broadcast", async () => {
    const store = memStore();
    const { provider: p, broadcasts } = provider();
    const { c, input } = counters();
    expect((await anchorEpochOnce(deps(p, store), input("issuance-1"))).broadcast).toBe(true);
    for (const t of [2_000, 3_000, 4_000]) await store.upsertBitcoinAnchor(statsRow(t));
    for (let i = 0; i < 3; i++) {
      const again = await anchorEpochOnce(deps(p, store), input("issuance-1"));
      expect(again).toMatchObject({ broadcast: false, record: { epochId: "issuance-1", txRef: TXID } });
    }
    expect(broadcasts).toHaveLength(1);
    expect(c).toEqual({ hashes: 1, ledgerAppends: 1 });
  });

  it("an in-flight or needs_admin broadcast for the epoch blocks a second broadcast", async () => {
    for (const status of ["broadcasting", "needs_admin"] as const) {
      const store = memStore([{
        anchorId: "inflight", epochId: "issuance-2", checkpointHash: "11".repeat(32), anchorNetwork: "signet",
        txRef: "broadcasting:x", status, createdAtMs: 1
      }]);
      const { provider: p, broadcasts } = provider();
      const { c, input } = counters();
      const out = await anchorEpochOnce(deps(p, store), input("issuance-2"));
      expect(out).toMatchObject({ broadcast: false, record: { anchorId: "inflight" } });
      expect(broadcasts).toHaveLength(0);
      expect(c.ledgerAppends).toBe(0);
    }
  });

  it("no ledger append when the broadcast is rejected; exactly one on the retry that broadcasts", async () => {
    const store = memStore();
    const { provider: p } = provider({ failFirst: true });
    const { c, input } = counters();
    await expect(anchorEpochOnce(deps(p, store), input("issuance-3"))).rejects.toThrow(/Insufficient/);
    expect(c.ledgerAppends).toBe(0);
    clock += 1;
    expect((await anchorEpochOnce(deps(p, store), input("issuance-3"))).broadcast).toBe(true);
    expect(c.ledgerAppends).toBe(1);
  });

  it("a store without latestAnchorByEpoch still de-duplicates by checkpoint hash", async () => {
    const store = memStore([], false);
    const { provider: p, broadcasts } = provider();
    const { c, input } = counters();
    await anchorEpochOnce(deps(p, store), input("e"));
    await anchorEpochOnce(deps(p, store), input("e"));
    expect(broadcasts).toHaveLength(1);
    expect(c.ledgerAppends).toBe(1);
  });
});
