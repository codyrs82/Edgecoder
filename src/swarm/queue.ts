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

/**
 * #51: claim leases. A claim stays valid while BOTH hold:
 * - hard deadline: claimedAt + subtask.timeoutMs + graceMs (a task can't outlive its timeout);
 * - liveness: the claimant heartbeated within livenessMs (workers heartbeat while executing).
 * An expired claim is requeued; after maxAttempts claims the subtask fails instead.
 * Results from a holder whose lease expired are rejected.
 */
export interface LeaseConfig {
  graceMs: number;
  livenessMs: number;
  maxAttempts: number;
  /** Server-side cap on a subtask's timeoutMs for lease purposes, so a huge submitted timeout can't pin a claim. */
  maxTimeoutMs: number;
}

export const DEFAULT_LEASE: LeaseConfig = { graceMs: 30_000, livenessMs: 45_000, maxAttempts: 3, maxTimeoutMs: 30 * 60_000 };

export function leaseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LeaseConfig {
  const num = (v: string | undefined, d: number, min: number) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) && n >= min ? Math.floor(n) : d;
  };
  return {
    graceMs: num(env.CLAIM_LEASE_GRACE_MS, DEFAULT_LEASE.graceMs, 0),
    livenessMs: num(env.CLAIM_LEASE_LIVENESS_MS, DEFAULT_LEASE.livenessMs, 1_000),
    maxAttempts: num(env.CLAIM_MAX_ATTEMPTS, DEFAULT_LEASE.maxAttempts, 1),
    maxTimeoutMs: num(env.CLAIM_MAX_TIMEOUT_MS, DEFAULT_LEASE.maxTimeoutMs, 1_000)
  };
}

export interface LeaseExpiry {
  requeued: string[];
  failed: string[];
}

const MAX_TRACKED_EXPIRED = 10_000;

interface QueueItem {
  subtask: Subtask;
  claimedBy?: string;
  claimedAt?: number;
  /** #51: last heartbeat from the claimant while holding the lease. */
  leaseRenewedAt?: number;
  /** #51: number of times this subtask has been claimed. */
  attempts?: number;
  /** If set, local agents cannot claim this task until after this timestamp.
   *  Gives gossip peers a window to send task_claim before local execution. */
  claimableAfterMs?: number;
  /** #50: agents that may not claim this item (verification replicas go to a different agent). */
  excludeAgents?: string[];
  /** #50: reward accounts that may not claim this item (same operator, different agent id). */
  excludeAccounts?: string[];
}

export class SwarmQueue {
  private readonly lease: LeaseConfig;
  constructor(private readonly store?: PostgresStore | null, lease: Partial<LeaseConfig> = {}) {
    this.lease = { ...DEFAULT_LEASE, ...lease };
  }

  /**
   * #51: called once for every subtask failed at the retry cap, whichever caller
   * triggered expiry, so the coordinator can finalize it (fail dependents, refund).
   * #99: attempts and expired holders are also written to Postgres (queue_tasks.attempts,
   * queue_expired_holders), so a re-enqueued subtask keeps its retry count after a restart and a
   * late result from an expired holder is rejected by any coordinator on the same database.
   */
  private leaseFailureListener?: (result: SubtaskResult) => void;

  onLeaseFailure(listener: (result: SubtaskResult) => void): void {
    this.leaseFailureListener = listener;
  }

  /** #51: subtaskId -> agents whose lease on it expired (their late results are rejected). */
  private readonly expiredHolders = new Map<string, Set<string>>();

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
    this.renewLeases(agentId, current.lastHeartbeat);
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

  enqueueSubtask(
    subtask: Omit<Subtask, "id"> & { id?: string },
    opts?: { claimDelayMs?: number; excludeAgents?: string[]; excludeAccounts?: string[] }
  ): Subtask {
    const materialized: Subtask = { ...subtask, id: subtask.id ?? randomUUID() };
    // Deduplicate — prevent same subtask from being enqueued twice via mesh gossip
    if (this.tasks.some(t => t.subtask.id === materialized.id)) {
      return materialized;
    }
    const claimableAfterMs = opts?.claimDelayMs ? Date.now() + opts.claimDelayMs : undefined;
    const excludeAgents = opts?.excludeAgents?.length ? [...opts.excludeAgents] : undefined;
    const excludeAccounts = opts?.excludeAccounts?.length ? [...opts.excludeAccounts] : undefined;
    const item: QueueItem = { subtask: materialized, claimableAfterMs, excludeAgents, excludeAccounts };
    this.tasks.push(item);
    this.persist(materialized.id, async (store) => {
      await store.persistSubtask(materialized);
      this.mergeLeaseState(item, await store.getSubtaskLeaseState(materialized.id));
    });
    return materialized;
  }

  /** #99: per-subtask tail of store writes, so a claim and its expiry reach Postgres in order. */
  private readonly persistTails = new Map<string, Promise<void>>();

