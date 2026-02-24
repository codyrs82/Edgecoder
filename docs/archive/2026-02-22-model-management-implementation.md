# Model Management & Network-Wide Capability Advertisement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement full model management — on-device model swap UI (iOS llama.cpp + SwiftUI, Node.js HTTP + CLI), BLE re-advertisement on model change, coordinator capability gossip across the federation, P2P model distribution, and documentation updates.

**Architecture:** Every device manages its own model lifecycle (download, activate, unload). Model changes propagate through three layers: local persistence, BLE mesh re-advertisement, and coordinator heartbeat. Coordinators gossip aggregated capability summaries to federation peers, enabling cross-coordinator task routing. Models distribute peer-to-peer through the agent mesh, reducing CDN dependency.

**Tech Stack:** TypeScript (Fastify, Vitest, Zod), Swift (llama.cpp SPM, CoreBluetooth, SwiftUI), Ollama HTTP API, VitePress docs

---

## Task 1: Model Catalog Types

**Files:**
- Modify: `src/common/types.ts` (append after BLE types, around line 160+)
- Test: `tests/model/catalog-types.test.ts`

**Step 1: Write the failing test**

Create `tests/model/catalog-types.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type {
  ModelCatalogEntry,
  ModelSwapRequest,
  ModelSwapResponse,
  ModelStatusResponse,
  CapabilitySummaryPayload,
} from "../../src/common/types.js";

describe("ModelCatalogEntry type", () => {
  it("accepts a valid catalog entry", () => {
    const entry: ModelCatalogEntry = {
      modelId: "qwen2.5-coder-1.5b-q4",
      displayName: "Qwen 2.5 Coder 1.5B (Q4_K_M)",
      paramSize: 1.5,
      quantization: "Q4_K_M",
      fileSizeBytes: 1_200_000_000,
      downloadUrl: "https://models.edgecoder.io/qwen2.5-coder-1.5b-q4.gguf",
      checksumSha256: "abc123",
      platform: "all",
      languages: ["python", "javascript"],
      minMemoryMB: 2048,
    };
    expect(entry.modelId).toBe("qwen2.5-coder-1.5b-q4");
    expect(entry.platform).toBe("all");
  });
});

describe("ModelSwapRequest type", () => {
  it("accepts a swap request", () => {
    const req: ModelSwapRequest = { model: "qwen2.5-coder:7b" };
    expect(req.model).toBe("qwen2.5-coder:7b");
  });
});

describe("ModelSwapResponse type", () => {
  it("accepts a ready response", () => {
    const res: ModelSwapResponse = {
      previous: "qwen2.5-coder:1.5b",
      active: "qwen2.5-coder:7b",
      status: "ready",
      paramSize: 7,
    };
    expect(res.status).toBe("ready");
  });

  it("accepts a pulling response", () => {
    const res: ModelSwapResponse = {
      previous: "qwen2.5-coder:1.5b",
      active: "qwen2.5-coder:1.5b",
      status: "pulling",
      paramSize: 1.5,
      progress: 42,
    };
    expect(res.status).toBe("pulling");
    expect(res.progress).toBe(42);
  });
});

describe("ModelStatusResponse type", () => {
  it("accepts a status response", () => {
    const res: ModelStatusResponse = {
      model: "qwen2.5-coder:7b",
      paramSize: 7,
      status: "ready",
      ollamaHealthy: true,
    };
    expect(res.ollamaHealthy).toBe(true);
  });
});

describe("CapabilitySummaryPayload type", () => {
  it("accepts a capability summary", () => {
    const summary: CapabilitySummaryPayload = {
      coordinatorId: "coord-1",
      agentCount: 5,
      modelAvailability: {
        "qwen2.5-coder:7b": {
          agentCount: 3,
          totalParamCapacity: 21,
          avgLoad: 0.5,
        },
      },
      timestamp: Date.now(),
    };
    expect(summary.agentCount).toBe(5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/model/catalog-types.test.ts`
Expected: FAIL — types not exported from types.ts

**Step 3: Write minimal implementation**

Append these types to `src/common/types.ts` after the existing BLE types:

```typescript
/* ── Model Catalog & Swap ──────────────────────────────── */

export interface ModelCatalogEntry {
  modelId: string;
  displayName: string;
  paramSize: number;
  quantization: string;
  fileSizeBytes: number;
  downloadUrl: string;
  checksumSha256: string;
  platform: "ios" | "node" | "all";
  languages: string[];
  minMemoryMB: number;
}

export interface ModelSwapRequest {
  model: string;
}

export interface ModelSwapResponse {
  previous: string;
  active: string;
  status: "ready" | "pulling" | "error";
  paramSize: number;
  progress?: number;
  error?: string;
}

export interface ModelStatusResponse {
  model: string;
  paramSize: number;
  status: "ready" | "loading" | "error" | "no_model";
  ollamaHealthy: boolean;
  pullProgress?: number;
}

export interface ModelListEntry {
  modelId: string;
  paramSize: number;
  quantization?: string;
  installed: boolean;
  active: boolean;
  source: "ollama" | "cdn";
}

export interface CapabilitySummaryPayload {
  coordinatorId: string;
  agentCount: number;
  modelAvailability: {
    [modelName: string]: {
      agentCount: number;
      totalParamCapacity: number;
      avgLoad: number;
    };
  };
  timestamp: number;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/model/catalog-types.test.ts`
Expected: PASS — all 5 type checks compile and pass

**Step 5: Commit**

```bash
git add src/common/types.ts tests/model/catalog-types.test.ts
git commit -m "feat: add model catalog, swap, status, and capability summary types"
```

---

## Task 2: Node.js Model Swap HTTP Endpoints

**Files:**
- Create: `src/model/swap.ts`
- Test: `tests/model/swap.test.ts`

**Context:** The inference service runs on port 4302 at `src/inference/service.ts`. The existing `ProviderRegistry` is at `src/model/providers.ts` with `OllamaLocalProvider` that wraps `http://127.0.0.1:11434/api/generate`. The Ollama health check is `GET http://127.0.0.1:11434/api/tags`. Environment variables: `OLLAMA_HOST` (default `http://127.0.0.1:11434`), `OLLAMA_MODEL`.

**Step 1: Write the failing test**

Create `tests/model/swap.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  swapModel,
  getModelStatus,
  listModels,
  type OllamaTagsResponse,
} from "../../src/model/swap.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function ollamaTagsResponse(models: Array<{ name: string; size: number }>): OllamaTagsResponse {
  return {
    models: models.map((m) => ({
      name: m.name,
      model: m.name,
      size: m.size,
      digest: "sha256:abc123",
      details: {
        parameter_size: `${(m.size / 1e9).toFixed(1)}B`,
        quantization_level: "Q4_0",
      },
      modified_at: new Date().toISOString(),
    })),
  };
}

describe("swapModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("swaps to an installed model", async () => {
    // First call: GET /api/tags — model exists
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ollamaTagsResponse([
        { name: "qwen2.5-coder:1.5b", size: 1_500_000_000 },
        { name: "qwen2.5-coder:7b", size: 7_000_000_000 },
      ]),
    });

    const result = await swapModel("qwen2.5-coder:7b", "qwen2.5-coder:1.5b");
    expect(result.status).toBe("ready");
    expect(result.active).toBe("qwen2.5-coder:7b");
    expect(result.previous).toBe("qwen2.5-coder:1.5b");
    expect(result.paramSize).toBeCloseTo(7, 0);
  });

  it("returns pulling status for uninstalled model", async () => {
    // GET /api/tags — model not in list
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ollamaTagsResponse([
        { name: "qwen2.5-coder:1.5b", size: 1_500_000_000 },
      ]),
    });
    // POST /api/pull — starts pull
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "success" }),
    });

    const result = await swapModel("qwen2.5-coder:7b", "qwen2.5-coder:1.5b");
    expect(result.status).toBe("pulling");
    expect(result.active).toBe("qwen2.5-coder:1.5b");
  });

  it("returns error when Ollama unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await swapModel("qwen2.5-coder:7b", "qwen2.5-coder:1.5b");
    expect(result.status).toBe("error");
    expect(result.error).toContain("ollama_not_running");
  });
});

describe("getModelStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ready status for active model", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ollamaTagsResponse([
        { name: "qwen2.5-coder:7b", size: 7_000_000_000 },
      ]),
    });

    const result = await getModelStatus("qwen2.5-coder:7b");
    expect(result.status).toBe("ready");
    expect(result.ollamaHealthy).toBe(true);
    expect(result.model).toBe("qwen2.5-coder:7b");
  });

  it("returns error when Ollama unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await getModelStatus("qwen2.5-coder:7b");
    expect(result.ollamaHealthy).toBe(false);
  });
});

describe("listModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns installed models from Ollama", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ollamaTagsResponse([
        { name: "qwen2.5-coder:1.5b", size: 1_500_000_000 },
        { name: "qwen2.5-coder:7b", size: 7_000_000_000 },
      ]),
    });

    const result = await listModels("qwen2.5-coder:7b");
    expect(result).toHaveLength(2);
    const active = result.find((m) => m.active);
    expect(active?.modelId).toBe("qwen2.5-coder:7b");
    expect(result.every((m) => m.installed)).toBe(true);
    expect(result.every((m) => m.source === "ollama")).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/model/swap.test.ts`
Expected: FAIL — module `../../src/model/swap.js` not found

**Step 3: Write minimal implementation**

Create `src/model/swap.ts`:

