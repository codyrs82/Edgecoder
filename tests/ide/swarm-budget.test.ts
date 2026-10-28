import { describe, expect, it } from "vitest";
import { SwarmSpendGuard, swarmBudgetFromEnv } from "../../src/apps/ide/swarm-budget.js";

// #71: IDE /run/swarm spend caps.
describe("SwarmSpendGuard (#71)", () => {
  it("rejects before submit when the expected cost is over the per-request cap", () => {
    const g = new SwarmSpendGuard({ perRequestMax: 0.5, expectedCredits: 1 });
    expect(g.reserve()).toEqual({ ok: false, reason: "per_request_cap" });
    expect(g.status().spent).toBe(0);
  });

  it("accumulates session spend from creditsSpent and stops at the session cap", () => {
    const g = new SwarmSpendGuard({ sessionMax: 3, expectedCredits: 1 });
    for (const spent of [1, 1.5]) {
      expect(g.reserve()).toEqual({ ok: true });
      g.settle(spent);
    }
    expect(g.status()).toMatchObject({ spent: 2.5, remaining: 0.5 });
    expect(g.reserve()).toEqual({ ok: false, reason: "session_cap" });
  });

  it("counts in-flight reservations so concurrent requests can't overshoot", () => {
    const g = new SwarmSpendGuard({ sessionMax: 2, expectedCredits: 1 });
    expect(g.reserve().ok).toBe(true);
    expect(g.reserve().ok).toBe(true);
    expect(g.reserve()).toEqual({ ok: false, reason: "session_cap" });
    g.release(); // a failed submit gives its reservation back
    expect(g.reserve().ok).toBe(true);
  });

  it("falls back to the estimate when the coordinator reports no cost and flags over-cap actuals", () => {
    const g = new SwarmSpendGuard({ perRequestMax: 2, expectedCredits: 1 });
    g.reserve();
    expect(g.settle(undefined)).toEqual({ overPerRequestCap: false });
    g.reserve();
    expect(g.settle(5)).toEqual({ overPerRequestCap: true });
    expect(g.status().spent).toBe(6);
  });

  it("config from env: unset = no cap", () => {
    expect(swarmBudgetFromEnv({})).toEqual({ perRequestMax: undefined, sessionMax: undefined, expectedCredits: 1 });
    expect(swarmBudgetFromEnv({ IDE_SWARM_MAX_CREDITS: "2", IDE_SWARM_SESSION_MAX_CREDITS: "50", IDE_SWARM_EXPECTED_CREDITS: "1.5" }))
      .toEqual({ perRequestMax: 2, sessionMax: 50, expectedCredits: 1.5 });
    expect(new SwarmSpendGuard(swarmBudgetFromEnv({})).reserve().ok).toBe(true);
  });
});
