import { describe, expect, test } from "vitest";
import { AgentRateLimiter } from "../../src/security/agent-rate-limiter.js";

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
