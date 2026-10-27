import { describe, expect, it } from "vitest";
import { pullSandboxRejection, swarmExecutionEnabled } from "../../src/swarm/sandbox-enforcement.js";

// #45: the coordinator /pull handler calls pullSandboxRejection(capability) BEFORE queue.claim().
describe("coordinator /pull sandbox gate", () => {
  it("rejects agents registered with sandboxMode none (no claim)", () => {
    expect(pullSandboxRejection({ sandboxMode: "none" })).toEqual({
      subtask: null,
      sandboxRequired: true,
      reason: "agent_lacks_sandbox_capability"
    });
  });

  it("rejects agents with no reported sandbox mode", () => {
    expect(pullSandboxRejection(undefined)).not.toBeNull();
    expect(pullSandboxRejection({})).not.toBeNull();
  });

  it("allows docker and vm agents regardless of tenant", () => {
    expect(pullSandboxRejection({ sandboxMode: "docker" })).toBeNull();
    expect(pullSandboxRejection({ sandboxMode: "vm" })).toBeNull();
  });
});

describe("worker swarm execution switch", () => {
  it("SANDBOX_MODE=none disables /pull and mesh/peer execution", () => {
    expect(swarmExecutionEnabled("none")).toBe(false);
    expect(swarmExecutionEnabled("docker")).toBe(true);
    expect(swarmExecutionEnabled("vm")).toBe(true);
  });
});
