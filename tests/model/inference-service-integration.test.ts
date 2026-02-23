import { describe, it, expect } from "vitest";

describe("inference service model routes integration", () => {
  it("exports buildModelSwapRoutes from swap-routes", async () => {
    const mod = await import("../../src/model/swap-routes.js");
    expect(typeof mod.buildModelSwapRoutes).toBe("function");
  });

  it("ModelSwapState interface includes onModelChanged callback", () => {
    const state: import("../../src/model/swap-routes.js").ModelSwapState = {
      activeModel: "test",
      activeModelParamSize: 1,
      onModelChanged: (_model: string, _paramSize: number) => {},
    };
    expect(state.onModelChanged).toBeDefined();
  });
});
