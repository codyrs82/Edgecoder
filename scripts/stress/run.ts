// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Stress harness entry point (also the entry of the bundled load generator, scripts/stress/bundle.sh).
 *
 *   npx tsx scripts/stress/run.ts --target scripts/stress/targets/local.json --scenario smoke
 *   node edgecoder-stress.mjs --target live-regtest.json --scenario ramp --region fra
 *
 * Options (flags or env):
 *   --target  / STRESS_TARGET     target profile JSON
 *   --scenario/ STRESS_SCENARIO   smoke | ramp | soak | churn | coordinator-kill | db-slowdown | payout-storm | malicious | market-burst
 *   --out     / STRESS_OUT_DIR    directory for results.json + report.md (default .stress-runs/<runId>)
 *   --region  / STRESS_REGION     label for this load generator (merged reports group by it)
 *   --run-id  / STRESS_RUN_ID     shared id when several load generators run one scenario together
 *   --stdout                      also print results.json to stdout
 *   --no-invariants               skip the post-run checks
 *   --during                      run the SQL checks every 60 s during the scenario (local only)
 *   --list                        list scenarios and exit
 * Scale: STRESS_AGENTS, STRESS_BUYERS, STRESS_DURATION_SEC, STRESS_RATE, STRESS_INFERENCE_SHARE,
 *   STRESS_MALICIOUS_FRACTION, STRESS_FAILURE_RATE, STRESS_LATENCY_MS, STRESS_LATENCY_SIGMA,
 *   STRESS_NO_SANDBOX_SHARE, STRESS_TOPUP_SATS (scenario defaults otherwise).
 * Exit code: 0 when no invariant failed and the scenario finished, 1 otherwise, 2 on bad usage.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { RunContext, scaleFromEnv } from "./lib/context.js";
