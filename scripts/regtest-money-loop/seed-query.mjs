// Runs inside a seed machine (/app) for scripts/regtest-money-loop.mjs, like deploy/lnd-test/e2e-seed.mjs:
// it uses the machine's own DATABASE_URL and tokens, so nothing secret leaves the machine. Prints JSON only.
//   spend <buyer> <sinceMs> <untilMs>  every task the buyer reserved in the window, with its rows
//   ledger-totals                      row and sum checks over the whole ledger
//   payouts <sinceMs>                  payout rows created since
//   transfer <from> <runId> <json [[accountId, sats], ...]> <feeBps>
//                                      test-network-only (regtest/signet) test earnings, balanced: a spend on <from> and,
//                                      per host, an earn (95 %) plus a network-fee earn on the pool
//   owners                             agent -> account
//   records <taskId,...>               ordering ledger records (coordinator that billed them)
//   address <accountId> <lightningAddress|->   register / clear the auto-payout address (coordinator route)
//   auto-payouts                       one automatic payout pass (the coordinator's own runAutoPayouts code)
//   withdraw <accountId> <bolt11>      a withdrawal through the coordinator route (PayoutService.withdraw)
//   ledger-verify                      the coordinator's #115 ledger reconciliation (/ledger/verify)
//   balance <accountId>                payout balance, payouts and policy (coordinator route)
//   resolve-pending                    (fixed builds only) settle stuck pending payouts from the node's record
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
const require = createRequire("/app/package.json");
const { Pool } = require("pg");
const [cmd, ...a] = process.argv.slice(2);
const out = (v) => console.log(JSON.stringify(v));
const base = "http://127.0.0.1:4301";
const headers = {
  "content-type": "application/json",
  "x-portal-service-token": process.env.PORTAL_SERVICE_TOKEN ?? "",
  "x-mesh-token": process.env.MESH_AUTH_TOKEN ?? "",
  "x-admin-token": process.env.ADMIN_API_TOKEN ?? ""
};
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
let pool;
const q = async (sql, p = []) => {
  pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  return (await pool.query(sql, p)).rows;
};
const n = (v) => (v === null || v === undefined ? 0 : Number(v));

