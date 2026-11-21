// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { BitcoinNetwork } from "../common/types.js";
import type { ChainTransaction, OnchainConfig, OnchainWallet } from "./onchain.js";
import type { FeePoolLockResult } from "./payout-service.js";

/**
 * Funding with Bitcoin on-chain (docs/economy-math.md "On-chain"). Each account has a deposit
 * address from the coordinator's LND wallet. The watcher reads the wallet's transactions, records
 * every output paid to a deposit address as a deposit (keyed by txid:vout, so a deposit is credited
 * at most once however often it is seen), and credits it once it has ONCHAIN_DEPOSIT_CONFIRMATIONS.
 *
 * Deposit states:
 *   pending        seen, waiting for confirmations (shown to the user with the count)
 *   credited       cSats added (a settled payment intent `onchain:<txid>:<vout>` plus its credit row)
 *   below_minimum  under ONCHAIN_DEPOSIT_MIN_SATS: kept by the node, not credited
 *   held           over a per-deposit or per-account 24 h cap: waits for an operator to credit it
 *   dropped        left the wallet before confirming (replaced, double-spent, reorged out); a
 *                  dropped deposit that reappears goes back to pending
 *   reversed       credited, then gone from the chain (a reorg deeper than the confirmations):
 *                  reported as a security event; reconciliation pauses payouts on the balance drop
 *
 * One watcher runs at a time across coordinators sharing the database (an advisory lock); the
 * credit itself is a compare-and-set on the deposit row, so even two watchers could not credit twice.
 */

export type DepositStatus = "pending" | "credited" | "below_minimum" | "held" | "dropped" | "reversed";

export interface DepositAddress {
  address: string;
  accountId: string;
  network: BitcoinNetwork;
  createdAtMs: number;
  /** First time a deposit to this address was seen; the account gets a fresh address after that. */
  usedAtMs: number | null;
}

export interface OnchainDeposit {
  txid: string;
  vout: number;
  accountId: string;
  address: string;
  amountSats: number;
  confirmations: number;
  blockHeight: number;
  status: DepositStatus;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  creditedAtMs: number | null;
  detail: string | null;
}

export interface DepositCredit {
  /** `onchain:<txid>:<vout>`: the payment intent id and invoice ref of the credited deposit. */
  intentId: string;
  coordinatorId: string;
  network: BitcoinNetwork;
  feeBps: number;
  feeSats: number;
  netSats: number;
  nowMs: number;
}

export interface OnchainDepositStore {
  /** The account's newest deposit address (used or not), or null. */
  latestDepositAddress(accountId: string): Promise<DepositAddress | null>;
  addDepositAddress(address: DepositAddress): Promise<void>;
  /** Owner of each of these addresses that is a deposit address. */
  depositAccounts(addresses: string[]): Promise<Map<string, { accountId: string; usedAtMs: number | null }>>;
  markAddressUsed(address: string, atMs: number): Promise<void>;
  /**
   * Insert a newly seen deposit as pending, or refresh confirmations / height / lastSeen of a known
   * one. A dropped deposit seen again becomes pending. Returns the stored row.
   */
  observeDeposit(seen: Omit<OnchainDeposit, "status" | "creditedAtMs" | "detail" | "lastSeenAtMs">, nowMs: number): Promise<OnchainDeposit>;
  /** Compare-and-set on the status. Returns false when the row was not in one of `from`. */
  setDepositStatus(txid: string, vout: number, from: DepositStatus[], to: DepositStatus, detail?: string | null): Promise<boolean>;
  /**
   * Atomically: pending (or held, for an operator release) -> credited, the settled payment intent
   * and the account's credit row. "already" when the deposit was not creditable (another watcher, a repeat).
   */
  creditDeposit(txid: string, vout: number, credit: DepositCredit, from: DepositStatus[]): Promise<"credited" | "already">;
  /** Sats credited from on-chain deposits to the account since `sinceMs` (the 24 h cap). */
  creditedSatsSince(accountId: string, sinceMs: number): Promise<number>;
  /** Deposits whose state can still change: pending, held, below_minimum, dropped; plus credited ones seen at or above `minHeight`. */
  listWatchedDeposits(minHeight: number): Promise<OnchainDeposit[]>;
  listDeposits(accountId: string, limit: number): Promise<OnchainDeposit[]>;
  getDeposit(txid: string, vout: number): Promise<OnchainDeposit | null>;
  /** Sats in the node from deposits not (yet) in the ledger: pending, held, below_minimum. */
  uncreditedDepositSats(): Promise<number>;
  /** The watcher's scan height (the tip minus a reorg margin at its last run), or 0. */
  getScanHeight(): Promise<number>;
  setScanHeight(height: number): Promise<void>;
  /** Run `fn` as the only watcher across instances sharing the database; acquired:false at once otherwise. */
  withWatcherLock<T>(fn: () => Promise<T>): Promise<FeePoolLockResult<T>>;
}

