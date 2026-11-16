import { describe, expect, it } from "vitest";
import { describeServed, gpuLine } from "../../src/swarm/served-by.js";
import { servedOf } from "../../src/apps/ide/network-inference.js";

const key = Buffer.alloc(32, 7);

describe("served-by", () => {
  it("masks another account's machine and names the hardware, GPU, region and timings", () => {
    const s = describeServed(key, {
      agentId: "agent-secret-id",
      ownerAccountId: "acct-owner",
      requesterAccountId: "acct-me",
      os: "linux",
      computeClass: "gpu.dc",
      tier: "gpu.dc40",
      hardwareProfile: { gpu: { vendor: "nvidia", model: "A16", count: 2, vramGb: 64, datacenter: true } },
      region: "ord",
      timings: { pickupMs: 420, promptMs: 81_000, genMs: 6_500, promptTokens: 24_800, outputTokens: 312 },
    });
    expect(s).toMatchObject({ own: false, hardware: "Datacenter GPU (gpu.dc40)", gpu: "2× NVIDIA A16", region: "ord", city: "Chicago", country: "US", promptMs: 81_000, genMs: 6_500, promptTokens: 24_800, outputTokens: 312 });
    expect(s.label).toMatch(/^lin-•••[0-9a-f]{4}$/);
    expect(JSON.stringify(s)).not.toContain("agent-secret-id");
  });

  it("names the caller's own machine as theirs", () => {
    expect(describeServed(key, { agentId: "a", ownerAccountId: "acct-me", requesterAccountId: "acct-me", os: "darwin", computeClass: "apple", tier: "apple.m.hi" })).toMatchObject({ own: true, label: "your machine (Mac)", hardware: "Apple silicon (apple.m.hi)" });
  });

  it("gpu lines and the client's shape check", () => {
    expect(gpuLine({ gpu: { vendor: "nvidia", model: "NVIDIA RTX 4090" } })).toBe("NVIDIA RTX 4090");
    expect(gpuLine(undefined)).toBeUndefined();
    expect(servedOf({ label: "x", hardware: "CPU", promptMs: -1, genMs: 5, extra: "dropped" })).toEqual({ label: "x", own: false, computeClass: "", tier: null, hardware: "CPU", region: null, country: null, genMs: 5 });
    expect(servedOf("nope")).toBeUndefined();
  });
});
