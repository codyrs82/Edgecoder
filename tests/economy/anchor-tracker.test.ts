import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  anchorCheckpoint,
  anchorCheckpointWithOutcome,
  isLiveAnchor,
  isTxid,
  type AnchorDeps,
  type AnchorStore
} from "../../src/economy/anchoring.js";
import {
  AnchorTracker,
  anchorTrackerTuningFromEnv,
  type AnchorTrackerConfig,
  type AnchorTrackerEvent
} from "../../src/economy/anchor-tracker.js";
import { checkpointAnchorFinality, describeAnchor } from "../../src/economy/anchor-status.js";
import {
  decodeOpReturnCheckpoint,
  encodeCheckpointForOpReturn,
  type AnchorConfirmationResult,
  type BitcoinAnchorProvider
} from "../../src/economy/bitcoin-rpc.js";
import type { BitcoinAnchorRecord } from "../../src/common/types.js";

// #46: the anchor state machine driven end to end against a mock provider that behaves like a
// node: a mempool, blocks, reorgs, evictions and outages. No network is involved.

const HOUR = 60 * 60 * 1000;
const hash = (n: number) => createHash("sha256").update(`checkpoint:${n}`).digest("hex");
const CHECKPOINT = hash(1);

/** Mock provider: an in-memory chain with a wallet. */
class FakeChain implements BitcoinAnchorProvider {
  blocks: Array<{ hash: string; txids: Set<string> }> = [];
  mempool = new Set<string>();
  /** Every transaction the wallet ever sent. */
  wallet: Array<{ txid: string; dataHex: string }> = [];
  abandoned: string[] = [];
  /** Outage: every call throws, like a node that is down. */
  down = false;
  /** Set to make the next transaction conflicted (negative confirmations). */
  conflicted = new Set<string>();
  confirmationCalls: string[] = [];
  private seq = 0;

  private guard(): void {
    if (this.down) throw new Error("connect ECONNREFUSED 127.0.0.1:38332");
  }

  async broadcastOpReturn(dataHex: string) {
    this.guard();
    const txid = createHash("sha256").update(`tx:${dataHex}:${this.seq++}`).digest("hex");
    this.wallet.push({ txid, dataHex });
    this.mempool.add(txid);
    return { txid };
  }

  async getConfirmations(txid: string): Promise<AnchorConfirmationResult> {
    this.confirmationCalls.push(txid);
    this.guard();
    if (this.conflicted.has(txid)) return { confirmed: false, confirmations: -1 };
    const index = this.blocks.findIndex((b) => b.txids.has(txid));
    if (index < 0) return { confirmed: false, confirmations: 0 };
    return { confirmed: true, confirmations: this.blocks.length - index, blockHeight: index + 1, blockHash: this.blocks[index].hash };
  }

  async isInMempool(txid: string) {
    this.guard();
    return this.mempool.has(txid);
  }

  async abandonTx(txid: string) {
    this.guard();
    if (this.mempool.has(txid) || this.blocks.some((b) => b.txids.has(txid))) {
      throw new Error("bitcoind_rpc_error: -5 Transaction not eligible for abandonment");
    }
    this.abandoned.push(txid);
  }

  async findCheckpointTx(dataHex: string) {
    this.guard();
    return this.wallet.filter((t) => t.dataHex === dataHex && !this.abandoned.includes(t.txid)).at(-1)?.txid ?? null;
  }

  async healthCheck() {
    return { reachable: !this.down, provider: "fake-chain" };
  }

  async sendToMany(): Promise<never> {
    throw new Error("n/a");
  }

  /** Mine `count` blocks; the first one takes everything in the mempool. */
  mine(count = 1, includeMempool = true): void {
    for (let i = 0; i < count; i++) {
      const txids = new Set(i === 0 && includeMempool ? this.mempool : []);
      if (i === 0 && includeMempool) this.mempool.clear();
      this.blocks.push({ hash: createHash("sha256").update(`block:${this.seq++}`).digest("hex"), txids });
    }
  }

