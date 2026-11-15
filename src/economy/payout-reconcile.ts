// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { PayoutRecord } from "../common/types.js";
import type { LightningProvider, NodeBalances, NodePayment } from "./lightning.js";

/**
 * Payout reconciliation: the ledger (payouts table, purchases, earned balances) against what the
 * Lightning node itself reports (balances, outgoing payments). Runs every PAYOUT_RECONCILE_MS.
 *
 * Checks, each with PAYOUT_RECONCILE_TOLERANCE_SATS of slack:
 *   unknown_payments   node payments (succeeded or in flight) with no payout row. Something other
 *                      than PayoutService is spending from the node.                         -> pause
 *   ledger_freed       node says succeeded / in flight, ledger marked the payout failed: the
 *                      balance was freed but the sats left (double-pay risk).                -> pause
 *   paid_mismatch      for payouts the node knows, Σ node value+fee vs Σ ledger amount+fee.  -> pause
 *   balance_drop       node total fell more than purchases-in minus payouts-out explain since
 *                      the previous run (first run only records the baseline).              -> pause
 *   liability_shortfall  ledger liabilities (earned, not yet paid) exceed node holdings. Expected
 *                      while purchases lag accrual (payout capacity already caps payouts at
 *                      received sats), so this alerts only.                                  -> alert
 *   solvency           cSats outstanding exceed sats received - paid out + admin grants (+ the
 *                      PAYOUT_SOLVENCY_ALLOWANCE_SATS allowance).                             -> pause
 * A node that cannot be read (HTTP error, malformed body) is an error result: alerted, not paused
 * (it cannot pay either), and the baseline is kept for the next run.
 *
 * On-chain (ONCHAIN_ENABLED, src/economy/onchain*.ts) extends the ledger side instead of loosening
 * the checks: credited deposits are settled payment intents, so they are in receivedMsat like any
 * purchase; deposits the node holds but the ledger has not credited (unconfirmed, held, below the
 * minimum) count as received for balance_drop only, so a deposit that vanishes before it is credited
 * is not a loss; on-chain payouts are payouts rows (outflow); the network fee EdgeCoder pays for a
 * batch is extra outflow, recorded with its fee-pool spend row. While a batch's send outcome is not
 * yet recorded, balance_drop waits for the next run (the baseline is kept).
 */

export interface ReconcileLedger {
  /** Payout rows for these payment hashes (any status). */
  payoutsByPaymentHash(hashes: string[]): Promise<Map<string, Pick<PayoutRecord, "paymentHash" | "status" | "amountMsat" | "feeMsat" | "maxFeeMsat">>>;
  /** Σ (amount + fee) of paid payouts, plus Σ (amount + fee cap) of pending ones: what has or may have left. */
  payoutsOutflowMsat(): Promise<number>;
  receivedPurchaseMsat(): Promise<number>;
  /** Earned but not yet paid out, across all accounts; undefined when the store cannot total it. */
  liabilitiesMsat?(): Promise<number | undefined>;
  /**
   * Solvency inputs: every account's credit balance (sats owed, as cSats or withdrawable; the fee
   * pool at its undistributed sats) and the cSats an admin granted without sats behind them
   * (faucet). Undefined when the store cannot total them.
   */
  solvencyMsat?(): Promise<SolvencyInputs | undefined>;
  /**
   * The last run's snapshot, shared by every coordinator on the database (payout_controls). A
   * restarted reconciler continues from it instead of looking back the whole lookback again, so a
   * payment that already tripped (and was reviewed before an admin resumed) does not pause payouts
   * again on every deploy, and the balance-drop check keeps its baseline across restarts.
   */
  loadReconcileSnapshot?(): Promise<ReconcileSnapshot | null>;
  saveReconcileSnapshot?(snapshot: ReconcileSnapshot): Promise<void>;
}

export interface SolvencyInputs {
  outstandingMsat: number;
  grantedMsat: number;
}

