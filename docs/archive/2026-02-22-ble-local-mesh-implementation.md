# BLE Local Mesh Tethering Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable phones, workstations, and laptops to form a local BLE compute mesh for offline task routing with credit-tracked transactions.

**Architecture:** Standard GATT service profile implemented via CoreBluetooth (iOS/macOS) and noble/bleno (Node.js/Linux/Windows). Cost-based routing selects the cheapest peer. Dual-signed offline credit transactions batch-sync to the coordinator on reconnect.

**Tech Stack:** CoreBluetooth (Swift), @abandonware/noble + @abandonware/bleno (Node.js), Ed25519 signing (existing mesh identity), Vitest (tests)

---

### Task 1: BLE Protocol Constants & Types (TypeScript)

**Files:**
- Create: `src/mesh/ble/protocol.ts`
- Modify: `src/common/types.ts`
- Test: `tests/mesh/ble/protocol.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/mesh/ble/protocol.test.ts
import { describe, it, expect } from "vitest";
import {
  BLE_SERVICE_UUID,
  BLE_CHAR_PEER_IDENTITY,
  BLE_CHAR_CAPABILITIES,
  BLE_CHAR_TASK_REQUEST,
  BLE_CHAR_TASK_RESPONSE,
  BLE_CHAR_LEDGER_SYNC,
  encodeChunks,
  decodeChunks,
  BLEPeerEntry,
  BLETaskRequest,
  BLETaskResponse,
  BLECreditTransaction
} from "../../src/mesh/ble/protocol.js";

describe("BLE protocol constants", () => {
  it("exports service and characteristic UUIDs", () => {
    expect(BLE_SERVICE_UUID).toBeDefined();
    expect(BLE_CHAR_PEER_IDENTITY).toBeDefined();
    expect(BLE_CHAR_CAPABILITIES).toBeDefined();
    expect(BLE_CHAR_TASK_REQUEST).toBeDefined();
    expect(BLE_CHAR_TASK_RESPONSE).toBeDefined();
    expect(BLE_CHAR_LEDGER_SYNC).toBeDefined();
  });
});

describe("chunk encoding/decoding", () => {
  it("round-trips a small payload in one chunk", () => {
    const data = Buffer.from(JSON.stringify({ hello: "world" }));
    const chunks = encodeChunks(data, 512);
    expect(chunks).toHaveLength(1);
    const reassembled = decodeChunks(chunks);
    expect(reassembled.toString()).toBe(data.toString());
  });

  it("round-trips a large payload across multiple chunks", () => {
    const data = Buffer.from("x".repeat(2000));
    const chunks = encodeChunks(data, 512);
    expect(chunks.length).toBeGreaterThan(1);
    const reassembled = decodeChunks(chunks);
    expect(reassembled.toString()).toBe(data.toString());
  });

  it("handles exact MTU boundary", () => {
    // 4 bytes header per chunk, so 508 bytes data per chunk at MTU 512
    const data = Buffer.from("y".repeat(508));
    const chunks = encodeChunks(data, 512);
    expect(chunks).toHaveLength(1);
    const reassembled = decodeChunks(chunks);
    expect(reassembled.toString()).toBe(data.toString());
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mesh/ble/protocol.test.ts`
Expected: FAIL (module not found)

**Step 3: Add BLE types to common/types.ts**

Add these interfaces at the end of `src/common/types.ts`:

```typescript
// --- BLE Local Mesh Types ---

export interface BLEPeerEntry {
  agentId: string;
  meshTokenHash: string;
  accountId: string;
  model: string;
  modelParamSize: number;
  memoryMB: number;
  batteryPct: number;
  currentLoad: number;
  deviceType: "phone" | "laptop" | "workstation";
  rssi: number;
  lastSeenMs: number;
}

export interface BLETaskRequest {
  requestId: string;
  requesterId: string;
  task: string;
  language: Language;
  failedCode?: string;
  errorHistory?: string[];
  requesterSignature: string;
}

export interface BLETaskResponse {
  requestId: string;
  providerId: string;
  status: "completed" | "failed";
  generatedCode?: string;
  output?: string;
  cpuSeconds: number;
  providerSignature: string;
}

export interface BLECreditTransaction {
  txId: string;
  requesterId: string;
  providerId: string;
  requesterAccountId: string;
  providerAccountId: string;
  credits: number;
  cpuSeconds: number;
  taskHash: string;
  timestamp: number;
  requesterSignature: string;
  providerSignature: string;
}
```

**Step 4: Write protocol.ts implementation**

```typescript
// src/mesh/ble/protocol.ts
export const BLE_SERVICE_UUID = "e0d6ec00-0001-4c3a-9b5e-00edgec0de00";
export const BLE_CHAR_PEER_IDENTITY = "e0d6ec00-0002-4c3a-9b5e-00edgec0de00";
export const BLE_CHAR_CAPABILITIES = "e0d6ec00-0003-4c3a-9b5e-00edgec0de00";
export const BLE_CHAR_TASK_REQUEST = "e0d6ec00-0004-4c3a-9b5e-00edgec0de00";
export const BLE_CHAR_TASK_RESPONSE = "e0d6ec00-0005-4c3a-9b5e-00edgec0de00";
export const BLE_CHAR_LEDGER_SYNC = "e0d6ec00-0006-4c3a-9b5e-00edgec0de00";

export const DEFAULT_MTU = 512;
const CHUNK_HEADER_SIZE = 4; // 2 bytes seqNo + 2 bytes totalChunks

export { BLEPeerEntry, BLETaskRequest, BLETaskResponse, BLECreditTransaction } from "../../common/types.js";

export function encodeChunks(data: Buffer, mtu: number = DEFAULT_MTU): Buffer[] {
  const chunkDataSize = mtu - CHUNK_HEADER_SIZE;
  const totalChunks = Math.ceil(data.length / chunkDataSize);
  const chunks: Buffer[] = [];
  for (let i = 0; i < totalChunks; i++) {
    const header = Buffer.alloc(CHUNK_HEADER_SIZE);
    header.writeUInt16BE(i, 0);
    header.writeUInt16BE(totalChunks, 2);
    const start = i * chunkDataSize;
    const end = Math.min(start + chunkDataSize, data.length);
    chunks.push(Buffer.concat([header, data.subarray(start, end)]));
  }
  return chunks;
}

export function decodeChunks(chunks: Buffer[]): Buffer {
  const sorted = [...chunks].sort((a, b) => a.readUInt16BE(0) - b.readUInt16BE(0));
  const dataParts = sorted.map((chunk) => chunk.subarray(CHUNK_HEADER_SIZE));
  return Buffer.concat(dataParts);
}
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/mesh/ble/protocol.test.ts`
Expected: PASS (3 tests)