```typescript
import type {
  ModelSwapResponse,
  ModelStatusResponse,
  ModelListEntry,
} from "../common/types.js";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

export interface OllamaTagsResponse {
  models: Array<{
    name: string;
    model: string;
    size: number;
    digest: string;
    details: {
      parameter_size: string;
      quantization_level: string;
    };
    modified_at: string;
  }>;
}

function parseParamSize(sizeStr: string): number {
  const match = sizeStr.match(/([\d.]+)\s*[Bb]/);
  return match ? parseFloat(match[1]) : 0;
}

function paramSizeFromBytes(sizeBytes: number): number {
  return Math.round((sizeBytes / 1e9) * 10) / 10;
}

async function ollamaTags(): Promise<OllamaTagsResponse> {
  const res = await fetch(`${OLLAMA_HOST}/api/tags`);
  if (!res.ok) throw new Error(`ollama_tags_failed: ${res.status}`);
  return res.json() as Promise<OllamaTagsResponse>;
}

export async function swapModel(
  targetModel: string,
  currentModel: string,
): Promise<ModelSwapResponse> {
  let tags: OllamaTagsResponse;
  try {
    tags = await ollamaTags();
  } catch {
    return {
      previous: currentModel,
      active: currentModel,
      status: "error",
      paramSize: 0,
      error: "ollama_not_running: Start Ollama with: ollama serve",
    };
  }

  const installed = tags.models.find((m) => m.name === targetModel);
  if (installed) {
    const paramSize = parseParamSize(installed.details.parameter_size)
      || paramSizeFromBytes(installed.size);
    return {
      previous: currentModel,
      active: targetModel,
      status: "ready",
      paramSize,
    };
  }

  // Model not installed — trigger pull
  try {
    await fetch(`${OLLAMA_HOST}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: targetModel, stream: false }),
    });
  } catch {
    return {
      previous: currentModel,
      active: currentModel,
      status: "error",
      paramSize: 0,
      error: "pull_failed",
    };
  }

  return {
    previous: currentModel,
    active: currentModel,
    status: "pulling",
    paramSize: 0,
    progress: 0,
  };
}

export async function getModelStatus(
  activeModel: string,
): Promise<ModelStatusResponse> {
  try {
    const tags = await ollamaTags();
    const found = tags.models.find((m) => m.name === activeModel);
    if (!found) {
      return {
        model: activeModel,
        paramSize: 0,
        status: "no_model",
        ollamaHealthy: true,
      };
    }
    const paramSize = parseParamSize(found.details.parameter_size)
      || paramSizeFromBytes(found.size);
    return {
      model: activeModel,
      paramSize,
      status: "ready",
      ollamaHealthy: true,
    };
  } catch {
    return {
      model: activeModel,
      paramSize: 0,
      status: "error",
      ollamaHealthy: false,
    };
  }
}

export async function listModels(
  activeModel: string,
): Promise<ModelListEntry[]> {
  let tags: OllamaTagsResponse;
  try {
    tags = await ollamaTags();
  } catch {
    return [];
  }

  return tags.models.map((m) => ({
    modelId: m.name,
    paramSize: parseParamSize(m.details.parameter_size)
      || paramSizeFromBytes(m.size),
    quantization: m.details.quantization_level,
    installed: true,
    active: m.name === activeModel,
    source: "ollama" as const,
  }));
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/model/swap.test.ts`
Expected: PASS — all 6 tests pass

**Step 5: Commit**

```bash
git add src/model/swap.ts tests/model/swap.test.ts
git commit -m "feat: add model swap, status, and list functions wrapping Ollama API"
```

---

## Task 3: Model Swap Inference Endpoints

**Files:**
- Modify: `src/inference/service.ts` (add `/model/swap`, `/model/status`, `/model/list` routes)
- Test: `tests/model/swap-endpoints.test.ts`

**Context:** The inference service is at `src/inference/service.ts`, Fastify on port 4302. It already has `/health`, `/decompose`, `/escalate`. The `ProviderRegistry` (`src/model/providers.ts`) manages the active provider. We need to wire `swapModel`/`getModelStatus`/`listModels` from `src/model/swap.ts` into HTTP endpoints and update the ProviderRegistry's active model on swap.

**Step 1: Write the failing test**

Create `tests/model/swap-endpoints.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as swapModule from "../../src/model/swap.js";

vi.mock("../../src/model/swap.js", () => ({
  swapModel: vi.fn(),
  getModelStatus: vi.fn(),
  listModels: vi.fn(),
}));

const mockSwapModel = vi.mocked(swapModule.swapModel);
const mockGetModelStatus = vi.mocked(swapModule.getModelStatus);
const mockListModels = vi.mocked(swapModule.listModels);

import { buildModelSwapRoutes } from "../../src/model/swap-routes.js";
import Fastify from "fastify";

async function buildApp() {
  const app = Fastify();
  const state = { activeModel: "qwen2.5-coder:1.5b", activeModelParamSize: 1.5 };
  buildModelSwapRoutes(app, state);
  await app.ready();
  return { app, state };
}

describe("POST /model/swap", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns ready for installed model", async () => {
    mockSwapModel.mockResolvedValueOnce({
      previous: "qwen2.5-coder:1.5b",
      active: "qwen2.5-coder:7b",
      status: "ready",
      paramSize: 7,
    });

    const { app, state } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/model/swap",
      payload: { model: "qwen2.5-coder:7b" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ready");
    expect(body.active).toBe("qwen2.5-coder:7b");
    expect(state.activeModel).toBe("qwen2.5-coder:7b");
    expect(state.activeModelParamSize).toBe(7);
    await app.close();
  });

  it("does not update state when pulling", async () => {
    mockSwapModel.mockResolvedValueOnce({
      previous: "qwen2.5-coder:1.5b",
      active: "qwen2.5-coder:1.5b",
      status: "pulling",
      paramSize: 1.5,
      progress: 0,
    });

    const { app, state } = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/model/swap",
      payload: { model: "qwen2.5-coder:7b" },
    });

    expect(res.statusCode).toBe(200);
    expect(state.activeModel).toBe("qwen2.5-coder:1.5b");
    await app.close();
  });
});

describe("GET /model/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns current model status", async () => {
    mockGetModelStatus.mockResolvedValueOnce({
      model: "qwen2.5-coder:1.5b",
      paramSize: 1.5,
      status: "ready",
      ollamaHealthy: true,
    });

    const { app } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/model/status" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.model).toBe("qwen2.5-coder:1.5b");
    expect(body.ollamaHealthy).toBe(true);
    await app.close();
  });
});

