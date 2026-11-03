import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { buildModelSwapRoutes } from "../../src/model/swap-routes.js";
import { PullTracker } from "../../src/model/pull-tracker.js";
import { MODEL_CATALOG, MODEL_CATALOG_VERSION } from "../../src/model/catalog.js";

vi.mock("../../src/model/swap.js", () => ({
  swapModel: vi.fn(),
  getModelStatus: vi.fn(),
  listModels: vi.fn()
}));

describe("GET /model/catalog", () => {
  it("serves the shared catalog with its version and category labels", async () => {
    const app = Fastify();
    buildModelSwapRoutes(app, { activeModel: "qwen3.5:9b", activeModelParamSize: 9, pullTracker: new PullTracker() });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/model/catalog" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe(MODEL_CATALOG_VERSION);
    expect(body.categories).toEqual({ coding: "Coding", general: "General Purpose", small: "Small & Fast", large: "Large (GPU servers)" });
    expect(body.models).toHaveLength(MODEL_CATALOG.length);
    expect(body.models.map((m: { modelId: string }) => m.modelId)).toContain("qwen3.5:9b");
    await app.close();
  });
});
