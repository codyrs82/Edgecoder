import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { SwarmQueue } from "../../src/swarm/queue.js";
import { CreditEngine } from "../../src/credits/engine.js";
import {
  BLEMeshManager,
  modelQualityMultiplier,
} from "../../src/mesh/ble/ble-mesh-manager.js";
import { MockBLETransport } from "../../src/mesh/ble/ble-transport.js";
import {
  computeDynamicPricePerComputeUnitSats,
  DynamicPriceInputs,
} from "../../src/economy/pricing.js";
import {
  baseRatePerSecond,
  loadMultiplier,
  LoadSnapshot,
} from "../../src/credits/pricing.js";
import {
  ExecutionPolicy,
  Subtask,
  SubtaskResult,
  ComputeContributionReport,
  BLETaskRequest,
  BLETaskResponse,
} from "../../src/common/types.js";

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
    snapshotRef: "commit:e2e-test",
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

function makeReport(
  agentId: string,
  taskId: string,
  cpuSeconds: number,
  qualityScore: number,
  success: boolean
): ComputeContributionReport {
  return {
    reportId: randomUUID(),
    agentId,
    taskId,
    resourceClass: "cpu",
    cpuSeconds,
    gpuSeconds: 0,
    success,
    qualityScore,
    timestampMs: Date.now(),
  };
}

// ── Scenario 1: Multi-Agent Fair-Share Scheduling ───────────────────────

describe("Scenario 1: Multi-Agent Fair-Share Scheduling", () => {
  let queue: SwarmQueue;

  beforeEach(() => {
    queue = new SwarmQueue();
    queue.registerAgent("agent-7B", defaultPolicy);
    queue.registerAgent("agent-3B", defaultPolicy);
    queue.registerAgent("agent-1.5B", defaultPolicy);
  });

  it("should distribute 9 tasks across 3 projects with fair-share", () => {
    const projects = ["proj-alpha", "proj-beta", "proj-gamma"];

    // Enqueue 3 tasks per project (9 total)
    const enqueued: Subtask[] = [];
    for (const project of projects) {
      for (let i = 0; i < 3; i++) {
        enqueued.push(queue.enqueueSubtask(makeSubtask(project)));
      }
    }

    expect(queue.status().queued).toBe(9);

    const agents = ["agent-7B", "agent-3B", "agent-1.5B"];
    const claimed: Subtask[] = [];
    const projectClaimCounts = new Map<string, number>();

    // Each agent claims one task at a time, completes it, then claims next
    for (let round = 0; round < 3; round++) {
      for (const agent of agents) {
        const task = queue.claim(agent);
        expect(task).toBeDefined();
        claimed.push(task!);
        const pid = task!.projectMeta.projectId;
        projectClaimCounts.set(pid, (projectClaimCounts.get(pid) ?? 0) + 1);
        queue.complete(makeResult(task!, agent, true));
      }
    }

    // All 9 tasks claimed and completed
    expect(claimed).toHaveLength(9);
    expect(queue.status().queued).toBe(0);
    expect(queue.status().results).toBe(9);

    // Fair-share: each project should get exactly 3 completions
    for (const project of projects) {
      expect(projectClaimCounts.get(project)).toBe(3);
    }
  });

  it("should prefer projects with fewer completions", () => {
    // Enqueue 2 tasks for proj-A and 1 for proj-B
    const a1 = queue.enqueueSubtask(makeSubtask("proj-A"));
    const a2 = queue.enqueueSubtask(makeSubtask("proj-A"));
    const b1 = queue.enqueueSubtask(makeSubtask("proj-B"));

    // Complete one task from proj-A
    const first = queue.claim("agent-7B");
    expect(first).toBeDefined();
    queue.complete(makeResult(first!, "agent-7B", true));

    // Next claim should prefer proj-B (0 completions) over proj-A (1 completion)
    // if first was proj-A, or proj-A if first was proj-B
    const second = queue.claim("agent-3B");
    expect(second).toBeDefined();

    if (first!.projectMeta.projectId === "proj-A") {
      expect(second!.projectMeta.projectId).toBe("proj-B");
    } else {
      expect(second!.projectMeta.projectId).toBe("proj-A");
    }
  });
});

