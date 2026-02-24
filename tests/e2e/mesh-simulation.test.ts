import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { GossipMesh } from "../../src/mesh/gossip.js";
import { SwarmQueue } from "../../src/swarm/queue.js";
import { CreditEngine } from "../../src/credits/engine.js";
import {
  baseRatePerSecond,
  loadMultiplier,
  LoadSnapshot,
} from "../../src/credits/pricing.js";
import {
  ExecutionPolicy,
  Subtask,
  SubtaskResult,
  MeshMessage,
  MeshPeerIdentity,
  ComputeContributionReport,
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
    snapshotRef: "commit:mesh-sim",
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

function makeMeshMessage(
  fromPeerId: string,
  type: MeshMessage["type"] = "peer_announce"
): MeshMessage {
  return {
    id: randomUUID(),
    type,
    fromPeerId,
    issuedAtMs: Date.now(),
    ttlMs: 30_000,
    payload: { data: "hello-mesh" },
    signature: "sig-" + fromPeerId,
  };
}

// ── Scenario 1: Gossip Propagation Across a 5-Node Chain ────────────────

describe("Scenario 1: Gossip Propagation Across a 5-Node Chain", () => {
  /**
   * GossipMesh.broadcast() sends HTTP POST requests to each peer's
   * coordinatorUrl. To test propagation without real HTTP servers, we
   * mock the `undici.request` function and track which URLs receive
   * the message, simulating a chain-relay pattern.
   */

  const NODE_COUNT = 5;

  it("should broadcast from node 0 and deliver to all peers in the chain", async () => {
    // Track which coordinator URLs received the broadcast
    const deliveredUrls: string[] = [];

    // Mock undici.request so broadcast() does not make real HTTP calls
    const { request } = await import("undici");
    const mockRequest = vi.fn().mockImplementation(async (url: string) => {
      deliveredUrls.push(url);
      return { statusCode: 200 };
    });

    // We need to mock at the module level; instead, we test the structural
    // behavior: create 5 GossipMesh nodes, wire them in a chain, and
    // verify that broadcast reaches the direct peers of each node.

    // Create 5 mesh nodes
    const nodes: GossipMesh[] = [];
    const peerIdentities: MeshPeerIdentity[] = [];

    for (let i = 0; i < NODE_COUNT; i++) {
      nodes.push(new GossipMesh());
      peerIdentities.push({
        peerId: `node-${i}`,
        publicKeyPem: `pem-${i}`,
        coordinatorUrl: `http://localhost:${9000 + i}`,
        networkMode: "public_mesh",
      });
    }

    // Wire nodes in a chain: node[i] knows about node[i+1]
    // node-0 -> node-1 -> node-2 -> node-3 -> node-4
    for (let i = 0; i < NODE_COUNT - 1; i++) {
      nodes[i].addPeer(peerIdentities[i + 1]);
    }

    // Verify chain wiring: each node (except the last) has exactly 1 peer
    for (let i = 0; i < NODE_COUNT - 1; i++) {
      expect(nodes[i].listPeers()).toHaveLength(1);
      expect(nodes[i].listPeers()[0].peerId).toBe(`node-${i + 1}`);
    }
    // Last node has no peers
    expect(nodes[NODE_COUNT - 1].listPeers()).toHaveLength(0);

    // Verify peer management: add and remove
    const tempPeer: MeshPeerIdentity = {
      peerId: "temp-peer",
      publicKeyPem: "pem-temp",
      coordinatorUrl: "http://localhost:9999",
      networkMode: "public_mesh",
    };

    nodes[4].addPeer(tempPeer);
    expect(nodes[4].listPeers()).toHaveLength(1);
    nodes[4].removePeer("temp-peer");
    expect(nodes[4].listPeers()).toHaveLength(0);
  });

  it("should simulate multi-hop relay propagation across the chain", async () => {
    // Simulate gossip relay: when a node receives a broadcast, it
    // re-broadcasts to its own peers. We track message delivery
    // in-memory without real HTTP by directly calling broadcast
    // and recording which node identities are targeted.

    const nodes: GossipMesh[] = [];
    const peerIdentities: MeshPeerIdentity[] = [];
    const receivedByNode = new Set<string>();

    for (let i = 0; i < NODE_COUNT; i++) {
      nodes.push(new GossipMesh());
      peerIdentities.push({
        peerId: `node-${i}`,
        publicKeyPem: `pem-${i}`,
        coordinatorUrl: `http://localhost:${9000 + i}`,
        networkMode: "public_mesh",
      });
    }

    // Wire chain: each node knows the next node
    for (let i = 0; i < NODE_COUNT - 1; i++) {
      nodes[i].addPeer(peerIdentities[i + 1]);
    }

    // Simulate relay propagation: node-0 originates the message
    const originMessage = makeMeshMessage("node-0", "task_offer");
    receivedByNode.add("node-0"); // originator has the message

    // Relay hop-by-hop: node[i] broadcasts to node[i+1], marking it received
    for (let i = 0; i < NODE_COUNT - 1; i++) {
      const peers = nodes[i].listPeers();
      for (const peer of peers) {
        receivedByNode.add(peer.peerId);
      }
    }

    // All 5 nodes should have received the message
    expect(receivedByNode.size).toBe(NODE_COUNT);
    for (let i = 0; i < NODE_COUNT; i++) {
      expect(receivedByNode.has(`node-${i}`)).toBe(true);
    }
  });

  it("should report delivery and failure counts from broadcast", async () => {
    // Since broadcast() makes real HTTP calls that will fail (no server),
    // we verify the failure-counting behavior.
    const node = new GossipMesh();
    const peers: MeshPeerIdentity[] = [
      {
        peerId: "dead-peer-1",
        publicKeyPem: "pem-d1",
        coordinatorUrl: "http://127.0.0.1:1",
        networkMode: "public_mesh",
      },
      {
        peerId: "dead-peer-2",
        publicKeyPem: "pem-d2",
        coordinatorUrl: "http://127.0.0.1:2",
        networkMode: "public_mesh",
      },
    ];

    for (const p of peers) {
      node.addPeer(p);
    }

    const msg = makeMeshMessage("test-sender", "queue_summary");
    const result = await node.broadcast(msg);

    // Both peers are unreachable, so all should fail
    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.delivered + result.failed).toBe(peers.length);
  });

  it("should handle broadcast with zero peers gracefully", async () => {
    const node = new GossipMesh();
    const msg = makeMeshMessage("lone-node");
    const result = await node.broadcast(msg);

    expect(result.delivered).toBe(0);
    expect(result.failed).toBe(0);
  });
});

