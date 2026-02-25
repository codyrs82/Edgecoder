# Robot Work Marketplace Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an open marketplace where clients fund bitcoin tasks and physical robots claim, complete, and get paid in batched onchain sweeps.

**Architecture:** Three new files (`robot-types.ts`, `robot-queue.ts`, `robot-routes.ts`) in `src/swarm/`, plus a `sendToMany` extension on the bitcoin provider for sweep payouts. Coordinator.ts gets a 3-line integration. All business logic is in `RobotQueue` — routes are thin wrappers. TDD throughout.

**Tech Stack:** TypeScript, Vitest, Zod validation, existing LightningProvider/BitcoinAnchorProvider interfaces.

**Design doc:** `docs/plans/2026-02-24-robot-queue-design.md`

---

### Task 1: Define robot types

**Files:**
- Create: `src/swarm/robot-types.ts`

**Step 1: Write the type definitions**

```typescript
import type { BitcoinNetwork } from "../common/types.js";

export type RobotTaskKind = "physical" | "compute" | "hybrid";

export type RobotTaskStatus =
  | "pending_funding"
  | "funded"
  | "claimed"
  | "proof_submitted"
  | "settled"
  | "disputed"
  | "expired";

export interface RobotTask {
  taskId: string;
  clientAccountId: string;
  title: string;
  description: string;
  taskKind: RobotTaskKind;
  resourceRequirements: string[];
  escrowSats: number;
  rewardSats: number;
  coordinatorFeeSats: number;
  coordinatorFeeBps: number;
  status: RobotTaskStatus;
  timeoutMs: number;
  proofSchema?: Record<string, unknown>;
  invoiceRef: string;
  claimedBy?: string;
  claimedAtMs?: number;
  proofPayload?: unknown;
  proofSubmittedAtMs?: number;
  disputeReason?: string;
  createdAtMs: number;
  settledAtMs?: number;
}

export interface RobotAgent {
  agentId: string;
  payoutAddress: string;
  capabilities: string[];
  robotKind: string;
  lastSeenMs: number;
  successCount: number;
  failureCount: number;
}

export interface RobotEarningsEntry {
  entryId: string;
  agentId: string;
  taskId: string;
  earnedSats: number;
  status: "accrued" | "swept";
  sweepTxId?: string;
  createdAtMs: number;
}

export interface RobotSweepPayout {
  agentId: string;
  address: string;
  amountSats: number;
}

export interface RobotSweepEvent {
  sweepId: string;
  txid: string;
  totalSats: number;
  feesSats: number;
  payouts: RobotSweepPayout[];
  broadcastAtMs: number;
  confirmedAtMs?: number;
}

export interface RobotQueueConfig {
  coordinatorFeeBps: number;
  defaultTimeoutMs: number;
  autoSettleDelayMs: number;
  sweepIntervalMs: number;
  minSweepSats: number;
  bitcoinNetwork: BitcoinNetwork;
}
```

**Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/swarm/robot-types.ts
git commit -m "feat(robot): add robot marketplace type definitions"
```

---

### Task 2: Add `sendToMany` to BitcoinAnchorProvider

The existing `BitcoinAnchorProvider` only has `broadcastOpReturn`. Sweep payouts need multi-output BTC sends.

**Files:**
- Modify: `src/economy/bitcoin-rpc.ts`
- Test: `tests/economy/bitcoin-rpc.test.ts`

**Step 1: Write the failing test**

Add to `tests/economy/bitcoin-rpc.test.ts`:

```typescript
test("mock provider sendToMany returns txid", async () => {
  const provider = new MockBitcoinAnchorProvider();
  const result = await provider.sendToMany([
    { address: "bc1qtest1", amountSats: 50000 },
    { address: "bc1qtest2", amountSats: 30000 }
  ]);
  expect(result.txid).toBeTruthy();
  expect(result.txid.length).toBe(64);
});