/** In-memory store (dev, tests). `onCredit` stands in for the payment intent + credit row the Postgres store writes. */
export class MemoryOnchainDepositStore implements OnchainDepositStore {
  readonly addresses = new Map<string, DepositAddress>();
  readonly deposits = new Map<string, OnchainDeposit>();
  readonly credits: Array<{ accountId: string; credit: DepositCredit; amountSats: number }> = [];
  private scanHeight = 0;
  private locked = false;
  constructor(private readonly onCredit: (accountId: string, credit: DepositCredit, amountSats: number) => void | Promise<void> = () => undefined) {}
  private key(txid: string, vout: number) {
    return `${txid}:${vout}`;
  }
  async latestDepositAddress(accountId: string) {
    const mine = [...this.addresses.values()].filter((a) => a.accountId === accountId).sort((a, b) => b.createdAtMs - a.createdAtMs);
    return mine[0] ? { ...mine[0] } : null;
  }
  async addDepositAddress(address: DepositAddress) {
    if (!this.addresses.has(address.address)) this.addresses.set(address.address, { ...address });
  }
  async depositAccounts(addresses: string[]) {
    const out = new Map<string, { accountId: string; usedAtMs: number | null }>();
    for (const a of addresses) {
      const row = this.addresses.get(a);
      if (row) out.set(a, { accountId: row.accountId, usedAtMs: row.usedAtMs });
    }
    return out;
  }
  async markAddressUsed(address: string, atMs: number) {
    const row = this.addresses.get(address);
    if (row && row.usedAtMs === null) row.usedAtMs = atMs;
  }
  async observeDeposit(seen: Omit<OnchainDeposit, "status" | "creditedAtMs" | "detail" | "lastSeenAtMs">, nowMs: number) {
    const k = this.key(seen.txid, seen.vout);
    const cur = this.deposits.get(k);
    if (!cur) {
      const row: OnchainDeposit = { ...seen, status: "pending", creditedAtMs: null, detail: null, lastSeenAtMs: nowMs };
      this.deposits.set(k, row);
      return { ...row };
    }
    Object.assign(cur, { confirmations: seen.confirmations, blockHeight: seen.blockHeight, lastSeenAtMs: nowMs });
    if (cur.status === "dropped") Object.assign(cur, { status: "pending", detail: null });
    return { ...cur };
  }
  async setDepositStatus(txid: string, vout: number, from: DepositStatus[], to: DepositStatus, detail: string | null = null) {
    const cur = this.deposits.get(this.key(txid, vout));
    if (!cur || !from.includes(cur.status)) return false;
    cur.status = to;
    cur.detail = detail;
    return true;
  }
  async creditDeposit(txid: string, vout: number, credit: DepositCredit, from: DepositStatus[]) {
    const cur = this.deposits.get(this.key(txid, vout));
    if (!cur || !from.includes(cur.status)) return "already" as const;
    // Synchronous from the check to the status change: a concurrent call sees "credited".
    cur.status = "credited";
    cur.creditedAtMs = credit.nowMs;
    cur.detail = null;
    this.credits.push({ accountId: cur.accountId, credit, amountSats: cur.amountSats });
    await this.onCredit(cur.accountId, credit, cur.amountSats);
    return "credited" as const;
  }
  async creditedSatsSince(accountId: string, sinceMs: number) {
    return [...this.deposits.values()].filter((d) => d.accountId === accountId && d.status === "credited" && (d.creditedAtMs ?? 0) >= sinceMs).reduce((s, d) => s + d.amountSats, 0);
  }
  async listWatchedDeposits(minHeight: number) {
    return [...this.deposits.values()].filter((d) => d.status !== "credited" && d.status !== "reversed" ? true : d.status === "credited" && (d.blockHeight === 0 || d.blockHeight >= minHeight)).map((d) => ({ ...d }));
  }
  async listDeposits(accountId: string, limit: number) {
    return [...this.deposits.values()].filter((d) => d.accountId === accountId).sort((a, b) => b.firstSeenAtMs - a.firstSeenAtMs).slice(0, limit).map((d) => ({ ...d }));
  }
  async getDeposit(txid: string, vout: number) {
    const d = this.deposits.get(this.key(txid, vout));
    return d ? { ...d } : null;
  }
  async uncreditedDepositSats() {
    return [...this.deposits.values()].filter((d) => d.status === "pending" || d.status === "held" || d.status === "below_minimum").reduce((s, d) => s + d.amountSats, 0);
  }
  async getScanHeight() {
    return this.scanHeight;
  }
  async setScanHeight(height: number) {
    this.scanHeight = height;
  }
  async withWatcherLock<T>(fn: () => Promise<T>): Promise<FeePoolLockResult<T>> {
    if (this.locked) return { acquired: false };
    this.locked = true;
    try {
      return { acquired: true, value: await fn() };
    } finally {
      this.locked = false;
    }
  }
}

