// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import { computeIntentFee } from "./coordinator-utils.js";
import type {
  RobotAgent,
  RobotTask,
  RobotTaskKind,
  RobotEarningsEntry,
  RobotSweepPayout,
  RobotQueueConfig
} from "./robot-types.js";

export class RobotQueue {
  private readonly config: RobotQueueConfig;
  private readonly agents = new Map<string, RobotAgent>();
  private readonly tasks = new Map<string, RobotTask>();
  private readonly earnings: RobotEarningsEntry[] = [];

  constructor(config: RobotQueueConfig) {
    this.config = config;
  }

  registerAgent(input: {
    agentId: string;
    payoutAddress: string;
    capabilities: string[];
    robotKind: string;
  }): RobotAgent {
    if (!input.payoutAddress) throw new Error("payout_address_required");
    const existing = this.agents.get(input.agentId);
    const agent: RobotAgent = {
      agentId: input.agentId,
      payoutAddress: input.payoutAddress,
      capabilities: input.capabilities,
      robotKind: input.robotKind,
      lastSeenMs: Date.now(),
      successCount: existing?.successCount ?? 0,
      failureCount: existing?.failureCount ?? 0
    };
    this.agents.set(input.agentId, agent);
    return agent;
  }

  getAgent(agentId: string): RobotAgent | undefined {
    return this.agents.get(agentId);
  }

  heartbeat(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) agent.lastSeenMs = Date.now();
  }

  createTask(input: {
    clientAccountId: string;
    title: string;
    description: string;
    taskKind: RobotTaskKind;
    resourceRequirements: string[];
    amountSats: number;
    invoiceRef: string;
    timeoutMs?: number;
    proofSchema?: Record<string, unknown>;
  }): RobotTask {
    const { feeSats, netSats } = computeIntentFee(input.amountSats, this.config.coordinatorFeeBps);
    const task: RobotTask = {
      taskId: randomUUID(),
      clientAccountId: input.clientAccountId,
      title: input.title,
      description: input.description,
      taskKind: input.taskKind,
      resourceRequirements: input.resourceRequirements,
      escrowSats: input.amountSats,
      rewardSats: netSats,
      coordinatorFeeSats: feeSats,
      coordinatorFeeBps: this.config.coordinatorFeeBps,
      status: "pending_funding",
      timeoutMs: input.timeoutMs ?? this.config.defaultTimeoutMs,
      proofSchema: input.proofSchema,
      invoiceRef: input.invoiceRef,
      createdAtMs: Date.now()
    };
    this.tasks.set(task.taskId, task);
    return task;
  }

  getTask(taskId: string): RobotTask | undefined {
    return this.tasks.get(taskId);
  }

  markFunded(taskId: string): RobotTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("task_not_found");
    if (task.status !== "pending_funding") throw new Error("task_not_pending_funding");
    task.status = "funded";
    return task;
  }

  claimTask(taskId: string, agentId: string): RobotTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("task_not_found");
    if (task.status !== "funded") throw new Error("task_not_claimable");
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error("agent_not_registered");
    for (const req of task.resourceRequirements) {
      if (!agent.capabilities.includes(req)) throw new Error("capability_mismatch");
    }
    task.status = "claimed";
    task.claimedBy = agentId;
    task.claimedAtMs = Date.now();
    return task;
  }

  listAvailableTasks(agentId: string): RobotTask[] {
    const agent = this.agents.get(agentId);
    if (!agent) return [];
    const results: RobotTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== "funded") continue;
      const matches = task.resourceRequirements.every((r) => agent.capabilities.includes(r));
      if (matches) results.push(task);
    }
    return results;
  }

  submitProof(taskId: string, agentId: string, payload: unknown): RobotTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("task_not_found");
    if (task.status !== "claimed") throw new Error("task_not_claimed");
    if (task.claimedBy !== agentId) throw new Error("not_claimed_by_agent");
    task.status = "proof_submitted";
    task.proofPayload = payload;
    task.proofSubmittedAtMs = Date.now();
    return task;
  }

  settleTask(taskId: string): RobotTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("task_not_found");
    if (task.status !== "proof_submitted") throw new Error("task_not_proof_submitted");
    task.status = "settled";
    task.settledAtMs = Date.now();
    const entry: RobotEarningsEntry = {
      entryId: randomUUID(),
      agentId: task.claimedBy!,
      taskId: task.taskId,
      earnedSats: task.rewardSats,
      status: "accrued",
      createdAtMs: Date.now()
    };
    this.earnings.push(entry);
    const agent = this.agents.get(task.claimedBy!);
    if (agent) agent.successCount += 1;
    return task;
  }

  disputeTask(taskId: string, reason: string): RobotTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("task_not_found");
    if (task.status !== "proof_submitted") throw new Error("task_not_proof_submitted");
    task.status = "disputed";
    task.disputeReason = reason;
    return task;
  }

  expireStale(): number {
    const now = Date.now();
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status !== "claimed") continue;
      if (!task.claimedAtMs) continue;
      if (now - task.claimedAtMs > task.timeoutMs) {
        task.status = "expired";
        const agent = this.agents.get(task.claimedBy!);
        if (agent) agent.failureCount += 1;
        count += 1;
      }
    }
    return count;
  }

  getEarnings(agentId: string): RobotEarningsEntry[] {
    return this.earnings.filter((e) => e.agentId === agentId);
  }

  pendingSweepPayouts(): RobotSweepPayout[] {
    const byAgent = new Map<string, number>();
    for (const entry of this.earnings) {
      if (entry.status !== "accrued") continue;
      byAgent.set(entry.agentId, (byAgent.get(entry.agentId) ?? 0) + entry.earnedSats);
    }
    const payouts: RobotSweepPayout[] = [];
    for (const [agentId, total] of byAgent) {
      if (total < this.config.minSweepSats) continue;
      const agent = this.agents.get(agentId);
      if (!agent) continue;
      payouts.push({ agentId, address: agent.payoutAddress, amountSats: total });
    }
    return payouts;
  }

  markSwept(agentId: string, txid: string): void {
    for (const entry of this.earnings) {
      if (entry.agentId === agentId && entry.status === "accrued") {
        entry.status = "swept";
        entry.sweepTxId = txid;
      }
    }
  }

  status(): { agents: number; totalTasks: number; funded: number; claimed: number; settled: number } {
    let funded = 0, claimed = 0, settled = 0;
    for (const task of this.tasks.values()) {
      if (task.status === "funded") funded++;
      else if (task.status === "claimed") claimed++;
      else if (task.status === "settled") settled++;
    }
    return { agents: this.agents.size, totalTasks: this.tasks.size, funded, claimed, settled };
  }
}