/** On-chain inputs to reconciliation (src/swarm/coordinator/onchain.ts wires them). */
export interface OnchainReconcileLedger {
  /** Sats (as msat) of deposits the node holds that are not credited: pending, held, below the minimum. */
  uncreditedDepositMsat(): Promise<number>;
  /** Network fees EdgeCoder paid for payout batches (msat). */
  feeOutflowMsat(): Promise<number>;
  /** A batch was handed to the node and its transaction or fee is not recorded yet. */
  inFlight(): Promise<boolean>;
  /** Bring the deposit view up to date first, so a deposit already in the node balance is known. */
  beforeRun?(): Promise<unknown>;
}

export interface PayoutReconcileConfig {
  intervalMs: number;
  toleranceSats: number;
  /** First run looks back this far for node payments. */
  lookbackMs: number;
  /** Known solvency gap tolerated on top of toleranceSats (a historical gap awaiting a data fix). */
  solvencyAllowanceSats?: number;
}

export function payoutReconcileConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PayoutReconcileConfig {
  const num = (k: string, d: number, min = 0) => {
    const v = env[k];
    if (v === undefined || v.trim() === "") return d;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new Error(`[payouts] ${k} must be a number >= 0`);
    return n === 0 ? 0 : Math.max(min, n);
  };
  return {
    // 0 disables the timer (manual runs still work).
    intervalMs: num("PAYOUT_RECONCILE_MS", 600_000, 60_000),
    toleranceSats: num("PAYOUT_RECONCILE_TOLERANCE_SATS", 1_000),
    // How far back the first run after a start reads node payments (later runs continue from the previous one).
    lookbackMs: num("PAYOUT_RECONCILE_LOOKBACK_MS", 86_400_000, 60_000),
    solvencyAllowanceSats: num("PAYOUT_SOLVENCY_ALLOWANCE_SATS", 0)
  };
}

export type ReconcileCheckName = "unknown_payments" | "ledger_freed" | "paid_mismatch" | "balance_drop" | "liability_shortfall" | "solvency";

export interface ReconcileCheck {
  name: ReconcileCheckName;
  ok: boolean;
  /** true: this check pauses payouts when it fails. */
  pauses: boolean;
  detail: string;
  msat?: number;
  paymentHashes?: string[];
}

export interface ReconcileSnapshot {
  atMs: number;
  nodeTotalMsat: number;
  outflowMsat: number;
  receivedMsat: number;
}

export interface ReconcileResult {
  atMs: number;
  status: "ok" | "alert" | "tripped" | "error" | "unsupported";
  checks: ReconcileCheck[];
  node?: { totalSats: number; onchainSats: number; channelLocalSats: number; channelPendingSats: number; payments: number; truncated: boolean };
  ledger?: { outflowMsat: number; receivedMsat: number; liabilitiesMsat?: number; outstandingMsat?: number; grantedMsat?: number; solvencyGapMsat?: number };
  error?: string;
}

