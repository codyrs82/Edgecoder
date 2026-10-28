import { describe, expect, it } from "vitest";
import { agentStatusMessage, localAgentUsable, parseAgentStatus, shouldDropToken, statusFromTokenError } from "../src/lib/agent-status";

describe("local agent status (#72)", () => {
  it("parses the shell's status strings", () => {
    expect(parseAgentStatus("spawned")).toBe("spawned");
    expect(parseAgentStatus("port_occupied")).toBe("port_occupied");
    expect(parseAgentStatus("not_started")).toBe("not_started");
    expect(parseAgentStatus("other")).toBe("unknown");
    expect(parseAgentStatus(undefined)).toBe("unknown");
  });

  it("reads the status from a get_local_token refusal", () => {
    expect(statusFromTokenError("port_occupied: another process is already listening on 127.0.0.1:4301")).toBe("port_occupied");
    expect(statusFromTokenError("not_started: the local agent is not running")).toBe("not_started");
    expect(statusFromTokenError("invoke not ready")).toBeNull();
  });

  it("never uses an occupied :4301", () => {
    expect(localAgentUsable("port_occupied")).toBe(false);
    expect(localAgentUsable("spawned")).toBe(true);
    expect(localAgentUsable("unknown")).toBe(true);
    expect(localAgentUsable("not_started")).toBe(false);
    expect(agentStatusMessage("port_occupied")).toMatch(/4301/);
    expect(agentStatusMessage("spawned")).toBeNull();
  });

  it("drops the cached token unless it's our live agent", () => {
    expect(shouldDropToken("not_started")).toBe(true);
    expect(shouldDropToken("port_occupied")).toBe(true);
    expect(shouldDropToken("spawned")).toBe(false);
    expect(shouldDropToken("unknown")).toBe(false);
  });
});
