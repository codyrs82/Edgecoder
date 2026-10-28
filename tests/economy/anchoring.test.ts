import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import {
  anchorCheckpoint,
  applyConfirmation,
  isTxid,
  refreshAnchor,
  refreshAnchors,
  reconcileAnchor,
  reconcileAnchors,
  reconcileConfigFromEnv,
  requiredConfirmationsFromEnv,
  type AnchorStore
} from "../../src/economy/anchoring.js";
import {
  BitcoindRpcProvider,
  anchorFeeRateSatVb,
  decodeOpReturnCheckpoint,
  type AnchorConfirmationResult,
  type BitcoinAnchorProvider
} from "../../src/economy/bitcoin-rpc.js";
import type { BitcoinAnchorRecord } from "../../src/common/types.js";

// #46: real anchoring: broadcast -> pending (real txid) -> confirmed at N -> reorg reverts.
const CHECKPOINT = "ab".repeat(32);
const TXID = "cd".repeat(32);
const BLOCK_A = "00".repeat(28) + "aaaaaaaa";
const BLOCK_B = "00".repeat(28) + "bbbbbbbb";

function memStore(initial: BitcoinAnchorRecord[] = []): AnchorStore & { rows: Map<string, BitcoinAnchorRecord> } {
  const rows = new Map(initial.map((r) => [r.anchorId, r]));
  return {
    rows,
    async upsertBitcoinAnchor(r) { rows.set(r.anchorId, { ...r }); },
    async latestAnchorByCheckpoint(h) {
      return [...rows.values()].filter((r) => r.checkpointHash === h).sort((a, b) => b.createdAtMs - a.createdAtMs)[0] ?? null;
    },
    async listPendingAnchors() { return [...rows.values()].filter((r) => r.status === "pending"); }
  };
}

/** Scripted chain: each getConfirmations() returns the next scripted state. */
function scriptedProvider(script: AnchorConfirmationResult[]) {
  const broadcasts: string[] = [];
  let i = 0;
  const provider: BitcoinAnchorProvider = {
    async broadcastOpReturn(dataHex) { broadcasts.push(dataHex); return { txid: TXID }; },
    async getConfirmations() { return script[Math.min(i++, script.length - 1)]; },
    async healthCheck() { return { reachable: true, provider: "scripted" }; },
    async sendToMany() { throw new Error("n/a"); }
  };
  return { provider, broadcasts };
}

const POLICY = { dailyBudgetSats: 1_000_000, maxFeeSats: 20_000, mainnetEnabled: false };
const deps = (provider: BitcoinAnchorProvider, store: AnchorStore) => ({ provider, store, network: "signet" as const, now: () => 1_000, policy: POLICY });

describe("anchorCheckpoint (#46)", () => {
  it("broadcasts an EC OP_RETURN and stores the real txid as pending", async () => {
    const store = memStore();
    const { provider, broadcasts } = scriptedProvider([]);
    const rec = await anchorCheckpoint(deps(provider, store), { epochId: "e1", checkpointHash: CHECKPOINT });
    expect(rec).toMatchObject({ txRef: TXID, status: "pending", confirmations: 0, anchorNetwork: "signet" });
    expect(isTxid(rec.txRef)).toBe(true);
    expect(decodeOpReturnCheckpoint(broadcasts[0])).toEqual({ version: 1, checkpointHash: CHECKPOINT });
  });

  it("doesn't re-broadcast a checkpoint that already has a real anchor", async () => {
    const store = memStore();
    const { provider, broadcasts } = scriptedProvider([]);
    await anchorCheckpoint(deps(provider, store), { epochId: "e1", checkpointHash: CHECKPOINT });
    await anchorCheckpoint(deps(provider, store), { epochId: "e1", checkpointHash: CHECKPOINT });
    expect(broadcasts).toHaveLength(1);
  });

  it("replaces a legacy simulated 'anchored' row with a real broadcast (same anchorId)", async () => {
    const legacy: BitcoinAnchorRecord = {
      anchorId: "legacy", epochId: "e1", checkpointHash: CHECKPOINT, anchorNetwork: "signet",
      txRef: `anchor:signet:${CHECKPOINT.slice(0, 24)}`, status: "anchored", anchoredAtMs: 1, createdAtMs: 1
    };
    const store = memStore([legacy]);
    const { provider, broadcasts } = scriptedProvider([]);
    const rec = await anchorCheckpoint(deps(provider, store), { epochId: "e1", checkpointHash: CHECKPOINT });
    expect(broadcasts).toHaveLength(1);
    expect(rec).toMatchObject({ anchorId: "legacy", txRef: TXID, status: "pending", anchoredAtMs: undefined });
  });

  it("rejects a provider that returns a non-txid", async () => {
    const store = memStore();
    const provider = { ...scriptedProvider([]).provider, broadcastOpReturn: async () => ({ txid: "mock-123" }) };
    await expect(anchorCheckpoint(deps(provider, store), { epochId: "e", checkpointHash: CHECKPOINT })).rejects.toThrow(/invalid_txid/);
    // Something may have been sent: the "broadcasting" row stays for reconciliation and blocks a re-send.
    expect([...store.rows.values()].map((r) => r.status)).toEqual(["broadcasting"]);
    await expect(anchorCheckpoint(deps(provider, store), { epochId: "e", checkpointHash: CHECKPOINT })).rejects.toThrow(/unreconciled/);
  });
});