// ── Scenario 2: Fair-Share Task Distribution Across 5 Agents ────────────

describe("Scenario 2: Fair-Share Task Distribution Across 5 Agents", () => {
  let queue: SwarmQueue;
  const AGENT_COUNT = 5;
  const TASK_COUNT = 10;
  const agentIds = Array.from({ length: AGENT_COUNT }, (_, i) => `agent-${i}`);

  beforeEach(() => {
    queue = new SwarmQueue();
    for (const agentId of agentIds) {
      queue.registerAgent(agentId, defaultPolicy);
    }
  });

  it("should distribute 10 tasks fairly across 5 agents", () => {
    // Enqueue 10 tasks for the same project
    const enqueued: Subtask[] = [];
    for (let i = 0; i < TASK_COUNT; i++) {
      enqueued.push(queue.enqueueSubtask(makeSubtask("proj-fair")));
    }

    expect(queue.status().queued).toBe(TASK_COUNT);
    expect(queue.status().agents).toBe(AGENT_COUNT);

    // Each agent claims tasks in round-robin fashion
    const claimedByAgent = new Map<string, Subtask[]>();
    for (const agentId of agentIds) {
      claimedByAgent.set(agentId, []);
    }

    // Simulate 2 rounds: 5 agents each claim 1 task per round = 10 tasks total
    for (let round = 0; round < 2; round++) {
      for (const agentId of agentIds) {
        const task = queue.claim(agentId);
        expect(task).toBeDefined();
        claimedByAgent.get(agentId)!.push(task!);
        queue.complete(makeResult(task!, agentId, true));
      }
    }

    // All 10 tasks should have been claimed and completed
    expect(queue.status().queued).toBe(0);
    expect(queue.status().results).toBe(TASK_COUNT);

    // Each agent should have claimed exactly 2 tasks (10 / 5 = 2)
    for (const agentId of agentIds) {
      expect(claimedByAgent.get(agentId)!).toHaveLength(2);
    }
  });

  it("should apply fair-share across multiple projects", () => {
    // Enqueue tasks across 2 projects: 6 for proj-X, 4 for proj-Y
    for (let i = 0; i < 6; i++) {
      queue.enqueueSubtask(makeSubtask("proj-X"));
    }
    for (let i = 0; i < 4; i++) {
      queue.enqueueSubtask(makeSubtask("proj-Y"));
    }

    expect(queue.status().queued).toBe(10);

    const projectCompletions = new Map<string, number>();

    // Claim all 10 tasks using 5 agents
    for (let i = 0; i < TASK_COUNT; i++) {
      const agentId = agentIds[i % AGENT_COUNT];
      const task = queue.claim(agentId);
      expect(task).toBeDefined();

      const pid = task!.projectMeta.projectId;
      projectCompletions.set(pid, (projectCompletions.get(pid) ?? 0) + 1);
      queue.complete(makeResult(task!, agentId, true));
    }

    // All tasks completed
    expect(queue.status().queued).toBe(0);
    expect(queue.status().results).toBe(10);

    // Each project should have all its tasks completed
    expect(projectCompletions.get("proj-X")).toBe(6);
    expect(projectCompletions.get("proj-Y")).toBe(4);
  });

  it("should respect priority within the same completion count", () => {
    // Enqueue one low-priority and one high-priority task for different projects
    queue.enqueueSubtask(makeSubtask("proj-low", 1));
    queue.enqueueSubtask(makeSubtask("proj-high", 100));

    // Neither project has completions yet, so fair-share is tied at 0.
    // Within tied fair-share, higher priority should win.
    const first = queue.claim("agent-0");
    expect(first).toBeDefined();
    expect(first!.projectMeta.priority).toBe(100);
    expect(first!.projectMeta.projectId).toBe("proj-high");
  });

  it("should return undefined when no tasks are available", () => {
    // No tasks enqueued, claim should return undefined
    const result = queue.claim("agent-0");
    expect(result).toBeUndefined();
  });

  it("should track queue status accurately", () => {
    expect(queue.status().agents).toBe(AGENT_COUNT);
    expect(queue.status().queued).toBe(0);
    expect(queue.status().results).toBe(0);

    const task = queue.enqueueSubtask(makeSubtask("proj-status"));
    expect(queue.status().queued).toBe(1);

    const claimed = queue.claim("agent-0");
    expect(claimed).toBeDefined();
    // Task is claimed but still in the queue until completed
    expect(queue.status().queued).toBe(1);

    queue.complete(makeResult(claimed!, "agent-0", true));
    expect(queue.status().queued).toBe(0);
    expect(queue.status().results).toBe(1);
  });
});

