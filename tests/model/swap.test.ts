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
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ollamaTagsResponse([
        { name: "qwen2.5-coder:1.5b", size: 1_500_000_000 },
      ]),
    });
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
