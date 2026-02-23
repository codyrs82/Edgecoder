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
