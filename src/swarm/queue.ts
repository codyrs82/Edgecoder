import { randomUUID } from "node:crypto";
import { ExecutionPolicy, Subtask, SubtaskResult } from "../common/types.js";
import { PostgresStore } from "../db/postgres.js";

interface AgentState {
  agentId: string;
  policy: ExecutionPolicy;
  lastHeartbeat: number;
}

interface QueueItem {
  subtask: Subtask;
  claimedBy?: string;
  claimedAt?: number;
}

export class SwarmQueue {
  constructor(private readonly store?: PostgresStore | null) {}

  private readonly tasks: QueueItem[] = [];
  private readonly results: SubtaskResult[] = [];
  private readonly agents = new Map<string, AgentState>();
  private readonly projectCompleted = new Map<string, number>();

  registerAgent(
    agentId: string,
    policy: ExecutionPolicy,
    metadata?: { os: string; version: string; mode: string; localModelEnabled?: boolean }
  ): void {
    const lastHeartbeat = Date.now();
    this.agents.set(agentId, { agentId, policy, lastHeartbeat });
    void this.store
      ?.upsertAgent({
        agentId,
        os: metadata?.os ?? "unknown",
        version: metadata?.version ?? "unknown",
        mode: metadata?.mode ?? "swarm-only",
        localModelEnabled: metadata?.localModelEnabled ?? false,
        lastSeenMs: lastHeartbeat
      })
      .catch(() => undefined);
  }

  heartbeat(agentId: string): void {
    const current = this.agents.get(agentId);
    if (!current) return;
    current.lastHeartbeat = Date.now();
    this.agents.set(agentId, current);
    void this.store
      ?.upsertAgent({
        agentId,
        os: "unknown",
        version: "unknown",
        mode: "swarm-only",
        localModelEnabled: false,
        lastSeenMs: current.lastHeartbeat
      })
      .catch(() => undefined);
  }

  enqueueSubtask(subtask: Omit<Subtask, "id">): Subtask {
    const materialized: Subtask = { ...subtask, id: randomUUID() };
    this.tasks.push({ subtask: materialized });
    void this.store?.persistSubtask(materialized).catch(() => undefined);
    return materialized;
  }

  claim(agentId: string): Subtask | undefined {
    const unclaimed = this.tasks.filter((task) => !task.claimedBy);
    if (unclaimed.length === 0) return undefined;

    // Fair-share: prefer projects with fewer completed results.
    let item = unclaimed[0];
    for (const candidate of unclaimed) {
      const currentProject = item.subtask.projectMeta.projectId;
      const candidateProject = candidate.subtask.projectMeta.projectId;
      const currentCount = this.projectCompleted.get(currentProject) ?? 0;
      const candidateCount = this.projectCompleted.get(candidateProject) ?? 0;
      const currentPriority = item.subtask.projectMeta.priority;
      const candidatePriority = candidate.subtask.projectMeta.priority;

      if (candidateCount < currentCount) {
        item = candidate;
      } else if (candidateCount === currentCount && candidatePriority > currentPriority) {
        item = candidate;
      }
    }

    if (!item) return undefined;
    item.claimedBy = agentId;
    item.claimedAt = Date.now();
    void this.store?.markSubtaskClaimed(item.subtask.id, agentId, item.claimedAt).catch(() => undefined);
    return item.subtask;
  }

  complete(result: SubtaskResult): void {
    this.results.push(result);
    void this.store?.persistResult(result).catch(() => undefined);
    const index = this.tasks.findIndex((task) => task.subtask.id === result.subtaskId);
    if (index >= 0) {
      const projectId = this.tasks[index].subtask.projectMeta.projectId;
      this.projectCompleted.set(projectId, (this.projectCompleted.get(projectId) ?? 0) + 1);
      this.tasks.splice(index, 1);
    }
  }

  getSubtask(subtaskId: string): Subtask | undefined {
    const item = this.tasks.find((task) => task.subtask.id === subtaskId);
    return item?.subtask;
  }

  requeueStale(claimTimeoutMs: number): number {
    const now = Date.now();
    let count = 0;
    for (const item of this.tasks) {
      if (item.claimedBy && item.claimedAt && now - item.claimedAt > claimTimeoutMs) {
        item.claimedBy = undefined;
        item.claimedAt = undefined;
        count += 1;
      }
    }
    return count;
  }

  status(): { queued: number; agents: number; results: number } {
    return {
      queued: this.tasks.length,
      agents: this.agents.size,
      results: this.results.length
    };
  }
}
