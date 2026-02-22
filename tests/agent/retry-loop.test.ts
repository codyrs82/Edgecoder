import { describe, expect, it } from "vitest";
import type { IterationRecord, AgentExecution } from "../../src/common/types.js";

describe("agent retry types", () => {
  it("IterationRecord has required fields", () => {
    const record: IterationRecord = {
      iteration: 1,
      plan: "step 1",
      code: "print('hi')",
      runResult: {
        language: "python",
        ok: false,
        stdout: "",
        stderr: "NameError",
        exitCode: 1,
        durationMs: 100,
        queueForCloud: false
      }
    };
    expect(record.iteration).toBe(1);
  });

  it("AgentExecution includes iteration tracking and escalation", () => {
    const exec: AgentExecution = {
      plan: "plan",
      generatedCode: "code",
      runResult: {
        language: "python",
        ok: true,
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        durationMs: 50,
        queueForCloud: false
      },
      iterations: 1,
      history: [],
      escalated: false
    };
    expect(exec.escalated).toBe(false);
    expect(exec.iterations).toBe(1);
  });
});
