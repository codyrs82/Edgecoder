// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Named scenario profiles. Each sets its own default scale (overridable by STRESS_* env), runs
 * against a RunContext and records phases, extra numbers and findings. Invariants run afterwards
 * (run.ts). What a scenario may do is bounded by the target profile (allowedScenarios,
 * allowDatabase, allowDocker, allowAdminWrites, limits).
 */
import { randomUUID } from "node:crypto";
import { payoutBalance, withdraw } from "./buyer.js";
import type { RunContext, Scale } from "./context.js";
import { call, sleep } from "./http.js";
import { saturationPoint, summarizeEndpoint, type RampStep } from "./metrics.js";

export interface Scenario {
  name: string;
  description: string;
  defaults: Partial<Scale>;
  /** Requirements checked against the target before anything is sent. */
  needs?: { database?: boolean; docker?: boolean; portalServiceToken?: boolean; adminWrites?: boolean };
  run(ctx: RunContext): Promise<void>;
}

/** Errors and p95 of requests recorded in [fromMs, toMs) (from the timeline buckets). */
function windowStats(ctx: RunContext, fromMs: number, toMs: number) {
  const a = Math.floor((fromMs - ctx.rec.data.startedAtMs) / 1000);
  const b = Math.floor((toMs - ctx.rec.data.startedAtMs) / 1000);
  let ok = 0;
  let err = 0;
  for (const x of ctx.rec.data.timeline) if (x.t >= a && x.t < b) (ok += x.ok), (err += x.err);
  return { ok, err, errorRate: ok + err ? err / (ok + err) : 0 };
}

async function standardSetup(ctx: RunContext, opts: { agents?: number; maliciousFraction?: number; hardwareProfile?: Record<string, unknown> } = {}): Promise<void> {
  ctx.phase("setup");
  ctx.spawnBuyers(ctx.scale.buyers);
  await ctx.fundBuyers(Math.min(2_000, ctx.scale.topupSats / 2));
  await ctx.spawnAgents(opts.agents ?? ctx.scale.agents, { maliciousFraction: opts.maliciousFraction, hardwareProfile: opts.hardwareProfile });
  // Let the first heartbeats land so asks are posted before load.
  await sleep(3_000);
}

const smoke: Scenario = {
  name: "smoke",
  description: "Small end-to-end pass over every flow (CI-like): top-up, code tasks on both coordinators, inference, market order, reservation (+ reserved inference and cancel).",
  // Simulated work takes ~1.2 s: the coordinator's BHV001 rule blacklists an agent after three
  // results it reports as faster than 500 ms (src/security/anomaly-detector.ts).
  defaults: { agents: 6, buyers: 2, durationSec: 20, rate: 0.5, topupSats: 5_000, latency: { medianMs: 1_200, sigma: 0.3 }, noSandboxShare: 0.2, failureRate: 0 },
  async run(ctx) {
    await standardSetup(ctx);
    ctx.phase("load", { rate: ctx.scale.rate });
    const r = await ctx.drive(ctx.scale.rate, ctx.scale.durationSec, { inferenceShare: 0.25, taskTimeoutMs: 60_000 });
    ctx.phase("market+reservation");
    const b = ctx.buyers[0];
    const order = await b.marketOrder(ctx.t.profile.coordinators[0], "buy", 50_000);
    ctx.extra.marketOrder = order?.outcome;
    const res = await b.reserve("cpu", 5, ctx.t.profile.inferenceModel);
    ctx.extra.reservation = res.outcome;
    if (res.status === 200 && res.json?.reservation?.id) {
      const inf = await b.inference(`reserved/${res.json.reservation.id}/${ctx.t.profile.inferenceModel}`, "on my lease");
      ctx.extra.reservedInference = inf.outcome;
      const c = await b.cancelReservation(res.json.reservation.id);
      ctx.extra.reservationCancel = c.outcome;
    }
    ctx.phase("drain");
    await ctx.drain();
    const s = ctx.taskSummary(r.tasks);
    ctx.extra.tasks = s;
    if ((s.byStatus.completed ?? 0) + (s.byStatus.failed_injected ?? 0) < s.total) ctx.finding({ severity: "high", title: "smoke: not every code task completed", detail: JSON.stringify(s) });
    const infFail = r.inference.filter((x) => !x.outcome.startsWith("2"));
    if (infFail.length) ctx.finding({ severity: "high", title: "smoke: inference calls failed", detail: JSON.stringify(infFail.slice(0, 5)) });
  }
};

