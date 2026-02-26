import { describe, it, expect, beforeEach } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { SwarmQueue } from "../../src/swarm/queue.js";
import { CreditEngine } from "../../src/credits/engine.js";
import { baseRatePerSecond, loadMultiplier, LoadSnapshot } from "../../src/credits/pricing.js";
import {
  computeLoadIndex,
  smoothLoadIndex,
  computeDailyPoolTokens,
  computeHourlyIssuanceAllocations,
  IssuancePoolConfig,
  LoadInputs,
} from "../../src/economy/issuance.js";
import {
  MockBitcoinAnchorProvider,
  encodeCheckpointForOpReturn,
  decodeOpReturnCheckpoint,
} from "../../src/economy/bitcoin-rpc.js";
import { createLightningProviderFromEnv } from "../../src/economy/lightning.js";
import { computeIntentFee } from "../../src/swarm/coordinator-utils.js";
import {
  ExecutionPolicy,
  Subtask,
  SubtaskResult,
  ComputeContributionReport,
  ResourceClass,
  RollingContributionShare,
} from "../../src/common/types.js";

// ── Shared helpers ──────────────────────────────────────────────────────

const defaultPolicy: ExecutionPolicy = {
  cpuCapPercent: 50,
  memoryLimitMb: 2048,
  idleOnly: true,
  maxConcurrentTasks: 1,
  allowedHours: { startHourUtc: 0, endHourUtc: 24 },
};

const defaultPoolConfig: IssuancePoolConfig = {
  baseDailyPoolTokens: 1000,
  minDailyPoolTokens: 500,
  maxDailyPoolTokens: 5000,
  loadCurveSlope: 0.5,
  smoothingAlpha: 0.3,
};

