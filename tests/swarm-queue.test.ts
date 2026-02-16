import { describe, expect, it } from "vitest";
import { SwarmQueue } from "../src/swarm/queue.js";
import { ExecutionPolicy } from "../src/common/types.js";

const policy: ExecutionPolicy = {
  cpuCapPercent: 50,
  memoryLimitMb: 2048,
  idleOnly: true,
  maxConcurrentTasks: 1,
  allowedHours: {
    startHourUtc: 22,
    endHourUtc: 6
  }
};

describe("swarm queue", () => {
  it("enqueues and claims tasks", () => {
    const queue = new SwarmQueue();
    queue.registerAgent("a-1", policy);
    const created = queue.enqueueSubtask({
      taskId: "t-1",
      kind: "micro_loop",
      language: "python",
      input: "say hello",
      timeoutMs: 3000,
      snapshotRef: "commit:abc",
      projectMeta: {
        projectId: "p-1",
        resourceClass: "cpu",
        priority: 50
      }
    });
    const claimed = queue.claim("a-1");
    expect(claimed?.id).toBe(created.id);
  });

  it("tracks completion", () => {
    const queue = new SwarmQueue();
    queue.registerAgent("a-1", policy);
    const task = queue.enqueueSubtask({
      taskId: "t-1",
      kind: "micro_loop",
      language: "python",
      input: "work",
      timeoutMs: 3000,
      snapshotRef: "commit:abc",
      projectMeta: {
        projectId: "p-1",
        resourceClass: "cpu",
        priority: 50
      }
    });
    queue.claim("a-1");
    queue.complete({
      subtaskId: task.id,
      taskId: task.taskId,
      agentId: "a-1",
      ok: true,
      output: "done",
      durationMs: 120
    });
    expect(queue.status().queued).toBe(0);
    expect(queue.status().results).toBe(1);
  });

  it("supports fair-share scheduling across projects", () => {
    const queue = new SwarmQueue();
    queue.registerAgent("a-1", policy);
    queue.registerAgent("a-2", policy);

    const p1 = queue.enqueueSubtask({
      taskId: "t-1",
      kind: "micro_loop",
      language: "python",
      input: "p1",
      timeoutMs: 3000,
      snapshotRef: "commit:abc",
      projectMeta: { projectId: "project-a", resourceClass: "cpu", priority: 10 }
    });
    const p2 = queue.enqueueSubtask({
      taskId: "t-2",
      kind: "micro_loop",
      language: "python",
      input: "p2",
      timeoutMs: 3000,
      snapshotRef: "commit:abc",
      projectMeta: { projectId: "project-b", resourceClass: "cpu", priority: 10 }
    });

    const first = queue.claim("a-1");
    expect([p1.id, p2.id]).toContain(first?.id);
    if (!first) throw new Error("expected first claim");
    queue.complete({
      subtaskId: first.id,
      taskId: first.taskId,
      agentId: "a-1",
      ok: true,
      output: "done",
      durationMs: 120
    });

    // Remaining claim should select the other project for fairness.
    const second = queue.claim("a-2");
    expect(second?.projectMeta.projectId).not.toBe(first.projectMeta.projectId);
  });
});