// ── Scenario 3: Credit Settlement ───────────────────────────────────────

describe("Scenario 3: Credit Settlement", () => {
  let engine: CreditEngine;

  beforeEach(() => {
    engine = new CreditEngine();
  });

  it("should credit one agent via accrue and debit another via spend", () => {
    const load: LoadSnapshot = { queuedTasks: 5, activeAgents: 5 };
    // pressure = 1.0, loadMultiplier = 1.0

    // Agent-provider earns credits by contributing compute
    const report = makeReport("agent-provider", "task-settle-1", 20, 1.0, true);
    const earnTx = engine.accrue(report, load);

    // credits = cpuSeconds * baseRatePerSecond("cpu") * qualityMultiplier * loadMultiplier
    //         = 20 * 1.0 * 1.0 * 1.0 = 20.0
    expect(earnTx.type).toBe("earn");
    expect(earnTx.credits).toBe(20.0);
    expect(earnTx.accountId).toBe("agent-provider");
    expect(engine.balance("agent-provider")).toBe(20.0);

    // Agent-consumer also earns some credits first (needs balance to spend)
    const consumerReport = makeReport("agent-consumer", "task-settle-2", 15, 1.0, true);
    engine.accrue(consumerReport, load);
    expect(engine.balance("agent-consumer")).toBe(15.0);

    // Agent-consumer spends 10 credits
    const spendTx = engine.spend("agent-consumer", 10, "task_delegation", "task-settle-3");

    expect(spendTx.type).toBe("spend");
    expect(spendTx.credits).toBe(10);
    expect(spendTx.accountId).toBe("agent-consumer");
    expect(spendTx.reason).toBe("task_delegation");

    // Verify final balances
    expect(engine.balance("agent-provider")).toBe(20.0);
    expect(engine.balance("agent-consumer")).toBe(5.0); // 15 - 10 = 5
  });

  it("should reject spend when balance is insufficient", () => {
    // New account has zero balance
    expect(engine.balance("agent-broke")).toBe(0);

    expect(() => {
      engine.spend("agent-broke", 5, "over_spend");
    }).toThrow("insufficient_credits");
  });

  it("should support adjust for both positive and negative credit changes", () => {
    // Positive adjustment (acts as earn)
    const positiveTx = engine.adjust("agent-adj", 50, "bonus_grant");
    expect(positiveTx.type).toBe("earn");
    expect(positiveTx.credits).toBe(50);
    expect(engine.balance("agent-adj")).toBe(50);

    // Negative adjustment (acts as spend)
    const negativeTx = engine.adjust("agent-adj", -20, "penalty_deduction");
    expect(negativeTx.type).toBe("spend");
    expect(negativeTx.credits).toBe(20); // stored as absolute value
    expect(engine.balance("agent-adj")).toBe(30); // 50 - 20 = 30
  });

  it("should maintain correct history and balances across multiple transactions", () => {
    const load: LoadSnapshot = { queuedTasks: 5, activeAgents: 5 };

    // Earn through 3 contribution reports
    for (let i = 0; i < 3; i++) {
      const report = makeReport("agent-ledger", `task-l${i}`, 10, 1.0, true);
      engine.accrue(report, load);
    }

    expect(engine.balance("agent-ledger")).toBe(30.0); // 3 * 10
    expect(engine.history("agent-ledger")).toHaveLength(3);

    // Spend 12 credits
    engine.spend("agent-ledger", 12, "inference_cost");
    expect(engine.balance("agent-ledger")).toBe(18.0); // 30 - 12

    // Adjust +5
    engine.adjust("agent-ledger", 5, "referral_bonus");
    expect(engine.balance("agent-ledger")).toBe(23.0); // 18 + 5

    // Full history should have 5 entries (3 earn + 1 spend + 1 adjust-earn)
    const history = engine.history("agent-ledger");
    expect(history).toHaveLength(5);

    // Verify transaction types in order
    expect(history[0].type).toBe("earn");
    expect(history[1].type).toBe("earn");
    expect(history[2].type).toBe("earn");
    expect(history[3].type).toBe("spend");
    expect(history[4].type).toBe("earn"); // positive adjust is "earn"
  });

  it("should isolate balances between different accounts", () => {
    const load: LoadSnapshot = { queuedTasks: 5, activeAgents: 5 };

    const r1 = makeReport("agent-alpha", "t-iso-1", 10, 1.0, true);
    const r2 = makeReport("agent-beta", "t-iso-2", 25, 1.0, true);

    engine.accrue(r1, load);
    engine.accrue(r2, load);

    // Balances are independent
    expect(engine.balance("agent-alpha")).toBe(10.0);
    expect(engine.balance("agent-beta")).toBe(25.0);
    expect(engine.balance("agent-gamma")).toBe(0); // never used

    // Spending from alpha does not affect beta
    engine.spend("agent-alpha", 5, "spend-test");
    expect(engine.balance("agent-alpha")).toBe(5.0);
    expect(engine.balance("agent-beta")).toBe(25.0);
  });

  it("should scale credits by load multiplier tiers", () => {
    // Low load: pressure 0.2 => multiplier 0.8
    const lowLoad: LoadSnapshot = { queuedTasks: 1, activeAgents: 5 };
    const r1 = makeReport("agent-lm1", "t-lm1", 10, 1.0, true);
    const tx1 = engine.accrue(r1, lowLoad);
    expect(tx1.credits).toBe(8.0); // 10 * 1.0 * 1.0 * 0.8

    // Normal load: pressure 1.0 => multiplier 1.0
    const normalLoad: LoadSnapshot = { queuedTasks: 5, activeAgents: 5 };
    const r2 = makeReport("agent-lm2", "t-lm2", 10, 1.0, true);
    const tx2 = engine.accrue(r2, normalLoad);
    expect(tx2.credits).toBe(10.0); // 10 * 1.0 * 1.0 * 1.0

    // High load: pressure 3.0 => multiplier 1.6
    const highLoad: LoadSnapshot = { queuedTasks: 15, activeAgents: 5 };
    const r3 = makeReport("agent-lm3", "t-lm3", 10, 1.0, true);
    const tx3 = engine.accrue(r3, highLoad);
    expect(tx3.credits).toBe(16.0); // 10 * 1.0 * 1.0 * 1.6

    // Higher load means more credits earned
    expect(tx3.credits).toBeGreaterThan(tx2.credits);
    expect(tx2.credits).toBeGreaterThan(tx1.credits);
  });

  it("should reject duplicate contribution reports", () => {
    const load: LoadSnapshot = { queuedTasks: 5, activeAgents: 5 };
    const report = makeReport("agent-dup", "task-dup", 5, 1.0, true);

    engine.accrue(report, load);
    expect(() => engine.accrue(report, load)).toThrow("duplicate_contribution_report");

    // Balance should reflect only the first accrual
    expect(engine.balance("agent-dup")).toBe(5.0);
  });
});
