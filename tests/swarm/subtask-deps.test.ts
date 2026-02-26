import { describe, it, expect, beforeEach, vi } from "vitest";
import { SubtaskDepTracker } from "../../src/swarm/subtask-deps.js";
import type { Subtask } from "../../src/common/types.js";

function makeSubtask(overrides: Partial<Subtask> & { id: string }): Omit<Subtask, "id"> & { id: string } {
  return {
    taskId: "task-1",
    kind: "single_step",
    language: "python",
    input: "do something",
    timeoutMs: 30_000,
    snapshotRef: "snap-1",
    projectMeta: { projectId: "proj-1", resourceClass: "cpu", priority: 50 },
    ...overrides,
  };
}

/**
 * Fake enqueue function that records calls and returns the subtask as a Subtask.
 */
function createMockEnqueue() {
  const calls: Array<{ subtask: Omit<Subtask, "id"> & { id: string }; opts?: { claimDelayMs?: number } }> = [];
  const fn = (subtask: Omit<Subtask, "id"> & { id: string }, opts?: { claimDelayMs?: number }): Subtask => {
    calls.push({ subtask, opts });
    return subtask as Subtask;
  };
  return { fn, calls };
}

describe("SubtaskDepTracker", () => {
  let tracker: SubtaskDepTracker;

  beforeEach(() => {
    tracker = new SubtaskDepTracker();
  });

  // ── Test 1: Subtasks without dependencies are enqueued immediately ──────

  describe("subtasks without dependencies", () => {
    it("are never held in the pending map", () => {
      // The tracker only deals with subtasks that HAVE dependencies.
      // Subtasks without deps should be enqueued directly (coordinator does
      // this without calling tracker.hold).  Verify that the tracker's
      // pending map stays empty when we only record completions.

      const enqueue = createMockEnqueue();
      const released = tracker.recordCompletionAndRelease("s1", "output-1", enqueue.fn);

      expect(tracker.pending.size).toBe(0);
      expect(released).toHaveLength(0);
    });

    it("does not interfere with independent subtask flow", () => {
      // Simulates coordinator flow: subtasks A and B have no deps, so they
      // are enqueued by the coordinator directly.  The tracker should not
      // affect them at all.
      const enqueue = createMockEnqueue();

      // Complete A
      const releasedA = tracker.recordCompletionAndRelease("a", "result-a", enqueue.fn);
      expect(releasedA).toHaveLength(0);

      // Complete B
      const releasedB = tracker.recordCompletionAndRelease("b", "result-b", enqueue.fn);
      expect(releasedB).toHaveLength(0);

      // No pending, no spurious enqueues
      expect(enqueue.calls).toHaveLength(0);
    });
  });

  // ── Test 2: Subtasks with dependencies are held until deps complete ─────

  describe("subtasks with dependencies", () => {
    it("are held in pending and not released until dependency completes", () => {
      const enqueue = createMockEnqueue();

      // Hold subtask B which depends on A
      tracker.hold({
        subtask: makeSubtask({ id: "b", input: "update call sites" }),
        dependsOn: ["a"],
      });

      expect(tracker.pending.size).toBe(1);

      // Complete some unrelated subtask — B should stay pending
      tracker.recordCompletionAndRelease("x", "unrelated", enqueue.fn);
      expect(tracker.pending.size).toBe(1);
      expect(enqueue.calls).toHaveLength(0);

      // Now complete A — B should be released
      const released = tracker.recordCompletionAndRelease("a", "added field X", enqueue.fn);
      expect(released).toHaveLength(1);
      expect(released[0].id).toBe("b");
      expect(tracker.pending.size).toBe(0);
    });

    it("preserves enqueueOpts when releasing", () => {
      const enqueue = createMockEnqueue();
      const opts = { claimDelayMs: 3000 };

      tracker.hold({
        subtask: makeSubtask({ id: "b" }),
        dependsOn: ["a"],
        enqueueOpts: opts,
      });

      tracker.recordCompletionAndRelease("a", "done", enqueue.fn);
      expect(enqueue.calls).toHaveLength(1);
      expect(enqueue.calls[0].opts).toEqual(opts);
    });
  });

  // ── Test 3: Context from completed deps is injected into dependent subtask input ──

  describe("context injection", () => {
    it("prepends context from a single dependency", () => {
      const enqueue = createMockEnqueue();

      tracker.hold({
        subtask: makeSubtask({ id: "b", input: "update call sites" }),
        dependsOn: ["a"],
      });

      tracker.recordCompletionAndRelease("a", "struct Foo { bar: i32 }", enqueue.fn);

      expect(enqueue.calls).toHaveLength(1);
      const enrichedInput = enqueue.calls[0].subtask.input;
      expect(enrichedInput).toContain("[Context from previous subtasks]");
      expect(enrichedInput).toContain("Subtask 1 result: struct Foo { bar: i32 }");
      expect(enrichedInput).toContain("[Your task]");
      expect(enrichedInput).toContain("update call sites");
    });

    it("prepends context from multiple dependencies in order", () => {
      const enqueue = createMockEnqueue();

      tracker.hold({
        subtask: makeSubtask({ id: "c", input: "write tests" }),
        dependsOn: ["a", "b"],
      });

      // Complete A first
      tracker.recordCompletionAndRelease("a", "output-a", enqueue.fn);
      expect(enqueue.calls).toHaveLength(0); // not all deps met

      // Complete B
      tracker.recordCompletionAndRelease("b", "output-b", enqueue.fn);
      expect(enqueue.calls).toHaveLength(1);

      const enrichedInput = enqueue.calls[0].subtask.input;
      expect(enrichedInput).toContain("Subtask 1 result: output-a");
      expect(enrichedInput).toContain("Subtask 2 result: output-b");
      // The original input should come after the context block
      const contextEnd = enrichedInput.indexOf("[Your task]");
      const originalStart = enrichedInput.indexOf("write tests");
      expect(contextEnd).toBeLessThan(originalStart);
    });

    it("builds correct context string via buildDependencyContext", () => {
      tracker.completedOutputs.set("d1", "first output");
      tracker.completedOutputs.set("d2", "second output");

      const ctx = tracker.buildDependencyContext(["d1", "d2"]);
      expect(ctx).toBe(
        "[Context from previous subtasks]\nSubtask 1 result: first output\nSubtask 2 result: second output\n\n[Your task]\n"
      );
    });

    it("returns empty string when no outputs found", () => {
      const ctx = tracker.buildDependencyContext(["nonexistent"]);
      expect(ctx).toBe("");
    });
  });

  // ── Test 4: Multiple dependencies (all must complete before release) ────

  describe("multiple dependencies", () => {
    it("waits for ALL dependencies before releasing", () => {
      const enqueue = createMockEnqueue();

      tracker.hold({
        subtask: makeSubtask({ id: "d", input: "final step" }),
        dependsOn: ["a", "b", "c"],
      });

      tracker.recordCompletionAndRelease("a", "out-a", enqueue.fn);
      expect(enqueue.calls).toHaveLength(0);
      expect(tracker.pending.size).toBe(1);

      tracker.recordCompletionAndRelease("b", "out-b", enqueue.fn);
      expect(enqueue.calls).toHaveLength(0);
      expect(tracker.pending.size).toBe(1);

      tracker.recordCompletionAndRelease("c", "out-c", enqueue.fn);
      expect(enqueue.calls).toHaveLength(1);
      expect(tracker.pending.size).toBe(0);
      expect(enqueue.calls[0].subtask.id).toBe("d");
    });

    it("can release multiple independent dependents when a shared dep completes", () => {
      const enqueue = createMockEnqueue();

      // Both B and C depend on A
      tracker.hold({
        subtask: makeSubtask({ id: "b", input: "task-b" }),
        dependsOn: ["a"],
      });
      tracker.hold({
        subtask: makeSubtask({ id: "c", input: "task-c" }),
        dependsOn: ["a"],
      });

      expect(tracker.pending.size).toBe(2);

      const released = tracker.recordCompletionAndRelease("a", "out-a", enqueue.fn);
      expect(released).toHaveLength(2);
      expect(tracker.pending.size).toBe(0);
      const releasedIds = released.map((r) => r.id).sort();
      expect(releasedIds).toEqual(["b", "c"]);
    });

    it("handles a chain: A -> B -> C", () => {
      const enqueue = createMockEnqueue();

      tracker.hold({
        subtask: makeSubtask({ id: "b", input: "step-b" }),
        dependsOn: ["a"],
      });
      tracker.hold({
        subtask: makeSubtask({ id: "c", input: "step-c" }),
        dependsOn: ["b"],
      });

      // Complete A -> releases B
      const r1 = tracker.recordCompletionAndRelease("a", "out-a", enqueue.fn);
      expect(r1).toHaveLength(1);
      expect(r1[0].id).toBe("b");

      // Complete B -> releases C (B was just enqueued, now "completes")
      const r2 = tracker.recordCompletionAndRelease("b", "out-b", enqueue.fn);
      expect(r2).toHaveLength(1);
      expect(r2[0].id).toBe("c");

      // Context for C should include B's output
      const cInput = enqueue.calls[1].subtask.input;
      expect(cInput).toContain("Subtask 1 result: out-b");
      expect(cInput).toContain("step-c");
    });
  });

  // ── Test 5: Circular dependency detection ───────────────────────────────

  describe("circular dependency detection", () => {
    it("detects a simple A <-> B cycle", () => {
      const cycleIds = tracker.detectCircularDeps([
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
      ]);
      expect(cycleIds.size).toBeGreaterThan(0);
      expect(cycleIds.has("a")).toBe(true);
      expect(cycleIds.has("b")).toBe(true);
    });

    it("detects a three-node cycle A -> B -> C -> A", () => {
      const cycleIds = tracker.detectCircularDeps([
        { id: "a", dependsOn: ["c"] },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["b"] },
      ]);
      expect(cycleIds.size).toBe(3);
    });

    it("returns empty set when there are no cycles", () => {
      const cycleIds = tracker.detectCircularDeps([
        { id: "a", dependsOn: [] },
        { id: "b", dependsOn: ["a"] },
        { id: "c", dependsOn: ["a", "b"] },
      ]);
      expect(cycleIds.size).toBe(0);
    });

    it("only flags nodes in the cycle, not innocent bystanders", () => {
      // D depends on A (innocent), A and B form a cycle
      const cycleIds = tracker.detectCircularDeps([
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
        { id: "d", dependsOn: ["a"] },
      ]);
      // A and B are in the cycle
      expect(cycleIds.has("a")).toBe(true);
      expect(cycleIds.has("b")).toBe(true);
      // D is NOT in a cycle — it just depends on a node that is
      expect(cycleIds.has("d")).toBe(false);
    });

    it("handles self-referencing node", () => {
      const cycleIds = tracker.detectCircularDeps([
        { id: "a", dependsOn: ["a"] },
        { id: "b", dependsOn: [] },
      ]);
      expect(cycleIds.has("a")).toBe(true);
      expect(cycleIds.has("b")).toBe(false);
    });

    it("handles subtasks with no dependsOn field", () => {
      const cycleIds = tracker.detectCircularDeps([
        { id: "a" },
        { id: "b", dependsOn: ["a"] },
      ]);
      expect(cycleIds.size).toBe(0);
    });
  });
});