export interface DepositWatcherDeps {
  store: OnchainDepositStore;
  wallet: OnchainWallet;
  config: OnchainConfig;
  coordinatorId: string;
  /** Purchase fee (COORDINATOR_FEE_BPS) applied like a Lightning purchase; 0 = buying is free. */
  purchaseFeeBps?: number;
  /** After a deposit is credited (fee-pool row for a purchase fee, ledger event). */
  onCredited?: (deposit: OnchainDeposit, credit: DepositCredit) => Promise<void>;
  onSecurityEvent?: (event: "onchain_deposit_held" | "onchain_deposit_reversed", details: Record<string, unknown>) => void;
  log?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
  now?: () => number;
}

/** Blocks re-read below the last scan, so a reorg that replaces recent blocks is seen. */
export const DEPOSIT_REORG_MARGIN_BLOCKS = 12;

export type DepositTickResult =
  | { skipped: "disabled" | "locked" }
  | { skipped?: undefined; seen: number; credited: number; held: number; belowMinimum: number; dropped: number; reversed: number };

export function depositIntentId(txid: string, vout: number): string {
  return `onchain:${txid}:${vout}`;
}

export class DepositWatcher {
  private running: Promise<DepositTickResult> | null = null;
  constructor(private readonly d: DepositWatcherDeps) {}

  private now() {
    return (this.d.now ?? Date.now)();
  }

  /**
   * The account's deposit address: the newest one until a deposit to it is seen, then a fresh one
   * ("last used" rotation; older addresses stay watched and are still credited).
   */
  async depositAddress(accountId: string): Promise<DepositAddress> {
    const cur = await this.d.store.latestDepositAddress(accountId);
    if (cur && cur.usedAtMs === null) return cur;
    const address = await this.d.wallet.newAddress(this.d.config.addressType);
    const row: DepositAddress = { address, accountId, network: this.d.config.network, createdAtMs: this.now(), usedAtMs: null };
    await this.d.store.addDepositAddress(row);
    return row;
  }

