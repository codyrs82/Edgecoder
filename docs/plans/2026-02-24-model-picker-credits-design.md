# Model Picker + Credit System Redesign

## Goal

Add a Cursor-style model switching menu to the chat screen on both iOS and desktop so users can pick which model to route to. Redesign the credit system to charge per-billion-parameter instead of a flat rate.

## Architecture

The model picker is a compact UI element in the chat header that shows the selected model and opens a grouped list of all known models (local, BLE peers, swarm). The selected model is passed through the router, which filters routes to honor the user's choice. Credit pricing becomes proportional to model size.

---

## 1. Model Picker UI

### iOS
A compact button in the chat header showing the currently selected model name + chevron. Tapping opens a sheet with models grouped into sections:

- **On this device** — locally installed models from `LocalModelManager` (Qwen 0.5B, 1.5B, 3B, 7B). Shows download state.
- **Nearby devices** — BLE peers from `BLEMeshManager.discoveredPeers`, showing agent ID + active model + signal strength.
- **Swarm network** — models available via coordinator (from capability gossip). Shows agent count per model.

Each row shows: model name, param size, estimated cost (credits or "Free"), and availability status. Unavailable models are grayed out with a reason ("Not downloaded", "Peer offline", "No agents online"). Tapping an available model selects it and dismisses the sheet. The selected model persists per conversation.

### Desktop
Same concept: a dropdown button in the chat header and editor chat panel. Click opens a popover with the same grouped sections. Desktop pulls local models from Ollama and swarm data from the coordinator. Nearby devices section is hidden on desktop (no BLE scanning).

---

## 2. Credit Pricing by Model Size

Replace the flat 5-credit swarm cost with a per-billion-parameter rate:

- **Base rate:** 1 credit per billion parameters per request
- **Minimum:** 0.5 credits (so even tiny models aren't free on swarm)
- **Examples:** Qwen 0.5B = 0.5 credits, Qwen 3B = 3 credits, Qwen 7B = 7 credits, 13B model = 13 credits
- **Local and BLE routes remain free** — using your own or a nearby peer's hardware
- **Swarm route charges credits** — based on the requested model's param size

New function `modelCostCredits(paramSizeB: number): number` in `pricing.ts` returns `Math.max(0.5, paramSizeB)`.

The existing GPU-time pricing (`accrueCredits`) still governs how much the fulfilling agent earns — unchanged. This separates "what the requester pays" (model-based) from "what the worker earns" (compute-time-based).

**Credit display:** The model picker shows estimated cost next to each swarm model (e.g. "7 credits") and "Free" next to local/BLE options. The streaming progress indicator shows credits spent for the current request.

---

## 3. Model-Specific Routing

The router honors the user's model choice with this updated logic:

1. **User selects model X** in the picker
2. **Local check** — is model X loaded locally? If yes, route local (free)
3. **BLE check** — does any discovered peer have model X active? If yes, route to that peer (free). If multiple peers have it, pick lowest load / best signal
4. **Swarm check** — submit task to coordinator with `requestedModel: "X"`. Coordinator matches to agents running model X. If no match within 30s, falls back to any available agent and returns what model actually fulfilled it
5. **Offline stub** — if nothing is reachable

### Data flow changes

- `Conversation` gains `selectedModel: String?` (persisted so reloading restores the choice)
- `ChatRouter.routeChat()` / `routeChatStreaming()` accept `requestedModel: String?`
- Swarm task submission adds `requestedModel` to the POST payload
- Coordinator `claim()` gains model-matching filter: prefer agents with requested model, fall back to any after timeout
- `ChatRouteResult.model` tells the user what model actually responded (may differ if fallback)

---

## 4. Model Catalog Sources

### On this device
- iOS: `LocalModelManager.catalog` + `installedModels`. Active model highlighted.
- Desktop: Ollama `/api/tags` for installed, `/api/ps` for loaded. Active highlighted.

### Nearby devices (iOS only)
- `BLEMeshManager.discoveredPeers` — each peer advertises `model` + `modelParamSize` in GATT payload. Live-updating.

### Swarm network
- New coordinator endpoint: `GET /models/available`
- Returns aggregated model availability from capability gossip: `[{ model, paramSize, agentCount, avgLoad }]`
- Fetched on picker open, cached 30 seconds

### Grayed-out states
- Local model not downloaded → "Not downloaded" (download button inline)
- BLE peer went stale → removed from list automatically
- Swarm model with 0 agents → "No agents online"

---

## 5. Changes Summary

| Area | Change |
|------|--------|
| iOS ChatView | Model picker button in header, opens ModelPickerSheet |
| iOS MessageBubble | Show credits spent in streaming progress |
| iOS ChatRouter | Accept requestedModel param, filter BLE peers by model |
| iOS ChatModels | Add selectedModel to Conversation, credits to StreamProgress |
| Desktop ChatView | Model picker dropdown in header |
| Desktop EditorChatPanel | Same model picker dropdown |
| Desktop API client | Pass requestedModel to provider-server |
| Provider server | Forward requestedModel to router |
| IntelligentRouter | Accept requestedModel, filter routes by model |
| Coordinator | New GET /models/available endpoint, model-matching in claim() |
| Task submission | Add requestedModel field to task payload |
| Credit pricing | New modelCostCredits(paramSizeB) function, replace flat 5-credit cost |
| Swarm queue | Filter claim() to prefer agents with requested model |

## Not in Scope

- Desktop BLE scanning
- Model auto-download on demand
- Credit balance display UI (server-side tracking exists, display is a separate feature)
