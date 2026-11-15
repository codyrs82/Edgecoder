import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Subtask } from "../../src/common/types.js";
import { SwarmQueue } from "../../src/swarm/queue.js";
import { agentMayClaim, inferenceOnlyAgent, inferenceOnlyRejection, swarmExecutionEnabled } from "../../src/swarm/sandbox-enforcement.js";

function subtask(kind: Subtask["kind"], id: string): Subtask {
  return {
    id,
    taskId: `task-${id}`,
    kind,
    language: "python",
    input: kind === "inference" ? "hello" : "print(1)",
    timeoutMs: 60_000,
    snapshotRef: kind === "inference" ? "inference" : "commit:test",
    projectMeta: { projectId: "p", resourceClass: "gpu", priority: 10 }
  };
}

// #45 + inference-only mode: the coordinator /pull handler applies agentMayClaim inside queue.claim(),
// so nothing is claimed (and requeued) for an agent that may not run it.
describe("coordinator /pull sandbox rule", () => {
  it("an agent without a sandbox may claim inference subtasks only", () => {
    for (const cap of [{ sandboxMode: "none" as const }, {}, undefined]) {
      expect(agentMayClaim(cap, { kind: "inference" })).toBe(true);
      expect(agentMayClaim(cap, { kind: "single_step" })).toBe(false);
      expect(agentMayClaim(cap, { kind: "micro_loop" })).toBe(false);
      expect(inferenceOnlyAgent(cap)).toBe(true);
    }
  });

  it("docker and vm agents may claim every kind", () => {
    for (const sandboxMode of ["docker", "vm"] as const) {
      for (const kind of ["inference", "single_step", "micro_loop"]) expect(agentMayClaim({ sandboxMode }, { kind })).toBe(true);
      expect(inferenceOnlyAgent({ sandboxMode })).toBe(false);
    }
  });

  it("from a real queue, a sandbox-less agent skips code work and takes the inference subtask behind it", () => {
    const queue = new SwarmQueue();
    queue.enqueueSubtask(subtask("single_step", "code-1"));
    queue.enqueueSubtask(subtask("micro_loop", "code-2"));
    queue.enqueueSubtask(subtask("inference", "infer-1"));
    const claimed = queue.claim("gpu-container", undefined, undefined, (st) => agentMayClaim({ sandboxMode: "none" }, st));
    expect(claimed?.id).toBe("infer-1");
    expect(queue.claim("gpu-container", undefined, undefined, (st) => agentMayClaim({ sandboxMode: "none" }, st))).toBeUndefined();
    // The code work is still there for a sandboxed agent.
    expect(queue.claim("docker-vm", undefined, undefined, (st) => agentMayClaim({ sandboxMode: "docker" }, st))?.id).toBe("code-1");
  });

  it("the /pull handler applies the rule inside claim(), before every other eligibility check", () => {
    const src = readFileSync("src/swarm/coordinator/routes/tasks.ts", "utf8");
    expect(src).not.toContain("pullSandboxRejection");
    // The claim rule lives in dispatch.ts (shared with nudge targeting) and is applied inside claim().
    expect(src).toMatch(/const canTake = claimRule\(body\.agentId, capability, pullerAccount\);/);
    expect(src).toMatch(/\(subtask\) => canTake\(subtask\) && mayTakeNow\(/);
    const rule = readFileSync("src/swarm/coordinator/dispatch.ts", "utf8");
    expect(rule).toMatch(/return \(subtask\) => \{\s*if \(!agentMayClaim\(capability, subtask\)\) return false;/);
  });
});

describe("worker", () => {
  it("SANDBOX_MODE=none disables swarm execution (mesh, BLE, peer-direct code)", () => {
    expect(swarmExecutionEnabled("none")).toBe(false);
    expect(swarmExecutionEnabled("docker")).toBe(true);
    expect(swarmExecutionEnabled("vm")).toBe(true);
  });

  it("an inference-only agent refuses anything but inference, even if a coordinator sends it", () => {
    expect(inferenceOnlyRejection(true, { kind: "inference" })).toBeNull();
    expect(inferenceOnlyRejection(true, { kind: "single_step" })).toMatch(/^inference_only_agent:/);
    expect(inferenceOnlyRejection(true, { kind: "micro_loop" })).toMatch(/^inference_only_agent:/);
    expect(inferenceOnlyRejection(false, { kind: "single_step" })).toBeNull();
  });

  it("the worker checks the refusal before running a pulled subtask, and pulls only with a sandbox or inference-only", () => {
    const src = readFileSync("src/swarm/worker-runner.ts", "utf8");
    expect(src).toContain('const INFERENCE_ONLY = SANDBOX_MODE === "none" && W.AGENT_INFERENCE_ONLY === true;');
    expect(src).toContain("const PULLS_FROM_COORDINATOR = SWARM_EXECUTION_ENABLED || INFERENCE_ONLY;");
    const pulledAt = src.indexOf("if (pulled.subtask) {");
    const refusalAt = src.indexOf("inferenceOnlyRejection(INFERENCE_ONLY, st)", pulledAt);
    const runAt = src.indexOf("runPolicedSubtask(st", pulledAt);
    expect(pulledAt).toBeGreaterThan(0);
    expect(refusalAt).toBeGreaterThan(pulledAt);
    expect(runAt).toBeGreaterThan(refusalAt);
  });
});
