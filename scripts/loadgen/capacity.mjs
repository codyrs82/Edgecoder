#!/usr/bin/env node
// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Network capacity per model, from the coordinators' GET /admin/network (admin token): slots and
 * free slots per model (summed over coordinators) and the compute classes that hold each model.
 * The public API (/v1/models) lists models but not slots, and /inference/models needs the mesh
 * token, so this is the one source a load generator can use.
 *
 *   node scripts/loadgen/capacity.mjs            print the snapshot as JSON (fly.sh passes it to the
 *                                                machines as LOADGEN_CAPACITY; no token leaves this host)
 *   node scripts/loadgen/capacity.mjs --sample out.jsonl --until <epoch ms>
 *                                                sample every 15 s during a run, for report.mjs
 *                                                (per-model and per-class utilization)
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_COORDINATORS = ["https://coordinator.edgecoder.io", "https://coordinator-eu.edgecoder.io"];

export function adminToken() {
  if (process.env.EDGECODER_ADMIN_TOKEN) return process.env.EDGECODER_ADMIN_TOKEN;
  if (process.env.LOADGEN_ADMIN_TOKEN) return process.env.LOADGEN_ADMIN_TOKEN;
  const f = join(homedir(), ".config/edgecoder/coordinator-admin-token");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}

/** The models and agents parts of every coordinator's snapshot (null for one that failed). */
export async function fetchSnapshots(token, coordinators = DEFAULT_COORDINATORS) {
  return Promise.all(coordinators.map(async (c) => {
    try {
      const r = await fetch(`${c}/admin/network?range=1h`, { headers: { "x-admin-token": token, "user-agent": "edgecoder-loadgen/1.0 (capacity)" }, signal: AbortSignal.timeout(20_000) });
      if (r.status !== 200) return null;
      const j = await r.json();
      return { coordinator: c, models: j.models ?? [], agents: j.agents ?? [] };
    } catch { return null; }
  }));
}

/**
 * { atMs, models: { "<model>": { slots, freeSlots, agents, classes: [..] } }, classes: { "<class>": { slots, freeSlots, agents } } }
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
  return { atMs, models, classes };
}

export async function fetchCapacity(token = adminToken(), coordinators = DEFAULT_COORDINATORS) {
  const snaps = await fetchSnapshots(token, coordinators);
  if (!snaps.some(Boolean)) return null;
  return capacityFrom(snaps);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
  const token = adminToken();
  if (!token) { console.error("no admin token (~/.config/edgecoder/coordinator-admin-token)"); process.exit(2); }
  const out = flag("sample");
  if (!out) {
    const cap = await fetchCapacity(token);
    if (!cap) { console.error("no coordinator answered"); process.exit(1); }
    console.log(JSON.stringify(cap));
  } else {
    const until = Number(flag("until") ?? Date.now() + 3600_000);
    while (Date.now() < until) {
      const cap = await fetchCapacity(token);
      if (cap) appendFileSync(out, JSON.stringify({ type: "capacity", ...cap }) + "\n");
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}
