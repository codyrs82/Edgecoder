// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Host memory safety over a load run, from the coordinators' view of agent heartbeats
 * (GET /admin/network agents[].memory; src/swarm/coordinator/memory-admission.ts):
 *
 *  - hostsFromSnapshots: each agent's memory now (pressure, loaded-model bytes, budget). capacity.mjs
 *    records it with every 15 s sample, so a run has a per-host series.
 *  - hostMemoryReport: per host over [from, to]: peak pressure and peak loaded-model bytes against
 *    its budget, from the samples, plus the incidents the coordinator logged (critical pressure, or
 *    loaded models past the budget) between samples.
 *  - A run FAILS when any host hit critical pressure or exceeded its budget in the window: the
 *    network's load must never take a host down (2026-11-16: a 48 GB Mac crashed in round 3).
 */

const RANK = { normal: 0, warning: 1, critical: 2 };
const GB = 1024 ** 3;

/** { "<agentId>": { pressure, usedBytes, budgetBytes, totalBytes, loaded: [..], incidents: [..] } } from /admin/network snapshots. */
export function hostsFromSnapshots(snapshots) {
  const hosts = {};
  for (const s of snapshots ?? []) {
    if (!s) continue;
    for (const a of s.agents ?? []) {
      const m = a.memory;
      if (!m) continue;
      hosts[a.agentId] = {
        pressure: m.pressure,
        usedBytes: m.usedBytes ?? 0,
        budgetBytes: m.budgetBytes ?? 0,
        totalBytes: m.totalBytes ?? 0,
        loaded: (m.loadedModels ?? []).map((x) => x.name),
        incidents: m.incidents ?? [],
      };
    }
  }
  return hosts;
}

/**
 * Per-host memory over [from, to]. `samples`: capacity samples ({ atMs, hosts }); `finalHosts`: hosts
 * from a snapshot taken after the run (its incidents cover spikes between samples).
 * Returns { ok, hosts: { id: { peakPressure, peakUsedBytes, budgetBytes, overBudget, critical, samples } }, flags: [..] }.
 */
export function hostMemoryReport(samples, finalHosts, from, to) {
  const hosts = {};
  const entry = (id) => (hosts[id] ??= { peakPressure: "normal", peakUsedBytes: 0, budgetBytes: 0, totalBytes: 0, overBudget: false, critical: false, samples: 0, peakLoaded: [] });
  for (const p of samples ?? []) {
    if (!(p.atMs >= from && p.atMs <= to) || !p.hosts) continue;
    for (const [id, h] of Object.entries(p.hosts)) {
      const e = entry(id);
      e.samples++;
      if (RANK[h.pressure] > RANK[e.peakPressure]) e.peakPressure = h.pressure;
      if ((h.usedBytes ?? 0) > e.peakUsedBytes) { e.peakUsedBytes = h.usedBytes; e.peakLoaded = h.loaded ?? []; }
      e.budgetBytes = Math.max(e.budgetBytes, h.budgetBytes ?? 0);
      e.totalBytes = Math.max(e.totalBytes, h.totalBytes ?? 0);
      if (h.pressure === "critical") e.critical = true;
      if (h.budgetBytes > 0 && h.usedBytes > h.budgetBytes) e.overBudget = true;
    }
  }
  for (const [id, h] of Object.entries(finalHosts ?? {})) {
    const e = entry(id);
    e.budgetBytes = Math.max(e.budgetBytes, h.budgetBytes ?? 0);
    e.totalBytes = Math.max(e.totalBytes, h.totalBytes ?? 0);
    for (const i of h.incidents ?? []) {
      if (!(i.atMs >= from && i.atMs <= to)) continue;
      if (i.kind === "critical") { e.critical = true; e.peakPressure = "critical"; }
      if (i.kind === "over_budget") { e.overBudget = true; e.peakUsedBytes = Math.max(e.peakUsedBytes, i.usedBytes ?? 0); }
    }
  }
  const flags = [];
  for (const [id, e] of Object.entries(hosts)) {
    if (e.critical) flags.push(`FLAG host-memory: ${id} hit CRITICAL memory pressure during the run`);
    if (e.overBudget) flags.push(`FLAG host-memory: ${id} loaded ${gb(e.peakUsedBytes)} of models, over its ${gb(e.budgetBytes)} budget`);
  }
  return { ok: flags.length === 0, hosts, flags };
}

export function gb(bytes) {
  return `${(Number(bytes || 0) / GB).toFixed(1)} GB`;
}

/** One line per host for the printed report. */
export function formatHostMemory(r) {
  const ids = Object.keys(r.hosts);
  if (!ids.length) return "  no host reported memory (agents before the memory-budget release, or no samples)";
  return ids
    .sort()
    .map((id) => {
      const e = r.hosts[id];
      const mark = e.critical || e.overBudget ? "  <-- FLAG" : "";
      return `  ${id}: peak pressure ${e.peakPressure}, peak loaded ${gb(e.peakUsedBytes)} of ${gb(e.budgetBytes)} budget${e.totalBytes ? ` (${gb(e.totalBytes)} RAM)` : ""}${e.peakLoaded.length ? ` [${e.peakLoaded.join(", ")}]` : ""}, ${e.samples} samples${mark}`;
    })
    .join("\n");
}
