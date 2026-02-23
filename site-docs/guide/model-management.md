# Model Management

Every device in the EdgeCoder network can hot-swap its active model at runtime. Model changes propagate through three layers: local persistence, BLE mesh re-advertisement, and coordinator heartbeat.

## Model Catalog

A curated catalog at the EdgeCoder CDN lists available models with metadata:

- Model ID, display name, parameter size, quantization
- File size, download URL, SHA-256 checksum
- Platform compatibility (iOS, Node.js, or both)
- Supported languages, minimum memory requirement

## iOS (llama.cpp)

iOS devices run inference locally via llama.cpp with GGUF model files:

- Models stored in `Documents/Models/{modelId}.gguf`
- Registry persisted to UserDefaults
- Single model in memory (iPhone RAM constraint)
- SwiftUI views: ModelPickerView, ModelLibraryView, ModelStatusBanner

### Model Swap Flow

1. User taps a model in ModelLibraryView
2. `LocalModelManager.activate(modelId)` called
3. BLE advertisement updated (currentLoad = -1 during loading)
4. Current llama.cpp context freed, new GGUF loaded
5. BLE re-advertises with new capabilities
6. Next heartbeat includes updated model fields

## Node.js (Ollama)

Node.js agents use Ollama for model management:

### HTTP Endpoints (port 4302)

| Method | Path | Purpose |
|---|---|---|
| POST | `/model/swap` | Swap active model (pulls if not installed) |
| GET | `/model/status` | Current model, param size, Ollama health |
| GET | `/model/list` | Installed + available models |

### Swap Response

```json
{ "previous": "qwen2.5-coder:1.5b", "active": "qwen2.5-coder:7b", "status": "ready", "paramSize": 7 }
```

## BLE Re-Advertisement

When a model changes, the BLE Capabilities characteristic pushes the update to connected peers. During loading, `currentLoad = -1` signals unavailability — the router skips this peer until loading completes.

## Network-Wide Capability Advertisement

Agents include `activeModel` and `activeModelParamSize` in heartbeats. Coordinators aggregate this into capability summaries and gossip them to federation peers every 60 seconds via `capability_summary` mesh messages.

Query `GET /mesh/capabilities?model=qwen2.5-coder:7b` to find coordinators with matching agents.

## P2P Model Distribution

Devices that have a model can seed it to peers, reducing CDN dependency:

1. **BLE peer** (fastest, free) — nearby device streams GGUF chunks
2. **Agent mesh** (medium speed) — coordinator brokers transfer between agents
3. **CDN download** (fallback) — always available

All peer-distributed models are verified against the CDN catalog's SHA-256 checksum.

### Seed Credits

Seeders earn distribution credits proportional to file size, with a rarity bonus when fewer seeders are available.
