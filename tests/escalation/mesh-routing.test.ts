import { describe, expect, it } from "vitest";
import type { EscalationRequest, EscalationResult } from "../../src/escalation/types.js";
import { sanitizeEscalation } from "../../src/escalation/client.js";

describe("escalation types", () => {
  it("EscalationRequest has required fields", () => {
    const req: EscalationRequest = {
      taskId: "t-1",
      agentId: "a-1",
      task: "implement auth",
      failedCode: "print('broken')",
      errorHistory: ["NameError: x not defined"],
      language: "python",
      iterationsAttempted: 3
    };
    expect(req.taskId).toBe("t-1");
  });

  it("EscalationResult has required fields", () => {
    const res: EscalationResult = {
      taskId: "t-1",
      status: "completed",
      improvedCode: "print('fixed')",
      explanation: "Fixed the variable name"
    };
    expect(res.status).toBe("completed");
  });
});

describe("sanitizeEscalation", () => {
  it("redacts AWS keys in task descriptions", () => {
    const req: EscalationRequest = {
      taskId: "t-1",
      agentId: "a-1",
      task: "connect to AKIAIOSFODNN7EXAMPLE bucket",
      failedCode: "",
      errorHistory: [],
      language: "python",
      iterationsAttempted: 1
    };
    const clean = sanitizeEscalation(req);
    expect(clean.task).toContain("[REDACTED]");
    expect(clean.task).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts password patterns", () => {
    const req: EscalationRequest = {
      taskId: "t-2",
      agentId: "a-1",
      task: "db connection",
      failedCode: "password = supersecret123",
      errorHistory: ["api_key = sk-12345"],
      language: "python",
      iterationsAttempted: 1
    };
    const clean = sanitizeEscalation(req);
    expect(clean.failedCode).toContain("[REDACTED]");
  });
});