describe("confirmations and reorgs (#46)", () => {
  it("pending -> confirmed only at the required depth, with block recorded", async () => {
    const store = memStore();
    const { provider } = scriptedProvider([
      { confirmed: false, confirmations: 0 },
      { confirmed: true, confirmations: 1, blockHash: BLOCK_A, blockHeight: 100 },
      { confirmed: true, confirmations: 5, blockHash: BLOCK_A, blockHeight: 100 },
      { confirmed: true, confirmations: 6, blockHash: BLOCK_A, blockHeight: 100 }
    ]);
    const d = deps(provider, store);
    let rec = await anchorCheckpoint(d, { epochId: "e", checkpointHash: CHECKPOINT });
    const events: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await refreshAnchor(d, rec, 6);
      rec = r.record;
      events.push(`${r.event}:${rec.status}:${rec.confirmations}`);
    }
    expect(events).toEqual(["unchanged:pending:0", "progress:pending:1", "progress:pending:5", "confirmed:anchored:6"]);
    expect(rec).toMatchObject({ blockHash: BLOCK_A, blockHeight: 100, anchoredAtMs: 1_000 });
    expect(store.rows.get(rec.anchorId)?.status).toBe("anchored");
  });

  it("reorg (tx drops out of the chain) reverts anchored -> pending", async () => {
    const store = memStore();
    const { provider } = scriptedProvider([
      { confirmed: true, confirmations: 6, blockHash: BLOCK_A, blockHeight: 100 },
      { confirmed: false, confirmations: 0 }
    ]);
    const d = deps(provider, store);
    let rec = await anchorCheckpoint(d, { epochId: "e", checkpointHash: CHECKPOINT });
    rec = (await refreshAnchor(d, rec, 6)).record;
    expect(rec.status).toBe("anchored");
    const r = await refreshAnchor(d, rec, 6);
    expect(r.event).toBe("reorg");
    expect(r.record).toMatchObject({ status: "pending", confirmations: 0, blockHash: undefined, anchoredAtMs: undefined });
  });

  it("reorg into a different block also reverts to pending until deep enough again", () => {
    const anchored: BitcoinAnchorRecord = {
      anchorId: "a", epochId: "e", checkpointHash: CHECKPOINT, anchorNetwork: "signet", txRef: TXID,
      status: "anchored", anchoredAtMs: 5, createdAtMs: 1, confirmations: 7, blockHash: BLOCK_A, blockHeight: 100
    };
    const r = applyConfirmation(anchored, { confirmed: true, confirmations: 1, blockHash: BLOCK_B, blockHeight: 101 }, 6, 9);
    expect(r.event).toBe("reorg");
    expect(r.record).toMatchObject({ status: "pending", confirmations: 1, blockHash: BLOCK_B, blockHeight: 101 });
    const again = applyConfirmation(r.record, { confirmed: true, confirmations: 6, blockHash: BLOCK_B, blockHeight: 101 }, 6, 10);
    expect(again).toMatchObject({ event: "confirmed", record: { status: "anchored", anchoredAtMs: 10 } });
  });

  it("refreshAnchors polls pending rows and re-checks recent anchored ones; legacy rows are left alone", async () => {
    const legacy: BitcoinAnchorRecord = {
      anchorId: "legacy", epochId: "old", checkpointHash: "ee".repeat(32), anchorNetwork: "signet",
      txRef: "anchor:signet:deadbeef", status: "anchored", createdAtMs: 0
    };
    const store = memStore([legacy]);
    const { provider } = scriptedProvider([{ confirmed: true, confirmations: 6, blockHash: BLOCK_A, blockHeight: 1 }]);
    const d = deps(provider, store);
    const rec = await anchorCheckpoint(d, { epochId: "e", checkpointHash: CHECKPOINT });
    const out = await refreshAnchors(d, 6, [legacy, rec]);
    expect(out).toEqual([{ anchorId: rec.anchorId, event: "confirmed" }, { anchorId: "legacy", event: "unchanged" }]);
  });

  it("required confirmations config", () => {
    expect(requiredConfirmationsFromEnv({})).toBe(6);
    expect(requiredConfirmationsFromEnv({ BITCOIN_ANCHOR_CONFIRMATIONS: "3" })).toBe(3);
    expect(requiredConfirmationsFromEnv({ BITCOIN_ANCHOR_CONFIRMATIONS: "0" })).toBe(6);
  });
});

