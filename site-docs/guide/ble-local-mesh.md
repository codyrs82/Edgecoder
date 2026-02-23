# BLE Local Mesh

EdgeCoder agents on nearby devices form a Bluetooth Low Energy mesh when internet connectivity drops. This allows task routing, credit tracking, and model discovery to continue offline.

## How It Works

When an agent fails 3 consecutive heartbeats (45 seconds), it enters offline mode:

1. BLE scanning activates — discovers nearby EdgeCoder devices
2. Each device advertises capabilities via BLE GATT characteristics
3. The cost-based router selects the best peer for each task
4. Credit transactions are recorded in an offline ledger
5. When connectivity returns, the offline ledger syncs to the coordinator

## BLE GATT Service Profile

EdgeCoder uses a custom BLE service with these characteristics:

| Characteristic | UUID Suffix | Purpose |
|---|---|---|
| Peer Identity | `0002` | Agent ID, mesh token hash |
| Capabilities | `0003` | Model, param size, memory, battery, load, device type |
| Task Request | `0004` | Chunked task payload (prompt, language, context) |
| Task Response | `0005` | Chunked result (generated code, output, CPU seconds) |
| Ledger Sync | `0006` | Credit transaction batch |

Service UUID: `E0D6EC00-0001-4C3A-9B5E-00ED6EC0DE00`

Payloads exceeding the 512-byte MTU are chunked with a 4-byte header (2-byte sequence number + 2-byte total count, big-endian).

## Cost-Based Routing

The router scores each peer and selects the lowest-cost option:

```
cost = modelPreferencePenalty + loadPenalty + batteryPenalty + signalPenalty
```

| Factor | Formula | Notes |
|---|---|---|
| Model preference | `max(0, (7 - paramSize) * 8)` | Larger models preferred, never rejected |
| Load | `currentLoad * 20` | Busy peers cost more |
| Battery (phones) | `(100 - batteryPct) * 0.5` | Low-battery phones deprioritized |
| Signal | `min(30, max(0, (-RSSI - 30) * 0.5))` | Weak signal penalized |

Peers with cost >= 200 are skipped. Stale peers (>60s since last seen) are evicted.

## Model Quality Multiplier

Credit earnings scale with model capability:

| Model Size | Multiplier |
|---|---|
| 7B+ | 1.0x |
| 3B-7B | 0.7x |
| 1.5B-3B | 0.5x |
| < 1.5B | 0.3x |

## Offline Credit Ledger

Every completed task generates a dual-signed credit transaction:

- Requester signs before sending the task
- Provider counter-signs after returning results
- Transaction includes: task hash, CPU seconds, credit amount, timestamps

Transactions persist to device storage (UserDefaults on iOS, in-memory on Node.js).

### Batch Sync

When connectivity returns, the agent sends all pending transactions to `POST /credits/ble-sync`. The coordinator deduplicates by `txId` and records them in the ordering chain.

## Integration Points

- **iOS**: `BLEMeshManager.swift` uses CoreBluetooth (CBCentralManager + CBPeripheralManager)
- **Node.js**: `ble-mesh-manager.ts` uses `@abandonware/noble` (scanning) and `@abandonware/bleno` (advertising)
- **Coordinator**: `POST /credits/ble-sync` ingests offline transactions