try {
  if (cmd === "spend") {
    const [buyer, since, until] = a;
    const reserves = await q(
      `SELECT related_task_id AS task, SUM(credits) AS reserved, MIN(timestamp_ms) AS at FROM credit_transactions
        WHERE account_id = $1 AND tx_type = 'spend' AND reason IN ('inference_reserve','task_reserve') AND timestamp_ms BETWEEN $2 AND $3
        GROUP BY related_task_id`,
      [buyer, since, until]
    );
    const tasks = reserves.map((r) => r.task);
    const rows = tasks.length
      ? await q(
          `SELECT account_id, tx_type, credits, msat, reason, related_task_id, timestamp_ms FROM credit_transactions
            WHERE related_task_id = ANY($1) OR reason = ANY($2) OR reason = ANY($3)`,
          [tasks, tasks.map((t) => `task_submit_refund:${t}`), tasks.map((t) => `network_fee:${t}`)]
        )
      : [];
    // Which coordinator billed each call: its signed earnings_accrual record (stats ledger, both seeds).
    const coords = tasks.length ? await q(`SELECT task_id, coordinator_id, COUNT(*)::int AS n FROM stats_ledger_records WHERE event_type = 'earnings_accrual' AND task_id = ANY($1) GROUP BY 1, 2`, [tasks]) : [];
    out({ coords: coords.map((c) => ({ task: c.task_id, coordinator: c.coordinator_id, n: c.n })), reserves: reserves.map((r) => ({ task: r.task, reservedMicro: Math.round(n(r.reserved) * 1e6), at: n(r.at) })), rows: rows.map((r) => ({ account: r.account_id, type: r.tx_type, micro: Math.round(n(r.credits) * 1e6), msat: r.msat === null ? null : n(r.msat), reason: r.reason, task: r.related_task_id, at: n(r.timestamp_ms) })) });
  } else if (cmd === "ledger-totals") {
    const [neg] = await q(`SELECT COUNT(*)::int AS n FROM (SELECT account_id, SUM(CASE WHEN tx_type='spend' THEN -credits ELSE credits END) b FROM credit_transactions WHERE account_id <> 'network:fee_pool' GROUP BY 1 HAVING SUM(CASE WHEN tx_type='spend' THEN -credits ELSE credits END) < -0.000001) x`);
    const [dupTx] = await q(`SELECT COUNT(*)::int AS n FROM (SELECT tx_id FROM credit_transactions GROUP BY 1 HAVING COUNT(*) > 1) x`);
    const [dupPay] = await q(`SELECT COUNT(*)::int AS n FROM (SELECT payment_hash FROM payouts GROUP BY 1 HAVING COUNT(*) > 1) x`);
    const [paidTwice] = await q(`SELECT COUNT(*)::int AS n FROM (SELECT payment_hash FROM payouts WHERE status='paid' GROUP BY 1 HAVING COUNT(*) > 1) x`);
    const st = await q(`SELECT status, COUNT(*)::int AS n, COALESCE(SUM(amount_msat),0) AS amount, COALESCE(SUM(fee_msat),0) AS fee FROM payouts GROUP BY 1`);
    // Every payout has its debit; every settled one its refund / fee-excess row when one is due.
    const [noDebit] = await q(`SELECT COUNT(*)::int AS n FROM payouts p WHERE NOT EXISTS (SELECT 1 FROM credit_transactions c WHERE c.tx_id = 'payout:' || p.payout_id)`);
    const [failedNoRefund] = await q(`SELECT COUNT(*)::int AS n FROM payouts p WHERE status='failed' AND NOT EXISTS (SELECT 1 FROM credit_transactions c WHERE c.tx_id = 'payout_refund:' || p.payout_id)`);
    out({ negativeBalances: neg.n, duplicateTxIds: dupTx.n, duplicatePaymentHashes: dupPay.n, paidTwice: paidTwice.n, payoutsWithoutDebit: noDebit.n, failedWithoutRefund: failedNoRefund.n, payoutsByStatus: st.map((r) => ({ status: r.status, n: r.n, amountMsat: n(r.amount), feeMsat: n(r.fee) })) });
  } else if (cmd === "payouts") {
    const rows = await q(`SELECT payout_id, account_id, coordinator_id, kind, payment_hash, amount_msat, fee_msat, max_fee_msat, status, error, destination, created_at_ms, settled_at_ms FROM payouts WHERE created_at_ms >= $1 ORDER BY created_at_ms`, [a[0]]);
    out(rows.map((r) => ({ id: r.payout_id, account: r.account_id, coord: r.coordinator_id, kind: r.kind, hash: r.payment_hash, amountMsat: n(r.amount_msat), feeMsat: n(r.fee_msat), maxFeeMsat: n(r.max_fee_msat), status: r.status, error: r.error, destination: r.destination, createdAtMs: n(r.created_at_ms), settledAtMs: r.settled_at_ms === null ? null : n(r.settled_at_ms) })));
  } else if (cmd === "transfer") {
    const [from, runId, json, bps] = a;
    const net = process.env.BITCOIN_NETWORK;
    if (net !== "regtest" && net !== "signet") throw new Error(`refusing: transfer is for regtest/signet, this seed is on ${net}`);
    const list = JSON.parse(Buffer.from(json, "base64").toString("utf8"));
    const feeBps = Number(bps);
    const now = Date.now();
    const total = list.reduce((s, [, sats]) => s + sats, 0);
    const [bal] = await q(`SELECT COALESCE(SUM(CASE WHEN tx_type='spend' THEN -credits ELSE credits END),0) AS b FROM credit_transactions WHERE account_id = $1`, [from]);
    if (n(bal.b) < total) { out({ ok: false, error: "insufficient_balance", balance: n(bal.b), total }); process.exitCode = 1; }
    else {
      pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const reason = `${net}_e2e_test:${runId}`; // regtest_e2e_test / signet_e2e_test
        await c.query(`INSERT INTO credit_transactions (tx_id, account_id, tx_type, credits, reason, related_task_id, timestamp_ms, msat) VALUES ($1,$2,'spend',$3,$4,NULL,$5,NULL)`, [randomUUID(), from, total, reason, now]);
        const rows = [];
        for (const [acct, sats] of list) {
          const feeMsat = Math.floor((sats * 1000 * feeBps) / 10_000);
          const hostMsat = sats * 1000 - feeMsat;
          await c.query(`INSERT INTO credit_transactions (tx_id, account_id, tx_type, credits, reason, related_task_id, timestamp_ms, msat) VALUES ($1,$2,'earn',$3,$4,NULL,$5,$6)`, [randomUUID(), acct, hostMsat / 1000, reason, now, hostMsat]);
          await c.query(`INSERT INTO credit_transactions (tx_id, account_id, tx_type, credits, reason, related_task_id, timestamp_ms, msat) VALUES ($1,'network:fee_pool','earn',$2,$3,NULL,$4,$5)`, [randomUUID(), feeMsat / 1000, reason, now, feeMsat]);
          rows.push({ account: acct, hostMsat, feeMsat });
        }
        await c.query("COMMIT");
        out({ ok: true, reason, atMs: now, totalSats: total, rows });
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    }
  } else if (cmd === "owners") {
    out(await q(`SELECT agent_id, account_id FROM agent_ownership ORDER BY account_id`));
  } else if (cmd === "records") {
    const ids = a[0].split(",");
    const rows = await q(`SELECT task_id, event_type, coordinator_id, actor_id FROM ledger_records WHERE task_id = ANY($1)`, [ids]).catch((e) => [{ error: String(e.message) }]);
    out(rows);
  } else if (cmd === "address") out(await call("POST", "/economy/payouts/address", { accountId: a[0], lightningAddress: a[1] === "-" ? null : a[1] }));
  else if (cmd === "infer") {
    // Paid model calls billed by THIS coordinator, submitted the way the portal does (portal service token).
    const [acct, model, count, conc] = a;
    const results = [];
    let next = 0;
    const one = async (i) => {
      const taskId = `inf-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const sub = await call("POST", "/inference/submit", { taskId, submitterAccountId: acct, model, computeClass: "any", messages: [{ role: "user", content: `Write a one-line Python lambda that doubles x. (#${i})` }], maxTokens: 40 });
      if (sub.status !== 200) return { taskId, status: sub.status, error: sub.body?.error };
      let after = 0;
      for (let k = 0; k < 40; k++) {
        const r = await call("POST", "/inference/stream", { taskId, subtaskId: sub.body.subtaskId, after, waitMs: 15000 });
        if (r.status !== 200) return { taskId, status: r.status, error: r.body?.error };
        after = Number(r.body.next ?? after);
        if (r.body.done) return { taskId, status: 200, creditsSpent: r.body.creditsSpent, error: r.body.error };
      }
      return { taskId, status: 504 };
    };
    await Promise.all(Array.from({ length: Number(conc ?? 2) }, async () => { while (next < Number(count)) results.push(await one(next++)); }));
    out({ coordinator: process.env.FLY_APP_NAME, results });
  }
  else if (cmd === "ledger-verify") {
    const r = await call("GET", "/ledger/verify?max=20");
    const b = r.body ?? {};
    out({ status: r.status, ok: b.ok, mismatches: b.mismatches, byKind: b.byKind, accountsChecked: b.accountsChecked, accrualsChecked: b.accrualsChecked, accrualsRecomputed: b.accrualsRecomputed, notRecomputable: b.notRecomputable, orderingChain: b.orderingChain, discrepancies: (b.discrepancies ?? []).slice(0, 10), error: b.error });
  }
  else if (cmd === "withdraw") out(await call("POST", "/economy/payouts/withdraw", { accountId: a[0], bolt11: a[1] }));
  else if (cmd === "balance") out(await call("GET", `/economy/payouts/${encodeURIComponent(a[0])}`));
  else if (cmd === "auto-payouts") {
    // The coordinator runs PayoutService.runAutoPayouts on a timer (PAYOUT_AUTO_INTERVAL_MS, 6 h,
    // restarted with every deploy). This pass builds the same service from the machine's env and
    // dist/ (same store, node, caps, hold, pause and LNURL pins) and runs it once.
    const m = (p) => import(`/app/dist/${p}`);
    const { PostgresStore } = await m("db/postgres.js");
    const { PayoutService } = await m("economy/payout-service.js");
    const { PayoutPauseControl, payoutLimitsFromEnv, payoutsPausedByEnv } = await m("economy/payout-safeguards.js");
    const { payoutPolicyFromEnv } = await m("economy/payouts.js");
    const { createLightningProviderFromEnv } = await m("economy/lightning.js");
    const { fetchPublicJson } = await m("security/public-fetch.js");
    const store = PostgresStore.fromEnv();
    const network = process.env.BITCOIN_NETWORK;
    if (network === "bitcoin") throw new Error("refusing: mainnet");
    const ln = createLightningProviderFromEnv();
    const pause = new PayoutPauseControl({ store, envPaused: payoutsPausedByEnv() });
    const provider = { ...ln, createInvoice: (i) => ln.createInvoice(i), checkSettlement: (r, h) => ln.checkSettlement(r, h), payInvoice: async (i) => ((await pause.isPaused()) ? { status: "failed", error: "payouts_paused" } : ln.payInvoice(i)) };
    const svc = new PayoutService({
      store, pins: store.callbackPinStore(), provider, policy: payoutPolicyFromEnv(network), limits: payoutLimitsFromEnv(network), pause,
      coordinatorId: `${process.env.FLY_APP_NAME ?? "seed"}:auto-pass`, feePoolAccountId: "network:fee_pool",
      fetcher: (url) => fetchPublicJson(url, { timeoutMs: 10_000 })
    });
    const results = await svc.runAutoPayouts();
    out(results.map(({ accountId, result }) => ({ accountId, ok: result.ok, code: result.code, detail: result.detail, payoutId: result.payout?.payoutId, amountMsat: result.payout?.amountMsat, feeMsat: result.payout?.feeMsat, hash: result.payout?.paymentHash })));
    await store.close?.();
    process.exit(0);
  } else {
    out({ error: "unknown_command", cmd });
    process.exitCode = 2;
  }
} finally {
  await pool?.end();
}