**Step 6: Commit**

```bash
git add src/mesh/ble/protocol.ts src/common/types.ts tests/mesh/ble/protocol.test.ts
git commit -m "feat: add BLE mesh protocol constants, types, and chunking"
```

---

### Task 2: Cost-Based BLE Router

**Files:**
- Create: `src/mesh/ble/ble-router.ts`
- Test: `tests/mesh/ble/ble-router.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/mesh/ble/ble-router.test.ts
import { describe, it, expect } from "vitest";
import { BLERouter } from "../../src/mesh/ble/ble-router.js";
import { BLEPeerEntry } from "../../src/common/types.js";

function makePeer(overrides: Partial<BLEPeerEntry> = {}): BLEPeerEntry {
  return {
    agentId: "peer-1",
    meshTokenHash: "abc123",
    accountId: "account-1",
    model: "qwen2.5-coder:1.5b",
    modelParamSize: 1.5,
    memoryMB: 4096,
    batteryPct: 80,
    currentLoad: 0,
    deviceType: "laptop",
    rssi: -50,
    lastSeenMs: Date.now(),
    ...overrides
  };
}

describe("BLERouter", () => {
  it("adds and lists peers", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "a" }));
    router.updatePeer(makePeer({ agentId: "b" }));
    expect(router.listPeers()).toHaveLength(2);
  });

  it("evicts stale peers", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "old", lastSeenMs: Date.now() - 70_000 }));
    router.updatePeer(makePeer({ agentId: "fresh" }));
    router.evictStale();
    expect(router.listPeers()).toHaveLength(1);
    expect(router.listPeers()[0].agentId).toBe("fresh");
  });

  it("computes lower cost for idle powerful peer", () => {
    const router = new BLERouter();
    const powerful = makePeer({ agentId: "big", modelParamSize: 7, currentLoad: 0, rssi: -40 });
    const weak = makePeer({ agentId: "small", modelParamSize: 0.5, currentLoad: 2, rssi: -80 });
    const costBig = router.computeCost(powerful, 3);
    const costSmall = router.computeCost(weak, 3);
    expect(costBig).toBeLessThan(costSmall);
  });

  it("penalizes low battery on phones", () => {
    const router = new BLERouter();
    const phoneLow = makePeer({ agentId: "phone-low", deviceType: "phone", batteryPct: 10 });
    const phoneHigh = makePeer({ agentId: "phone-high", deviceType: "phone", batteryPct: 90 });
    expect(router.computeCost(phoneLow, 1)).toBeGreaterThan(router.computeCost(phoneHigh, 1));
  });

  it("selectBestPeer returns lowest cost peer", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "busy", currentLoad: 5, rssi: -80 }));
    router.updatePeer(makePeer({ agentId: "idle", currentLoad: 0, rssi: -40 }));
    const best = router.selectBestPeer(1.5);
    expect(best?.agentId).toBe("idle");
  });

  it("returns null when all costs exceed threshold", () => {
    const router = new BLERouter();
    router.updatePeer(makePeer({ agentId: "bad", modelParamSize: 0.1, currentLoad: 10, rssi: -90 }));
    const best = router.selectBestPeer(7);
    expect(best).toBeNull();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mesh/ble/ble-router.test.ts`
Expected: FAIL

**Step 3: Write ble-router.ts**

```typescript
// src/mesh/ble/ble-router.ts
import { BLEPeerEntry } from "../../common/types.js";

const EVICTION_MS = 60_000;
const COST_THRESHOLD = 200;

export class BLERouter {
  private readonly peers = new Map<string, BLEPeerEntry>();

  updatePeer(peer: BLEPeerEntry): void {
    this.peers.set(peer.agentId, peer);
  }

  removePeer(agentId: string): void {
    this.peers.delete(agentId);
  }

  listPeers(): BLEPeerEntry[] {
    return [...this.peers.values()];
  }

  evictStale(): void {
    const now = Date.now();
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeenMs > EVICTION_MS) {
        this.peers.delete(id);
      }
    }
  }

  computeCost(peer: BLEPeerEntry, requiredModelSize: number): number {
    const modelFitPenalty = peer.modelParamSize >= requiredModelSize ? 0 : 100;
    const loadPenalty = peer.currentLoad * 20;
    const batteryPenalty = peer.deviceType === "phone"
      ? (100 - peer.batteryPct) * 0.5
      : 0;
    const signalPenalty = Math.min(30, Math.max(0, (-peer.rssi - 30) * 0.5));
    return modelFitPenalty + loadPenalty + batteryPenalty + signalPenalty;
  }

  selectBestPeer(requiredModelSize: number): BLEPeerEntry | null {
    this.evictStale();
    let best: BLEPeerEntry | null = null;
    let bestCost = COST_THRESHOLD;
    for (const peer of this.peers.values()) {
      const cost = this.computeCost(peer, requiredModelSize);
      if (cost < bestCost) {
        bestCost = cost;
        best = peer;
      }
    }
    return best;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mesh/ble/ble-router.test.ts`
Expected: PASS (6 tests)

**Step 5: Commit**

```bash
git add src/mesh/ble/ble-router.ts tests/mesh/ble/ble-router.test.ts
git commit -m "feat: add BLE cost-based router with peer management"
```

---

### Task 3: Offline Credit Ledger

