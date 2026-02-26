// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

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
  /** If set, local agents cannot claim this task until after this timestamp.
   *  Gives gossip peers a window to send task_claim before local execution. */
  claimableAfterMs?: number;
}

export class SwarmQueue {
  constructor(private readonly store?: PostgresStore | null) {}

  private readonly tasks: QueueItem[] = [];
  private readonly results: SubtaskResult[] = [];
  private readonly agents = new Map<string, AgentState>();
  private readonly projectCompleted = new Map<string, number>();
  /** Tracks how many tasks each agent has claimed, for round-robin fairness. */
  private readonly agentClaimCount = new Map<string, number>();

  registerAgent(
    agentId: string,
    policy: ExecutionPolicy,
    metadata?: { os: string; version: string; mode: string; localModelEnabled?: boolean; activeModel?: string; activeModelParamSize?: number }
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
        lastSeenMs: lastHeartbeat,
        activeModel: metadata?.activeModel,
        activeModelParamSize: metadata?.activeModelParamSize
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
        lastSeenMs: current.lastHeartbeat,
        activeModel: undefined,
        activeModelParamSize: undefined
      })
      .catch(() => undefined);
  }

  enqueueSubtask(subtask: Omit<Subtask, "id"> & { id?: string }, opts?: { claimDelayMs?: number }): Subtask {
    const materialized: Subtask = { ...subtask, id: subtask.id ?? randomUUID() };
    // Deduplicate — prevent same subtask from being enqueued twice via mesh gossip
    if (this.tasks.some(t => t.subtask.id === materialized.id)) {
      return materialized;
    }
    const claimableAfterMs = opts?.claimDelayMs ? Date.now() + opts.claimDelayMs : undefined;
    this.tasks.push({ subtask: materialized, claimableAfterMs });
    void this.store?.persistSubtask(materialized).catch(() => undefined);
    return materialized;
  }

  /** Remove an unclaimed task that was claimed by a peer coordinator via mesh gossip. */
  markRemoteClaimed(subtaskId: string): boolean {
    const idx = this.tasks.findIndex(t => t.subtask.id === subtaskId && !t.claimedBy);
    if (idx >= 0) {
      this.tasks.splice(idx, 1);
      return true;
    }
    return false;
  }

  claim(agentId: string, agentActiveModel?: string): Subtask | undefined {
    const now = Date.now();
    const unclaimed = this.tasks.filter(
      (task) => !task.claimedBy && (!task.claimableAfterMs || now >= task.claimableAfterMs)
    );
    if (unclaimed.length === 0) return undefined;

    // Partition into model-matching and non-matching
    const matching = agentActiveModel
      ? unclaimed.filter(t => t.subtask.requestedModel === agentActiveModel)
      : [];
    const pool = matching.length > 0 ? matching : unclaimed;

    // Fair-share: prefer projects with fewer completed results.
    let item = pool[0];
    for (const candidate of pool) {
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
    this.agentClaimCount.set(agentId, (this.agentClaimCount.get(agentId) ?? 0) + 1);
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

  /** Requeue a single subtask by clearing its claim so it becomes available again. */
  requeue(subtaskId: string): boolean {
    const item = this.tasks.find((t) => t.subtask.id === subtaskId);
    if (!item) return false;
    item.claimedBy = undefined;
    item.claimedAt = undefined;
    return true;
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

  agentClaims(agentId: string): number {
    return this.agentClaimCount.get(agentId) ?? 0;
  }

  status(): { queued: number; agents: number; results: number } {
    return {
      queued: this.tasks.length,
      agents: this.agents.size,
      results: this.results.length
    };
  }
}
