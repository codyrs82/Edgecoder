import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { SwarmQueue } from "../../src/swarm/queue.js";
import { ExecutionPolicy, Subtask, SubtaskResult } from "../../src/common/types.js";

// ── Shared helpers ──────────────────────────────────────────────────────

const defaultPolicy: ExecutionPolicy = {
  cpuCapPercent: 50,
  memoryLimitMb: 2048,
  idleOnly: true,
  maxConcurrentTasks: 1,
  allowedHours: { startHourUtc: 0, endHourUtc: 24 },
};

function makeSubtask(
  projectId: string,
  priority = 10
): Omit<Subtask, "id"> {
  return {
    taskId: randomUUID(),
    kind: "micro_loop",
    language: "python",
    input: `task for ${projectId}`,
    timeoutMs: 5000,
    snapshotRef: "commit:mesh-churn-test",
    projectMeta: { projectId, resourceClass: "cpu", priority },
  };
}

function makeResult(
  subtask: Subtask,
  agentId: string,
  ok: boolean,
  durationMs = 150
): SubtaskResult {
  return {
    subtaskId: subtask.id,
    taskId: subtask.taskId,
    agentId,
    ok,
    output: ok ? "done" : "",
    error: ok ? undefined : "simulated failure",
    durationMs,
  };
}

// ── Mesh Churn: Agent Departure & Arrival ───────────────────────────────

describe("Mesh Churn: Tasks redistributed when agent leaves", () => {
  let queue: SwarmQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new SwarmQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should redistribute tasks claimed by a departed agent to remaining agents", () => {
    // Register 3 agents
    queue.registerAgent("agent-A", defaultPolicy);
    queue.registerAgent("agent-B", defaultPolicy);
    queue.registerAgent("agent-C", defaultPolicy);

    // Enqueue 6 tasks
    const enqueued: Subtask[] = [];
    for (let i = 0; i < 6; i++) {
      enqueued.push(queue.enqueueSubtask(makeSubtask("proj-churn")));
    }
    expect(queue.status().queued).toBe(6);

    // Agent-B claims 2 tasks
    const claimedByB1 = queue.claim("agent-B");
    const claimedByB2 = queue.claim("agent-B");
    expect(claimedByB1).toBeDefined();
    expect(claimedByB2).toBeDefined();

    // 6 tasks still in queue (claimed but not completed)
    expect(queue.status().queued).toBe(6);

    // Simulate agent-B leaving: advance time so its claims go stale,
    // then requeue. SwarmQueue has no unregisterAgent method; the
    // mechanism for handling departed agents is requeueStale().
    vi.advanceTimersByTime(10_000);
    const requeued = queue.requeueStale(5_000);
    expect(requeued).toBe(2);

    // Remaining agents (A and C) should be able to pull all 6 tasks
    const claimedByRemaining: Subtask[] = [];
    for (let i = 0; i < 6; i++) {
      const agent = i % 2 === 0 ? "agent-A" : "agent-C";
      const task = queue.claim(agent);
      expect(task).toBeDefined();
      claimedByRemaining.push(task!);
      queue.complete(makeResult(task!, agent, true));
    }

    expect(claimedByRemaining).toHaveLength(6);
    expect(queue.status().queued).toBe(0);
    expect(queue.status().results).toBe(6);

    // Verify all 6 original task IDs were claimed by the remaining agents
    const originalIds = new Set(enqueued.map((t) => t.id));
    const claimedIds = new Set(claimedByRemaining.map((t) => t.id));
    expect(claimedIds).toEqual(originalIds);
  });
});

describe("Mesh Churn: New agent joining receives tasks", () => {
  let queue: SwarmQueue;

  beforeEach(() => {
    queue = new SwarmQueue();
  });

  it("should allow a newly joined agent to claim remaining tasks", () => {
    // Register agent-X and enqueue 4 tasks
    queue.registerAgent("agent-X", defaultPolicy);

    const enqueued: Subtask[] = [];
    for (let i = 0; i < 4; i++) {
      enqueued.push(queue.enqueueSubtask(makeSubtask("proj-join")));
    }
    expect(queue.status().queued).toBe(4);
    expect(queue.status().agents).toBe(1);

    // Agent-X claims and completes 2 tasks
    const claimedByX: Subtask[] = [];
    for (let i = 0; i < 2; i++) {
      const task = queue.claim("agent-X");
      expect(task).toBeDefined();
      claimedByX.push(task!);
      queue.complete(makeResult(task!, "agent-X", true));
    }

    expect(queue.status().queued).toBe(2);
    expect(queue.status().results).toBe(2);

    // Register agent-Y mid-flight
    queue.registerAgent("agent-Y", defaultPolicy);
    expect(queue.status().agents).toBe(2);

    // Agent-Y should be able to claim the remaining 2 tasks
    const claimedByY: Subtask[] = [];
    for (let i = 0; i < 2; i++) {
      const task = queue.claim("agent-Y");
      expect(task).toBeDefined();
      claimedByY.push(task!);
      queue.complete(makeResult(task!, "agent-Y", true));
    }

    expect(claimedByY).toHaveLength(2);
    expect(queue.status().queued).toBe(0);
    expect(queue.status().results).toBe(4);

    // Verify no tasks are left to claim
    const nothing = queue.claim("agent-Y");
    expect(nothing).toBeUndefined();

    // Verify the tasks agent-Y claimed are distinct from agent-X's
    const xIds = new Set(claimedByX.map((t) => t.id));
    const yIds = new Set(claimedByY.map((t) => t.id));
    for (const id of yIds) {
      expect(xIds.has(id)).toBe(false);
    }

    // All 4 original tasks accounted for
    const allClaimedIds = new Set([...claimedByX, ...claimedByY].map((t) => t.id));
    const originalIds = new Set(enqueued.map((t) => t.id));
    expect(allClaimedIds).toEqual(originalIds);
  });
});