describe("GET /model/list", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns model list", async () => {
    mockListModels.mockResolvedValueOnce([
      { modelId: "qwen2.5-coder:1.5b", paramSize: 1.5, installed: true, active: true, source: "ollama" },
      { modelId: "qwen2.5-coder:7b", paramSize: 7, installed: true, active: false, source: "ollama" },
    ]);

    const { app } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/model/list" });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
    await app.close();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/model/swap-endpoints.test.ts`
Expected: FAIL — `../../src/model/swap-routes.js` not found

**Step 3: Write minimal implementation**

Create `src/model/swap-routes.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { swapModel, getModelStatus, listModels } from "./swap.js";

export interface ModelSwapState {
  activeModel: string;
  activeModelParamSize: number;
  onModelChanged?: (model: string, paramSize: number) => void;
}

export function buildModelSwapRoutes(
  app: FastifyInstance,
  state: ModelSwapState,
): void {
  app.post("/model/swap", async (req, reply) => {
    const { model } = req.body as { model: string };
    if (!model || typeof model !== "string") {
      return reply.code(400).send({ error: "model_required" });
    }

    const result = await swapModel(model, state.activeModel);

    if (result.status === "ready") {
      state.activeModel = result.active;
      state.activeModelParamSize = result.paramSize;
      state.onModelChanged?.(result.active, result.paramSize);
    }

    return reply.send(result);
  });

  app.get("/model/status", async (_req, reply) => {
    const result = await getModelStatus(state.activeModel);
    return reply.send(result);
  });

  app.get("/model/list", async (_req, reply) => {
    const result = await listModels(state.activeModel);
    return reply.send(result);
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/model/swap-endpoints.test.ts`
Expected: PASS — all 4 tests pass

**Step 5: Commit**

```bash
git add src/model/swap-routes.ts tests/model/swap-endpoints.test.ts
git commit -m "feat: add /model/swap, /model/status, /model/list HTTP endpoints"
```

---

## Task 4: Wire Model Swap Routes into Inference Service

**Files:**
- Modify: `src/inference/service.ts` (import and register model swap routes)
- Test: `tests/model/inference-service-integration.test.ts`

**Context:** `src/inference/service.ts` creates a Fastify app on port 4302. Import `buildModelSwapRoutes` and wire it up with a shared `ModelSwapState` object. The current active model comes from the `OLLAMA_MODEL` env var (default "qwen2.5-coder:latest").

**Step 1: Write the failing test**

Create `tests/model/inference-service-integration.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as swapModule from "../../src/model/swap.js";

vi.mock("../../src/model/swap.js", () => ({
  swapModel: vi.fn(),
  getModelStatus: vi.fn(),
  listModels: vi.fn(),
}));

const mockGetModelStatus = vi.mocked(swapModule.getModelStatus);

describe("inference service model routes", () => {
  it("exports buildModelSwapRoutes from swap-routes", async () => {
    const mod = await import("../../src/model/swap-routes.js");
    expect(typeof mod.buildModelSwapRoutes).toBe("function");
  });

  it("ModelSwapState interface includes onModelChanged callback", () => {
    // Type-level test: ensure the onModelChanged callback exists
    const state: import("../../src/model/swap-routes.js").ModelSwapState = {
      activeModel: "test",
      activeModelParamSize: 1,
      onModelChanged: (_model: string, _paramSize: number) => {},
    };
    expect(state.onModelChanged).toBeDefined();
  });
});
```

**Step 2: Run test to verify it passes** (this is a type/import integration check)

Run: `npx vitest run tests/model/inference-service-integration.test.ts`
Expected: PASS

**Step 3: Modify `src/inference/service.ts`**

Add these lines to the inference service. Near the top imports, add:

```typescript
import { buildModelSwapRoutes } from "../model/swap-routes.js";
```

After the Fastify app is created and before `app.listen()`, add:

```typescript
const modelSwapState = {
  activeModel: process.env.OLLAMA_MODEL ?? "qwen2.5-coder:latest",
  activeModelParamSize: 0,
};
buildModelSwapRoutes(app, modelSwapState);
```

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing + new)

**Step 5: Commit**

```bash
git add src/inference/service.ts tests/model/inference-service-integration.test.ts
git commit -m "feat: wire model swap routes into inference service on port 4302"
```

---

## Task 5: BLE Re-Advertisement on Model Change (Node.js)

**Files:**
- Modify: `src/mesh/ble/ble-mesh-manager.ts` (add `onModelChanged` method)
- Modify: `src/mesh/ble/ble-transport.ts` (add `updateAdvertisement` to BLETransport interface and MockBLETransport)
- Test: `tests/mesh/ble/ble-model-readvertise.test.ts`

**Context:** `BLEMeshManager` at `src/mesh/ble/ble-mesh-manager.ts` manages the BLE mesh. When a model swap happens, the BLE advertisement must update so peers see the new capabilities. The `BLETransport` interface at `src/mesh/ble/ble-transport.ts` needs an `updateAdvertisement` method. During swap, set `currentLoad = -1` (unavailable), then reset to 0 after loading.

**Step 1: Write the failing test**

Create `tests/mesh/ble/ble-model-readvertise.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { BLEMeshManager } from "../../../src/mesh/ble/ble-mesh-manager.js";
import { MockBLETransport } from "../../../src/mesh/ble/ble-transport.js";

describe("BLE model re-advertisement", () => {
  it("updates advertisement when model changes", () => {
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("agent-a", network);
    transport.startAdvertising({
      agentId: "agent-a",
      model: "qwen2.5-coder:1.5b",
      modelParamSize: 1.5,
      memoryMB: 4096,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "laptop",
    });

    const manager = new BLEMeshManager("agent-a", "account-a", transport);
    manager.onModelChanged("qwen2.5-coder:7b", 7);

    const ad = transport.currentAdvertisement();
    expect(ad).not.toBeNull();
    expect(ad!.model).toBe("qwen2.5-coder:7b");
    expect(ad!.modelParamSize).toBe(7);
    expect(ad!.currentLoad).toBe(0);
  });

  it("sets currentLoad to -1 during swap then resets", () => {
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("agent-a", network);
    transport.startAdvertising({
      agentId: "agent-a",
      model: "old",
      modelParamSize: 1.5,
      memoryMB: 4096,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "laptop",
    });

    const manager = new BLEMeshManager("agent-a", "account-a", transport);

    // Simulate swap start (loading phase)
    manager.onModelSwapStart();
    expect(transport.currentAdvertisement()!.currentLoad).toBe(-1);

    // Swap complete
    manager.onModelChanged("new-model", 3);
    expect(transport.currentAdvertisement()!.currentLoad).toBe(0);
    expect(transport.currentAdvertisement()!.model).toBe("new-model");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mesh/ble/ble-model-readvertise.test.ts`
Expected: FAIL — `onModelChanged` and `onModelSwapStart` not defined, `currentAdvertisement` not on MockBLETransport

**Step 3: Write minimal implementation**

Add to `BLETransport` interface in `src/mesh/ble/ble-transport.ts`:

```typescript
updateAdvertisement(update: Partial<BLEAdvertisement>): void;
currentAdvertisement(): BLEAdvertisement | null;
```

Add to `MockBLETransport` class:

```typescript
updateAdvertisement(update: Partial<BLEAdvertisement>): void {
  if (this.advertisement) {
    this.advertisement = { ...this.advertisement, ...update };
  }
}

currentAdvertisement(): BLEAdvertisement | null {
  return this.advertisement ?? null;
}
```

Add methods to `BLEMeshManager` in `src/mesh/ble/ble-mesh-manager.ts`:

```typescript
onModelSwapStart(): void {
  this.transport.updateAdvertisement({ currentLoad: -1 });
}

onModelChanged(model: string, paramSize: number): void {
  this.transport.updateAdvertisement({
    model,
    modelParamSize: paramSize,
    currentLoad: 0,
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mesh/ble/ble-model-readvertise.test.ts`
Expected: PASS

**Step 5: Run full BLE test suite to confirm no regressions**

Run: `npx vitest run tests/mesh/ble/`
Expected: All BLE tests pass

**Step 6: Commit**

```bash
git add src/mesh/ble/ble-mesh-manager.ts src/mesh/ble/ble-transport.ts tests/mesh/ble/ble-model-readvertise.test.ts
git commit -m "feat: BLE re-advertisement on model change with unavailability sentinel"
```

---

## Task 6: Coordinator Capability Summary Gossip

**Files:**
- Create: `src/mesh/capability-gossip.ts`
- Test: `tests/mesh/capability-gossip.test.ts`

**Context:** The coordinator at `src/swarm/coordinator.ts` maintains `agentCapabilities` (Map of agent → { os, version, localModelProvider, localModelCatalog, ... }). The `GossipMesh` at `src/mesh/gossip.ts` has `broadcast(message)` which sends to all peer coordinators. The `MeshProtocol` at `src/mesh/protocol.ts` creates signed messages. The existing `bootstrapPeerMesh()` timer runs every 45s. We add a `capability_summary` message type to gossiped data.

**Step 1: Write the failing test**

Create `tests/mesh/capability-gossip.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  buildCapabilitySummary,
  type AgentCapabilityInfo,
} from "../../src/mesh/capability-gossip.js";

describe("buildCapabilitySummary", () => {
  it("aggregates model availability from agents", () => {
    const agents: AgentCapabilityInfo[] = [
      { agentId: "a1", activeModel: "qwen2.5-coder:7b", activeModelParamSize: 7, currentLoad: 1 },
      { agentId: "a2", activeModel: "qwen2.5-coder:7b", activeModelParamSize: 7, currentLoad: 3 },
      { agentId: "a3", activeModel: "qwen2.5-coder:1.5b", activeModelParamSize: 1.5, currentLoad: 0 },
    ];

    const summary = buildCapabilitySummary("coord-1", agents);

    expect(summary.coordinatorId).toBe("coord-1");
    expect(summary.agentCount).toBe(3);
    expect(summary.modelAvailability["qwen2.5-coder:7b"].agentCount).toBe(2);
    expect(summary.modelAvailability["qwen2.5-coder:7b"].totalParamCapacity).toBe(14);
    expect(summary.modelAvailability["qwen2.5-coder:7b"].avgLoad).toBe(2);
    expect(summary.modelAvailability["qwen2.5-coder:1.5b"].agentCount).toBe(1);
    expect(summary.modelAvailability["qwen2.5-coder:1.5b"].totalParamCapacity).toBe(1.5);
    expect(summary.modelAvailability["qwen2.5-coder:1.5b"].avgLoad).toBe(0);
    expect(summary.timestamp).toBeGreaterThan(0);
  });

  it("returns empty availability for no agents", () => {
    const summary = buildCapabilitySummary("coord-1", []);
    expect(summary.agentCount).toBe(0);
    expect(Object.keys(summary.modelAvailability)).toHaveLength(0);
  });

  it("excludes agents with no active model", () => {
    const agents: AgentCapabilityInfo[] = [
      { agentId: "a1", activeModel: "", activeModelParamSize: 0, currentLoad: 0 },
      { agentId: "a2", activeModel: "qwen2.5-coder:7b", activeModelParamSize: 7, currentLoad: 0 },
    ];

    const summary = buildCapabilitySummary("coord-1", agents);
    expect(summary.agentCount).toBe(2);
    expect(Object.keys(summary.modelAvailability)).toHaveLength(1);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mesh/capability-gossip.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/mesh/capability-gossip.ts`:

```typescript
import type { CapabilitySummaryPayload } from "../common/types.js";

export interface AgentCapabilityInfo {
  agentId: string;
  activeModel: string;
  activeModelParamSize: number;
  currentLoad: number;
}

export function buildCapabilitySummary(
  coordinatorId: string,
  agents: AgentCapabilityInfo[],
): CapabilitySummaryPayload {
  const modelMap: CapabilitySummaryPayload["modelAvailability"] = {};

  for (const agent of agents) {
    if (!agent.activeModel) continue;
    const key = agent.activeModel;
    if (!modelMap[key]) {
      modelMap[key] = { agentCount: 0, totalParamCapacity: 0, avgLoad: 0 };
    }
    modelMap[key].agentCount += 1;
    modelMap[key].totalParamCapacity += agent.activeModelParamSize;
    modelMap[key].avgLoad += agent.currentLoad;
  }

  // Convert sum of loads to average
  for (const entry of Object.values(modelMap)) {
    if (entry.agentCount > 0) {
      entry.avgLoad = entry.avgLoad / entry.agentCount;
    }
  }

  return {
    coordinatorId,
    agentCount: agents.length,
    modelAvailability: modelMap,
    timestamp: Date.now(),
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mesh/capability-gossip.test.ts`
Expected: PASS — all 3 tests

**Step 5: Commit**

```bash
git add src/mesh/capability-gossip.ts tests/mesh/capability-gossip.test.ts
git commit -m "feat: capability summary builder for coordinator gossip"
```

---

## Task 7: Wire Capability Gossip into Coordinator

**Files:**
- Modify: `src/swarm/coordinator.ts` (add `capability_summary` to mesh ingest, broadcast on timer, store federated capabilities)
- Modify: `src/common/types.ts` (add `capability_summary` to `MeshMessageType`)
- Test: `tests/mesh/capability-gossip-coordinator.test.ts`

**Context:** The `/mesh/ingest` endpoint at `coordinator.ts:2303` validates `MeshMessageType` via Zod enum. The `MeshMessageType` union type is in `src/common/types.ts`. The 45s `bootstrapPeerMesh` timer at `coordinator.ts:3509` is where we add gossip broadcast. The `mesh.broadcast()` sends to all peers. The `protocol.createMessage()` creates signed messages.

**Step 1: Write the failing test**

Create `tests/mesh/capability-gossip-coordinator.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  buildCapabilitySummary,
  type AgentCapabilityInfo,
} from "../../src/mesh/capability-gossip.js";
import type { CapabilitySummaryPayload } from "../../src/common/types.js";

describe("capability_summary coordinator integration", () => {
  it("capability_summary is a valid MeshMessageType", () => {
    // Type-level check: capability_summary must be assignable to MeshMessageType
    const msgType: import("../../src/common/types.js").MeshMessageType = "capability_summary";
    expect(msgType).toBe("capability_summary");
  });

  it("buildCapabilitySummary output conforms to CapabilitySummaryPayload", () => {
    const agents: AgentCapabilityInfo[] = [
      { agentId: "a1", activeModel: "qwen2.5-coder:7b", activeModelParamSize: 7, currentLoad: 0 },
    ];
    const summary: CapabilitySummaryPayload = buildCapabilitySummary("coord-1", agents);
    expect(summary.coordinatorId).toBe("coord-1");
    expect(typeof summary.timestamp).toBe("number");
  });

  it("federated capabilities map stores summaries by coordinator ID", () => {
    // Simulate what the coordinator does when receiving a capability_summary
    const federatedCapabilities = new Map<string, CapabilitySummaryPayload>();

    const incomingSummary: CapabilitySummaryPayload = {
      coordinatorId: "coord-remote",
      agentCount: 10,
      modelAvailability: {
        "qwen2.5-coder:7b": { agentCount: 5, totalParamCapacity: 35, avgLoad: 1.2 },
      },
      timestamp: Date.now(),
    };

    federatedCapabilities.set(incomingSummary.coordinatorId, incomingSummary);

    expect(federatedCapabilities.has("coord-remote")).toBe(true);
    const stored = federatedCapabilities.get("coord-remote")!;
    expect(stored.agentCount).toBe(10);
    expect(stored.modelAvailability["qwen2.5-coder:7b"].agentCount).toBe(5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mesh/capability-gossip-coordinator.test.ts`
Expected: FAIL — `"capability_summary"` is not assignable to `MeshMessageType`

**Step 3: Write minimal implementation**

**In `src/common/types.ts`**, add `"capability_summary"` to the `MeshMessageType` union:

Find the existing `MeshMessageType` line and add the new value:

```typescript
export type MeshMessageType =
  | "peer_announce"
  | "queue_summary"
  | "task_offer"
  | "task_claim"
  | "result_announce"
  | "ordering_snapshot"
  | "blacklist_update"
  | "issuance_proposal"
  | "issuance_vote"
  | "issuance_commit"
  | "issuance_checkpoint"
  | "capability_summary";
```

**In `src/swarm/coordinator.ts`**:

1. Add `"capability_summary"` to the Zod enum at the `/mesh/ingest` endpoint (line ~2308):

```typescript
z.enum([
  "peer_announce",
  "queue_summary",
  "task_offer",
  "task_claim",
  "result_announce",
  "ordering_snapshot",
  "blacklist_update",
  "issuance_proposal",
  "issuance_vote",
  "issuance_commit",
  "issuance_checkpoint",
  "capability_summary"
]),
```

2. Add a `federatedCapabilities` map near the top (after `agentCapabilities`):

```typescript
import { buildCapabilitySummary, type AgentCapabilityInfo } from "../mesh/capability-gossip.js";
import type { CapabilitySummaryPayload } from "../common/types.js";

const federatedCapabilities = new Map<string, CapabilitySummaryPayload>();
```

3. Add handler in `/mesh/ingest` (after blacklist_update handler):

```typescript
if (message.type === "capability_summary") {
  const payload = message.payload as unknown as CapabilitySummaryPayload;
  if (payload.coordinatorId && payload.timestamp) {
    federatedCapabilities.set(payload.coordinatorId, payload);
    app.log.info({ from: payload.coordinatorId, agents: payload.agentCount }, "capability_summary_received");
  }
  return reply.send({ ok: true });
}
```

4. Add capability gossip broadcast to the 45s `bootstrapPeerMesh` timer interval (at ~line 3509). Add a new interval right after:

```typescript
setInterval(() => {
  void (async () => {
    const agents: AgentCapabilityInfo[] = [...agentCapabilities.entries()].map(
      ([agentId, cap]) => ({
        agentId,
        activeModel: cap.localModelCatalog[0] ?? "",
        activeModelParamSize: 0,
        currentLoad: 0,
      })
    );
    const summary = buildCapabilitySummary(identity.peerId, agents);
    const msg = protocol.createMessage(
      "capability_summary",
      identity.peerId,
      summary as unknown as Record<string, unknown>,
      identity.privateKeyPem,
      60_000
    );
    await mesh.broadcast(msg);
  })().catch((error) => app.log.warn({ error }, "capability_gossip_failed"));
}, 60_000);
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mesh/capability-gossip-coordinator.test.ts`
Expected: PASS — all 3 tests

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/common/types.ts src/swarm/coordinator.ts tests/mesh/capability-gossip-coordinator.test.ts
git commit -m "feat: wire capability_summary gossip into coordinator mesh"
```

---

## Task 8: Heartbeat Active Model Fields

**Files:**
- Modify: `src/swarm/coordinator.ts` (extend heartbeat to accept/store `activeModel`, `activeModelParamSize`, `modelSwapInProgress`)
- Test: `tests/mesh/heartbeat-model-fields.test.ts`

**Context:** The heartbeat endpoint at `coordinator.ts:1412` uses `heartbeatSchema` (Zod). The `agentCapabilities` map at line 171 stores agent info. We need to add `activeModel`, `activeModelParamSize`, and `modelSwapInProgress` to both the schema and the capabilities map so the coordinator knows each agent's current model for capability summary gossip.

**Step 1: Write the failing test**

Create `tests/mesh/heartbeat-model-fields.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("heartbeat active model fields", () => {
  it("agentCapabilities type should support activeModel field", () => {
    // Simulates the extended agentCapabilities shape
    const cap = {
      os: "macos",
      version: "1.0.0",
      mode: "swarm-only" as const,
      localModelEnabled: true,
      localModelProvider: "ollama-local" as const,
      localModelCatalog: ["qwen2.5-coder:7b"],
      clientType: "node",
      swarmEnabled: true,
      ideEnabled: false,
      maxConcurrentTasks: 1,
      connectedPeers: new Set<string>(),
      lastSeenMs: Date.now(),
      activeModel: "qwen2.5-coder:7b",
      activeModelParamSize: 7,
      modelSwapInProgress: false,
    };
    expect(cap.activeModel).toBe("qwen2.5-coder:7b");
    expect(cap.activeModelParamSize).toBe(7);
    expect(cap.modelSwapInProgress).toBe(false);
  });

  it("heartbeat payload includes model fields for gossip aggregation", () => {
    const heartbeatPayload = {
      agentId: "agent-1",
      powerTelemetry: {
        onExternalPower: true,
        batteryLevelPct: 100,
        lowPowerMode: false,
        updatedAtMs: Date.now(),
      },
      activeModel: "qwen2.5-coder:7b",
      activeModelParamSize: 7,
      modelSwapInProgress: false,
    };
    expect(heartbeatPayload.activeModel).toBe("qwen2.5-coder:7b");
  });
});
```

**Step 2: Run test to verify it passes** (these are structural tests)

Run: `npx vitest run tests/mesh/heartbeat-model-fields.test.ts`
Expected: PASS

**Step 3: Modify coordinator**

In `src/swarm/coordinator.ts`:

1. Add optional fields to `heartbeatSchema` (find the Zod schema definition for heartbeat, add):

```typescript
activeModel: z.string().optional(),
activeModelParamSize: z.number().optional(),
modelSwapInProgress: z.boolean().optional(),
```

2. In the heartbeat handler (line ~1428), after updating `powerTelemetry`, also update model fields:

```typescript
if (body.activeModel !== undefined) {
  existing.activeModel = body.activeModel;
  existing.activeModelParamSize = body.activeModelParamSize ?? 0;
  existing.modelSwapInProgress = body.modelSwapInProgress ?? false;
}
```

3. Add to the `agentCapabilities` type definition (line ~171):

```typescript
activeModel?: string;
activeModelParamSize?: number;
modelSwapInProgress?: boolean;
```

4. Update the capability gossip timer to use the new fields:

```typescript
const agents: AgentCapabilityInfo[] = [...agentCapabilities.entries()].map(
  ([agentId, cap]) => ({
    agentId,
    activeModel: cap.activeModel ?? cap.localModelCatalog[0] ?? "",
    activeModelParamSize: cap.activeModelParamSize ?? 0,
    currentLoad: 0,
  })
);
```

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/swarm/coordinator.ts tests/mesh/heartbeat-model-fields.test.ts
git commit -m "feat: extend heartbeat with activeModel fields for capability gossip"
```

---

## Task 9: Federated Capabilities Query Endpoint

**Files:**
- Modify: `src/swarm/coordinator.ts` (add `GET /mesh/capabilities` endpoint)
- Test: `tests/mesh/federated-capabilities.test.ts`

**Context:** The `federatedCapabilities` map stores `CapabilitySummaryPayload` by coordinator ID. Expose it so operators can query "which coordinator has agents with model X?". This enables the cross-coordinator routing described in the design.

**Step 1: Write the failing test**

Create `tests/mesh/federated-capabilities.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { CapabilitySummaryPayload } from "../../src/common/types.js";

describe("federated capabilities query", () => {
  it("finds coordinators with matching model", () => {
    const federated = new Map<string, CapabilitySummaryPayload>();
    federated.set("coord-a", {
      coordinatorId: "coord-a",
      agentCount: 5,
      modelAvailability: {
        "qwen2.5-coder:7b": { agentCount: 3, totalParamCapacity: 21, avgLoad: 1.0 },
      },
      timestamp: Date.now(),
    });
    federated.set("coord-b", {
      coordinatorId: "coord-b",
      agentCount: 2,
      modelAvailability: {
        "qwen2.5-coder:1.5b": { agentCount: 2, totalParamCapacity: 3, avgLoad: 0.5 },
      },
      timestamp: Date.now(),
    });

    // Find coordinators with 7B model
    const with7B = [...federated.values()].filter(
      (c) => c.modelAvailability["qwen2.5-coder:7b"]?.agentCount > 0
    );
    expect(with7B).toHaveLength(1);
    expect(with7B[0].coordinatorId).toBe("coord-a");

    // Find coordinators with 1.5B model
    const with1_5B = [...federated.values()].filter(
      (c) => c.modelAvailability["qwen2.5-coder:1.5b"]?.agentCount > 0
    );
    expect(with1_5B).toHaveLength(1);
    expect(with1_5B[0].coordinatorId).toBe("coord-b");
  });

  it("sorts by available capacity descending", () => {
    const federated = new Map<string, CapabilitySummaryPayload>();
    federated.set("coord-a", {
      coordinatorId: "coord-a",
      agentCount: 2,
      modelAvailability: {
        "qwen2.5-coder:7b": { agentCount: 2, totalParamCapacity: 14, avgLoad: 0.5 },
      },
      timestamp: Date.now(),
    });
    federated.set("coord-b", {
      coordinatorId: "coord-b",
      agentCount: 5,
      modelAvailability: {
        "qwen2.5-coder:7b": { agentCount: 5, totalParamCapacity: 35, avgLoad: 0.2 },
      },
      timestamp: Date.now(),
    });

    const sorted = [...federated.values()]
      .filter((c) => c.modelAvailability["qwen2.5-coder:7b"])
      .sort(
        (a, b) =>
          b.modelAvailability["qwen2.5-coder:7b"].totalParamCapacity -
          a.modelAvailability["qwen2.5-coder:7b"].totalParamCapacity
      );

    expect(sorted[0].coordinatorId).toBe("coord-b");
  });
});
```

**Step 2: Run test to verify it passes**

Run: `npx vitest run tests/mesh/federated-capabilities.test.ts`
Expected: PASS (these test the lookup logic directly)

**Step 3: Add endpoint to coordinator**

In `src/swarm/coordinator.ts`, add after the `/mesh/ingest` endpoint:

```typescript
app.get("/mesh/capabilities", async (req, reply) => {
  if (!requireMeshToken(req as any, reply)) return reply.send({ error: "mesh_unauthorized" });
  const model = (req.query as Record<string, string>).model;
  const entries = [...federatedCapabilities.values()];
  if (model) {
    const filtered = entries.filter(
      (c) => c.modelAvailability[model]?.agentCount > 0
    );
    return reply.send({ coordinators: filtered });
  }
  return reply.send({ coordinators: entries });
});
```

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/swarm/coordinator.ts tests/mesh/federated-capabilities.test.ts
git commit -m "feat: add GET /mesh/capabilities endpoint for federated model discovery"
```

---

## Task 10: iOS LocalModelManager llama.cpp Rewrite

**Files:**
- Rewrite: `ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/LocalModelManager.swift`
- No automated test (Xcode XCTest — manual verification)

**Context:** The current `LocalModelManager.swift` is a placeholder with fake `installLightweightModel()` and `runInference()`. Rewrite it to manage GGUF files in `Documents/Models/`, load them via llama.cpp, and publish model change notifications for BLE re-advertisement. The llama.cpp Swift package needs to be added via SPM (separate step). For now, write the manager with a protocol-based `LlamaContext` dependency so it compiles without the actual llama.cpp package.

**Step 1: Rewrite `LocalModelManager.swift`**

Replace the entire file with:

```swift
import Foundation
import Combine

// MARK: - Model Registry Entry

struct InstalledModel: Codable, Identifiable {
    let modelId: String
    let localPath: String
    let paramSize: Double
    let fileSizeBytes: Int64
    let checksumSha256: String

    var id: String { modelId }
}

// MARK: - Notifications

extension Notification.Name {
    static let modelDidChange = Notification.Name("edgecoder.modelDidChange")
    static let modelSwapStarted = Notification.Name("edgecoder.modelSwapStarted")
}

// MARK: - Llama Context Protocol

/// Abstract interface for llama.cpp context. Enables testing without linking llama.cpp.
protocol LlamaContextProtocol {
    func loadModel(path: String) throws
    func unloadModel()
    func generate(prompt: String, maxTokens: Int) async throws -> String
    var isLoaded: Bool { get }
}

// MARK: - Stub Llama Context (until llama.cpp SPM is added)

final class StubLlamaContext: LlamaContextProtocol {
    private(set) var isLoaded = false
    private var modelPath: String?

    func loadModel(path: String) throws {
        modelPath = path
        isLoaded = true
    }

    func unloadModel() {
        modelPath = nil
        isLoaded = false
    }

    func generate(prompt: String, maxTokens: Int) async throws -> String {
        guard isLoaded else { throw LocalModelError.noModelLoaded }
        return "[stub-llama] \(prompt.prefix(80))"
    }
}

// MARK: - Errors

enum LocalModelError: Error, LocalizedError {
    case noModelLoaded
    case modelNotFound(String)
    case loadFailed(String)
    case checksumMismatch
    case insufficientMemory(required: Int, available: Int)

    var errorDescription: String? {
        switch self {
        case .noModelLoaded: return "No model is loaded."
        case .modelNotFound(let id): return "Model \(id) not found on device."
        case .loadFailed(let reason): return "Failed to load model: \(reason)"
        case .checksumMismatch: return "Model file checksum does not match catalog."
        case .insufficientMemory(let req, let avail):
            return "Insufficient memory: \(req)MB required, \(avail)MB available."
        }
    }
}

// MARK: - Local Model Manager

enum LocalModelState: String {
    case notInstalled, downloading, loading, ready, error
}

@MainActor
final class LocalModelManager: ObservableObject {
    @Published var state: LocalModelState = .notInstalled
    @Published var selectedModel: String = ""
    @Published var selectedModelParamSize: Double = 0
    @Published var statusText: String = "No local model installed."
    @Published var lastInferenceOutput: String = ""
    @Published var installedModels: [InstalledModel] = []
    @Published var downloadProgress: Double = 0

    private var llamaContext: LlamaContextProtocol
    private let registryKey = "edgecoder.installedModels"
    private let activeModelKey = "edgecoder.activeModel"

    init(llamaContext: LlamaContextProtocol = StubLlamaContext()) {
        self.llamaContext = llamaContext
        loadRegistry()
        let savedModel = UserDefaults.standard.string(forKey: activeModelKey) ?? ""
        if !savedModel.isEmpty, let model = installedModels.first(where: { $0.modelId == savedModel }) {
            selectedModel = model.modelId
            selectedModelParamSize = model.paramSize
        }
    }

    // MARK: - Model Directory

    static var modelsDirectory: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("Models")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    // MARK: - Registry Persistence

    private func loadRegistry() {
        guard let data = UserDefaults.standard.data(forKey: registryKey),
              let models = try? JSONDecoder().decode([InstalledModel].self, from: data) else {
            installedModels = []
            return
        }
        installedModels = models
    }

    private func saveRegistry() {
        if let data = try? JSONEncoder().encode(installedModels) {
            UserDefaults.standard.set(data, forKey: registryKey)
        }
    }

    // MARK: - Model Activation

    func activate(modelId: String) async throws {
        guard let model = installedModels.first(where: { $0.modelId == modelId }) else {
            throw LocalModelError.modelNotFound(modelId)
        }

        let previousModel = selectedModel
        state = .loading
        statusText = "Loading \(model.modelId)..."
        NotificationCenter.default.post(name: .modelSwapStarted, object: nil)

        // Unload current model
        llamaContext.unloadModel()

        // Load new model
        do {
            try llamaContext.loadModel(path: model.localPath)
        } catch {
            state = .error
            statusText = "Failed to load \(model.modelId): \(error.localizedDescription)"
            // Try to reload previous model
            if !previousModel.isEmpty,
               let prev = installedModels.first(where: { $0.modelId == previousModel }) {
                try? llamaContext.loadModel(path: prev.localPath)
            }
            throw LocalModelError.loadFailed(error.localizedDescription)
        }

        selectedModel = model.modelId
        selectedModelParamSize = model.paramSize
        UserDefaults.standard.set(model.modelId, forKey: activeModelKey)
        state = .ready
        statusText = "\(model.modelId) ready"

        NotificationCenter.default.post(
            name: .modelDidChange,
            object: nil,
            userInfo: [
                "modelId": model.modelId,
                "paramSize": model.paramSize,
            ]
        )
    }

    // MARK: - Model Download

    func downloadModel(
        modelId: String,
        downloadUrl: URL,
        paramSize: Double,
        fileSizeBytes: Int64,
        checksumSha256: String
    ) async throws {
        state = .downloading
        statusText = "Downloading \(modelId)..."
        downloadProgress = 0

        let destinationUrl = Self.modelsDirectory.appendingPathComponent("\(modelId).gguf")

        let (tempUrl, _) = try await URLSession.shared.download(from: downloadUrl)

        // Verify checksum
        let fileData = try Data(contentsOf: tempUrl)
        let computedHash = fileData.sha256Hex()
        guard computedHash == checksumSha256 else {
            try? FileManager.default.removeItem(at: tempUrl)
            state = .error
            statusText = "Checksum mismatch for \(modelId)"
            throw LocalModelError.checksumMismatch
        }

        try FileManager.default.moveItem(at: tempUrl, to: destinationUrl)

        let installed = InstalledModel(
            modelId: modelId,
            localPath: destinationUrl.path,
            paramSize: paramSize,
            fileSizeBytes: fileSizeBytes,
            checksumSha256: checksumSha256
        )
        installedModels.append(installed)
        saveRegistry()

        state = .ready
        statusText = "\(modelId) downloaded"
        downloadProgress = 1.0
    }

    // MARK: - Delete Model

    func deleteModel(modelId: String) {
        guard let model = installedModels.first(where: { $0.modelId == modelId }) else { return }

        if selectedModel == modelId {
            llamaContext.unloadModel()
            selectedModel = ""
            selectedModelParamSize = 0
            UserDefaults.standard.removeObject(forKey: activeModelKey)
            state = .notInstalled
            statusText = "No model active"
        }

        try? FileManager.default.removeItem(atPath: model.localPath)
        installedModels.removeAll { $0.modelId == modelId }
        saveRegistry()
    }

    // MARK: - Inference

    func runInference(prompt: String) async {
        guard llamaContext.isLoaded else {
            lastInferenceOutput = "No model loaded."
            return
        }
        do {
            let output = try await llamaContext.generate(prompt: prompt, maxTokens: 512)
            lastInferenceOutput = output
        } catch {
            lastInferenceOutput = "Error: \(error.localizedDescription)"
        }
    }
}

// MARK: - SHA-256 Helper

extension Data {
    func sha256Hex() -> String {
        // Use CryptoKit on iOS 13+
        import CryptoKit is unavailable in this context, use CommonCrypto
        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        withUnsafeBytes { bytes in
            _ = CC_SHA256(bytes.baseAddress, CC_LONG(count), &hash)
        }
        return hash.map { String(format: "%02x", $0) }.joined()
    }
}
```

**Important:** The SHA-256 helper above needs `import CommonCrypto`. The actual implementation should use:

```swift
import CommonCrypto

extension Data {
    func sha256Hex() -> String {
        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        withUnsafeBytes { bytes in
            _ = CC_SHA256(bytes.baseAddress, CC_LONG(count), &hash)
        }
        return hash.map { String(format: "%02x", $0) }.joined()
    }
}
```

**Step 2: Verify it compiles**

Open Xcode project and build. Fix any compilation issues. The `StubLlamaContext` ensures it compiles without actual llama.cpp.

**Step 3: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/LocalModelManager.swift
git commit -m "feat: rewrite LocalModelManager with llama.cpp protocol and GGUF registry"
```

---

## Task 11: iOS SwiftUI ModelLibraryView & ModelPickerView

**Files:**
- Create: `ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/ModelLibraryView.swift`
- Create: `ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/ModelPickerView.swift`
- Create: `ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/ModelStatusBanner.swift`
- Modify: `ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/SwarmView.swift` (replace Local Model section with ModelPickerView + ModelStatusBanner)

**Context:** The design specifies three SwiftUI views: ModelPickerView (compact, shows active model + chevron), ModelLibraryView (full-screen list with installed/available sections), ModelStatusBanner (banner in SwarmView). SwarmView currently has an inline "Local Model" form section with TextField for model name and basic install/inference buttons.

**Step 1: Create ModelPickerView.swift**

```swift
import SwiftUI

struct ModelPickerView: View {
    @ObservedObject var modelManager: LocalModelManager
    @State private var showLibrary = false

    var body: some View {
        Button {
            showLibrary = true
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Active Model")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text(modelManager.selectedModel.isEmpty ? "No model selected" : modelManager.selectedModel)
                        .font(.body)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .foregroundColor(.secondary)
            }
            .padding(.vertical, 4)
        }
        .sheet(isPresented: $showLibrary) {
            ModelLibraryView(modelManager: modelManager)
        }
    }
}
```

**Step 2: Create ModelLibraryView.swift**

```swift
import SwiftUI

struct ModelLibraryView: View {
    @ObservedObject var modelManager: LocalModelManager
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            List {
                if !modelManager.installedModels.isEmpty {
                    Section("Installed") {
                        ForEach(modelManager.installedModels) { model in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(model.modelId)
                                        .font(.body)
                                    Text("\(model.paramSize, specifier: "%.1f")B params")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                Spacer()
                                if model.modelId == modelManager.selectedModel {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundColor(.green)
                                }
                            }
                            .contentShape(Rectangle())
                            .onTapGesture {
                                Task {
                                    try? await modelManager.activate(modelId: model.modelId)
                                }
                            }
                        }
                        .onDelete { indexSet in
                            for index in indexSet {
                                modelManager.deleteModel(modelId: modelManager.installedModels[index].modelId)
                            }
                        }
                    }
                }

                Section("Status") {
                    HStack {
                        Text("State")
                        Spacer()
                        Text(modelManager.state.rawValue)
                            .foregroundColor(.secondary)
                    }
                    if modelManager.state == .downloading {
                        ProgressView(value: modelManager.downloadProgress)
                    }
                    Text(modelManager.statusText)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .navigationTitle("Model Library")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
```

**Step 3: Create ModelStatusBanner.swift**

```swift
import SwiftUI

struct ModelStatusBanner: View {
    @ObservedObject var modelManager: LocalModelManager

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 1) {
                Text(modelManager.selectedModel.isEmpty ? "No Model" : modelManager.selectedModel)
                    .font(.caption.bold())
                Text(modelManager.statusText)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            Spacer()
            if modelManager.state == .loading || modelManager.state == .downloading {
                ProgressView()
                    .scaleEffect(0.7)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color(.systemGray6))
        .cornerRadius(8)
    }

    private var statusColor: Color {
        switch modelManager.state {
        case .ready: return .green
        case .loading, .downloading: return .orange
        case .error: return .red
        case .notInstalled: return .gray
        }
    }
}
```

**Step 4: Modify SwarmView.swift**

Replace the "Local Model" section with the new components. Find the existing `Section("Local Model")` and replace with:

```swift
Section("Local Model") {
    ModelPickerView(modelManager: modelManager)
    ModelStatusBanner(modelManager: modelManager)

    // Inference prompt (keep existing)
    TextField("Prompt", text: $inferencePrompt, axis: .vertical)
        .lineLimit(3...6)
    Button("Run Local Inference") {
        Task { await modelManager.runInference(prompt: inferencePrompt) }
    }
    .disabled(modelManager.state != .ready)
    if !modelManager.lastInferenceOutput.isEmpty {
        Text(modelManager.lastInferenceOutput)
            .font(.system(.caption, design: .monospaced))
    }
}
```

**Step 5: Verify in Xcode**

Build and run in Xcode simulator. Verify:
- ModelPickerView shows current model with chevron
- Tapping opens ModelLibraryView sheet
- ModelStatusBanner shows status color and text
- Installed models list with swipe-to-delete
- Active model shows checkmark

**Step 6: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/ModelPickerView.swift \
        ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/ModelLibraryView.swift \
        ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/ModelStatusBanner.swift \
        ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/SwarmView.swift
git commit -m "feat: add ModelPickerView, ModelLibraryView, ModelStatusBanner SwiftUI views"
```

---

## Task 12: iOS BLE Re-Advertisement on Model Change

**Files:**
- Modify: `ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/BLEMeshManager.swift` (add model change notification observer)
- Modify: `ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/SwarmRuntimeController.swift` (connect model change to heartbeat)

**Context:** `BLEMeshManager.swift` manages CoreBluetooth advertising. `LocalModelManager` posts `Notification.Name.modelDidChange` and `.modelSwapStarted`. The BLE manager needs to observe these and re-advertise. `SwarmRuntimeController` needs to send updated model info in heartbeats.

**Step 1: Modify BLEMeshManager.swift**

Add a notification observer in `start()`:

```swift
func start() {
    // ... existing init code ...

    // Observe model changes for BLE re-advertisement
    NotificationCenter.default.addObserver(
        self,
        selector: #selector(handleModelSwapStarted),
        name: .modelSwapStarted,
        object: nil
    )
    NotificationCenter.default.addObserver(
        self,
        selector: #selector(handleModelDidChange(_:)),
        name: .modelDidChange,
        object: nil
    )
}

@objc private func handleModelSwapStarted() {
    // Set currentLoad to -1 during swap (unavailable sentinel)
    // Re-advertise with loading state
    stopAdvertising()
    // Will re-advertise when modelDidChange fires
}

@objc private func handleModelDidChange(_ notification: Notification) {
    guard let userInfo = notification.userInfo,
          let modelId = userInfo["modelId"] as? String,
          let paramSize = userInfo["paramSize"] as? Double else { return }

    // Re-advertise with new model info
    stopAdvertising()
    if let agentId = currentAgentId {
        startAdvertising(agentId: agentId, model: modelId, modelParamSize: paramSize)
    }
}
```

Add a stored property `currentAgentId` to BLEMeshManager and set it in `startAdvertising`.

**Step 2: Modify SwarmRuntimeController.swift**

Add model change observation and include model info in heartbeat:

In `start()`, add:

```swift
NotificationCenter.default.addObserver(
    forName: .modelDidChange,
    object: nil,
    queue: .main
) { [weak self] notification in
    guard let self,
          let userInfo = notification.userInfo,
          let modelId = userInfo["modelId"] as? String else { return }
    // Will be included in next heartbeat
    self.appendEvent("Model changed to \(modelId)")
}
```

In `sendHeartbeat()`, add model fields to the payload:

```swift
let heartbeatPayload: [String: Any] = [
    "agentId": agentId,
    "powerTelemetry": currentPowerTelemetry(),
    "activeModel": modelManager.selectedModel,
    "activeModelParamSize": modelManager.selectedModelParamSize,
    "modelSwapInProgress": modelManager.state == .loading,
]
```

**Step 3: Verify in Xcode**

Build and test that model swap triggers BLE re-advertisement and heartbeat includes model fields.

**Step 4: Commit**

```bash
git add ios/EdgeCoderIOS/EdgeCoderIOS/Mesh/BLEMeshManager.swift \
        ios/EdgeCoderIOS/EdgeCoderIOS/Swarm/SwarmRuntimeController.swift
git commit -m "feat: iOS BLE re-advertisement and heartbeat model fields on model change"
```

---

## Task 13: P2P Model Transfer Stub

**Files:**
- Create: `src/mesh/model-transfer.ts`
- Test: `tests/mesh/model-transfer.test.ts`

**Context:** Per the design, devices that have a model can seed it to peers. This task creates the foundational transfer request/response protocol. The coordinator tracks which agents have which models via heartbeat `localModelCatalog`. Full streaming transfer is a follow-up; this task implements the request brokering logic.

**Step 1: Write the failing test**

Create `tests/mesh/model-transfer.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  findModelSeeders,
  rankSeeders,
  type ModelSeeder,
} from "../../src/mesh/model-transfer.js";

describe("findModelSeeders", () => {
  it("returns agents that have the requested model", () => {
    const agents = new Map<string, { localModelCatalog: string[]; lastSeenMs: number }>();
    agents.set("agent-a", { localModelCatalog: ["qwen2.5-coder:7b", "qwen2.5-coder:1.5b"], lastSeenMs: Date.now() });
    agents.set("agent-b", { localModelCatalog: ["qwen2.5-coder:1.5b"], lastSeenMs: Date.now() });
    agents.set("agent-c", { localModelCatalog: ["qwen2.5-coder:7b"], lastSeenMs: Date.now() });

    const seeders = findModelSeeders("qwen2.5-coder:7b", agents);
    expect(seeders).toHaveLength(2);
    expect(seeders.map((s) => s.agentId).sort()).toEqual(["agent-a", "agent-c"]);
  });

  it("returns empty for model nobody has", () => {
    const agents = new Map<string, { localModelCatalog: string[]; lastSeenMs: number }>();
    agents.set("agent-a", { localModelCatalog: ["qwen2.5-coder:1.5b"], lastSeenMs: Date.now() });

    const seeders = findModelSeeders("qwen2.5-coder:7b", agents);
    expect(seeders).toHaveLength(0);
  });

  it("excludes stale agents", () => {
    const agents = new Map<string, { localModelCatalog: string[]; lastSeenMs: number }>();
    agents.set("agent-stale", {
      localModelCatalog: ["qwen2.5-coder:7b"],
      lastSeenMs: Date.now() - 120_000,
    });
    agents.set("agent-fresh", {
      localModelCatalog: ["qwen2.5-coder:7b"],
      lastSeenMs: Date.now(),
    });

    const seeders = findModelSeeders("qwen2.5-coder:7b", agents);
    expect(seeders).toHaveLength(1);
    expect(seeders[0].agentId).toBe("agent-fresh");
  });
});

describe("rankSeeders", () => {
  it("ranks by freshness (most recently seen first)", () => {
    const now = Date.now();
    const seeders: ModelSeeder[] = [
      { agentId: "old", lastSeenMs: now - 50_000 },
      { agentId: "fresh", lastSeenMs: now - 1_000 },
      { agentId: "medium", lastSeenMs: now - 20_000 },
    ];

    const ranked = rankSeeders(seeders);
    expect(ranked[0].agentId).toBe("fresh");
    expect(ranked[1].agentId).toBe("medium");
    expect(ranked[2].agentId).toBe("old");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mesh/model-transfer.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/mesh/model-transfer.ts`:

```typescript
const STALE_THRESHOLD_MS = 90_000;

export interface ModelSeeder {
  agentId: string;
  lastSeenMs: number;
}

export function findModelSeeders(
  modelName: string,
  agents: Map<string, { localModelCatalog: string[]; lastSeenMs: number }>,
): ModelSeeder[] {
  const now = Date.now();
  const seeders: ModelSeeder[] = [];

  for (const [agentId, info] of agents) {
    if (now - info.lastSeenMs > STALE_THRESHOLD_MS) continue;
    if (info.localModelCatalog.includes(modelName)) {
      seeders.push({ agentId, lastSeenMs: info.lastSeenMs });
    }
  }

  return seeders;
}

export function rankSeeders(seeders: ModelSeeder[]): ModelSeeder[] {
  return [...seeders].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mesh/model-transfer.test.ts`
Expected: PASS — all 4 tests

**Step 5: Commit**

```bash
git add src/mesh/model-transfer.ts tests/mesh/model-transfer.test.ts
git commit -m "feat: P2P model transfer seeder discovery and ranking"
```

---

## Task 14: Model Seed Credits

**Files:**
- Modify: `src/credits/pricing.ts` (add `modelSeedCredits` function)
- Test: `tests/credits/model-seed-credits.test.ts`

**Context:** Per the design, when device A seeds a model to device B, A earns "distribution credits" (new earn reason: `model_seed`). Amount is based on file size and seeder count (fewer seeders = higher reward). The existing `baseRatePerSecond` function is at `src/credits/pricing.ts`.

**Step 1: Write the failing test**

Create `tests/credits/model-seed-credits.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { modelSeedCredits } from "../../src/credits/pricing.js";

describe("modelSeedCredits", () => {
  it("awards credits proportional to file size", () => {
    const small = modelSeedCredits(1_000_000_000, 5);   // 1GB, 5 seeders
    const large = modelSeedCredits(5_000_000_000, 5);   // 5GB, 5 seeders
    expect(large).toBeGreaterThan(small);
  });

  it("awards more credits when fewer seeders exist (rarity bonus)", () => {
    const manySeeders = modelSeedCredits(3_000_000_000, 10);
    const fewSeeders = modelSeedCredits(3_000_000_000, 1);
    expect(fewSeeders).toBeGreaterThan(manySeeders);
  });

  it("returns positive credits for any valid input", () => {
    const credits = modelSeedCredits(500_000_000, 3);
    expect(credits).toBeGreaterThan(0);
  });

  it("handles single seeder (maximum rarity)", () => {
    const credits = modelSeedCredits(1_000_000_000, 1);
    expect(credits).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/credits/model-seed-credits.test.ts`
Expected: FAIL — `modelSeedCredits` not exported from pricing.js

**Step 3: Write minimal implementation**

Add to `src/credits/pricing.ts`:

```typescript
/**
 * Compute credits earned for seeding a model to a peer.
 * @param fileSizeBytes Size of the model file transferred
 * @param seederCount Number of active seeders for this model (rarity factor)
 * @returns Credits earned
 */
export function modelSeedCredits(fileSizeBytes: number, seederCount: number): number {
  const sizeGB = fileSizeBytes / 1e9;
  const baseCredits = sizeGB * 0.5; // 0.5 credits per GB
  const rarityMultiplier = 1 / Math.max(1, seederCount); // fewer seeders = more reward
  return Number((baseCredits * (1 + rarityMultiplier)).toFixed(3));
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/credits/model-seed-credits.test.ts`
Expected: PASS — all 4 tests

**Step 5: Commit**

```bash
git add src/credits/pricing.ts tests/credits/model-seed-credits.test.ts
git commit -m "feat: model seed credit calculation with rarity bonus"
```

---

## Task 15: Documentation — BLE Local Mesh Guide

**Files:**
- Create: `site-docs/guide/ble-local-mesh.md`
- Modify: `site-docs/.vitepress/config.ts` (add to sidebar)

**Context:** The VitePress site at `site-docs/` has a `guide/` directory with existing pages. The sidebar config is at `site-docs/.vitepress/config.ts`. Per the design, we need a new page covering BLE mesh tethering: discovery, cost-based routing, offline credit ledger, batch sync.

**Step 1: Create the docs page**

Create `site-docs/guide/ble-local-mesh.md`:

```markdown
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
| <1.5B | 0.3x |

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
```

**Step 2: Add to sidebar**

In `site-docs/.vitepress/config.ts`, add to the Guide section items array:

```typescript
{ text: 'BLE Local Mesh', link: '/guide/ble-local-mesh' },
```

**Step 3: Build docs to verify**

Run: `npx vitepress build site-docs`
Expected: Build succeeds, new page accessible

**Step 4: Commit**

```bash
git add site-docs/guide/ble-local-mesh.md site-docs/.vitepress/config.ts
git commit -m "docs: add BLE local mesh guide page"
```

---

## Task 16: Documentation — Model Management Guide

**Files:**
- Create: `site-docs/guide/model-management.md`
- Modify: `site-docs/.vitepress/config.ts` (add to sidebar)

**Context:** Per the design doc, we need a guide page covering model swap, catalog, download, and P2P distribution.

**Step 1: Create the docs page**

Create `site-docs/guide/model-management.md`:

```markdown
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
// Immediate (installed)
{ "previous": "qwen2.5-coder:1.5b", "active": "qwen2.5-coder:7b", "status": "ready", "paramSize": 7 }

// Pulling
{ "previous": "qwen2.5-coder:1.5b", "active": "qwen2.5-coder:1.5b", "status": "pulling", "progress": 0 }
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
```

**Step 2: Add to sidebar**

In `site-docs/.vitepress/config.ts`, add to the Guide section:

```typescript
{ text: 'Model Management', link: '/guide/model-management' },
```

**Step 3: Build docs**

Run: `npx vitepress build site-docs`
Expected: Builds successfully

**Step 4: Commit**

```bash
git add site-docs/guide/model-management.md site-docs/.vitepress/config.ts
git commit -m "docs: add model management guide page"
```

---

## Task 17: Documentation — Coordinator Federation Operations

**Files:**
- Create: `site-docs/operations/coordinator-federation.md`
- Modify: `site-docs/.vitepress/config.ts` (add to sidebar)

**Step 1: Create the docs page**

Create `site-docs/operations/coordinator-federation.md`:

```markdown
# Coordinator Federation

Coordinators in the EdgeCoder network form a gossip-based federation. Each coordinator maintains a local view of its agents' capabilities and shares aggregated summaries with peers.

## Capability Gossip

Every 60 seconds, each coordinator broadcasts a `capability_summary` mesh message:

```json
{
  "coordinatorId": "coord-abc",
  "agentCount": 15,
  "modelAvailability": {
    "qwen2.5-coder:7b": { "agentCount": 8, "totalParamCapacity": 56, "avgLoad": 1.2 },
    "qwen2.5-coder:1.5b": { "agentCount": 7, "totalParamCapacity": 10.5, "avgLoad": 0.8 }
  },
  "timestamp": 1740268800000
}
```

Receiving coordinators store these summaries in a `federatedCapabilities` map, enabling cross-coordinator queries.

## Cross-Coordinator Task Routing

When a coordinator has no suitable local agent:

1. Check `federatedCapabilities` for coordinators with matching model capacity
2. Forward task to best-fit coordinator via mesh relay
3. Receiving coordinator assigns to a local agent
4. Result returns through the same path

## Ledger Agreement

The ordering chain provides hash-linked, signed event logs. Cross-coordinator reconciliation uses quorum voting (`floor(approvedCoordinators / 2) + 1`). The issuance flow (Proposal, Vote, Commit, Checkpoint) ensures all coordinators agree on credit distributions.

Model swap events affect credit calculations through the quality multiplier — swapping to a smaller model reduces future earnings proportionally.

## Querying Federation State

| Endpoint | Purpose |
|---|---|
| `GET /mesh/capabilities` | All federated capability summaries |
| `GET /mesh/capabilities?model=X` | Coordinators with agents running model X |
| `GET /mesh/peers` | Connected federation peers |

## Monitoring

- Capability gossip failures logged as `capability_gossip_failed`
- Stale federation data degrades gracefully — local routing still works
- Gossip messages are Ed25519-signed and validated on receipt
```

**Step 2: Add to sidebar**

In `site-docs/.vitepress/config.ts`, add to the Operations section:

```typescript
{ text: 'Coordinator Federation', link: '/operations/coordinator-federation' },
```

**Step 3: Build docs**

Run: `npx vitepress build site-docs`
Expected: Builds successfully

**Step 4: Commit**

```bash
git add site-docs/operations/coordinator-federation.md site-docs/.vitepress/config.ts
git commit -m "docs: add coordinator federation operations page"
```

---

## Task 18: Update Existing Documentation Pages

**Files:**
- Modify: `site-docs/guide/model-provider-abstraction.md` (add llama.cpp, model swap, quality multiplier)
- Modify: `site-docs/reference/api-endpoints-detailed.md` (add new endpoints)
- Modify: `site-docs/economy/credits-pricing-issuance.md` (add quality multiplier, BLE credits, seed credits)

**Step 1: Update model-provider-abstraction.md**

Add a new section after existing content:

```markdown
## llama.cpp (iOS)

iOS devices use llama.cpp for on-device inference with GGUF model files. The `LocalModelManager` handles model lifecycle:

- Download GGUF files from EdgeCoder CDN
- SHA-256 checksum verification
- Load into llama.cpp context
- Generate completions via `llama_decode` / `llama_sampling`
- Single model in memory (iPhone RAM constraint)

### Model Quality Multiplier

Credit earnings scale with model capability to incentivize running larger models:

| Model Size | Multiplier | Example |
|---|---|---|
| 7B+ parameters | 1.0x | Full credit rate |
| 3B-7B | 0.7x | 70% credit rate |
| 1.5B-3B | 0.5x | 50% credit rate |
| <1.5B | 0.3x | 30% credit rate |

### Runtime Model Swap

Models can be swapped at runtime via:
- **iOS**: ModelLibraryView UI → `LocalModelManager.activate(modelId)`
- **Node.js**: `POST /model/swap` HTTP endpoint or CLI `npx edgecoder model swap <name>`

Both trigger BLE re-advertisement and heartbeat capability updates.
```

**Step 2: Update api-endpoints-detailed.md**

Add to the Inference Service table:

```markdown
| POST | `/model/swap` | swap active model |
| GET | `/model/status` | current model and health |
| GET | `/model/list` | installed and available models |
```

Add to the Coordinator table:

```markdown
| GET | `/mesh/capabilities` | federated capability summaries |
| POST | `/credits/ble-sync` | sync offline BLE credit transactions |
```

**Step 3: Update credits-pricing-issuance.md**

Add new sections:

```markdown
## Model Quality Multiplier

Credit earnings from compute contributions are scaled by the model being used:

- 7B+ parameters: 1.0x (full rate)
- 3B-7B: 0.7x
- 1.5B-3B: 0.5x
- <1.5B: 0.3x

This incentivizes running capable models while still allowing participation with smaller hardware.

## BLE Offline Credits

When agents operate in BLE mesh mode (offline), credit transactions are recorded locally with dual signatures. On reconnection, transactions sync to the coordinator via `POST /credits/ble-sync` and enter the ordering chain.

## Model Seed Credits

Agents that distribute models to peers earn seed credits:

- Base: 0.5 credits per GB transferred
- Rarity bonus: `1 / seederCount` multiplier (fewer seeders = more reward)
- Incentivizes keeping popular models available for the network
```

**Step 4: Build docs**

Run: `npx vitepress build site-docs`
Expected: Builds successfully

**Step 5: Commit**

```bash
git add site-docs/guide/model-provider-abstraction.md \
        site-docs/reference/api-endpoints-detailed.md \
        site-docs/economy/credits-pricing-issuance.md
git commit -m "docs: update model provider, API endpoints, and credits docs"
```

---

## Task 19: E2E Test — Model Swap with BLE Re-Advertisement

**Files:**
- Create: `tests/model/model-swap-e2e.test.ts`

**Context:** This test verifies the full flow: model swap → BLE re-advertisement → peer routing table update. Uses MockBLETransport from the existing BLE test infrastructure.

**Step 1: Write the test**

Create `tests/model/model-swap-e2e.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { BLEMeshManager, modelQualityMultiplier } from "../../src/mesh/ble/ble-mesh-manager.js";
import { MockBLETransport } from "../../src/mesh/ble/ble-transport.js";
import { BLERouter } from "../../src/mesh/ble/ble-router.js";

describe("model swap E2E with BLE re-advertisement", () => {
  it("model change on device A is visible to device B's router", () => {
    const network = new Map<string, MockBLETransport>();

    // Device A starts with 1.5B model
    const transportA = new MockBLETransport("agent-a", network);
    transportA.startAdvertising({
      agentId: "agent-a",
      model: "qwen2.5-coder:1.5b",
      modelParamSize: 1.5,
      memoryMB: 8192,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "laptop",
    });

    const managerA = new BLEMeshManager("agent-a", "account-a", transportA);

    // Device B discovers A
    const transportB = new MockBLETransport("agent-b", network);
    const routerB = new BLERouter();
    const peersBeforeSwap = transportB.discoveredPeers();
    for (const peer of peersBeforeSwap) {
      routerB.updatePeer(peer);
    }

    const peerBefore = routerB.listPeers().find((p) => p.agentId === "agent-a");
    expect(peerBefore?.modelParamSize).toBe(1.5);

    // Device A swaps to 7B model
    managerA.onModelChanged("qwen2.5-coder:7b", 7);

    // Device B refreshes peers
    const peersAfterSwap = transportB.discoveredPeers();
    for (const peer of peersAfterSwap) {
      routerB.updatePeer(peer);
    }

    const peerAfter = routerB.listPeers().find((p) => p.agentId === "agent-a");
    expect(peerAfter?.model).toBe("qwen2.5-coder:7b");
    expect(peerAfter?.modelParamSize).toBe(7);
  });

  it("model swap changes quality multiplier for credit calculation", () => {
    // 1.5B model → 0.5x multiplier
    expect(modelQualityMultiplier(1.5)).toBe(0.5);

    // After swap to 7B → 1.0x multiplier
    expect(modelQualityMultiplier(7)).toBe(1.0);
  });

  it("device is unavailable during swap (currentLoad = -1)", () => {
    const network = new Map<string, MockBLETransport>();
    const transport = new MockBLETransport("agent-a", network);
    transport.startAdvertising({
      agentId: "agent-a",
      model: "old",
      modelParamSize: 1.5,
      memoryMB: 4096,
      batteryPct: 100,
      currentLoad: 0,
      deviceType: "laptop",
    });

    const manager = new BLEMeshManager("agent-a", "account-a", transport);

    // Start swap
    manager.onModelSwapStart();

    // Other device sees unavailable
    const transportB = new MockBLETransport("agent-b", network);
    const routerB = new BLERouter();
    for (const peer of transportB.discoveredPeers()) {
      routerB.updatePeer(peer);
    }

    const peerDuringSwap = routerB.listPeers().find((p) => p.agentId === "agent-a");
    expect(peerDuringSwap?.currentLoad).toBe(-1);

    // Swap completes
    manager.onModelChanged("new-model", 7);

    for (const peer of transportB.discoveredPeers()) {
      routerB.updatePeer(peer);
    }

    const peerAfterSwap = routerB.listPeers().find((p) => p.agentId === "agent-a");
    expect(peerAfterSwap?.currentLoad).toBe(0);
    expect(peerAfterSwap?.model).toBe("new-model");
  });
});
```

**Step 2: Run test**

Run: `npx vitest run tests/model/model-swap-e2e.test.ts`
Expected: PASS (after Task 5 is complete — depends on `onModelChanged`/`onModelSwapStart` methods)

**Step 3: Commit**

```bash
git add tests/model/model-swap-e2e.test.ts
git commit -m "test: E2E model swap with BLE re-advertisement and routing update"
```

---

## Task 20: Run Full Test Suite & Final Verification

**Files:** None — verification only

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (existing 128 + ~30 new = ~158 total)

**Step 2: Build docs**

Run: `npx vitepress build site-docs`
Expected: Clean build

**Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: No type errors (or only pre-existing ones)

**Step 4: Review all changes**

Run: `git log --oneline -20`
Verify commit history is clean with descriptive messages.

**Step 5: Commit any remaining fixes**

If any tests fail, fix and commit. Otherwise, no commit needed.

---

## Summary

| Task | Component | New Files | Modified Files | New Tests |
|---|---|---|---|---|
| 1 | Model catalog types | — | `types.ts` | 5 |
| 2 | Model swap functions | `swap.ts` | — | 6 |
| 3 | Model swap HTTP routes | `swap-routes.ts` | — | 4 |
| 4 | Wire into inference service | — | `service.ts` | 2 |
| 5 | BLE re-advertisement | — | `ble-mesh-manager.ts`, `ble-transport.ts` | 2 |
| 6 | Capability summary builder | `capability-gossip.ts` | — | 3 |
| 7 | Wire gossip into coordinator | — | `types.ts`, `coordinator.ts` | 3 |
| 8 | Heartbeat model fields | — | `coordinator.ts` | 2 |
| 9 | Federated capabilities endpoint | — | `coordinator.ts` | 2 |
| 10 | iOS LocalModelManager rewrite | — | `LocalModelManager.swift` | — |
| 11 | iOS SwiftUI views | 3 new Swift files | `SwarmView.swift` | — |
| 12 | iOS BLE re-advertisement | — | `BLEMeshManager.swift`, `SwarmRuntimeController.swift` | — |
| 13 | P2P model transfer | `model-transfer.ts` | — | 4 |
| 14 | Model seed credits | — | `pricing.ts` | 4 |
| 15 | BLE mesh docs | `ble-local-mesh.md` | `config.ts` | — |
| 16 | Model management docs | `model-management.md` | `config.ts` | — |
| 17 | Federation docs | `coordinator-federation.md` | `config.ts` | — |
| 18 | Update existing docs | — | 3 doc files | — |
| 19 | E2E test | — | — | 3 |
| 20 | Final verification | — | — | — |

**Total: ~6 new TS files, ~4 new Swift files, 3 new doc pages, ~40 new tests, ~10 modified files**
