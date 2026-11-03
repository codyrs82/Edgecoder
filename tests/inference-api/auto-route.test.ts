import { describe, expect, it } from "vitest";
import { fitScore, paramsB, rankRoutes, routeModelId, sizeWorkload, type RouteInputs } from "../../src/inference-api/auto-route.js";

const light = sizeWorkload({ messages: [{ role: "user", content: "what does git rebase do?" }] });
const heavy = sizeWorkload({ messages: [{ role: "user", content: "fix the bug" }], tools: [{ type: "function", function: { name: "Edit" } }] });

const prices = { cpu: 0.009, apple: 0.052, gpu: 0.043, "gpu.dc": 0.304 };
const base: RouteInputs = { localModels: [], myModels: [], leases: [], networkModels: [], classPrice: prices };

describe("auto routing", () => {
  it("sizes the job: tools or a long prompt is agent work", () => {
    expect(light.heavy).toBe(false);
    expect(heavy.heavy).toBe(true);
    expect(sizeWorkload({ messages: [{ role: "user", content: "x".repeat(30_000) }] }).heavy).toBe(true);
  });

  it("reads model sizes from tags", () => {
    expect(paramsB("qwen2.5-coder:1.5b")).toBe(1.5);
    expect(paramsB("qwen3-coder:30b")).toBe(30);
    expect(paramsB("qwen2.5-coder:latest")).toBe(7);
  });

  it("uses small models for quick tasks and capable coders for agent work", () => {
    expect(fitScore("qwen2.5-coder:0.5b", light)).toBe(-1);
    expect(fitScore("qwen2.5-coder:1.5b", light)).toBeGreaterThan(fitScore("qwen3.5:9b", light));
    expect(fitScore("qwen2.5-coder:1.5b", heavy)).toBe(-1);
    expect(fitScore("qwen2.5-coder:14b", heavy)).toBeGreaterThan(fitScore("qwen3.5:9b", heavy));
    expect(fitScore("nomic-embed-text", light)).toBe(-1);
  });

  it("prefers prepaid, then free, then the cheapest network class for the job", () => {
    const routes = rankRoutes(heavy, {
      ...base,
      leases: [{ id: "r1", computeClass: "gpu", models: ["qwen2.5-coder:14b"] }],
      localModels: ["qwen3.5:9b"],
      myModels: ["qwen2.5-coder:7b"],
      networkModels: [{ model: "qwen2.5-coder:14b", classes: ["cpu", "apple", "gpu", "gpu.dc"] }],
    });
    expect(routes.map((r) => r.placement)).toEqual(["reserved", "local", "mine", "network", "network", "network"]);
    // GPU beats Apple and datacenter on cost for the same job, and CPU is skipped for agent work.
    expect(routes.filter((r) => r.placement === "network").map((r) => r.computeClass)).toEqual(["gpu", "apple", "gpu.dc"]);
    expect(routeModelId(routes[0])).toBe("reserved/r1/qwen2.5-coder:14b");
  });

  it("sends a quick task to the cheapest machine, CPU included, when nothing free fits", () => {
    const routes = rankRoutes(light, { ...base, localModels: ["qwen2.5-coder:0.5b"], networkModels: [{ model: "qwen2.5-coder:1.5b", classes: ["cpu", "gpu"] }] });
    expect(routes.map((r) => `${r.placement}:${r.computeClass ?? ""}`)).toEqual(["network:cpu", "network:gpu"]);
    expect(routeModelId(routes[0])).toBe("network/qwen2.5-coder:1.5b@cpu");
  });

  it("returns nothing when no model anywhere fits", () => {
    expect(rankRoutes(heavy, { ...base, localModels: ["qwen2.5-coder:1.5b"] })).toEqual([]);
  });
});
