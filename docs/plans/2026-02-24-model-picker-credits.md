# Model Picker + Credit System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Cursor-style model picker to the chat screen on both iOS and desktop, with per-billion-parameter credit pricing and model-specific routing through the swarm.

**Architecture:** The model picker sits in the chat header, shows grouped models (local, BLE peers, swarm), and persists the selection per conversation. The router honors the selection when deciding where to send requests. Credit pricing switches from flat 5 credits to `Math.max(0.5, paramSizeB)` credits per swarm request. The coordinator gains a `GET /models/available` endpoint and model-matching in its task claim logic.

**Tech Stack:** SwiftUI (iOS), Svelte 5 (desktop), TypeScript/Fastify (coordinator), llama.cpp (iOS local), Ollama (desktop local)

---

### Task 1: Add `modelCostCredits()` to pricing engine

**Files:**
- Modify: `src/credits/pricing.ts`
- Create: `src/credits/__tests__/pricing.test.ts`

**Context:** Currently swarm tasks cost a flat 5 credits (hardcoded in `ChatRouter.swift:119` and `coordinator.ts`). We need a function that calculates cost based on model parameter size.

**Step 1: Write the test**

```typescript
// src/credits/__tests__/pricing.test.ts
import { describe, it, expect } from "vitest";
import { modelCostCredits } from "../pricing.js";

describe("modelCostCredits", () => {
  it("returns paramSizeB for models >= 0.5B", () => {
    expect(modelCostCredits(7)).toBe(7);
    expect(modelCostCredits(3)).toBe(3);
    expect(modelCostCredits(1.5)).toBe(1.5);
    expect(modelCostCredits(0.5)).toBe(0.5);
  });

  it("enforces minimum of 0.5 credits", () => {
    expect(modelCostCredits(0.1)).toBe(0.5);
    expect(modelCostCredits(0)).toBe(0.5);
  });

  it("handles large models", () => {
    expect(modelCostCredits(70)).toBe(70);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd /Users/codysmith/Cursor/Edgecoder && npx vitest run src/credits/__tests__/pricing.test.ts
```
Expected: FAIL — `modelCostCredits` is not exported

**Step 3: Implement the function**

Add to the end of `src/credits/pricing.ts`:

```typescript
/**
 * Credit cost for a swarm request based on model parameter count.
 * @param paramSizeB Model size in billions of parameters (e.g. 7 for a 7B model)
 * @returns Credits to charge the requester (minimum 0.5)
 */
export function modelCostCredits(paramSizeB: number): number {
  return Math.max(0.5, paramSizeB);
}
```

**Step 4: Run test to verify it passes**

```bash
npx vitest run src/credits/__tests__/pricing.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/credits/pricing.ts src/credits/__tests__/pricing.test.ts
git commit -m "feat: add modelCostCredits pricing function (per-billion-param rate)"
```

---

### Task 2: Add `GET /models/available` endpoint to coordinator

**Files:**
- Modify: `src/swarm/coordinator.ts`

**Context:** The coordinator already tracks agent capabilities in an `agentCapabilities` Map that includes `activeModel` and `activeModelParamSize` per agent. The `buildCapabilitySummary()` function in `src/mesh/capability-gossip.ts` already aggregates this data. We need an HTTP endpoint that returns this aggregated data so the model picker can show swarm-available models.

**Step 1: Add the endpoint**

In `src/swarm/coordinator.ts`, find the existing route handlers section and add a new `GET /models/available` route. The `agentCapabilities` Map is already in scope.

```typescript
app.get("/models/available", async (_req, reply) => {
  const modelMap: Record<string, { model: string; paramSize: number; agentCount: number; avgLoad: number }> = {};

  for (const [_agentId, cap] of agentCapabilities) {
    const model = cap.activeModel;
    if (!model) continue;
    if (!modelMap[model]) {
      modelMap[model] = { model, paramSize: cap.activeModelParamSize ?? 0, agentCount: 0, avgLoad: 0 };
    }
    modelMap[model].agentCount += 1;
    modelMap[model].avgLoad += cap.currentLoad ?? 0;
  }

  const models = Object.values(modelMap).map(m => ({
    ...m,
    avgLoad: m.agentCount > 0 ? m.avgLoad / m.agentCount : 0,
  }));

  return reply.send(models);
});
```

The `agentCapabilities` Map entries should already have `activeModel`, `activeModelParamSize`, and `currentLoad` fields — verify by checking the `/heartbeat` handler which updates them.

**Step 2: Test manually**

```bash
curl http://localhost:4301/models/available
```
Expected: JSON array of `{ model, paramSize, agentCount, avgLoad }` objects (may be empty if no agents registered)

**Step 3: Commit**

```bash
git add src/swarm/coordinator.ts
git commit -m "feat: add GET /models/available coordinator endpoint"
```

---

### Task 3: Add `requestedModel` to swarm task submission and claim logic