const ramp: Scenario = {
  name: "ramp",
  description: "Ramp offered load step by step (rate doubles) until the system stops keeping up; reports the saturation point.",
  defaults: { agents: 60, buyers: 6, durationSec: 30, rate: 1, topupSats: 60_000, latency: { medianMs: 1_200, sigma: 0.4 }, inferenceShare: 0.15 },
  async run(ctx) {
    await standardSetup(ctx);
    const stop = ctx.startGaugeSampler(5_000);
    const steps: RampStep[] = [];
    const maxRate = Number(process.env.STRESS_RAMP_MAX_RATE ?? 64);
    let saturatedSeen = 0;
    for (let rate = ctx.scale.rate; rate <= maxRate; rate *= 2) {
      const p = ctx.phase(`step ${rate}/s`, { rate });
      const from = Date.now();
      const r = await ctx.drive(rate, ctx.scale.durationSec, { taskTimeoutMs: 90_000, maxInFlight: 4_000 });
      // Count what finished within the step plus a grace of one step length.
      await Promise.race([ctx.drain(), sleep(ctx.scale.durationSec * 1000)]);
      const done = r.tasks.filter((t) => t.status === "completed").length + r.inference.filter((x) => x.outcome.startsWith("2")).length;
      const w = windowStats(ctx, from, Date.now());
      const e2e = r.tasks.filter((t) => t.completedAtMs).map((t) => t.completedAtMs! - t.submittedAtMs).sort((a, b) => a - b);
      const step: RampStep = {
        step: steps.length + 1,
        offeredPerSec: r.offered / ctx.scale.durationSec,
        completedPerSec: done / ctx.scale.durationSec,
        errorRate: w.errorRate,
        p95Ms: e2e.length ? e2e[Math.min(e2e.length - 1, Math.ceil(0.95 * e2e.length) - 1)] : 0
      };
      p.meta = { ...p.meta, ...step, tasks: ctx.taskSummary(r.tasks) };
      steps.push(step);
      ctx.log(`step ${rate}/s: completed ${step.completedPerSec.toFixed(2)}/s, errors ${(step.errorRate * 100).toFixed(1)}%, task p95 ${step.p95Ms} ms`);
      const sat = saturationPoint(steps, { maxP95Ms: 30_000 });
      if (sat.firstSaturated) saturatedSeen++;
      if (saturatedSeen >= 2) break;
    }
    stop();
    ctx.phase("drain");
    await ctx.drain();
    const sat = saturationPoint(steps, { maxP95Ms: 30_000 });
    ctx.extra.rampSteps = steps;
    ctx.extra.saturation = sat;
  }
};

const soak: Scenario = {
  name: "soak",
  description: "Sustained moderate load; watches latency drift, coordinator memory, event-loop lag and queue depth.",
  defaults: { agents: 40, buyers: 4, durationSec: 600, rate: 3, topupSats: 80_000 },
  async run(ctx) {
    await standardSetup(ctx);
    const stop = ctx.startGaugeSampler(10_000);
    ctx.phase("soak", { rate: ctx.scale.rate, durationSec: ctx.scale.durationSec });
    const r = await ctx.drive(ctx.scale.rate, ctx.scale.durationSec, { taskTimeoutMs: 120_000 });
    ctx.phase("drain");
    await ctx.drain();
    stop();
    ctx.extra.tasks = ctx.taskSummary(r.tasks);
    // Drift: compare first and last fifth of task end-to-end latency, and RSS growth.
    const done = r.tasks.filter((t) => t.completedAtMs).sort((a, b) => a.submittedAtMs - b.submittedAtMs);
    const fifth = Math.max(1, Math.floor(done.length / 5));
    const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
    const first = med(done.slice(0, fifth).map((t) => t.completedAtMs! - t.submittedAtMs));
    const last = med(done.slice(-fifth).map((t) => t.completedAtMs! - t.submittedAtMs));
    ctx.extra.latencyDrift = { firstFifthMedianMs: first, lastFifthMedianMs: last };
    for (const c of ctx.t.profile.coordinators) {
      const s = ctx.rec.data.series[`${c.id}.rss_mb`] ?? [];
      if (s.length >= 2) ctx.extra[`${c.id}.rssGrowthMb`] = s[s.length - 1].v - s[0].v;
    }
    if (last > first * 2 && last - first > 2_000) ctx.finding({ severity: "medium", title: "soak: task latency drifted upward under constant load", detail: `median first fifth ${first} ms, last fifth ${last} ms` });
  }
};