// ── Scenario 2: Credit Calculation with Model Quality Multiplier ────────

describe("Scenario 2: Credit Calculation with Model Quality Multiplier", () => {
  let engine: CreditEngine;

  beforeEach(() => {
    engine = new CreditEngine();
  });

  it("should verify modelQualityMultiplier for all model sizes", () => {
    expect(modelQualityMultiplier(7)).toBe(1.0);
    expect(modelQualityMultiplier(13)).toBe(1.0);
    expect(modelQualityMultiplier(3)).toBe(0.7);
    expect(modelQualityMultiplier(5)).toBe(0.7);
    expect(modelQualityMultiplier(1.5)).toBe(0.5);
    expect(modelQualityMultiplier(2)).toBe(0.5);
    expect(modelQualityMultiplier(1)).toBe(0.3);
    expect(modelQualityMultiplier(0.5)).toBe(0.3);
  });

  it("should accrue credits based on cpuSeconds and qualityScore", () => {
    const load: LoadSnapshot = { queuedTasks: 5, activeAgents: 5 };
    // pressure = 5/5 = 1.0 => loadMultiplier = 1.0
    expect(loadMultiplier(load)).toBe(1.0);

    const report = makeReport("agent-7B", "task-1", 10, 1.0, true);
    const tx = engine.accrue(report, load);

    // credits = cpuSeconds * baseRatePerSecond("cpu") * qualityMultiplier * loadMultiplier
    // = 10 * 1.0 * 1.0 * 1.0 = 10.0
    expect(tx.credits).toBe(10.0);
    expect(tx.type).toBe("earn");
    expect(tx.accountId).toBe("agent-7B");
  });

  it("should scale credits by quality score", () => {
    const load: LoadSnapshot = { queuedTasks: 5, activeAgents: 5 };

    // qualityScore 0.5 (clamped to min 0.5)
    const lowQ = makeReport("agent-low", "task-2", 10, 0.5, true);
    const txLow = engine.accrue(lowQ, load);
    expect(txLow.credits).toBe(5.0); // 10 * 1.0 * 0.5 * 1.0

    // qualityScore 1.5 (clamped to max 1.5)
    const highQ = makeReport("agent-high", "task-3", 10, 1.5, true);
    const txHigh = engine.accrue(highQ, load);
    expect(txHigh.credits).toBe(15.0); // 10 * 1.0 * 1.5 * 1.0

    expect(txHigh.credits).toBeGreaterThan(txLow.credits);
  });

  it("should apply load multiplier based on queue pressure", () => {
    // Low pressure: pressure = 1/5 = 0.2 => multiplier 0.8
    const lowLoad: LoadSnapshot = { queuedTasks: 1, activeAgents: 5 };
    expect(loadMultiplier(lowLoad)).toBe(0.8);
    const r1 = makeReport("agent-a", "t-lp", 10, 1.0, true);
    const tx1 = engine.accrue(r1, lowLoad);
    expect(tx1.credits).toBe(8.0); // 10 * 1.0 * 1.0 * 0.8

    // High pressure: pressure = 15/5 = 3.0 => multiplier 1.6
    const highLoad: LoadSnapshot = { queuedTasks: 15, activeAgents: 5 };
    expect(loadMultiplier(highLoad)).toBe(1.6);
    const r2 = makeReport("agent-b", "t-hp", 10, 1.0, true);
    const tx2 = engine.accrue(r2, highLoad);
    expect(tx2.credits).toBe(16.0); // 10 * 1.0 * 1.0 * 1.6

    expect(tx2.credits).toBeGreaterThan(tx1.credits);
  });

  it("should reject duplicate contribution reports", () => {
    const load: LoadSnapshot = { queuedTasks: 5, activeAgents: 5 };
    const report = makeReport("agent-dup", "task-dup", 5, 1.0, true);

    engine.accrue(report, load);
    expect(() => engine.accrue(report, load)).toThrow("duplicate_contribution_report");
  });
});

