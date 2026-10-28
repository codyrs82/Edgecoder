import { describe, expect, it } from "vitest";
import { contributionCredits } from "../../src/credits/pricing.js";
import { CreditEngine } from "../../src/credits/engine.js";

// #38: one formula for balances and the earnings_accrual ledger payload.
const load = { queuedTasks: 1, activeAgents: 1 }; // pressure 1.0 -> multiplier 1.0
const report = (over: Record<string, unknown> = {}) => ({
  reportId: `r-${Math.random()}`,
  agentId: "acct",
  taskId: "t",
  resourceClass: "cpu" as const,
  cpuSeconds: 12,
  gpuSeconds: 0,
  success: true,
  qualityScore: 1,
  timestampMs: 0,
  ...over
});

describe("contributionCredits (#38)", () => {
  it("is measured seconds x base rate x quality x load", () => {
    expect(contributionCredits(report(), load)).toBe(12);
    expect(contributionCredits(report({ resourceClass: "gpu", gpuSeconds: 3 }), load)).toBe(12);
    expect(contributionCredits(report({ qualityScore: 9 }), load)).toBe(18); // quality clamped to 1.5
    expect(contributionCredits(report(), { queuedTasks: 0, activeAgents: 4 })).toBe(9.6); // low load 0.8
  });

  it("failed, zero-length or invalid work earns 0 (no flat placeholder credit)", () => {
    expect(contributionCredits(report({ success: false }), load)).toBe(0);
    expect(contributionCredits(report({ cpuSeconds: 0 }), load)).toBe(0);
    expect(contributionCredits(report({ cpuSeconds: Number.NaN }), load)).toBe(0);
    expect(contributionCredits(report({ cpuSeconds: -5 }), load)).toBe(0);
  });

  it("the balance equals the formula (what the ledger payload records)", () => {
    const e = new CreditEngine();
    const r = report({ cpuSeconds: 7.5 });
    const tx = e.accrue(r as any, load);
    expect(tx.credits).toBe(contributionCredits(r, load));
    expect(e.balance("acct")).toBe(7.5);
  });
});
