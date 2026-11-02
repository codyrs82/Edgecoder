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
 * A node that cannot be read (HTTP error, malformed body) is an error result: alerted, not paused
 * (it cannot pay either), and the baseline is kept for the next run.
 */

export interface ReconcileLedger {
  /** Payout rows for these payment hashes (any status). */
  payoutsByPaymentHash(hashes: string[]): Promise<Map<string, Pick<PayoutRecord, "paymentHash" | "status" | "amountMsat" | "feeMsat" | "maxFeeMsat">>>;
  /** Σ (amount + fee) of paid payouts, plus Σ (amount + fee cap) of pending ones: what has or may have left. */
  payoutsOutflowMsat(): Promise<number>;
  receivedPurchaseMsat(): Promise<number>;
  /** Earned but not yet paid out, across all accounts; undefined when the store cannot total it. */
  liabilitiesMsat?(): Promise<number | undefined>;
}

export interface PayoutReconcileConfig {
  intervalMs: number;
  toleranceSats: number;
  /** First run looks back this far for node payments. */
  lookbackMs: number;
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
    lookbackMs: num("PAYOUT_RECONCILE_LOOKBACK_MS", 86_400_000, 60_000)
  };
}

export type ReconcileCheckName = "unknown_payments" | "ledger_freed" | "paid_mismatch" | "balance_drop" | "liability_shortfall";

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
  ledger?: { outflowMsat: number; receivedMsat: number; liabilitiesMsat?: number };
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
  previous?: ReconcileSnapshot | null;
  toleranceSats: number;
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
  if (input.previous) {
    const expected = input.previous.nodeTotalMsat + (input.receivedMsat - input.previous.receivedMsat) - (input.outflowMsat - input.previous.outflowMsat);
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

  return { checks, snapshot: { atMs: input.nowMs, nodeTotalMsat, outflowMsat: input.outflowMsat, receivedMsat: input.receivedMsat } };
}

export interface ReconcilerDeps {
  provider: LightningProvider;
  ledger: ReconcileLedger;
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
      const sinceMs = Math.max(0, (this.previous?.atMs ?? now - this.d.config.lookbackMs) - 60 * 60 * 1000);
      const [balances, list] = await Promise.all([p.getBalances(), p.listPayments({ sinceMs, limit: 1000 })]);
      if (!balances.supported || !list.supported) {
        return this.finish({ atMs: now, status: "unsupported", checks: [], error: !balances.supported ? balances.reason : !list.supported ? list.reason : undefined });
      }
      const [ledgerRows, outflowMsat, receivedMsat, liabilitiesMsat] = await Promise.all([
        this.d.ledger.payoutsByPaymentHash([...new Set(list.payments.map((x) => x.paymentHash))]),
        this.d.ledger.payoutsOutflowMsat(),
        this.d.ledger.receivedPurchaseMsat(),
        this.d.ledger.liabilitiesMsat ? this.d.ledger.liabilitiesMsat() : Promise.resolve(undefined)
      ]);
      const { checks, snapshot } = evaluateReconciliation({ nowMs: now, balances, payments: list.payments, ledgerRows, outflowMsat, receivedMsat, liabilitiesMsat, previous: this.previous, toleranceSats: this.d.config.toleranceSats });
      this.previous = snapshot;
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
        ledger: { outflowMsat, receivedMsat, liabilitiesMsat }
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
