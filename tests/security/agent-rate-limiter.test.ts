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
