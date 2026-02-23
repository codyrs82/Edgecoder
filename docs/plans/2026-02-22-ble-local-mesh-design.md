# BLE Local Mesh Tethering Design

**Date:** 2026-02-22
**Status:** Approved
**Approach:** A+C Hybrid (CoreBluetooth + noble/bleno with standard GATT profile)

---

## Summary

Phones, workstations, and laptops in physical proximity discover each other via Bluetooth Low Energy (BLE) and form a local compute mesh. Each device contributes its local models to a shared pool. Tasks route to the cheapest/fastest peer using a cost-based routing protocol. Credit transactions follow the same earn/spend model as the HTTP mesh — requester pays, provider earns — with dual-signed offline transactions that batch-sync to the coordinator on reconnect.

**Primary use case:** Offline fallback. When devices can't reach the coordinator, the BLE mesh keeps compute available locally. When online, each device works with the coordinator independently; BLE stays dormant but keeps its routing table updated.

**Platforms:** iOS, macOS, Linux, Windows (all from v1).

---

## GATT Service Profile

Custom BLE GATT service that all EdgeCoder devices implement. Each device acts as both peripheral (advertising) and central (scanning).

**Service UUID:** `E0D6EC00-0001-4C3A-9B5E-00EDGEC0DE00` (EdgeCoder Mesh)

| Characteristic | UUID suffix | Properties | Purpose |
|---|---|---|---|
| Peer Identity | `...0001` | Read | JSON: `{agentId, meshTokenHash, accountId}` |
| Capabilities | `...0002` | Read, Notify | JSON: `{model, modelParamSize, memoryMB, batteryPct, load, deviceType, languages}` |
| Task Request | `...0003` | Write | Chunked JSON: task payload (task, language, failedCode, errorHistory) |
| Task Response | `...0004` | Notify | Chunked JSON: result code, generated code, output, credit receipt |
| Ledger Sync | `...0005` | Write, Notify | Signed offline transaction batch |

**Chunking:** BLE MTU is typically 512 bytes. Payloads >512 bytes use a chunk header: `[seqNo:uint16][totalChunks:uint16][data]`. Receiver reassembles in order.

**Mesh token validation:** Peer Identity includes SHA-256 hash of the mesh token. Connecting device verifies hash matches known-valid format before exchanging tasks. Full token never sent over BLE.

---

## Discovery & Cost-Based Routing

**Discovery:** Continuous BLE scan for peripherals advertising the EdgeCoder service UUID. On discovery, read Peer Identity and Capabilities. Maintain a local routing table.

**Routing table entry:**

```typescript
interface BLEPeerEntry {
  agentId: string;
  meshTokenHash: string;
  accountId: string;
  model: string;            // e.g. "qwen2.5-coder:1.5b"
  modelParamSize: number;   // billions
  memoryMB: number;
  batteryPct: number;
  currentLoad: number;      // tasks in progress
  deviceType: "phone" | "laptop" | "workstation";
  rssi: number;             // signal strength
  lastSeenMs: number;
}
```

**Cost function** (lower is better, inspired by OSPF link cost):

```
cost(peer, task) =
    modelFitPenalty       // 0 if model adequate for task, +100 if undersized
  + loadPenalty           // peer.currentLoad * 20
  + batteryPenalty        // (100 - batteryPct) * 0.5 for phones, 0 for plugged-in devices
  + signalPenalty         // map RSSI to 0-30 range (closer = cheaper)
  + latencyEstimate       // payload size / estimated BLE throughput
```

**Routing decision (offline mode):**

1. Compute cost for self (local model)
2. Compute cost for each BLE peer
3. Route to lowest-cost option
4. If all costs exceed threshold (200) -> queue task for coordinator

**Peer lifecycle:** Stale after 30s unseen, evicted after 60s. Capabilities characteristic uses Notify to push updates when load/battery changes.

---

## Offline Credit Ledger & Sync

**Transaction format:**

```typescript
interface BLECreditTransaction {
  txId: string;                 // UUID
  requesterId: string;          // agentId of task requester
  providerId: string;           // agentId of task processor
  requesterAccountId: string;
  providerAccountId: string;
  credits: number;              // baseRatePerSecond * cpuSeconds * qualityScore * loadMultiplier
  cpuSeconds: number;
  taskHash: string;             // SHA-256 of task payload
  timestamp: number;
  requesterSignature: string;   // ed25519 signed by requester
  providerSignature: string;    // ed25519 counter-signed by provider
}
```

**Dual-signature:** Requester signs the request before sending. Provider counter-signs after returning results. Prevents fabricated transactions.

**Credit computation:** Same formula as existing CreditEngine — `cpuSeconds * baseRatePerSecond(resourceClass) * qualityScore * loadMultiplier(load)`. Load multiplier uses BLE routing table size as proxy for `activeAgents`.

