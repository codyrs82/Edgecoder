import type { Subtask } from "../common/types.js";

// ── Subtask dependency tracking ─────────────────────────────────────────────

/**
 * Holds a subtask that cannot be enqueued yet because it depends on other
 * subtasks that have not completed.
 */
export interface PendingDependentSubtask {
  subtask: Omit<Subtask, "id"> & { id: string };
  dependsOn: string[];
  enqueueOpts?: { claimDelayMs?: number };
}

/**
 * Manages the lifecycle of subtask dependencies: holding subtasks until their
 * dependencies complete, injecting context from completed deps, and releasing
 * them into the queue.
 */
export class SubtaskDepTracker {
  /** Subtasks waiting for their dependencies to be satisfied. Keyed by subtask ID. */
  readonly pending = new Map<string, PendingDependentSubtask>();

  /** Output strings from completed subtasks, used for context injection. Keyed by subtask ID. */
  readonly completedOutputs = new Map<string, string>();

  /**
   * Detect circular dependencies among a set of subtasks.
   * Returns the IDs that participate in a cycle (empty set = no cycles).
   */
  detectCircularDeps(subtasks: Array<{ id: string; dependsOn?: string[] }>): Set<string> {
    const graph = new Map<string, string[]>();
    const ids = new Set<string>();
    for (const s of subtasks) {
      graph.set(s.id, (s.dependsOn ?? []).filter((d) => d !== s.id));
      ids.add(s.id);
    }

    const cycleNodes = new Set<string>();

    // Check self-loops
    for (const s of subtasks) {
      if (s.dependsOn?.includes(s.id)) {
        cycleNodes.add(s.id);
      }
    }

    // For each node, check if it can reach itself through the graph
    // (i.e., it participates in a cycle).
    for (const startId of ids) {
      if (cycleNodes.has(startId)) continue; // already known
      const visited = new Set<string>();
      const stack = [...(graph.get(startId) ?? [])];
      let reachesSelf = false;
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === startId) {
          reachesSelf = true;
          break;
        }
        if (visited.has(current) || !ids.has(current)) continue;
        visited.add(current);
        for (const dep of graph.get(current) ?? []) {
          stack.push(dep);
        }
      }
      if (reachesSelf) {
        cycleNodes.add(startId);
      }
    }

    return cycleNodes;
  }

  /**
   * Build a context string from completed dependency outputs to prepend to a
   * dependent subtask's input.
   */
  buildDependencyContext(depIds: string[]): string {
    const lines: string[] = [];
    for (let i = 0; i < depIds.length; i++) {
      const output = this.completedOutputs.get(depIds[i]);
      if (output !== undefined) {
        lines.push(`Subtask ${i + 1} result: ${output}`);
      }
    }
    if (lines.length === 0) return "";
    return `[Context from previous subtasks]\n${lines.join("\n")}\n\n[Your task]\n`;
  }

  /**
   * Record the output of a completed subtask and return any pending subtasks
   * whose dependencies are now fully satisfied (with context injected).
   */
  recordCompletionAndRelease(
    completedSubtaskId: string,
    output: string,
    enqueueFn: (subtask: Omit<Subtask, "id"> & { id: string }, opts?: { claimDelayMs?: number }) => Subtask
  ): Subtask[] {
    this.completedOutputs.set(completedSubtaskId, output);

    const released: Subtask[] = [];
    for (const [id, entry] of this.pending) {
      const allMet = entry.dependsOn.every((dep) => this.completedOutputs.has(dep));
      if (!allMet) continue;

      const context = this.buildDependencyContext(entry.dependsOn);
      const enrichedSubtask = {
        ...entry.subtask,
        input: context + entry.subtask.input,
      };

      this.pending.delete(id);
      const enqueued = enqueueFn(enrichedSubtask, entry.enqueueOpts);
      released.push(enqueued);
    }
    return released;
  }

  /**
   * Add a subtask to the pending map (it will be held until its deps complete).
   */
  hold(entry: PendingDependentSubtask): void {
    this.pending.set(entry.subtask.id, entry);
  }
}
