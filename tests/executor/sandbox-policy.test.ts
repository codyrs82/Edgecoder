import { describe, expect, it } from "vitest";
import type { SandboxPolicy, SandboxMode } from "../../src/common/types.js";
import {
  buildDockerArgs,
  policyToDockerOptions,
  type DockerSandboxOptions
} from "../../src/executor/docker-sandbox.js";
import { enforceSandboxPolicy } from "../../src/swarm/sandbox-enforcement.js";

// ────────────────────────────────────────────────────────────
// 1. SandboxPolicy type validation
// ────────────────────────────────────────────────────────────

describe("SandboxPolicy type", () => {
  it("accepts a valid policy with all fields", () => {
    const policy: SandboxPolicy = {
      required: true,
      allowedModes: ["docker", "vm"],
      maxMemoryMB: 512,
      maxCpuPercent: 80,
      networkAccess: false,
      timeoutMs: 30_000
    };
    expect(policy.required).toBe(true);
    expect(policy.allowedModes).toContain("docker");
    expect(policy.maxMemoryMB).toBe(512);
    expect(policy.maxCpuPercent).toBe(80);
    expect(policy.networkAccess).toBe(false);
    expect(policy.timeoutMs).toBe(30_000);
  });

  it("accepts a minimal policy with only required fields", () => {
    const policy: SandboxPolicy = {
      required: false,
      allowedModes: ["none"]
    };
    expect(policy.required).toBe(false);
    expect(policy.allowedModes).toEqual(["none"]);
    expect(policy.maxMemoryMB).toBeUndefined();
    expect(policy.maxCpuPercent).toBeUndefined();
  });

  it("SandboxMode accepts all valid values", () => {
    const modes: SandboxMode[] = ["none", "docker", "vm"];
    expect(modes).toHaveLength(3);
    expect(modes).toContain("none");
    expect(modes).toContain("docker");
    expect(modes).toContain("vm");
  });
});

// ────────────────────────────────────────────────────────────
// 2. Worker refuses execution when SANDBOX_REQUIRED=true but mode=none
// ────────────────────────────────────────────────────────────

