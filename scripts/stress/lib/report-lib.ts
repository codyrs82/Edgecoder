// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Run results (one load generator) and the report built from one or more of them (several
 * load-generator VMs in different regions running the same scenario at the same time).
 */
import { isOk, mergeEndpointData, summarizeEndpoint, type EndpointData, type RunMetrics } from "./metrics.js";
import type { Finding, Phase, Scale } from "./context.js";
import type { InvariantResult } from "./invariants.js";

export interface RunResult {
  schema: "edgecoder-stress-run/1";
  runId: string;
  scenario: string;
  target: string;
  targetKind: "local" | "remote";
  region: string;
  host: string;
  startedAtMs: number;
  endedAtMs: number;
  scale: Scale;
  metrics: RunMetrics;
  phases: Phase[];
  extra: Record<string, unknown>;
  invariants: InvariantResult[];
  findings: Finding[];
  notes: string[];
  error?: string;
}

const SEV_ORDER = ["critical", "high", "medium", "low", "info"] as const;

function baseEndpoint(name: string): string {
  return name.replace(/ \[[^\]]+\]/, "");
}

export interface Report {
  schema: "edgecoder-stress-report/1";
  scenario: string;
  target: string;
  runs: Array<{ runId: string; region: string; host: string; startedAtMs: number; endedAtMs: number; error?: string }>;
  durationSec: number;
  totals: { requests: number; errors: number; rps: number; errorRate: number };
  endpoints: ReturnType<typeof summarizeEndpoint>[];
  endpointsByRegion: Record<string, ReturnType<typeof summarizeEndpoint>[]>;
  errorsByOutcome: Array<{ endpoint: string; outcome: string; count: number }>;
  saturation?: unknown;
  rampSteps?: unknown;
  phases: Phase[];
  extra: Record<string, unknown>;
  invariants: Array<InvariantResult & { region?: string }>;
  findings: Array<Finding & { source: string }>;
  notes: string[];
}