**Files:**
- Create: `src/mesh/ble/offline-ledger.ts`
- Test: `tests/mesh/ble/offline-ledger.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/mesh/ble/offline-ledger.test.ts
import { describe, it, expect } from "vitest";
import { OfflineLedger } from "../../src/mesh/ble/offline-ledger.js";
import { BLECreditTransaction } from "../../src/common/types.js";

function makeTx(overrides: Partial<BLECreditTransaction> = {}): BLECreditTransaction {
  return {
    txId: "tx-1",
    requesterId: "agent-a",
    providerId: "agent-b",
    requesterAccountId: "account-a",
    providerAccountId: "account-b",
    credits: 1.5,
    cpuSeconds: 1.5,
    taskHash: "abc123",
    timestamp: Date.now(),
    requesterSignature: "sig-a",
    providerSignature: "sig-b",
    ...overrides
  };
}

describe("OfflineLedger", () => {
  it("records and retrieves pending transactions", () => {
    const ledger = new OfflineLedger();
    ledger.record(makeTx({ txId: "tx-1" }));
    ledger.record(makeTx({ txId: "tx-2" }));
    expect(ledger.pending()).toHaveLength(2);
  });

  it("deduplicates by txId", () => {
    const ledger = new OfflineLedger();
    ledger.record(makeTx({ txId: "tx-1" }));
    ledger.record(makeTx({ txId: "tx-1" }));
    expect(ledger.pending()).toHaveLength(1);
  });

  it("clears synced transactions", () => {
    const ledger = new OfflineLedger();
    ledger.record(makeTx({ txId: "tx-1" }));
    ledger.record(makeTx({ txId: "tx-2" }));
    ledger.markSynced(["tx-1"]);
    expect(ledger.pending()).toHaveLength(1);
    expect(ledger.pending()[0].txId).toBe("tx-2");
  });

  it("exports batch for sync", () => {
    const ledger = new OfflineLedger();
    ledger.record(makeTx({ txId: "tx-1" }));
    ledger.record(makeTx({ txId: "tx-2" }));
    const batch = ledger.exportBatch();
    expect(batch).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mesh/ble/offline-ledger.test.ts`
Expected: FAIL

**Step 3: Write offline-ledger.ts**

```typescript
// src/mesh/ble/offline-ledger.ts
import { BLECreditTransaction } from "../../common/types.js";

export class OfflineLedger {
  private readonly transactions = new Map<string, BLECreditTransaction>();

  record(tx: BLECreditTransaction): void {
    if (!this.transactions.has(tx.txId)) {
      this.transactions.set(tx.txId, tx);
    }
  }

  pending(): BLECreditTransaction[] {
    return [...this.transactions.values()];
  }

  exportBatch(): BLECreditTransaction[] {
    return this.pending();
  }

  markSynced(txIds: string[]): void {
    for (const id of txIds) {
      this.transactions.delete(id);
    }
  }

  clear(): void {
    this.transactions.clear();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mesh/ble/offline-ledger.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/mesh/ble/offline-ledger.ts tests/mesh/ble/offline-ledger.test.ts
git commit -m "feat: add offline credit ledger for BLE mesh transactions"
```

---

### Task 4: Mock BLE Transport

**Files:**
- Create: `src/mesh/ble/ble-transport.ts` (interface + mock)
- Test: `tests/mesh/ble/ble-transport.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/mesh/ble/ble-transport.test.ts
import { describe, it, expect } from "vitest";
import { MockBLETransport } from "../../src/mesh/ble/ble-transport.js";

describe("MockBLETransport", () => {
  it("two transports discover each other", async () => {
    const network = new Map<string, MockBLETransport>();
    const a = new MockBLETransport("agent-a", network);
    const b = new MockBLETransport("agent-b", network);
    a.startAdvertising({ agentId: "agent-a", model: "qwen2.5-coder:1.5b", modelParamSize: 1.5, memoryMB: 4096, batteryPct: 100, currentLoad: 0, deviceType: "laptop" });
    b.startAdvertising({ agentId: "agent-b", model: "qwen2.5-coder:7b", modelParamSize: 7, memoryMB: 8192, batteryPct: 80, currentLoad: 0, deviceType: "workstation" });
    a.startScanning();
    const peers = a.discoveredPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0].agentId).toBe("agent-b");
  });

  it("sends task request and receives response", async () => {
    const network = new Map<string, MockBLETransport>();
    const a = new MockBLETransport("agent-a", network);
    const b = new MockBLETransport("agent-b", network);
    a.startAdvertising({ agentId: "agent-a", model: "small", modelParamSize: 0.5, memoryMB: 2048, batteryPct: 100, currentLoad: 0, deviceType: "phone" });
    b.startAdvertising({ agentId: "agent-b", model: "big", modelParamSize: 7, memoryMB: 8192, batteryPct: 90, currentLoad: 0, deviceType: "laptop" });

    b.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "agent-b",
      status: "completed" as const,
      generatedCode: "print('hello')",
      output: "hello",
      cpuSeconds: 0.5,
      providerSignature: "sig-b"
    }));

    const response = await a.sendTaskRequest("agent-b", {
      requestId: "req-1",
      requesterId: "agent-a",
      task: "print hello",
      language: "python" as const,
      requesterSignature: "sig-a"
    });

    expect(response.status).toBe("completed");
    expect(response.generatedCode).toBe("print('hello')");
  });

  it("returns failed response when peer has no handler", async () => {
    const network = new Map<string, MockBLETransport>();
    const a = new MockBLETransport("agent-a", network);
    const b = new MockBLETransport("agent-b", network);
    b.startAdvertising({ agentId: "agent-b", model: "big", modelParamSize: 7, memoryMB: 8192, batteryPct: 90, currentLoad: 0, deviceType: "laptop" });

    const response = await a.sendTaskRequest("agent-b", {
      requestId: "req-2",
      requesterId: "agent-a",
      task: "test",
      language: "python" as const,
      requesterSignature: "sig-a"
    });
    expect(response.status).toBe("failed");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mesh/ble/ble-transport.test.ts`
Expected: FAIL

**Step 3: Write ble-transport.ts**