**Files:**
- Modify: `src/swarm/queue.ts` — add model-matching to `claim()`
- Modify: `src/swarm/coordinator.ts` — pass `requestedModel` through `/submit` and `/tasks`
- Modify: `src/common/types.ts` — add `requestedModel` to `Subtask` interface

**Context:** Currently `queue.claim(agentId)` returns any unclaimed task using fair-share scheduling. We need it to prefer tasks whose `requestedModel` matches the claiming agent's active model.

**Step 1: Add `requestedModel` to the `Subtask` interface**

In `src/common/types.ts`, find the `Subtask` interface and add:

```typescript
export interface Subtask {
  id: string;
  taskId: string;
  kind: "micro_loop" | "single_step";
  language: Language;
  input: string;
  timeoutMs: number;
  snapshotRef: string;
  projectMeta: TaskProjectMeta;
  requestedModel?: string;  // <-- ADD THIS
}
```

**Step 2: Update `claim()` in `queue.ts` to accept and match model**

Change the `claim` method signature to accept the agent's active model:

```typescript
claim(agentId: string, agentActiveModel?: string): Subtask | undefined {
  const now = Date.now();
  const unclaimed = this.tasks.filter(
    (task) => !task.claimedBy && (!task.claimableAfterMs || now >= task.claimableAfterMs)
  );
  if (unclaimed.length === 0) return undefined;

  // Partition into model-matching and non-matching
  const matching = agentActiveModel
    ? unclaimed.filter(t => t.subtask.requestedModel === agentActiveModel)
    : [];
  const pool = matching.length > 0 ? matching : unclaimed;

  // Fair-share within the pool
  let item = pool[0];
  for (const candidate of pool) {
    const currentProject = item.subtask.projectMeta.projectId;
    const candidateProject = candidate.subtask.projectMeta.projectId;
    const currentCount = this.projectCompleted.get(currentProject) ?? 0;
    const candidateCount = this.projectCompleted.get(candidateProject) ?? 0;
    const currentPriority = item.subtask.projectMeta.priority;
    const candidatePriority = candidate.subtask.projectMeta.priority;

    if (candidateCount < currentCount) {
      item = candidate;
    } else if (candidateCount === currentCount && candidatePriority > currentPriority) {
      item = candidate;
    }
  }

  if (!item) return undefined;
  item.claimedBy = agentId;
  item.claimedAt = Date.now();
  void this.store?.markSubtaskClaimed(item.subtask.id, agentId, item.claimedAt).catch(() => undefined);
  return item.subtask;
}
```

**Step 3: Update coordinator `/pull` to pass agent's active model**

In `coordinator.ts`, find the `/pull` handler where `queue.claim(body.agentId)` is called. Change to:

```typescript
const capability = agentCapabilities.get(body.agentId);
const task = queue.claim(body.agentId, capability?.activeModel);
```

**Step 4: Update coordinator `/tasks` (and `/submit`) to pass `requestedModel` through**

In the `/tasks` POST handler (or `/submit`), when calling `queue.enqueueSubtask()`, pass the `requestedModel` from the request body:

Add `requestedModel` to the task schema validation, then include it in the subtask:

```typescript
// In the task/submit schema, add:
requestedModel: z.string().optional(),

// When creating subtasks:
queue.enqueueSubtask({
  ...subtask,
  requestedModel: body.requestedModel,  // <-- ADD THIS
  projectMeta: { ... }
}, ...)
```

**Step 5: Commit**

```bash
git add src/common/types.ts src/swarm/queue.ts src/swarm/coordinator.ts
git commit -m "feat: model-matching in swarm task claim + requestedModel field"
```

---

### Task 4: Update `IntelligentRouter` to accept `requestedModel`

**Files:**
- Modify: `src/model/router.ts`

**Context:** The desktop `IntelligentRouter.routeChat()` currently uses the hardcoded `this.ollamaChatModel` (from `OLLAMA_MODEL` env var or `"qwen2.5-coder:latest"`). It needs to accept an optional `requestedModel` parameter and use it for Ollama requests and swarm submission.

**Step 1: Add `requestedModel` to `routeChat` options**

In `router.ts`, modify the `routeChat` method:

```typescript
async routeChat(
  messages: ChatMessage[],
  opts: { stream?: boolean; temperature?: number; maxTokens?: number; requestedModel?: string } = {}
): Promise<ChatRouteResult> {
```

**Step 2: Use requested model for Ollama**

In the local Ollama section of `routeChat()`, replace `this.ollamaChatModel` with:

```typescript
const model = opts.requestedModel ?? this.ollamaChatModel;
```

Use `model` everywhere in that section where `this.ollamaChatModel` was used (the JSON body and the return value).

**Step 3: Pass `requestedModel` to swarm submission**

In `runViaSwarm()`, add a `requestedModel` parameter and include it in the task body:

