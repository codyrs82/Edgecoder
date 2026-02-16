export interface AgentPowerTelemetry {
  onExternalPower?: boolean;
  batteryLevelPct?: number;
  lowPowerMode?: boolean;
  updatedAtMs?: number;
}

export interface PowerPolicyInput {
  os: string;
  telemetry?: AgentPowerTelemetry;
  nowMs: number;
  lastTaskAssignedAtMs?: number;
  batteryPullMinIntervalMs: number;
  batteryTaskStopLevelPct: number;
}

export interface PowerPolicyDecision {
  allowCoordinatorTasks: boolean;
  allowPeerDirectWork: boolean;
  reason: string;
}

export function evaluateAgentPowerPolicy(input: PowerPolicyInput): PowerPolicyDecision {
  if (input.os !== "ios") {
    return {
      allowCoordinatorTasks: true,
      allowPeerDirectWork: true,
      reason: "non_mobile_default"
    };
  }

  const telemetry = input.telemetry ?? {};
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
