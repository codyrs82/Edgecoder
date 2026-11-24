import { describe, expect, it } from "vitest";
import { pullSchema } from "../../src/swarm/coordinator/schemas.js";

describe("pull schema: contextWindow", () => {
  it("accepts a cloud host's 1M-token window", () => {
    expect(pullSchema.safeParse({ agentId: "cloud-fireworks-1", contextWindow: 1_040_000 }).success).toBe(true);
  });
  it("still bounds it", () => {
    expect(pullSchema.safeParse({ agentId: "a", contextWindow: 1024 }).success).toBe(false);
    expect(pullSchema.safeParse({ agentId: "a", contextWindow: 3_000_000 }).success).toBe(false);
  });
});