```typescript
private async runViaSwarm(
  prompt: string,
  requestedModel?: string
): Promise<Omit<RouterResult, "route" | "latencyMs">> {
```

Add to the POST body:

```typescript
body: JSON.stringify({
  taskId: `ide-${Date.now()}`,
  prompt,
  language: this.cfg.swarmLanguage ?? "python",
  submitterAccountId: this.cfg.agentAccountId,
  projectId: "ide-requests",
  resourceClass: "cpu",
  priority: 60,
  requestedModel,  // <-- ADD THIS
  subtasks: [{ prompt, language: this.cfg.swarmLanguage ?? "python" }]
}),
```

Update the swarm section of `routeChat()` to pass the model:

```typescript
const result = await this.runViaSwarm(lastUserMsg.content, opts.requestedModel);
```

**Step 4: Commit**

```bash
git add src/model/router.ts
git commit -m "feat: IntelligentRouter accepts requestedModel for Ollama and swarm"
```

---

### Task 5: Update provider-server and desktop API client to pass `requestedModel`

**Files:**
- Modify: `src/apps/ide/provider-server.ts`
- Modify: `desktop/src/lib/api.ts`

**Context:** The provider-server receives OpenAI-format requests and forwards to the router. The desktop API client sends the requests. Both need to thread the model name through.

**Step 1: Forward `model` field from request to router in provider-server**

In `provider-server.ts`, the `/v1/chat/completions` handler already parses `body.model`. Pass it to `routeChat`:

```typescript
const result = await router.routeChat(body.messages, {
  stream: body.stream,
  temperature: body.temperature,
  maxTokens: body.max_tokens,
  requestedModel: body.model !== "edgecoder-local" ? body.model : undefined,
});
```

**Step 2: Update `streamChat` in desktop API client to accept model**

In `desktop/src/lib/api.ts`, modify `streamChat`:

```typescript
export async function streamChat(
  messages: Array<{ role: string; content: string }>,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
  onProgress?: (progress: StreamProgress) => void,
  requestedModel?: string,
): Promise<void> {
```

And in the fetch body:

```typescript
body: JSON.stringify({
  model: requestedModel ?? "edgecoder-local",
  messages,
  stream: true,
  temperature: 0.7,
  max_tokens: 4096,
}),
```

**Step 3: Add `getAvailableModels()` to API client**

Add a new function to fetch swarm model availability:

```typescript
export interface SwarmModelInfo {
  model: string;
  paramSize: number;
  agentCount: number;
  avgLoad: number;
}

export const getAvailableModels = () =>
  get<SwarmModelInfo[]>(AGENT_BASE, "/models/available");
```

**Step 4: Commit**

```bash
git add src/apps/ide/provider-server.ts desktop/src/lib/api.ts
git commit -m "feat: thread requestedModel through provider-server and API client"
```

---

### Task 6: Add `selectedModel` to iOS `Conversation` and `StreamProgress`

**Files:**
- Modify: `ios/EdgeCoderIOS/EdgeCoderIOS/Chat/ChatModels.swift`

**Context:** `Conversation` needs to persist the user's model choice. `StreamProgress` needs a `creditsSpent` field.

**Step 1: Add `selectedModel` to `Conversation`**

In `ChatModels.swift`, add to the `Conversation` struct:

```swift
struct Conversation: Codable, Identifiable, Equatable {
    let id: String
    var title: String
    var messages: [ChatMessage]
    let source: Source
    let createdAt: Date
    var updatedAt: Date
    var selectedModel: String?  // <-- ADD THIS
    // ... rest unchanged
```

**Step 2: Add `creditsSpent` to `StreamProgress`**

```swift
struct StreamProgress {
    var tokenCount: Int = 0
    var elapsedMs: Int = 0
    var route: RouteDecision?
    var routeLabel: String = ""
    var model: String = ""
    var creditsSpent: Double?  // <-- ADD THIS
    // ... rest unchanged
```