import { closeDispatchers } from "./lib/http.js";
import { httpInvariants, sqlInvariants, type InvariantResult } from "./lib/invariants.js";
import { buildReport, renderMarkdown, type RunResult } from "./lib/report-lib.js";
import { SCENARIOS, scenarioRefusal } from "./lib/scenarios.js";
import { loadTarget } from "./lib/target.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  if (flag("list")) {
    for (const s of Object.values(SCENARIOS)) console.log(`${s.name.padEnd(18)} ${s.description}`);
    return 0;
  }
  const targetPath = arg("target") ?? process.env.STRESS_TARGET;
  const scenarioName = arg("scenario") ?? process.env.STRESS_SCENARIO;
  if (!targetPath || !scenarioName) {
    console.error("usage: run.ts --target <profile.json> --scenario <name> [--region r] [--out dir] [--stdout] [--during] | --list");
    return 2;
  }
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) {
    console.error(`unknown scenario ${scenarioName}; --list shows them`);
    return 2;
  }
  const t = loadTarget(targetPath);
  const refusal = scenarioRefusal(scenario, t);
  if (refusal) {
    console.error(`refused: ${refusal}`);
    return 2;
  }
  const scale = scaleFromEnv(process.env, scenario.defaults);
  if (scale.durationSec > t.profile.limits.maxDurationSec) {
    console.error(`refused: duration ${scale.durationSec}s exceeds the target limit ${t.profile.limits.maxDurationSec}s`);
    return 2;
  }
  const runId = arg("run-id") || process.env.STRESS_RUN_ID || `${new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12)}${Math.random().toString(36).slice(2, 5)}`;
  const region = arg("region") || process.env.STRESS_REGION || "local";
  // Agent ids must be unique per load generator when several share a run id.
  const agentRunId = region === "local" ? runId : `${runId}-${region}`.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
  const outDir = resolve(arg("out") || process.env.STRESS_OUT_DIR || join(".stress-runs", `${runId}-${scenario.name}${region === "local" ? "" : `-${region}`}`));
  mkdirSync(outDir, { recursive: true });
  const ctx = new RunContext(t, agentRunId, scale, scenario.name);
  ctx.log(`run ${runId} target=${t.profile.name} region=${region} scale=${JSON.stringify(scale)}`);
  const startedAtMs = Date.now();
  let error: string | undefined;
  const during: InvariantResult[] = [];
  let duringTimer: NodeJS.Timeout | undefined;
  if (flag("during") && t.profile.allowDatabase && t.creds.postgresUrl) {
    duringTimer = setInterval(() => {
      void sqlInvariants(t.creds.postgresUrl!, { sinceMs: startedAtMs, quiescentBeforeMs: 0, settings: t.settings })
        .then((rs) => {
          for (const r of rs.filter((x) => x.status === "fail")) during.push({ ...r, id: `${r.id}@${Math.round((Date.now() - startedAtMs) / 1000)}s`, title: `(during run) ${r.title}` });
        })
        .catch(() => undefined);
    }, 60_000);
  }
  try {
    await scenario.run(ctx);
  } catch (err) {
    error = err instanceof Error ? `${err.message}\n${err.stack ?? ""}`.slice(0, 2_000) : String(err);
    ctx.log(`scenario error: ${error}`);
  } finally {
    if (duringTimer) clearInterval(duringTimer);
    ctx.endPhase();
    ctx.phase("stop agents");
    await ctx.stopAll();
    ctx.endPhase();
  }
  let invariants: InvariantResult[] = [...during];
  if (!flag("no-invariants")) {
    ctx.log("invariants");
    const attacksAccepted: Record<string, number> = {};
    for (const [k, v] of Object.entries(ctx.rec.data.counters)) if (/^attack\.[a-z_]+\.accepted$/.test(k)) attacksAccepted[k] = v;
    const doubleCredited = [...ctx.shared.acceptedResults.entries()].filter(([, seen]) => seen.length > 1).map(([subtaskId, seen]) => ({ subtaskId, n: seen.length, seen }));
    const topups = ctx.buyers.flatMap((b) => b.topups);
    const balances = await Promise.all(
      [...new Map(ctx.buyers.map((b) => [b.account.accountId, b])).values()].map(async (b) => ({ accountId: b.account.accountId, cSats: await b.balance() }))
    );
    invariants.push(
      ...(await httpInvariants(t, null, {
        meshToken: ctx.meshToken,
        attacksAccepted,
        doubleCredited,
        topupsPaid: topups.filter((x) => x.paid).length,
        topupsPaidUnsettled: topups.filter((x) => x.paid && !x.settled).length,
        balances
      }))
    );
    if (t.profile.allowDatabase && t.creds.postgresUrl) {
      const maliciousAgents: Record<string, string[]> = {};
      for (const a of ctx.agents) if (a.cfg.behaviour !== "honest") (maliciousAgents[a.cfg.behaviour] ??= []).push(a.agentId);
      try {
        invariants.push(...(await sqlInvariants(t.creds.postgresUrl, { sinceMs: startedAtMs, quiescentBeforeMs: Date.now() - 15_000, settings: t.settings, hub: ctx.hub, maliciousAgents })));
      } catch (err) {
        invariants.push({ id: "sql-invariants", title: "SQL invariants", status: "fail", severity: "high", detail: `could not run: ${(err as Error).message}` });
      }
    } else {
      invariants.push({ id: "sql-invariants", title: "Direct ledger checks (SQL)", status: "skipped", severity: "info", detail: `target ${t.profile.name} allows no database access; conservation, hold, caps and LND matching rely on /ledger/verify and /admin/payouts/reconciliation (admin token) only` });
    }
  }
  const result: RunResult = {
    schema: "edgecoder-stress-run/1",
    runId,
    scenario: scenario.name,
    target: t.profile.name,
    targetKind: t.profile.kind,
    region,
    host: hostname(),
    startedAtMs,
    endedAtMs: Date.now(),
    scale,
    metrics: ctx.rec.data,
    phases: ctx.phases,
    extra: { ...ctx.extra, counters: ctx.rec.data.counters, agents: summarizeAgents(ctx) },
    invariants,
    findings: ctx.findings,
    notes: ctx.notes,
    ...(error ? { error } : {})
  };
  const json = JSON.stringify(result);
  writeFileSync(join(outDir, "results.json"), json);
  const report = buildReport([result]);
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(outDir, "report.md"), renderMarkdown(report));
  if (flag("stdout")) process.stdout.write(json + "\n");
  const failed = invariants.filter((i) => i.status === "fail");
  ctx.log(`done: ${report.totals.requests} requests, ${failed.length} invariant failures, ${report.findings.length} findings -> ${outDir}/report.md`);
  await closeDispatchers();
  return error || failed.length ? 1 : 0;
}

function summarizeAgents(ctx: RunContext) {
  const by: Record<string, Record<string, number>> = {};
  for (const a of ctx.agents) {
    const k = `${a.cfg.pulls ? a.cfg.behaviour : "submitter"}/${a.cfg.sandboxMode}`;
    const m = (by[k] ??= { count: 0 });
    m.count++;
    m[`state:${a.state}`] = (m[`state:${a.state}`] ?? 0) + 1;
    for (const [s, v] of Object.entries(a.stats)) m[s] = (m[s] ?? 0) + v;
  }
  return by;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
