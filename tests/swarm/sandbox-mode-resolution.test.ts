import { describe, expect, it, vi } from "vitest";
import { resolveSandboxMode, SANDBOX_MODES } from "../../src/swarm/sandbox-enforcement.js";

// Regression: a worker started with SANDBOX_MODE=process (the value the old docs listed)
// sent it to the coordinator, whose schema only knows none|docker|vm, so /register
// answered 500 forever and the node never joined.
describe("resolveSandboxMode", () => {
  it("defaults to docker for swarm-only agents and none otherwise", () => {
    expect(resolveSandboxMode({})).toBe("docker");
    expect(resolveSandboxMode({ AGENT_MODE: "swarm-only" })).toBe("docker");
    expect(resolveSandboxMode({ AGENT_MODE: "ide-enabled" })).toBe("none");
  });

  it("accepts every mode the coordinator schema accepts (case-insensitive, trimmed)", () => {
    for (const mode of SANDBOX_MODES) {
      expect(resolveSandboxMode({ SANDBOX_MODE: ` ${mode.toUpperCase()} ` }, () => undefined)).toBe(mode);
    }
  });

  it("maps unknown values (e.g. 'process') to none and warns once", () => {
    const warn = vi.fn();
    expect(resolveSandboxMode({ SANDBOX_MODE: "process" }, warn)).toBe("none");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/SANDBOX_MODE=process is not supported/);
    expect(warn.mock.calls[0][0]).toMatch(/none, docker, vm/);
  });
});