**Step 3: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Chat/ChatModels.swift
git commit -m "feat: add selectedModel to Conversation, creditsSpent to StreamProgress"
```

---

### Task 7: Update iOS `ChatRouter` to accept `requestedModel`

**Files:**
- Modify: `ios/EdgeCoderIOS/EdgeCoderIOS/Chat/ChatRouter.swift`

**Context:** `routeChat()` and `routeChatStreaming()` need to filter routes by the requested model. BLE peers advertise their model — we can match against it. Swarm submissions need `requestedModel` in the payload.

**Step 1: Add `requestedModel` parameter to `routeChat`**

```swift
func routeChat(messages: [ChatMessage], requestedModel: String? = nil) async -> ChatRouteResult {
```

In the local model section, add a model match check:

```swift
if modelManager.state == .ready && activeConcurrent < concurrencyCap {
    // Skip local if user requested a different model
    if let requested = requestedModel,
       !requested.isEmpty,
       modelManager.selectedModel != requested {
        // Don't use local — model mismatch
    } else {
        // existing local inference logic
    }
}
```

In the BLE peer section, filter by model:

```swift
let matchingPeer = requestedModel != nil
    ? bleMeshManager.discoveredPeers.first(where: { $0.model == requestedModel })
    : bleMeshManager.discoveredPeers.first
if let peer = matchingPeer {
    // existing BLE logic
}
```

In the swarm section, add `requestedModel` to `submitChatTask`:

```swift
let swarmResult = try await swarmRuntime.submitChatTask(prompt: lastUserContent, requestedModel: requestedModel)
```

**Step 2: Add `requestedModel` to `routeChatStreaming`**

```swift
func routeChatStreaming(messages: [ChatMessage], requestedModel: String? = nil) -> StreamingSession {
```

Apply the same model-matching logic in the route decision:

```swift
// Determine route before streaming
if modelManager.state == .ready {
    if let requested = requestedModel, !requested.isEmpty, modelManager.selectedModel != requested {
        // Skip local — model mismatch
    } else {
        routeDecision = .local
        // ... existing local setup
    }
}
```

For BLE in streaming, match by model:

```swift
if routeDecision == .offlineStub && !bleMeshManager.discoveredPeers.isEmpty {
    let matchingPeer = requestedModel != nil
        ? bleMeshManager.discoveredPeers.first(where: { $0.model == requestedModel })
        : bleMeshManager.discoveredPeers.first
    if matchingPeer != nil {
        routeDecision = .blePeer
        // ...
    }
}
```

**Step 3: Update `StreamProgress` to include credits**

In the progress closure, add credits calculation:

```swift
let progress: () -> StreamProgress = {
    let paramSize = /* get from model catalog or peer info */
    StreamProgress(
        tokenCount: tokenCount,
        elapsedMs: Int((CFAbsoluteTimeGetCurrent() - startTime) * 1000),
        route: routeDecision,
        routeLabel: routeLabel,
        model: modelName,
        creditsSpent: routeDecision == .swarm ? max(0.5, paramSize) : nil
    )
}
```

**Step 4: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Chat/ChatRouter.swift
git commit -m "feat: ChatRouter honors requestedModel for local, BLE, and swarm routes"
```

---

### Task 8: Update iOS `SwarmRuntimeController.submitChatTask` with `requestedModel`

**Files:**
- Modify: `ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/SwarmRuntimeController.swift`

**Context:** `submitChatTask(prompt:)` builds the task payload POSTed to the coordinator. Add `requestedModel` to the payload.

**Step 1: Update method signature and payload**

```swift
func submitChatTask(prompt: String, requestedModel: String? = nil) async throws -> (output: String, taskId: String) {
    let taskId = "chat-\(Int(Date().timeIntervalSince1970 * 1000))"
    var submitPayload: [String: Any] = [
        "taskId": taskId,
        "prompt": prompt,
        "language": "python",
        "submitterAccountId": agentId,
        "projectId": "chat-requests",
        "resourceClass": "cpu",
        "priority": 60,
        "subtasks": [["prompt": prompt, "language": "python"]]
    ]
    if let model = requestedModel {
        submitPayload["requestedModel"] = model
    }
    // ... rest unchanged
```

**Step 2: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/SwarmRuntimeController.swift
git commit -m "feat: submitChatTask passes requestedModel to coordinator"
```

---

### Task 9: Build iOS `ModelPickerSheet`

**Files:**
- Create: `ios/EdgeCoderIOS/EdgeCoderIOS/Chat/ModelPickerSheet.swift`

**Context:** A SwiftUI sheet showing all known models grouped into sections. Takes bindings for the selected model and whether the sheet is shown. Reads from `LocalModelManager` (local models), `BLEMeshManager` (nearby peers), and fetches `GET /models/available` from the coordinator (swarm models).

**Step 1: Create the file**

```swift
import SwiftUI

struct ModelPickerSheet: View {
    @Binding var selectedModel: String?
    @Binding var isPresented: Bool

    @EnvironmentObject private var sessionStore: SessionStore

    let localModels: [InstalledModel]
    let localActiveModel: String
    let catalogModels: [CatalogModel]
    let blePeers: [BLEPeer]
    @State private var swarmModels: [SwarmModelInfo] = []
    @State private var isLoadingSwarm = false

    struct SwarmModelInfo: Identifiable {
        let model: String
        let paramSize: Double
        let agentCount: Int
        let avgLoad: Double
        var id: String { model }
    }

    var body: some View {
        NavigationView {
            List {
                // On This Device
                Section("On This Device") {
                    ForEach(catalogModels) { catalog in
                        let installed = localModels.first(where: { $0.modelId == catalog.modelId })
                        let isActive = catalog.modelId == localActiveModel
                        let isAvailable = installed != nil

                        Button {
                            if isAvailable {
                                selectedModel = catalog.modelId
                                isPresented = false
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(catalog.displayName)
                                        .font(.subheadline)
                                        .foregroundColor(isAvailable ? Theme.textPrimary : Theme.textMuted)
                                    HStack(spacing: 8) {
                                        Text("\(String(format: "%.1f", catalog.paramSize))B")
                                            .font(.caption)
                                            .foregroundColor(Theme.textMuted)
                                        Text("Free")
                                            .font(.caption)
                                            .foregroundColor(Theme.accent)
                                    }
                                }
                                Spacer()
                                if isActive && (selectedModel == nil || selectedModel == catalog.modelId) {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundColor(Theme.accent)
                                } else if !isAvailable {
                                    Text("Not downloaded")
                                        .font(.caption2)
                                        .foregroundColor(Theme.textMuted)
                                }
                            }
                        }
                        .disabled(!isAvailable)
                    }
                }

                // Nearby Devices
                if !blePeers.isEmpty {
                    Section("Nearby Devices") {
                        ForEach(blePeers, id: \.agentId) { peer in
                            Button {
                                selectedModel = peer.model
                                isPresented = false
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(peer.model)
                                            .font(.subheadline)
                                            .foregroundColor(Theme.textPrimary)
                                        HStack(spacing: 8) {
                                            Text("\(String(format: "%.1f", peer.modelParamSize))B")
                                                .font(.caption)
                                                .foregroundColor(Theme.textMuted)
                                            Text("Free")
                                                .font(.caption)
                                                .foregroundColor(Theme.accent)
                                            Text(peer.agentId)
                                                .font(.caption2)
                                                .foregroundColor(Theme.textMuted)
                                                .lineLimit(1)
                                        }
                                    }
                                    Spacer()
                                    if selectedModel == peer.model {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundColor(Theme.accent)
                                    }
                                    // Signal indicator
                                    Image(systemName: peer.rssi > -60 ? "wifi" : "wifi.exclamationmark")
                                        .font(.caption)
                                        .foregroundColor(Theme.textMuted)
                                }
                            }
                        }
                    }
                }

                // Swarm Network
                if !swarmModels.isEmpty {
                    Section("Swarm Network") {
                        ForEach(swarmModels) { model in
                            let cost = max(0.5, model.paramSize)
                            let available = model.agentCount > 0
                            Button {
                                if available {
                                    selectedModel = model.model
                                    isPresented = false
                                }
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(model.model)
                                            .font(.subheadline)
                                            .foregroundColor(available ? Theme.textPrimary : Theme.textMuted)
                                        HStack(spacing: 8) {
                                            Text("\(String(format: "%.1f", model.paramSize))B")
                                                .font(.caption)
                                                .foregroundColor(Theme.textMuted)
                                            Text("\(String(format: "%.1f", cost)) credits")
                                                .font(.caption)
                                                .foregroundColor(Theme.accent)
                                            Text("\(model.agentCount) agent\(model.agentCount == 1 ? "" : "s")")
                                                .font(.caption2)
                                                .foregroundColor(Theme.textMuted)
                                        }
                                    }
                                    Spacer()
                                    if !available {
                                        Text("No agents")
                                            .font(.caption2)
                                            .foregroundColor(Theme.textMuted)
                                    } else if selectedModel == model.model {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundColor(Theme.accent)
                                    }
                                }
                            }
                            .disabled(!available)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Select Model")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isPresented = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Auto") {
                        selectedModel = nil
                        isPresented = false
                    }
                    .foregroundColor(Theme.textSecondary)
                }
            }
            .onAppear { fetchSwarmModels() }
        }
    }

    private func fetchSwarmModels() {
        guard !isLoadingSwarm else { return }
        isLoadingSwarm = true
        let coordinatorURL = SwarmRuntimeController.shared.selectedCoordinatorURL
        guard let url = URL(string: "\(coordinatorURL)/models/available") else { return }

        Task {
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                let decoded = try JSONDecoder().decode([SwarmModelDTO].self, from: data)
                swarmModels = decoded.map {
                    SwarmModelInfo(model: $0.model, paramSize: $0.paramSize, agentCount: $0.agentCount, avgLoad: $0.avgLoad)
                }
            } catch {
                // Silent — swarm models just won't show
            }
            isLoadingSwarm = false
        }
    }

    private struct SwarmModelDTO: Decodable {
        let model: String
        let paramSize: Double
        let agentCount: Int
        let avgLoad: Double
    }
}
```

**Step 2: Register in Xcode project**

Add `ModelPickerSheet.swift` to the Chat group in `project.pbxproj`.

**Step 3: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Chat/ModelPickerSheet.swift ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj/project.pbxproj
git commit -m "feat: add iOS ModelPickerSheet with local, BLE, and swarm sections"
```