/** Pure: compare one node read against the ledger and the previous snapshot. */
export function evaluateReconciliation(input: {
  nowMs: number;
  balances: NodeBalances;
  payments: NodePayment[];
  ledgerRows: Map<string, Pick<PayoutRecord, "paymentHash" | "status" | "amountMsat" | "feeMsat" | "maxFeeMsat">>;
  outflowMsat: number;
  receivedMsat: number;
  liabilitiesMsat?: number;
  solvency?: SolvencyInputs;
  solvencyAllowanceSats?: number;
  previous?: ReconcileSnapshot | null;
  toleranceSats: number;
  /** On-chain deposits in the node not credited yet (msat): received, for balance_drop only. */
  onchainUncreditedMsat?: number;
  /** An on-chain batch's outcome is not recorded yet: balance_drop is not evaluated this run. */
  skipBalanceDrop?: boolean;
}): { checks: ReconcileCheck[]; snapshot: ReconcileSnapshot } {
  const tol = input.toleranceSats * 1000;
  const checks: ReconcileCheck[] = [];
  const moving = input.payments.filter((p) => p.status !== "failed");

  const unknown = moving.filter((p) => !input.ledgerRows.has(p.paymentHash));
  const unknownMsat = unknown.reduce((s, p) => s + p.valueMsat + p.feeMsat, 0);
  checks.push({
    name: "unknown_payments",
    ok: unknownMsat <= tol,
    pauses: true,
    detail: unknown.length ? `${unknown.length} node payment(s) with no payout row, ${unknownMsat} msat` : "every node payment has a payout row",
    msat: unknownMsat,
    paymentHashes: unknown.slice(0, 20).map((p) => p.paymentHash)
  });

  const freed = moving.filter((p) => input.ledgerRows.get(p.paymentHash)?.status === "failed");
  const freedMsat = freed.reduce((s, p) => s + p.valueMsat + p.feeMsat, 0);
  checks.push({
    name: "ledger_freed",
    ok: freed.length === 0,
    pauses: true,
    detail: freed.length ? `${freed.length} payout(s) marked failed but sent by the node, ${freedMsat} msat` : "no failed payout left the node",
    msat: freedMsat,
    paymentHashes: freed.slice(0, 20).map((p) => p.paymentHash)
  });

  let nodeKnown = 0;
  let ledgerKnown = 0;
  for (const p of input.payments) {
    if (p.status !== "succeeded") continue;
    const row = input.ledgerRows.get(p.paymentHash);
    if (!row || row.status !== "paid") continue;
    nodeKnown += p.valueMsat + p.feeMsat;
    ledgerKnown += row.amountMsat + row.feeMsat;
  }
  const paidDiff = Math.abs(nodeKnown - ledgerKnown);
  checks.push({
    name: "paid_mismatch",
    ok: paidDiff <= tol,
    pauses: true,
    detail: `node sent ${nodeKnown} msat for paid payouts, ledger records ${ledgerKnown} msat`,
    msat: paidDiff
  });

  const nodeTotalMsat = input.balances.totalSats * 1000;
  const balanceReceivedMsat = input.receivedMsat + Math.max(0, input.onchainUncreditedMsat ?? 0);
  if (input.previous && !input.skipBalanceDrop) {
    const expected = input.previous.nodeTotalMsat + (balanceReceivedMsat - input.previous.receivedMsat) - (input.outflowMsat - input.previous.outflowMsat);
    const drop = expected - nodeTotalMsat;
    checks.push({
      name: "balance_drop",
      ok: drop <= tol,
      pauses: true,
      detail: `node holds ${nodeTotalMsat} msat; purchases and payouts since the last run explain ${expected} msat`,
      msat: Math.max(0, drop)
    });
  }

  if (input.liabilitiesMsat !== undefined) {
    const shortfall = input.liabilitiesMsat - nodeTotalMsat;
    checks.push({
      name: "liability_shortfall",
      ok: shortfall <= tol,
      pauses: false,
      detail: `ledger owes ${input.liabilitiesMsat} msat, node holds ${nodeTotalMsat} msat`,
      msat: Math.max(0, shortfall)
    });
  }

  // Ledger solvency: cSats outstanding (every account's balance, which caps what it can withdraw;
  // the fee pool at its undistributed sats) against the sats the node took in minus what has or
  // may have left, plus admin grants (faucet), which have no sats behind them by design. Every
  // ledger move keeps this balanced (a spend held for a running lease or task only lowers the
  // outstanding side until it is paid on), so a gap means more is owed than ever came in: pause.
  // The allowance absorbs a known historical gap (payouts made before withdrawals debited credits)
  // until the owner corrects the data.
  if (input.solvency) {
    const backingMsat = input.receivedMsat - input.outflowMsat + input.solvency.grantedMsat;
    const gap = input.solvency.outstandingMsat - backingMsat;
    const allowance = (input.solvencyAllowanceSats ?? 0) * 1000;
    checks.push({
      name: "solvency",
      ok: gap <= tol + allowance,
      pauses: true,
      detail: `cSats outstanding ${input.solvency.outstandingMsat} msat; received - paid out + granted = ${backingMsat} msat${allowance ? ` (allowance ${allowance} msat)` : ""}`,
      msat: Math.max(0, gap)
    });
  }

  return { checks, snapshot: { atMs: input.nowMs, nodeTotalMsat, outflowMsat: input.outflowMsat, receivedMsat: balanceReceivedMsat } };
}

