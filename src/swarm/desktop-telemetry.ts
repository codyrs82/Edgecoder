// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { platform, totalmem, freemem, cpus } from "node:os";
import type { AgentPowerTelemetry } from "./power-policy.js";

const COMMAND_TIMEOUT_MS = 2000;

// ── Public API ─────────────────────────────────────────────────────

export async function collectDesktopTelemetry(): Promise<AgentPowerTelemetry> {
  const deviceType = await detectDeviceType();
  const base: AgentPowerTelemetry = {
    deviceType,
    cpuUsagePct: getCpuUsage(),
    memoryUsagePct: getMemoryUsage(),
    updatedAtMs: Date.now()
  };

  try {
    const plat = platform();
    if (plat === "darwin") {
      const power = await collectMacOSPower();
      return { ...base, ...power };
    }
    if (plat === "linux") {
      const power = await collectLinuxPower();
      return { ...base, ...power };
    }
    if (plat === "win32") {
      const power = await collectWindowsPower();
      return { ...base, ...power };
    }
  } catch {
    // Fallback: assume AC power desktop
  }

  return { ...base, onACPower: true };
}

export async function detectDeviceType(): Promise<AgentPowerTelemetry["deviceType"]> {
  const plat = platform();

  // Servers typically have no battery — check platform-specific indicators
  if (plat === "linux") {
    try {
      await readFile("/sys/class/power_supply/BAT0/status", "utf-8");
      return "laptop";
    } catch {
      // No battery file — could be desktop or server
      try {
        const virt = await execCommand("systemd-detect-virt", [], COMMAND_TIMEOUT_MS);
        if (virt.trim() !== "none" && virt.trim() !== "") return "server";
      } catch {
        // Not a VM, and no battery — desktop
      }
      return "desktop";
    }
  }

  if (plat === "darwin") {
    try {
      const output = await execCommand("pmset", ["-g", "batt"], COMMAND_TIMEOUT_MS);
      if (output.includes("InternalBattery") || output.includes("Battery")) {
        return "laptop";
      }
      return "desktop";
    } catch {
      return "desktop";
    }
  }

  if (plat === "win32") {
    try {
      const output = await execCommand(
        "powershell",
        ["-NoProfile", "-Command", "(Get-WmiObject Win32_Battery).EstimatedChargeRemaining"],
        COMMAND_TIMEOUT_MS
      );
      if (output.trim() !== "" && output.trim() !== "0") return "laptop";
      return "desktop";
    } catch {
      return "desktop";
    }
  }

  return "desktop";
}

export function getCpuUsage(): number {
  const cpuList = cpus();
  if (cpuList.length === 0) return 0;
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpuList) {
    const { user, nice, sys, idle, irq } = cpu.times;
    totalTick += user + nice + sys + idle + irq;
    totalIdle += idle;
  }
  const usage = totalTick > 0 ? ((totalTick - totalIdle) / totalTick) * 100 : 0;
  return Math.round(Math.max(0, Math.min(100, usage)));
}

export function getMemoryUsage(): number {
  const total = totalmem();
  const free = freemem();
  if (total === 0) return 0;
  const usage = ((total - free) / total) * 100;
  return Math.round(Math.max(0, Math.min(100, usage)));
}

// ── macOS ──────────────────────────────────────────────────────────