export function buildReport(results: RunResult[]): Report {
  if (!results.length) throw new Error("no results");
  const scenario = [...new Set(results.map((r) => r.scenario))].join("+");
  const start = Math.min(...results.map((r) => r.startedAtMs));
  const end = Math.max(...results.map((r) => r.endedAtMs));
  const durationSec = Math.max(1, (end - start) / 1000);
  // Endpoints merged across runs, keyed by the full name (coordinator included).
  const names = new Set(results.flatMap((r) => Object.keys(r.metrics.endpoints)));
  const merged: Record<string, EndpointData> = {};
  for (const n of names) merged[n] = mergeEndpointData(results.map((r) => r.metrics.endpoints[n]).filter(Boolean));
  const endpoints = Object.entries(merged).map(([n, e]) => summarizeEndpoint(n, e)).sort((a, b) => b.count - a.count);
  const endpointsByRegion: Record<string, ReturnType<typeof summarizeEndpoint>[]> = {};
  if (results.length > 1) {
    for (const r of results) {
      const byBase: Record<string, EndpointData[]> = {};
      for (const [n, e] of Object.entries(r.metrics.endpoints)) (byBase[baseEndpoint(n)] ??= []).push(e);
      endpointsByRegion[r.region] = Object.entries(byBase).map(([n, es]) => summarizeEndpoint(n, mergeEndpointData(es))).sort((a, b) => b.count - a.count);
    }
  }
  let requests = 0;
  let errors = 0;
  const errorsByOutcome: Report["errorsByOutcome"] = [];
  for (const e of endpoints) {
    for (const [k, v] of Object.entries(e.outcomes)) {
      requests += v;
      if (!isOk(k)) {
        errors += v;
        errorsByOutcome.push({ endpoint: e.endpoint, outcome: k, count: v });
      }
    }
  }
  errorsByOutcome.sort((a, b) => b.count - a.count);
  const findings: Report["findings"] = [];
  for (const r of results) {
    for (const f of r.findings) findings.push({ ...f, source: `${r.region}/${r.scenario}` });
    if (r.error) findings.push({ severity: "high", title: `scenario aborted on ${r.region}`, detail: r.error, source: r.region });
  }
  const invariants: Report["invariants"] = [];
  for (const r of results) for (const i of r.invariants) invariants.push(results.length > 1 ? { ...i, region: r.region } : i);
  for (const i of invariants) {
    if (i.status === "fail" || i.status === "warn") {
      findings.push({
        severity: i.status === "fail" ? i.severity : i.severity === "critical" || i.severity === "high" ? "medium" : i.severity,
        title: `invariant ${i.status}: ${i.title}`,
        detail: i.detail,
        evidence: i.evidence,
        source: `invariant ${i.id}${i.region ? ` (${i.region})` : ""}`
      });
    }
  }
  // Unexpected server errors (5xx / transport) are findings too, with their recorded evidence.
  const evidence = results.flatMap((r) => r.metrics.evidence.map((e) => ({ ...e, region: r.region })));
  for (const eo of errorsByOutcome) {
    if (!/^(5\d\d|0:)/.test(eo.outcome)) continue;
    const ev = evidence.filter((e) => e.endpoint === eo.endpoint && e.outcome === eo.outcome).slice(0, 2);
    findings.push({ severity: eo.count > 10 ? "high" : "medium", title: `${eo.count} × ${eo.outcome} on ${eo.endpoint}`, detail: "server error or transport failure seen by the load generator", evidence: ev, source: "requests" });
  }
  findings.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  const extra: Record<string, unknown> = results.length === 1 ? results[0].extra : Object.fromEntries(results.map((r) => [r.region, r.extra]));
  return {
    schema: "edgecoder-stress-report/1",
    scenario,
    target: [...new Set(results.map((r) => r.target))].join("+"),
    runs: results.map((r) => ({ runId: r.runId, region: r.region, host: r.host, startedAtMs: r.startedAtMs, endedAtMs: r.endedAtMs, ...(r.error ? { error: r.error } : {}) })),
    durationSec,
    totals: { requests, errors, rps: requests / durationSec, errorRate: requests ? errors / requests : 0 },
    endpoints,
    endpointsByRegion,
    errorsByOutcome: errorsByOutcome.slice(0, 50),
    saturation: results.length === 1 ? results[0].extra.saturation : results.map((r) => ({ region: r.region, saturation: r.extra.saturation })),
    rampSteps: results.length === 1 ? results[0].extra.rampSteps : undefined,
    phases: results[0].phases,
    extra,
    invariants,
    findings,
    notes: [...new Set(results.flatMap((r) => r.notes))]
  };
}

const fmt = (n: number | undefined, d = 0) => (n === undefined || !Number.isFinite(n) ? "–" : n.toFixed(d));