// ── Scenario 3: Success vs Failure Credit Differences ───────────────────

describe("Scenario 3: Success vs Failure Credit Differences", () => {
  let queue: SwarmQueue;
  let engine: CreditEngine;

  beforeEach(() => {
    queue = new SwarmQueue();
    engine = new CreditEngine();
  });

  it("should award more credits for successful tasks than failed ones", () => {
    queue.registerAgent("agent-success", defaultPolicy);
    queue.registerAgent("agent-fail", defaultPolicy);

    const taskA = queue.enqueueSubtask(makeSubtask("proj-cred"));
    const taskB = queue.enqueueSubtask(makeSubtask("proj-cred"));

    const claimedA = queue.claim("agent-success");
    queue.complete(makeResult(claimedA!, "agent-success", true, 200));

    const claimedB = queue.claim("agent-fail");
    queue.complete(makeResult(claimedB!, "agent-fail", false, 200));

    const load: LoadSnapshot = { queuedTasks: 2, activeAgents: 2 };

    // Success with high quality score
    const successReport = makeReport(
      "agent-success",
      claimedA!.taskId,
      2.0,
      1.2, // high qualityScore
      true
    );
    const txSuccess = engine.accrue(successReport, load);

    // Failure with low quality score
    const failReport = makeReport(
      "agent-fail",
      claimedB!.taskId,
      2.0,
      0.5, // low qualityScore for failed result
      false
    );
    const txFail = engine.accrue(failReport, load);

    // Success should earn more credits due to higher qualityScore
    expect(txSuccess.credits).toBeGreaterThan(txFail.credits);

    // Verify exact values:
    // success: 2.0 * 1.0 * 1.2 * 1.0 = 2.4
    // fail:    2.0 * 1.0 * 0.5 * 1.0 = 1.0
    expect(txSuccess.credits).toBe(2.4);
    expect(txFail.credits).toBe(1.0);

    // Verify balances
    expect(engine.balance("agent-success")).toBe(2.4);
    expect(engine.balance("agent-fail")).toBe(1.0);
  });

  it("should clamp qualityScore to [0.5, 1.5] range", () => {
    const load: LoadSnapshot = { queuedTasks: 5, activeAgents: 5 };

    // qualityScore below 0.5 should be clamped to 0.5
    const belowMin = makeReport("agent-below", "t-below", 10, 0.1, true);
    const txBelow = engine.accrue(belowMin, load);
    expect(txBelow.credits).toBe(5.0); // 10 * 1.0 * 0.5 * 1.0

    // qualityScore above 1.5 should be clamped to 1.5
    const aboveMax = makeReport("agent-above", "t-above", 10, 2.0, true);
    const txAbove = engine.accrue(aboveMax, load);
    expect(txAbove.credits).toBe(15.0); // 10 * 1.0 * 1.5 * 1.0
  });

  it("should track credit history per agent", () => {
    const load: LoadSnapshot = { queuedTasks: 5, activeAgents: 5 };

    const r1 = makeReport("agent-hist", "t-h1", 5, 1.0, true);
    const r2 = makeReport("agent-hist", "t-h2", 3, 1.0, true);

    engine.accrue(r1, load);
    engine.accrue(r2, load);

    const history = engine.history("agent-hist");
    expect(history).toHaveLength(2);
    expect(history[0].credits).toBe(5.0);
    expect(history[1].credits).toBe(3.0);
    expect(engine.balance("agent-hist")).toBe(8.0);
  });
});

// ── Scenario 4: BLE Offline Credits Flow ────────────────────────────────

