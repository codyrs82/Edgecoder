import { describe, expect, test } from "vitest";
import {
  createSandboxConfig,
  buildSpawnArgs,
  type SandboxConfig,
} from "../../src/executor/sandbox.js";

describe("sandbox", () => {
  test("createSandboxConfig sets defaults", () => {
    const config = createSandboxConfig({
      language: "python",
      memoryLimitMB: 256,
      cpuTimeLimitSec: 10,
      timeoutMs: 30_000,
    });
    expect(config.noFileCreation).toBe(true);
    expect(config.noNetwork).toBe(true);
    expect(config.timeoutMs).toBe(30_000);
    expect(config.memoryLimitMB).toBe(256);
    expect(config.cpuTimeLimitSec).toBe(10);
  });

  test("buildSpawnArgs for python without sandbox-exec", () => {
    const config: SandboxConfig = {
      timeoutMs: 5000,
      memoryLimitMB: 128,
      cpuTimeLimitSec: 5,
      noFileCreation: true,
      noNetwork: true,
      useSeccomp: false,
      useNamespaces: false,
      useSandboxExec: false,
    };
    const result = buildSpawnArgs(config, "python", "print('hi')");
    expect(result.command).toBe("python3");
    expect(result.args).toContain("-c");
    expect(result.args).toContain("print('hi')");
  });

  test("buildSpawnArgs for javascript includes memory flag", () => {
    const config: SandboxConfig = {
      timeoutMs: 5000,
      memoryLimitMB: 512,
      cpuTimeLimitSec: 5,
      noFileCreation: true,
      noNetwork: true,
      useSeccomp: false,
      useNamespaces: false,
      useSandboxExec: false,
    };
    const result = buildSpawnArgs(config, "javascript", "console.log(1)");
    expect(result.command).toBe("node");
    expect(result.args).toContain("--max-old-space-size=512");
    expect(result.args).toContain("--disallow-code-generation-from-strings");
    expect(result.args).toContain("-e");
    expect(result.args).toContain("console.log(1)");
  });

  test("buildSpawnArgs for python with sandbox-exec profile", () => {
    const config: SandboxConfig = {
      timeoutMs: 5000,
      memoryLimitMB: 128,
      cpuTimeLimitSec: 5,
      noFileCreation: true,
      noNetwork: true,
      useSeccomp: false,
      useNamespaces: false,
      useSandboxExec: true,
      sandboxProfile: "(version 1)(deny default)",
    };
    const result = buildSpawnArgs(config, "python", "x=1");
    expect(result.command).toBe("sandbox-exec");
    expect(result.args[0]).toBe("-p");
    expect(result.args[1]).toBe("(version 1)(deny default)");
    expect(result.args).toContain("python3");
    expect(result.args).toContain("x=1");
  });
});
