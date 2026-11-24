#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Network capacity per model, from the coordinators' GET /admin/network (admin token): slots and
 * free slots per model (summed over coordinators) and the compute classes that hold each model.
 * The public API (/v1/models) lists models but not slots, and /inference/models needs the mesh
 * token, so this is the one source a load generator can use.
 *
 * The coordinators refuse admin routes on public ingress (403 admin_internal_only), so from the
 * operator's machine the query runs inside each coordinator's Fly app instead: `fly ssh console`
 * runs a small node script (sent on stdin) that reads ADMIN_API_TOKEN and ADMIN_LISTEN_PORT from the
 * machine's own env and asks http://127.0.0.1:<port>/admin/network. The token never leaves the
 * machine and is never printed. Needs a working `fly` login (see flyEnv). A coordinator whose
 * snapshot cannot be read is an error with the reason, not a silent gap.
 *
 *   node scripts/loadgen/capacity.mjs            print the snapshot as JSON (fly.sh passes it to the
 *                                                machines as LOADGEN_CAPACITY; no token leaves this host)
 *   node scripts/loadgen/capacity.mjs --sample out.jsonl --until <epoch ms>
 *                                                sample every 15 s during a run, for report.mjs
 *                                                (per-model and per-class utilization)
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostsFromSnapshots } from "./memory.mjs";

export const DEFAULT_COORDINATORS = ["https://coordinator.edgecoder.io", "https://coordinator-eu.edgecoder.io"];

export function adminToken() {
  if (process.env.EDGECODER_ADMIN_TOKEN) return process.env.EDGECODER_ADMIN_TOKEN;
  if (process.env.LOADGEN_ADMIN_TOKEN) return process.env.LOADGEN_ADMIN_TOKEN;
  const f = join(homedir(), ".config/edgecoder/coordinator-admin-token");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}

/** The Fly app behind each public coordinator URL, for the in-machine fallback. */
export const SEED_APPS = { "https://coordinator.edgecoder.io": "edgecoder-seed", "https://coordinator-eu.edgecoder.io": "edgecoder-seed-eu" };

/**
 * Env for `fly`: FLY_API_TOKEN when set, else the `fly auth login` session as is. The token file
 * (~/.config/edgecoder/fly.token) is used only when there is no working session, since a revoked
 * token there would override a good login ("verify: root banned").
 */
export function flyEnv(run = execFileSync) {
  const e = { ...process.env };
  if (e.FLY_API_TOKEN) return e;
  try { run("fly", ["auth", "whoami"], { env: e, stdio: "ignore", timeout: 30_000 }); return e; } catch {}
  const f = join(homedir(), ".config/edgecoder/fly.token");
  if (existsSync(f)) e.FLY_API_TOKEN = readFileSync(f, "utf8").trim();
  return e;
}

/** Runs inside a coordinator machine: prints one SNAPSHOT line (models + agents) or ERROR line. Never prints the token. */
export const IN_MACHINE_SCRIPT = `
const t = process.env.ADMIN_API_TOKEN || "";
const port = process.env.ADMIN_LISTEN_PORT || process.env.PORT || "4301";
if (!t) { console.log("EDGECODER_ERROR no ADMIN_API_TOKEN in the machine env"); process.exit(0); }
fetch("http://127.0.0.1:" + port + "/admin/network?range=1h", { headers: { "x-admin-token": t }, signal: AbortSignal.timeout(20000) })
  .then(async (r) => { const j = await r.json().catch(() => ({})); if (r.status !== 200) { console.log("EDGECODER_ERROR http_" + r.status + " " + (j.error || "")); return; }
    console.log("EDGECODER_SNAPSHOT " + JSON.stringify({ models: j.models || [], agents: j.agents || [] })); })
  .catch((e) => console.log("EDGECODER_ERROR " + String(e && e.message || e).slice(0, 200)));
`;

/** Parse the in-machine script's output: { models, agents } or throws with the reason. */
export function parseInMachineOutput(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith("EDGECODER_SNAPSHOT ")) return JSON.parse(line.slice("EDGECODER_SNAPSHOT ".length));
    if (line.startsWith("EDGECODER_ERROR ")) throw new Error(line.slice("EDGECODER_ERROR ".length).trim());
  }
  throw new Error("no snapshot in the fly ssh output");
}