describe("Scenario 4: BLE Offline Credits Flow", () => {
  it("should route a task via BLE, record offline credit, and export sync batch", async () => {
    const network = new Map<string, MockBLETransport>();
    const transportA = new MockBLETransport("agent-A", network);
    const transportB = new MockBLETransport("agent-B", network);

    const managerA = new BLEMeshManager("agent-A", "account-A", transportA);
    const managerB = new BLEMeshManager("agent-B", "account-B", transportB);

    // Set both offline
    managerA.setOffline(true);
    managerB.setOffline(true);

    expect(managerA.isOffline()).toBe(true);
    expect(managerB.isOffline()).toBe(true);

    // Agent B advertises its capabilities (7B model)
    transportB.startAdvertising({
      agentId: "agent-B",
      model: "qwen2.5-coder:7b",
      modelParamSize: 7,
      memoryMB: 8192,
      batteryPct: 80,
      currentLoad: 0,
      deviceType: "laptop",
    });

    // Agent B registers a task handler
    transportB.onTaskRequest(async (req: BLETaskRequest): Promise<BLETaskResponse> => {
      return {
        requestId: req.requestId,
        providerId: "agent-B",
        status: "completed",
        generatedCode: "print('hello')",
        output: "hello",
        cpuSeconds: 5.0,
        providerSignature: "sig-B-123",
      };
    });

    // Agent A routes a task to Agent B
    const request: BLETaskRequest = {
      requestId: randomUUID(),
      requesterId: "agent-A",
      task: "write a hello world function",
      language: "python",
      requesterSignature: "sig-A-456",
    };

    const response = await managerA.routeTask(request, 3);

    // Verify the response
    expect(response).not.toBeNull();
    expect(response!.status).toBe("completed");
    expect(response!.providerId).toBe("agent-B");
    expect(response!.cpuSeconds).toBe(5.0);

    // Verify offline ledger recorded the transaction
    const pending = managerA.pendingTransactions();
    expect(pending).toHaveLength(1);

    const tx = pending[0];
    expect(tx.requesterId).toBe("agent-A");
    expect(tx.providerId).toBe("agent-B");
    expect(tx.requesterAccountId).toBe("account-A");
    expect(tx.providerAccountId).toBe("agent-B"); // MockBLETransport uses agentId as accountId
    expect(tx.cpuSeconds).toBe(5.0);

    // Verify modelQualityMultiplier applied: 7B => 1.0
    // credits = cpuSeconds * baseRatePerSecond("cpu") * modelQualityMultiplier(7)
    // = 5.0 * 1.0 * 1.0 = 5.0
    const expectedCredits = 5.0 * baseRatePerSecond("cpu") * modelQualityMultiplier(7);
    expect(tx.credits).toBe(expectedCredits);

    // Export sync batch and verify it contains pending transactions
    const batch = managerA.exportSyncBatch();
    expect(batch).toHaveLength(1);
    expect(batch[0].txId).toBe(tx.txId);

    // After marking synced, pending should be empty
    managerA.markSynced([tx.txId]);
    expect(managerA.pendingTransactions()).toHaveLength(0);
  });

  it("should apply lower multiplier for smaller models in BLE credits", async () => {
    const network = new Map<string, MockBLETransport>();
    const transportA = new MockBLETransport("agent-A2", network);
    const transportB = new MockBLETransport("agent-B2", network);

    const managerA = new BLEMeshManager("agent-A2", "account-A2", transportA);

    managerA.setOffline(true);

    // Agent B2 advertises with a 1.5B model
    transportB.startAdvertising({
      agentId: "agent-B2",
      model: "qwen2.5-coder:1.5b",
      modelParamSize: 1.5,
      memoryMB: 4096,
      batteryPct: 90,
      currentLoad: 0,
      deviceType: "laptop",
    });

    transportB.onTaskRequest(async (req): Promise<BLETaskResponse> => {
      return {
        requestId: req.requestId,
        providerId: "agent-B2",
        status: "completed",
        generatedCode: "print('hi')",
        output: "hi",
        cpuSeconds: 5.0,
        providerSignature: "sig-B2",
      };
    });

    const request: BLETaskRequest = {
      requestId: randomUUID(),
      requesterId: "agent-A2",
      task: "simple task",
      language: "python",
      requesterSignature: "sig-A2",
    };

    const response = await managerA.routeTask(request, 1);
    expect(response).not.toBeNull();
    expect(response!.status).toBe("completed");

    const pending = managerA.pendingTransactions();
    expect(pending).toHaveLength(1);

    // 1.5B => multiplier = 0.5
    // credits = 5.0 * 1.0 * 0.5 = 2.5
    const expectedCredits = Number(
      (5.0 * baseRatePerSecond("cpu") * modelQualityMultiplier(1.5)).toFixed(3)
    );
    expect(pending[0].credits).toBe(expectedCredits);
    expect(expectedCredits).toBe(2.5);
  });

  it("should not route tasks when not offline", async () => {
    const network = new Map<string, MockBLETransport>();
    const transportA = new MockBLETransport("agent-online", network);
    const managerA = new BLEMeshManager("agent-online", "account-online", transportA);

    // Not offline -- should return null
    const request: BLETaskRequest = {
      requestId: randomUUID(),
      requesterId: "agent-online",
      task: "task",
      language: "python",
      requesterSignature: "sig",
    };

    const response = await managerA.routeTask(request, 3);
    expect(response).toBeNull();
  });
});