const churn: Scenario = {
  name: "churn",
  description: "Agents disconnect (some mid-task, abandoning the claim) and reconnect; checks lease requeue and that work still completes.",
  defaults: { agents: 40, buyers: 4, durationSec: 180, rate: 2, topupSats: 60_000, latency: { medianMs: 2_000, sigma: 0.5 } },
  async run(ctx) {
    await standardSetup(ctx);
    ctx.phase("churn", { rate: ctx.scale.rate });
    let churnEvents = 0;
    const churner = setInterval(() => {
      const pool = ctx.agents.filter((a) => a.cfg.pulls && a.state === "registered");
      const k = Math.max(1, Math.round(pool.length * Number(process.env.STRESS_CHURN_FRACTION ?? 0.15)));
      for (let i = 0; i < k; i++) {
        const a = pool[Math.floor(Math.random() * pool.length)];
        a.goOffline(10_000 + Math.random() * 20_000, Math.random() < 0.6);
        churnEvents++;
      }
    }, 10_000);
    const r = await ctx.drive(ctx.scale.rate, ctx.scale.durationSec, { taskTimeoutMs: 240_000 });
    clearInterval(churner);
    ctx.phase("drain (leases expire, work requeues)");
    await ctx.drain();
    const s = ctx.taskSummary(r.tasks);
    ctx.extra.tasks = s;
    ctx.extra.churnEvents = churnEvents;
    ctx.extra.abandoned = ctx.agents.reduce((n, a) => n + a.stats.abandoned, 0);
    const lost = (s.byStatus.timeout ?? 0) + (s.byStatus.failed ?? 0);
    if (lost > 0.02 * s.total) ctx.finding({ severity: "high", title: "churn: tasks lost when agents dropped mid-task", detail: `${lost}/${s.total} tasks failed or timed out (abandoned claims ${ctx.extra.abandoned}); ${JSON.stringify(s.byStatus)}` });
  }
};

const coordinatorKill: Scenario = {
  name: "coordinator-kill",
  description: "Steady load, then one coordinator is stopped mid-task and started again; measures lost/duplicated work and recovery. Live: prints the fly commands only.",
  defaults: { agents: 30, buyers: 4, durationSec: 150, rate: 2, topupSats: 60_000, latency: { medianMs: 3_000, sigma: 0.4 } },
  async run(ctx) {
    const victim = ctx.t.profile.coordinators[0];
    if (!ctx.t.profile.allowDocker) {
      ctx.notes.push(
        `coordinator-kill on ${ctx.t.profile.name} does not stop machines. Operator: while this run's load phase is going, run`,
        `  fly machine list -a ${victim.flyApp ?? victim.id}`,
        `  fly machine stop <machine-id> -a ${victim.flyApp ?? victim.id}    # ~40 s into the run`,
        `  fly machine start <machine-id> -a ${victim.flyApp ?? victim.id}   # ~20 s later`,
        "and note the times; the run reports what the agents and buyers saw."
      );
      for (const n of ctx.notes) ctx.log(n);
    }
    await standardSetup(ctx);
    const stopGauges = ctx.startGaugeSampler(5_000);
    ctx.phase("load before kill");
    const load = ctx.drive(ctx.scale.rate, ctx.scale.durationSec, { taskTimeoutMs: 300_000 });
    await sleep(40_000);
    if (ctx.t.profile.allowDocker && victim.container) {
      const mode = process.env.STRESS_KILL_MODE === "kill" ? "kill" : "stop";
      ctx.phase(`${mode} ${victim.id}`, { container: victim.container });
      const t0 = Date.now();
      await ctx.docker(mode, victim.container);
      ctx.extra.killedAtMs = t0;
      await sleep(Number(process.env.STRESS_DOWN_SEC ?? 20) * 1000);
      ctx.phase(`start ${victim.id}`);
      await ctx.docker("start", victim.container);
      // Healthy again?
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const h = await call(null, "h", `${victim.url}/health/runtime`);
        if (h.status === 200) break;
        await sleep(1_000);
      }
      ctx.extra.downtimeMs = Date.now() - t0;
      ctx.phase("load after restart");
    }
    const r = await load;
    ctx.phase("drain");
    await ctx.drain();
    stopGauges();
    const s = ctx.taskSummary(r.tasks);
    ctx.extra.tasks = s;
    ctx.extra.reRegistered = ctx.agents.reduce((n, a) => n + a.stats.reRegistered, 0);
    const byCoord: Record<string, Record<string, number>> = {};
    for (const t of r.tasks) {
      const m = (byCoord[t.coordinatorId] ??= {});
      m[t.status] = (m[t.status] ?? 0) + 1;
    }
    ctx.extra.tasksByCoordinator = byCoord;
    const victimLost = (byCoord[victim.id]?.timeout ?? 0) + (byCoord[victim.id]?.failed ?? 0);
    if (victimLost > 0) {
      ctx.finding({
        severity: "high",
        title: `coordinator-kill: ${victimLost} tasks submitted to ${victim.id} never completed after it restarted`,
        detail: `tasks by coordinator: ${JSON.stringify(byCoord)}. In-flight subtasks, held verifications and task billing live in process memory; see the invariant results for the cSats those tasks still retain.`,
        reproduction: "scripts/stress/up.sh; npx tsx scripts/stress/run.ts --target scripts/stress/targets/local.json --scenario coordinator-kill"
      });
    }
  }
};