describe("bitcoind coin selection (#46)", () => {
  let original: Dispatcher;
  let agent: MockAgent;
  beforeEach(() => {
    original = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });
  afterEach(async () => {
    setGlobalDispatcher(original);
    await agent.close();
    delete process.env.BITCOIN_ANCHOR_MAX_FEE_SATS;
  });

  function rpcMock(fundedFeeBtc: number) {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const results: Record<string, unknown> = {
      createrawtransaction: "rawtx0",
      estimatesmartfee: { feerate: 0.00001 }, // 1 sat/vB -> floored to 2
      fundrawtransaction: { hex: "funded", fee: fundedFeeBtc, changepos: 1 },
      signrawtransactionwithwallet: { hex: "signed", complete: true },
      sendrawtransaction: TXID
    };
    agent.get("http://btc.test:38332").intercept({ path: /.*/, method: "POST" }).reply(200, (opts) => {
      const body = JSON.parse(String(opts.body));
      calls.push({ method: body.method, params: body.params });
      return { result: results[body.method] ?? null, error: null };
    }).persist();
    return calls;
  }

  it("uses fundrawtransaction (wallet coin selection + change) with a fee floor", async () => {
    const calls = rpcMock(0.000004);
    const p = new BitcoindRpcProvider("http://btc.test:38332", "u", "p", "anchor");
    const res = await p.broadcastOpReturn("4543" + "01" + CHECKPOINT);
    expect(res.txid).toBe(TXID);
    expect(calls.map((c) => c.method)).toEqual([
      "createrawtransaction", "estimatesmartfee", "fundrawtransaction", "signrawtransactionwithwallet", "sendrawtransaction"
    ]);
    expect(calls[0].params).toEqual([[], [{ data: "4543" + "01" + CHECKPOINT }]]);
    expect(calls[2].params[1]).toEqual({ fee_rate: 2, replaceable: true });
    expect(calls.some((c) => c.method === "listunspent")).toBe(false);
  });

  it("refuses to broadcast above the absolute fee cap", async () => {
    process.env.BITCOIN_ANCHOR_MAX_FEE_SATS = "1000";
    const calls = rpcMock(0.0001); // 10_000 sats
    const p = new BitcoindRpcProvider("http://btc.test:38332", "u", "p", "anchor");
    await expect(p.broadcastOpReturn("4543" + "01" + CHECKPOINT)).rejects.toThrow(/fee_too_high/);
    expect(calls.some((c) => c.method === "sendrawtransaction")).toBe(false);
  });

  it("fee rate = max(estimate, floor)", () => {
    expect(anchorFeeRateSatVb(undefined, {})).toBe(2);
    expect(anchorFeeRateSatVb(0.00025, {})).toBe(25);
    expect(anchorFeeRateSatVb(0.00001, { BITCOIN_ANCHOR_MIN_FEE_SAT_VB: "5" })).toBe(5);
  });
});

