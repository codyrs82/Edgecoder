import { describe, expect, test } from "vitest";
import { AgentRateLimiter, RATE_LIMIT_MAX_SLOTS, isLeaseTraffic, isPullTraffic } from "../../src/security/agent-rate-limiter.js";

describe("agent-rate-limiter", () => {
  test("allows requests within limit", () => {
    const limiter = new AgentRateLimiter({ maxRequests: 3, windowMs: 60_000 });
    expect(limiter.check("agent-1")).toBe(true);
    expect(limiter.check("agent-1")).toBe(true);
    expect(limiter.check("agent-1")).toBe(true);
  });

  test("blocks requests exceeding limit", () => {
    const limiter = new AgentRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    expect(limiter.check("agent-1")).toBe(true);
    expect(limiter.check("agent-1")).toBe(true);
    expect(limiter.check("agent-1")).toBe(false);
  });

  test("tracks agents independently", () => {
    const limiter = new AgentRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    expect(limiter.check("agent-1")).toBe(true);
    expect(limiter.check("agent-2")).toBe(true);
    expect(limiter.check("agent-1")).toBe(false);
    expect(limiter.check("agent-2")).toBe(false);
  });

  test("reset clears window for specific agent", () => {
    const limiter = new AgentRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    expect(limiter.check("agent-1")).toBe(true);
    expect(limiter.check("agent-1")).toBe(false);
    limiter.reset("agent-1");
    expect(limiter.check("agent-1")).toBe(true);
  });
});

describe("agent-rate-limiter retryAfterMs", () => {
  test("is 0 under the limit and the time until the oldest counted request leaves the window over it", () => {
    const limiter = new AgentRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const real = Date.now;
    try {
      Date.now = () => 1_000_000;
      expect(limiter.check("a")).toBe(true);
      expect(limiter.retryAfterMs("a", 1_000_000)).toBe(0);
      Date.now = () => 1_010_000;
      expect(limiter.check("a")).toBe(true);
      Date.now = () => 1_020_000;
      expect(limiter.check("a")).toBe(false);
      expect(limiter.retryAfterMs("a", 1_020_000)).toBe(40_000);
    } finally {
      Date.now = real;
    }
  });
});

describe("AgentRateLimitedError", () => {
  test("is a 429 with a whole-second Retry-After of at least 1", async () => {
    const { AgentRateLimitedError } = await import("../../src/security/agent-rate-limiter.js");
    expect(new AgentRateLimitedError(40_200)).toMatchObject({ statusCode: 429, code: "agent_rate_limited", headers: { "retry-after": "41" } });
    expect(new AgentRateLimitedError(0).headers["retry-after"]).toBe("1");
  });
});

describe("agent-rate-limiter: budgets scale with the agent's reported slots", () => {
  test("base plus perSlot per reported slot, capped at 16 slots; flat without perSlot or a report", () => {
    const limiter = new AgentRateLimiter({ maxRequests: 300, windowMs: 60_000, perSlot: 50 });
    const slots: Record<string, number> = { cloud: 16, mac: 2, huge: 64 };
    limiter.setSlotsLookup((id) => slots[id]);
    expect(limiter.limitFor("cloud")).toBe(300 + 50 * 16);
    expect(limiter.limitFor("mac")).toBe(400);
    expect(limiter.limitFor("huge")).toBe(300 + 50 * RATE_LIMIT_MAX_SLOTS);
    expect(limiter.limitFor("unknown")).toBe(300);
    const flat = new AgentRateLimiter({ maxRequests: 3, windowMs: 60_000 });
    flat.setSlotsLookup(() => 16);
    expect(flat.limitFor("cloud")).toBe(3);
  });

  test("a 16-slot host's scaled budget admits what its base alone would refuse", () => {
    const limiter = new AgentRateLimiter({ maxRequests: 2, windowMs: 60_000, perSlot: 1 });
    limiter.setSlotsLookup((id) => (id === "cloud" ? 16 : undefined));
    for (let i = 0; i < 18; i++) expect(limiter.check("cloud")).toBe(true);
    expect(limiter.check("cloud")).toBe(false);
    expect(limiter.check("other")).toBe(true);
    expect(limiter.check("other")).toBe(true);
    expect(limiter.check("other")).toBe(false);
  });
});

describe("lease traffic (/result, lease-only heartbeats) has its own budget", () => {
  test("isLeaseTraffic: /result and leaseOnly heartbeats only", () => {
    expect(isLeaseTraffic("/result", "{}")).toBe(true);
    expect(isLeaseTraffic("/heartbeat", JSON.stringify({ agentId: "a", leaseOnly: true }))).toBe(true);
    expect(isLeaseTraffic("/heartbeat", JSON.stringify({ agentId: "a" }))).toBe(false);
    expect(isLeaseTraffic("/heartbeat", JSON.stringify({ agentId: "a", leaseOnly: false }))).toBe(false);
    expect(isLeaseTraffic("/heartbeat", "{\"leaseOnly\": tru")).toBe(false);
    expect(isLeaseTraffic("/pull", JSON.stringify({ leaseOnly: true }))).toBe(false);
  });
});

describe("pull traffic (/pull, non-lease heartbeats) has its own budget (D6)", () => {
  test("isPullTraffic: /pull and heartbeats that are not lease-only; nothing else", () => {
    expect(isPullTraffic("/pull", JSON.stringify({ agentId: "a", inferenceSlots: 16 }))).toBe(true);
    expect(isPullTraffic("/heartbeat", JSON.stringify({ agentId: "a" }))).toBe(true);
    expect(isPullTraffic("/heartbeat", undefined)).toBe(true);
    expect(isPullTraffic("/heartbeat", JSON.stringify({ agentId: "a", leaseOnly: true }))).toBe(false);
    for (const r of ["/agent-mesh/relay", "/agent-mesh/connect", "/register", "/result", "/inference/chunks"]) expect(isPullTraffic(r, "{}")).toBe(false);
  });

  test("run 3c: a 16-slot cloud host pulling ~1.5 times a second plus a heartbeat per pass stays inside its budget; a zero-slot agent gets the base only", () => {
    const pull = new AgentRateLimiter({ maxRequests: 300, windowMs: 60_000, perSlot: 40 });
    pull.setSlotsLookup((id) => (id === "cloud-fireworks-1" ? 16 : id === "huge" ? 500 : undefined));
    expect(pull.limitFor("cloud-fireworks-1")).toBe(300 + 40 * 16);
    expect(pull.limitFor("huge")).toBe(300 + 40 * RATE_LIMIT_MAX_SLOTS);
    expect(pull.limitFor("unknown")).toBe(300);
    // 60 s at 1.5 pull passes a second, each a heartbeat and a pull: 180 requests, well inside.
    for (let i = 0; i < 180; i++) expect(pull.check("cloud-fireworks-1")).toBe(true);
    // An agent that reports no slots is still held to the base.
    for (let i = 0; i < 300; i++) expect(pull.check("unknown")).toBe(true);
    expect(pull.check("unknown")).toBe(false);
  });
});