---

### Task 10: Wire model picker into iOS `ChatView`

**Files:**
- Modify: `ios/EdgeCoderIOS/EdgeCoderIOS/Chat/ChatView.swift`

**Context:** Add a model picker button to the chat header, persist selection per conversation, and pass the selected model to `routeChatStreaming()`.

**Step 1: Add state and sheet**

Add to existing `@State` properties:

```swift
@State private var showModelPicker = false
```

**Step 2: Add model picker button to header**

In the `header` computed property, add a button between the title and the right-side buttons. Replace the existing `Text(conversation.title)` center section with:

```swift
Button {
    showModelPicker = true
} label: {
    HStack(spacing: 4) {
        Text(conversation.selectedModel ?? "Auto")
            .font(.subheadline.weight(.medium))
            .foregroundColor(Theme.textPrimary)
        Image(systemName: "chevron.up.chevron.down")
            .font(.caption2)
            .foregroundColor(Theme.textMuted)
    }
}
```

**Step 3: Add the sheet**

Add to the body's `.sheet` modifiers:

```swift
.sheet(isPresented: $showModelPicker) {
    ModelPickerSheet(
        selectedModel: $conversation.selectedModel,
        isPresented: $showModelPicker,
        localModels: chatRouter.modelManager.installedModels,
        localActiveModel: chatRouter.modelManager.selectedModel,
        catalogModels: chatRouter.modelManager.availableCatalog,
        blePeers: chatRouter.bleMeshManager.discoveredPeers
    )
}
```

