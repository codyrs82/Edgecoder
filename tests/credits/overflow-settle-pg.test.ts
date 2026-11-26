import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { CreditTransaction } from "../../src/common/types.js";
import { debitTxId, refundTxId } from "../../src/credits/store.js";
import { FEE_ROUNDING, splitJobCost } from "../../src/economy/job-pricing.js";
import { OrderingChain } from "../../src/ledger/chain.js";
import { reconcileLedger } from "../../src/ledger/reconcile.js";
import { createPeerKeys } from "../../src/mesh/peer.js";
import type { PostgresStore } from "../../src/db/postgres.js";
import { PG_URL, twoCoordinatorsOneDatabase, type SharedDb } from "../helpers/shared-pg.js";

/*
 * A model call's cost past its reserve, on a real Postgres (CI's credits-pg job): the rest is taken
 * from the buyer's balance in the same transaction as the host's earning
 * (PostgresStore.persistContributionWithOverflow, as credits/store.ts accruePricedJobWithOverflow
 * calls it), under the buyer's credit lock and the overflow's deterministic tx id. The ledger stays
 * balanced (/ledger/verify), no balance goes negative, a repeated report debits nothing, and two
 * calls of one buyer settling at once never take more than the balance holds.
 */

const FEE_POOL = "network:fee_pool";
const FEE_BPS = 500;
const keys = createPeerKeys("coord-overflow");

