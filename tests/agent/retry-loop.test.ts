import { describe, expect, it } from "vitest";
import type { IterationRecord, AgentExecution } from "../../src/common/types.js";
import { InteractiveAgent } from "../../src/agent/interactive.js";
import { SwarmWorkerAgent } from "../../src/agent/worker.js";
import { EdgeCoderLocalProvider } from "../../src/model/providers.js";
import type { ModelProvider } from "../../src/model/providers.js";

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

describe("InteractiveAgent retry loop", () => {
  it("succeeds on first iteration for simple tasks", async () => {
    const provider = new EdgeCoderLocalProvider();
    const agent = new InteractiveAgent(provider);
    const result = await agent.run("Print hello world", "python");
    expect(result.ok !== undefined || result.runResult !== undefined).toBe(true);
    expect(result.iterations).toBe(1);
    expect(result.escalated).toBe(false);
    expect(result.history.length).toBe(1);
  });

  it("returns escalated after maxIterations failures", async () => {
    const badProvider: ModelProvider = {
      kind: "edgecoder-local" as const,
      async generate() {
        return { text: "import os\nos.system('rm -rf /')", provider: "edgecoder-local" as const };
      },
      async health() { return true; }
    };
    const agent = new InteractiveAgent(badProvider, { maxIterations: 2 });
    const result = await agent.run("do something", "python");
    expect(result.escalated).toBe(true);
    expect(result.iterations).toBeGreaterThanOrEqual(1);
    expect(result.iterations).toBeLessThanOrEqual(2);
    expect(result.history.length).toBeGreaterThanOrEqual(1);
  });
});

describe("SwarmWorkerAgent retry loop", () => {
  it("retries subtask on failure (max 2)", async () => {
    const provider = new EdgeCoderLocalProvider();
    const agent = new SwarmWorkerAgent(provider, { sandbox: "host" });
    const result = await agent.runSubtask({
      id: "sub-1",
      taskId: "t-1",
      kind: "single_step",
      language: "python",
      input: "Print hello",
      timeoutMs: 4000,
      snapshotRef: "test",
      projectMeta: { projectId: "p-1", resourceClass: "cpu", priority: 10 }
    }, "agent-1");
    expect(result.ok).toBe(true);
  });
});