Note: `chatRouter` has `modelManager` and `bleMeshManager` — check if they're accessible. If they're private, expose them or pass via init. The `ChatRouter` currently stores them as `private let` — change to `let` (internal access).

**Step 4: Pass `requestedModel` to router in `sendMessage()`**

In `sendMessage()`, update the streaming call:

```swift
let session = chatRouter.routeChatStreaming(
    messages: conversation.messages,
    requestedModel: conversation.selectedModel
)
```

**Step 5: Save conversation after model change**

The model selection is already bound to `conversation.selectedModel` and persists when the conversation is saved.

**Step 6: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Chat/ChatView.swift
git commit -m "feat: wire model picker into iOS ChatView header"
```

---

### Task 11: Update iOS `ChatRouter` access modifiers

**Files:**
- Modify: `ios/EdgeCoderIOS/EdgeCoderIOS/Chat/ChatRouter.swift`

**Context:** `ChatView` needs access to `modelManager` and `bleMeshManager` to pass data to `ModelPickerSheet`. They're currently `private let`.

**Step 1: Change access level**

Change from:

```swift
private let modelManager: LocalModelManager
private let swarmRuntime: SwarmRuntimeController
private let bleMeshManager: BLEMeshManager
```

To:

```swift
let modelManager: LocalModelManager
let swarmRuntime: SwarmRuntimeController
let bleMeshManager: BLEMeshManager
```

**Step 2: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Chat/ChatRouter.swift
git commit -m "feat: expose ChatRouter dependencies for model picker"
```

---

### Task 12: Build desktop `ModelPicker` Svelte component

**Files:**
- Create: `desktop/src/components/ModelPicker.svelte`

**Context:** A dropdown component for the desktop chat header. Shows local Ollama models, swarm models, and the current selection. Matches the Cursor-style inline picker.

**Step 1: Create the component**

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { getOllamaTags, getOllamaPs, getAvailableModels } from "../lib/api";
  import type { OllamaModel, OllamaRunningModel, SwarmModelInfo } from "../lib/api";

  interface Props {
    selectedModel?: string;
    onSelect: (model: string | undefined) => void;
  }
  let { selectedModel, onSelect }: Props = $props();

  let open = $state(false);
  let ollamaModels: OllamaModel[] = $state([]);
  let runningModels: OllamaRunningModel[] = $state([]);
  let swarmModels: SwarmModelInfo[] = $state([]);

  function displayLabel(model?: string): string {
    if (!model) return "Auto";
    // Shorten "qwen2.5-coder:7b-instruct-q4_K_M" → "qwen2.5-coder:7b"
    const parts = model.split(":");
    const name = parts[0];
    const tag = parts[1]?.split("-")[0] ?? "";
    return tag ? `${name}:${tag}` : name;
  }

  function paramSizeFromDetails(details: { parameter_size: string }): number {
    const match = details.parameter_size.match(/([\d.]+)/);
    return match ? parseFloat(match[1]) : 0;
  }

  async function refresh() {
    try {
      const [tags, ps, swarm] = await Promise.all([
        getOllamaTags(),
        getOllamaPs(),
        getAvailableModels().catch(() => []),
      ]);
      ollamaModels = tags.models ?? [];
      runningModels = ps.models ?? [];
      swarmModels = swarm;
    } catch {
      // Silent
    }
  }

  function selectModel(model: string | undefined) {
    onSelect(model);
    open = false;
  }

  function isRunning(name: string): boolean {
    return runningModels.some(m => m.name === name || m.model === name);
  }