  /**
   * Replace the last `depth` blocks with `depth + 1` new ones. Their transactions are
   * "remined" in the first new block, returned to the "mempool", or "dropped" entirely.
   */
  reorg(depth: number, fate: "remined" | "mempool" | "dropped"): void {
    const orphaned = this.blocks.splice(-depth).flatMap((b) => [...b.txids]);
    if (fate !== "dropped") for (const txid of orphaned) this.mempool.add(txid);
    this.mine(depth + 1, fate === "remined");
  }
}

type MemStore = Required<Pick<AnchorStore, "listAnchorsToReverify" | "latestLiveAnchorPerKind" | "listAnchorsToReconcile" | "countAnchorBroadcastsSince">> &
  AnchorStore & { rows: Map<string, BitcoinAnchorRecord>; all(): BitcoinAnchorRecord[] };

function memStore(initial: BitcoinAnchorRecord[] = []): MemStore {
  const rows = new Map(initial.map((r) => [r.anchorId, r]));
  const all = () => [...rows.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const kind = (r: BitcoinAnchorRecord) => (r.epochId.startsWith("stats:") ? "stats" : r.epochId.startsWith("receipts:") ? "receipts" : "issuance");
  return {
    rows,
    all,
    async upsertBitcoinAnchor(r) { rows.set(r.anchorId, { ...r }); },
    async latestAnchorByCheckpoint(h) { return all().filter((r) => r.checkpointHash === h).at(-1) ?? null; },
    async listPendingAnchors() { return all().filter((r) => r.status === "pending"); },
    async listAnchorsToReverify(below) { return all().filter((r) => r.status === "anchored" && isLiveAnchor(r) && (r.confirmations ?? 0) < below); },
    async latestLiveAnchorPerKind() {
      const newest = new Map<string, BitcoinAnchorRecord>();
      for (const r of all()) if (isLiveAnchor(r)) newest.set(kind(r), r);
      return [...newest.values()];
    },
    async listAnchorsToReconcile(pendingBeforeMs, _limit, abandonedSinceMs) {
      return all().filter(
        (r) =>
          r.status === "broadcasting" ||
          (r.status === "pending" && r.createdAtMs < pendingBeforeMs) ||
          (r.status === "failed" && r.abandonedAtMs !== undefined && r.abandonedAtMs >= (abandonedSinceMs ?? Infinity))
      );
    },
    // Like the Postgres store: every row that was (or may have been) sent, failed ones included.
    async countAnchorBroadcastsSince(sinceMs) {
      return all().filter((r) => r.createdAtMs >= sinceMs && (r.status === "broadcasting" || r.status === "needs_admin" || isTxid(r.txRef))).length;
    }
  };
}

const CONFIG: AnchorTrackerConfig = {
  requiredConfirmations: 6,
  pollMs: 600_000,
  reconcile: { maxAttempts: 5, stuckAfterMs: 6 * HOUR, abandonWatchMs: 72 * HOUR },
  reorgWatchConfirmations: 100,
  retryBaseMs: 30_000,
  maxBackoffMs: HOUR
};

function setup(opts: { store?: MemStore; chain?: FakeChain; config?: Partial<AnchorTrackerConfig>; dailyBudgetSats?: number } = {}) {
  const chain = opts.chain ?? new FakeChain();
  const store = opts.store ?? memStore();
  const clock = { ms: 1_000_000 };
  const deps: AnchorDeps = {
    provider: chain,
    store,
    network: "signet",
    now: () => clock.ms,
    policy: { dailyBudgetSats: opts.dailyBudgetSats ?? 1_000_000, maxFeeSats: 20_000, mainnetEnabled: false },
    providerName: "bitcoind"
  };
  const events: AnchorTrackerEvent[] = [];
  const assigned: BitcoinAnchorRecord[] = [];
  const tracker = new AnchorTracker({
    deps: () => deps,
    config: { ...CONFIG, ...opts.config },
    onEvent: (e) => events.push(e),
    onTxidAssigned: async (r) => { assigned.push(r); }
  });
  const names = (list: AnchorTrackerEvent[]) => list.map((e) => e.event);
  const row = async (checkpointHash = CHECKPOINT) => (await store.latestAnchorByCheckpoint(checkpointHash))!;
  return { chain, store, clock, deps, tracker, events, assigned, names, row };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("AnchorTracker: broadcast and confirmation (#46)", () => {
  it("records the provider's txid as pending at broadcast", async () => {
    const t = setup();
    const rec = await anchorCheckpoint(t.deps, { epochId: "epoch-1", checkpointHash: CHECKPOINT });
    expect(rec).toMatchObject({ status: "pending", confirmations: 0, txRef: t.chain.wallet[0].txid, anchorProvider: "bitcoind" });
    expect(rec.anchoredAtMs).toBeUndefined();
    expect(decodeOpReturnCheckpoint(t.chain.wallet[0].dataHex)).toEqual({ version: 1, checkpointHash: CHECKPOINT });
    expect(describeAnchor(rec, 6)).toMatchObject({ status: "pending", simulated: false, txRef: rec.txRef, confirmations: 0 });
  });

  it("stays pending while confirmations climb and becomes anchored only at N", async () => {
    const t = setup();
    await anchorCheckpoint(t.deps, { epochId: "epoch-1", checkpointHash: CHECKPOINT });
    const seen: Array<[string, number, string]> = [];
    const step = async () => {
      const [e] = await t.tracker.poll();
      seen.push([e.record.status, e.record.confirmations ?? 0, e.event]);
    };
    await step(); // still in the mempool
    for (let i = 0; i < 6; i++) {
      t.chain.mine();
      await step();
    }
    expect(seen).toEqual([
      ["pending", 0, "unchanged"],
      ["pending", 1, "progress"],
      ["pending", 2, "progress"],
      ["pending", 3, "progress"],
      ["pending", 4, "progress"],
      ["pending", 5, "progress"],
      ["anchored", 6, "confirmed"]
    ]);
    const rec = await t.row();
    expect(rec).toMatchObject({ status: "anchored", blockHeight: 1, blockHash: t.chain.blocks[0].hash, anchoredAtMs: t.clock.ms });
    expect(t.chain.wallet).toHaveLength(1);
  });

  it("the required depth is configurable", async () => {
    const t = setup({ config: { requiredConfirmations: 2 } });
    await anchorCheckpoint(t.deps, { epochId: "epoch-1", checkpointHash: CHECKPOINT });
    t.chain.mine();
    expect((await t.tracker.poll())[0].record.status).toBe("pending");
    t.chain.mine();
    expect((await t.tracker.poll())[0].record.status).toBe("anchored");
  });

  it("keeps watching an anchored row until it is reorgWatchConfirmations deep", async () => {
    const t = setup({ config: { reorgWatchConfirmations: 10 } });
    await anchorCheckpoint(t.deps, { epochId: "epoch-1", checkpointHash: CHECKPOINT });
    // A newer anchor, so the first one is no longer "the newest of its kind".
    await anchorCheckpoint(t.deps, { epochId: "epoch-2", checkpointHash: hash(2) });
    t.chain.mine(9);
    expect((await t.tracker.poll()).map((e) => e.record.confirmations)).toEqual([9, 9]);
    t.chain.mine(1);
    expect(await t.tracker.poll()).toHaveLength(2);
    t.chain.mine(1);
    // Both are 10 deep in the store now; only the newest of the kind is still re-verified.
    expect((await t.tracker.poll()).map((e) => e.record.epochId)).toEqual(["epoch-2"]);
  });
});

describe("AnchorTracker: reorgs (#46)", () => {
  async function anchored(t: ReturnType<typeof setup>) {
    await anchorCheckpoint(t.deps, { epochId: "epoch-1", checkpointHash: CHECKPOINT });
    t.chain.mine(6);
    await t.tracker.poll();
    const rec = await t.row();
    expect(rec.status).toBe("anchored");
    return rec;
  }

  it("confirmed -> pending when the block that held the tx is replaced", async () => {
    const t = setup();
    const before = await anchored(t);
    t.chain.reorg(6, "remined");
    const [e] = await t.tracker.poll();
    expect(e.event).toBe("reorg");
    const after = await t.row();
    expect(after).toMatchObject({ status: "pending", txRef: before.txRef, blockHash: t.chain.blocks[0].hash });
    expect(after.blockHash).not.toBe(before.blockHash);
    expect(after.anchoredAtMs).toBeUndefined();
    expect(checkpointAnchorFinality({ anchor: after, requiredConfirmations: 6, minConfirmations: 1 }).hardFinalized).toBe(false);
    // The same transaction is confirmed again in its new block; nothing is re-broadcast.
    expect(t.names(await t.tracker.poll())).toEqual(["confirmed"]);
    expect((await t.row()).status).toBe("anchored");
    expect(t.chain.wallet).toHaveLength(1);
  });

  it("confirmed -> pending when the tx falls back to the mempool, and it is not re-broadcast", async () => {
    const t = setup();
    const before = await anchored(t);
    t.chain.reorg(6, "mempool");
    expect(t.names(await t.tracker.poll())).toEqual(["reorg"]);
    expect(await t.row()).toMatchObject({ status: "pending", confirmations: 0, blockHash: undefined, blockHeight: undefined, txRef: before.txRef });
    expect(t.chain.wallet).toHaveLength(1);
    expect(t.chain.abandoned).toEqual([]);
    t.chain.mine(6);
    expect(t.names(await t.tracker.poll())).toEqual(["confirmed"]);
    expect(await t.row()).toMatchObject({ status: "anchored", txRef: before.txRef, confirmations: 6 });
  });

  it("re-broadcasts when the tx is gone from both the chain and the mempool", async () => {
    const t = setup();
    const before = await anchored(t);
    t.chain.reorg(6, "dropped");
    t.clock.ms += 1_000;
    expect(t.names(await t.tracker.poll())).toEqual(["reorg", "failed", "rebroadcast"]);

    const old = t.store.rows.get(before.anchorId)!;
    expect(old).toMatchObject({ status: "failed", txRef: before.txRef, abandonedAtMs: t.clock.ms });
    expect(t.chain.abandoned).toEqual([before.txRef]);

    const replacement = await t.row();
    expect(replacement.anchorId).not.toBe(before.anchorId);
    expect(replacement).toMatchObject({ status: "pending", checkpointHash: CHECKPOINT, epochId: "epoch-1", txRef: t.chain.wallet[1].txid });
    expect(t.chain.wallet).toHaveLength(2);
    expect(t.assigned.map((r) => r.txRef)).toEqual([replacement.txRef]);

    t.chain.mine(6);
    await t.tracker.poll();
    expect((await t.row()).status).toBe("anchored");
    expect(t.chain.wallet).toHaveLength(2);
  });

  it("re-broadcasts a transaction that was conflicted out", async () => {
    const t = setup();
    const first = await anchorCheckpoint(t.deps, { epochId: "epoch-1", checkpointHash: CHECKPOINT });
    t.chain.conflicted.add(first.txRef);
    t.clock.ms += 1_000;
    expect(t.names(await t.tracker.poll())).toEqual(["conflicted", "rebroadcast"]);
    expect(t.store.rows.get(first.anchorId)!.status).toBe("failed");
    expect(await t.row()).toMatchObject({ status: "pending", txRef: t.chain.wallet[1].txid });
  });
});

describe("AnchorTracker: dropped and stuck transactions (#46, #103)", () => {
  it("reconcile replaces a never-confirmed tx that was evicted from the mempool", async () => {
    const t = setup();
    const first = await anchorCheckpoint(t.deps, { epochId: "receipts:r1", checkpointHash: CHECKPOINT });
    t.chain.mempool.delete(first.txRef);
    // Not old enough yet: it may simply not have propagated.
    expect(await t.tracker.reconcile()).toEqual([]);
    t.clock.ms += 7 * HOUR;
    expect(t.names(await t.tracker.reconcile())).toEqual(["failed", "rebroadcast"]);
    expect(t.chain.abandoned).toEqual([first.txRef]);
    const replacement = await t.row();
    expect(replacement).toMatchObject({ status: "pending", epochId: "receipts:r1" });
    expect(replacement.txRef).not.toBe(first.txRef);
    expect(t.assigned).toEqual([replacement]);
    // Nothing left to do on the next pass.
    expect(t.names(await t.tracker.reconcile())).toEqual([]);
    expect(t.chain.wallet).toHaveLength(2);
  });

  it("leaves a tx that is still in the mempool alone, however old", async () => {
    const t = setup();
    await anchorCheckpoint(t.deps, { epochId: "epoch-1", checkpointHash: CHECKPOINT });
    t.clock.ms += 48 * HOUR;
    expect(t.names(await t.tracker.reconcile())).toEqual(["still_pending"]);
    expect(t.chain.wallet).toHaveLength(1);
    expect((await t.row()).status).toBe("pending");
  });

  it("retries a replacement the daily budget refused", async () => {
    const t = setup({ dailyBudgetSats: 20_000 }); // one broadcast per 24h
    const first = await anchorCheckpoint(t.deps, { epochId: "epoch-1", checkpointHash: CHECKPOINT });
    t.chain.mempool.delete(first.txRef);
    t.clock.ms += 7 * HOUR;
    const refused = await t.tracker.reconcile();
    expect(t.names(refused)).toEqual(["failed", "rebroadcast_failed"]);
    expect(refused[1].error).toMatch(/anchor_daily_budget_exceeded/);
    expect(t.chain.wallet).toHaveLength(1);
    t.clock.ms += 24 * HOUR;
    expect(t.names(await t.tracker.reconcile())).toContain("rebroadcast");
    expect(t.chain.wallet).toHaveLength(2);
    expect((await t.row()).status).toBe("pending");
  });

  it("does not re-broadcast a dropped stats anchor that a newer one supersedes", async () => {
    const t = setup();
    const old = await anchorCheckpoint(t.deps, { epochId: "stats:10", checkpointHash: hash(10) });
    t.clock.ms += 1_000;
    await anchorCheckpoint(t.deps, { epochId: "stats:11", checkpointHash: hash(11) });
    t.chain.mempool.delete(old.txRef);
    t.clock.ms += 7 * HOUR;
    const out = await t.tracker.reconcile();
    expect(out.filter((e) => e.record.checkpointHash === hash(10)).map((e) => e.event)).toEqual(["failed", "superseded"]);
    expect(t.chain.wallet).toHaveLength(2);
  });
});

describe("AnchorTracker: provider outage (#46)", () => {
  it("keeps the row pending, changes nothing, and backs off exponentially", async () => {
    const t = setup();
    await anchorCheckpoint(t.deps, { epochId: "epoch-1", checkpointHash: CHECKPOINT });
    const before = await t.row();
    expect(t.tracker.nextDelayMs()).toBe(600_000);

    t.chain.down = true;
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      t.clock.ms += 1_000;
      expect(t.names(await t.tracker.poll())).toEqual(["unknown"]);
      delays.push(t.tracker.nextDelayMs());
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, HOUR, HOUR]);
    expect(await t.row()).toEqual(before);
    expect(t.tracker.status()).toMatchObject({ consecutiveFailures: 9, lastError: "anchor_provider_unavailable", lastSuccessAtMs: undefined });
    expect(t.chain.wallet).toHaveLength(1);

    t.chain.down = false;
    t.chain.mine(6);
    expect(t.names(await t.tracker.poll())).toEqual(["confirmed"]);
    expect(t.tracker.status()).toMatchObject({ consecutiveFailures: 0, lastError: undefined, lastSuccessAtMs: t.clock.ms, nextPollDelayMs: 600_000 });
  });

  it("an outage is not a reorg: an anchored row stays anchored", async () => {
    const t = setup();
    await anchorCheckpoint(t.deps, { epochId: "epoch-1", checkpointHash: CHECKPOINT });
    t.chain.mine(6);
    await t.tracker.poll();
    const before = await t.row();
    t.chain.down = true;
    await t.tracker.poll();
    expect(await t.row()).toEqual(before);
    expect(before.status).toBe("anchored");
  });

  it("stops the pass at the first unanswered row", async () => {
    const t = setup();
    for (const n of [1, 2, 3]) {
      t.clock.ms += 1;
      await anchorCheckpoint(t.deps, { epochId: `epoch-${n}`, checkpointHash: hash(n) });
    }
    t.chain.down = true;
    expect(await t.tracker.poll()).toHaveLength(1);
    expect(t.chain.confirmationCalls).toHaveLength(1);
  });

  it("does not count reconcile attempts against rows while the provider is down", async () => {
    const t = setup();
    const first = await anchorCheckpoint(t.deps, { epochId: "epoch-1", checkpointHash: CHECKPOINT });
    t.chain.mempool.delete(first.txRef);
    t.clock.ms += 7 * HOUR;
    t.chain.down = true;
    await t.tracker.poll();
    for (let i = 0; i < 10; i++) expect(await t.tracker.reconcile()).toEqual([]);
    expect(await t.row()).toMatchObject({ status: "pending", txRef: first.txRef });
    expect((await t.row()).reconcileAttempts ?? 0).toBe(0);
    expect(t.chain.wallet).toHaveLength(1);
  });

  it("the loop retries on the backoff schedule and returns to the normal interval", async () => {
    vi.useFakeTimers();
    const t = setup();
    await anchorCheckpoint(t.deps, { epochId: "epoch-1", checkpointHash: CHECKPOINT });
    t.chain.down = true;
    t.tracker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.chain.confirmationCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(t.chain.confirmationCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.chain.confirmationCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.chain.confirmationCalls).toHaveLength(3);

    t.chain.down = false;
    t.chain.mine(6);
    await vi.advanceTimersByTimeAsync(120_000);
    expect((await t.row()).status).toBe("anchored");
    expect(t.chain.confirmationCalls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(t.chain.confirmationCalls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.chain.confirmationCalls).toHaveLength(5);

    t.tracker.stop();
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    expect(t.chain.confirmationCalls).toHaveLength(5);
    expect(t.chain.wallet).toHaveLength(1);
  });
});

describe("AnchorTracker: restart (#46)", () => {
  it("resumes a pending anchor from the store without broadcasting again", async () => {
    vi.useFakeTimers();
    const first = setup();
    const pending = await anchorCheckpoint(first.deps, { epochId: "epoch-1", checkpointHash: CHECKPOINT });
    first.chain.mine(2);

    // New process: same database and node, fresh tracker with no memory of the broadcast.
    const second = setup({ store: first.store, chain: first.chain });
    second.tracker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await second.row()).toMatchObject({ anchorId: pending.anchorId, txRef: pending.txRef, status: "pending", confirmations: 2 });

    // The startup anchor tick finds the live row and does not broadcast.
    const again = await anchorCheckpointWithOutcome(second.deps, { epochId: "epoch-1", checkpointHash: CHECKPOINT });
    expect(again).toMatchObject({ broadcast: false, record: { anchorId: pending.anchorId, txRef: pending.txRef } });
    expect(await second.tracker.reconcile()).toEqual([]);

    second.chain.mine(4);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(await second.row()).toMatchObject({ anchorId: pending.anchorId, txRef: pending.txRef, status: "anchored", confirmations: 6 });
    expect(second.chain.wallet).toHaveLength(1);
    expect(second.store.rows.size).toBe(1);
    second.tracker.stop();
  });

  const crashLeft = (): BitcoinAnchorRecord => ({
    anchorId: "crashed",
    epochId: "receipts:r1",
    checkpointHash: CHECKPOINT,
    anchorNetwork: "signet",
    txRef: "broadcasting:1f0e",
    status: "broadcasting",
    createdAtMs: 999_000,
    confirmations: 0,
    anchorProvider: "bitcoind"
  });

  it("recovers the txid of a broadcast the previous process did not get to record", async () => {
    const chain = new FakeChain();
    const { txid } = await chain.broadcastOpReturn(encodeCheckpointForOpReturn(CHECKPOINT));
    const t = setup({ chain, store: memStore([crashLeft()]) });
    expect(t.names(await t.tracker.reconcile())).toEqual(["recovered"]);
    expect(await t.row()).toMatchObject({ anchorId: "crashed", txRef: txid, status: "pending" });
    expect(t.assigned.map((r) => r.txRef)).toEqual([txid]);
    expect(chain.wallet).toHaveLength(1);
  });

  it("broadcasts once when the crash happened before anything was sent", async () => {
    const t = setup({ store: memStore([crashLeft()]) });
    expect(t.names(await t.tracker.reconcile())).toEqual(["failed", "rebroadcast"]);
    expect(t.store.rows.get("crashed")!.status).toBe("failed");
    expect(await t.row()).toMatchObject({ status: "pending", txRef: t.chain.wallet[0].txid, epochId: "receipts:r1" });
    expect(t.names(await t.tracker.reconcile())).toEqual([]);
    expect(t.chain.wallet).toHaveLength(1);
  });
});