export interface ReconcilerDeps {
  provider: LightningProvider;
  ledger: ReconcileLedger;
  /** On-chain deposits and batch fees, when ONCHAIN_ENABLED. */
  onchain?: OnchainReconcileLedger;
  config: PayoutReconcileConfig;
  coordinatorId: string;
  /** Called when a pausing check fails (the coordinator's kill switch). */
  pause: (reason: string) => Promise<void>;
  /** Security event sink. */
  onAlert?: (result: ReconcileResult) => void;
  webhookUrl?: string;
  postJson?: (url: string, body: unknown) => Promise<void>;
  log?: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
  now?: () => number;
}

/** Webhook body: counts, amounts and payment hashes only (no tokens, preimages or invoices). */
export function alertSummary(coordinatorId: string, r: ReconcileResult, paused: boolean): Record<string, unknown> {
  return {
    event: "payout_reconciliation_alert",
    coordinatorId,
    atMs: r.atMs,
    at: new Date(r.atMs).toISOString(),
    status: r.status,
    payoutsPaused: paused,
    failedChecks: r.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, pauses: c.pauses, detail: c.detail, msat: c.msat, paymentHashes: c.paymentHashes?.slice(0, 5) })),
    node: r.node,
    ledger: r.ledger,
    error: r.error
  };
}

export async function defaultPostJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`webhook_http_${res.status}`);
}

export class PayoutReconciler {
  private previous: ReconcileSnapshot | null = null;
  private lastResult: ReconcileResult | null = null;
  private running: Promise<ReconcileResult> | null = null;

  constructor(private readonly d: ReconcilerDeps) {}

  last(): ReconcileResult | null {
    return this.lastResult;
  }

  /** Add the on-chain ledger inputs after construction (the on-chain module is built after the reconciler). */
  attachOnchain(onchain: OnchainReconcileLedger): void {
    (this.d as { onchain?: OnchainReconcileLedger }).onchain = onchain;
  }

  /** Single-flight: concurrent callers share one run. */
  run(): Promise<ReconcileResult> {
    if (!this.running) this.running = this.runOnce().finally(() => { this.running = null; });
    return this.running;
  }