**Batch sync on reconnect:**

1. Device regains coordinator connectivity
2. Submits `POST /credits/ble-sync` with signed transaction batch
3. Coordinator validates both signatures per transaction
4. Applies `spend` to requester, `earn` to provider
5. Duplicate `txId` rejected (idempotent)
6. Returns sync receipt; device clears synced transactions

**Same-account wash:** When `requesterAccountId === providerAccountId`, both sides recorded for audit but net balance change is zero.

---

## Task Flow & State Machine

```
idle -> scanning -> peer_discovered -> evaluating_cost -> routing_decision
  -> local_execute (self is cheapest)
  -> ble_send_task -> awaiting_response -> response_received -> credit_transaction -> done
  -> queued (all costs too high, wait for coordinator)
```

**Offline detection:** 3 consecutive failed coordinator heartbeats (15s interval = 45s) triggers `offline` mode. BLE mesh becomes active for task routing. Successful heartbeat returns to `online` mode and triggers batch sync.

**Task timeout:** 60 seconds per BLE task. On timeout, mark failed, try next-cheapest peer or queue.

**Concurrent connections:** Up to 5 simultaneous BLE connections (iOS CoreBluetooth limit). Router prioritizes lowest-cost peers.

---

## Platform Implementation

### iOS/macOS (Swift - CoreBluetooth)

New directory: `ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/`

| File | Purpose |
|---|---|
| `BLEMeshManager.swift` | CBCentralManager + CBPeripheralManager. Scanning, advertising, connection lifecycle |
| `BLEMeshRouter.swift` | Routing table, cost function, routing decisions |
| `BLEChunkedTransfer.swift` | Chunking/reassembly for payloads > MTU |
| `OfflineLedger.swift` | Persists BLE credit transactions locally, batch sync |
| `BLEConstants.swift` | Service UUID, characteristic UUIDs, chunk header format |

**Integration:**
- `SwarmRuntimeController` gains `bleMeshManager` property. BLE scanning starts with runtime. Tasks route through BLE when coordinator unreachable.
- `LocalModelManager` — BLE peers invoke local inference through the mesh.
- Info.plist: add `NSBluetoothAlwaysUsageDescription`, `NSBluetoothPeripheralUsageDescription`
- Entitlements: add Bluetooth capability

### Node.js/TypeScript (Linux/Windows - noble/bleno)

New directory: `src/mesh/ble/`

| File | Purpose |
|---|---|
| `ble-peripheral.ts` | bleno-based GATT server advertising EdgeCoder service |
| `ble-central.ts` | noble-based scanner discovering peers |
| `ble-mesh-manager.ts` | Combined central+peripheral, manages connections |
| `ble-router.ts` | Routing table + cost function |
| `ble-chunked-transfer.ts` | Chunking/reassembly |
| `offline-ledger.ts` | Local transaction log, batch sync client |
| `protocol.ts` | Service UUID, characteristic UUIDs, message types (single source of truth) |

**New dependency:** `@abandonware/noble`, `@abandonware/bleno`

**Integration:**
- `AgentBase` gains optional `bleMeshManager`. When escalation fails and no coordinator, check BLE peers.
- Coordinator: new `POST /credits/ble-sync` endpoint accepts signed transaction batches.
- `BLEMeshProvider` implements `ModelProvider` interface — routes inference to BLE peer.

---

## Trust Model

- Only devices with valid mesh tokens (issued by coordinator registration) participate
- BLE advertisement includes mesh token SHA-256 hash for verification
- Task payloads are ed25519-signed with the device's mesh identity key pair
- Unknown/unsigned peers are silently ignored
- Full mesh token never transmitted over BLE

---

## Testing

**Unit tests:**
- Cost function returns expected values for various peer configurations
- Chunking/reassembly for payloads 100 bytes to 50KB
- Offline ledger queues, deduplicates, batch-syncs correctly
- Dual-signature validation rejects tampered transactions

**Integration tests:**
- Two Node.js agents discover each other over BLE, exchange tasks
- Credit transaction recorded on both sides, synced to coordinator
- BLE mesh dormant when online, active when offline

**E2E success criteria:**
- iPhone + MacBook in BLE range, both offline — iPhone sends task, MacBook processes, result returns
- Credits deducted from requester, earned by provider
- Both come online — transactions sync, ledger balances match

**Mock layer:** `MockBLETransport` for CI without BLE hardware. Same interface as real BLE manager.

---

## New Dependencies

- `@abandonware/noble` — BLE central (Node.js)
- `@abandonware/bleno` — BLE peripheral (Node.js)

## Estimated New Files

- ~6 new Swift files (iOS/macOS BLE mesh)
- ~7 new TypeScript files (Node.js BLE mesh)
- ~4 new test files
- Info.plist and entitlements updates