</script>

<div class="model-picker">
  <button class="picker-trigger" onclick={() => { open = !open; if (!open) return; refresh(); }}>
    <span class="picker-label">{displayLabel(selectedModel)}</span>
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  </button>

  {#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="picker-backdrop" onclick={() => { open = false; }}></div>
    <div class="picker-dropdown">
      <button class="picker-option" class:active={!selectedModel} onclick={() => selectModel(undefined)}>
        <span class="option-name">Auto</span>
        <span class="option-meta">Best available route</span>
      </button>

      {#if ollamaModels.length > 0}
        <div class="picker-section-label">Local Models</div>
        {#each ollamaModels as model}
          <button
            class="picker-option"
            class:active={selectedModel === model.name}
            onclick={() => selectModel(model.name)}
          >
            <span class="option-name">
              {displayLabel(model.name)}
              {#if isRunning(model.name)}
                <span class="running-dot"></span>
              {/if}
            </span>
            <span class="option-meta">
              {model.details.parameter_size} · Free
            </span>
          </button>
        {/each}
      {/if}

      {#if swarmModels.length > 0}
        <div class="picker-section-label">Swarm Network</div>
        {#each swarmModels as model}
          {@const cost = Math.max(0.5, model.paramSize)}
          <button
            class="picker-option"
            class:active={selectedModel === model.model}
            class:disabled={model.agentCount === 0}
            disabled={model.agentCount === 0}
            onclick={() => selectModel(model.model)}
          >
            <span class="option-name">{displayLabel(model.model)}</span>
            <span class="option-meta">
              {model.paramSize}B · {cost.toFixed(1)} credits · {model.agentCount} agent{model.agentCount === 1 ? '' : 's'}
            </span>
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .model-picker {
    position: relative;
  }
  .picker-trigger {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border: 0.5px solid var(--border);
    background: var(--bg-surface);
    color: var(--text-secondary);
    border-radius: var(--radius-sm);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
  }
  .picker-trigger:hover {
    border-color: var(--accent);
    color: var(--text-primary);
  }
  .picker-label {
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .picker-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }
  .picker-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    min-width: 240px;
    max-height: 360px;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 0.5px solid var(--border-strong);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
    z-index: 100;
    padding: 4px;
  }
  .picker-section-label {
    padding: 8px 10px 4px;
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .picker-option {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    padding: 8px 10px;
    border: none;
    background: none;
    color: var(--text-primary);
    cursor: pointer;
    border-radius: var(--radius-sm);
    text-align: left;
    transition: background 0.1s;
  }
  .picker-option:hover:not(:disabled) {
    background: var(--bg-surface);
  }
  .picker-option.active {
    border-left: 2px solid var(--accent);
    padding-left: 8px;
  }
  .picker-option.disabled {
    opacity: 0.4;
    cursor: default;
  }
  .option-name {
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .option-meta {
    font-size: 11px;
    color: var(--text-muted);
  }
  .running-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
</style>
```

**Step 2: Commit**

```bash
git add desktop/src/components/ModelPicker.svelte
git commit -m "feat: add desktop ModelPicker dropdown component"
```

---

### Task 13: Wire `ModelPicker` into desktop ChatView and EditorChatPanel

**Files:**
- Modify: `desktop/src/pages/ChatView.svelte`
- Modify: `desktop/src/components/EditorChatPanel.svelte`
- Modify: `desktop/src/lib/types.ts`

**Context:** Both chat surfaces need the model picker in their header and need to pass the selected model through to `streamChat()`.

**Step 1: Add `selectedModel` to desktop `Conversation` type**

In `desktop/src/lib/types.ts`, add to the `Conversation` interface:

```typescript
export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  source?: "chat" | "editor";
  selectedModel?: string;  // <-- ADD THIS
}
```

**Step 2: Wire into ChatView**

In `ChatView.svelte`:

1. Import `ModelPicker`:
```svelte
import ModelPicker from "../components/ModelPicker.svelte";
```

2. Add to the empty state / header area — place the `ModelPicker` component near the top of the chat view. Since `ChatView` doesn't have its own header (it's rendered inside a layout), add the model picker above the messages area or in the quick actions area:

```svelte
<div class="model-selector">
  <ModelPicker
    selectedModel={conversation.selectedModel}
    onSelect={(model) => { conversation.selectedModel = model; conversation = conversation; }}
  />
</div>
```

3. Pass model to `streamChat`:
```svelte
await streamChat(
  apiMessages,
  (chunk) => { streamingContent += chunk; scrollToBottom(); },
  abortController.signal,
  (progress) => { streamProgress = progress; },
  conversation.selectedModel,
);
```

**Step 3: Wire into EditorChatPanel**

Same pattern — add `ModelPicker` in the panel header next to the conversation selector, and pass `conversation.selectedModel` to `streamChat`.

**Step 4: Commit**

```bash
git add desktop/src/pages/ChatView.svelte desktop/src/components/EditorChatPanel.svelte desktop/src/lib/types.ts
git commit -m "feat: wire ModelPicker into desktop ChatView and EditorChatPanel"
```

---

### Task 14: Update iOS `MessageBubble` to show credits

**Files:**
- Modify: `ios/EdgeCoderIOS/EdgeCoderIOS/Chat/MessageBubble.swift`

**Context:** The streaming progress view should show credits spent when routing through the swarm.

**Step 1: Add credits display**

In the `streamingProgressView` computed property, after the route info section, add:

```swift
if let credits = progress?.creditsSpent {
    Text("· \(String(format: "%.1f", credits)) credits")
        .font(.caption)
        .foregroundColor(Theme.accent)
}
```

**Step 2: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Chat/MessageBubble.swift
git commit -m "feat: show credits spent in iOS streaming progress"
```

---

### Task 15: Update iOS `project.pbxproj` and build verification

**Files:**
- Modify: `ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj/project.pbxproj`

**Context:** The new `ModelPickerSheet.swift` file needs to be registered in the Xcode project.

**Step 1: Add file references**

Add `ModelPickerSheet.swift` to the PBXBuildFile, PBXFileReference, PBXGroup (Chat group), and PBXSourcesBuildPhase sections following the same pattern as existing Chat files.

**Step 2: Build**

```bash
xcodebuild -project EdgeCoderIOS.xcodeproj -scheme EdgeCoderIOS -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build 2>&1 | tail -10
```
Expected: BUILD SUCCEEDED

**Step 3: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj/project.pbxproj
git commit -m "chore: register ModelPickerSheet in Xcode project"
```

---

### Task 16: Replace flat credit cost in iOS `SwarmRuntimeController`

**Files:**
- Modify: `ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/SwarmRuntimeController.swift`

**Context:** Line 465 hardcodes `creditsEarned += 5` and line 469 hardcodes `creditsEarned += 2`. These should use the model's param size.

**Step 1: Update credit calculation**

In `pollAndExecuteTask()`, replace:

```swift
if result.ok {
    tasksCompleted += 1
    creditsEarned += 5
    appendEvent("Task \(subtaskId.prefix(8))… completed (\(result.durationMs)ms) — +5 credits")
} else {
    tasksFailed += 1
    creditsEarned += 2
    appendEvent("Task \(subtaskId.prefix(8))… failed (\(result.durationMs)ms) — +2 credits")
}
```

With:

```swift
let earnedCredits = Int(max(0.5, modelManager.selectedModelParamSize))
if result.ok {
    tasksCompleted += 1
    creditsEarned += earnedCredits
    appendEvent("Task \(subtaskId.prefix(8))… completed (\(result.durationMs)ms) — +\(earnedCredits) credits")
} else {
    tasksFailed += 1
    let failCredits = max(1, earnedCredits / 2)
    creditsEarned += failCredits
    appendEvent("Task \(subtaskId.prefix(8))… failed (\(result.durationMs)ms) — +\(failCredits) credits")
}
```

**Step 2: Also update `ChatRouter.swift` where it hardcodes `creditsSpent: 5`**

In `ChatRouter.swift`, in the swarm section of `routeChat()`, replace:

```swift
creditsSpent: 5,
```

With:

```swift
creditsSpent: Int(max(0.5, /* paramSize from the model or default */ 1.0)),
```

The exact param size should come from the model catalog or swarm response. For now use a default and refine in task 7.

**Step 3: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/SwarmRuntimeController.swift ios/EdgeCoderIOS/EdgeCoderIOS/Chat/ChatRouter.swift
git commit -m "feat: replace flat credit costs with per-param-size pricing"
```

---

## Verification

1. **Build all platforms:**
   - iOS: `xcodebuild -project EdgeCoderIOS.xcodeproj -scheme EdgeCoderIOS build`
   - Desktop: `cd desktop && npm run build`
   - Server: `cd src && npx tsc --noEmit`

2. **iOS model picker:**
   - Tap model button in chat header → sheet opens
   - Shows installed local models, BLE peers (if nearby), swarm models
   - Tap model → selection persists, sheet dismisses
   - Send message → routes to selected model
   - "Auto" button clears selection → falls back to default waterfall

3. **Desktop model picker:**
   - Click model dropdown in chat header → popover opens
   - Shows local Ollama models (with green dot for loaded), swarm models
   - Click model → selection persists, dropdown closes
   - Send message → routes to selected model via provider-server

4. **Credit pricing:**
   - Swarm task with 7B model charges 7 credits (not flat 5)
   - Streaming progress shows credits for swarm routes
   - Local/BLE routes show "Free"

5. **Model-specific routing:**
   - Select model X when local has model Y → skips local, tries BLE/swarm
   - BLE peers filtered by model match
   - Swarm task includes `requestedModel` field
