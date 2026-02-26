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
{ "previous": "qwen2.5:1.5b", "active": "qwen2.5:7b", "status": "ready", "paramSize": 7 }
```

### Download Progress Tracking

When a model swap triggers a download (status `"pulling"`), Ollama pull progress is streamed via NDJSON and tracked by an in-memory `PullTracker`. Query download state at any time:

```bash
curl http://127.0.0.1:4302/model/pull/progress
```

The same endpoint is available on the coordinator (`:4301`) and IDE provider (`:4304`). Returns `{"status":"idle"}` when no download is active. See [API Endpoints](/reference/api-endpoints-detailed) for the full response schema.

## BLE Re-Advertisement

When a model changes, the BLE Capabilities characteristic pushes the update to connected peers. During loading, `currentLoad = -1` signals unavailability — the router skips this peer until loading completes.

## Network-Wide Capability Advertisement

Agents include `activeModel` and `activeModelParamSize` in heartbeats. Coordinators aggregate this into capability summaries and gossip them to federation peers every 60 seconds via `capability_summary` mesh messages.

Query `GET /mesh/capabilities?model=qwen2.5:7b` to find coordinators with matching agents.

## Model Picker UI

Both iOS and desktop clients provide a model selection interface that lets users choose which model handles inference for a given conversation.

### iOS: ModelPickerSheet

The iOS client presents a `ModelPickerSheet` with three sections:

- **Local Models** — GGUF models downloaded to the device, managed by `LocalModelManager`
- **BLE Peers** — models available on nearby devices discovered via Bluetooth
- **Swarm Models** — models advertised through coordinator capability gossip

### Desktop: ModelPicker Dropdown

The desktop (Electron / web) client renders a `ModelPicker` dropdown in the chat header. It queries `/model/list` (local) and `/models/available` (mesh) to build the option list.

### Persistence

The selected model is persisted per `Conversation`. When the user switches conversations, the UI restores whatever model was last chosen for that thread.

### "Auto" Mode

When no model is explicitly selected, the system operates in **Auto** mode. In this mode the `IntelligentRouter` picks the best available model based on latency, load, and parameter-size heuristics. Auto is the default for new conversations.

## System-Aware Chat (Dynamic System Prompt)

The chatbot is self-aware -- it knows what model it is running, what other models are installed, how routing works, and the current state of the swarm. This is achieved by injecting a dynamic system prompt server-side before every chat request.

### How it works

1. **Coordinator path** (`POST /portal/chat`): Before calling Ollama, the coordinator gathers context from `agentCapabilities`, Ollama tags, and the swarm queue, then prepends a system message. All portal and desktop chat goes through this path.
2. **IDE provider path** (`POST /v1/chat/completions`): Before calling `IntelligentRouter.routeChat()`, the provider gathers context from Ollama tags and router status, then prepends a system message. Client file-context system messages (e.g. from the editor panel) are preserved and merged after the EdgeCoder system prompt.

### What the chatbot knows

The system prompt has two layers:

- **Static reference card** (~250 tokens): EdgeCoder identity, architecture (ports, services), routing waterfall (BLE > Ollama > swarm > stub), task scheduling, and credit economy.
- **Dynamic state** (~150 tokens, refreshed per request): active model name/size/quantization, installed models, swarm network models with agent counts, Ollama health, queue depth, connected agents, and any active model download progress.

### Example interactions

- "What model are you using?" -- responds with the actual active model name, parameter size, and quantization level.
- "How does routing work?" -- describes the BLE > Ollama > swarm > stub waterfall from its system prompt.
- "What models are available on the network?" -- lists swarm models with agent counts.

### Implementation

- `src/model/system-prompt.ts` -- exports `buildChatSystemPrompt(ctx: SystemPromptContext)` that assembles the prompt.
- Client-injected system messages are stripped (coordinator) or merged after the EdgeCoder prompt (IDE provider) to prevent override.

## Desktop Download Progress Banner

When a model is being downloaded, the desktop app shows a slim progress banner at the top of both **ChatView** and **EditorChatPanel**. The banner displays the model name, a progress bar, and a percentage. It auto-dismisses when the download completes.

The banner polls `GET /model/pull/progress` every 3 seconds. The desktop client tries the coordinator endpoint first, then falls back to the inference service.

## P2P Model Distribution

Devices that have a model can seed it to peers, reducing CDN dependency:

1. **BLE peer** (fastest, free) — nearby device streams GGUF chunks
2. **Agent mesh** (medium speed) — coordinator brokers transfer between agents
3. **CDN download** (fallback) — always available

All peer-distributed models are verified against the CDN catalog's SHA-256 checksum.

### Seed Credits

Seeders earn distribution credits proportional to file size, with a rarity bonus when fewer seeders are available.