const dbSlowdown: Scenario = {
  name: "db-slowdown",
  description: "Steady load while Postgres is made slow: an ACCESS EXCLUSIVE lock on credit_transactions, then the container paused.",
  defaults: { agents: 30, buyers: 4, durationSec: 120, rate: 2, topupSats: 60_000 },
  needs: { database: true, docker: true },
  async run(ctx) {
    await standardSetup(ctx);
    const stopGauges = ctx.startGaugeSampler(5_000);
    ctx.phase("baseline");
    const load = ctx.drive(ctx.scale.rate, ctx.scale.durationSec, { taskTimeoutMs: 240_000 });
    await sleep(20_000);
    const lockSec = Number(process.env.STRESS_LOCK_SEC ?? 15);
    ctx.phase(`lock credit_transactions ${lockSec}s`);
    const pool = ctx.pgPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("LOCK TABLE credit_transactions IN ACCESS EXCLUSIVE MODE");
      await sleep(lockSec * 1000);
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await pool.end();
    }
    ctx.phase("recover from lock");
    await sleep(20_000);
    const pauseSec = Number(process.env.STRESS_PAUSE_SEC ?? 10);
    ctx.phase(`pause postgres ${pauseSec}s`);
    await ctx.docker("pause", "ec-stress-pg");
    await sleep(pauseSec * 1000);
    await ctx.docker("unpause", "ec-stress-pg");
    ctx.phase("recover from pause");
    const r = await load;
    ctx.phase("drain");
    await ctx.drain();
    stopGauges();
    ctx.extra.tasks = ctx.taskSummary(r.tasks);
    ctx.extra.phaseErrors = ctx.phases.map((p) => ({ phase: p.name, ...windowStats(ctx, p.startMs, p.endMs ?? Date.now()) }));
  }
};

