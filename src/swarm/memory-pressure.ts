// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * System memory pressure, so the agent stops taking network work before the host runs out of
 * memory (src/swarm/worker-runner.ts's memory guard):
 *
 *  - macOS: `sysctl kern.memorystatus_vm_pressure_level` (1 normal, 2 warning, 4 critical: the
 *    kernel's own verdict, what Activity Monitor's pressure graph shows) and `vm_stat` (free +
 *    inactive + speculative + purgeable pages available; pages held by the compressor).
 *  - Linux: /proc/meminfo MemAvailable and the PSI file /proc/pressure/memory (share of time tasks
 *    stalled waiting for memory, over the last 10 s).
 *  - elsewhere: free memory from the OS.
 *
 * Thresholds:
 *   macOS   critical: kernel level 4, or under 3% available;  warning: level 2, under 8% available,
 *           or the compressor holding 40% of RAM or more
 *   Linux   critical: MemAvailable under 5%, or PSI full avg10 >= 10;  warning: under 10%, or PSI
 *           some avg10 >= 25
 *   other   critical: under 5% free;  warning: under 10% free
 *
 * PressureGuard adds hysteresis: worse readings take effect at once, better ones only after they
 * have held for `recoverMs` (default 30 s), so a host does not flap in and out of network work.
 */

import type { PressureLevel } from "./memory-budget.js";

export type { PressureLevel };

export interface VmStat {
  pageSize: number;
  free: number;
  active: number;
  inactive: number;
  speculative: number;
  wired: number;
  purgeable: number;
  compressor: number;
}

/** Parses `vm_stat` output (pages; "Mach Virtual Memory Statistics: (page size of 16384 bytes)"). */
export function parseVmStat(text: string): VmStat | undefined {
  const size = /page size of (\d+) bytes/.exec(text);
  if (!size) return undefined;
  const get = (label: string): number => {
    const m = new RegExp(`^${label}:\\s+(\\d+)\\.?`, "m").exec(text);
    return m ? Number(m[1]) : 0;
  };
  return {
    pageSize: Number(size[1]),
    free: get("Pages free"),
    active: get("Pages active"),
    inactive: get("Pages inactive"),
    speculative: get("Pages speculative"),
    wired: get("Pages wired down"),
    purgeable: get("Pages purgeable"),
    compressor: get("Pages occupied by compressor"),
  };
}

export interface MemInfo {
  totalBytes: number;
  availableBytes: number;
}

/** Parses /proc/meminfo (kB). */
export function parseMeminfo(text: string): MemInfo | undefined {
  const kb = (key: string): number | undefined => {
    const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : undefined;
  };
  const total = kb("MemTotal");
  if (!total) return undefined;
  const available = kb("MemAvailable") ?? (kb("MemFree") ?? 0) + (kb("Cached") ?? 0);
  return { totalBytes: total, availableBytes: available };
}

export interface Psi {
  someAvg10: number;
  fullAvg10?: number;
}

/** Parses /proc/pressure/memory ("some avg10=0.00 avg60=… total=…", "full avg10=…"). */
export function parsePsi(text: string): Psi | undefined {
  const some = /^some\s+avg10=([\d.]+)/m.exec(text);
  if (!some) return undefined;
  const full = /^full\s+avg10=([\d.]+)/m.exec(text);
  return { someAvg10: Number(some[1]), ...(full ? { fullAvg10: Number(full[1]) } : {}) };
}

export function classifyMac(input: { kernelLevel?: number; availablePct?: number; compressorPct?: number }): PressureLevel {
  const { kernelLevel, availablePct, compressorPct } = input;
  if ((kernelLevel !== undefined && kernelLevel >= 4) || (availablePct !== undefined && availablePct < 3)) return "critical";
  if ((kernelLevel !== undefined && kernelLevel >= 2) || (availablePct !== undefined && availablePct < 8) || (compressorPct !== undefined && compressorPct >= 40)) return "warning";
  return "normal";
}

export function classifyLinux(input: { availablePct?: number; psi?: Psi }): PressureLevel {
  const { availablePct, psi } = input;
  if ((availablePct !== undefined && availablePct < 5) || (psi?.fullAvg10 !== undefined && psi.fullAvg10 >= 10)) return "critical";
  if ((availablePct !== undefined && availablePct < 10) || (psi !== undefined && psi.someAvg10 >= 25)) return "warning";
  return "normal";
}

export function classifyOther(availablePct: number): PressureLevel {
  return availablePct < 5 ? "critical" : availablePct < 10 ? "warning" : "normal";
}

export interface MemorySnapshot {
  level: PressureLevel;
  totalBytes: number;
  availableBytes?: number;
  /** What the level came from, for logs ("kernel level 2, 6.1% available"). */
  detail: string;
}

export interface PressureDeps {
  platform: NodeJS.Platform;
  totalBytes: number;
  freeBytes: () => number;
  /** Runs a command, stdout or null (never throws). */
  exec: (cmd: string, args: string[]) => string | null;
  /** Reads a file, or null (never throws). */
  readFile: (path: string) => string | null;
}

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 100);