function makeSubtask(
  projectId: string,
  priority = 10,
  resourceClass: ResourceClass = "cpu"
): Omit<Subtask, "id"> {
  return {
    taskId: randomUUID(),
    kind: "micro_loop",
    language: "python",
    input: `task for ${projectId}`,
    timeoutMs: 5000,
    snapshotRef: "commit:e2e-reward",
    projectMeta: { projectId, resourceClass, priority },
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
  gpuSeconds: number,
  qualityScore: number,
  success: boolean,
  resourceClass: ResourceClass = "cpu"
): ComputeContributionReport {
  return {
    reportId: randomUUID(),
    agentId,
    taskId,
    resourceClass,
    cpuSeconds,
    gpuSeconds,
    success,
    qualityScore,
    timestampMs: Date.now(),
  };
}

// ── Phase 1: Task Completion → Credit Accrual ───────────────────────────

describe("Phase 1: Task Completion → Credit Accrual", () => {
  let engine: CreditEngine;

  beforeEach(() => {
    engine = new CreditEngine();
  });

  it("should accrue CPU credits proportional to compute seconds and quality", () => {
    const load: LoadSnapshot = { queuedTasks: 5, activeAgents: 5 };
    // pressure = 1.0 => loadMultiplier = 1.0
    const report = makeReport("agent-cpu", "t1", 20, 0, 1.0, true, "cpu");
    const tx = engine.accrue(report, load);

    // 20 * 1.0 (baseRate cpu) * 1.0 (quality) * 1.0 (load) = 20.0
    expect(tx.credits).toBe(20.0);
    expect(tx.type).toBe("earn");
    expect(engine.balance("agent-cpu")).toBe(20.0);
  });

  it("should accrue GPU credits at 4x CPU rate", () => {
    const load: LoadSnapshot = { queuedTasks: 5, activeAgents: 5 };
    const report = makeReport("agent-gpu", "t2", 0, 10, 1.0, true, "gpu");
    const tx = engine.accrue(report, load);

    // 10 * 4.0 (baseRate gpu) * 1.0 * 1.0 = 40.0
    expect(tx.credits).toBe(40.0);
    expect(baseRatePerSecond("gpu")).toBe(4.0);
    expect(baseRatePerSecond("cpu")).toBe(1.0);
  });

  it("should clamp quality score to [0.5, 1.5]", () => {
    const load: LoadSnapshot = { queuedTasks: 5, activeAgents: 5 };

    // Below min => clamped to 0.5
    const rLow = makeReport("agent-lo", "t3", 10, 0, 0.1, true, "cpu");
    expect(engine.accrue(rLow, load).credits).toBe(5.0); // 10 * 1.0 * 0.5 * 1.0

    // Above max => clamped to 1.5
    const rHigh = makeReport("agent-hi", "t4", 10, 0, 3.0, true, "cpu");
    expect(engine.accrue(rHigh, load).credits).toBe(15.0); // 10 * 1.0 * 1.5 * 1.0
  });

  it("should apply load multiplier tiers (0.8 / 1.0 / 1.25 / 1.6)", () => {
    // pressure ≤ 0.5 => 0.8
    expect(loadMultiplier({ queuedTasks: 1, activeAgents: 5 })).toBe(0.8);
    // pressure ≤ 1.0 => 1.0
    expect(loadMultiplier({ queuedTasks: 5, activeAgents: 5 })).toBe(1.0);
    // pressure ≤ 2.0 => 1.25
    expect(loadMultiplier({ queuedTasks: 8, activeAgents: 5 })).toBe(1.25);
    // pressure > 2.0 => 1.6
    expect(loadMultiplier({ queuedTasks: 15, activeAgents: 5 })).toBe(1.6);

    // Verify credits scale with load
    const r1 = makeReport("a1", "lt1", 10, 0, 1.0, true, "cpu");
    const tx1 = engine.accrue(r1, { queuedTasks: 1, activeAgents: 5 });
    expect(tx1.credits).toBe(8.0); // 10 * 1.0 * 1.0 * 0.8

    const r2 = makeReport("a2", "lt2", 10, 0, 1.0, true, "cpu");
    const tx2 = engine.accrue(r2, { queuedTasks: 15, activeAgents: 5 });
    expect(tx2.credits).toBe(16.0); // 10 * 1.0 * 1.0 * 1.6
  });

  it("should accumulate balance across multiple tasks", () => {
    const load: LoadSnapshot = { queuedTasks: 5, activeAgents: 5 };

    const r1 = makeReport("agent-m", "mt1", 10, 0, 1.0, true, "cpu");
    const r2 = makeReport("agent-m", "mt2", 5, 0, 1.2, true, "cpu");
    const r3 = makeReport("agent-m", "mt3", 0, 3, 0.9, true, "gpu");

    engine.accrue(r1, load); // 10 * 1.0 * 1.0 * 1.0 = 10.0
    engine.accrue(r2, load); // 5 * 1.0 * 1.2 * 1.0 = 6.0
    engine.accrue(r3, load); // 3 * 4.0 * 0.9 * 1.0 = 10.8

    expect(engine.balance("agent-m")).toBe(26.8);
    expect(engine.history("agent-m")).toHaveLength(3);
  });
});

// ── Phase 2: Rolling Contribution Shares → Issuance ────────────────────

describe("Phase 2: Rolling Contribution Shares → Issuance", () => {
  it("should clamp load index to [0.2, 6.0]", () => {
    // Very low demand => clamped to 0.2
    const low = computeLoadIndex({ queuedTasks: 0, activeAgents: 0, cpuCapacity: 100, gpuCapacity: 50 });
    expect(low).toBe(0.2);

    // Very high demand => clamped to 6.0
    const high = computeLoadIndex({ queuedTasks: 10000, activeAgents: 5000, cpuCapacity: 1, gpuCapacity: 0 });
    expect(high).toBe(6);
  });

  it("should apply exponential moving average smoothing", () => {
    const alpha = 0.3;
    const prev = 1.0;
    const current = 2.0;
    const smoothed = smoothLoadIndex(prev, current, alpha);

    // prev * (1 - alpha) + current * alpha = 1.0 * 0.7 + 2.0 * 0.3 = 1.3
    expect(smoothed).toBeCloseTo(1.3, 6);

    // null previous => returns current
    expect(smoothLoadIndex(null, 2.5, alpha)).toBe(2.5);
  });

  it("should scale daily pool tokens by load curve", () => {
    // loadIndex = 1.0 => scaled = 1000 * (1 + max(0, 0) * 0.5) = 1000
    expect(computeDailyPoolTokens(1.0, defaultPoolConfig)).toBe(1000);

    // loadIndex = 3.0 => scaled = 1000 * (1 + 2.0 * 0.5) = 2000
    expect(computeDailyPoolTokens(3.0, defaultPoolConfig)).toBe(2000);

    // loadIndex = 0.5 => loadIndex - 1 < 0, max(0, ...) = 0 => 1000
    expect(computeDailyPoolTokens(0.5, defaultPoolConfig)).toBe(1000);

    // Very high => clamped to maxDailyPoolTokens
    expect(computeDailyPoolTokens(6.0, defaultPoolConfig)).toBe(3500);
  });

  it("should allocate hourly tokens proportional to weighted contribution", () => {
    const shares: RollingContributionShare[] = [
      { accountId: "a1", cpuSeconds: 100, gpuSeconds: 0, avgQualityScore: 1.0, reliabilityScore: 1.0, weightedContribution: 60 },
      { accountId: "a2", cpuSeconds: 50, gpuSeconds: 0, avgQualityScore: 1.0, reliabilityScore: 1.0, weightedContribution: 30 },
      { accountId: "a3", cpuSeconds: 20, gpuSeconds: 0, avgQualityScore: 1.0, reliabilityScore: 1.0, weightedContribution: 10 },
    ];

    const dailyTokens = 2400; // hourly = 100
    const allocs = computeHourlyIssuanceAllocations(shares, dailyTokens);

    expect(allocs).toHaveLength(3);

    // Sum of allocation shares ≈ 1.0
    const shareSum = allocs.reduce((s, a) => s + a.allocationShare, 0);
    expect(shareSum).toBeCloseTo(1.0, 6);

    // Sum of issued tokens ≈ hourlyPool (2400/24 = 100)
    const tokenSum = allocs.reduce((s, a) => s + a.issuedTokens, 0);
    expect(tokenSum).toBeCloseTo(100, 3);

    // Proportionality: a1 gets 60%, a2 gets 30%, a3 gets 10%
    expect(allocs[0].allocationShare).toBeCloseTo(0.6, 6);
    expect(allocs[1].allocationShare).toBeCloseTo(0.3, 6);
    expect(allocs[2].allocationShare).toBeCloseTo(0.1, 6);
  });

  it("should filter out zero-contribution participants", () => {
    const shares: RollingContributionShare[] = [
      { accountId: "active", cpuSeconds: 50, gpuSeconds: 0, avgQualityScore: 1.0, reliabilityScore: 1.0, weightedContribution: 50 },
      { accountId: "idle", cpuSeconds: 0, gpuSeconds: 0, avgQualityScore: 0, reliabilityScore: 1.0, weightedContribution: 0 },
    ];

    const allocs = computeHourlyIssuanceAllocations(shares, 2400);
    expect(allocs).toHaveLength(1);
    expect(allocs[0].accountId).toBe("active");
    expect(allocs[0].allocationShare).toBeCloseTo(1.0, 6);
  });
});

// ── Phase 3: Bitcoin Checkpoint Anchoring ───────────────────────────────

describe("Phase 3: Bitcoin Checkpoint Anchoring", () => {
  it("should produce SHA256 hash of epoch + allocations payload", () => {
    const payload = JSON.stringify({
      epoch: 42,
      allocations: [
        { accountId: "a1", issuedTokens: 60 },
        { accountId: "a2", issuedTokens: 40 },
      ],
    });
    const hash = createHash("sha256").update(payload).digest("hex");

    expect(hash).toHaveLength(64);
    // Deterministic
    const hash2 = createHash("sha256").update(payload).digest("hex");
    expect(hash).toBe(hash2);
  });

  it("should encode OP_RETURN as 35 bytes: 'EC' prefix + version + 32-byte hash", () => {
    const hash = createHash("sha256").update("test-checkpoint").digest("hex");
    const encoded = encodeCheckpointForOpReturn(hash);

    // 35 bytes = 70 hex chars
    expect(encoded).toHaveLength(70);

    // Starts with "EC" in ascii hex (0x4543)
    expect(encoded.slice(0, 4)).toBe("4543");

    // Version byte is 0x01
    expect(encoded.slice(4, 6)).toBe("01");

    // Remaining 32 bytes are the hash
    expect(encoded.slice(6)).toBe(hash);
  });

  it("should round-trip encode/decode correctly", () => {
    const originalHash = createHash("sha256").update("epoch-data-round-trip").digest("hex");
    const encoded = encodeCheckpointForOpReturn(originalHash);
    const decoded = decodeOpReturnCheckpoint(encoded);

    expect(decoded).not.toBeNull();
    expect(decoded!.version).toBe(1);
    expect(decoded!.checkpointHash).toBe(originalHash);
  });

  it("should return null for invalid OP_RETURN data", () => {
    expect(decodeOpReturnCheckpoint("")).toBeNull();
    expect(decodeOpReturnCheckpoint("aabb")).toBeNull();
    expect(decodeOpReturnCheckpoint("0000" + "01" + "a".repeat(64))).toBeNull(); // wrong prefix
  });

  it("should broadcast and confirm via MockBitcoinAnchorProvider", async () => {
    const provider = new MockBitcoinAnchorProvider();
    const hash = createHash("sha256").update("anchor-test").digest("hex");
    const opReturnData = encodeCheckpointForOpReturn(hash);

    const broadcast = await provider.broadcastOpReturn(opReturnData);
    expect(broadcast.txid).toHaveLength(64);

    const confirmation = await provider.getConfirmations(broadcast.txid);
    expect(confirmation.confirmed).toBe(true);
    expect(confirmation.confirmations).toBe(6);
    expect(confirmation.blockHeight).toBe(900_000);
  });
});

// ── Phase 4: Payment Settlement → Payout Distribution ──────────────────

describe("Phase 4: Payment Settlement → Payout Distribution", () => {
  it("should compute 5% coordinator + 5% reserve fee split", () => {
    const totalSats = 100_000;
    const coordinatorFeeBps = 500; // 5%
    const reserveFeeBps = 500; // 5%

    // Coordinator fee first
    const { feeSats: coordinatorFee, netSats: afterCoordinator } = computeIntentFee(totalSats, coordinatorFeeBps);
    expect(coordinatorFee).toBe(5000);
    expect(afterCoordinator).toBe(95000);

    // Reserve fee on remainder
    const { feeSats: reserveFee, netSats: payoutPool } = computeIntentFee(afterCoordinator, reserveFeeBps);
    expect(reserveFee).toBe(4750);
    expect(payoutPool).toBe(90250);

    // Accounting: coordinator + reserve + payoutPool = total
    expect(coordinatorFee + reserveFee + payoutPool).toBe(totalSats);
  });

  it("should create and auto-settle a mock Lightning invoice", async () => {
    const lightning = createLightningProviderFromEnv();

    const invoice = await lightning.createInvoice({
      amountSats: 50000,
      memo: "reward-flow-test",
      expiresInSeconds: 3600,
    });

    expect(invoice.invoiceRef).toMatch(/^mockln:/);
    expect(invoice.paymentHash).toBeTruthy();
    expect(invoice.expiresAtMs).toBeGreaterThan(Date.now());

    const settlement = await lightning.checkSettlement(invoice.invoiceRef);
    expect(settlement.settled).toBe(true);
    expect(settlement.txRef).toBeTruthy();
  });

  it("should distribute payouts proportional to allocation shares", () => {
    const payoutPool = 90000;
    const allocations = [
      { accountId: "a1", allocationShare: 0.6 },
      { accountId: "a2", allocationShare: 0.3 },
      { accountId: "a3", allocationShare: 0.1 },
    ];

    const payouts = allocations.map((a) => ({
      accountId: a.accountId,
      amountSats: Math.floor(payoutPool * a.allocationShare),
    }));

    // Verify proportionality
    expect(payouts[0].amountSats).toBe(54000);
    expect(payouts[1].amountSats).toBe(27000);
    expect(payouts[2].amountSats).toBe(9000);

    // Dust from floor rounding
    const totalPaid = payouts.reduce((s, p) => s + p.amountSats, 0);
    const dust = payoutPool - totalPaid;
    expect(dust).toBe(0); // clean split in this case
    expect(dust).toBeLessThan(allocations.length);
  });

  it("should satisfy accounting invariant: coordinator + reserve + payouts + dust = total", () => {
    const totalSats = 123_456;
    const { feeSats: coordFee, netSats: afterCoord } = computeIntentFee(totalSats, 500);
    const { feeSats: reserveFee, netSats: payoutPool } = computeIntentFee(afterCoord, 500);

    const shares = [0.5, 0.3, 0.15, 0.05];
    const payouts = shares.map((s) => Math.floor(payoutPool * s));
    const totalPaid = payouts.reduce((s, p) => s + p, 0);
    const dust = payoutPool - totalPaid;

    expect(coordFee + reserveFee + totalPaid + dust).toBe(totalSats);
    expect(dust).toBeLessThan(shares.length);
    expect(dust).toBeGreaterThanOrEqual(0);
  });

  it("should execute batch payout via MockBitcoinAnchorProvider.sendToMany", async () => {
    const provider = new MockBitcoinAnchorProvider();
    const outputs = [
      { address: "bc1q-agent-1", amountSats: 54000 },
      { address: "bc1q-agent-2", amountSats: 27000 },
      { address: "bc1q-agent-3", amountSats: 9000 },
    ];

    const result = await provider.sendToMany(outputs);
    expect(result.txid).toHaveLength(64);
  });
});

// ── Phase 5: Full Pipeline Integration ─────────────────────────────────

describe("Phase 5: Full Pipeline Integration", () => {
  it("should run complete reward flow: 3 agents, 12 tasks → issuance → anchor → settle → payout", async () => {
    // ── Setup ──────────────────────────────────────────────────────
    const queue = new SwarmQueue();
    const engine = new CreditEngine();
    const bitcoinProvider = new MockBitcoinAnchorProvider();
    const lightning = createLightningProviderFromEnv();

    const agents = ["agent-alpha", "agent-beta", "agent-gamma"];
    for (const agent of agents) {
      queue.registerAgent(agent, defaultPolicy);
    }

    // ── Enqueue 12 tasks: 8 CPU + 4 GPU ───────────────────────────
    const cpuTasks: Subtask[] = [];
    const gpuTasks: Subtask[] = [];
    for (let i = 0; i < 8; i++) {
      cpuTasks.push(queue.enqueueSubtask(makeSubtask("proj-reward", 10, "cpu")));
    }
    for (let i = 0; i < 4; i++) {
      gpuTasks.push(queue.enqueueSubtask(makeSubtask("proj-reward", 10, "gpu")));
    }
    const allTasks = [...cpuTasks, ...gpuTasks];
    expect(queue.status().queued).toBe(12);

    // ── Claim, complete, and accrue credits ────────────────────────
    // Quality scores per agent: alpha=1.3 (high), beta=1.0 (medium), gamma=0.7 (low)
    const qualityByAgent: Record<string, number> = {
      "agent-alpha": 1.3,
      "agent-beta": 1.0,
      "agent-gamma": 0.7,
    };

    // Track per-agent accrual data for building contribution shares
    const agentCpuSeconds: Record<string, number> = {};
    const agentGpuSeconds: Record<string, number> = {};
    const agentQualitySum: Record<string, number> = {};
    const agentTaskCount: Record<string, number> = {};
    for (const agent of agents) {
      agentCpuSeconds[agent] = 0;
      agentGpuSeconds[agent] = 0;
      agentQualitySum[agent] = 0;
      agentTaskCount[agent] = 0;
    }

    const load: LoadSnapshot = { queuedTasks: 12, activeAgents: 3 };
    // pressure = 12/3 = 4 > 2.0 => loadMultiplier = 1.6
    expect(loadMultiplier(load)).toBe(1.6);

    let completedCount = 0;
    while (completedCount < 12) {
      for (const agent of agents) {
        const claimed = queue.claim(agent);
        if (!claimed) continue;

        const isGpu = claimed.projectMeta.resourceClass === "gpu";
        const cpuSec = isGpu ? 0 : 5 + Math.floor(completedCount * 0.5); // varying durations
        const gpuSec = isGpu ? 8 : 0;
        const quality = qualityByAgent[agent];

        queue.complete(makeResult(claimed, agent, true, 200));

        const report = makeReport(agent, claimed.taskId, cpuSec, gpuSec, quality, true, isGpu ? "gpu" : "cpu");
        engine.accrue(report, load);

        agentCpuSeconds[agent] += cpuSec;
        agentGpuSeconds[agent] += gpuSec;
        agentQualitySum[agent] += quality;
        agentTaskCount[agent] += 1;

        completedCount++;
        if (completedCount >= 12) break;
      }
    }

    // ── Invariant 1: All 12 tasks completed ─────────────────────────
    expect(queue.status().results).toBe(12);
    expect(completedCount).toBe(12);

    // ── Invariant 2: All agents have positive credit balances ───────
    for (const agent of agents) {
      expect(engine.balance(agent)).toBeGreaterThan(0);
    }

    // ── Build RollingContributionShares from accrual data ───────────
    const shares: RollingContributionShare[] = agents.map((agent) => {
      const avgQ = agentTaskCount[agent] > 0
        ? agentQualitySum[agent] / agentTaskCount[agent]
        : 0;
      // Weighted contribution: cpu credits + gpu credits (at 4x rate) scaled by quality
      const clampedQ = Math.max(0.5, Math.min(1.5, avgQ));
      const weightedContribution =
        (agentCpuSeconds[agent] * baseRatePerSecond("cpu") +
          agentGpuSeconds[agent] * baseRatePerSecond("gpu")) * clampedQ;
      return {
        accountId: agent,
        cpuSeconds: agentCpuSeconds[agent],
        gpuSeconds: agentGpuSeconds[agent],
        avgQualityScore: avgQ,
        reliabilityScore: 1.0,
        weightedContribution,
      };
    });

    // ── Compute issuance ───────────────────────────────────────────
    const loadInputs: LoadInputs = {
      queuedTasks: 12,
      activeAgents: 3,
      cpuCapacity: 50,
      gpuCapacity: 10,
    };
    const loadIndex = computeLoadIndex(loadInputs);
    const smoothed = smoothLoadIndex(null, loadIndex, defaultPoolConfig.smoothingAlpha);
    const dailyTokens = computeDailyPoolTokens(smoothed, defaultPoolConfig);
    const allocations = computeHourlyIssuanceAllocations(shares, dailyTokens);
    const hourlyPool = dailyTokens / 24;

    // ── Invariant 3: Issuance token sum ≈ hourly pool ──────────────
    const issuedSum = allocations.reduce((s, a) => s + a.issuedTokens, 0);
    expect(issuedSum).toBeCloseTo(hourlyPool, 2);

    // ── Anchor checkpoint ──────────────────────────────────────────
    const epochPayload = JSON.stringify({
      epoch: 1,
      loadIndex: smoothed,
      allocations: allocations.map((a) => ({
        accountId: a.accountId,
        issuedTokens: a.issuedTokens,
      })),
    });
    const checkpointHash = createHash("sha256").update(epochPayload).digest("hex");
    const opReturnData = encodeCheckpointForOpReturn(checkpointHash);
    const broadcast = await bitcoinProvider.broadcastOpReturn(opReturnData);

    // ── Invariant 7: Checkpoint hash round-trips through OP_RETURN ──
    const decoded = decodeOpReturnCheckpoint(opReturnData);
    expect(decoded).not.toBeNull();
    expect(decoded!.checkpointHash).toBe(checkpointHash);

    // ── Invariant 8: Bitcoin anchor confirmed ──────────────────────
    const confirmation = await bitcoinProvider.getConfirmations(broadcast.txid);
    expect(confirmation.confirmed).toBe(true);

    // ── Payment settlement ─────────────────────────────────────────
    const totalPaymentSats = 100_000;
    const { feeSats: coordinatorFee, netSats: afterCoordinator } = computeIntentFee(totalPaymentSats, 500);
    const { feeSats: reserveFee, netSats: payoutPool } = computeIntentFee(afterCoordinator, 500);

    // Create Lightning invoice for the full payment
    const invoice = await lightning.createInvoice({
      amountSats: totalPaymentSats,
      memo: `reward-epoch-1`,
      expiresInSeconds: 3600,
    });

    // ── Invariant 9: Lightning invoice settled ─────────────────────
    const settlement = await lightning.checkSettlement(invoice.invoiceRef);
    expect(settlement.settled).toBe(true);

    // ── Distribute payouts proportional to allocation shares ───────
    const payouts = allocations.map((a) => ({
      address: `bc1q-${a.accountId}`,
      amountSats: Math.floor(payoutPool * a.allocationShare),
    }));
    const totalPaid = payouts.reduce((s, p) => s + p.amountSats, 0);
    const dust = payoutPool - totalPaid;

    // ── Invariant 4: coordinator + reserve + payouts + dust = total (exact) ──
    expect(coordinatorFee + reserveFee + totalPaid + dust).toBe(totalPaymentSats);

    // ── Invariant 5: Dust < number of participants ──────────────────
    expect(dust).toBeLessThan(allocations.length);
    expect(dust).toBeGreaterThanOrEqual(0);

    // ── Invariant 6: Highest-weighted contributor gets most tokens AND largest payout ──
    const sortedAllocsByWeight = [...allocations].sort(
      (a, b) => b.weightedContribution - a.weightedContribution
    );
    const topContributor = sortedAllocsByWeight[0];

    // Highest weighted => most tokens
    for (const a of allocations) {
      expect(topContributor.issuedTokens).toBeGreaterThanOrEqual(a.issuedTokens);
    }

    // Highest weighted => largest payout
    const topPayout = payouts.find((p) => p.address === `bc1q-${topContributor.accountId}`);
    for (const p of payouts) {
      expect(topPayout!.amountSats).toBeGreaterThanOrEqual(p.amountSats);
    }

    // ── Invariant 10: Batch payout succeeded ────────────────────────
    const batchResult = await bitcoinProvider.sendToMany(payouts);
    expect(batchResult.txid).toHaveLength(64);
  });
});