async function collectMacOSPower(): Promise<Partial<AgentPowerTelemetry>> {
  const result: Partial<AgentPowerTelemetry> = {};

  try {
    const output = await execCommand("pmset", ["-g", "batt"], COMMAND_TIMEOUT_MS);
    // Example output:
    //  Now drawing from 'AC Power'
    //  -InternalBattery-0 (id=...)  85%; charging; 1:23 remaining
    const acMatch = /drawing from '([^']+)'/.exec(output);
    if (acMatch) {
      result.onACPower = acMatch[1].toLowerCase().includes("ac");
    }
    const battMatch = /(\d+)%/.exec(output);
    if (battMatch) {
      result.batteryPct = Math.max(0, Math.min(100, Number(battMatch[1])));
    }
  } catch {
    // pmset unavailable
  }

  try {
    const output = await execCommand(
      "sysctl",
      ["-n", "machdep.xcpm.cpu_thermal_level"],
      COMMAND_TIMEOUT_MS
    );
    const level = parseInt(output.trim(), 10);
    if (Number.isFinite(level)) {
      if (level <= 30) result.thermalState = "nominal";
      else if (level <= 60) result.thermalState = "fair";
      else if (level <= 85) result.thermalState = "serious";
      else result.thermalState = "critical";
    }
  } catch {
    // Thermal info not available — fallback: try IOKit approach
    try {
      const output = await execCommand(
        "sysctl",
        ["-n", "kern.sched_thermr_throttling_level"],
        COMMAND_TIMEOUT_MS
      );
      const level = parseInt(output.trim(), 10);
      if (Number.isFinite(level) && level > 0) {
        result.thermalState = level >= 80 ? "critical" : level >= 50 ? "serious" : "fair";
      }
    } catch {
      // No thermal data available
    }
  }

  return result;
}

// ── Linux ──────────────────────────────────────────────────────────

async function collectLinuxPower(): Promise<Partial<AgentPowerTelemetry>> {
  const result: Partial<AgentPowerTelemetry> = {};

  // Try common battery paths
  const battPaths = [
    "/sys/class/power_supply/BAT0",
    "/sys/class/power_supply/BAT1",
    "/sys/class/power_supply/battery"
  ];

  for (const battPath of battPaths) {
    try {
      const capacityStr = await readFile(`${battPath}/capacity`, "utf-8");
      const capacity = parseInt(capacityStr.trim(), 10);
      if (Number.isFinite(capacity)) {
        result.batteryPct = Math.max(0, Math.min(100, capacity));
      }

      const statusStr = await readFile(`${battPath}/status`, "utf-8");
      const status = statusStr.trim().toLowerCase();
      result.onACPower = status === "charging" || status === "full" || status === "not charging";
      break;
    } catch {
      continue;
    }
  }

  // If no battery path was found, assume AC power
  if (result.onACPower === undefined && result.batteryPct === undefined) {
    result.onACPower = true;
  }

  // Thermal zone
  try {
    const tempStr = await readFile("/sys/class/thermal/thermal_zone0/temp", "utf-8");
    const tempMilliC = parseInt(tempStr.trim(), 10);
    if (Number.isFinite(tempMilliC)) {
      const tempC = tempMilliC / 1000;
      if (tempC <= 60) result.thermalState = "nominal";
      else if (tempC <= 75) result.thermalState = "fair";
      else if (tempC <= 90) result.thermalState = "serious";
      else result.thermalState = "critical";
    }
  } catch {
    // No thermal data
  }

  return result;
}

// ── Windows ────────────────────────────────────────────────────────

async function collectWindowsPower(): Promise<Partial<AgentPowerTelemetry>> {
  const result: Partial<AgentPowerTelemetry> = {};

  try {
    const output = await execCommand(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
        "$b = Get-WmiObject Win32_Battery; " +
        "if ($b) { \"$($b.EstimatedChargeRemaining)|$($b.BatteryStatus)\" } else { 'NoBattery' }"
      ],
      COMMAND_TIMEOUT_MS
    );
    const trimmed = output.trim();
    if (trimmed === "NoBattery") {
      result.onACPower = true;
    } else {
      const [chargeStr, statusStr] = trimmed.split("|");
      const charge = parseInt(chargeStr, 10);
      if (Number.isFinite(charge)) {
        result.batteryPct = Math.max(0, Math.min(100, charge));
      }
      // BatteryStatus: 1 = discharging, 2 = AC, 3 = fully charged, ...
      const status = parseInt(statusStr, 10);
      result.onACPower = status !== 1;
    }
  } catch {
    result.onACPower = true;
  }

  return result;
}

// ── Helpers ────────────────────────────────────────────────────────

function execCommand(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, { timeout: timeoutMs }, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout);
    });
    // Ensure process is killed on timeout
    proc.on("error", reject);
  });
}