const payoutStorm: Scenario = {
  name: "payout-storm",
  description: "Providers earn, then fire many concurrent withdrawals (over payable, over caps, the same invoice to both coordinators at once, during a pause) to test the earnings hold, caps, kill switch and double-pay protection.",
  defaults: { agents: 40, buyers: 6, durationSec: 150, rate: 3, topupSats: 150_000, latency: { medianMs: 20_000, sigma: 0.2 }, inferenceShare: 0, noSandboxShare: 0, failureRate: 0 },
  needs: { portalServiceToken: true, adminWrites: true },
  async run(ctx) {
    const token = ctx.t.creds.tokens?.portalService!;
    const coords = ctx.t.profile.coordinators;
    const payee = ctx.payee;
    if (!payee) throw new Error("payout-storm needs the payee LND credentials");
    // CPU work pays ~5 sats per agent-hour at the reference price; datacenter-GPU agents (paid at
    // the gpu.dc base tier, unverified) earn enough in a few minutes to exercise payouts.
    await standardSetup(ctx, { hardwareProfile: { cpuCores: 32, ramGb: 256, gpu: { vendor: "nvidia", model: "H100", vramGb: 80, datacenter: true } } });
    await ctx.fundBuyers(50_000);
    ctx.phase("earn", { rate: ctx.scale.rate });
    const r = await ctx.drive(ctx.scale.rate, ctx.scale.durationSec, { taskTimeoutMs: 180_000, extraTask: { resourceClass: "gpu", computeClass: "gpu.dc" } });
    await ctx.drain();
    ctx.extra.tasks = ctx.taskSummary(r.tasks);
    const providerAccounts = [...new Set(ctx.agents.filter((a) => a.cfg.pulls).map((a) => a.accountId))];
    const balances = async () =>
      Object.fromEntries(
        await Promise.all(providerAccounts.map(async (acct) => [acct, (await payoutBalance(ctx.rec, coords[0], token, acct)).json?.balance ?? null] as const))
      );
    const before = await balances();
    ctx.extra.balancesBeforeStorm = before;
    ctx.log(`provider payout balances: ${JSON.stringify(before)}`);

    ctx.phase("withdraw inside the hold (expect refusal)");
    const inside: Record<string, number> = {};
    for (const acct of providerAccounts) {
      const inv = await payee.addInvoice(20, `stress hold ${acct}`);
      const w = await withdraw(ctx.rec, coords[0], token, acct, inv.bolt11, " (inside hold)");
      inside[w.outcome + (w.json?.code ? `:${w.json.code}` : "")] = (inside[w.outcome + (w.json?.code ? `:${w.json.code}` : "")] ?? 0) + 1;
    }
    ctx.extra.withdrawInsideHold = inside;
    const holdMs = ctx.t.settings.earningsHoldMs ?? 0;
    ctx.phase(`wait out the earnings hold (${holdMs} ms)`);
    await sleep(holdMs + 5_000);
    const afterHold = await balances();
    ctx.extra.balancesAfterHold = afterHold;

    ctx.phase("storm");
    const outcomes: Record<string, number> = {};
    const note = (k: string) => (outcomes[k] = (outcomes[k] ?? 0) + 1);
    const jobs: Promise<void>[] = [];
    const perAccount = Number(process.env.STRESS_WITHDRAWALS_PER_ACCOUNT ?? 12);
    const single = ctx.t.settings.payoutMaxSingleSats ?? 0;
    for (const acct of providerAccounts) {
      const bal = (afterHold[acct] as { payableMsat?: number; withdrawableMsat?: number } | null) ?? {};
      const payable = Math.floor(Number(bal.withdrawableMsat ?? bal.payableMsat ?? 0) / 1000);
      // Mixed sizes: most at a third of payable (several fit, the rest must be refused), one over the single cap.
      const amounts = Array.from({ length: perAccount }, (_, i) => (i === 0 && single ? single + 5 : Math.max(11, Math.floor(payable / 3))));
      for (const amt of amounts) {
        jobs.push(
          (async () => {
            const inv = await payee.addInvoice(amt, `stress storm ${acct}`);
            const w = await withdraw(ctx.rec, coords[Math.floor(Math.random() * coords.length)], token, acct, inv.bolt11, " (storm)");
            note(`${w.outcome}${w.json?.code && !w.outcome.includes(w.json.code) ? `:${w.json.code}` : ""}`);
          })()
        );
      }
      // The same invoice to both coordinators at once, three times each: at most one may pay.
      jobs.push(
        (async () => {
          const inv = await payee.addInvoice(Math.max(11, Math.floor(payable / 10)), `stress dup ${acct}`);
          const rs = await Promise.all(coords.flatMap((c) => [0, 1, 2].map(() => withdraw(ctx.rec, c, token, acct, inv.bolt11, " (same invoice x6)"))));
          const paid = rs.filter((x) => x.status === 200 && (x.json?.ok || x.json?.payout?.status === "paid")).length;
          note(`dup-invoice paid=${paid}`);
          if (paid > 1) ctx.finding({ severity: "critical", title: "payout-storm: the same invoice was paid more than once", detail: `account ${acct}: ${paid} of ${rs.length} concurrent withdrawals of one bolt11 reported paid`, evidence: rs.map((x) => x.outcome) });
        })()
      );
    }
    await Promise.all(jobs);
    ctx.extra.stormOutcomes = outcomes;

    ctx.phase("kill switch");
    const admin = ctx.t.creds.tokens?.admin;
    if (admin && ctx.t.profile.allowAdminWrites) {
      const pz = await call(ctx.rec, `POST /admin/payouts/pause [${coords[0].id}]`, `${coords[0].url}/admin/payouts/pause`, { body: { paused: true, reason: "stress payout-storm", actor: "stress" }, headers: { "x-admin-token": admin } });
      const during: Record<string, number> = {};
      await Promise.all(
        providerAccounts.flatMap((acct) =>
          coords.map(async (c) => {
            const inv = await payee.addInvoice(11, `stress paused ${acct}`);
            const w = await withdraw(ctx.rec, c, token, acct, inv.bolt11, " (paused)");
            during[w.outcome] = (during[w.outcome] ?? 0) + 1;
          })
        )
      );
      const rs = await call(ctx.rec, `POST /admin/payouts/pause [${coords[0].id}]`, `${coords[0].url}/admin/payouts/pause`, { body: { paused: false, reason: "stress payout-storm done", actor: "stress" }, headers: { "x-admin-token": admin } });
      ctx.extra.killSwitch = { pause: pz.outcome, withdrawalsWhilePaused: during, resume: rs.outcome };
      const leaked = Object.entries(during).filter(([k]) => k.startsWith("200")).reduce((s, [, v]) => s + v, 0);
      if (leaked) ctx.finding({ severity: "critical", title: "payout-storm: withdrawals went through while payouts were paused", detail: JSON.stringify(during) });
    }
    ctx.extra.balancesAfterStorm = await balances();
  }
};

