# Model Management & Network-Wide Capability Advertisement Design

**Date:** 2026-02-22
**Status:** Approved
**Approach:** llama.cpp on iOS, Ollama on Node.js, coordinator gossip for capability replication

---

## Summary

Every device in the EdgeCoder network — phones, laptops, workstations, coordinators — can hot-swap its active model at runtime. Each device advertises its current model capabilities to the network. Coordinators gossip model availability across the federation so any coordinator can route tasks to the best-fit agent regardless of which coordinator the agent is registered with. Models distribute peer-to-peer through the agent mesh, reducing CDN dependency — similar to BitTorrent swarm distribution.

**Three layers:**
1. **Local** — On-device model management UI (iOS SwiftUI, Node.js HTTP+CLI)
2. **BLE mesh** — Nearby peers see model changes via BLE Notify characteristic
3. **Network** — Coordinators replicate agent capability tables via gossip, enabling cross-coordinator task routing and P2P model distribution

---

## Model Catalog & Registry

### CDN Catalog

A JSON manifest at `https://models.edgecoder.io/catalog.json` listing curated models:

```typescript
interface ModelCatalogEntry {
  modelId: string;           // "qwen2.5-coder-1.5b-q4"
  displayName: string;       // "Qwen 2.5 Coder 1.5B (Q4_K_M)"
  paramSize: number;         // 1.5
  quantization: string;      // "Q4_K_M"
  fileSizeBytes: number;     // 1_200_000_000
  downloadUrl: string;       // CDN URL to GGUF file
  checksumSha256: string;
  platform: "ios" | "node" | "all";
  languages: string[];       // ["python", "javascript"]
  minMemoryMB: number;       // 2048
}
```

### Local Registry

Each device tracks installed models and the active selection:

- **iOS:** UserDefaults-persisted map of `modelId` → `{localPath, status, paramSize, fileSizeBytes}`
- **Node.js:** Wraps Ollama's `/api/tags` API. No separate registry needed — Ollama is the registry.

### Active Model

One active model per device. Changing it triggers:
1. Local registry update + persistence
2. BLE re-advertisement (Capabilities characteristic Notify)
3. Heartbeat capability update to coordinator (`localModelCatalog` field)
4. Coordinator gossips updated capability to federation peers

---

## iOS Implementation (llama.cpp + SwiftUI)

### llama.cpp Integration

Add the `llama.cpp` Swift package via SPM. Rewrite `LocalModelManager` to:

- Load GGUF files from `Documents/Models/` into llama.cpp
- Run inference via `llama_decode` / `llama_sampling`
- Unload current model before loading new one (single model in memory — iPhone RAM constraint)
- Report model metadata (paramSize, quantization) for BLE and heartbeat advertisement
- Persist selected model to UserDefaults

### SwiftUI Views

| View | Purpose |
|---|---|
| `ModelPickerView` | Compact picker in SwarmView showing active model name + chevron. Taps open ModelLibraryView |
| `ModelLibraryView` | Full-screen list: **Installed** section (tap to activate, swipe to delete) + **Available** section (from CDN catalog, tap to download with progress) |
| `ModelStatusBanner` | Banner in SwarmView: model name, status (loading/ready/error), last inference time |

### Download Manager

- `URLSession` background download tasks (survives app backgrounding)
- Progress shown in ModelLibraryView + system notification on completion
- SHA-256 checksum verification after download
- GGUF files stored in `Documents/Models/{modelId}.gguf`

### Model Swap Flow

1. User taps different installed model in ModelLibraryView
2. `LocalModelManager.activate(modelId)` called
3. Device sets BLE `currentLoad = -1` (unavailable sentinel)
4. Current llama.cpp context freed
5. New GGUF loaded into llama.cpp
6. `selectedModel` updated, persisted to UserDefaults
7. `BLEMeshManager` re-advertises with new model capabilities
8. Heartbeat sends updated `localModelCatalog` to coordinator
9. BLE `currentLoad` resets to 0 (routable again)

---

## Node.js Implementation (Ollama + HTTP + CLI)

### HTTP Endpoints (on inference service, port 4302)

**`POST /model/swap`**
```typescript
// Request
{ model: "qwen2.5-coder:7b" }

// Response (immediate if installed)
{ previous: "qwen2.5-coder:1.5b", active: "qwen2.5-coder:7b", status: "ready", paramSize: 7 }

// Response (pulling)
{ previous: "qwen2.5-coder:1.5b", active: "qwen2.5-coder:1.5b", status: "pulling", progress: 0 }
```

Flow:
1. Check model exists in Ollama (`GET /api/tags`)
2. If not installed, trigger `POST /api/pull`, return pulling status — client polls `/model/status`
3. Update `ProviderRegistry` to use new model
4. Fire model-changed event → BLE re-advertisement + heartbeat update
5. Return new active model info

**`GET /model/status`** — Current model, param size, pull progress, Ollama health.

**`GET /model/list`** — Installed models (from Ollama `/api/tags`) + CDN catalog entries not yet installed.

### CLI