describe("anchoring review fixes (#46)", () => {
  const anchored = (): BitcoinAnchorRecord => ({
    anchorId: "a1", epochId: "e", checkpointHash: CHECKPOINT, anchorNetwork: "signet", txRef: TXID,
    status: "anchored", anchoredAtMs: 500, createdAtMs: 1, confirmations: 6, blockHash: BLOCK_A, blockHeight: 100
  });

  it("an unreachable node is not a reorg: last known state is kept and nothing is written", async () => {
    const store = memStore([anchored()]);
    const provider = { ...scriptedProvider([]).provider, getConfirmations: async () => { throw new Error("ECONNREFUSED"); } };
    const r = await refreshAnchor(deps(provider, store), anchored(), 6);
    expect(r.event).toBe("unknown");
    expect(store.rows.get("a1")).toMatchObject({ status: "anchored", confirmations: 6, blockHash: BLOCK_A, anchoredAtMs: 500 });
  });

  it("bitcoind: RPC -5 (unknown txid) is a definite miss, other RPC errors throw", async () => {
    const original = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    try {
      const pool = agent.get("http://btc.test:38332");
      pool.intercept({ path: /.*/, method: "POST" }).reply(200, { result: null, error: { code: -5, message: "Invalid or non-wallet transaction id" } });
      pool.intercept({ path: /.*/, method: "POST" }).reply(200, { result: null, error: { code: -18, message: "Requested wallet does not exist or is not loaded" } });
      const p = new BitcoindRpcProvider("http://btc.test:38332", "u", "p", "anchor");
      await expect(p.getConfirmations(TXID)).resolves.toEqual({ confirmed: false, confirmations: 0 });
      await expect(p.getConfirmations(TXID)).rejects.toThrow(/-18/);
    } finally {
      setGlobalDispatcher(original);
      await agent.close();
    }
  });

  it("concurrent anchorCheckpoint calls broadcast once", async () => {
    const store = memStore();
    const { provider, broadcasts } = scriptedProvider([]);
    const d = deps(provider, store);
    const recs = await Promise.all([1, 2, 3, 4].map(() => anchorCheckpoint(d, { epochId: "e", checkpointHash: CHECKPOINT })));
    expect(broadcasts).toHaveLength(1);
    expect(new Set(recs.map((r) => r.anchorId)).size).toBe(1);
  });

  it("a failed broadcast is marked failed and can be retried", async () => {
    const store = memStore();
    let n = 0;
    const provider = { ...scriptedProvider([]).provider, broadcastOpReturn: async () => { if (n++ === 0) throw new Error("insufficient funds"); return { txid: TXID }; } };
    await expect(anchorCheckpoint(deps(provider, store), { epochId: "e", checkpointHash: CHECKPOINT })).rejects.toThrow(/insufficient/);
    expect([...store.rows.values()][0].status).toBe("failed");
    const rec = await anchorCheckpoint(deps(provider, store), { epochId: "e", checkpointHash: CHECKPOINT });
    expect(rec).toMatchObject({ status: "pending", txRef: TXID });
  });

  it("mainnet needs an explicit opt-in", async () => {
    const { provider, broadcasts } = scriptedProvider([]);
    const d = { ...deps(provider, memStore()), network: "bitcoin" as const };
    await expect(anchorCheckpoint(d, { epochId: "e", checkpointHash: CHECKPOINT })).rejects.toThrow(/mainnet_not_enabled/);
    expect(broadcasts).toHaveLength(0);
    const ok = await anchorCheckpoint({ ...d, policy: { ...POLICY, mainnetEnabled: true } }, { epochId: "e", checkpointHash: "ef".repeat(32) });
    expect(ok.status).toBe("pending");
  });

  it("daily budget refuses broadcasts past (count + 1) x maxFeeSats", async () => {
    const store = Object.assign(memStore(), { countAnchorBroadcastsSince: async () => 2 });
    const { provider, broadcasts } = scriptedProvider([]);
    const d = { ...deps(provider, store), policy: { ...POLICY, dailyBudgetSats: 60_000 } };
    await expect(anchorCheckpoint(d, { epochId: "e", checkpointHash: CHECKPOINT })).resolves.toMatchObject({ status: "pending" });
    const tight = { ...d, policy: { ...POLICY, dailyBudgetSats: 59_999 } };
    await expect(anchorCheckpoint(tight, { epochId: "e", checkpointHash: "ef".repeat(32) })).rejects.toThrow(/daily_budget/);
    expect(broadcasts).toHaveLength(1);
  });

  it("negative confirmations (conflicted / replaced) mark the anchor failed", () => {
    const r = applyConfirmation(anchored(), { confirmed: false, confirmations: -1 }, 6, 2_000);
    expect(r.event).toBe("conflicted");
    expect(r.record.status).toBe("failed");
  });
});

