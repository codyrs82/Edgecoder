// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Invariant checks after (or during) a scenario.
 *
 * Two evidence sources:
 *  - SQL (local targets only): read-only queries against the shared Postgres, plus the hub LND
 *    node's invoices and payments. Every check names the SQL it ran in its evidence.
 *  - HTTP (any target): the coordinators' own reconciliation (/ledger/verify and
 *    /admin/payouts/reconciliation with the admin token), /metrics, /health/runtime, /status and
 *    /capacity (mesh token from an agent's /register), each harness account's balance through
 *    the portal, and what the load generator itself observed (attacks accepted, results credited
 *    twice, top-ups paid but never settled).
 *
 * ── Credit conservation (SQL), the formula ──
 * Ledger: credit_transactions rows, balance(a) = Σ earn.credits − Σ spend.credits.
 *   P   = Σ quoted_credits of payment_intents with status 'settled'           (from payment_intents)
 *   O   = Σ over payouts of what left or is held: paid -> amount+fee, pending -> amount+max_fee,
 *         failed -> 0                                                          (from payouts, msat/1000)
 *   R_t = per task t: spend(task_reserve|inference_reserve) − earn(compute_contribution, network_fee:t)
 *         − earn(task_submit_refund:t)                                         ("retained" by the task)
 *   R_r = per reservation r: spend(compute_reservation) − earn(reservation:r work + fee) − earn(reservation_refund:r)
 *   X   = Σ earn − Σ spend of rows in no class above (admin grants, minted replica rewards, ...)
 *   Conservation:   Σ_a balance(a) = P − O − Σ R_t − Σ R_r + X     (residual must be 0.000000)
 * P and O come from tables other than the credit rows, so a purchase credited twice or without a
 * settled intent, or a payout debit that does not match the payout, shows as a residual. Each R_t
 * must be >= 0 (a task can never pay out more than was set aside for it) and, once the task has
 * settled, should be 0 except for documented retention (peer-forwarded subtasks are charged at the
 * worst case by the origin, see routes/tasks.ts): the report lists every task with R_t != 0.
 */
import pg from "pg";
import { preimageMatchesHash, type LndClient } from "./lnd.js";
import { call } from "./http.js";
import type { Recorder } from "./metrics.js";
import type { LoadedTarget, Settings } from "./target.js";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface InvariantResult {
  id: string;
  title: string;
  /** pass | fail | warn | skipped (not checkable on this target) */
  status: "pass" | "fail" | "warn" | "skipped";
  severity: Severity;
  detail: string;
  /** SQL text, endpoint, counts, sample rows. */
  evidence?: Record<string, unknown>;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

async function q<T = any>(pool: pg.Pool, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}

export interface SqlCheckOptions {
  /** Only rows/tasks created at or after this time (ms); 0 = whole database. */
  sinceMs?: number;
  /** Tasks newer than this are still settling: R_t != 0 for them is not reported. */
  quiescentBeforeMs?: number;
  settings: Settings;
  hub?: LndClient;
  /** Agent ids the harness ran with a malicious behaviour (behaviour -> ids). */
  maliciousAgents?: Record<string, string[]>;
}

export async function sqlInvariants(postgresUrl: string, o: SqlCheckOptions): Promise<InvariantResult[]> {
  const pool = new pg.Pool({ connectionString: postgresUrl, max: 2 });
  const out: InvariantResult[] = [];
  try {
    await pool.query("SET default_transaction_read_only = on");
    // ── conservation ──
    const classify = `CASE
        WHEN tx_type='earn' AND reason LIKE 'credit_purchase:%' THEN 'purchase'
        WHEN tx_type='earn' AND reason LIKE 'purchase_fee:%' THEN 'purchase_fee'
        WHEN tx_type='earn' AND reason='compute_contribution' AND related_task_id LIKE 'reservation:%' THEN 'res_work'
        WHEN tx_type='earn' AND reason LIKE 'network_fee:reservation:%' THEN 'res_work'
        WHEN tx_type='earn' AND reason='compute_contribution' THEN 'task_work'
        WHEN tx_type='earn' AND reason LIKE 'network_fee:%' THEN 'task_work'
        WHEN tx_type='earn' AND reason LIKE 'task_submit_refund:%' THEN 'task_refund'
        WHEN tx_type='earn' AND reason LIKE 'reservation_refund:%' THEN 'res_refund'
        WHEN tx_type='spend' AND reason IN ('task_reserve','inference_reserve') THEN 'task_reserve'
        WHEN tx_type='spend' AND reason='compute_reservation' THEN 'res_reserve'
        WHEN tx_id LIKE 'payout:%' OR tx_id LIKE 'payout_refund:%' OR tx_id LIKE 'payout_fee_excess:%' THEN 'payout'
        ELSE 'other' END`;
    const byClass = await q(pool, `SELECT ${classify} AS cls, tx_type, COUNT(*)::int AS n, COALESCE(SUM(credits),0)::text AS credits FROM credit_transactions GROUP BY 1,2 ORDER BY 1,2`);
    const sumOf = (cls: string, type?: string) => byClass.filter((r) => r.cls === cls && (!type || r.tx_type === type)).reduce((s, r) => s + (r.tx_type === "spend" ? -1 : 1) * Number(r.credits), 0);
    const totalBalance = Number((await q(pool, `SELECT COALESCE(SUM(CASE WHEN tx_type='spend' THEN -credits ELSE credits END),0)::text AS b FROM credit_transactions`))[0].b);
    const P = Number((await q(pool, `SELECT COALESCE(SUM(quoted_credits),0)::text AS p FROM payment_intents WHERE status='settled'`))[0].p);
    const O = Number((await q(pool, `SELECT COALESCE(SUM(CASE WHEN status='paid' THEN amount_msat+fee_msat WHEN status='pending' THEN amount_msat+GREATEST(fee_msat,max_fee_msat) ELSE 0 END),0)::text AS o FROM payouts`))[0].o) / 1000;
    const taskRetained = sumOf("task_reserve") + sumOf("task_work") + sumOf("task_refund"); // reserve is negative
    const resRetained = sumOf("res_reserve") + sumOf("res_work") + sumOf("res_refund");
    const X = sumOf("other");
    const expected = P - O + taskRetained + resRetained + X;
    const residual = r6(totalBalance - expected);
    const payoutRows = sumOf("payout");
    out.push({
      id: "credits-conserved",
      title: "Credits conserved: Σ balances = settled purchases − payouts − retained reserves + other",
      status: Math.abs(residual) < 0.000001 ? "pass" : "fail",
      severity: "critical",
      detail: `Σbalance=${r6(totalBalance)} P=${r6(P)} O=${r6(O)} retained(tasks)=${r6(-taskRetained)} retained(reservations)=${r6(-resRetained)} other=${r6(X)} residual=${residual}; payout rows net=${r6(payoutRows)} vs −O=${r6(-O)}`,
      evidence: { byClass, sql: "credit_transactions grouped by class (see invariants.ts header); payment_intents status='settled'; payouts by status" }
    });
    out.push({
      id: "payout-rows-match-payouts",
      title: "Payout debits net of refunds equal what the payouts table says left (or is held)",
      status: Math.abs(r6(payoutRows + O)) < 0.000001 ? "pass" : "fail",
      severity: "critical",
      detail: `credit rows for payouts net ${r6(payoutRows)} cSats; payouts table ${r6(O)} cSats`
    });
    if (Math.abs(X) > 0) {
      const other = await q(pool, `SELECT tx_type, split_part(reason, ':', 1) AS reason, COUNT(*)::int AS n, SUM(credits)::text AS credits FROM credit_transactions WHERE ${classify} = 'other' GROUP BY 1,2`);
      out.push({ id: "unclassified-credit-rows", title: "Credit rows outside the purchase/work/refund/payout classes", status: "warn", severity: "info", detail: `${other.length} kinds`, evidence: { other } });
    }

    // ── per-task retention ──
    const since = o.sinceMs ?? 0;
    const tasks = await q(
      pool,
      `WITH reserve AS (
         SELECT related_task_id AS task_id, SUM(credits) AS reserved, MIN(timestamp_ms) AS at_ms FROM credit_transactions
          WHERE tx_type='spend' AND reason IN ('task_reserve','inference_reserve') GROUP BY 1),
       work AS (
         SELECT COALESCE(related_task_id, substring(reason FROM 13)) AS task_id, SUM(credits) AS paid FROM credit_transactions
          WHERE tx_type='earn' AND (reason='compute_contribution' OR reason LIKE 'network\\_fee:%') GROUP BY 1),
       refund AS (
         SELECT substring(reason FROM 20) AS task_id, SUM(credits) AS refunded FROM credit_transactions
          WHERE tx_type='earn' AND reason LIKE 'task_submit_refund:%' GROUP BY 1)
       SELECT r.task_id, r.reserved::text, COALESCE(w.paid,0)::text AS paid, COALESCE(f.refunded,0)::text AS refunded,
              (r.reserved - COALESCE(w.paid,0) - COALESCE(f.refunded,0))::text AS retained, r.at_ms::text
         FROM reserve r LEFT JOIN work w ON w.task_id = r.task_id LEFT JOIN refund f ON f.task_id = r.task_id`
    );
    const overpaid = tasks.filter((t) => Number(t.retained) < -0.000001);
    out.push({
      id: "task-never-overpays",
      title: "No task pays out (work + fees + refund) more than its requester set aside",
      status: overpaid.length ? "fail" : "pass",
      severity: "critical",
      detail: `${tasks.length} tasks checked (whole ledger), ${overpaid.length} paid out more than reserved, Σ ${r6(-overpaid.reduce((s, t) => s + Number(t.retained), 0))} cSats created`,
      evidence: { sample: overpaid.slice(0, 10), sql: "per related_task_id: reserve − work(compute_contribution + network_fee:<task>) − refund(task_submit_refund:<task>) < 0" }
    });
    const quiet = o.quiescentBeforeMs ?? Date.now() - 120_000;
    const retained = tasks.filter((t) => Number(t.retained) > 0.000001 && Number(t.at_ms) >= since && Number(t.at_ms) < quiet);
    const runTasks = tasks.filter((t) => Number(t.at_ms) >= since).length;
    const fullyRetained = retained.filter((t) => Number(t.paid) === 0 && Number(t.refunded) === 0);
    out.push({
      id: "task-reserve-settled",
      title: "Every settled task returns or pays out its whole reserve (retained = 0)",
      status: retained.length ? "warn" : "pass",
      severity: "medium",
      detail: `${retained.length}/${runTasks} tasks of this run older than the settle window still retain cSats (Σ ${r6(retained.reduce((s, t) => s + Number(t.retained), 0))}); ${fullyRetained.length} of them with nothing paid and nothing refunded`,
      evidence: { sample: retained.slice(0, 10), sql: "reserve(spend task_reserve|inference_reserve) − work(compute_contribution + network_fee:<task>) − refund(task_submit_refund:<task>) per related_task_id" }
    });

    // ── balances ──
    const negative = await q(pool, `SELECT account_id, SUM(CASE WHEN tx_type='spend' THEN -credits ELSE credits END)::text AS balance FROM credit_transactions GROUP BY 1 HAVING SUM(CASE WHEN tx_type='spend' THEN -credits ELSE credits END) < 0`);
    out.push({ id: "no-negative-balance", title: "No account balance is negative", status: negative.length ? "fail" : "pass", severity: "critical", detail: `${negative.length} negative`, evidence: { negative } });

    // ── credited at most once ──
    const dupAccrual = await q(pool, `SELECT subtask_id, COUNT(*)::int AS n FROM stats_ledger_records WHERE event_type='earnings_accrual' AND subtask_id IS NOT NULL AND issued_at_ms >= $1 GROUP BY 1 HAVING COUNT(*) > 1`, [since]);
    const dupReceipt = await q(pool, `SELECT subtask_id, COUNT(*)::int AS n FROM work_receipts WHERE stored_at_ms >= $1 GROUP BY 1 HAVING COUNT(*) > 1`, [since]);
    const earnVsReports = await q(
      pool,
      `SELECT t.account_id, t.related_task_id, t.rows, COALESCE(r.reports,0) AS reports FROM
         (SELECT account_id, related_task_id, COUNT(*)::int AS rows FROM credit_transactions WHERE tx_type='earn' AND reason='compute_contribution' AND timestamp_ms >= $1 GROUP BY 1,2) t
         LEFT JOIN (SELECT account_id, task_id, COUNT(*)::int AS reports FROM compute_contribution_reports GROUP BY 1,2) r
           ON r.account_id = t.account_id AND r.task_id = t.related_task_id
        WHERE t.rows <> COALESCE(r.reports,0)`,
      [since]
    );
    out.push({
      id: "subtask-credited-once",
      title: "Each executed subtask is credited at most once",
      status: dupAccrual.length || dupReceipt.length || earnVsReports.length ? "fail" : "pass",
      severity: "critical",
      detail: `duplicate earnings_accrual records: ${dupAccrual.length}; duplicate work receipts: ${dupReceipt.length}; (account, task) with earn rows != contribution reports: ${earnVsReports.length}`,
      evidence: { dupAccrual: dupAccrual.slice(0, 10), dupReceipt: dupReceipt.slice(0, 10), earnVsReports: earnVsReports.slice(0, 10) }
    });

    // ── top-ups ──
    const intents = await q(pool, `SELECT intent_id, account_id, amount_sats::int, quoted_credits::text, status, payment_hash, created_at_ms::text FROM payment_intents WHERE created_at_ms >= $1`, [since]);
    const purchaseRows = await q(pool, `SELECT substring(reason FROM 17) AS intent_id, COUNT(*)::int AS n, SUM(credits)::text AS credits FROM credit_transactions WHERE reason LIKE 'credit\\_purchase:%' GROUP BY 1`);
    const rowsByIntent = new Map(purchaseRows.map((r) => [r.intent_id, r]));
    const settled = intents.filter((i) => i.status === "settled");
    const badPurchase = settled.filter((i) => {
      const r = rowsByIntent.get(i.intent_id);
      return !r || r.n !== 1 || Math.abs(Number(r.credits) - Number(i.quoted_credits)) > 0.000001;
    });
    const settledIds = new Set((await q(pool, `SELECT intent_id FROM payment_intents WHERE status='settled'`)).map((r) => r.intent_id));
    const orphanPurchase = purchaseRows.filter((r) => !settledIds.has(r.intent_id));
    let lndCheck: InvariantResult | null = null;
    if (o.hub) {
      const invoices = await o.hub.listInvoices();
      const byHash = new Map(invoices.map((i) => [i.paymentHashHex, i]));
      const unbacked = settled.filter((i) => {
        const inv = i.payment_hash ? byHash.get(i.payment_hash) : undefined;
        return !inv || inv.state !== "SETTLED" || inv.amtPaidMsat < Number(i.amount_sats) * 1000;
      });
      const missed = intents.filter((i) => i.status !== "settled" && i.payment_hash && byHash.get(i.payment_hash)?.state === "SETTLED");
      lndCheck = {
        id: "topup-backed-by-lnd",
        title: "Every settled top-up has a settled hub invoice for its amount; no paid invoice left unsettled",
        status: unbacked.length ? "fail" : missed.length ? "warn" : "pass",
        severity: unbacked.length ? "critical" : "medium",
        detail: `${settled.length} settled intents; ${unbacked.length} without a matching SETTLED hub invoice; ${missed.length} paid on LND but intent not settled (yet)`,
        evidence: { unbacked: unbacked.slice(0, 10), missed: missed.slice(0, 10) }
      };
    }
    out.push({
      id: "topup-credited-once",
      title: "Each settled top-up credited exactly once with its quoted cSats; no purchase credit without a settled intent",
      status: badPurchase.length || orphanPurchase.length ? "fail" : "pass",
      severity: "critical",
      detail: `${settled.length} settled, ${badPurchase.length} with missing/duplicate/wrong credit, ${orphanPurchase.length} purchase rows for unsettled intents`,
      evidence: { badPurchase: badPurchase.slice(0, 10), orphanPurchase: orphanPurchase.slice(0, 10) }
    });
    if (lndCheck) out.push(lndCheck);
    else out.push({ id: "topup-backed-by-lnd", title: "Top-ups backed by LND", status: "skipped", severity: "critical", detail: "no hub LND credentials" });

    // ── payouts ──
    const payouts = await q(pool, `SELECT payout_id, account_id, coordinator_id, kind, payment_hash, bolt11, amount_msat::text, fee_msat::text, max_fee_msat::text, status, preimage, created_at_ms::text, error FROM payouts ORDER BY created_at_ms`);
    const dupHash = await q(pool, `SELECT payment_hash, COUNT(*)::int AS n FROM payouts GROUP BY 1 HAVING COUNT(*) > 1`);
    const dupBolt = await q(pool, `SELECT lower(bolt11) AS b, COUNT(*)::int AS n FROM payouts GROUP BY 1 HAVING COUNT(*) > 1`);
    const selfPay = await q(pool, `SELECT p.payout_id FROM payouts p JOIN payment_intents i ON i.payment_hash = p.payment_hash`);
    const badPreimage = payouts.filter((p) => p.status === "paid" && !preimageMatchesHash(p.preimage, p.payment_hash));
    let lndPaidTwice: unknown[] = [];
    let lndUnknown: unknown[] = [];
    let lndMismatch: unknown[] = [];
    if (o.hub) {
      const pays = await o.hub.listPayments();
      const succeeded = pays.filter((p) => p.status === "SUCCEEDED");
      const counts = new Map<string, number>();
      for (const p of succeeded) counts.set(p.paymentHashHex, (counts.get(p.paymentHashHex) ?? 0) + 1);
      lndPaidTwice = [...counts.entries()].filter(([, n]) => n > 1).map(([h, n]) => ({ hash: h, n }));
      const byHash = new Map(payouts.map((p) => [p.payment_hash, p]));
      lndUnknown = succeeded.filter((p) => !byHash.has(p.paymentHashHex)).map((p) => ({ hash: p.paymentHashHex, valueMsat: p.valueMsat }));
      lndMismatch = payouts
        .filter((p) => p.status === "paid")
        .filter((p) => {
          const l = succeeded.find((x) => x.paymentHashHex === p.payment_hash);
          return !l || l.valueMsat !== Number(p.amount_msat);
        })
        .map((p) => ({ payoutId: p.payout_id, hash: p.payment_hash }));
    }
    out.push({
      id: "payout-once",
      title: "No payout paid twice; payment hashes never reused; every paid payout matches one LND payment",
      status: dupHash.length || dupBolt.length || selfPay.length || badPreimage.length || lndPaidTwice.length || lndUnknown.length || lndMismatch.length ? "fail" : "pass",
      severity: "critical",
      detail: `${payouts.length} payouts (${payouts.filter((p) => p.status === "paid").length} paid, ${payouts.filter((p) => p.status === "pending").length} pending, ${payouts.filter((p) => p.status === "failed").length} failed); dup hash ${dupHash.length}, dup bolt11 ${dupBolt.length}, hash of our own top-up ${selfPay.length}, bad preimage ${badPreimage.length}, LND paid twice ${lndPaidTwice.length}, LND payment without payout row ${lndUnknown.length}, paid row without matching LND payment ${lndMismatch.length}${o.hub ? "" : " (LND side not checked)"}`,
      evidence: { dupHash, dupBolt, selfPay, badPreimage: badPreimage.slice(0, 5), lndPaidTwice, lndUnknown: lndUnknown.slice(0, 5), lndMismatch: lndMismatch.slice(0, 5) }
    });
    // Earnings hold and caps, replayed in creation order.
    const holdMs = o.settings.earningsHoldMs ?? 0;
    const earns = await q(pool, `SELECT account_id, timestamp_ms::text AS t, msat::text FROM credit_transactions WHERE tx_type='earn' AND msat IS NOT NULL AND msat > 0 ORDER BY timestamp_ms`);
    const earnsBy = new Map<string, Array<{ t: number; msat: number }>>();
    for (const e of earns) (earnsBy.get(e.account_id) ?? earnsBy.set(e.account_id, []).get(e.account_id)!).push({ t: Number(e.t), msat: Number(e.msat) });
    const holdViolations: unknown[] = [];
    const capViolations: unknown[] = [];
    const live = payouts.filter((p) => p.status === "paid" || p.status === "pending");
    const outflow = (p: any) => Number(p.amount_msat) + (p.status === "pending" ? Math.max(Number(p.fee_msat), Number(p.max_fee_msat)) : Number(p.fee_msat));
    // Payouts made before this run may have followed other settings (reconfigure.sh): only this
    // run's payouts are judged, against windows that still include the older ones.
    for (const p of live.filter((x) => Number(x.created_at_ms) >= since)) {
      const at = Number(p.created_at_ms);
      const matured = (earnsBy.get(p.account_id) ?? []).filter((e) => e.t <= at - holdMs).reduce((s, e) => s + e.msat, 0);
      const outSoFar = live.filter((x) => x.account_id === p.account_id && Number(x.created_at_ms) <= at).reduce((s, x) => s + Number(x.amount_msat), 0);
      if (outSoFar > matured) holdViolations.push({ payoutId: p.payout_id, accountId: p.account_id, createdAtMs: at, paidOutMsat: outSoFar, maturedEarnMsat: matured, holdMs });
      const self = Number(p.amount_msat) + Number(p.max_fee_msat);
      const day = 86_400_000;
      const acct = live.filter((x) => x.account_id === p.account_id && Number(x.created_at_ms) > at - day && Number(x.created_at_ms) <= at).reduce((s, x) => s + (x === p ? self : outflow(x)), 0);
      const glob = live.filter((x) => Number(x.created_at_ms) > at - day && Number(x.created_at_ms) <= at).reduce((s, x) => s + (x === p ? self : outflow(x)), 0);
      const s = o.settings;
      if (s.payoutMaxSingleSats && self > s.payoutMaxSingleSats * 1000) capViolations.push({ payoutId: p.payout_id, cap: "single", msat: self });
      if (s.payoutMaxAccountDailySats && acct > s.payoutMaxAccountDailySats * 1000) capViolations.push({ payoutId: p.payout_id, cap: "account_daily", msat: acct });
      if (s.payoutMaxGlobalDailySats && glob > s.payoutMaxGlobalDailySats * 1000) capViolations.push({ payoutId: p.payout_id, cap: "global_daily", msat: glob });
    }
    out.push({
      id: "payout-within-matured-earnings",
      title: `Payouts never exceed earnings matured past the hold (${holdMs} ms) at the time they were made`,
      status: holdViolations.length ? "fail" : "pass",
      severity: "critical",
      detail: `${live.filter((x) => Number(x.created_at_ms) >= since).length} paid/pending payouts of this run replayed (${live.length} in the ledger), ${holdViolations.length} over matured earnings`,
      evidence: { holdViolations: holdViolations.slice(0, 10) }
    });
    out.push({
      id: "payout-caps",
      title: "Payout caps (single, per-account 24 h, global 24 h) held",
      status: o.settings.payoutMaxSingleSats === undefined ? "skipped" : capViolations.length ? "fail" : "pass",
      severity: "critical",
      detail: `caps single=${o.settings.payoutMaxSingleSats} account=${o.settings.payoutMaxAccountDailySats} global=${o.settings.payoutMaxGlobalDailySats} sats; ${capViolations.length} violations (window counted as the service does: pending at max(fee, fee cap))`,
      evidence: { capViolations: capViolations.slice(0, 10) }
    });

    // ── verification → strikes → blacklist ──
    const mal = o.maliciousAgents ?? {};
    const wrong = mal.wrong_output ?? [];
    if (wrong.length) {
      const bl = await q(pool, `SELECT agent_id, reason_code, reason, timestamp_ms::text FROM blacklist_events WHERE agent_id = ANY($1)`, [wrong]);
      const blacklisted = new Set(bl.map((b) => b.agent_id));
      const earned = await q(
        pool,
        `SELECT c.source_agent_id, COUNT(*)::int AS n FROM compute_contribution_reports c WHERE c.source_agent_id = ANY($1) GROUP BY 1`,
        [wrong]
      );
      out.push({
        id: "mismatch-leads-to-blacklist",
        title: "Agents returning wrong outputs are struck and blacklisted (VRF001, 3 strikes/hour)",
        status: blacklisted.size === wrong.length ? "pass" : blacklisted.size > 0 ? "warn" : "fail",
        severity: "high",
        detail: `${blacklisted.size}/${wrong.length} wrong-output agents blacklisted; ${earned.reduce((s, e) => s + e.n, 0)} of their executions were credited (unsampled results pay unverified by design)`,
        evidence: { blacklistEvents: bl.slice(0, 10), creditedExecutions: earned }
      });
    }
    const pendingVer = await q(pool, `SELECT coordinator_id, COUNT(*)::int AS n, MIN(started_at_ms)::text AS oldest FROM pending_verifications GROUP BY 1`);
    out.push({ id: "pending-verifications", title: "Held verifications (should drain after the scenario)", status: "pass", severity: "info", detail: JSON.stringify(pendingVer) });

    // ── reservations ──
    const now = Date.now();
    const res = await q(pool, `SELECT reservation_id, account_id, record_json FROM compute_reservations`);
    const orphanActive = res.filter((r) => r.record_json.status === "active" && Number(r.record_json.endMs) < now - 3 * 60_000);
    const resSettle = await q(
      pool,
      `SELECT r.reservation_id,
              (SELECT COALESCE(SUM(credits),0) FROM credit_transactions WHERE tx_type='spend' AND reason='compute_reservation' AND related_task_id = r.reservation_id)::text AS prepaid,
              (SELECT COALESCE(SUM(credits),0) FROM credit_transactions WHERE tx_type='earn' AND related_task_id = 'reservation:' || r.reservation_id)::text AS paid,
              (SELECT COALESCE(SUM(credits),0) FROM credit_transactions WHERE tx_type='earn' AND reason = 'reservation_refund:' || r.reservation_id)::text AS refunded,
              r.record_json->>'status' AS status
         FROM compute_reservations r`
    );
    const resBad = resSettle.filter((r) => r.status === "ended" && Math.abs(Number(r.prepaid) - Number(r.paid) - Number(r.refunded)) > 0.001);
    const resOver = resSettle.filter((r) => Number(r.paid) + Number(r.refunded) > Number(r.prepaid) + 0.000001);
    out.push({
      id: "reservations-settled",
      title: "No orphaned reservations: none active past its end; every ended lease pays out + refunds exactly its prepayment",
      status: resOver.length ? "fail" : orphanActive.length || resBad.length ? "warn" : "pass",
      severity: resOver.length ? "critical" : "medium",
      detail: `${res.length} leases; ${orphanActive.length} still active > 3 min past end; ${resBad.length} ended with prepaid != paid + refund (±0.001 for cSat rounding); ${resOver.length} paid out more than prepaid`,
      evidence: { orphanActive: orphanActive.slice(0, 5).map((r) => ({ id: r.reservation_id, endMs: r.record_json.endMs })), resBad: resBad.slice(0, 5), resOver: resOver.slice(0, 5) }
    });
  } finally {
    await pool.end();
  }
  return out;
}

/** HTTP-only checks (every target). */
export async function httpInvariants(
  t: LoadedTarget,
  rec: Recorder | null,
  observed: {
    meshToken?: string;
    attacksAccepted: Record<string, number>;
    doubleCredited: Array<{ subtaskId: string; n: number; seen?: unknown }>;
    topupsPaidUnsettled: number;
    topupsPaid: number;
    balances: Array<{ accountId: string; cSats?: number }>;
  }
): Promise<InvariantResult[]> {
  const out: InvariantResult[] = [];
  const admin = t.creds.tokens?.admin;
  // Every route but a few public ones sits behind the mesh token (any registered agent holds it).
  const mesh = observed.meshToken ?? t.creds.tokens?.mesh;
  const adminHeaders = { "x-admin-token": admin ?? "", ...(mesh ? { "x-mesh-token": mesh } : {}) };
  for (const c of t.profile.coordinators) {
    const h = await call(rec, `GET /health/runtime [${c.id}]`, `${c.url}/health/runtime`);
    out.push({ id: `health-${c.id}`, title: `${c.id} /health/runtime ok`, status: h.status === 200 && h.json?.ok ? "pass" : "fail", severity: "high", detail: h.outcome, evidence: { body: h.json?.coordinator } });
    if (admin) {
      const lv = await call(rec, `GET /ledger/verify [${c.id}]`, `${c.url}/ledger/verify?max=20`, { headers: adminHeaders, timeoutMs: 120_000 });
      out.push({
        id: `ledger-verify-${c.id}`,
        title: `${c.id} built-in ledger reconciliation (/ledger/verify, #115)`,
        status: lv.status !== 200 ? "warn" : lv.json?.ok ? "pass" : "fail",
        severity: "critical",
        detail: lv.status === 200 ? `ok=${lv.json.ok} mismatches=${lv.json.mismatches} accounts=${lv.json.accountsChecked} accruals=${lv.json.accrualsChecked} warnings=${JSON.stringify(lv.json.warnings ?? lv.json.byKind ?? {})}` : lv.outcome,
        evidence: lv.status === 200 ? { byKind: lv.json.byKind, discrepancies: (lv.json.discrepancies ?? []).slice(0, 10), orderingChain: lv.json.orderingChain } : undefined
      });
      const pr = await call(rec, `GET /admin/payouts/reconciliation [${c.id}]`, `${c.url}/admin/payouts/reconciliation`, { headers: { "x-admin-token": admin } });
      const st = pr.json?.status ?? pr.json?.last?.status ?? pr.json?.state;
      out.push({
        id: `payout-reconcile-${c.id}`,
        title: `${c.id} payout reconciliation (ledger vs Lightning node)`,
        status: pr.status !== 200 ? "warn" : ["ok", "never_run", "unsupported"].includes(String(st)) || pr.json?.ok === true ? "pass" : "fail",
        severity: "critical",
        detail: pr.status === 200 ? JSON.stringify(pr.json).slice(0, 400) : pr.outcome
      });
      const pz = await call(rec, `GET /admin/payouts/pause [${c.id}]`, `${c.url}/admin/payouts/pause`, { headers: { "x-admin-token": admin } });
      out.push({ id: `payout-pause-${c.id}`, title: `${c.id} payout kill switch state`, status: pz.json?.paused ? "warn" : "pass", severity: "info", detail: JSON.stringify(pz.json ?? pz.outcome).slice(0, 300) });
    } else {
      out.push({ id: `ledger-verify-${c.id}`, title: `${c.id} ledger reconciliation`, status: "skipped", severity: "critical", detail: "no admin token in the credentials: /ledger/verify and /admin/payouts/reconciliation not readable; ledger conservation is unverified on this target" });
    }
    if (observed.meshToken) {
      const cap = await call(rec, `GET /capacity [${c.id}]`, `${c.url}/capacity`, { headers: { "x-mesh-token": observed.meshToken } });
      out.push({ id: `capacity-${c.id}`, title: `${c.id} /capacity totals`, status: cap.status === 200 ? "pass" : "warn", severity: "info", detail: cap.status === 200 ? JSON.stringify(cap.json?.totals) : cap.outcome });
    }
  }
  const attacked = Object.entries(observed.attacksAccepted).filter(([, n]) => n > 0);
  out.push({
    id: "attacks-refused",
    title: "Replayed, duplicate, unclaimed and oversized results are refused",
    status: attacked.length ? "fail" : "pass",
    severity: "critical",
    detail: attacked.length ? attacked.map(([k, n]) => `${k}: ${n} accepted`).join(", ") : "every attack request was refused",
    evidence: { attacksAccepted: observed.attacksAccepted }
  });
  out.push({
    id: "harness-double-credit",
    title: "No subtask answered as credited (200, not held) twice to the load generator",
    status: observed.doubleCredited.length ? "fail" : "pass",
    severity: "critical",
    detail: `${observed.doubleCredited.length} subtasks`,
    evidence: { sample: observed.doubleCredited.slice(0, 10) }
  });
  out.push({
    id: "topups-settle",
    title: "Every top-up the payee paid was settled by the coordinator",
    status: observed.topupsPaidUnsettled ? "fail" : "pass",
    severity: "high",
    detail: `${observed.topupsPaid} paid, ${observed.topupsPaidUnsettled} still unsettled at the end of the poll window`
  });
  const neg = observed.balances.filter((b) => (b.cSats ?? 0) < 0);
  out.push({ id: "balances-nonnegative-http", title: "Harness accounts' balances (portal /v1/account) are never negative", status: neg.length ? "fail" : "pass", severity: "critical", detail: `${observed.balances.length} accounts read, ${neg.length} negative`, evidence: { balances: observed.balances } });
  return out;
}
