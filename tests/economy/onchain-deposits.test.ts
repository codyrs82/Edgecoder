import { describe, expect, it } from "vitest";
import { MockOnchainWallet, onchainConfigFromEnv, type OnchainConfig } from "../../src/economy/onchain.js";
import { DepositWatcher, MemoryOnchainDepositStore, depositIntentId, type DepositCredit } from "../../src/economy/onchain-deposits.js";

function setup(over: Partial<OnchainConfig> = {}, feeBps = 0) {
  const config: OnchainConfig = { ...onchainConfigFromEnv("regtest", { ONCHAIN_ENABLED: "1" }), depositConfirmations: 3, depositMinSats: 10_000, ...over };
  const wallet = new MockOnchainWallet("regtest");
  const credited: Array<{ accountId: string; credit: DepositCredit; amountSats: number }> = [];
  const store = new MemoryOnchainDepositStore((accountId, credit, amountSats) => {
    credited.push({ accountId, credit, amountSats });
  });
  const events: Array<{ event: string; details: Record<string, unknown> }> = [];
  let now = 1_000_000;
  const watcher = new DepositWatcher({ store, wallet, config, coordinatorId: "coord-1", purchaseFeeBps: feeBps, now: () => now, onSecurityEvent: (event, details) => events.push({ event, details }) });
  return { config, wallet, store, watcher, credited, events, advance: (ms: number) => (now += ms) };
}

describe("deposit addresses", () => {
  it("keeps one address until it is used, then hands out a fresh one (old ones stay watched)", async () => {
    const t = setup();
    const a1 = await t.watcher.depositAddress("acct-a");
    expect(a1.address).toMatch(/^bcrt1p/);
    expect((await t.watcher.depositAddress("acct-a")).address).toBe(a1.address);
    t.wallet.receive(a1.address, 50_000, 0);
    await t.watcher.tick();
    const a2 = await t.watcher.depositAddress("acct-a");
    expect(a2.address).not.toBe(a1.address);
    // A late payment to the first address is still the account's.
    t.wallet.receive(a1.address, 20_000, 3);
    await t.watcher.tick();
    expect((await t.store.listDeposits("acct-a", 10)).map((d) => d.amountSats).sort()).toEqual([20_000, 50_000]);
  });

  it("each account gets its own address", async () => {
    const t = setup();
    expect((await t.watcher.depositAddress("acct-a")).address).not.toBe((await t.watcher.depositAddress("acct-b")).address);
  });
});

describe("crediting", () => {
  it("shows a pending deposit with its confirmations and credits it once at N confirmations", async () => {
    const t = setup();
    const { address } = await t.watcher.depositAddress("acct-a");
    const txid = t.wallet.receive(address, 40_000, 0);
    await t.watcher.tick();
    expect(await t.store.getDeposit(txid, 0)).toMatchObject({ status: "pending", confirmations: 0, accountId: "acct-a" });
    t.wallet.mine(2);
    await t.watcher.tick();
    expect(await t.store.getDeposit(txid, 0)).toMatchObject({ status: "pending", confirmations: 2 });
    expect(t.credited).toHaveLength(0);
    t.wallet.mine(1);
    expect(await t.watcher.tick()).toMatchObject({ credited: 1 });
    expect(t.credited).toEqual([{ accountId: "acct-a", amountSats: 40_000, credit: expect.objectContaining({ intentId: depositIntentId(txid, 0), feeSats: 0, netSats: 40_000 }) }]);
    // Seen again and again: never credited twice.
    t.wallet.mine(5);
    await t.watcher.tick();
    await t.watcher.tick();
    expect(t.credited).toHaveLength(1);
    expect(await t.store.getDeposit(txid, 0)).toMatchObject({ status: "credited" });
  });

  it("is idempotent per txid:vout even with two watchers on one store", async () => {
    const t = setup({ depositConfirmations: 1 });
    const second = new DepositWatcher({ store: t.store, wallet: t.wallet, config: t.config, coordinatorId: "coord-2" });
    const { address } = await t.watcher.depositAddress("acct-a");
    t.wallet.receive(address, 30_000, 1, 0);
    t.wallet.receive(address, 30_000, 1, 1);
    const [r1, r2] = await Promise.all([t.watcher.tick(), second.tick()]);
    // One holds the watcher lock; the other is turned away.
    expect([r1, r2].filter((r) => "skipped" in r && r.skipped === "locked")).toHaveLength(1);
    await second.tick();
    await t.watcher.tick();
    expect(t.credited).toHaveLength(2);
    expect(new Set(t.credited.map((c) => c.credit.intentId)).size).toBe(2);
  });

  it("refuses dust below the minimum and keeps it out of the ledger", async () => {
    const t = setup({ depositMinSats: 10_000, depositConfirmations: 1 });
    const { address } = await t.watcher.depositAddress("acct-a");
    const txid = t.wallet.receive(address, 9_999, 0);
    expect(await t.watcher.tick()).toMatchObject({ belowMinimum: 1 });
    t.wallet.mine(6);
    await t.watcher.tick();
    expect(await t.store.getDeposit(txid, 0)).toMatchObject({ status: "below_minimum" });
    expect(t.credited).toHaveLength(0);
    expect(await t.store.uncreditedDepositSats()).toBe(9_999);
  });

  it("applies a purchase fee like a Lightning purchase when the coordinator sets one", async () => {
    const t = setup({ depositConfirmations: 1 }, 150);
    const { address } = await t.watcher.depositAddress("acct-a");
    t.wallet.receive(address, 20_000, 1);
    await t.watcher.tick();
    expect(t.credited[0].credit).toMatchObject({ feeBps: 150, feeSats: 300, netSats: 19_700 });
  });

  it("does nothing while disabled", async () => {
    const t = setup({ enabled: false });
    expect(await t.watcher.tick()).toEqual({ skipped: "disabled" });
  });
});

