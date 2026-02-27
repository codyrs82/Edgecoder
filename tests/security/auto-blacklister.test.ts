import { describe, expect, it, vi } from "vitest";
import { AutoBlacklister, type BlacklistAction } from "../../src/security/auto-blacklister.js";
import { type AnomalyEvent } from "../../src/security/anomaly-detector.js";

function makeAnomaly(overrides: Partial<AnomalyEvent> = {}): AnomalyEvent {
  return {
    ruleId: "BHV999",
    ruleName: "Test rule",
    severity: "WARN",
    blacklistReason: "forged_results",
    description: "test anomaly",
    stats: {},
    ...overrides,
  };
}

describe("AutoBlacklister", () => {
  it("instant-blacklists on CRITICAL severity", () => {
    const onBlacklist = vi.fn();
    const blacklister = new AutoBlacklister(onBlacklist);

    const anomaly = makeAnomaly({ ruleId: "BHV001", severity: "CRITICAL", blacklistReason: "forged_results" });
    const result = blacklister.processAnomalies("agent-1", [anomaly]);

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe("agent-1");
    expect(result!.reasonCode).toBe("forged_results");
    expect(onBlacklist).toHaveBeenCalledOnce();
    expect(onBlacklist.mock.calls[0][0].agentId).toBe("agent-1");
  });

  it("accumulates strikes for non-CRITICAL anomalies", () => {
    const onBlacklist = vi.fn();
    const blacklister = new AutoBlacklister(onBlacklist);
    const now = Date.now();

    const warn = makeAnomaly({ severity: "WARN" });

    // First strike — no blacklist
    const r1 = blacklister.processAnomalies("agent-1", [warn], now);
    expect(r1).toBeNull();
    expect(onBlacklist).not.toHaveBeenCalled();
    expect(blacklister.getStrikeCount("agent-1", now)).toBe(1);

    // Second strike — still no blacklist
    const r2 = blacklister.processAnomalies("agent-1", [warn], now + 1000);
    expect(r2).toBeNull();
    expect(blacklister.getStrikeCount("agent-1", now + 1000)).toBe(2);

    // Third strike — blacklist triggered
    const r3 = blacklister.processAnomalies("agent-1", [warn], now + 2000);
    expect(r3).not.toBeNull();
    expect(r3!.agentId).toBe("agent-1");
    expect(onBlacklist).toHaveBeenCalledOnce();
  });

  it("clears strikes after blacklist", () => {
    const onBlacklist = vi.fn();
    const blacklister = new AutoBlacklister(onBlacklist);
    const now = Date.now();
    const warn = makeAnomaly({ severity: "WARN" });

    blacklister.processAnomalies("agent-1", [warn], now);
    blacklister.processAnomalies("agent-1", [warn], now + 1000);
    blacklister.processAnomalies("agent-1", [warn], now + 2000);

    // Strikes should be cleared after blacklist
    expect(blacklister.getStrikeCount("agent-1", now + 3000)).toBe(0);
  });

  it("expires strikes outside window", () => {
    const WINDOW = 5000; // 5 second window for testing
    const onBlacklist = vi.fn();
    const blacklister = new AutoBlacklister(onBlacklist, WINDOW);
    const now = Date.now();
    const warn = makeAnomaly({ severity: "WARN" });

    blacklister.processAnomalies("agent-1", [warn], now);
    blacklister.processAnomalies("agent-1", [warn], now + 1000);

    // Wait well beyond window so both strikes expire
    expect(blacklister.getStrikeCount("agent-1", now + WINDOW + 1001)).toBe(0);

    // These should not trigger blacklist since old strikes expired
    const r = blacklister.processAnomalies("agent-1", [warn], now + WINDOW + 1002);
    expect(r).toBeNull();
    expect(onBlacklist).not.toHaveBeenCalled();
  });

  it("does nothing with empty anomaly list", () => {
    const onBlacklist = vi.fn();
    const blacklister = new AutoBlacklister(onBlacklist);

    const result = blacklister.processAnomalies("agent-1", []);
    expect(result).toBeNull();
    expect(onBlacklist).not.toHaveBeenCalled();
  });

  it("HIGH anomalies also accumulate strikes", () => {
    const onBlacklist = vi.fn();
    const blacklister = new AutoBlacklister(onBlacklist);
    const now = Date.now();

    const high = makeAnomaly({ severity: "HIGH", blacklistReason: "dos_behavior" });

    blacklister.processAnomalies("agent-1", [high], now);
    blacklister.processAnomalies("agent-1", [high], now + 1000);
    const r = blacklister.processAnomalies("agent-1", [high], now + 2000);
    expect(r).not.toBeNull();
    expect(r!.reasonCode).toBe("dos_behavior");
  });

  it("multiple anomalies in one call can accumulate multiple strikes", () => {
    const onBlacklist = vi.fn();
    const blacklister = new AutoBlacklister(onBlacklist);
    const now = Date.now();

    const warn1 = makeAnomaly({ severity: "WARN", ruleId: "BHV009" });
    const warn2 = makeAnomaly({ severity: "WARN", ruleId: "BHV010" });
    const warn3 = makeAnomaly({ severity: "WARN", ruleId: "BHV002" });

    // 3 strikes in one call → blacklist
    const r = blacklister.processAnomalies("agent-1", [warn1, warn2, warn3], now);
    expect(r).not.toBeNull();
    expect(onBlacklist).toHaveBeenCalledOnce();
  });

  it("produces evidence hash from anomaly events", () => {
    const onBlacklist = vi.fn();
    const blacklister = new AutoBlacklister(onBlacklist);

    const anomaly = makeAnomaly({ severity: "CRITICAL" });
    const result = blacklister.processAnomalies("agent-1", [anomaly]);

    expect(result!.evidenceHashSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("picks most severe reason code", () => {
    const onBlacklist = vi.fn();
    const blacklister = new AutoBlacklister(onBlacklist);
    const now = Date.now();

    const critical = makeAnomaly({ severity: "CRITICAL", blacklistReason: "credential_abuse", ruleId: "BHV005" });
    const warn = makeAnomaly({ severity: "WARN", blacklistReason: "forged_results", ruleId: "BHV010" });

    const result = blacklister.processAnomalies("agent-1", [warn, critical], now);
    expect(result!.reasonCode).toBe("credential_abuse");
  });

  it("isolates agents", () => {
    const onBlacklist = vi.fn();
    const blacklister = new AutoBlacklister(onBlacklist);
    const now = Date.now();
    const warn = makeAnomaly({ severity: "WARN" });

    blacklister.processAnomalies("agent-1", [warn], now);
    blacklister.processAnomalies("agent-2", [warn], now);

    expect(blacklister.getStrikeCount("agent-1", now)).toBe(1);
    expect(blacklister.getStrikeCount("agent-2", now)).toBe(1);
  });
});