describe("AnchorTracker: disabled and foreign rows (#46)", () => {
  it("does nothing when anchoring is disabled", async () => {
    const store = memStore();
    const tracker = new AnchorTracker({ deps: () => null, config: CONFIG });
    expect(await tracker.poll()).toEqual([]);
    expect(await tracker.reconcile()).toEqual([]);
    expect(store.rows.size).toBe(0);
    expect(tracker.status()).toMatchObject({ running: false, consecutiveFailures: 0 });
  });

  it("never asks a real provider about legacy, mock or other-network rows", async () => {
    const base = { checkpointHash: CHECKPOINT, anchorNetwork: "signet" as const, status: "anchored" as const, anchoredAtMs: 1, confirmations: 6 };
    const t = setup({
      store: memStore([
        { ...base, anchorId: "legacy", epochId: "e1", txRef: `anchor:signet:${CHECKPOINT.slice(0, 24)}`, createdAtMs: 1 },
        { ...base, anchorId: "mock", epochId: "e2", checkpointHash: hash(2), txRef: "ab".repeat(32), createdAtMs: 2, anchorProvider: "mock" },
        { ...base, anchorId: "testnet", epochId: "e3", checkpointHash: hash(3), txRef: "cd".repeat(32), createdAtMs: 3, anchorNetwork: "testnet" }
      ])
    });
    expect(await t.tracker.poll()).toEqual([]);
    expect(t.chain.confirmationCalls).toEqual([]);
    expect(t.store.rows.get("legacy")!.status).toBe("anchored"); // stored row untouched; labelled at read time
  });

  it("tuning from env", () => {
    expect(anchorTrackerTuningFromEnv({})).toEqual({ reorgWatchConfirmations: 100, retryBaseMs: 30_000, maxBackoffMs: HOUR });
    expect(anchorTrackerTuningFromEnv({ ANCHOR_REORG_WATCH_CONFIRMATIONS: "12", ANCHOR_POLL_RETRY_BASE_MS: "5000", ANCHOR_POLL_MAX_BACKOFF_MS: "60000" }))
      .toEqual({ reorgWatchConfirmations: 12, retryBaseMs: 5_000, maxBackoffMs: 60_000 });
    expect(anchorTrackerTuningFromEnv({ ANCHOR_POLL_RETRY_BASE_MS: "nope" }).retryBaseMs).toBe(30_000);
  });
});
