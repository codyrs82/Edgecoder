import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { CreditTransaction } from "../../src/common/types.js";
import { NETWORK_FEE_POOL_ACCOUNT } from "../../src/credits/store.js";
import { resultReportId } from "../../src/swarm/result-integrity.js";
import { PG_URL, twoCoordinatorsOneDatabase, type SharedDb } from "../helpers/shared-pg.js";

// #123: a gossiped subtask can be queued on both seeds (US, EU), and an agent on each may claim and
// run it. Each seed then accrues with its own random tx ids. The credit is keyed on the subtask
// (resultReportId), and both seeds share one database, so exactly one credit and one fee land.
// The origin seed never accrues a forwarded result (/result skips accrual for peer_forward).

function accrual(store: SharedDb["a"], subtaskId: string, taskId: string, accountId: string) {
  const now = Date.now();
  const tx: CreditTransaction = {
    txId: randomUUID(), accountId, type: "earn", credits: 9, reason: "compute_contribution",
    relatedTaskId: taskId, timestampMs: now, msat: 9_000,
  };
  const feeTx: CreditTransaction = {
    txId: randomUUID(), accountId: NETWORK_FEE_POOL_ACCOUNT, type: "earn", credits: 1,
    reason: `network_fee:${taskId}`, relatedTaskId: taskId, timestampMs: now, msat: 1_000,
  };
  return store.persistContributionWithCredit(
    {
      report: {
        reportId: resultReportId(subtaskId), agentId: accountId, taskId, resourceClass: "cpu",
        cpuSeconds: 10, gpuSeconds: 0, success: true, qualityScore: 1, timestampMs: now,
      },
      accountId, sourceAgentId: `agent-of-${accountId}`, reliabilityScore: 1, weightedContribution: 10,
    },
    tx,
    feeTx
  );
}

describe.skipIf(!PG_URL)("#123: one credit per subtask across two coordinators on one Postgres", () => {
  let db: SharedDb;
  beforeAll(async () => { db = await twoCoordinatorsOneDatabase(); });
  afterAll(async () => { await db?.close(); });

  const feeRows = async (taskId: string) =>
    Number((await db.poolA.query(
      "SELECT COUNT(*)::int AS n FROM credit_transactions WHERE account_id = $1 AND related_task_id = $2",
      [NETWORK_FEE_POOL_ACCOUNT, taskId]
    )).rows[0].n);

  it("the same gossiped subtask run on both seeds is credited once", async () => {
    const subtaskId = `sub-${randomUUID()}`;
    const taskId = `task-${randomUUID()}`;
    const usAcct = `acct-us-${randomUUID()}`;
    const euAcct = `acct-eu-${randomUUID()}`;

    const results = await Promise.all([accrual(db.a, subtaskId, taskId, usAcct), accrual(db.b, subtaskId, taskId, euAcct)]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const [us, eu] = await Promise.all([db.a.creditBalance(usAcct), db.b.creditBalance(euAcct)]);
    expect(us + eu).toBe(9);
    expect([us, eu].sort()).toEqual([0, 9]);
    expect(await feeRows(taskId)).toBe(1);
  });

  it("many concurrent accruals from both seeds still credit once", async () => {
    const subtaskId = `sub-${randomUUID()}`;
    const taskId = `task-${randomUUID()}`;
    const accounts = Array.from({ length: 8 }, (_, i) => `acct-${i}-${randomUUID()}`);

    const results = await Promise.all(
      accounts.map((acct, i) => accrual(i % 2 ? db.b : db.a, subtaskId, taskId, acct))
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    const balances = await Promise.all(accounts.map((acct) => db.a.creditBalance(acct)));
    expect(balances.reduce((s, b) => s + b, 0)).toBe(9);
    expect(await feeRows(taskId)).toBe(1);
  });

  it("a re-posted result on the other seed after the first credit accrues nothing", async () => {
    const subtaskId = `sub-${randomUUID()}`;
    const taskId = `task-${randomUUID()}`;
    const acct = `acct-${randomUUID()}`;

    expect(await accrual(db.a, subtaskId, taskId, acct)).toBe(true);
    expect(await accrual(db.b, subtaskId, taskId, acct)).toBe(false);
    expect(await db.b.creditBalance(acct)).toBe(9);
    expect(await feeRows(taskId)).toBe(1);
  });

  it("different subtasks of one task are each credited", async () => {
    const taskId = `task-${randomUUID()}`;
    const acct = `acct-${randomUUID()}`;
    const results = await Promise.all([
      accrual(db.a, `sub-${randomUUID()}`, taskId, acct),
      accrual(db.b, `sub-${randomUUID()}`, taskId, acct),
    ]);
    expect(results).toEqual([true, true]);
    expect(await db.a.creditBalance(acct)).toBe(18);
    expect(await feeRows(taskId)).toBe(2);
  });
});