// ── Scenario 5: Load-Based Dynamic Pricing ──────────────────────────────

describe("Scenario 5: Load-Based Dynamic Pricing", () => {
  it("should compute lower price under low demand", () => {
    const lowDemand: DynamicPriceInputs = {
      cpuCapacity: 100,
      gpuCapacity: 10,
      queuedTasks: 2,
      activeAgents: 3,
    };
    const priceLow = computeDynamicPricePerComputeUnitSats("cpu", lowDemand);

    // demand = max(1, 2 + 3) = 5
    // scarcity = 5 / 100 = 0.05
    // multiplier = clamp(0.65 + 0.05 * 0.35, 0.35, 4.0) = clamp(0.6675, 0.35, 4.0) = 0.6675
    // price = max(1, round(30 * 0.6675)) = max(1, 20) = 20
    expect(priceLow).toBe(20);
  });

  it("should compute higher price under high demand", () => {
    const highDemand: DynamicPriceInputs = {
      cpuCapacity: 10,
      gpuCapacity: 2,
      queuedTasks: 50,
      activeAgents: 20,
    };
    const priceHigh = computeDynamicPricePerComputeUnitSats("cpu", highDemand);

    // demand = max(1, 50 + 20) = 70
    // scarcity = 70 / 10 = 7.0
    // multiplier = clamp(0.65 + 7.0 * 0.35, 0.35, 4.0) = clamp(3.1, 0.35, 4.0) = 3.1
    // price = max(1, round(30 * 3.1)) = 93
    expect(priceHigh).toBe(93);
  });

  it("should produce higher price for GPU resources", () => {
    const inputs: DynamicPriceInputs = {
      cpuCapacity: 50,
      gpuCapacity: 50,
      queuedTasks: 10,
      activeAgents: 10,
    };

    const cpuPrice = computeDynamicPricePerComputeUnitSats("cpu", inputs);
    const gpuPrice = computeDynamicPricePerComputeUnitSats("gpu", inputs);

    // GPU base is 120 vs CPU base of 30, same multiplier
    expect(gpuPrice).toBeGreaterThan(cpuPrice);

    // demand = 20, capacity = 50, scarcity = 0.4
    // multiplier = clamp(0.65 + 0.4 * 0.35, 0.35, 4.0) = 0.79
    // CPU: round(30 * 0.79) = 24
    // GPU: round(120 * 0.79) = 95
    expect(cpuPrice).toBe(24);
    expect(gpuPrice).toBe(95);
  });

  it("should clamp multiplier to 4.0 at extreme scarcity", () => {
    const extreme: DynamicPriceInputs = {
      cpuCapacity: 1,
      gpuCapacity: 1,
      queuedTasks: 1000,
      activeAgents: 500,
    };

    const price = computeDynamicPricePerComputeUnitSats("cpu", extreme);

    // demand = 1500, capacity = 1, scarcity = 1500
    // multiplier = clamp(0.65 + 1500 * 0.35, 0.35, 4.0) = 4.0
    // price = round(30 * 4.0) = 120
    expect(price).toBe(120);
  });

  it("should match loadMultiplier tiers for credit engine", () => {
    // Verify loadMultiplier tiers used in CreditEngine
    expect(loadMultiplier({ queuedTasks: 1, activeAgents: 5 })).toBe(0.8); // 0.2 <= 0.5
    expect(loadMultiplier({ queuedTasks: 5, activeAgents: 5 })).toBe(1.0); // 1.0 <= 1.0
    expect(loadMultiplier({ queuedTasks: 8, activeAgents: 5 })).toBe(1.25); // 1.6 <= 2.0
    expect(loadMultiplier({ queuedTasks: 15, activeAgents: 5 })).toBe(1.6); // 3.0 > 2.0
    expect(loadMultiplier({ queuedTasks: 10, activeAgents: 0 })).toBe(1.25); // 0 agents => pressure 2, which is <= 2.0
  });
});

