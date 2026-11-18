#!/usr/bin/env node
// npm audit gate for CI (dependency-audit job). Fails on any high or critical advisory, except
// one listed in audit-exceptions.json at the repo root whose expiry has not passed.
// An expired exception fails the job, so an accepted advisory is looked at again at least monthly.
// Run from the directory whose package-lock.json to check.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_DAYS = 30;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const today = new Date().toISOString().slice(0, 10);

/** Accepted advisory ids: valid entries whose expiry is today or later. Exits on a bad entry. */
export function acceptedIds(file, now = today) {
  const ok = new Set();
  const problems = [];
  for (const e of file.exceptions ?? []) {
    if (!/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(e.id ?? "") || !e.reason || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? "")) {
      problems.push(`bad exception entry: ${JSON.stringify(e)}`);
      continue;
    }
    const days = (Date.parse(e.expires) - Date.parse(now)) / 86_400_000;
    if (days > MAX_DAYS) problems.push(`${e.id}: expiry ${e.expires} is more than ${MAX_DAYS} days out`);
    else if (e.expires < now) problems.push(`${e.id}: exception expired on ${e.expires}; fix, or renew it with a reason`);
    else ok.add(e.id);
  }
  return { ok, problems };
}

/** High/critical advisories in `npm audit --json` output, as id -> "package: title". */
export function blockingAdvisories(report) {
  const found = new Map();
  for (const v of Object.values(report.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== "object" || !["high", "critical"].includes(via.severity)) continue;
      const id = String(via.url ?? "").split("/").pop() || `${via.name}@${via.range}`;
      found.set(id, `${via.severity} ${via.name}: ${via.title}`);
    }
  }
  return found;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let out;
  try {
    out = execFileSync("npm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 64 << 20 });
  } catch (err) {
    out = err.stdout; // npm audit exits 1 when it finds anything
  }
  const report = JSON.parse(out || "{}");
  if (report.error) {
    console.error(`npm audit failed: ${JSON.stringify(report.error)}`);
    process.exit(1);
  }
  const { ok, problems } = acceptedIds(JSON.parse(readFileSync(join(root, "audit-exceptions.json"), "utf8")));
  let failed = problems.length > 0;
  for (const p of problems) console.error(p);
  for (const [id, what] of blockingAdvisories(report)) {
    if (ok.has(id)) console.log(`accepted until expiry: ${id} (${what})`);
    else {
      console.error(`blocking: ${id} (${what})`);
      failed = true;
    }
  }
  console.log(failed ? "dependency audit: FAILED" : "dependency audit: ok");
  process.exit(failed ? 1 : 0);
}
