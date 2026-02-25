import { describe, expect, test } from "vitest";
import { RobotQueue } from "../../src/swarm/robot-queue.js";

function makeQueue() {
  return new RobotQueue({
    coordinatorFeeBps: 200,
    defaultTimeoutMs: 3_600_000,
    autoSettleDelayMs: 86_400_000,
    sweepIntervalMs: 86_400_000,
    minSweepSats: 10_000,
    bitcoinNetwork: "testnet"
  });
}

describe("robot agent registration", () => {
  test("registers a robot agent", () => {
    const q = makeQueue();
    q.registerAgent({
      agentId: "robot-1",
      payoutAddress: "tb1qtest123456",
      capabilities: ["camera", "gps"],
      robotKind: "rover"
    });
    const agent = q.getAgent("robot-1");
    expect(agent).toBeDefined();
    expect(agent!.payoutAddress).toBe("tb1qtest123456");
    expect(agent!.capabilities).toEqual(["camera", "gps"]);
    expect(agent!.successCount).toBe(0);
  });

  test("rejects registration without payout address", () => {
    const q = makeQueue();
    expect(() =>
      q.registerAgent({
        agentId: "robot-2",
        payoutAddress: "",
        capabilities: [],
        robotKind: "drone"
      })
    ).toThrow("payout_address_required");
  });

  test("updates agent on re-registration", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1qa", capabilities: ["gps"], robotKind: "rover" });
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1qb", capabilities: ["camera"], robotKind: "drone" });
    const agent = q.getAgent("r1");
    expect(agent!.payoutAddress).toBe("tb1qb");
    expect(agent!.robotKind).toBe("drone");
  });

  test("heartbeat updates lastSeenMs", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1qa", capabilities: [], robotKind: "rover" });
    const before = q.getAgent("r1")!.lastSeenMs;
    q.heartbeat("r1");
    expect(q.getAgent("r1")!.lastSeenMs).toBeGreaterThanOrEqual(before);
  });
});

describe("robot task creation", () => {
  test("creates a task with computed fee", () => {
    const q = makeQueue();
    const task = q.createTask({
      clientAccountId: "client-1",
      title: "Deliver package",
      description: "Deliver to coordinates X,Y",
      taskKind: "physical",
      resourceRequirements: ["gps"],
      amountSats: 100_000,
      invoiceRef: "lnbc1test"
    });
    expect(task.status).toBe("pending_funding");
    expect(task.escrowSats).toBe(100_000);
    expect(task.coordinatorFeeSats).toBe(2_000);
    expect(task.rewardSats).toBe(98_000);
    expect(task.taskId).toBeTruthy();
  });

  test("marks task funded", () => {
    const q = makeQueue();
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 50_000, invoiceRef: "lnbc2test"
    });
    const funded = q.markFunded(task.taskId);
    expect(funded.status).toBe("funded");
  });

  test("rejects funding non-existent task", () => {
    const q = makeQueue();
    expect(() => q.markFunded("nope")).toThrow("task_not_found");
  });
});

describe("robot task claim", () => {
  test("robot claims a funded task with matching capabilities", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: ["camera"], robotKind: "rover" });
    const task = q.createTask({
      clientAccountId: "c1", title: "photo", description: "take photo",
      taskKind: "physical", resourceRequirements: ["camera"],
      amountSats: 10_000, invoiceRef: "inv1"
    });
    q.markFunded(task.taskId);
    const claimed = q.claimTask(task.taskId, "r1");
    expect(claimed.status).toBe("claimed");
    expect(claimed.claimedBy).toBe("r1");
  });

  test("rejects claim from unregistered robot", () => {
    const q = makeQueue();
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 10_000, invoiceRef: "inv2"
    });
    q.markFunded(task.taskId);
    expect(() => q.claimTask(task.taskId, "unknown")).toThrow("agent_not_registered");
  });

  test("rejects claim when capabilities dont match", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: ["gps"], robotKind: "rover" });
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "physical", resourceRequirements: ["camera"],
      amountSats: 10_000, invoiceRef: "inv3"
    });
    q.markFunded(task.taskId);
    expect(() => q.claimTask(task.taskId, "r1")).toThrow("capability_mismatch");
  });

  test("rejects claim on unfunded task", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 10_000, invoiceRef: "inv4"
    });
    expect(() => q.claimTask(task.taskId, "r1")).toThrow("task_not_claimable");
  });

  test("rejects double claim", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    q.registerAgent({ agentId: "r2", payoutAddress: "tb1q2", capabilities: [], robotKind: "drone" });
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 10_000, invoiceRef: "inv5"
    });
    q.markFunded(task.taskId);
    q.claimTask(task.taskId, "r1");
    expect(() => q.claimTask(task.taskId, "r2")).toThrow("task_not_claimable");
  });

  test("lists available tasks matching capabilities", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: ["camera"], robotKind: "rover" });
    const t1 = q.createTask({
      clientAccountId: "c1", title: "photo", description: "d",
      taskKind: "physical", resourceRequirements: ["camera"],
      amountSats: 10_000, invoiceRef: "inv6"
    });
    q.createTask({
      clientAccountId: "c1", title: "compute", description: "d",
      taskKind: "compute", resourceRequirements: ["gpu"],
      amountSats: 20_000, invoiceRef: "inv7"
    });
    q.markFunded(t1.taskId);
    const available = q.listAvailableTasks("r1");
    expect(available).toHaveLength(1);
    expect(available[0].taskId).toBe(t1.taskId);
  });
});

