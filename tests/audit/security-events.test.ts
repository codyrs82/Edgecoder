import { describe, expect, test } from "vitest";
import {
  SecurityEventLogger,
  type SecurityEvent,
} from "../../src/audit/security-events.js";

describe("security-events", () => {
  test("log emits event with timestamp to sink", () => {
    const events: SecurityEvent[] = [];
    const logger = new SecurityEventLogger((e) => events.push(e));

    logger.log({
      level: "WARN",
      event: "failed_auth",
      source: { type: "agent", id: "agent-1" },
      action: "reject_request",
      coordinatorId: "coord-1",
    });

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("failed_auth");
    expect(events[0].timestamp).toBeTruthy();
    expect(new Date(events[0].timestamp).getTime()).toBeGreaterThan(0);
  });

  test("severity returns correct level for each event type", () => {
    const logger = new SecurityEventLogger(() => {});

    expect(logger.severity("failed_auth")).toBe("WARN");
    expect(logger.severity("replay_attempt")).toBe("HIGH");
    expect(logger.severity("ledger_chain_break")).toBe("CRITICAL");
    expect(logger.severity("key_rotation")).toBe("INFO");
    expect(logger.severity("sandbox_seccomp_violation")).toBe("HIGH");
  });

  test("CRITICAL events include expected types", () => {
    const logger = new SecurityEventLogger(() => {});
    const criticals = [
      "manifest_signature_failure",
      "ledger_chain_break",
      "blacklist_chain_tamper",
      "key_expired",
    ] as const;
    for (const type of criticals) {
      expect(logger.severity(type)).toBe("CRITICAL");
    }
  });

  test("event preserves source and details", () => {
    const events: SecurityEvent[] = [];
    const logger = new SecurityEventLogger((e) => events.push(e));

    logger.log({
      level: "HIGH",
      event: "invalid_signature",
      source: { type: "agent", id: "agent-x", ip: "10.0.0.1" },
      details: { path: "/submit", method: "POST" },
      action: "reject_request",
      coordinatorId: "coord-2",
    });

    expect(events[0].source.ip).toBe("10.0.0.1");
    expect(events[0].details?.path).toBe("/submit");
    expect(events[0].coordinatorId).toBe("coord-2");
  });
});
