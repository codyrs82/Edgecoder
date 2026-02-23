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

  it("returns ready for installed model and updates state", async () => {
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