export function renderMarkdown(rep: Report): string {
  const L: string[] = [];
  L.push(`# Stress run: ${rep.scenario} on ${rep.target}`);
  L.push("");
  L.push(`- Runs: ${rep.runs.map((r) => `${r.runId} (${r.region}${r.error ? `, aborted: ${r.error}` : ""})`).join(", ")}`);
  L.push(`- Window: ${new Date(Math.min(...rep.runs.map((r) => r.startedAtMs))).toISOString()} – ${new Date(Math.max(...rep.runs.map((r) => r.endedAtMs))).toISOString()} (${fmt(rep.durationSec)} s)`);
  L.push(`- Requests: ${rep.totals.requests} (${fmt(rep.totals.rps, 1)}/s), unexpected errors ${rep.totals.errors} (${fmt(rep.totals.errorRate * 100, 2)}%)`);
  const inv = rep.invariants;
  L.push(`- Invariants: ${inv.filter((i) => i.status === "pass").length} pass, ${inv.filter((i) => i.status === "fail").length} fail, ${inv.filter((i) => i.status === "warn").length} warn, ${inv.filter((i) => i.status === "skipped").length} skipped`);
  L.push(`- Findings: ${rep.findings.length} (${SEV_ORDER.map((s) => `${rep.findings.filter((f) => f.severity === s).length} ${s}`).join(", ")})`);
  L.push("");
  if (rep.rampSteps) {
    L.push("## Saturation");
    L.push("");
    L.push("| step | offered/s | completed/s | error rate | task p95 ms |");
    L.push("|---:|---:|---:|---:|---:|");
    for (const s of rep.rampSteps as Array<{ step: number; offeredPerSec: number; completedPerSec: number; errorRate: number; p95Ms: number }>) {
      L.push(`| ${s.step} | ${fmt(s.offeredPerSec, 2)} | ${fmt(s.completedPerSec, 2)} | ${fmt(s.errorRate * 100, 1)}% | ${fmt(s.p95Ms)} |`);
    }
    L.push("");
    L.push("```json");
    L.push(JSON.stringify(rep.saturation, null, 2));
    L.push("```");
    L.push("");
  }
  L.push("## Latency by endpoint (ms)");
  L.push("");
  L.push("| endpoint | count | p50 | p95 | p99 | max | error rate | outcomes |");
  L.push("|---|---:|---:|---:|---:|---:|---:|---|");
  for (const e of rep.endpoints) {
    L.push(`| ${e.endpoint} | ${e.count} | ${fmt(e.p50, 1)} | ${fmt(e.p95, 1)} | ${fmt(e.p99, 1)} | ${fmt(e.max)} | ${fmt(e.errorRate * 100, 2)}% | ${Object.entries(e.outcomes).map(([k, v]) => `${k}×${v}`).join(", ")} |`);
  }
  L.push("");
  for (const [region, eps] of Object.entries(rep.endpointsByRegion)) {
    L.push(`### Region ${region}`);
    L.push("");
    L.push("| endpoint | count | p50 | p95 | p99 | error rate |");
    L.push("|---|---:|---:|---:|---:|---:|");
    for (const e of eps.slice(0, 25)) L.push(`| ${e.endpoint} | ${e.count} | ${fmt(e.p50, 1)} | ${fmt(e.p95, 1)} | ${fmt(e.p99, 1)} | ${fmt(e.errorRate * 100, 2)}% |`);
    L.push("");
  }
  if (rep.errorsByOutcome.length) {
    L.push("## Errors by status / code");
    L.push("");
    L.push("| endpoint | outcome | count |");
    L.push("|---|---|---:|");
    for (const e of rep.errorsByOutcome) L.push(`| ${e.endpoint} | ${e.outcome} | ${e.count} |`);
    L.push("");
  }
  L.push("## Phases");
  L.push("");
  for (const p of rep.phases) L.push(`- ${p.name}: ${fmt(((p.endMs ?? p.startMs) - p.startMs) / 1000, 1)} s${p.meta ? ` ${JSON.stringify(p.meta)}` : ""}`);
  L.push("");
  L.push("## Scenario numbers");
  L.push("");
  L.push("```json");
  L.push(JSON.stringify(rep.extra, null, 2));
  L.push("```");
  L.push("");
  L.push("## Invariants");
  L.push("");
  L.push("| status | severity | invariant | detail |");
  L.push("|---|---|---|---|");
  for (const i of inv) L.push(`| ${i.status.toUpperCase()} | ${i.severity} | ${i.title}${i.region ? ` (${i.region})` : ""} | ${i.detail.replace(/\|/g, "\\|")} |`);
  L.push("");
  L.push("## Findings");
  L.push("");
  if (!rep.findings.length) L.push("None.");
  for (const f of rep.findings) {
    L.push(`### [${f.severity}] ${f.title}`);
    L.push("");
    L.push(`Source: ${f.source}`);
    L.push("");
    L.push(f.detail);
    if (f.reproduction) {
      L.push("");
      L.push(`Reproduction: \`${f.reproduction}\``);
    }
    if (f.evidence !== undefined) {
      L.push("");
      L.push("```json");
      L.push(JSON.stringify(f.evidence, null, 2).slice(0, 4_000));
      L.push("```");
    }
    L.push("");
  }
  if (rep.notes.length) {
    L.push("## Notes");
    L.push("");
    for (const n of rep.notes) L.push(`- ${n}`);
    L.push("");
  }
  return L.join("\n");
}
