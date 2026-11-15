#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Merge a load run's results from every machine and line them up with the coordinators' own view.
 * Runs on the operator's machine.
 *
 *   node scripts/loadgen/report.mjs --app edgecoder-loadgen [--out report.json]
 *   node scripts/loadgen/report.mjs --files a.jsonl b.jsonl [--out report.json]
 *
 * --app: reads /tmp/loadgen-results.jsonl from each started machine of the Fly app (fly ssh).
 * Server side: GET /admin/network?range=... on each coordinator (admin token from
 * ~/.config/edgecoder/coordinator-admin-token or EDGECODER_ADMIN_TOKEN; never printed), keeps the
 * samples inside the run window and reports per stage: utilization (busy slots / slots), queue and
 * waiting-inference peaks, dispatch pickup p90, server TTFT p90, started/completed/failed and
 * no-capacity counts. The samples are in coordinator memory: a coordinator restart loses them.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { digestStage, mergeStage, table } from "./stats.mjs";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i < 0 ? d : argv[i + 1]; };
const files = argv.includes("--files") ? argv.slice(argv.indexOf("--files") + 1).filter((a) => !a.startsWith("--")) : [];
const APP = flag("app");
const COORDS = (flag("coordinators", "https://coordinator.edgecoder.io,https://coordinator-eu.edgecoder.io")).split(",");

function flyEnv() {
  const e = { ...process.env };
  if (!e.FLY_API_TOKEN) { const f = join(homedir(), ".config/edgecoder/fly.token"); if (existsSync(f)) e.FLY_API_TOKEN = readFileSync(f, "utf8").trim(); }
  return e;
}