  /** Fire-and-forget store write, ordered after earlier writes for the same subtask. */
  private persist(subtaskId: string, write: (store: PostgresStore) => Promise<unknown>): void {
    const store = this.store;
    if (!store) return;
    const tail = (this.persistTails.get(subtaskId) ?? Promise.resolve())
      .then(() => write(store))
      .then(() => undefined, () => undefined);
    this.persistTails.set(subtaskId, tail);
    void tail.then(() => {
      if (this.persistTails.get(subtaskId) === tail) this.persistTails.delete(subtaskId);
    });
  }

  /**
   * #99: fold persisted lease state into a (re-)enqueued item: the retry count never goes down,
   * and agents whose lease on it expired before a restart stay barred (unless one holds it now).
   */
  private mergeLeaseState(item: QueueItem, state: { attempts: number; expiredHolders: string[] }): void {
    if (state.attempts > (item.attempts ?? 0)) item.attempts = state.attempts;
    for (const agentId of state.expiredHolders) {
      if (agentId !== item.claimedBy) this.markExpired(item.subtask.id, agentId);
    }
  }

  /**
   * #50: take a claimed item off the queue without publishing a result. Used for
   * results held for verification: the requester-visible result is recorded with
   * complete() once the verdict is in.
   */
  removeHeld(subtaskId: string): boolean {
    const idx = this.tasks.findIndex((t) => t.subtask.id === subtaskId);
    if (idx < 0) return false;
    this.tasks.splice(idx, 1);
    return true;
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

  /** `accountId` = the agent's reward account (defaults to agentId), for #50 replica exclusion. */
  claim(
    agentId: string,
    agentActiveModel?: string,
    accountId: string = agentId,
    /** Market gate: return false when the agent's ask is above the task's bid or the class doesn't match. */
    canTake?: (subtask: Subtask) => boolean
  ): Subtask | undefined {
    const now = Date.now();
    this.expireLeases(now);
    const unclaimed = this.tasks.filter(
      (task) =>
        !task.claimedBy &&
        (!task.claimableAfterMs || now >= task.claimableAfterMs) &&
        !task.excludeAgents?.includes(agentId) &&
        !task.excludeAccounts?.includes(accountId) &&
        (!canTake || canTake(task.subtask))
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
    item.leaseRenewedAt = item.claimedAt;
    item.attempts = (item.attempts ?? 0) + 1;
    this.expiredHolders.get(item.subtask.id)?.delete(agentId);
    this.agentClaimCount.set(agentId, (this.agentClaimCount.get(agentId) ?? 0) + 1);
    const { claimedAt, attempts } = item;
    this.persist(item.subtask.id, (store) => store.markSubtaskClaimed(item.subtask.id, agentId, claimedAt, attempts));
    return item.subtask;
  }

  /** Subtasks of a task still queued or running (0 once every subtask has a result or was removed). */
  openSubtaskCount(taskId: string): number {
    return this.tasks.reduce((n, t) => n + (t.subtask.taskId === taskId ? 1 : 0), 0);
  }

  /** Requester-visible result for a subtask (the latest one recorded), or undefined while it is still queued/running. */
  getResult(subtaskId: string): SubtaskResult | undefined {
    for (let i = this.results.length - 1; i >= 0; i--) {
      if (this.results[i].subtaskId === subtaskId) return this.results[i];
    }
    return undefined;
  }

  complete(result: SubtaskResult): void {
    this.results.push(result);
    this.persist(result.subtaskId, (store) => store.persistResult(result));
    const index = this.tasks.findIndex((task) => task.subtask.id === result.subtaskId);
    if (index >= 0) {
      const projectId = this.tasks[index].subtask.projectMeta.projectId;
      this.projectCompleted.set(projectId, (this.projectCompleted.get(projectId) ?? 0) + 1);
      this.tasks.splice(index, 1);
    }
  }

  /** #44: current claim record for a queued subtask (undefined once completed/removed). */
  getClaim(subtaskId: string): { subtask: Subtask; claimedBy?: string; claimedAt?: number } | undefined {
    this.expireLeases();
    const item = this.tasks.find((t) => t.subtask.id === subtaskId);
    return item && { subtask: item.subtask, claimedBy: item.claimedBy, claimedAt: item.claimedAt };
  }

  getSubtask(subtaskId: string): Subtask | undefined {
    const item = this.tasks.find((task) => task.subtask.id === subtaskId);
    return item?.subtask;
  }

  /**
   * Requeue a single subtask by clearing its claim so it becomes available again.
   * Used when the coordinator itself hands a claim back (e.g. power policy), so it
   * doesn't count against the retry cap. Coordinator-side only: never call this
   * from a worker-triggered path, or a broken worker could bounce a task forever.
   */
  requeue(subtaskId: string): boolean {
    const item = this.tasks.find((t) => t.subtask.id === subtaskId);
    if (!item) return false;
    const wasClaimed = Boolean(item.claimedBy);
    if (item.claimedBy && item.attempts) item.attempts -= 1;
    item.claimedBy = undefined;
    item.claimedAt = undefined;
    item.leaseRenewedAt = undefined;
    const attempts = item.attempts ?? 0;
    if (wasClaimed) this.persist(subtaskId, (store) => store.markSubtaskReleased(subtaskId, attempts));
    return true;
  }

  /** #51: lease deadline for a claimed item (ms epoch). */
  private leaseDeadline(item: QueueItem): number {
    const claimedAt = item.claimedAt ?? 0;
    const timeout = Number.isFinite(item.subtask.timeoutMs) && item.subtask.timeoutMs > 0
      ? Math.min(item.subtask.timeoutMs, this.lease.maxTimeoutMs)
      : 0;
    const hard = claimedAt + timeout + this.lease.graceMs;
    const live = (item.leaseRenewedAt ?? claimedAt) + this.lease.livenessMs;
    return Math.min(hard, live);
  }

  /** #51: heartbeat from a claimant keeps its (unexpired) leases alive. */
  private renewLeases(agentId: string, now: number): void {
    this.expireLeases(now);
    for (const item of this.tasks) {
      if (item.claimedBy === agentId) item.leaseRenewedAt = now;
    }
  }

  private markExpired(subtaskId: string, agentId: string): void {
    let set = this.expiredHolders.get(subtaskId);
    if (!set) {
      if (this.expiredHolders.size >= MAX_TRACKED_EXPIRED) {
        const oldest = this.expiredHolders.keys().next().value;
        if (oldest !== undefined) this.expiredHolders.delete(oldest);
      }
      set = new Set();
      this.expiredHolders.set(subtaskId, set);
    }
    set.add(agentId);
  }

  /** #51: true if `agentId` held a lease on `subtaskId` that expired (late result). */
  leaseExpiredFor(subtaskId: string, agentId: string): boolean {
    this.expireLeases();
    return this.expiredHolders.get(subtaskId)?.has(agentId) ?? false;
  }

  /**
   * #99: leaseExpiredFor, plus the expired holders persisted in Postgres (recorded before a restart
   * or by another coordinator on the same database). The current claimant is never "expired". A
   * store error falls back to the in-memory answer; the #44 claimant check still runs after this.
   */
  async leaseExpiredForDurable(subtaskId: string, agentId: string): Promise<boolean> {
    if (this.leaseExpiredFor(subtaskId, agentId)) return true;
    if (!this.store) return false;
    const current = this.tasks.find((t) => t.subtask.id === subtaskId);
    if (current?.claimedBy === agentId) return false;
    try {
      return await this.store.isExpiredLeaseHolder(subtaskId, agentId);
    } catch {
      return false;
    }
  }

  /**
   * #51: requeue claims whose lease expired; fail subtasks that hit maxAttempts
   * (recorded as a failed result from the coordinator).
   */
  expireLeases(now = Date.now()): LeaseExpiry {
    const requeued: string[] = [];
    const failed: string[] = [];
    for (let i = this.tasks.length - 1; i >= 0; i -= 1) {
      const item = this.tasks[i];
      if (!item.claimedBy || now <= this.leaseDeadline(item)) continue;
      const holder = item.claimedBy;
      this.markExpired(item.subtask.id, holder);
      item.claimedBy = undefined;
      item.claimedAt = undefined;
      item.leaseRenewedAt = undefined;
      const atCap = (item.attempts ?? 0) >= this.lease.maxAttempts;
      // #99: a subtask failed at the cap is done (its result row clears the holder rows), so only a
      // requeued one records the expired holder durably.
      const attempts = item.attempts ?? 0;
      this.persist(item.subtask.id, (store) =>
        store.markSubtaskReleased(item.subtask.id, attempts, atCap ? undefined : { agentId: holder, atMs: now })
      );
      if (atCap) {
        this.tasks.splice(i, 1);
        const result: SubtaskResult = {
          subtaskId: item.subtask.id,
          taskId: item.subtask.taskId,
          agentId: "coordinator",
          ok: false,
          output: "",
          error: `lease_expired_max_attempts:${item.attempts}`,
          durationMs: 0
        };
        this.results.push(result);
        this.persist(result.subtaskId, (store) => store.persistResult(result));
        failed.push(item.subtask.id);
        try {
          this.leaseFailureListener?.(result);
        } catch {
          // finalize errors must not break lease bookkeeping
        }
      } else {
        requeued.push(item.subtask.id);
      }
    }
    return { requeued, failed };
  }

  /** @deprecated #51: fixed-age requeue kept for harness tests; the coordinator uses expireLeases(). */
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