export function readMemoryPressure(d: PressureDeps): MemorySnapshot {
  if (d.platform === "darwin") {
    const lvlRaw = d.exec("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]);
    const kernelLevel = lvlRaw !== null && /^\s*\d+\s*$/.test(lvlRaw) ? Number(lvlRaw.trim()) : undefined;
    const vmText = d.exec("/usr/bin/vm_stat", []);
    const vm = vmText ? parseVmStat(vmText) : undefined;
    const available = vm ? (vm.free + vm.inactive + vm.speculative + vm.purgeable) * vm.pageSize : undefined;
    const availablePct = available !== undefined ? pct(available, d.totalBytes) : undefined;
    const compressorPct = vm ? pct(vm.compressor * vm.pageSize, d.totalBytes) : undefined;
    const level = classifyMac({ kernelLevel, availablePct, compressorPct });
    const parts = [kernelLevel !== undefined ? `kernel level ${kernelLevel}` : "", availablePct !== undefined ? `${availablePct.toFixed(1)}% available` : "", compressorPct !== undefined ? `compressor ${compressorPct.toFixed(1)}%` : ""].filter(Boolean);
    return { level, totalBytes: d.totalBytes, ...(available !== undefined ? { availableBytes: available } : {}), detail: parts.join(", ") || "no reading" };
  }
  if (d.platform === "linux") {
    const mi = (() => {
      const t = d.readFile("/proc/meminfo");
      return t ? parseMeminfo(t) : undefined;
    })();
    const psiText = d.readFile("/proc/pressure/memory");
    const psi = psiText ? parsePsi(psiText) : undefined;
    const total = mi?.totalBytes ?? d.totalBytes;
    const available = mi?.availableBytes ?? d.freeBytes();
    const availablePct = pct(available, total);
    const level = classifyLinux({ availablePct, psi });
    return { level, totalBytes: total, availableBytes: available, detail: `${availablePct.toFixed(1)}% available${psi ? `, PSI some ${psi.someAvg10}${psi.fullAvg10 !== undefined ? ` full ${psi.fullAvg10}` : ""}` : ""}` };
  }
  const free = d.freeBytes();
  const availablePct = pct(free, d.totalBytes);
  return { level: classifyOther(availablePct), totalBytes: d.totalBytes, availableBytes: free, detail: `${availablePct.toFixed(1)}% free` };
}

const RANK: Record<PressureLevel, number> = { normal: 0, warning: 1, critical: 2 };

/** Pressure with hysteresis: worse at once, better only after `recoverMs` of better readings. */
export class PressureGuard {
  private level: PressureLevel = "normal";
  private betterSinceMs: number | undefined;
  private betterLevel: PressureLevel = "normal";

  constructor(private readonly recoverMs = 30_000) {}

  current(): PressureLevel {
    return this.level;
  }

  /** Feed a reading; returns the effective level and whether it changed. */
  update(reading: PressureLevel, nowMs: number): { level: PressureLevel; changed: boolean; from: PressureLevel } {
    const from = this.level;
    if (RANK[reading] >= RANK[this.level]) {
      this.betterSinceMs = undefined;
      this.level = reading;
    } else {
      // Recovering: the level to go to is the worst reading since recovery started.
      if (this.betterSinceMs === undefined) {
        this.betterSinceMs = nowMs;
        this.betterLevel = reading;
      } else if (RANK[reading] > RANK[this.betterLevel]) this.betterLevel = reading;
      if (nowMs - this.betterSinceMs >= this.recoverMs) {
        this.level = this.betterLevel;
        this.betterSinceMs = undefined;
      }
    }
    return { level: this.level, changed: from !== this.level, from };
  }
}