describe("robot proof submission", () => {
  test("robot submits proof for claimed task", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 10_000, invoiceRef: "inv1"
    });
    q.markFunded(task.taskId);
    q.claimTask(task.taskId, "r1");
    const updated = q.submitProof(task.taskId, "r1", { result: "done", gps: [1.0, 2.0] });
    expect(updated.status).toBe("proof_submitted");
    expect(updated.proofPayload).toEqual({ result: "done", gps: [1.0, 2.0] });
  });

  test("rejects proof from wrong agent", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    q.registerAgent({ agentId: "r2", payoutAddress: "tb1q2", capabilities: [], robotKind: "drone" });
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 10_000, invoiceRef: "inv2"
    });
    q.markFunded(task.taskId);
    q.claimTask(task.taskId, "r1");
    expect(() => q.submitProof(task.taskId, "r2", {})).toThrow("not_claimed_by_agent");
  });

  test("rejects proof for non-claimed task", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 10_000, invoiceRef: "inv3"
    });
    q.markFunded(task.taskId);
    expect(() => q.submitProof(task.taskId, "r1", {})).toThrow("task_not_claimed");
  });
});

describe("robot task settlement", () => {
  test("settles task and accrues earnings", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 50_000, invoiceRef: "inv1"
    });
    q.markFunded(task.taskId);
    q.claimTask(task.taskId, "r1");
    q.submitProof(task.taskId, "r1", { output: "ok" });
    const settled = q.settleTask(task.taskId);
    expect(settled.status).toBe("settled");
    expect(settled.settledAtMs).toBeDefined();
    const earnings = q.getEarnings("r1");
    expect(earnings).toHaveLength(1);
    expect(earnings[0].earnedSats).toBe(settled.rewardSats);
    expect(earnings[0].status).toBe("accrued");
  });

  test("increments agent success count on settle", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 10_000, invoiceRef: "inv2"
    });
    q.markFunded(task.taskId);
    q.claimTask(task.taskId, "r1");
    q.submitProof(task.taskId, "r1", {});
    q.settleTask(task.taskId);
    expect(q.getAgent("r1")!.successCount).toBe(1);
  });

  test("rejects settlement of non-proof_submitted task", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 10_000, invoiceRef: "inv3"
    });
    q.markFunded(task.taskId);
    q.claimTask(task.taskId, "r1");
    expect(() => q.settleTask(task.taskId)).toThrow("task_not_proof_submitted");
  });
});

describe("robot task dispute and expiry", () => {
  test("disputes a proof_submitted task", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 10_000, invoiceRef: "inv1"
    });
    q.markFunded(task.taskId);
    q.claimTask(task.taskId, "r1");
    q.submitProof(task.taskId, "r1", {});
    const disputed = q.disputeTask(task.taskId, "bad quality");
    expect(disputed.status).toBe("disputed");
    expect(disputed.disputeReason).toBe("bad quality");
  });

  test("expires stale claimed tasks", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 10_000, invoiceRef: "inv2", timeoutMs: 1
    });
    q.markFunded(task.taskId);
    q.claimTask(task.taskId, "r1");
    const t = q.getTask(task.taskId)!;
    (t as any).claimedAtMs = Date.now() - 1000;
    const expired = q.expireStale();
    expect(expired).toBe(1);
    expect(q.getTask(task.taskId)!.status).toBe("expired");
    expect(q.getAgent("r1")!.failureCount).toBe(1);
  });
});

describe("robot sweep aggregation", () => {
  test("aggregates accrued earnings by agent", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    q.registerAgent({ agentId: "r2", payoutAddress: "tb1q2", capabilities: [], robotKind: "drone" });
    for (const [agent, inv] of [["r1", "i1"], ["r1", "i2"], ["r2", "i3"]] as const) {
      const task = q.createTask({
        clientAccountId: "c1", title: "t", description: "d",
        taskKind: "compute", resourceRequirements: [],
        amountSats: 50_000, invoiceRef: inv
      });
      q.markFunded(task.taskId);
      q.claimTask(task.taskId, agent);
      q.submitProof(task.taskId, agent, {});
      q.settleTask(task.taskId);
    }
    const pending = q.pendingSweepPayouts();
    expect(pending).toHaveLength(2);
    const r1Payout = pending.find((p) => p.agentId === "r1")!;
    expect(r1Payout.amountSats).toBe(49_000 * 2);
    expect(r1Payout.address).toBe("tb1q1");
  });

  test("skips agents below minimum sweep threshold", () => {
    const q = new RobotQueue({
      coordinatorFeeBps: 200,
      defaultTimeoutMs: 3_600_000,
      autoSettleDelayMs: 86_400_000,
      sweepIntervalMs: 86_400_000,
      minSweepSats: 100_000,
      bitcoinNetwork: "testnet"
    });
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 10_000, invoiceRef: "inv1"
    });
    q.markFunded(task.taskId);
    q.claimTask(task.taskId, "r1");
    q.submitProof(task.taskId, "r1", {});
    q.settleTask(task.taskId);
    const pending = q.pendingSweepPayouts();
    expect(pending).toHaveLength(0);
  });

  test("markSwept updates earnings entries", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 50_000, invoiceRef: "inv1"
    });
    q.markFunded(task.taskId);
    q.claimTask(task.taskId, "r1");
    q.submitProof(task.taskId, "r1", {});
    q.settleTask(task.taskId);
    q.markSwept("r1", "txid123");
    const earnings = q.getEarnings("r1");
    expect(earnings[0].status).toBe("swept");
    expect(earnings[0].sweepTxId).toBe("txid123");
  });

  test("status returns queue summary", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    const task = q.createTask({
      clientAccountId: "c1", title: "t", description: "d",
      taskKind: "compute", resourceRequirements: [],
      amountSats: 10_000, invoiceRef: "inv1"
    });
    q.markFunded(task.taskId);
    const s = q.status();
    expect(s.agents).toBe(1);
    expect(s.funded).toBe(1);
    expect(s.totalTasks).toBe(1);
  });
});
