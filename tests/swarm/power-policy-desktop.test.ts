import { describe, expect, test } from "vitest";
import { evaluateAgentPowerPolicy, type AgentPowerTelemetry } from "../../src/swarm/power-policy.js";

const BASE_INPUT = {
  nowMs: 1000,
  batteryPullMinIntervalMs: 45_000,
  batteryTaskStopLevelPct: 20
};

describe("desktop power policy", () => {
  test("desktop AC power allows all tasks", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: true,
        batteryPct: 85,
        deviceType: "desktop"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
    expect(decision.reason).toBe("desktop_ac_power");
  });

  test("desktop with no battery info allows all tasks", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        deviceType: "desktop"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
    expect(decision.reason).toBe("desktop_ac_power");
  });

  test("laptop on AC power allows all tasks", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: true,
        batteryPct: 60,
        deviceType: "laptop"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
    expect(decision.reason).toBe("desktop_ac_power");
  });

  test("laptop battery high (>40%) throttles peer-direct", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: false,
        batteryPct: 65,
        deviceType: "laptop"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(false);
    expect(decision.reason).toBe("laptop_battery_high");
  });

  test("laptop battery low (15-40%) only allows small tasks", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: false,
        batteryPct: 30,
        deviceType: "laptop"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(false);
    expect(decision.allowSmallTasksOnly).toBe(true);
    expect(decision.reason).toBe("laptop_battery_low");
  });

  test("laptop battery low at 40% boundary", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: false,
        batteryPct: 40,
        deviceType: "laptop"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowSmallTasksOnly).toBe(true);
    expect(decision.reason).toBe("laptop_battery_low");
  });

  test("laptop battery low at 15% boundary is still low (not critical)", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: false,
        batteryPct: 15,
        deviceType: "laptop"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowSmallTasksOnly).toBe(true);
    expect(decision.reason).toBe("laptop_battery_low");
  });

  test("laptop battery critical (<15%) blocks all tasks", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: false,
        batteryPct: 10,
        deviceType: "laptop"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(false);
    expect(decision.allowPeerDirectWork).toBe(false);
    expect(decision.reason).toBe("laptop_battery_critical");
  });

  test("laptop battery critical at 0%", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: false,
        batteryPct: 0,
        deviceType: "laptop"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(false);
    expect(decision.allowPeerDirectWork).toBe(false);
    expect(decision.reason).toBe("laptop_battery_critical");
  });
});

describe("thermal throttle", () => {
  test("serious thermal state blocks tasks", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: true,
        thermalState: "serious",
        deviceType: "laptop"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(false);
    expect(decision.allowPeerDirectWork).toBe(false);
    expect(decision.reason).toBe("thermal_throttle");
  });

  test("critical thermal state blocks tasks", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "linux",
      telemetry: {
        onACPower: true,
        thermalState: "critical",
        deviceType: "desktop"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(false);
    expect(decision.allowPeerDirectWork).toBe(false);
    expect(decision.reason).toBe("thermal_throttle");
  });

  test("nominal thermal state allows tasks", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: true,
        thermalState: "nominal",
        deviceType: "laptop"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
    expect(decision.reason).toBe("desktop_ac_power");
  });

  test("fair thermal state allows tasks", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: true,
        thermalState: "fair",
        deviceType: "desktop"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
    expect(decision.reason).toBe("desktop_ac_power");
  });
});

describe("high CPU defer", () => {
  test("CPU > 85% defers new tasks for 5 seconds", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: true,
        cpuUsagePct: 90,
        deviceType: "laptop"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
    expect(decision.deferMs).toBe(5000);
    expect(decision.reason).toBe("high_cpu_defer");
  });

  test("CPU at 85% does not defer", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: true,
        cpuUsagePct: 85,
        deviceType: "laptop"
      }
    });
    expect(decision.deferMs).toBeUndefined();
    expect(decision.reason).not.toBe("high_cpu_defer");
  });

  test("CPU at 86% triggers defer", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: true,
        cpuUsagePct: 86,
        deviceType: "desktop"
      }
    });
    expect(decision.deferMs).toBe(5000);
    expect(decision.reason).toBe("high_cpu_defer");
  });
});

describe("server device type", () => {
  test("server always allows all tasks", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "linux",
      telemetry: {
        deviceType: "server"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
    expect(decision.reason).toBe("server_unlimited");
  });

  test("server ignores high CPU", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "linux",
      telemetry: {
        deviceType: "server",
        cpuUsagePct: 95
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
    expect(decision.reason).toBe("server_unlimited");
  });

  test("server ignores thermal state", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "linux",
      telemetry: {
        deviceType: "server",
        thermalState: "critical"
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
    expect(decision.reason).toBe("server_unlimited");
  });
});

