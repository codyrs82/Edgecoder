import { describe, expect, test } from "vitest";
import { evaluateAgentPowerPolicy } from "../../src/swarm/power-policy.js";

describe("swarm power policy", () => {
  test("allows non-ios agents by default", () => {
    const decision = evaluateAgentPowerPolicy({
      os: "macos",
      nowMs: 1000,
      batteryPullMinIntervalMs: 45_000,
      batteryTaskStopLevelPct: 20
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
  });

  test("blocks all work on iOS low power mode", () => {
    const decision = evaluateAgentPowerPolicy({
      os: "ios",
      telemetry: { onExternalPower: false, batteryLevelPct: 80, lowPowerMode: true },
      nowMs: 1000,
      batteryPullMinIntervalMs: 45_000,
      batteryTaskStopLevelPct: 20
    });
    expect(decision.allowCoordinatorTasks).toBe(false);
    expect(decision.allowPeerDirectWork).toBe(false);
    expect(decision.reason).toBe("ios_low_power_mode");
  });

  test("throttles coordinator tasks on iOS battery and disables peer-direct", () => {
    const throttled = evaluateAgentPowerPolicy({
      os: "ios",
      telemetry: { onExternalPower: false, batteryLevelPct: 65, lowPowerMode: false },
      nowMs: 10_000,
      lastTaskAssignedAtMs: 8_000,
      batteryPullMinIntervalMs: 5_000,
      batteryTaskStopLevelPct: 20
    });
    expect(throttled.allowCoordinatorTasks).toBe(false);
    expect(throttled.allowPeerDirectWork).toBe(false);
    expect(throttled.reason).toBe("ios_on_battery_throttled");

    const allowed = evaluateAgentPowerPolicy({
      os: "ios",
      telemetry: { onExternalPower: false, batteryLevelPct: 65, lowPowerMode: false },
      nowMs: 20_000,
      lastTaskAssignedAtMs: 8_000,
      batteryPullMinIntervalMs: 5_000,
      batteryTaskStopLevelPct: 20
    });
    expect(allowed.allowCoordinatorTasks).toBe(true);
    expect(allowed.allowPeerDirectWork).toBe(false);
    expect(allowed.reason).toBe("ios_on_battery_lite_mode");
  });
});