  /** Single-flight in this process; one watcher across the database (advisory lock). */
  tick(): Promise<DepositTickResult> {
    if (!this.d.config.enabled) return Promise.resolve({ skipped: "disabled" });
    if (!this.running) {
      this.running = (async () => {
        const r = await this.d.store.withWatcherLock(() => this.scan());
        return r.acquired ? r.value : { skipped: "locked" as const };
      })().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async scan(): Promise<DepositTickResult> {
    const nowMs = this.now();
    const cfg = this.d.config;
    const scanHeight = await this.d.store.getScanHeight();
    const watched = await this.d.store.listWatchedDeposits(Math.max(0, scanHeight - DEPOSIT_REORG_MARGIN_BLOCKS));
    // Read far enough back for every deposit whose state can still change (its block or earlier).
    // Only pending deposits pull the read back: held / below-minimum ones keep their state until an
    // operator acts, so an old one must not make every scan re-read the whole wallet.
    const lowest = watched.reduce((m, d) => (d.status === "pending" && d.blockHeight > 0 ? Math.min(m, d.blockHeight) : m), Number.POSITIVE_INFINITY);
    const startHeight = Math.max(0, Math.min(scanHeight - DEPOSIT_REORG_MARGIN_BLOCKS, Number.isFinite(lowest) ? lowest - 1 : Number.POSITIVE_INFINITY));
    const txs = await this.d.wallet.listTransactions({ startHeight });
    const out = { seen: 0, credited: 0, held: 0, belowMinimum: 0, dropped: 0, reversed: 0 };

    const candidates: Array<{ tx: ChainTransaction; vout: number; address: string; amountSats: number }> = [];
    for (const tx of txs) {
      // Our own payout batches pay out, never in; their change is not a deposit address anyway.
      if (tx.label.startsWith("edgecoder:onchain-batch")) continue;
      for (const o of tx.outputs) if (o.address && o.amountSats > 0) candidates.push({ tx, vout: o.outputIndex, address: o.address, amountSats: o.amountSats });
    }
    const owners = await this.d.store.depositAccounts([...new Set(candidates.map((c) => c.address))]);
    const present = new Set<string>();
    let tip = scanHeight;
    for (const tx of txs) if (tx.blockHeight > 0) tip = Math.max(tip, tx.blockHeight + Math.max(0, tx.confirmations - 1));

    for (const c of candidates) {
      const owner = owners.get(c.address);
      if (!owner) continue;
      present.add(`${c.tx.txid}:${c.vout}`);
      out.seen += 1;
      if (owner.usedAtMs === null) await this.d.store.markAddressUsed(c.address, nowMs);
      const row = await this.d.store.observeDeposit(
        { txid: c.tx.txid, vout: c.vout, accountId: owner.accountId, address: c.address, amountSats: c.amountSats, confirmations: c.tx.confirmations, blockHeight: c.tx.blockHeight, firstSeenAtMs: nowMs },
        nowMs
      );
      if (row.status !== "pending") continue;
      if (row.amountSats < cfg.depositMinSats) {
        if (await this.d.store.setDepositStatus(row.txid, row.vout, ["pending"], "below_minimum", `below the ${cfg.depositMinSats} sat minimum`)) out.belowMinimum += 1;
        continue;
      }
      if (row.confirmations < cfg.depositConfirmations) continue;
      const cap = await this.capViolation(row, nowMs);
      if (cap) {
        if (await this.d.store.setDepositStatus(row.txid, row.vout, ["pending"], "held", cap)) {
          out.held += 1;
          this.d.onSecurityEvent?.("onchain_deposit_held", { accountId: row.accountId, txid: row.txid, vout: row.vout, amountSats: row.amountSats, reason: cap });
          this.d.log?.warn({ accountId: row.accountId, txid: row.txid, vout: row.vout, amountSats: row.amountSats, reason: cap }, "onchain_deposit_held");
        }
        continue;
      }
      if ((await this.credit(row, ["pending"], nowMs)) === "credited") out.credited += 1;
    }

    // Deposits the wallet no longer lists inside the window that was read.
    for (const d of watched) {
      if (present.has(`${d.txid}:${d.vout}`)) continue;
      if (d.blockHeight > 0 && d.blockHeight < startHeight) continue; // outside this read: unknown, not gone
      if (d.status === "pending" || d.status === "held" || d.status === "below_minimum") {
        if (await this.d.store.setDepositStatus(d.txid, d.vout, [d.status], "dropped", "no longer in the wallet before it was credited")) out.dropped += 1;
      } else if (d.status === "credited") {
        if (await this.d.store.setDepositStatus(d.txid, d.vout, ["credited"], "reversed", "credited, then gone from the chain")) {
          out.reversed += 1;
          this.d.onSecurityEvent?.("onchain_deposit_reversed", { accountId: d.accountId, txid: d.txid, vout: d.vout, amountSats: d.amountSats });
          this.d.log?.warn({ accountId: d.accountId, txid: d.txid, vout: d.vout, amountSats: d.amountSats }, "onchain_deposit_reversed");
        }
      }
    }
    await this.d.store.setScanHeight(tip);
    if (out.credited || out.held || out.dropped || out.reversed) this.d.log?.info(out, "onchain_deposits");
    return out;
  }

  private async capViolation(d: OnchainDeposit, nowMs: number): Promise<string | null> {
    const cfg = this.d.config;
    if (cfg.depositMaxSats > 0 && d.amountSats > cfg.depositMaxSats) return `above the ${cfg.depositMaxSats} sat per-deposit cap`;
    if (cfg.depositMaxAccountDailySats > 0) {
      const recent = await this.d.store.creditedSatsSince(d.accountId, nowMs - 24 * 60 * 60 * 1000);
      if (recent + d.amountSats > cfg.depositMaxAccountDailySats) return `above the ${cfg.depositMaxAccountDailySats} sat per-account daily cap`;
    }
    return null;
  }

  private async credit(d: OnchainDeposit, from: DepositStatus[], nowMs: number): Promise<"credited" | "already"> {
    const feeBps = Math.max(0, Math.floor(this.d.purchaseFeeBps ?? 0));
    const feeSats = Math.floor((d.amountSats * feeBps) / 10_000);
    const credit: DepositCredit = { intentId: depositIntentId(d.txid, d.vout), coordinatorId: this.d.coordinatorId, network: this.d.config.network, feeBps, feeSats, netSats: d.amountSats - feeSats, nowMs };
    const r = await this.d.store.creditDeposit(d.txid, d.vout, credit, from);
    if (r === "credited") {
      this.d.log?.info({ accountId: d.accountId, txid: d.txid, vout: d.vout, amountSats: d.amountSats }, "onchain_deposit_credited");
      await this.d.onCredited?.({ ...d, status: "credited", creditedAtMs: nowMs }, credit).catch((error) => this.d.log?.warn({ error: String(error) }, "onchain_deposit_side_effects_failed"));
    }
    return r;
  }

  /** Operator: credit a held deposit (after review). Only a held deposit with enough confirmations. */
  async releaseHeld(txid: string, vout: number): Promise<{ ok: true } | { ok: false; code: "not_found" | "not_held" | "not_confirmed" }> {
    const d = await this.d.store.getDeposit(txid, vout);
    if (!d) return { ok: false, code: "not_found" };
    if (d.status !== "held") return { ok: false, code: "not_held" };
    if (d.confirmations < this.d.config.depositConfirmations) return { ok: false, code: "not_confirmed" };
    return (await this.credit(d, ["held"], this.now())) === "credited" ? { ok: true } : { ok: false, code: "not_held" };
  }
}

/** A deposit as the wallets show it. */
export function depositView(d: OnchainDeposit, requiredConfirmations: number) {
  return {
    txid: d.txid,
    vout: d.vout,
    address: d.address,
    amountSats: d.amountSats,
    confirmations: d.confirmations,
    requiredConfirmations,
    status: d.status,
    detail: d.detail,
    seenAtMs: d.firstSeenAtMs,
    creditedAtMs: d.creditedAtMs
  };
}