describe("graceful fallback", () => {
  test("no telemetry on non-ios defaults to allow all", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos"
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
  });

  test("empty telemetry object on non-ios defaults to allow all", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "linux",
      telemetry: {}
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
    expect(decision.reason).toBe("desktop_ac_power");
  });

  test("unknown device type with AC power allows all", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        onACPower: true
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
  });
});

describe("backward compatibility — iOS fields still work", () => {
  test("iOS low power mode still blocks all work", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "ios",
      telemetry: {
        onExternalPower: false,
        batteryLevelPct: 80,
        lowPowerMode: true
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(false);
    expect(decision.allowPeerDirectWork).toBe(false);
    expect(decision.reason).toBe("ios_low_power_mode");
  });

  test("iOS external power allows all work", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "ios",
      telemetry: {
        onExternalPower: true,
        batteryLevelPct: 50
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
    expect(decision.reason).toBe("ios_external_power");
  });

  test("iOS critical battery blocks work", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "ios",
      telemetry: {
        onExternalPower: false,
        batteryLevelPct: 15
      }
    });
    expect(decision.allowCoordinatorTasks).toBe(false);
    expect(decision.allowPeerDirectWork).toBe(false);
    expect(decision.reason).toBe("ios_battery_critical");
  });

  test("iOS on battery throttled by interval", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "ios",
      telemetry: {
        onExternalPower: false,
        batteryLevelPct: 65,
        lowPowerMode: false
      },
      lastTaskAssignedAtMs: 800
    });
    expect(decision.allowCoordinatorTasks).toBe(false);
    expect(decision.reason).toBe("ios_on_battery_throttled");
  });

  test("iOS on battery lite mode when throttle has passed", () => {
    const decision = evaluateAgentPowerPolicy({
      os: "ios",
      telemetry: {
        onExternalPower: false,
        batteryLevelPct: 65,
        lowPowerMode: false
      },
      nowMs: 100_000,
      lastTaskAssignedAtMs: 1,
      batteryPullMinIntervalMs: 45_000,
      batteryTaskStopLevelPct: 20
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(false);
    expect(decision.reason).toBe("ios_on_battery_lite_mode");
  });
});

describe("desktop telemetry merging with iOS telemetry", () => {
  test("iOS telemetry fields are ignored on non-iOS OS", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        // iOS fields
        onExternalPower: false,
        batteryLevelPct: 10,
        lowPowerMode: true,
        // Desktop fields
        onACPower: true,
        batteryPct: 85,
        deviceType: "laptop"
      }
    });
    // Should use desktop path, not iOS — AC power overrides iOS low-power-mode
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
    expect(decision.reason).toBe("desktop_ac_power");
  });

  test("desktop fields are ignored on iOS OS", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "ios",
      telemetry: {
        // iOS fields
        onExternalPower: true,
        batteryLevelPct: 80,
        // Desktop fields (should be ignored)
        onACPower: false,
        batteryPct: 5,
        thermalState: "critical",
        deviceType: "laptop"
      }
    });
    // Should use iOS path — external power allows all
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(true);
    expect(decision.reason).toBe("ios_external_power");
  });

  test("combined telemetry object works for desktop evaluation", () => {
    const telemetry: AgentPowerTelemetry = {
      onExternalPower: false,
      batteryLevelPct: 50,
      lowPowerMode: false,
      onACPower: false,
      batteryPct: 25,
      thermalState: "nominal",
      cpuUsagePct: 40,
      memoryUsagePct: 60,
      deviceType: "laptop",
      updatedAtMs: Date.now()
    };
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry
    });
    expect(decision.allowCoordinatorTasks).toBe(true);
    expect(decision.allowPeerDirectWork).toBe(false);
    expect(decision.allowSmallTasksOnly).toBe(true);
    expect(decision.reason).toBe("laptop_battery_low");
  });
});

describe("priority ordering of desktop policies", () => {
  test("server takes priority over high CPU", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "linux",
      telemetry: {
        deviceType: "server",
        cpuUsagePct: 99,
        thermalState: "critical"
      }
    });
    expect(decision.reason).toBe("server_unlimited");
  });

  test("high CPU takes priority over thermal throttle", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        deviceType: "laptop",
        cpuUsagePct: 95,
        thermalState: "serious",
        onACPower: true
      }
    });
    expect(decision.reason).toBe("high_cpu_defer");
  });

  test("thermal throttle takes priority over battery decisions", () => {
    const decision = evaluateAgentPowerPolicy({
      ...BASE_INPUT,
      os: "macos",
      telemetry: {
        deviceType: "laptop",
        thermalState: "critical",
        onACPower: false,
        batteryPct: 50
      }
    });
    expect(decision.reason).toBe("thermal_throttle");
  });
});