test("mock provider sendToMany rejects empty outputs", async () => {
  const provider = new MockBitcoinAnchorProvider();
  await expect(provider.sendToMany([])).rejects.toThrow("no_outputs");
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/economy/bitcoin-rpc.test.ts`
Expected: FAIL — `sendToMany` not a function

**Step 3: Add `SendToManyOutput` interface and extend `BitcoinAnchorProvider`**

In `src/economy/bitcoin-rpc.ts`, add after line 30 (after `BitcoinAnchorProvider` interface closing brace):

```typescript
export interface SendToManyOutput {
  address: string;
  amountSats: number;
}

export interface SendToManyResult {
  txid: string;
  rawHex?: string;
}
```

Add `sendToMany` to the `BitcoinAnchorProvider` interface:

```typescript
export interface BitcoinAnchorProvider {
  broadcastOpReturn(dataHex: string): Promise<AnchorBroadcastResult>;
  getConfirmations(txid: string): Promise<AnchorConfirmationResult>;
  healthCheck(): Promise<BitcoinNodeHealth>;
  sendToMany(outputs: SendToManyOutput[]): Promise<SendToManyResult>;
}
```

Add to `MockBitcoinAnchorProvider`:

```typescript
async sendToMany(outputs: SendToManyOutput[]): Promise<SendToManyResult> {
  if (outputs.length === 0) throw new Error("no_outputs");
  const txid = createHash("sha256")
    .update(`mock-sweep:${outputs.length}:${Date.now()}`)
    .digest("hex");
  return { txid };
}
```

Add to `BitcoindRpcProvider`:

```typescript
async sendToMany(outputs: SendToManyOutput[]): Promise<SendToManyResult> {
  if (outputs.length === 0) throw new Error("no_outputs");
  const amounts: Record<string, number> = {};
  for (const out of outputs) {
    amounts[out.address] = (amounts[out.address] ?? 0) + out.amountSats / 1e8;
  }
  // sendtoaddress doesn't support multi-output; use createrawtransaction
  const utxos = (await this.rpc("listunspent", [1, 9999999])) as Array<{
    txid: string; vout: number; amount: number;
  }>;
  if (utxos.length === 0) throw new Error("bitcoind_no_utxos");
  // Select enough UTXOs to cover total + fee
  const totalBtc = outputs.reduce((s, o) => s + o.amountSats / 1e8, 0);
  const feeRate = ((await this.rpc("estimatesmartfee", [6])) as { feerate?: number }).feerate ?? 0.00001;
  const estVbytes = 10 + outputs.length * 34 + utxos.length * 68;
  const feeBtc = feeRate * estVbytes / 1000;
  let inputTotal = 0;
  const selectedUtxos: Array<{ txid: string; vout: number }> = [];
  for (const utxo of utxos) {
    selectedUtxos.push({ txid: utxo.txid, vout: utxo.vout });
    inputTotal += utxo.amount;
    if (inputTotal >= totalBtc + feeBtc) break;
  }
  if (inputTotal < totalBtc + feeBtc) throw new Error("bitcoind_insufficient_funds");
  const changeBtc = inputTotal - totalBtc - feeBtc;
  const txOutputs: Record<string, unknown>[] = [];
  for (const [addr, btc] of Object.entries(amounts)) {
    txOutputs.push({ [addr]: Number(btc.toFixed(8)) });
  }
  if (changeBtc > 0.00000546) {
    const changeAddr = (await this.rpc("getrawchangeaddress")) as string;
    txOutputs.push({ [changeAddr]: Number(changeBtc.toFixed(8)) });
  }
  const rawTx = (await this.rpc("createrawtransaction", [selectedUtxos, txOutputs])) as string;
  const signed = (await this.rpc("signrawtransactionwithwallet", [rawTx])) as {
    hex: string; complete: boolean;
  };
  if (!signed.complete) throw new Error("bitcoind_signing_incomplete");
  const txid = (await this.rpc("sendrawtransaction", [signed.hex])) as string;
  return { txid, rawHex: signed.hex };
}
```

Add stub to `BlockstreamProvider` and `AnchorProxyClientProvider`:

```typescript
async sendToMany(_outputs: SendToManyOutput[]): Promise<SendToManyResult> {
  throw new Error("sendToMany not supported by this provider");
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/economy/bitcoin-rpc.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/economy/bitcoin-rpc.ts tests/economy/bitcoin-rpc.test.ts
git commit -m "feat(economy): add sendToMany to BitcoinAnchorProvider for multi-output payouts"
```

---

### Task 3: Implement RobotQueue core — agent registration, task creation, claim

**Files:**
- Create: `src/swarm/robot-queue.ts`
- Create: `tests/swarm/robot-queue.test.ts`

**Step 1: Write failing tests for agent registration and task creation**

```typescript
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
    expect(task.coordinatorFeeSats).toBe(200); // 2% of 100000
    expect(task.rewardSats).toBe(99_800);
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
    const t2 = q.createTask({
      clientAccountId: "c1", title: "compute", description: "d",
      taskKind: "compute", resourceRequirements: ["gpu"],
      amountSats: 20_000, invoiceRef: "inv7"
    });
    q.markFunded(t1.taskId);
    q.markFunded(t2.taskId);
    const available = q.listAvailableTasks("r1");
    expect(available).toHaveLength(1);
    expect(available[0].taskId).toBe(t1.taskId);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/swarm/robot-queue.test.ts`
Expected: FAIL — module not found

**Step 3: Implement RobotQueue (agent registration, task creation, claim, list)**

Create `src/swarm/robot-queue.ts`:

```typescript
import { randomUUID } from "node:crypto";
import { computeIntentFee } from "./coordinator-utils.js";
import type {
  RobotAgent,
  RobotTask,
  RobotTaskKind,
  RobotEarningsEntry,
  RobotSweepEvent,
  RobotQueueConfig
} from "./robot-types.js";

export class RobotQueue {
  private readonly config: RobotQueueConfig;
  private readonly agents = new Map<string, RobotAgent>();
  private readonly tasks = new Map<string, RobotTask>();
  private readonly earnings: RobotEarningsEntry[] = [];
  private readonly sweeps: RobotSweepEvent[] = [];

  constructor(config: RobotQueueConfig) {
    this.config = config;
  }

  /* ---- Agent management ---- */

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

  /* ---- Task lifecycle ---- */

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
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/swarm/robot-queue.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/swarm/robot-queue.ts tests/swarm/robot-queue.test.ts
git commit -m "feat(robot): implement RobotQueue core — registration, task creation, claim"
```

---

### Task 4: Implement proof submission, settlement, and earnings accrual

**Files:**
- Modify: `src/swarm/robot-queue.ts`
- Modify: `tests/swarm/robot-queue.test.ts`

**Step 1: Write failing tests**

Add to `tests/swarm/robot-queue.test.ts`:

```typescript
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

  test("settles task and increments agent success count", () => {
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
    // Simulate passage of time by directly setting claimedAtMs in the past
    const t = q.getTask(task.taskId)!;
    (t as any).claimedAtMs = Date.now() - 1000;
    const expired = q.expireStale();
    expect(expired).toBe(1);
    expect(q.getTask(task.taskId)!.status).toBe("expired");
    expect(q.getAgent("r1")!.failureCount).toBe(1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/swarm/robot-queue.test.ts`
Expected: FAIL — submitProof, settleTask, etc. not defined

**Step 3: Implement the methods in RobotQueue**

Add to `src/swarm/robot-queue.ts` inside the class:

```typescript
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
```

**Step 4: Run tests**

Run: `npx vitest run tests/swarm/robot-queue.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/swarm/robot-queue.ts tests/swarm/robot-queue.test.ts
git commit -m "feat(robot): add proof submission, settlement, dispute, expiry, and earnings"
```

---

### Task 5: Implement sweep aggregation

**Files:**
- Modify: `src/swarm/robot-queue.ts`
- Modify: `tests/swarm/robot-queue.test.ts`

**Step 1: Write failing tests**

Add to `tests/swarm/robot-queue.test.ts`:

```typescript
describe("robot sweep aggregation", () => {
  test("aggregates accrued earnings by agent", () => {
    const q = makeQueue();
    q.registerAgent({ agentId: "r1", payoutAddress: "tb1q1", capabilities: [], robotKind: "rover" });
    q.registerAgent({ agentId: "r2", payoutAddress: "tb1q2", capabilities: [], robotKind: "drone" });

    // Settle two tasks for r1, one for r2
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
    expect(r1Payout.amountSats).toBe(49_800 * 2); // 2 tasks * (50000 - 2% fee)
    expect(r1Payout.address).toBe("tb1q1");
  });

  test("skips agents below minimum sweep threshold", () => {
    const q = new RobotQueue({
      coordinatorFeeBps: 200,
      defaultTimeoutMs: 3_600_000,
      autoSettleDelayMs: 86_400_000,
      sweepIntervalMs: 86_400_000,
      minSweepSats: 100_000, // High threshold
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
    expect(pending).toHaveLength(0); // Below 100k sats threshold
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
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/swarm/robot-queue.test.ts`
Expected: FAIL — pendingSweepPayouts, markSwept, status not defined

**Step 3: Implement sweep methods**

Add to `RobotQueue` class in `src/swarm/robot-queue.ts`:

```typescript
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
```

Add the import for `RobotSweepPayout` at the top of the file if not already present.

**Step 4: Run tests**

Run: `npx vitest run tests/swarm/robot-queue.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/swarm/robot-queue.ts tests/swarm/robot-queue.test.ts
git commit -m "feat(robot): add sweep aggregation, earnings marking, and queue status"
```

---

### Task 6: Implement robot routes

**Files:**
- Create: `src/swarm/robot-routes.ts`
- Create: `tests/swarm/robot-routes.test.ts`

**Step 1: Write failing tests for route validation helpers**

The codebase avoids `app.inject()`. We'll test the Zod schemas and validation logic directly.

Create `tests/swarm/robot-routes.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import {
  robotAgentRegisterSchema,
  robotTaskCreateSchema,
  robotProofSchema,
  robotDisputeSchema
} from "../../src/swarm/robot-routes.js";

describe("robot route schemas", () => {
  test("agent register schema validates valid input", () => {
    const result = robotAgentRegisterSchema.safeParse({
      agentId: "robot-1",
      payoutAddress: "tb1qtest123456",
      capabilities: ["camera", "gps"],
      robotKind: "rover"
    });
    expect(result.success).toBe(true);
  });

  test("agent register schema rejects missing payoutAddress", () => {
    const result = robotAgentRegisterSchema.safeParse({
      agentId: "robot-1",
      capabilities: [],
      robotKind: "rover"
    });
    expect(result.success).toBe(false);
  });

  test("task create schema validates valid input", () => {
    const result = robotTaskCreateSchema.safeParse({
      clientAccountId: "client-1",
      title: "Deliver package",
      description: "Deliver to XY",
      taskKind: "physical",
      resourceRequirements: ["gps"],
      amountSats: 100_000
    });
    expect(result.success).toBe(true);
  });

  test("task create schema rejects zero amountSats", () => {
    const result = robotTaskCreateSchema.safeParse({
      clientAccountId: "c1",
      title: "t",
      description: "d",
      taskKind: "compute",
      resourceRequirements: [],
      amountSats: 0
    });
    expect(result.success).toBe(false);
  });

  test("task create schema rejects invalid taskKind", () => {
    const result = robotTaskCreateSchema.safeParse({
      clientAccountId: "c1",
      title: "t",
      description: "d",
      taskKind: "invalid",
      resourceRequirements: [],
      amountSats: 1000
    });
    expect(result.success).toBe(false);
  });

  test("proof schema validates payload", () => {
    const result = robotProofSchema.safeParse({ payload: { gps: [1.0, 2.0] } });
    expect(result.success).toBe(true);
  });

  test("dispute schema validates reason", () => {
    const result = robotDisputeSchema.safeParse({ reason: "bad quality" });
    expect(result.success).toBe(true);
  });

  test("dispute schema rejects empty reason", () => {
    const result = robotDisputeSchema.safeParse({ reason: "" });
    expect(result.success).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/swarm/robot-routes.test.ts`
Expected: FAIL — module not found

**Step 3: Implement robot-routes.ts**

Create `src/swarm/robot-routes.ts`:

```typescript
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { RobotQueue } from "./robot-queue.js";

/* ---- Exported Zod schemas (testable) ---- */

export const robotAgentRegisterSchema = z.object({
  agentId: z.string().min(1),
  payoutAddress: z.string().min(1),
  capabilities: z.array(z.string()).default([]),
  robotKind: z.string().min(1)
});

export const robotAgentHeartbeatSchema = z.object({
  agentId: z.string().min(1)
});

export const robotTaskCreateSchema = z.object({
  clientAccountId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  taskKind: z.enum(["physical", "compute", "hybrid"]),
  resourceRequirements: z.array(z.string()).default([]),
  amountSats: z.number().int().positive().max(100_000_000),
  timeoutMs: z.number().int().positive().optional(),
  proofSchema: z.record(z.unknown()).optional()
});

export const robotClaimSchema = z.object({
  agentId: z.string().min(1)
});

export const robotProofSchema = z.object({
  payload: z.unknown()
});

export const robotDisputeSchema = z.object({
  reason: z.string().min(1)
});

/* ---- Route registration ---- */

export function registerRobotRoutes(
  app: FastifyInstance,
  queue: RobotQueue,
  deps: {
    hasMeshToken: (headers: Record<string, unknown>) => boolean;
    hasPortalServiceToken: (headers: Record<string, unknown>) => boolean;
    lightningProvider: {
      createInvoice(input: { amountSats: number; memo: string; expiresInSeconds: number }): Promise<{
        invoiceRef: string; paymentHash: string; expiresAtMs: number;
      }>;
      checkSettlement(invoiceRef: string): Promise<{ settled: boolean; txRef?: string }>;
    };
  }
): void {
  /* ---- Agent endpoints ---- */

  app.post("/robot/agents/register", async (req, reply) => {
    if (!deps.hasMeshToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = robotAgentRegisterSchema.parse(req.body);
    const agent = queue.registerAgent(body);
    return { ok: true, agent };
  });

  app.post("/robot/agents/heartbeat", async (req, reply) => {
    if (!deps.hasMeshToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = robotAgentHeartbeatSchema.parse(req.body);
    queue.heartbeat(body.agentId);
    return { ok: true };
  });

  /* ---- Task endpoints ---- */

  app.post("/robot/tasks", async (req, reply) => {
    if (!deps.hasPortalServiceToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const body = robotTaskCreateSchema.parse(req.body);
    const invoice = await deps.lightningProvider.createInvoice({
      amountSats: body.amountSats,
      memo: `robot_task:${body.clientAccountId}`,
      expiresInSeconds: 900
    });
    const task = queue.createTask({ ...body, invoiceRef: invoice.invoiceRef });
    return { ok: true, task, invoice };
  });

  app.get("/robot/tasks/available", async (req, reply) => {
    if (!deps.hasMeshToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const agentId = (req.query as Record<string, string>).agentId;
    if (!agentId) return reply.code(400).send({ error: "agentId_required" });
    const tasks = queue.listAvailableTasks(agentId);
    return { ok: true, tasks };
  });

  app.get("/robot/tasks/:taskId", async (req, reply) => {
    const { taskId } = req.params as { taskId: string };
    const task = queue.getTask(taskId);
    if (!task) return reply.code(404).send({ error: "task_not_found" });
    return { ok: true, task };
  });

  app.post("/robot/tasks/:taskId/claim", async (req, reply) => {
    if (!deps.hasMeshToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { taskId } = req.params as { taskId: string };
    const body = robotClaimSchema.parse(req.body);
    try {
      const task = queue.claimTask(taskId, body.agentId);
      return { ok: true, task };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: msg });
    }
  });

  app.post("/robot/tasks/:taskId/proof", async (req, reply) => {
    if (!deps.hasMeshToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { taskId } = req.params as { taskId: string };
    const { agentId } = (req.query as Record<string, string>);
    if (!agentId) return reply.code(400).send({ error: "agentId_required" });
    const body = robotProofSchema.parse(req.body);
    try {
      const task = queue.submitProof(taskId, agentId, body.payload);
      return { ok: true, task };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: msg });
    }
  });

  app.post("/robot/tasks/:taskId/settle", async (req, reply) => {
    if (!deps.hasPortalServiceToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { taskId } = req.params as { taskId: string };
    try {
      const task = queue.settleTask(taskId);
      return { ok: true, task };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: msg });
    }
  });

  app.post("/robot/tasks/:taskId/dispute", async (req, reply) => {
    if (!deps.hasPortalServiceToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { taskId } = req.params as { taskId: string };
    const body = robotDisputeSchema.parse(req.body);
    try {
      const task = queue.disputeTask(taskId, body.reason);
      return { ok: true, task };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(409).send({ error: msg });
    }
  });

  /* ---- Earnings & sweep ---- */

  app.get("/robot/agents/:agentId/earnings", async (req, reply) => {
    if (!deps.hasMeshToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const { agentId } = req.params as { agentId: string };
    const earnings = queue.getEarnings(agentId);
    const totalAccrued = earnings.filter((e) => e.status === "accrued").reduce((s, e) => s + e.earnedSats, 0);
    const totalSwept = earnings.filter((e) => e.status === "swept").reduce((s, e) => s + e.earnedSats, 0);
    return { ok: true, earnings, totalAccrued, totalSwept };
  });

  app.post("/robot/sweep", async (req, reply) => {
    if (!deps.hasPortalServiceToken(req.headers as Record<string, unknown>)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const payouts = queue.pendingSweepPayouts();
    if (payouts.length === 0) return { ok: true, message: "no_payouts_pending", payouts: [] };
    return { ok: true, pendingPayouts: payouts };
  });
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/swarm/robot-routes.test.ts`
Expected: All PASS

**Step 5: Commit**

```bash
git add src/swarm/robot-routes.ts tests/swarm/robot-routes.test.ts
git commit -m "feat(robot): add robot routes with Zod schemas and Fastify registration"
```

---

### Task 7: Integrate into coordinator.ts

**Files:**
- Modify: `src/swarm/coordinator.ts`

**Step 1: Read coordinator.ts to find exact integration points**

Find:
- The line where `new SwarmQueue` is created (around line 83)
- The line where `lightningProvider` is created
- The line where `bitcoinProvider` is created
- The area where `hasMeshToken` and `hasPortalServiceToken` are defined (after the imports)

**Step 2: Add imports and instantiation**

After the existing imports at the top of coordinator.ts, add:

```typescript
import { RobotQueue } from "./robot-queue.js";
import { registerRobotRoutes } from "./robot-routes.js";
```

Add env vars near the other env var declarations:

```typescript
const ROBOT_QUEUE_ENABLED = process.env.ROBOT_QUEUE_ENABLED === "true";
const ROBOT_COORDINATOR_FEE_BPS = Number(process.env.ROBOT_COORDINATOR_FEE_BPS ?? "200");
const ROBOT_SWEEP_INTERVAL_MS = Number(process.env.ROBOT_SWEEP_INTERVAL_MS ?? "86400000");
const ROBOT_MIN_SWEEP_SATS = Number(process.env.ROBOT_MIN_SWEEP_SATS ?? "10000");
const ROBOT_TASK_DEFAULT_TIMEOUT_MS = Number(process.env.ROBOT_TASK_DEFAULT_TIMEOUT_MS ?? "3600000");
const ROBOT_AUTO_SETTLE_DELAY_MS = Number(process.env.ROBOT_AUTO_SETTLE_DELAY_MS ?? "86400000");
```

After the `SwarmQueue` instantiation (around line 83), add:

```typescript
const robotQueue = ROBOT_QUEUE_ENABLED
  ? new RobotQueue({
      coordinatorFeeBps: ROBOT_COORDINATOR_FEE_BPS,
      defaultTimeoutMs: ROBOT_TASK_DEFAULT_TIMEOUT_MS,
      autoSettleDelayMs: ROBOT_AUTO_SETTLE_DELAY_MS,
      sweepIntervalMs: ROBOT_SWEEP_INTERVAL_MS,
      minSweepSats: ROBOT_MIN_SWEEP_SATS,
      bitcoinNetwork: BITCOIN_NETWORK
    })
  : null;

if (robotQueue) {
  registerRobotRoutes(app, robotQueue, {
    hasMeshToken: (headers) => hasMeshToken(headers),
    hasPortalServiceToken: (headers) => hasPortalServiceToken(headers),
    lightningProvider
  });
}
```

**Step 3: Verify everything compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All existing + new tests pass

**Step 5: Commit**

```bash
git add src/swarm/coordinator.ts
git commit -m "feat(robot): integrate robot queue into coordinator with feature flag"
```

---

### Task 8: Final verification

**Step 1: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 2: Full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing + robot-queue + robot-routes + bitcoin-rpc additions)

**Step 3: Verify no regressions**

Confirm the existing 71 test files still pass with no behavioral changes.

---

## File Summary

| File | Action |
|------|--------|
| `src/swarm/robot-types.ts` | **Create** — type definitions |
| `src/swarm/robot-queue.ts` | **Create** — RobotQueue class |
| `src/swarm/robot-routes.ts` | **Create** — Fastify route registration + Zod schemas |
| `src/economy/bitcoin-rpc.ts` | **Modify** — add `sendToMany` to provider interface |
| `src/swarm/coordinator.ts` | **Modify** — 15-line integration behind feature flag |
| `tests/swarm/robot-queue.test.ts` | **Create** — ~25 queue logic tests |
| `tests/swarm/robot-routes.test.ts` | **Create** — ~8 schema validation tests |
| `tests/economy/bitcoin-rpc.test.ts` | **Modify** — add sendToMany tests |