describe("caps", () => {
  it("holds a deposit above the per-deposit cap for an operator, who can then credit it", async () => {
    const t = setup({ depositConfirmations: 1, depositMaxSats: 100_000 });
    const { address } = await t.watcher.depositAddress("acct-a");
    const txid = t.wallet.receive(address, 150_000, 1);
    expect(await t.watcher.tick()).toMatchObject({ held: 1, credited: 0 });
    expect(t.events).toEqual([{ event: "onchain_deposit_held", details: expect.objectContaining({ txid, amountSats: 150_000 }) }]);
    expect(await t.store.uncreditedDepositSats()).toBe(150_000);
    await t.watcher.tick();
    expect(t.credited).toHaveLength(0);
    expect(await t.watcher.releaseHeld(txid, 0)).toEqual({ ok: true });
    expect(await t.watcher.releaseHeld(txid, 0)).toEqual({ ok: false, code: "not_held" });
    expect(t.credited).toHaveLength(1);
    expect(await t.store.uncreditedDepositSats()).toBe(0);
  });

  it("holds deposits beyond the per-account 24 h cap", async () => {
    const t = setup({ depositConfirmations: 1, depositMaxAccountDailySats: 50_000 });
    const { address } = await t.watcher.depositAddress("acct-a");
    t.wallet.receive(address, 30_000, 1, 0);
    await t.watcher.tick();
    const second = t.wallet.receive(address, 30_000, 1, 1);
    await t.watcher.tick();
    expect(await t.store.getDeposit(second, 1)).toMatchObject({ status: "held" });
    // Another account is not affected.
    const b = await t.watcher.depositAddress("acct-b");
    t.wallet.receive(b.address, 30_000, 1);
    await t.watcher.tick();
    expect(t.credited.map((c) => c.accountId)).toEqual(["acct-a", "acct-b"]);
  });
});

describe("transactions that disappear", () => {
  it("drops a pending deposit that leaves the wallet before confirming, and revives it if it comes back", async () => {
    const t = setup();
    const { address } = await t.watcher.depositAddress("acct-a");
    const txid = t.wallet.receive(address, 40_000, 0);
    await t.watcher.tick();
    const tx = t.wallet.txs.find((x) => x.txid === txid)!;
    t.wallet.drop(txid);
    expect(await t.watcher.tick()).toMatchObject({ dropped: 1 });
    expect(await t.store.getDeposit(txid, 0)).toMatchObject({ status: "dropped" });
    expect(await t.store.uncreditedDepositSats()).toBe(0);
    t.wallet.txs.push(tx);
    await t.watcher.tick();
    expect(await t.store.getDeposit(txid, 0)).toMatchObject({ status: "pending" });
  });

  it("a reorg that lowers confirmations below N delays the credit", async () => {
    const t = setup({ depositConfirmations: 3 });
    const { address } = await t.watcher.depositAddress("acct-a");
    const txid = t.wallet.receive(address, 40_000, 2);
    await t.watcher.tick();
    const tx = t.wallet.txs.find((x) => x.txid === txid)!;
    tx.confirmations = 0;
    tx.blockHeight = 0;
    await t.watcher.tick();
    expect(await t.store.getDeposit(txid, 0)).toMatchObject({ status: "pending", confirmations: 0 });
    t.wallet.mine(3);
    await t.watcher.tick();
    expect(t.credited).toHaveLength(1);
  });

  it("reports a credited deposit that vanishes from the chain (deep reorg) as reversed", async () => {
    const t = setup({ depositConfirmations: 1 });
    const { address } = await t.watcher.depositAddress("acct-a");
    const txid = t.wallet.receive(address, 40_000, 1);
    await t.watcher.tick();
    t.wallet.drop(txid);
    expect(await t.watcher.tick()).toMatchObject({ reversed: 1 });
    expect(await t.store.getDeposit(txid, 0)).toMatchObject({ status: "reversed" });
    expect(t.events.map((e) => e.event)).toContain("onchain_deposit_reversed");
  });

  it("ignores outputs to addresses that are not deposit addresses (change, channel closes)", async () => {
    const t = setup({ depositConfirmations: 1 });
    t.wallet.receive("bcrt1qnotadepositaddress", 40_000, 1);
    expect(await t.watcher.tick()).toMatchObject({ seen: 0 });
  });
});
