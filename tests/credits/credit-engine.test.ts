import { describe, expect, it } from "vitest";
import { CreditEngine } from "../../src/credits/engine.js";

describe("credit engine", () => {
  it("accrues credits with load multiplier", () => {
    const engine = new CreditEngine();
    const tx = engine.accrue(
      {
        reportId: "r-1",
        agentId: "worker-a",
        taskId: "t-1",
        resourceClass: "cpu",
        cpuSeconds: 10,
        gpuSeconds: 0,
        success: true,
        qualityScore: 1.0,
        timestampMs: Date.now()
      },
      { queuedTasks: 10, activeAgents: 5 }
    );
    expect(tx.credits).toBeGreaterThan(0);
    expect(engine.balance("worker-a")).toBe(tx.credits);
  });

  it("rejects duplicate contribution reports", () => {
    const engine = new CreditEngine();
    const report = {
      reportId: "r-dup",
      agentId: "worker-a",
      taskId: "t-1",
      resourceClass: "gpu" as const,
      cpuSeconds: 0,
      gpuSeconds: 5,
      success: true,
      qualityScore: 1.0,
      timestampMs: Date.now()
    };
    engine.accrue(report, { queuedTasks: 2, activeAgents: 2 });
    expect(() => engine.accrue(report, { queuedTasks: 2, activeAgents: 2 })).toThrow(
      "duplicate_contribution_report"
    );
  });

  it("rejects overspending", () => {
    const engine = new CreditEngine();
    expect(() => engine.spend("submitter-a", 10, "submit")).toThrow("insufficient_credits");
  });
});