const malicious: Scenario = {
  name: "malicious",
  description: "A share of agents misbehave (wrong output, replayed result, duplicate result, result for another agent's subtask, oversized body) under result verification.",
  defaults: { agents: 40, buyers: 4, durationSec: 180, rate: 3, maliciousFraction: 0.25, topupSats: 60_000, inferenceShare: 0, noSandboxShare: 0, failureRate: 0 },
  async run(ctx) {
    await standardSetup(ctx);
    ctx.phase("load with malicious agents");
    const r = await ctx.drive(ctx.scale.rate, ctx.scale.durationSec, { taskTimeoutMs: 180_000 });
    ctx.phase("drain");
    await ctx.drain();
    ctx.extra.tasks = ctx.taskSummary(r.tasks);
    const per: Record<string, { agents: number; blacklisted: number; claimed: number; accepted: number; held: number; rejected: number }> = {};
    for (const a of ctx.agents.filter((x) => x.cfg.pulls)) {
      const p = (per[a.cfg.behaviour] ??= { agents: 0, blacklisted: 0, claimed: 0, accepted: 0, held: 0, rejected: 0 });
      p.agents++;
      if (a.state === "blacklisted") p.blacklisted++;
      p.claimed += a.stats.claimed;
      p.accepted += a.stats.accepted;
      p.held += a.stats.held;
      p.rejected += a.stats.rejected;
    }
    ctx.extra.byBehaviour = per;
    // Wrong answers that reached the requester (the harness knows the right one).
    ctx.extra.attackCounters = Object.fromEntries(Object.entries(ctx.rec.data.counters).filter(([k]) => k.startsWith("attack.")));
  }
};