// ── Scenario 6: Task Timeout and Requeue ────────────────────────────────

describe("Scenario 6: Task Timeout and Requeue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should requeue stale tasks and allow another agent to claim", () => {
    const queue = new SwarmQueue();
    queue.registerAgent("agent-A", defaultPolicy);
    queue.registerAgent("agent-B", defaultPolicy);

    const task = queue.enqueueSubtask(makeSubtask("proj-timeout"));

    // Agent A claims the task
    const claimed = queue.claim("agent-A");
    expect(claimed).toBeDefined();
    expect(claimed!.id).toBe(task.id);

    // No more unclaimed tasks
    const noClaim = queue.claim("agent-B");
    expect(noClaim).toBeUndefined();

    // Advance time past the claim timeout threshold
    vi.advanceTimersByTime(5000);

    // Requeue tasks claimed more than 1000ms ago
    const requeued = queue.requeueStale(1000);
    expect(requeued).toBe(1);

    // Now agent B can claim the requeued task
    const reclaimedByB = queue.claim("agent-B");
    expect(reclaimedByB).toBeDefined();
    expect(reclaimedByB!.id).toBe(task.id);

    // Complete the task as agent B
    queue.complete(makeResult(reclaimedByB!, "agent-B", true, 300));

    expect(queue.status().queued).toBe(0);
    expect(queue.status().results).toBe(1);
  });

  it("should award credits only to the agent that completed the task", () => {
    const queue = new SwarmQueue();
    const engine = new CreditEngine();

    queue.registerAgent("agent-stale", defaultPolicy);
    queue.registerAgent("agent-fresh", defaultPolicy);

    const task = queue.enqueueSubtask(makeSubtask("proj-requeue-credits"));

    // Agent-stale claims but times out
    queue.claim("agent-stale");

    // Advance time so the claim becomes stale
    vi.advanceTimersByTime(5000);
    queue.requeueStale(1000);

    // Agent-fresh claims and completes
    const reclaimedTask = queue.claim("agent-fresh");
    expect(reclaimedTask).toBeDefined();
    queue.complete(makeResult(reclaimedTask!, "agent-fresh", true, 250));

    // Accrue credits only for agent-fresh
    const load: LoadSnapshot = { queuedTasks: 1, activeAgents: 2 };
    const report = makeReport("agent-fresh", reclaimedTask!.taskId, 2.5, 1.0, true);
    const tx = engine.accrue(report, load);

    expect(tx.accountId).toBe("agent-fresh");
    // pressure = 1/2 = 0.5, loadMultiplier = 0.8
    // credits = 2.5 * 1.0 * 1.0 * 0.8 = 2.0
    expect(tx.credits).toBe(2.0);

    expect(engine.balance("agent-fresh")).toBe(2.0);
    expect(engine.balance("agent-stale")).toBe(0);
  });

  it("should not requeue tasks that are not stale yet", () => {
    const queue = new SwarmQueue();
    queue.registerAgent("agent-fast", defaultPolicy);

    queue.enqueueSubtask(makeSubtask("proj-fast"));

    queue.claim("agent-fast");

    // Requeue with a very long timeout -- nothing should be requeued
    const requeued = queue.requeueStale(999_999_999);
    expect(requeued).toBe(0);

    // Task is still claimed, no unclaimed tasks available
    expect(queue.status().queued).toBe(1);
  });
});