describe.skipIf(!PG_URL)("cost past the reserve settled from the buyer's balance (Postgres)", () => {
  let db: SharedDb;
  const chain = new OrderingChain("coord-overflow", keys.privateKeyPem);
  const verify = async () => reconcileLedger(await db.a.ledgerReconcileInput(FEE_POOL), { localCoordinatorIds: ["coord-overflow"], feePoolAccountId: FEE_POOL });
  const balance = async (account: string) =>
    Number((await db.poolA.query(`SELECT COALESCE(SUM(CASE WHEN tx_type = 'spend' THEN -credits ELSE credits END), 0)::text AS b FROM credit_transactions WHERE account_id = $1`, [account])).rows[0].b);

  beforeAll(async () => {
    db = await twoCoordinatorsOneDatabase();
  });
  afterAll(async () => {
    await db?.close();
  });

  async function fund(account: string, credits: number) {
    await db.a.persistCreditTransaction({ txId: randomUUID(), accountId: account, type: "earn", credits, reason: "test_funding", timestampMs: Date.now() });
  }

  /** Submit: the billing row and the reserve debit (reserveTaskBillingDebit). */
  async function reserve(store: PostgresStore, buyer: string, taskId: string, reserveMsat: number) {
    const tx: CreditTransaction = { txId: debitTxId(`reserve:${taskId}`), accountId: buyer, type: "spend", credits: reserveMsat / 1000, reason: "inference_reserve", relatedTaskId: taskId, timestampMs: Date.now() };
    const r = await store.reserveTaskBillingDebit({ taskId, coordinatorId: "coord-overflow", accountId: buyer, kind: "inference", perSubtaskReserveMsat: reserveMsat, createdAtMs: Date.now() }, tx);
    expect(r).toMatchObject({ billing: "inserted", debit: "applied" });
  }

  /** Settle one result as results.ts does: base from the reserve, the rest from the balance, then the ledger record. */
  async function settle(store: PostgresStore, o: { buyer: string; host: string; taskId: string; subtaskId: string; baseMsat: number; wantMsat: number }) {
    const now = Date.now();
    let split = { agentMsat: 0, feeMsat: 0 };
    let costMsat = 0;
    const report = { reportId: `result:${o.subtaskId}`, agentId: o.host, taskId: o.taskId, resourceClass: "gpu" as const, cpuSeconds: 0, gpuSeconds: 1, success: true, qualityScore: 1, timestampMs: now };
    const r = await store.persistContributionWithOverflow(
      { report, accountId: o.host, sourceAgentId: `agent-of-${o.host}`, reliabilityScore: 1, weightedContribution: 1 },
      (covered) => {
        costMsat = o.baseMsat + covered;
        split = splitJobCost(costMsat, FEE_BPS);
        const tx: CreditTransaction = { txId: randomUUID(), accountId: o.host, type: "earn", credits: split.agentMsat / 1000, reason: "compute_contribution", relatedTaskId: o.taskId, timestampMs: now, msat: split.agentMsat };
        const feeTx: CreditTransaction | undefined = split.feeMsat > 0 ? { txId: randomUUID(), accountId: FEE_POOL, type: "earn", credits: split.feeMsat / 1000, reason: `network_fee:${o.taskId}`, relatedTaskId: o.taskId, timestampMs: now, msat: split.feeMsat } : undefined;
        return { tx, ...(feeTx ? { feeTx } : {}) };
      },
      { accountId: o.buyer, wantMsat: o.wantMsat, txId: debitTxId(`overflow:${report.reportId}`), reason: "inference_reserve", relatedTaskId: o.taskId, timestampMs: now }
    );
    if (r.inserted) {
      const record = chain.append({
        eventType: "earnings_accrual", taskId: o.taskId, subtaskId: o.subtaskId, actorId: o.host, coordinatorId: "coord-overflow",
        payloadJson: JSON.stringify({ accountId: o.host, credits: split.agentMsat / 1000, msat: split.agentMsat, costMsat, feeMsat: split.feeMsat, pricingBasis: "tokens", networkFeeBps: FEE_BPS, feeRounding: FEE_ROUNDING, overflowMsat: r.coveredMsat, unpaidMsat: o.wantMsat - r.coveredMsat }),
      });
      await store.persistLedgerRecord(record);
      if (await store.persistStatsLedgerRecord(record)) await store.incrementCoordinatorEarningsProjection({ accountId: o.host, credits: split.agentMsat / 1000, taskCountDelta: 1, updatedAtMs: now });
    }
    return { ...r, costMsat, split };
  }

  /** Settle the billing: refund what was set aside and not used (refundTaskSubmit). */
  async function refund(store: PostgresStore, buyer: string, taskId: string, unusedMsat: number) {
    if (unusedMsat > 0) await store.persistCreditTransaction({ txId: refundTxId(taskId), accountId: buyer, type: "earn", credits: unusedMsat / 1000, reason: `task_submit_refund:${taskId}`, timestampMs: Date.now() });
    await store.markTaskBillingSettled(taskId, Date.now(), "coord-overflow");
  }

  it("covered in full: the host is paid the whole cost, the buyer is charged it, the ledger verifies", async () => {
    await fund("buyer-1", 100);
    await reserve(db.a, "buyer-1", "task-1", 10_000);
    const r = await settle(db.a, { buyer: "buyer-1", host: "host-1", taskId: "task-1", subtaskId: "sub-1", baseMsat: 10_000, wantMsat: 3_250 });
    expect(r).toMatchObject({ inserted: true, coveredMsat: 3_250, costMsat: 13_250 });
    await refund(db.a, "buyer-1", "task-1", 0);
    expect(await balance("buyer-1")).toBeCloseTo(100 - 13.25, 6);
    expect(await balance("host-1")).toBeCloseTo(r.split.agentMsat / 1000, 6);
    const totals = (await db.a.taskLedgerTotals([{ taskId: "task-1", refundTxId: refundTxId("task-1"), accountId: "buyer-1", kind: "inference" }])).get("task-1")!;
    expect(totals).toEqual({ reservedMsat: 13_250, paidMsat: 13_250, refundedMsat: 0 });
    const v = await verify();
    expect(v.discrepancies).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("the same report again: nothing written, nothing debited", async () => {
    const before = await balance("buyer-1");
    const r = await settle(db.b, { buyer: "buyer-1", host: "host-1", taskId: "task-1", subtaskId: "sub-1", baseMsat: 0, wantMsat: 3_250 });
    expect(r).toMatchObject({ inserted: false, coveredMsat: 0 });
    expect(await balance("buyer-1")).toBe(before);
  });

  it("a buyer who can't cover it all: the balance goes to 0 (never below), the rest is unpaid, the ledger verifies", async () => {
    await fund("buyer-2", 10.5);
    await reserve(db.a, "buyer-2", "task-2", 10_000);
    const r = await settle(db.a, { buyer: "buyer-2", host: "host-1", taskId: "task-2", subtaskId: "sub-2", baseMsat: 10_000, wantMsat: 3_250 });
    expect(r).toMatchObject({ inserted: true, coveredMsat: 500, costMsat: 10_500 });
    await refund(db.a, "buyer-2", "task-2", 0);
    expect(await balance("buyer-2")).toBe(0);
    const v = await verify();
    expect(v.discrepancies).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("an empty balance and nothing left of the reserve: no report, no rows", async () => {
    // Nothing funded: the reserve is refused at submit, so nothing is set aside.
    const refused = await db.a.reserveTaskBillingDebit(
      { taskId: "task-3", coordinatorId: "coord-overflow", accountId: "buyer-3", kind: "inference", perSubtaskReserveMsat: 1_000, createdAtMs: Date.now() },
      { txId: debitTxId("reserve:task-3"), accountId: "buyer-3", type: "spend", credits: 1, reason: "inference_reserve", relatedTaskId: "task-3", timestampMs: Date.now() }
    );
    expect(refused.debit).toBe("insufficient");
    const r = await settle(db.a, { buyer: "buyer-3", host: "host-1", taskId: "task-3", subtaskId: "sub-3", baseMsat: 0, wantMsat: 2_000 });
    expect(r).toMatchObject({ inserted: false, coveredMsat: 0 });
    expect((await db.poolA.query(`SELECT 1 FROM compute_contribution_reports WHERE report_id = 'result:sub-3'`)).rowCount).toBe(0);
    expect((await verify()).ok).toBe(true);
  });

  it("two calls of one buyer settling at once on both seeds never take more than the balance holds", async () => {
    await fund("buyer-4", 25);
    await reserve(db.a, "buyer-4", "task-4a", 10_000);
    await reserve(db.b, "buyer-4", "task-4b", 10_000);
    // 5 cSats left; each call wants 4 more.
    const [a, b] = await Promise.all([
      settle(db.a, { buyer: "buyer-4", host: "host-2", taskId: "task-4a", subtaskId: "sub-4a", baseMsat: 10_000, wantMsat: 4_000 }),
      settle(db.b, { buyer: "buyer-4", host: "host-2", taskId: "task-4b", subtaskId: "sub-4b", baseMsat: 10_000, wantMsat: 4_000 }),
    ]);
    expect(a.coveredMsat + b.coveredMsat).toBe(5_000);
    expect([a.coveredMsat, b.coveredMsat].sort()).toEqual([1_000, 4_000]);
    await refund(db.a, "buyer-4", "task-4a", 0);
    await refund(db.b, "buyer-4", "task-4b", 0);
    expect(await balance("buyer-4")).toBe(0);
    const v = await verify();
    expect(v.discrepancies).toEqual([]);
    expect(v.ok).toBe(true);
  });
});