/** GET /admin/network from inside the coordinator's Fly app (fly ssh console, script on stdin). */
export function fetchViaFly(app, run = execFileSync) {
  const outp = run("fly", ["ssh", "console", "-a", app, "-q", "-C", "node -"], { env: flyEnv(run), input: IN_MACHINE_SCRIPT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 90_000 });
  return parseInMachineOutput(outp);
}

export const HOW_TO_FIX = "the coordinators serve /admin/network only on internal ingress: log in to Fly (`fly auth login`, or FLY_API_TOKEN) with access to edgecoder-seed / edgecoder-seed-eu so the query can run inside a seed machine";

/**
 * The models and agents parts of every coordinator's snapshot. Tries the public URL when a token is
 * given, then (viaFly, the default on the operator's machine) the coordinator's Fly app. Throws
 * when a coordinator cannot be read, naming the reason and the fix.
 */
export async function fetchSnapshots(token, coordinators = DEFAULT_COORDINATORS, { viaFly = true, run = execFileSync } = {}) {
  return Promise.all(coordinators.map(async (c) => {
    let reason = "no admin token on this host";
    if (token) {
      try {
        const r = await fetch(`${c}/admin/network?range=1h`, { headers: { "x-admin-token": token, "user-agent": "edgecoder-loadgen/1.0 (capacity)" }, signal: AbortSignal.timeout(20_000) });
        const j = await r.json().catch(() => ({}));
        if (r.status === 200) return { coordinator: c, models: j.models ?? [], agents: j.agents ?? [] };
        reason = `http_${r.status} ${j.error ?? ""}`.trim();
      } catch (e) { reason = String(e?.message ?? e); }
    }
    const app = SEED_APPS[c];
    if (!viaFly || !app) throw new Error(`${c}/admin/network: ${reason}; ${HOW_TO_FIX}`);
    try {
      const j = fetchViaFly(app, run);
      return { coordinator: c, models: j.models ?? [], agents: j.agents ?? [] };
    } catch (e) {
      throw new Error(`${c}/admin/network: ${reason}; inside ${app} over fly ssh: ${String(e?.message ?? e).split("\n")[0].slice(0, 200)}; ${HOW_TO_FIX}`);
    }
  }));
}

/**
 * { atMs, models: { "<model>": { slots, freeSlots, agents, classes: [..] } }, classes: { "<class>": { slots, freeSlots, agents } },
 *   hosts: { "<agentId>": { pressure, usedBytes, budgetBytes, totalBytes, loaded, incidents } } }
 * Only connected, non-blacklisted agents count.
 */
export function capacityFrom(snapshots, atMs = Date.now()) {
  const models = {}, classes = {};
  for (const s of snapshots) {
    if (!s) continue;
    for (const m of s.models) {
      const e = (models[m.model] ??= { slots: 0, freeSlots: 0, agents: 0, classes: [] });
      e.slots += m.slots ?? 0;
      e.freeSlots += m.freeSlots ?? 0;
      e.agents += m.agents ?? 0;
    }
    for (const a of s.agents) {
      if (a.connected === false || a.blacklisted) continue;
      const cls = a.computeClass ?? "cpu";
      const c = (classes[cls] ??= { slots: 0, freeSlots: 0, agents: 0 });
      c.slots += a.slots ?? 0;
      c.freeSlots += a.freeSlots ?? 0;
      c.agents++;
      for (const m of a.modelsInstalled ?? []) {
        const e = (models[m] ??= { slots: 0, freeSlots: 0, agents: 0, classes: [] });
        if (!e.classes.includes(cls)) e.classes.push(cls);
      }
    }
  }
  // Each host's memory (pressure, loaded-model bytes, budget) for report.mjs's host-memory check.
  return { atMs, models, classes, hosts: hostsFromSnapshots(snapshots) };
}

export async function fetchCapacity(token = adminToken(), coordinators = DEFAULT_COORDINATORS, opts = {}) {
  return capacityFrom(await fetchSnapshots(token, coordinators, opts));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
  const token = adminToken(); // optional: without one the query runs inside the seed machines
  const out = flag("sample");
  if (!out) {
    try { console.log(JSON.stringify(await fetchCapacity(token))); }
    catch (e) { console.error(`capacity: ${e.message}`); process.exit(1); }
  } else {
    const until = Number(flag("until") ?? Date.now() + 3600_000);
    while (Date.now() < until) {
      try { appendFileSync(out, JSON.stringify({ type: "capacity", ...(await fetchCapacity(token)) }) + "\n"); }
      catch (e) { console.error(`capacity sample skipped: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}
