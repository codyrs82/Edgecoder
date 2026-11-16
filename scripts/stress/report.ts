// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Merge the results of one or more load generators (results.json each, e.g. one per Fly region)
 * into one report: latency per endpoint overall and per region, errors, invariants, findings.
 *
 *   npx tsx scripts/stress/report.ts --out .stress-runs/merged-ramp results-fra.json results-iad.json ...
 *   node edgecoder-stress-report.mjs --out merged results/*.json
 *
 * Inputs may also be directories containing results.json.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildReport, renderMarkdown, type RunResult } from "./lib/report-lib.js";

function main(): number {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const inputs = args.filter((a, i) => !a.startsWith("--") && !(outIdx >= 0 && i === outIdx + 1));
  if (!out || inputs.length === 0) {
    console.error("usage: report.ts --out <dir> <results.json|dir> [...]");
    return 2;
  }
  const results: RunResult[] = [];
  for (const p of inputs) {
    const file = existsSync(p) && statSync(p).isDirectory() ? join(p, "results.json") : p;
    // A file may hold one result or JSON lines (the wrapper's stdout capture).
    const text = readFileSync(file, "utf8").trim();
    for (const line of text.startsWith("{\"schema\"") && text.includes("\n{\"schema\"") ? text.split("\n") : [text]) {
      const r = JSON.parse(line) as RunResult;
      if (r.schema !== "edgecoder-stress-run/1") throw new Error(`${file}: not a stress run result`);
      results.push(r);
    }
  }
  const report = buildReport(results);
  const dir = resolve(out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(dir, "report.md"), renderMarkdown(report));
  console.error(`merged ${results.length} run(s) from ${[...new Set(results.map((r) => r.region))].join(", ")} -> ${join(dir, "report.md")}`);
  return 0;
}

process.exit(main());
