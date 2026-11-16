// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Minimal reproduction: one code task executed twice across two peered coordinators, and the
 * ledger rows that follow (local cluster only; reads Postgres).
 *
 *   scripts/stress/up.sh
 *   npx tsx scripts/stress/repro/dup-execution.ts [workMs=5000]
 *
 * One honest agent on each coordinator (different provider accounts), one buyer submits one task
 * to coord-a. coord-a gossips a task_offer and delays its own claim by 3 s; coord-b accepts the
 * offer, its agent claims at once. coord-a keeps its copy because it has live local agents
 * (routes/mesh.ts task_claim handling), so after 3 s its agent claims the same subtask too. With
 * work longer than 3 s both agents execute it. Prints both claims and the task's credit rows.
 */
import pg from "pg";
import { SimAgent, newSharedState } from "../lib/agent.js";
import { SimBuyer } from "../lib/buyer.js";
import { closeDispatchers, sleep } from "../lib/http.js";
import { LndClient } from "../lib/lnd.js";
import { Recorder } from "../lib/metrics.js";
import { buyers, loadTarget, providers } from "../lib/target.js";

const workMs = Number(process.argv[2] ?? 5_000);
const t = loadTarget(process.env.STRESS_TARGET ?? "scripts/stress/targets/local.json");
if (!t.creds.postgresUrl) throw new Error("local target with database access required");
const rec = new Recorder();
const shared = newSharedState();
const runId = `dup${Date.now().toString(36).slice(-5)}`;
const [pa, pb] = providers(t);
const agents = t.profile.coordinators.slice(0, 2).map(
  (c, i) =>
    new SimAgent(
      { runId, index: i, owner: i === 0 ? pa : pb, coordinator: c, portalUrl: t.profile.portalUrl, behaviour: "honest", sandboxMode: "docker", models: [], latency: { medianMs: workMs, sigma: 0 }, failureRate: 0, heartbeatMs: 10_000, idlePollMs: 300, pulls: true },
      rec,
      shared
    )
);
for (const a of agents) if (!(await a.start())) throw new Error(`${a.agentId}: ${a.lastError}`);
const loops = agents.map((a) => a.loop());
const buyer = new SimBuyer(buyers(t)[0], t.profile.portalUrl, t.profile.coordinators, rec, runId, 0, shared);
if (((await buyer.balance()) ?? 0) < 50) await buyer.topup(2_000, new LndClient(t.creds.lnd!.payee!, rec, t.profile.lndServername));
const task = await buyer.submitTask(t.profile.coordinators[0], `print("dup ${runId}")`);
console.log(`submitted ${task.taskId} to ${task.coordinatorId}: ${task.submitOutcome}, subtasks ${task.subtaskIds.join(",")}`);
await buyer.awaitTask(task, Date.now() + 60_000, 500);
await sleep(workMs + 4_000);
for (const a of agents) a.stop();
buyer.stop();
await Promise.allSettled(loops);
const pool = new pg.Pool({ connectionString: t.creds.postgresUrl, max: 1 });
const claims = await pool.query(`SELECT event_type, subtask_id, actor_id, coordinator_id, issued_at_ms FROM stats_ledger_records WHERE task_id = $1 ORDER BY issued_at_ms`, [task.taskId]);
const rows = await pool.query(`SELECT tx_type, account_id, credits::text, reason FROM credit_transactions WHERE related_task_id = $1 OR reason LIKE '%' || $1 ORDER BY timestamp_ms`, [task.taskId]);
await pool.end();
console.log("ledger events:");
console.table(claims.rows);
console.log("credit rows:");
console.table(rows.rows);
const claimers = new Set(claims.rows.filter((r) => r.event_type === "task_claim").map((r) => r.actor_id));
const reserve = rows.rows.filter((r) => r.tx_type === "spend").reduce((s, r) => s + Number(r.credits), 0);
const out = rows.rows.filter((r) => r.tx_type === "earn").reduce((s, r) => s + Number(r.credits), 0);
console.log(`executed by ${claimers.size} agents; reserved ${reserve.toFixed(6)} cSats, paid out + refunded ${out.toFixed(6)} cSats (${out > reserve ? "MORE than reserved: credits created" : out < reserve ? "less than reserved: retained" : "balanced"})`);
await closeDispatchers();
process.exit(0);
