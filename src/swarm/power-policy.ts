// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

export interface AgentPowerTelemetry {
  // iOS fields (backward compatible)
  onExternalPower?: boolean;
  batteryLevelPct?: number;
  lowPowerMode?: boolean;
  updatedAtMs?: number;

  // Desktop/laptop fields
  onACPower?: boolean;
  batteryPct?: number;
  thermalState?: "nominal" | "fair" | "serious" | "critical";
  cpuUsagePct?: number;
  memoryUsagePct?: number;
  deviceType?: "desktop" | "laptop" | "phone" | "tablet" | "server";
}

export interface PowerPolicyInput {
  os: string;
  telemetry?: AgentPowerTelemetry;
  nowMs: number;
  lastTaskAssignedAtMs?: number;
  batteryPullMinIntervalMs: number;
  batteryTaskStopLevelPct: number;
  taskTimeoutMs?: number;
}

export interface PowerPolicyDecision {
  allowCoordinatorTasks: boolean;
  allowPeerDirectWork: boolean;
  allowSmallTasksOnly?: boolean;
  /**
   * With allowSmallTasksOnly: the longest job (its timeoutMs) the agent takes now; a longer one is
   * refused (SMALL_TASK_MAX_TIMEOUT_MS). Model calls run with far longer limits, so a host here takes
   * no network model calls.
   */
  maxTaskTimeoutMs?: number;
  deferMs?: number;
  reason: string;
}

/** The longest job (timeoutMs) a laptop on low battery still takes ("small tasks only"). */
export const SMALL_TASK_MAX_TIMEOUT_MS = 10_000;

/**
 * Whether an agent under this power decision takes a job with this timeout. A short deferral
 * (deferMs, high CPU) is not a refusal: the agent takes the job on its next pull.
 */
export function powerAllowsTask(decision: PowerPolicyDecision | undefined, timeoutMs: number | undefined): boolean {
  if (!decision) return true;
  if (!decision.allowCoordinatorTasks) return false;
  if (!decision.allowSmallTasksOnly) return true;
  const max = decision.maxTaskTimeoutMs ?? SMALL_TASK_MAX_TIMEOUT_MS;
  return timeoutMs !== undefined && timeoutMs <= max;
}

/** An iOS agent: the iOS app registers with os "ios" and clientType "edgecoder-ios"; mesh-gossip phones are stored with os "ios". */
export function isIosAgent(agent: { os?: string; clientType?: string } | undefined): boolean {
  return Boolean(agent) && (agent!.os === "ios" || agent!.clientType === "edgecoder-ios");
}

/**
 * An iPhone takes coordinator jobs only while it is on external power (charging or full). True when
 * this is an iOS agent whose latest power telemetry (from /register or /heartbeat) does not say
 * `onExternalPower: true`; missing telemetry counts as not charging. Older app builds that run jobs
 * on battery are held back by this too.
 */
export function iosAgentNotCharging(agent: { os?: string; clientType?: string; powerTelemetry?: AgentPowerTelemetry } | undefined): boolean {
  return isIosAgent(agent) && agent!.powerTelemetry?.onExternalPower !== true;
}

export function evaluateAgentPowerPolicy(input: PowerPolicyInput): PowerPolicyDecision {
  const telemetry = input.telemetry ?? {};

  // ── iOS path (unchanged for backward compatibility) ──────────────
  if (input.os === "ios") {
    return evaluateIosPowerPolicy(input, telemetry);
  }

  // ── Desktop / laptop / server path ───────────────────────────────
  const deviceType = telemetry.deviceType;

  // Server devices: always unlimited
  if (deviceType === "server") {
    return {
      allowCoordinatorTasks: true,
      allowPeerDirectWork: true,
      reason: "server_unlimited"
    };
  }

  // High CPU: defer new tasks for 5 seconds
  if (typeof telemetry.cpuUsagePct === "number" && telemetry.cpuUsagePct > 85) {
    return {
      allowCoordinatorTasks: true,
      allowPeerDirectWork: true,
      deferMs: 5000,
      reason: "high_cpu_defer"
    };
  }

  // Thermal throttle: serious or critical thermal state
  if (telemetry.thermalState === "serious" || telemetry.thermalState === "critical") {
    return {
      allowCoordinatorTasks: false,
      allowPeerDirectWork: false,
      reason: "thermal_throttle"
    };
  }

  // Determine if we have battery info (laptop behavior)
  const onAC = telemetry.onACPower;
  const batteryPct = typeof telemetry.batteryPct === "number"
    ? Math.max(0, Math.min(100, telemetry.batteryPct))
    : undefined;

  // Desktop on AC or no battery info: allow all
  if (deviceType === "desktop" || onAC === true || (onAC === undefined && batteryPct === undefined)) {
    return {
      allowCoordinatorTasks: true,
      allowPeerDirectWork: true,
      reason: "desktop_ac_power"
    };
  }

  // Laptop on battery with known percentage
  if (typeof batteryPct === "number") {
    if (batteryPct < 15) {
      return {
        allowCoordinatorTasks: false,
        allowPeerDirectWork: false,
        reason: "laptop_battery_critical"
      };
    }
    if (batteryPct <= 40) {
      return {
        allowCoordinatorTasks: true,
        allowPeerDirectWork: false,
        allowSmallTasksOnly: true,
        maxTaskTimeoutMs: SMALL_TASK_MAX_TIMEOUT_MS,
        reason: "laptop_battery_low"
      };
    }
    // Battery > 40%
    return {
      allowCoordinatorTasks: true,
      allowPeerDirectWork: false,
      reason: "laptop_battery_high"
    };
  }

  // Laptop on battery but no percentage available — conservative: allow coordinator only
  return {
    allowCoordinatorTasks: true,
    allowPeerDirectWork: false,
    reason: "laptop_battery_high"
  };
}

// ── Original iOS policy (extracted, unchanged) ─────────────────────
function evaluateIosPowerPolicy(
  input: PowerPolicyInput,
  telemetry: AgentPowerTelemetry
): PowerPolicyDecision {
  const onExternalPower = telemetry.onExternalPower === true;
  const lowPowerMode = telemetry.lowPowerMode === true;
  const batteryLevelPct =
    typeof telemetry.batteryLevelPct === "number" ? Math.max(0, Math.min(100, telemetry.batteryLevelPct)) : undefined;

  if (lowPowerMode) {
    return {
      allowCoordinatorTasks: false,
      allowPeerDirectWork: false,
      reason: "ios_low_power_mode"
    };
  }

  if (onExternalPower) {
    return {
      allowCoordinatorTasks: true,
      allowPeerDirectWork: true,
      reason: "ios_external_power"
    };
  }

  if (typeof batteryLevelPct === "number" && batteryLevelPct <= input.batteryTaskStopLevelPct) {
    return {
      allowCoordinatorTasks: false,
      allowPeerDirectWork: false,
      reason: "ios_battery_critical"
    };
  }

  const lastAssigned = input.lastTaskAssignedAtMs ?? 0;
  if (input.nowMs - lastAssigned < input.batteryPullMinIntervalMs) {
    return {
      allowCoordinatorTasks: false,
      allowPeerDirectWork: false,
      reason: "ios_on_battery_throttled"
    };
  }

  return {
    allowCoordinatorTasks: true,
    allowPeerDirectWork: false,
    reason: "ios_on_battery_lite_mode"
  };
}