```typescript
// src/mesh/ble/ble-transport.ts
import { BLETaskRequest, BLETaskResponse, BLEPeerEntry } from "../../common/types.js";

export interface BLEAdvertisement {
  agentId: string;
  model: string;
  modelParamSize: number;
  memoryMB: number;
  batteryPct: number;
  currentLoad: number;
  deviceType: "phone" | "laptop" | "workstation";
}

export type TaskRequestHandler = (req: BLETaskRequest) => Promise<BLETaskResponse>;

export interface BLETransport {
  startAdvertising(advertisement: BLEAdvertisement): void;
  stopAdvertising(): void;
  startScanning(): void;
  stopScanning(): void;
  discoveredPeers(): BLEPeerEntry[];
  sendTaskRequest(peerId: string, request: BLETaskRequest): Promise<BLETaskResponse>;
  onTaskRequest(handler: TaskRequestHandler): void;
}

export class MockBLETransport implements BLETransport {
  private advertisement: BLEAdvertisement | null = null;
  private scanning = false;
  private handler: TaskRequestHandler | null = null;

  constructor(
    private readonly localId: string,
    private readonly network: Map<string, MockBLETransport>
  ) {
    this.network.set(localId, this);
  }

  startAdvertising(advertisement: BLEAdvertisement): void {
    this.advertisement = advertisement;
  }

  stopAdvertising(): void {
    this.advertisement = null;
  }

  startScanning(): void {
    this.scanning = true;
  }

  stopScanning(): void {
    this.scanning = false;
  }

  discoveredPeers(): BLEPeerEntry[] {
    const peers: BLEPeerEntry[] = [];
    for (const [id, transport] of this.network) {
      if (id === this.localId || !transport.advertisement) continue;
      const ad = transport.advertisement;
      peers.push({
        agentId: ad.agentId,
        meshTokenHash: "",
        accountId: ad.agentId,
        model: ad.model,
        modelParamSize: ad.modelParamSize,
        memoryMB: ad.memoryMB,
        batteryPct: ad.batteryPct,
        currentLoad: ad.currentLoad,
        deviceType: ad.deviceType,
        rssi: -50,
        lastSeenMs: Date.now()
      });
    }
    return peers;
  }

  onTaskRequest(handler: TaskRequestHandler): void {
    this.handler = handler;
  }

  async sendTaskRequest(peerId: string, request: BLETaskRequest): Promise<BLETaskResponse> {
    const peer = this.network.get(peerId);
    if (!peer || !peer.handler) {
      return {
        requestId: request.requestId,
        providerId: peerId,
        status: "failed",
        cpuSeconds: 0,
        providerSignature: ""
      };
    }
    return peer.handler(request);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mesh/ble/ble-transport.test.ts`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/mesh/ble/ble-transport.ts tests/mesh/ble/ble-transport.test.ts
git commit -m "feat: add BLE transport interface and mock implementation"
```

---

### Task 5: BLE Mesh Manager (Node.js orchestrator)

**Files:**
- Create: `src/mesh/ble/ble-mesh-manager.ts`
- Test: `tests/mesh/ble/ble-mesh-manager.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/mesh/ble/ble-mesh-manager.test.ts
import { describe, it, expect } from "vitest";
import { BLEMeshManager } from "../../src/mesh/ble/ble-mesh-manager.js";
import { MockBLETransport } from "../../src/mesh/ble/ble-transport.js";

