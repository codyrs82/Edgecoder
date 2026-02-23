import { describe, it, expect } from "vitest";
import type {
  ModelCatalogEntry,
  ModelSwapRequest,
  ModelSwapResponse,
  ModelStatusResponse,
  ModelListEntry,
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

  it("accepts a pulling response with progress", () => {
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

describe("ModelListEntry type", () => {
  it("accepts a list entry", () => {
    const entry: ModelListEntry = {
      modelId: "qwen2.5-coder:7b",
      paramSize: 7,
      quantization: "Q4_0",
      installed: true,
      active: true,
      source: "ollama",
    };
    expect(entry.installed).toBe(true);
    expect(entry.source).toBe("ollama");
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