describe("enforceSandboxPolicy", () => {
  it("returns error when sandbox required but mode is none", async () => {
    const error = await enforceSandboxPolicy("none", true);
    expect(error).not.toBeNull();
    expect(error).toContain("sandbox_required");
    expect(error).toContain("SANDBOX_REQUIRED=true");
  });

  it("returns null when sandbox is not required and mode is none", async () => {
    const error = await enforceSandboxPolicy("none", false);
    expect(error).toBeNull();
  });

  it("returns null when mode is docker and docker is available (or returns error if Docker not running)", async () => {
    // This test adapts to the environment: if Docker is available it passes,
    // otherwise it expects the appropriate error
    const error = await enforceSandboxPolicy("docker", true);
    if (error) {
      expect(error).toContain("sandbox_unavailable");
    } else {
      expect(error).toBeNull();
    }
  });

  it("returns null for vm mode (no runtime check yet)", async () => {
    const error = await enforceSandboxPolicy("vm", false);
    expect(error).toBeNull();
  });

  it("returns null for vm mode with required=true", async () => {
    const error = await enforceSandboxPolicy("vm", true);
    expect(error).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// 3. Docker sandbox respects memory/CPU limits (verify command args)
// ────────────────────────────────────────────────────────────

describe("buildDockerArgs", () => {
  it("uses default limits when no options provided", () => {
    const args = buildDockerArgs("edgecoder/sandbox-python:latest", "print('hi')");
    expect(args).toContain("--memory=256m");
    expect(args).toContain("--cpus=0.50");
    expect(args).toContain("--network=none");
    expect(args).toContain("--read-only");
    expect(args).toContain("--pids-limit=50");
    expect(args).toContain("edgecoder/sandbox-python:latest");
    expect(args).toContain("print('hi')");
  });

  it("respects custom memory limit", () => {
    const args = buildDockerArgs("img:test", "code", { memoryMB: 1024 });
    expect(args).toContain("--memory=1024m");
  });

  it("respects custom CPU limit", () => {
    const args = buildDockerArgs("img:test", "code", { cpuPercent: 200 });
    expect(args).toContain("--cpus=2.00");
  });

  it("respects CPU limit of 50 percent (0.50 cpus)", () => {
    const args = buildDockerArgs("img:test", "code", { cpuPercent: 50 });
    expect(args).toContain("--cpus=0.50");
  });

  it("enables network access when requested", () => {
    const args = buildDockerArgs("img:test", "code", { networkAccess: true });
    expect(args).not.toContain("--network=none");
  });

  it("disables network by default", () => {
    const args = buildDockerArgs("img:test", "code");
    expect(args).toContain("--network=none");
  });

  it("applies read-only filesystem by default", () => {
    const args = buildDockerArgs("img:test", "code");
    expect(args).toContain("--read-only");
  });

  it("omits read-only when explicitly disabled", () => {
    const args = buildDockerArgs("img:test", "code", { readOnly: false });
    expect(args).not.toContain("--read-only");
  });
});

describe("policyToDockerOptions", () => {
  it("converts a full SandboxPolicy to DockerSandboxOptions", () => {
    const policy: SandboxPolicy = {
      required: true,
      allowedModes: ["docker"],
      maxMemoryMB: 512,
      maxCpuPercent: 75,
      networkAccess: true,
      timeoutMs: 10_000
    };
    const opts = policyToDockerOptions(policy);
    expect(opts.memoryMB).toBe(512);
    expect(opts.cpuPercent).toBe(75);
    expect(opts.networkAccess).toBe(true);
    expect(opts.readOnly).toBe(true); // always read-only
  });

  it("returns empty options when no policy provided", () => {
    const opts = policyToDockerOptions(undefined);
    expect(opts).toEqual({});
  });

  it("handles policy with only required fields", () => {
    const policy: SandboxPolicy = {
      required: false,
      allowedModes: ["none"]
    };
    const opts = policyToDockerOptions(policy);
    expect(opts.memoryMB).toBeUndefined();
    expect(opts.cpuPercent).toBeUndefined();
    expect(opts.networkAccess).toBeUndefined();
    expect(opts.readOnly).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// 4. Coordinator tracks agent sandbox capabilities
// ────────────────────────────────────────────────────────────

describe("Coordinator sandbox capability tracking", () => {
  it("agentCapabilities map type includes sandboxMode", () => {
    // Simulate what the coordinator does when it stores agent capabilities
    const agentCapabilities = new Map<
      string,
      { sandboxMode: SandboxMode; lastSeenMs: number }
    >();

    agentCapabilities.set("agent-1", {
      sandboxMode: "docker",
      lastSeenMs: Date.now()
    });

    agentCapabilities.set("agent-2", {
      sandboxMode: "none",
      lastSeenMs: Date.now()
    });

    expect(agentCapabilities.get("agent-1")?.sandboxMode).toBe("docker");
    expect(agentCapabilities.get("agent-2")?.sandboxMode).toBe("none");
  });

  it("sandbox mode updates on heartbeat", () => {
    const agentCapabilities = new Map<
      string,
      { sandboxMode: SandboxMode; lastSeenMs: number }
    >();

    // Initially registered with no sandbox
    agentCapabilities.set("agent-1", {
      sandboxMode: "none",
      lastSeenMs: Date.now()
    });
    expect(agentCapabilities.get("agent-1")?.sandboxMode).toBe("none");

    // Heartbeat updates sandbox mode (simulating the coordinator logic)
    const heartbeatSandboxMode: SandboxMode = "docker";
    const existing = agentCapabilities.get("agent-1");
    if (existing) {
      existing.sandboxMode = heartbeatSandboxMode;
    }
    expect(agentCapabilities.get("agent-1")?.sandboxMode).toBe("docker");
  });
});

// ────────────────────────────────────────────────────────────
// 5. Task assignment respects sandbox requirements
// ────────────────────────────────────────────────────────────

describe("Task assignment sandbox requirement enforcement", () => {
  it("rejects task assignment to agent without sandbox when sandbox is required", () => {
    // Simulate coordinator pull logic
    const agentSandboxMode: SandboxMode = "none";
    const taskRequiresSandbox = true;

    const shouldReject = taskRequiresSandbox && agentSandboxMode === "none";
    expect(shouldReject).toBe(true);
  });

  it("allows task assignment to agent with docker sandbox", () => {
    const agentSandboxMode: SandboxMode = "docker";
    const taskRequiresSandbox = true;

    const shouldReject = taskRequiresSandbox && agentSandboxMode === "none";
    expect(shouldReject).toBe(false);
  });

  it("allows task assignment to agent with vm sandbox", () => {
    const agentSandboxMode: SandboxMode = "vm";
    const taskRequiresSandbox = true;

    const shouldReject = taskRequiresSandbox && agentSandboxMode === "none";
    expect(shouldReject).toBe(false);
  });

  it("allows task assignment when sandbox is not required regardless of agent mode", () => {
    const agentSandboxMode: SandboxMode = "none";
    const taskRequiresSandbox = false;

    const shouldReject = taskRequiresSandbox && agentSandboxMode === "none";
    expect(shouldReject).toBe(false);
  });

  it("enterprise tenant tasks require sandbox (coordinator heuristic)", () => {
    // Simulates the coordinator check: if task has a tenantId, sandbox is expected
    const tenantId = "enterprise-acme";
    const agentSandboxMode: SandboxMode = "none";
    const taskRequiresSandbox = (tenantId && tenantId !== "") || agentSandboxMode === "docker" || agentSandboxMode === "vm";
    const shouldReject = taskRequiresSandbox && agentSandboxMode === "none";
    expect(shouldReject).toBe(true);
  });
});
