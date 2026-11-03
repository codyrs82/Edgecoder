import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { CreditTransaction } from "../../src/common/types.js";
import { jobCostMsat, splitJobCost } from "../../src/economy/job-pricing.js";
import { OrderingChain } from "../../src/ledger/chain.js";
import { reconcileLedger } from "../../src/ledger/reconcile.js";
import { createPeerKeys } from "../../src/mesh/peer.js";
import type { PostgresStore } from "../../src/db/postgres.js";
import { PG_URL, twoCoordinatorsOneDatabase, type SharedDb } from "../helpers/shared-pg.js";

// #115: /ledger/verify reconciliation against a real Postgres shared by two coordinators (the seed
// layout). Accruals are written the way the coordinator writes them (accruePricedJob +
// earnings_accrual record + projection); then the ledger is tampered with and must be flagged.

const FEE_POOL = "network:fee_pool";
const FEE_BPS = 1_000;
const keysA = createPeerKeys("coord-a");
const keysB = createPeerKeys("coord-b");

async function accrue(store: PostgresStore, chain: OrderingChain, coordinatorId: string, o: { account: string; taskId: string; subtaskId?: string; durationMs: number; msatPerCredit: number; cps: number }) {
  const subtaskId = o.subtaskId ?? randomUUID();
  const rate = o.msatPerCredit * o.cps;
  const costMsat = jobCostMsat(o.durationMs, rate);
  const { agentMsat, feeMsat } = splitJobCost(costMsat, FEE_BPS);
  const now = Date.now();
  const tx: CreditTransaction = { txId: randomUUID(), accountId: o.account, type: "earn", credits: Math.round(agentMsat) / 1000, reason: "compute_contribution", relatedTaskId: o.taskId, timestampMs: now, msat: agentMsat };
  const feeTx: CreditTransaction | undefined = feeMsat > 0 ? { txId: randomUUID(), accountId: FEE_POOL, type: "earn", credits: feeMsat / 1000, reason: `network_fee:${o.taskId}`, relatedTaskId: o.taskId, timestampMs: now, msat: feeMsat } : undefined;
  const inserted = await store.persistContributionWithCredit(
    {
      report: { reportId: `result:${subtaskId}`, agentId: o.account, taskId: o.taskId, resourceClass: "cpu", cpuSeconds: o.durationMs / 1000, gpuSeconds: 0, success: true, qualityScore: 1, timestampMs: now },
      accountId: o.account,
      sourceAgentId: `agent-of-${o.account}`,
      reliabilityScore: 1,
      weightedContribution: o.durationMs / 1000
    },
    tx,
    feeTx
  );
  expect(inserted).toBe(true);
  const record = chain.append({
    eventType: "earnings_accrual",
    taskId: o.taskId,
    subtaskId,
    actorId: o.account,
    coordinatorId,
    payloadJson: JSON.stringify({
      sourceAgentId: `agent-of-${o.account}`, accountId: o.account, credits: tx.credits, msat: agentMsat, costMsat, feeMsat, pricingBasis: "per_second",
      ratePerSecondMsat: rate, msatPerCredit: o.msatPerCredit, networkFeeBps: FEE_BPS, computeClass: "cpu", creditsPerSecond: o.cps, durationMs: o.durationMs, ok: true, resourceClass: "cpu"
    })
  });
  await store.persistLedgerRecord(record);
  if (await store.persistStatsLedgerRecord(record)) {
    await store.incrementCoordinatorEarningsProjection({ accountId: o.account, credits: tx.credits, taskCountDelta: 1, updatedAtMs: now });
  }
  return { subtaskId, record, tx };
}

