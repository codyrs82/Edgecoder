// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Periodic verification of the credit ledger.
 */
import { reconcileLedger, type ReconcileReport } from "../../ledger/reconcile.js";
import { NETWORK_FEE_POOL_ACCOUNT } from "../../credits/store.js";
import { pgStore } from "../../db/store.js";
import { app } from "./app.js";
import { CC, identity, securityLog } from "./context.js";

// ── #115: credits-ledger reconciliation (src/ledger/reconcile.ts). Reads only; never corrects. ──
/** How often the periodic reconciliation runs (one coordinator per window on a shared database); 0 = off. */
export const LEDGER_VERIFY_INTERVAL_MS = CC.LEDGER_VERIFY_INTERVAL_MS;
type LedgerVerifyResult = ReconcileReport & { checkedAtMs: number; durationMs: number; coordinatorId: string };

export async function verifyCreditLedger(maxDiscrepancies: number): Promise<LedgerVerifyResult | null> {
  if (!pgStore) return null;
  const startedAtMs = Date.now();
  const input = await pgStore.ledgerReconcileInput(NETWORK_FEE_POOL_ACCOUNT);
  const report = reconcileLedger(input, { maxDiscrepancies, localCoordinatorIds: [identity.peerId], feePoolAccountId: NETWORK_FEE_POOL_ACCOUNT });
  return { ...report, checkedAtMs: startedAtMs, durationMs: Date.now() - startedAtMs, coordinatorId: identity.peerId };
}

export function alertLedgerMismatch(result: LedgerVerifyResult, trigger: "admin" | "timer"): void {
  if (result.ok) return;
  securityLog.log({
    level: securityLog.severity("ledger_reconciliation_mismatch"),
    event: "ledger_reconciliation_mismatch",
    source: { type: "system", id: identity.peerId },
    details: { trigger, mismatches: result.mismatches, byKind: result.byKind, discrepancies: result.discrepancies.slice(0, 5) },
    action: "manual_review_required",
    coordinatorId: identity.peerId
  });
}

/** Periodic run: the first coordinator to claim the window runs it and alerts; the others skip. */
export async function runLedgerVerifyTick(nowMs = Date.now()): Promise<void> {
  if (!pgStore || LEDGER_VERIFY_INTERVAL_MS <= 0) return;
  const windowStartMs = Math.floor(nowMs / LEDGER_VERIFY_INTERVAL_MS) * LEDGER_VERIFY_INTERVAL_MS;
  const r = await pgStore.withLedgerVerifyWindow(windowStartMs, identity.peerId, async () => (await verifyCreditLedger(20))!);
  if (!r.ran) return;
  app.log.info({ ok: r.value.ok, mismatches: r.value.mismatches, accountsChecked: r.value.accountsChecked, accrualsChecked: r.value.accrualsChecked, warnings: r.value.warnings, durationMs: r.value.durationMs }, "ledger_verify");
  alertLedgerMismatch(r.value, "timer");
}