describe("reconciliation (#103)", () => {
  const CFG = { maxAttempts: 3, stuckAfterMs: 60_000 };
  const inflight = (over: Partial<BitcoinAnchorRecord> = {}): BitcoinAnchorRecord => ({
    anchorId: "b1", epochId: "e", checkpointHash: CHECKPOINT, anchorNetwork: "signet",
    txRef: "broadcasting:x", status: "broadcasting", createdAtMs: 1, confirmations: 0, ...over
  });
  const withLookup = (find: () => Promise<string | null>, conf: AnchorConfirmationResult = { confirmed: false, confirmations: 0 }) => ({
    ...scriptedProvider([conf]).provider,
    findCheckpointTx: find
  });

  it("recovers the txid of a crash-left broadcast and refreshes it (straight to anchored when deep)", async () => {
    const store = memStore([inflight()]);
    let asked = "";
    const provider = withLookup(async () => TXID, { confirmed: true, confirmations: 6, blockHash: BLOCK_A, blockHeight: 9 });
    provider.findCheckpointTx = async (hex: string) => { asked = hex; return TXID; };
    expect(await reconcileAnchor(deps(provider, store), inflight(), 6, CFG)).toBe("recovered");
    expect(decodeOpReturnCheckpoint(asked)).toEqual({ version: 1, checkpointHash: CHECKPOINT });
    expect(store.rows.get("b1")).toMatchObject({ txRef: TXID, status: "anchored", confirmations: 6 });
  });

  it("a broadcast the wallet never sent is marked failed so it is re-anchored", async () => {
    const store = memStore([inflight()]);
    expect(await reconcileAnchor(deps(withLookup(async () => null), store), inflight(), 6, CFG)).toBe("failed");
    expect(store.rows.get("b1")?.status).toBe("failed");
  });

  it("lookup errors count attempts; after maxAttempts the row is flagged needs_admin and never re-broadcast", async () => {
    const store = memStore([inflight()]);
    const provider = withLookup(async () => { throw new Error("ECONNREFUSED"); });
    const events: string[] = [];
    for (let i = 0; i < 4; i += 1) events.push(await reconcileAnchor(deps(provider, store), store.rows.get("b1")!, 6, CFG));
    expect(events).toEqual(["retry_later", "retry_later", "needs_admin", "skipped"]);
    expect(store.rows.get("b1")).toMatchObject({ status: "needs_admin", reconcileAttempts: 3 });
    const sp = scriptedProvider([]);
    await expect(anchorCheckpoint(deps(sp.provider, store), { epochId: "e", checkpointHash: CHECKPOINT })).rejects.toThrow(/unreconciled/);
    expect(sp.broadcasts).toHaveLength(0);
  });

  it("a stuck pending tx that left the mempool is marked failed; one still in the mempool is kept", async () => {
    const stuck: BitcoinAnchorRecord = { ...inflight(), txRef: TXID, status: "pending" };
    const mk = (inMempool: boolean) => ({ ...scriptedProvider([{ confirmed: false, confirmations: 0 }]).provider, isInMempool: async () => inMempool });
    const d = (p: BitcoinAnchorProvider, st: AnchorStore) => ({ ...deps(p, st), now: () => 1 + CFG.stuckAfterMs });
    const s1 = memStore([stuck]);
    expect(await reconcileAnchor(d(mk(true), s1), stuck, 6, CFG)).toBe("still_pending");
    expect(s1.rows.get("b1")?.status).toBe("pending");
    const s2 = memStore([stuck]);
    expect(await reconcileAnchor(d(mk(false), s2), stuck, 6, CFG)).toBe("failed");
    expect(s2.rows.get("b1")?.status).toBe("failed");
  });

  it("reconcileAnchors walks the store's reconcile list", async () => {
    const store = Object.assign(memStore([inflight()]), {
      async listAnchorsToReconcile() { return [...store.rows.values()].filter((r) => r.status === "broadcasting"); }
    });
    const out = await reconcileAnchors(deps(withLookup(async () => null), store), 6, CFG);
    expect(out).toEqual([{ anchorId: "b1", event: "failed" }]);
  });

  it("config from env", () => {
    expect(reconcileConfigFromEnv({})).toEqual({ maxAttempts: 5, stuckAfterMs: 6 * 60 * 60 * 1000 });
    expect(reconcileConfigFromEnv({ ANCHOR_RECONCILE_MAX_ATTEMPTS: "2", ANCHOR_STUCK_AFTER_MS: "120000" })).toEqual({ maxAttempts: 2, stuckAfterMs: 120_000 });
  });
});