describe.skipIf(!PG_URL)("ledger reconciliation on one Postgres shared by two coordinators", () => {
  let db: SharedDb;
  const chainA = new OrderingChain("coord-a", keysA.privateKeyPem);
  const chainB = new OrderingChain("coord-b", keysB.privateKeyPem);
  const verify = async () => reconcileLedger(await db.a.ledgerReconcileInput(FEE_POOL), { localCoordinatorIds: ["coord-a", "coord-b"], feePoolAccountId: FEE_POOL });

  beforeAll(async () => {
    db = await twoCoordinatorsOneDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  it("a consistent ledger written by both seeds reconciles", async () => {
    await accrue(db.a, chainA, "coord-a", { account: "acct-1", taskId: "task-1", durationMs: 12_345, msatPerCredit: 7, cps: 2 });
    await accrue(db.b, chainB, "coord-b", { account: "acct-1", taskId: "task-1", durationMs: 4_000, msatPerCredit: 7, cps: 2 });
    await accrue(db.b, chainB, "coord-b", { account: "acct-2", taskId: "task-2", durationMs: 60_000, msatPerCredit: 11, cps: 1 });
    // A spend within the balance.
    await db.a.debitCredits({ txId: randomUUID(), accountId: "acct-2", type: "spend", credits: 0.1, reason: "task_submit", timestampMs: Date.now() });

    const r = await verify();
    expect(r.discrepancies).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.accountsChecked).toBe(3); // acct-1, acct-2, fee pool
    expect(r.accrualsChecked).toBe(3);
    expect(r.accrualsRecomputed).toBe(3);
    expect(r.ledgerRecordsChecked).toBe(3);
    expect(r.warnings.chainGaps).toBe(0);
  });

  it("flags a duplicated credit row, an altered amount, a missing ledger record and a chain fork", async () => {
    const pool = db.poolA;
    // Duplicate credit row for an existing accrual (same task, a second earn row).
    await pool.query(
      `INSERT INTO credit_transactions (tx_id, account_id, tx_type, credits, reason, related_task_id, timestamp_ms, msat)
       VALUES ($1, 'acct-2', 'earn', 1, 'compute_contribution', 'task-2', $2, 1000)`,
      [randomUUID(), Date.now()]
    );
    // An accrual whose recorded amount was edited after the fact.
    await pool.query(`UPDATE credit_transactions SET credits = credits + 5, msat = msat + 5000 WHERE account_id = 'acct-1' AND related_task_id = 'task-1' AND tx_id = (SELECT tx_id FROM credit_transactions WHERE account_id = 'acct-1' AND related_task_id = 'task-1' LIMIT 1)`);
    // A credited report with no earnings_accrual record (credits paid outside the ledger).
    await db.a.persistContributionWithCredit(
      {
        report: { reportId: `result:${randomUUID()}`, agentId: "acct-3", taskId: "task-3", resourceClass: "cpu", cpuSeconds: 1, gpuSeconds: 0, success: true, qualityScore: 1, timestampMs: Date.now() },
        accountId: "acct-3", sourceAgentId: "agent-3", reliabilityScore: 1, weightedContribution: 1
      },
      { txId: randomUUID(), accountId: "acct-3", type: "earn", credits: 50, reason: "compute_contribution", relatedTaskId: "task-3", timestampMs: Date.now(), msat: 50_000 }
    );
    // A second record on the same predecessor (fork) in ledger_records.
    const fork = chainB.snapshot()[1]; // not the first record: GENESIS starts every process's chain
    await pool.query(
      `INSERT INTO ledger_records (id, event_type, task_id, subtask_id, actor_id, sequence, issued_at_ms, prev_hash, hash, signature)
       SELECT $1, event_type, task_id, subtask_id, actor_id, sequence, issued_at_ms, prev_hash, $2, signature FROM ledger_records WHERE id = $3`,
      [randomUUID(), `forged-${randomUUID()}`, fork.id]
    );

    const r = await verify();
    expect(r.ok).toBe(false);
    expect(r.byKind.duplicate_credit_rows).toBe(1);
    expect(r.byKind.credit_amount_mismatch).toBe(2); // task-2 (extra row) and task-1 (edited)
    expect(r.byKind.accrual_missing_ledger_record).toBe(1);
    expect(r.byKind.ledger_chain_fork).toBe(1);
    expect(r.discrepancies.find((d) => d.kind === "accrual_missing_ledger_record")?.accountId).toBe("acct-3");
  });

  it("flags a payload whose recorded split doesn't follow from its inputs, and a projection out of step", async () => {
    // Re-price one accrual's ledger payload (msat no longer = cost - fee).
    await db.poolA.query(
      `UPDATE stats_ledger_records SET payload_json = jsonb_set(payload_json, '{costMsat}', to_jsonb((payload_json->>'costMsat')::bigint * 2))
        WHERE event_type = 'earnings_accrual' AND task_id = 'task-2'`
    );
    await db.poolA.query(`UPDATE coordinator_earnings_projection SET total_credits = total_credits + 1 WHERE account_id = 'acct-2'`);
    const r = await verify();
    const pricing = r.discrepancies.find((d) => d.kind === "accrual_pricing_mismatch");
    expect(pricing?.taskId).toBe("task-2");
    expect(Object.keys(pricing!.detail)).toEqual(expect.arrayContaining(["msat", "feeMsat", "costMsat"]));
    expect(r.byKind.earnings_projection_mismatch).toBe(1);
  });

  it("is read-only: verifying changes no balance", async () => {
    const before = await db.poolA.query(`SELECT account_id, SUM(credits)::text AS s, COUNT(*) AS n FROM credit_transactions GROUP BY account_id ORDER BY account_id`);
    await verify();
    const after = await db.poolA.query(`SELECT account_id, SUM(credits)::text AS s, COUNT(*) AS n FROM credit_transactions GROUP BY account_id ORDER BY account_id`);
    expect(after.rows).toEqual(before.rows);
  });

  it("the periodic run happens once per window across both seeds (no double alert)", async () => {
    const window = 1_000_000_000_000 + Math.floor(Math.random() * 1e9);
    let runs = 0;
    const job = async () => {
      runs++;
      await new Promise((res) => setTimeout(res, 50));
      return { ok: false, mismatches: 3 };
    };
    // Both seeds' timers fire at once: one runs, the other is locked out or finds the window taken.
    const [ra, rb] = await Promise.all([db.a.withLedgerVerifyWindow(window, "coord-a", job), db.b.withLedgerVerifyWindow(window, "coord-b", job)]);
    expect(runs).toBe(1);
    expect([ra.ran, rb.ran].filter(Boolean)).toHaveLength(1);
    // A later tick in the same window, on either seed, skips.
    expect(await db.b.withLedgerVerifyWindow(window, "coord-b", job)).toEqual({ ran: false, reason: "already_ran" });
    expect(runs).toBe(1);
    const row = await db.poolA.query(`SELECT ok, mismatches, finished_at_ms FROM ledger_verifications WHERE window_start_ms = $1`, [window]);
    expect(row.rows[0]).toMatchObject({ ok: false, mismatches: 3 });
    // The next window runs again.
    expect((await db.a.withLedgerVerifyWindow(window + 1, "coord-a", job)).ran).toBe(true);
  });
});
