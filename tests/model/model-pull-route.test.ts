import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import * as swapModule from "../../src/model/swap.js";
import { buildModelSwapRoutes } from "../../src/model/swap-routes.js";
import { PullTracker } from "../../src/model/pull-tracker.js";

vi.mock("../../src/model/swap.js", () => ({
  swapModel: vi.fn(),
  getModelStatus: vi.fn(),
  listModels: vi.fn(),
  pullModel: vi.fn(),
}));
const mockPull = vi.mocked(swapModule.pullModel);

async function buildApp() {
  const app = Fastify();
  const state = { activeModel: "qwen2.5-coder:1.5b", activeModelParamSize: 1.5, pullTracker: new PullTracker() };
  buildModelSwapRoutes(app, state);
  await app.ready();
  return { app, state };
}

describe("POST /model/pull (#37)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("starts a pull, returns 202, and progress is visible", async () => {
    const { app, state } = await buildApp();
    mockPull.mockImplementationOnce(async (model, tracker) => {
      tracker?.updateProgress("downloading", 50, 100);
      return { model, status: "pulling" };
    });
    const res = await app.inject({ method: "POST", url: "/model/pull", payload: { model: "qwen2.5:0.5b" } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ model: "qwen2.5:0.5b", status: "pulling" });
    expect(mockPull).toHaveBeenCalledWith("qwen2.5:0.5b", state.pullTracker);
    const progress = await app.inject({ method: "GET", url: "/model/pull/progress" });
    expect(progress.json()).toMatchObject({ model: "qwen2.5:0.5b", progressPct: 50 });
    // A second pull while one runs is refused.
    const again = await app.inject({ method: "POST", url: "/model/pull", payload: { model: "llama3:8b" } });
    expect(again.statusCode).toBe(409);
    await app.close();
  });

  it("concurrent pulls: only one starts (#119 review race)", async () => {
    const { app } = await buildApp();
    let release!: () => void;
    mockPull.mockImplementation(async (model) => {
      await new Promise<void>((r) => (release = r));
      return { model, status: "pulling" };
    });
    const a = app.inject({ method: "POST", url: "/model/pull", payload: { model: "a:1" } });
    const b = app.inject({ method: "POST", url: "/model/pull", payload: { model: "b:1" } });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const codes = (await Promise.all([a, b])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([202, 409]);
    expect(mockPull).toHaveBeenCalledTimes(1);
    mockPull.mockReset();
    await app.close();
  });

  it("returns 200 when the model is already installed and does not switch the active model", async () => {
    const { app, state } = await buildApp();
    mockPull.mockResolvedValueOnce({ model: "llama3:8b", status: "ready" });
    const res = await app.inject({ method: "POST", url: "/model/pull", payload: { model: "llama3:8b" } });
    expect(res.statusCode).toBe(200);
    expect(state.activeModel).toBe("qwen2.5-coder:1.5b");
    await app.close();
  });

  it("rejects missing or malformed model names", async () => {
    const { app } = await buildApp();
    for (const payload of [{}, { model: "" }, { model: 5 }, { model: "bad name" }, { model: "../etc" }, { model: "a/../b" }]) {
      expect((await app.inject({ method: "POST", url: "/model/pull", payload })).statusCode).toBe(400);
    }
    expect(mockPull).not.toHaveBeenCalled();
    await app.close();
  });

  it("maps an Ollama failure to 502", async () => {
    const { app } = await buildApp();
    mockPull.mockResolvedValueOnce({ model: "x:1", status: "error", error: "pull_failed" });
    expect((await app.inject({ method: "POST", url: "/model/pull", payload: { model: "x:1" } })).statusCode).toBe(502);
    await app.close();
  });
});