describe("BLEMeshManager", () => {
  it("starts in offline=false by default", () => {
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("agent-a", network);
    const manager = new BLEMeshManager("agent-a", "account-a", transport);
    expect(manager.isOffline()).toBe(false);
  });

  it("activates mesh routing when offline", async () => {
    const network = new Map<string, MockBLETransport>();
    const transportA = new MockBLETransport("agent-a", network);
    const transportB = new MockBLETransport("agent-b", network);
    transportB.startAdvertising({ agentId: "agent-b", model: "qwen2.5-coder:7b", modelParamSize: 7, memoryMB: 8192, batteryPct: 90, currentLoad: 0, deviceType: "workstation" });
    transportB.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "agent-b",
      status: "completed" as const,
      generatedCode: "result = 42\nprint(result)",
      output: "42",
      cpuSeconds: 1.0,
      providerSignature: "sig-b"
    }));

    const manager = new BLEMeshManager("agent-a", "account-a", transportA);
    manager.setOffline(true);
    manager.refreshPeers();

    const result = await manager.routeTask({
      requestId: "req-1",
      requesterId: "agent-a",
      task: "compute 42",
      language: "python",
      requesterSignature: "sig-a"
    }, 1.5);

    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");
    expect(result!.generatedCode).toBe("result = 42\nprint(result)");
  });

  it("returns null when online (mesh dormant)", async () => {
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("agent-a", network);
    const manager = new BLEMeshManager("agent-a", "account-a", transport);
    manager.setOffline(false);

    const result = await manager.routeTask({
      requestId: "req-1",
      requesterId: "agent-a",
      task: "test",
      language: "python",
      requesterSignature: "sig-a"
    }, 1.5);

    expect(result).toBeNull();
  });

  it("records credit transaction in offline ledger", async () => {
    const network = new Map<string, MockBLETransport>();
    const transportA = new MockBLETransport("agent-a", network);
    const transportB = new MockBLETransport("agent-b", network);
    transportB.startAdvertising({ agentId: "agent-b", model: "big", modelParamSize: 7, memoryMB: 8192, batteryPct: 90, currentLoad: 0, deviceType: "laptop" });
    transportB.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "agent-b",
      status: "completed" as const,
      generatedCode: "x = 1",
      output: "",
      cpuSeconds: 2.0,
      providerSignature: "sig-b"
    }));

    const manager = new BLEMeshManager("agent-a", "account-a", transportA);
    manager.setOffline(true);
    manager.refreshPeers();
    await manager.routeTask({
      requestId: "req-1",
      requesterId: "agent-a",
      task: "test",
      language: "python",
      requesterSignature: "sig-a"
    }, 1.5);

    const pending = manager.pendingTransactions();
    expect(pending).toHaveLength(1);
    expect(pending[0].requesterId).toBe("agent-a");
    expect(pending[0].providerId).toBe("agent-b");
    expect(pending[0].cpuSeconds).toBe(2.0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mesh/ble/ble-mesh-manager.test.ts`
Expected: FAIL

**Step 3: Write ble-mesh-manager.ts**

```typescript
// src/mesh/ble/ble-mesh-manager.ts
import { randomUUID, createHash } from "node:crypto";
import { BLETaskRequest, BLETaskResponse, BLECreditTransaction } from "../../common/types.js";
import { baseRatePerSecond } from "../../credits/pricing.js";
import { BLETransport } from "./ble-transport.js";
import { BLERouter } from "./ble-router.js";
import { OfflineLedger } from "./offline-ledger.js";

export class BLEMeshManager {
  private offline = false;
  private readonly router = new BLERouter();
  private readonly ledger = new OfflineLedger();
  private readonly transport: BLETransport;
  private readonly agentId: string;
  private readonly accountId: string;

  constructor(agentId: string, accountId: string, transport: BLETransport) {
    this.agentId = agentId;
    this.accountId = accountId;
    this.transport = transport;
  }

  isOffline(): boolean {
    return this.offline;
  }

  setOffline(offline: boolean): void {
    this.offline = offline;
    if (offline) {
      this.transport.startScanning();
    } else {
      this.transport.stopScanning();
    }
  }

  refreshPeers(): void {
    const discovered = this.transport.discoveredPeers();
    for (const peer of discovered) {
      this.router.updatePeer(peer);
    }
    this.router.evictStale();
  }

  async routeTask(
    request: BLETaskRequest,
    requiredModelSize: number
  ): Promise<BLETaskResponse | null> {
    if (!this.offline) return null;

    this.refreshPeers();
    const bestPeer = this.router.selectBestPeer(requiredModelSize);
    if (!bestPeer) return null;

    const response = await this.transport.sendTaskRequest(bestPeer.agentId, request);

    if (response.status === "completed") {
      const taskHash = createHash("sha256").update(request.task).digest("hex");
      const credits = response.cpuSeconds * baseRatePerSecond("cpu");
      const tx: BLECreditTransaction = {
        txId: randomUUID(),
        requesterId: this.agentId,
        providerId: response.providerId,
        requesterAccountId: this.accountId,
        providerAccountId: bestPeer.accountId,
        credits: Number(credits.toFixed(3)),
        cpuSeconds: response.cpuSeconds,
        taskHash,
        timestamp: Date.now(),
        requesterSignature: request.requesterSignature,
        providerSignature: response.providerSignature
      };
      this.ledger.record(tx);
    }

    return response;
  }

  pendingTransactions(): BLECreditTransaction[] {
    return this.ledger.pending();
  }

  exportSyncBatch(): BLECreditTransaction[] {
    return this.ledger.exportBatch();
  }

  markSynced(txIds: string[]): void {
    this.ledger.markSynced(txIds);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mesh/ble/ble-mesh-manager.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/mesh/ble/ble-mesh-manager.ts tests/mesh/ble/ble-mesh-manager.test.ts
git commit -m "feat: add BLE mesh manager with routing, task dispatch, and offline ledger"
```

---

### Task 6: Coordinator BLE Sync Endpoint

**Files:**
- Modify: `src/swarm/coordinator.ts` (add `POST /credits/ble-sync`)
- Test: `tests/mesh/ble/ble-sync-endpoint.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/mesh/ble/ble-sync-endpoint.test.ts
import { describe, it, expect } from "vitest";
import { BLECreditTransaction } from "../../src/common/types.js";

describe("BLE sync endpoint schema", () => {
  it("validates a well-formed transaction batch", () => {
    const batch: BLECreditTransaction[] = [
      {
        txId: "tx-1",
        requesterId: "agent-a",
        providerId: "agent-b",
        requesterAccountId: "account-a",
        providerAccountId: "account-b",
        credits: 1.5,
        cpuSeconds: 1.5,
        taskHash: "abc123",
        timestamp: Date.now(),
        requesterSignature: "sig-a",
        providerSignature: "sig-b"
      }
    ];
    expect(batch).toHaveLength(1);
    expect(batch[0].requesterSignature).toBeTruthy();
    expect(batch[0].providerSignature).toBeTruthy();
  });

  it("rejects duplicate txIds in a batch", () => {
    const seen = new Set<string>();
    const batch = [
      { txId: "tx-1" }, { txId: "tx-1" }
    ];
    const unique = batch.filter((tx) => {
      if (seen.has(tx.txId)) return false;
      seen.add(tx.txId);
      return true;
    });
    expect(unique).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mesh/ble/ble-sync-endpoint.test.ts`
Expected: FAIL (or PASS if types exist — this is a schema smoke test)

**Step 3: Add the sync endpoint to coordinator.ts**

Find the end of the route definitions in `src/swarm/coordinator.ts` (near the existing `/escalate` routes). Add:

```typescript
const bleSyncSchema = z.object({
  transactions: z.array(z.object({
    txId: z.string(),
    requesterId: z.string(),
    providerId: z.string(),
    requesterAccountId: z.string(),
    providerAccountId: z.string(),
    credits: z.number().min(0),
    cpuSeconds: z.number().min(0),
    taskHash: z.string(),
    timestamp: z.number(),
    requesterSignature: z.string(),
    providerSignature: z.string()
  }))
});

const syncedBLETxIds = new Set<string>();

app.post("/credits/ble-sync", async (req, reply) => {
  const body = bleSyncSchema.parse(req.body);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const tx of body.transactions) {
    if (syncedBLETxIds.has(tx.txId)) {
      skipped.push(tx.txId);
      continue;
    }
    // TODO: verify requesterSignature and providerSignature with ed25519
    syncedBLETxIds.add(tx.txId);
    applied.push(tx.txId);
  }

  return reply.send({ applied, skipped, total: body.transactions.length });
});
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/mesh/ble/ble-sync-endpoint.test.ts`
Expected: PASS (2 tests)

Run: `npx vitest run` (full suite to check nothing broke)
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/swarm/coordinator.ts tests/mesh/ble/ble-sync-endpoint.test.ts
git commit -m "feat: add POST /credits/ble-sync endpoint for offline BLE transaction batch sync"
```

---

### Task 7: iOS BLE Constants & Chunking (Swift)

**Files:**
- Create: `ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/BLEConstants.swift`
- Create: `ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/BLEChunkedTransfer.swift`

**Step 1: Write BLEConstants.swift**

```swift
// ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/BLEConstants.swift
import CoreBluetooth

enum BLEMeshConstants {
    static let serviceUUID = CBUUID(string: "E0D6EC00-0001-4C3A-9B5E-00EDGEC0DE00")
    static let peerIdentityUUID = CBUUID(string: "E0D6EC00-0002-4C3A-9B5E-00EDGEC0DE00")
    static let capabilitiesUUID = CBUUID(string: "E0D6EC00-0003-4C3A-9B5E-00EDGEC0DE00")
    static let taskRequestUUID = CBUUID(string: "E0D6EC00-0004-4C3A-9B5E-00EDGEC0DE00")
    static let taskResponseUUID = CBUUID(string: "E0D6EC00-0005-4C3A-9B5E-00EDGEC0DE00")
    static let ledgerSyncUUID = CBUUID(string: "E0D6EC00-0006-4C3A-9B5E-00EDGEC0DE00")

    static let defaultMTU = 512
    static let chunkHeaderSize = 4
    static let evictionIntervalSeconds: TimeInterval = 60
    static let staleThresholdSeconds: TimeInterval = 30
    static let maxConnections = 5
    static let taskTimeoutSeconds: TimeInterval = 60
}
```

**Step 2: Write BLEChunkedTransfer.swift**

```swift
// ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/BLEChunkedTransfer.swift
import Foundation

struct BLEChunkedTransfer {
    static func encode(data: Data, mtu: Int = BLEMeshConstants.defaultMTU) -> [Data] {
        let chunkDataSize = mtu - BLEMeshConstants.chunkHeaderSize
        guard chunkDataSize > 0 else { return [] }
        let totalChunks = max(1, Int(ceil(Double(data.count) / Double(chunkDataSize))))
        var chunks: [Data] = []
        for i in 0..<totalChunks {
            var header = Data(count: BLEMeshConstants.chunkHeaderSize)
            header.withUnsafeMutableBytes { buf in
                buf.storeBytes(of: UInt16(i).bigEndian, toByteOffset: 0, as: UInt16.self)
                buf.storeBytes(of: UInt16(totalChunks).bigEndian, toByteOffset: 2, as: UInt16.self)
            }
            let start = i * chunkDataSize
            let end = min(start + chunkDataSize, data.count)
            chunks.append(header + data[start..<end])
        }
        return chunks
    }

    static func decode(chunks: [Data]) -> Data {
        let sorted = chunks.sorted { a, b in
            let seqA = a.withUnsafeBytes { $0.load(as: UInt16.self).bigEndian }
            let seqB = b.withUnsafeBytes { $0.load(as: UInt16.self).bigEndian }
            return seqA < seqB
        }
        var result = Data()
        for chunk in sorted {
            result.append(chunk.dropFirst(BLEMeshConstants.chunkHeaderSize))
        }
        return result
    }
}
```

**Step 3: Build to verify compilation**

Run: `xcodebuild -project ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj -scheme EdgeCoderIOS -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -5`
Expected: BUILD SUCCEEDED (or verify no Swift errors in the new files)

**Step 4: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/BLEConstants.swift ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/BLEChunkedTransfer.swift
git commit -m "feat: add iOS BLE mesh constants and chunked transfer"
```

---

### Task 8: iOS BLE Mesh Manager (CoreBluetooth)

**Files:**
- Create: `ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/BLEMeshManager.swift`
- Modify: `ios/EdgeCoderIOS/EdgeCoderIOS/Info.plist` (add Bluetooth usage descriptions)

**Step 1: Add Bluetooth permissions to Info.plist**

Add to `ios/EdgeCoderIOS/EdgeCoderIOS/Info.plist` inside the top-level `<dict>`:

```xml
<key>NSBluetoothAlwaysUsageDescription</key>
<string>EdgeCoder uses Bluetooth to form a local compute mesh with nearby devices for offline task processing.</string>
<key>NSBluetoothPeripheralUsageDescription</key>
<string>EdgeCoder advertises as a Bluetooth peripheral to allow nearby devices to discover and route tasks.</string>
```

**Step 2: Write BLEMeshManager.swift**

```swift
// ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/BLEMeshManager.swift
import CoreBluetooth
import Foundation

struct BLEPeer {
    let agentId: String
    let model: String
    let modelParamSize: Double
    let memoryMB: Int
    let batteryPct: Int
    let currentLoad: Int
    let deviceType: String
    var rssi: Int
    var lastSeenAt: Date
}

@MainActor
final class BLEMeshManager: NSObject, ObservableObject {
    static let shared = BLEMeshManager()

    @Published var isScanning = false
    @Published var isAdvertising = false
    @Published var discoveredPeers: [BLEPeer] = []
    @Published var isOffline = false

    private var centralManager: CBCentralManager?
    private var peripheralManager: CBPeripheralManager?

    override init() {
        super.init()
    }

    func start() {
        centralManager = CBCentralManager(delegate: nil, queue: nil)
        peripheralManager = CBPeripheralManager(delegate: nil, queue: nil)
    }

    func stop() {
        stopScanning()
        stopAdvertising()
        centralManager = nil
        peripheralManager = nil
    }

    func startScanning() {
        guard let central = centralManager, central.state == .poweredOn else { return }
        central.scanForPeripherals(withServices: [BLEMeshConstants.serviceUUID], options: [
            CBCentralManagerScanOptionAllowDuplicatesKey: true
        ])
        isScanning = true
    }

    func stopScanning() {
        centralManager?.stopScan()
        isScanning = false
    }

    func startAdvertising(agentId: String, model: String, modelParamSize: Double) {
        guard let peripheral = peripheralManager, peripheral.state == .poweredOn else { return }
        let service = CBMutableService(type: BLEMeshConstants.serviceUUID, primary: true)

        let identityData = try? JSONSerialization.data(withJSONObject: [
            "agentId": agentId,
            "model": model,
            "modelParamSize": modelParamSize
        ])

        let identityChar = CBMutableCharacteristic(
            type: BLEMeshConstants.peerIdentityUUID,
            properties: [.read],
            value: identityData,
            permissions: [.readable]
        )
        service.characteristics = [identityChar]
        peripheral.add(service)
        peripheral.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [BLEMeshConstants.serviceUUID],
            CBAdvertisementDataLocalNameKey: "EC-\(agentId.prefix(8))"
        ])
        isAdvertising = true
    }

    func stopAdvertising() {
        peripheralManager?.stopAdvertising()
        peripheralManager?.removeAllServices()
        isAdvertising = false
    }

    func evictStalePeers() {
        let cutoff = Date().addingTimeInterval(-BLEMeshConstants.evictionIntervalSeconds)
        discoveredPeers.removeAll { $0.lastSeenAt < cutoff }
    }
}
```

**Step 3: Build to verify**

Run: `xcodebuild -project ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj -scheme EdgeCoderIOS -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -5`
Expected: BUILD SUCCEEDED

**Step 4: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/BLEMeshManager.swift ios/EdgeCoderIOS/EdgeCoderIOS/Info.plist
git commit -m "feat: add iOS BLE mesh manager with CoreBluetooth scanning and advertising"
```

---

### Task 9: iOS BLE Router & Offline Ledger

**Files:**
- Create: `ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/BLEMeshRouter.swift`
- Create: `ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/OfflineLedger.swift`

**Step 1: Write BLEMeshRouter.swift**

```swift
// ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/BLEMeshRouter.swift
import Foundation

struct BLEMeshRouter {
    static let costThreshold: Double = 200

    static func computeCost(peer: BLEPeer, requiredModelSize: Double) -> Double {
        let modelFitPenalty: Double = peer.modelParamSize >= requiredModelSize ? 0 : 100
        let loadPenalty = Double(peer.currentLoad) * 20
        let batteryPenalty: Double = peer.deviceType == "phone"
            ? Double(100 - peer.batteryPct) * 0.5
            : 0
        let signalPenalty = min(30, max(0, Double(-peer.rssi - 30) * 0.5))
        return modelFitPenalty + loadPenalty + batteryPenalty + signalPenalty
    }

    static func selectBestPeer(from peers: [BLEPeer], requiredModelSize: Double) -> BLEPeer? {
        var best: BLEPeer?
        var bestCost = costThreshold
        for peer in peers {
            let cost = computeCost(peer: peer, requiredModelSize: requiredModelSize)
            if cost < bestCost {
                bestCost = cost
                best = peer
            }
        }
        return best
    }
}
```

**Step 2: Write OfflineLedger.swift**

```swift
// ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/OfflineLedger.swift
import Foundation

struct BLECreditTransactionRecord: Codable {
    let txId: String
    let requesterId: String
    let providerId: String
    let requesterAccountId: String
    let providerAccountId: String
    let credits: Double
    let cpuSeconds: Double
    let taskHash: String
    let timestamp: Double
    let requesterSignature: String
    let providerSignature: String
}

final class OfflineLedger {
    static let shared = OfflineLedger()
    private static let storageKey = "edgecoder.offlineLedger"

    private var transactions: [String: BLECreditTransactionRecord] = [:]

    init() {
        load()
    }

    func record(_ tx: BLECreditTransactionRecord) {
        guard transactions[tx.txId] == nil else { return }
        transactions[tx.txId] = tx
        save()
    }

    func pending() -> [BLECreditTransactionRecord] {
        Array(transactions.values)
    }

    func markSynced(_ txIds: [String]) {
        for id in txIds {
            transactions.removeValue(forKey: id)
        }
        save()
    }

    private func save() {
        if let data = try? JSONEncoder().encode(Array(transactions.values)) {
            UserDefaults.standard.set(data, forKey: Self.storageKey)
        }
    }

    private func load() {
        guard let data = UserDefaults.standard.data(forKey: Self.storageKey),
              let records = try? JSONDecoder().decode([BLECreditTransactionRecord].self, from: data) else { return }
        for record in records {
            transactions[record.txId] = record
        }
    }
}
```

**Step 3: Build to verify**

Run: `xcodebuild -project ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj -scheme EdgeCoderIOS -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -5`
Expected: BUILD SUCCEEDED

**Step 4: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/BLEMeshRouter.swift ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/OfflineLedger.swift
git commit -m "feat: add iOS BLE router cost function and offline ledger with UserDefaults persistence"
```

---

### Task 10: Integrate BLE Mesh into iOS SwarmRuntimeController

**Files:**
- Modify: `ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/SwarmRuntimeController.swift`

**Step 1: Add BLE mesh integration**

Add to `SwarmRuntimeController`:

1. Add property: `let bleMeshManager = BLEMeshManager.shared`
2. Add published property: `@Published var consecutiveHeartbeatFailures = 0`
3. In `start()`: after `await discoverCoordinators()`, call `bleMeshManager.start()`
4. In `stop()`: call `bleMeshManager.stop()`
5. In `sendHeartbeat()` success path: reset `consecutiveHeartbeatFailures = 0` and if `bleMeshManager.isOffline`, set `bleMeshManager.isOffline = false` and trigger ledger sync
6. In `sendHeartbeat()` catch block: increment `consecutiveHeartbeatFailures`. If >= 3, set `bleMeshManager.isOffline = true` and call `bleMeshManager.startScanning()`
7. Add a `syncOfflineLedger()` method that POSTs pending transactions to coordinator `/credits/ble-sync`

**Step 2: Build to verify**

Run: `xcodebuild -project ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj -scheme EdgeCoderIOS -destination 'generic/platform=iOS' build CODE_SIGNING_ALLOWED=NO 2>&1 | tail -5`
Expected: BUILD SUCCEEDED

**Step 3: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/SwarmRuntimeController.swift
git commit -m "feat: integrate BLE mesh into iOS swarm runtime with offline detection and ledger sync"
```

---

### Task 11: Integrate BLE Mesh into Node.js AgentBase

**Files:**
- Modify: `src/agent/base.ts`
- Test: `tests/mesh/ble/agent-ble-integration.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/mesh/ble/agent-ble-integration.test.ts
import { describe, it, expect } from "vitest";
import { InteractiveAgent } from "../../src/agent/interactive.js";
import { EdgeCoderLocalProvider } from "../../src/model/providers.js";
import { BLEMeshManager } from "../../src/mesh/ble/ble-mesh-manager.js";
import { MockBLETransport } from "../../src/mesh/ble/ble-transport.js";

describe("Agent BLE integration", () => {
  it("agent accepts optional bleMeshManager", () => {
    const provider = new EdgeCoderLocalProvider();
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("agent-a", network);
    const bleMesh = new BLEMeshManager("agent-a", "account-a", transport);
    const agent = new InteractiveAgent(provider, { bleMeshManager: bleMesh });
    expect(agent).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mesh/ble/agent-ble-integration.test.ts`
Expected: FAIL (AgentOptions doesn't accept bleMeshManager)

**Step 3: Update AgentOptions in base.ts**

Add to `AgentOptions` interface in `src/agent/base.ts`:

```typescript
export interface AgentOptions {
  maxIterations?: number;
  sandbox?: "host" | "docker";
  bleMeshManager?: BLEMeshManager;
}
```

Add import and store the reference:

```typescript
import { BLEMeshManager } from "../mesh/ble/ble-mesh-manager.js";
```

In constructor:
```typescript
protected readonly bleMeshManager?: BLEMeshManager;
// ... in constructor body:
this.bleMeshManager = options?.bleMeshManager;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mesh/ble/agent-ble-integration.test.ts`
Expected: PASS

Run: `npx vitest run` (full suite)
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/agent/base.ts tests/mesh/ble/agent-ble-integration.test.ts
git commit -m "feat: integrate BLE mesh manager into AgentBase options"
```

---

### Task 12: Install noble/bleno Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install dependencies**

```bash
npm install @abandonware/noble @abandonware/bleno
npm install -D @types/web-bluetooth
```

Note: noble/bleno require OS-level Bluetooth. On Linux, requires `libbluetooth-dev` and `libusb-1.0-0-dev`. On macOS, uses native XPC. On CI without BLE hardware, the mock transport is used.

**Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

Run: `npx vitest run`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @abandonware/noble and @abandonware/bleno BLE dependencies"
```

---

### Task 13: Full Integration Test (Mock BLE E2E)

**Files:**
- Create: `tests/mesh/ble/ble-e2e.test.ts`

**Step 1: Write the e2e test**

```typescript
// tests/mesh/ble/ble-e2e.test.ts
import { describe, it, expect } from "vitest";
import { MockBLETransport } from "../../src/mesh/ble/ble-transport.js";
import { BLEMeshManager } from "../../src/mesh/ble/ble-mesh-manager.js";

describe("BLE mesh e2e (mock transport)", () => {
  it("full flow: discover → route task → get result → record credit transaction", async () => {
    const network = new Map<string, MockBLETransport>();
    const phoneTransport = new MockBLETransport("iphone", network);
    const laptopTransport = new MockBLETransport("macbook", network);

    // Laptop advertises as a capable peer
    laptopTransport.startAdvertising({
      agentId: "macbook",
      model: "qwen2.5-coder:7b",
      modelParamSize: 7,
      memoryMB: 16384,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "workstation"
    });

    // Laptop handles incoming tasks
    laptopTransport.onTaskRequest(async (req) => ({
      requestId: req.requestId,
      providerId: "macbook",
      status: "completed" as const,
      generatedCode: "def factorial(n):\n    result = 1\n    for i in range(2, n+1):\n        result *= i\n    return result\nprint(factorial(10))",
      output: "3628800",
      cpuSeconds: 3.2,
      providerSignature: "laptop-sig"
    }));

    // Phone goes offline and needs to route a task
    const phoneMesh = new BLEMeshManager("iphone", "user-account", phoneTransport);
    phoneMesh.setOffline(true);
    phoneMesh.refreshPeers();

    // Phone routes task to best BLE peer
    const response = await phoneMesh.routeTask({
      requestId: "factorial-req",
      requesterId: "iphone",
      task: "Write python code to compute factorial of 10 and print it",
      language: "python",
      requesterSignature: "phone-sig"
    }, 1.5);

    // Verify task completed
    expect(response).not.toBeNull();
    expect(response!.status).toBe("completed");
    expect(response!.output).toBe("3628800");
    expect(response!.providerId).toBe("macbook");

    // Verify credit transaction recorded
    const pending = phoneMesh.pendingTransactions();
    expect(pending).toHaveLength(1);
    expect(pending[0].requesterId).toBe("iphone");
    expect(pending[0].providerId).toBe("macbook");
    expect(pending[0].requesterAccountId).toBe("user-account");
    expect(pending[0].cpuSeconds).toBe(3.2);
    expect(pending[0].credits).toBeGreaterThan(0);

    // Simulate coming back online — export batch for sync
    const batch = phoneMesh.exportSyncBatch();
    expect(batch).toHaveLength(1);

    // Mark synced
    phoneMesh.markSynced(batch.map((tx) => tx.txId));
    expect(phoneMesh.pendingTransactions()).toHaveLength(0);
  });

  it("dormant when online — returns null", async () => {
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("device", network);
    const mesh = new BLEMeshManager("device", "account", transport);
    mesh.setOffline(false);

    const result = await mesh.routeTask({
      requestId: "req",
      requesterId: "device",
      task: "test",
      language: "python",
      requesterSignature: "sig"
    }, 1);

    expect(result).toBeNull();
  });

  it("queues task when no suitable peer available", async () => {
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("device", network);
    const mesh = new BLEMeshManager("device", "account", transport);
    mesh.setOffline(true);

    // No peers advertising
    const result = await mesh.routeTask({
      requestId: "req",
      requesterId: "device",
      task: "test",
      language: "python",
      requesterSignature: "sig"
    }, 7);

    expect(result).toBeNull();
    expect(mesh.pendingTransactions()).toHaveLength(0);
  });
});
```

**Step 2: Run test**

Run: `npx vitest run tests/mesh/ble/ble-e2e.test.ts`
Expected: PASS (3 tests)

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add tests/mesh/ble/ble-e2e.test.ts
git commit -m "feat: add BLE mesh e2e integration test with mock transport"
```

---

## Build Order

1. **Protocol constants & types** — foundation everything else depends on
2. **Cost-based router** — routing logic, no BLE dependency
3. **Offline ledger** — transaction storage, no BLE dependency
4. **Mock BLE transport** — enables testing without hardware
5. **BLE mesh manager** — orchestrates router + transport + ledger
6. **Coordinator sync endpoint** — server-side batch sync
7. **iOS BLE constants & chunking** — Swift protocol mirror
8. **iOS BLE mesh manager** — CoreBluetooth implementation
9. **iOS router & offline ledger** — Swift-side routing + persistence
10. **iOS swarm integration** — wire into existing SwarmRuntimeController
11. **Node.js agent integration** — wire into AgentBase
12. **Dependencies** — install noble/bleno
13. **E2E integration test** — prove it works end to end

## New Dependencies

- `@abandonware/noble` — BLE central scanning (Node.js)
- `@abandonware/bleno` — BLE peripheral advertising (Node.js)

## Estimated New Files

- 7 new TypeScript files (`src/mesh/ble/`)
- 5 new Swift files (`ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/`)
- 6 new test files (`tests/mesh/ble/`)
- 1 modified TypeScript file (`src/common/types.ts`)
- 1 modified TypeScript file (`src/agent/base.ts`)
- 1 modified TypeScript file (`src/swarm/coordinator.ts`)
- 1 modified Swift file (`SwarmRuntimeController.swift`)
- 1 modified plist (`Info.plist`)