```bash
npx edgecoder model list          # Show installed + available
npx edgecoder model swap <name>   # Swap active model
npx edgecoder model status        # Current model + health
npx edgecoder model pull <name>   # Pull model without activating
```

Thin wrappers over the HTTP API (`fetch("http://127.0.0.1:4302/model/...")`)

### Ollama Health Check

Before any model operation, ping `GET http://127.0.0.1:11434/api/tags`. If unreachable: `{ error: "ollama_not_running", message: "Start Ollama with: ollama serve" }`.

---

## BLE Mesh Re-Advertisement

When the active model changes, the BLE Capabilities characteristic pushes the update to all connected peers:

**iOS:**
1. `LocalModelManager` posts `.modelDidChange` notification
2. `BLEMeshManager` observes, calls `peripheralManager.updateValue(...)` on Capabilities characteristic
3. Connected peers receive Notify, call `router.updatePeer()` with new param size

**Node.js:**
1. `POST /model/swap` calls `bleMeshManager.onModelChanged(model, paramSize)`
2. bleno peripheral updates Capabilities characteristic value, notifies subscribers

**Unavailability during swap:**
During model loading, device sets `currentLoad = -1` in BLE advertisement. Router treats this as cost = threshold, skipping the peer until loading completes and `currentLoad` resets to 0.

---

## Network-Wide Capability Advertisement

### Agent → Coordinator (already exists, extend)

The existing heartbeat (`POST /heartbeat`) and registration (`POST /register`) already send `localModelCatalog` and `localModelProvider`. Extend to include:

```typescript
// Added to heartbeat payload
activeModel: string;           // Currently loaded model
activeModelParamSize: number;  // For routing decisions
modelSwapInProgress: boolean;  // True during loading
```

The coordinator's `agentCapabilities` map already stores `localModelCatalog`. Add `activeModel` and `activeModelParamSize` fields to enable model-aware task routing.

### Coordinator → Coordinator (gossip)

**New mesh message type: `capability_summary`**

Add to the existing `MeshMessageType` union:

```typescript
| "capability_summary"
```

Payload:

```typescript
{
  coordinatorId: string;
  agentCount: number;
  modelAvailability: {
    [modelName: string]: {
      agentCount: number;
      totalParamCapacity: number;  // sum of paramSize across agents
      avgLoad: number;
    }
  };
  timestamp: number;
}
```

**Broadcast schedule:** Every 60 seconds via the existing `bootstrapPeerMesh()` timer, each coordinator gossips its aggregated agent capability summary to all federation peers. This is lightweight (one small JSON per coordinator) and uses the existing `GossipMesh.broadcast()` infrastructure.

**Receiving coordinators** store a `federatedCapabilities` map keyed by `coordinatorId`, enabling cross-coordinator queries like "which coordinator has the most 7B agents available?"

### Cross-Coordinator Task Routing

When a coordinator receives a task but has no suitable local agent:

1. Check `federatedCapabilities` for coordinators with matching model capacity
2. Forward task to the best-fit coordinator via `POST /mesh/task-forward`
3. Receiving coordinator assigns to a local agent
4. Result returns through the same path
5. Credit transaction recorded on both coordinators, reconciled via quorum

This extends the existing `task_offer` / `task_claim` mesh message flow.

---

## P2P Model Distribution (BitTorrent-Inspired)

### The Problem

Every device downloading a 4.7GB model from the CDN is wasteful when nearby devices already have it.

### The Solution

Devices that have a model can seed it to peers — both over BLE (local) and through the coordinator mesh (network). This creates a swarm distribution pattern:

**Local (BLE) seeding:**
- Device A has `qwen2.5-coder:7b` and Device B wants it
- B discovers A has it via BLE Capabilities characteristic
- B requests the model file via BLE Task Request characteristic (special `model_transfer` request type)
- A streams the GGUF file in chunks using the existing BLE chunked transfer protocol
- B verifies SHA-256 checksum from CDN catalog

**Network seeding (agent mesh):**
- The existing `POST /agent-mesh/models/request` endpoint already supports model requests between agents
- Extend to support streaming the model binary, not just metadata
- Coordinator tracks which agents have which models (from heartbeat `localModelCatalog`)
- When agent B wants a model, coordinator finds the nearest agent A that has it and brokers the transfer
- Multiple seeders can serve chunks in parallel (like BitTorrent piece distribution)

**Catalog-driven integrity:**
- The CDN catalog provides the authoritative `checksumSha256` for every model
- Any peer-distributed model is verified against this checksum
- Corrupted or tampered transfers are rejected and re-fetched from CDN

### Seeding Priority

```
1. BLE peer on same network (fastest, free)
2. Agent mesh peer via coordinator relay (medium speed, uses network)
3. CDN direct download (slowest for large models, always available as fallback)
```

---

## Ledger Agreement Across Coordinators

### Existing Mechanisms (already built)

The codebase already has comprehensive ledger agreement:

- **Ordering chain** (`src/ledger/chain.ts`): Sequential, hash-linked, signed event log
- **Quorum voting** (`coordinator.ts`): `floor(approvedCoordinators / 2) + 1` threshold
- **Issuance epochs**: Proposal → Vote → Commit → Checkpoint flow
- **Stats ledger sync**: `GET /stats/ledger/head`, `POST /stats/ledger/ingest`
- **Bitcoin anchoring**: Checkpoint hashes anchored to Bitcoin for finality

### Extension for Model-Swap Credits

When a device swaps to a smaller model, its future credit earnings decrease (quality multiplier drops). This is already handled:

- The BLE offline ledger records `credits` using `modelQualityMultiplier(paramSize)`
- The coordinator sync endpoint (`POST /credits/ble-sync`) receives transactions with the multiplier baked in
- The ordering chain records these as `earnings_accrual` events
- Cross-coordinator reconciliation uses the existing quorum mechanism

**New addition:** Model transfer credits. When device A seeds a model to device B:
- A earns "distribution credits" (new `earn` reason: `model_seed`)
- Incentivizes devices to keep popular models and seed them
- Amount based on file size transferred and seeder count (fewer seeders = higher reward, like BitTorrent rarity)

---

## Error Handling

| Scenario | iOS | Node.js |
|---|---|---|
| Download/pull fails | Retry 3x, then show error. Delete partial file | Return `{ error: "pull_failed" }`. Ollama cleans up |
| Checksum mismatch | Delete file, show "corrupted" | N/A — Ollama validates |
| Model too large for RAM | Prevent activation, show memory requirement | Ollama returns OOM error |
| Ollama not running | N/A | Clear error: "Start with: ollama serve" |
| Swap during active task | Queue swap, finish in-flight task first | Same — finish current inference, then swap |
| CDN catalog unreachable | Show cached catalog, badge "offline" | Return cached `/model/list` |
| BLE peer seed fails mid-transfer | Resume from last verified chunk | Same — chunk-level resume |
| Coordinator gossip unreachable | Local routing still works, stale federation data | Same — degrade gracefully |

---

## Testing

### iOS (XCTest)
- `LocalModelManager` unit tests with mock llama.cpp context
- `ModelLibraryView` snapshot tests for installed/available/downloading states
- Download manager test with mock URLSession
- Model swap → BLE re-advertisement integration test

### Node.js (Vitest)
- `POST /model/swap` with mock Ollama responses (success, not found, pulling)
- `GET /model/list` returns merged Ollama + CDN catalog
- `GET /model/status` returns correct state during swap
- BLE re-advertisement fires on model change (MockBLETransport)
- CLI integration test calling HTTP endpoints
- Capability summary gossip broadcast test
- P2P model transfer with checksum verification

### E2E
- Two mock BLE devices: A swaps model, B's routing table updates, next task uses new cost/multiplier
- Two coordinators: agent registers model, coordinator gossips capability to peer, peer can route tasks to that agent
- P2P model seed: agent A has model, agent B requests it, transfer completes, checksum verified

---

## New Dependencies

- `llama.cpp` Swift package (iOS, via SPM)
- No new Node.js dependencies (Ollama API is HTTP, already have fetch)

## New Files

**iOS:**
- `ModelPickerView.swift`
- `ModelLibraryView.swift`
- `ModelStatusBanner.swift`
- Rewrite `LocalModelManager.swift` (llama.cpp integration)

**Node.js:**
- `src/model/swap.ts` — Model swap HTTP endpoints
- `bin/swap-model.ts` — CLI wrapper
- `src/mesh/capability-gossip.ts` — Capability summary broadcast
- `src/mesh/model-transfer.ts` — P2P model seeding
- Modify `src/swarm/coordinator.ts` — `capability_summary` message handling, cross-coordinator routing
- Modify `src/common/types.ts` — New message type, catalog types

## Documentation Updates (site-docs/)

The VitePress docs site at `https://edgecoder-docs.fly.dev/` needs updates:

**New pages:**
- `site-docs/guide/ble-local-mesh.md` — BLE mesh tethering: discovery, cost-based routing, offline credit ledger, batch sync
- `site-docs/guide/model-management.md` — Model swap, catalog, download, P2P distribution
- `site-docs/operations/coordinator-federation.md` — Capability gossip, cross-coordinator routing, ledger agreement

**Updated pages:**
- `site-docs/guide/model-provider-abstraction.md` — Add llama.cpp as iOS provider, model swap flow, quality multiplier
- `site-docs/reference/environment-variables.md` — Add new model swap env vars
- `site-docs/reference/api-endpoints-detailed.md` — Add `/model/swap`, `/model/status`, `/model/list`, `/credits/ble-sync` endpoints
- `site-docs/economy/credits-pricing-issuance.md` — Add model quality multiplier (0.3x-1.0x), BLE offline credits, model seed credits
- `site-docs/.vitepress/config.ts` — Add new pages to sidebar navigation

**Deploy:** After docs update, `fly deploy -c deploy/fly/fly.docs.toml` to push to edgecoder-docs.fly.dev.

## Estimated Scope

- ~5 new Swift files + 1 major rewrite
- ~4 new TypeScript files + 2 modifications
- ~8 new test files
- ~3 new doc pages + ~5 doc page updates