const marketBurst: Scenario = {
  name: "market-burst",
  description: "Bursts of standing orders, racing reservations on the same agents, cancels, reserved inference and below-ask bids.",
  defaults: { agents: 20, buyers: 8, durationSec: 60, rate: 1, topupSats: 80_000, latency: { medianMs: 1_200, sigma: 0.3 } },
  async run(ctx) {
    await standardSetup(ctx);
    const coords = ctx.t.profile.coordinators;
    ctx.phase("order burst");
    const orders = await Promise.all(
      ctx.buyers.flatMap((b, i) => Array.from({ length: 10 }, (_, k) => b.marketOrder(coords[(i + k) % coords.length], k % 2 ? "buy" : "sell", 1_000 + ((i * 37 + k * 101) % 90_000))))
    );
    const ord: Record<string, number> = {};
    for (const o of orders) ord[o?.outcome ?? "none"] = (ord[o?.outcome ?? "none"] ?? 0) + 1;
    ctx.extra.orderOutcomes = ord;
    ctx.phase("reservation race");
    const model = ctx.t.profile.inferenceModel;
    const reserveRs = await Promise.all(ctx.buyers.flatMap((b) => [0, 1, 2].map(() => b.reserve("cpu", 5, model).then((r) => ({ b, r })))));
    const resOut: Record<string, number> = {};
    for (const { r } of reserveRs) resOut[r.outcome] = (resOut[r.outcome] ?? 0) + 1;
    ctx.extra.reservationOutcomes = resOut;
    const held = reserveRs.filter(({ r }) => r.status === 200 && r.json?.reservation?.agentId).map(({ b, r }) => ({ b, id: r.json.reservation.id as string, agentId: r.json.reservation.agentId as string }));
    const perAgent = new Map<string, number>();
    for (const h of held) perAgent.set(h.agentId, (perAgent.get(h.agentId) ?? 0) + 1);
    const doubleBooked = [...perAgent.entries()].filter(([, n]) => n > 1);
    if (doubleBooked.length) ctx.finding({ severity: "critical", title: "market-burst: one agent leased to two reservations at once", detail: JSON.stringify(doubleBooked), evidence: held.filter((h) => perAgent.get(h.agentId)! > 1) });
    ctx.extra.reservationsHeld = held.length;
    ctx.phase("reserved inference + load with low bids");
    const reservedCalls = await Promise.all(held.slice(0, 6).map((h) => h.b.inference(`reserved/${h.id}/${model}`, "lease work")));
    const rc: Record<string, number> = {};
    for (const x of reservedCalls) rc[x.outcome] = (rc[x.outcome] ?? 0) + 1;
    ctx.extra.reservedInference = rc;
    // Bids far under any ask: these tasks should wait, never be claimed below the agents' price.
    const low = await ctx.drive(ctx.scale.rate, 15, { inferenceShare: 0, taskTimeoutMs: 30_000, extraTask: { maxBidMsatPerCredit: 1 } });
    await ctx.drain();
    ctx.extra.lowBidTasks = ctx.taskSummary(low.tasks);
    const lowCompleted = low.tasks.filter((t) => t.status === "completed").length;
    if (lowCompleted) ctx.notes.push(`${lowCompleted}/${low.tasks.length} tasks bid at 1 msat/credit were executed anyway (see clampToBand: the paid price is clamped to the class band, so a below-band bid matches)`);
    ctx.phase("cancel burst");
    const cancels = await Promise.all(held.map((h) => Promise.all([h.b.cancelReservation(h.id), h.b.cancelReservation(h.id)])));
    const cOut: Record<string, number> = {};
    for (const pair of cancels) for (const c of pair) cOut[c.outcome] = (cOut[c.outcome] ?? 0) + 1;
    ctx.extra.cancelOutcomes = cOut;
    ctx.phase("normal load after burst");
    const r = await ctx.drive(ctx.scale.rate, ctx.scale.durationSec, { taskTimeoutMs: 90_000 });
    await ctx.drain();
    ctx.extra.tasks = ctx.taskSummary(r.tasks);
    // Book snapshot (mesh token from an agent's /register).
    const tok = ctx.meshToken;
    if (tok) {
      const book = await call(ctx.rec, `GET /economy/market/book [${coords[0].id}]`, `${coords[0].url}/economy/market/book?computeClass=cpu`, { headers: { "x-mesh-token": tok } });
      ctx.extra.bookStatus = book.outcome;
    }
  }
};

export const SCENARIOS: Record<string, Scenario> = Object.fromEntries(
  [smoke, ramp, soak, churn, coordinatorKill, dbSlowdown, payoutStorm, malicious, marketBurst].map((s) => [s.name, s])
);

/** Why `scenario` may not run on this target, or null. */
export function scenarioRefusal(s: Scenario, t: { profile: { name: string; allowedScenarios: string[]; allowDatabase: boolean; allowDocker: boolean; allowAdminWrites: boolean }; creds: { tokens?: { portalService?: string } } }): string | null {
  if (!t.profile.allowedScenarios.includes(s.name)) return `scenario ${s.name} is not allowed on target ${t.profile.name} (allowedScenarios)`;
  if (s.needs?.database && !t.profile.allowDatabase) return `scenario ${s.name} needs direct database access, which target ${t.profile.name} does not allow`;
  if (s.needs?.docker && !t.profile.allowDocker) return `scenario ${s.name} needs docker control, which target ${t.profile.name} does not allow`;
  if (s.needs?.adminWrites && !t.profile.allowAdminWrites) return `scenario ${s.name} changes shared operator state, which target ${t.profile.name} does not allow`;
  if (s.needs?.portalServiceToken && !t.creds.tokens?.portalService) return `scenario ${s.name} needs the portal service token`;
  return null;
}

export { summarizeEndpoint, randomUUID };