const lines = [];
for (const f of files) lines.push(...readFileSync(f, "utf8").split("\n"));
if (APP) {
  const e = flyEnv();
  const machines = JSON.parse(execFileSync("fly", ["machines", "list", "-a", APP, "--json"], { env: e, encoding: "utf8" }));
  for (const m of machines) {
    if (m.state !== "started") { console.error(`machine ${m.id} (${m.region}) is ${m.state}; its results are gone`); continue; }
    try {
      const txt = execFileSync("fly", ["ssh", "console", "-a", APP, "--machine", m.id, "-q", "-C", "sh -c 'cat /tmp/loadgen-results.jsonl'"], { env: e, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
      lines.push(...txt.split("\n"));
    } catch (err) { console.error(`machine ${m.id} (${m.region}): ${String(err.message).slice(0, 120)}`); }
  }
}
const recs = lines.map((l) => l.trim()).filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
if (!recs.length) { console.error("no results"); process.exit(1); }

const runs = [...new Set(recs.map((r) => r.run))];
const run = flag("run", runs[runs.length - 1]);
const mine = recs.filter((r) => r.run === run);
const merged = {};
for (const r of mine.filter((x) => x.type === "stage")) merged[r.stage.stage] = mergeStage(merged[r.stage.stage], r.stage);
const stages = Object.values(merged).sort((a, b) => a.stage - b.stage);
if (!stages.length) {
  console.error(`run ${run}: no stage results yet (each machine writes them when its run and drain finish)`);
  process.exit(1);
}
const digests = stages.map(digestStage);
const summaries = mine.filter((r) => r.type === "summary");
const regions = [...new Set(mine.map((r) => r.region))];

// ---- server side
const tokenFile = join(homedir(), ".config/edgecoder/coordinator-admin-token");
const adminToken = process.env.EDGECODER_ADMIN_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "");
const t0 = Math.min(...stages.map((s) => s.startMs)), t1 = Math.max(...stages.map((s) => s.endMs ?? s.startMs));
const ageMs = Date.now() - t0;
const range = ageMs < 55 * 60_000 ? "1h" : ageMs < 5.5 * 3600_000 ? "6h" : "24h";
const server = {};
for (const c of COORDS) {
  try {
    const r = await fetch(`${c}/admin/network?range=${range}`, { headers: { "x-admin-token": adminToken, "user-agent": "edgecoder-loadgen/1.0 (report)" }, signal: AbortSignal.timeout(30_000) });
    const j = await r.json();
    server[c] = { region: j.coordinator?.region, uptimeSeconds: j.coordinator?.uptimeSeconds, bucketMs: j.series?.bucketMs, points: j.series?.points ?? [] };
  } catch (err) { server[c] = { error: String(err.message) }; }
}
const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
function serverWindow(from, to) {
  const out = {};
  for (const [c, s] of Object.entries(server)) {
    const pts = (s.points ?? []).filter((p) => p.atMs + (s.bucketMs ?? 15_000) > from && p.atMs <= to);
    if (!pts.length) { out[c] = { samples: 0, note: s.error ?? "no samples in the window (coordinator restarted?)" }; continue; }
    const util = pts.map((p) => (p.totalSlots ? (p.totalSlots - p.freeSlots) / p.totalSlots : 0));
    const max = (k) => Math.max(...pts.map((p) => p[k] ?? 0));
    const sum = (k) => pts.reduce((a, p) => a + (p[k] ?? 0), 0);
    const p90s = (k) => pts.map((p) => p[k]).filter((x) => x !== null);
    out[c] = {
      samples: pts.length,
      utilizationPct: { avg: r1((100 * util.reduce((a, b) => a + b, 0)) / util.length), peak: r1(100 * Math.max(...util)) },
      slots: { avg: r1(pts.reduce((a, p) => a + p.totalSlots, 0) / pts.length), busyAgentsPeak: max("busyAgents"), connectedAgents: max("connectedAgents") },
      queuePeak: max("queued"), waitingInferencePeak: max("waitingInference"), claimedPeak: max("claimed"),
      pickupP90MsMax: p90s("pickupP90").length ? Math.max(...p90s("pickupP90")) : null,
      ttftP90MsMax: p90s("ttftP90").length ? Math.max(...p90s("ttftP90")) : null,
      started: sum("started"), completed: sum("completed"), failed: sum("failed"), noCapacity: sum("noCapacity"), noAgentHasModel: sum("noAgentHasModel"),
    };
  }
  return out;
}

const report = {
  run, regions, machines: summaries.length, stopReasons: summaries.map((s) => `${s.region}:${s.stopReason}`),
  window: { from: new Date(t0).toISOString(), to: new Date(t1).toISOString() },
  cSatsSpent: Math.round(1000 * summaries.reduce((a, s) => a + (s.cSatsSpent ?? 0), 0)) / 1000,
  stages: digests.map((d, i) => ({ ...d, server: serverWindow(stages[i].startMs, stages[i].endMs ?? stages[i].startMs) })),
  serverWholeRun: serverWindow(t0, t1),
};
if (flag("out")) writeFileSync(flag("out"), JSON.stringify(report, null, 2));
console.log(`LOADGEN_REPORT ${JSON.stringify({ run, regions, machines: report.machines, stopReasons: report.stopReasons, window: report.window, cSatsSpent: report.cSatsSpent })}`);
console.log(`\nClient side, all regions (run ${run}):\n${table(digests)}`);
const rows = [];
for (const d of digests) for (const [k, g] of Object.entries(d.byModel)) rows.push({ ...g, stage: `${d.stage} ${k}`, offeredRate: "" });
console.log(`\nBy model:\n${table(rows)}`);
const crow = [];
for (const d of digests) for (const [k, g] of Object.entries(d.byClass)) crow.push({ ...g, stage: `${d.stage} ${k}`, offeredRate: "" });
console.log(`\nBy class asked for:\n${table(crow)}`);
const brow = [];
for (const d of digests) for (const [k, g] of Object.entries(d.byBehaviour)) brow.push({ ...g, stage: `${d.stage} ${k}`, offeredRate: "" });
console.log(`\nBy behaviour:\n${table(brow)}`);
console.log("\nServer side (coordinators' /admin/network samples in each stage's window):");
for (const s of report.stages) for (const [c, v] of Object.entries(s.server)) {
  console.log(`  stage ${s.stage} ${c.replace("https://", "")}: ${v.samples ? `util avg ${v.utilizationPct.avg}% peak ${v.utilizationPct.peak}%, busy agents peak ${v.slots.busyAgentsPeak}/${v.slots.connectedAgents}, queue peak ${v.queuePeak}, waiting inference peak ${v.waitingInferencePeak}, pickup p90 max ${v.pickupP90MsMax} ms, server ttft p90 max ${v.ttftP90MsMax} ms, started ${v.started} completed ${v.completed} failed ${v.failed} no_capacity ${v.noCapacity} no_agent_has_model ${v.noAgentHasModel}` : v.note}`);
}