  private async runOnce(): Promise<ReconcileResult> {
    const now = (this.d.now ?? Date.now)();
    const p = this.d.provider;
    if (!p.getBalances || !p.listPayments) return this.finish({ atMs: now, status: "unsupported", checks: [], error: "provider has no balance/payment queries" });
    let result: ReconcileResult;
    try {
      if (!this.previous && this.d.ledger.loadReconcileSnapshot) {
        this.previous = await this.d.ledger.loadReconcileSnapshot().catch((err) => {
          this.d.log?.warn({ error: err instanceof Error ? err.message : String(err) }, "payout_reconcile_snapshot_unreadable");
          return null;
        });
      }
      const sinceMs = Math.max(0, Math.min(now, this.previous?.atMs ?? now - this.d.config.lookbackMs) - 60 * 60 * 1000);
      const onchain = this.d.onchain;
      if (onchain?.beforeRun) await onchain.beforeRun().catch((err) => this.d.log?.warn({ error: err instanceof Error ? err.message : String(err) }, "payout_reconcile_onchain_refresh_failed"));
      const [balances, list] = await Promise.all([p.getBalances(), p.listPayments({ sinceMs, limit: 1000 })]);
      if (!balances.supported || !list.supported) {
        return this.finish({ atMs: now, status: "unsupported", checks: [], error: !balances.supported ? balances.reason : !list.supported ? list.reason : undefined });
      }
      const [ledgerRows, payoutOutflowMsat, receivedMsat, liabilitiesMsat, solvency, onchainUncreditedMsat, onchainFeeMsat, inFlight] = await Promise.all([
        this.d.ledger.payoutsByPaymentHash([...new Set(list.payments.map((x) => x.paymentHash))]),
        this.d.ledger.payoutsOutflowMsat(),
        this.d.ledger.receivedPurchaseMsat(),
        this.d.ledger.liabilitiesMsat ? this.d.ledger.liabilitiesMsat() : Promise.resolve(undefined),
        this.d.ledger.solvencyMsat ? this.d.ledger.solvencyMsat() : Promise.resolve(undefined),
        onchain ? onchain.uncreditedDepositMsat() : Promise.resolve(0),
        onchain ? onchain.feeOutflowMsat() : Promise.resolve(0),
        onchain ? onchain.inFlight() : Promise.resolve(false)
      ]);
      const outflowMsat = payoutOutflowMsat + onchainFeeMsat;
      const { checks, snapshot } = evaluateReconciliation({ nowMs: now, balances, payments: list.payments, ledgerRows, outflowMsat, receivedMsat, liabilitiesMsat, solvency, solvencyAllowanceSats: this.d.config.solvencyAllowanceSats, previous: this.previous, toleranceSats: this.d.config.toleranceSats, onchainUncreditedMsat, skipBalanceDrop: inFlight });
      // While an on-chain send is unrecorded the node balance is mid-move: keep the old baseline.
      if (!inFlight) {
        this.previous = snapshot;
        await this.d.ledger.saveReconcileSnapshot?.(snapshot).catch((err) => {
          this.d.log?.warn({ error: err instanceof Error ? err.message : String(err) }, "payout_reconcile_snapshot_save_failed");
        });
      }
      const tripped = checks.some((c) => !c.ok && c.pauses);
      result = {
        atMs: now,
        status: tripped ? "tripped" : checks.some((c) => !c.ok) ? "alert" : "ok",
        checks,
        node: {
          totalSats: balances.totalSats,
          onchainSats: balances.onchainConfirmedSats + balances.onchainUnconfirmedSats,
          channelLocalSats: balances.channelLocalSats,
          channelPendingSats: balances.channelPendingSats,
          payments: list.payments.length,
          truncated: list.truncated
        },
        ledger: { outflowMsat, receivedMsat, liabilitiesMsat, outstandingMsat: solvency?.outstandingMsat, grantedMsat: solvency?.grantedMsat, solvencyGapMsat: solvency ? solvency.outstandingMsat - (receivedMsat - outflowMsat + solvency.grantedMsat) : undefined }
      };
    } catch (err) {
      result = { atMs: now, status: "error", checks: [], error: err instanceof Error ? err.message : String(err) };
    }
    if (result.status === "tripped") {
      const failed = result.checks.filter((c) => !c.ok && c.pauses).map((c) => c.name).join(",");
      try {
        await this.d.pause(`reconciliation: ${failed}`);
      } catch (err) {
        this.d.log?.warn({ error: err instanceof Error ? err.message : String(err) }, "payout_reconcile_pause_failed");
      }
    }
    return this.finish(result);
  }

  private async finish(result: ReconcileResult): Promise<ReconcileResult> {
    this.lastResult = result;
    if (result.status === "ok" || result.status === "unsupported") {
      this.d.log?.info({ status: result.status, node: result.node }, "payout_reconciliation");
      return result;
    }
    this.d.log?.warn({ status: result.status, checks: result.checks.filter((c) => !c.ok), error: result.error }, "payout_reconciliation");
    this.d.onAlert?.(result);
    if (this.d.webhookUrl) {
      try {
        await (this.d.postJson ?? defaultPostJson)(this.d.webhookUrl, alertSummary(this.d.coordinatorId, result, result.status === "tripped"));
      } catch (err) {
        this.d.log?.warn({ error: err instanceof Error ? err.message : String(err) }, "payout_alert_webhook_failed");
      }
    }
    return result;
  }
}
