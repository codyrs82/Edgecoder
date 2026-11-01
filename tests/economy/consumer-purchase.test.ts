import { describe, expect, test } from "vitest";
import { contributionPolicyDecision } from "../../src/swarm/coordinator-utils.js";

/**
 * Contribute-first policy for POST /submit, as actually enforced by the coordinator.
 *
 * effectiveEarned = earned (compute_contribution) + purchased (credit_purchase:%)
 * allowed when balance >= burstCredits, or spent == 0, or effectiveEarned / spent >= minRatio.
 *
 * Regression: the previous version of this file re-did the arithmetic locally and never
 * called the coordinator, while the real query only counted compute_contribution. A user who
 * bought credits with sats, had a balance under the burst threshold and had ever submitted a
 * task was refused with contribute_first_required.
 */
const CFG = { burstCredits: 25, minRatio: 1.0 };

describe("contribute-first policy (consumer purchase path)", () => {
  test("purchased credits satisfy the ratio with no compute contribution", () => {
    const d = contributionPolicyDecision({ earned: 0, spent: 5, purchased: 10 }, 5, CFG);
    expect(d).toEqual({ ok: true, reason: "ratio_ok" });
  });

  test("mixed earned + purchased credits satisfy the ratio", () => {
    expect(contributionPolicyDecision({ earned: 3, spent: 5, purchased: 3 }, 1, CFG).ok).toBe(true);
  });

  test("zero earned + zero purchased is blocked once something was spent and the balance is small", () => {
    const d = contributionPolicyDecision({ earned: 0, spent: 5, purchased: 0 }, 3, CFG);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/contribute_first_policy/);
    expect(d.reason).toMatch(/purchased=0.000/);
  });

  test("burst balance bypasses the ratio", () => {
    expect(contributionPolicyDecision({ earned: 0, spent: 100, purchased: 0 }, 30, CFG)).toEqual({ ok: true, reason: "burst_balance" });
  });

  test("a fresh account that never spent is allowed", () => {
    expect(contributionPolicyDecision({ earned: 0, spent: 0, purchased: 0 }, 0, CFG)).toEqual({ ok: true, reason: "nothing_spent" });
  });

  test("pure consumer: keeps submitting while purchases keep pace with spend, blocked when they fall behind", () => {
    expect(contributionPolicyDecision({ earned: 0, spent: 10, purchased: 15 }, 5, CFG).ok).toBe(true);
    expect(contributionPolicyDecision({ earned: 0, spent: 16, purchased: 15 }, 0, CFG).ok).toBe(false);
  });

  test("minRatio is honoured and negative stats never help", () => {
    expect(contributionPolicyDecision({ earned: 1, spent: 4, purchased: 0 }, 0, { burstCredits: 25, minRatio: 0.25 }).ok).toBe(true);
    expect(contributionPolicyDecision({ earned: 1, spent: 4, purchased: 0 }, 0, { burstCredits: 25, minRatio: 0.5 }).ok).toBe(false);
    expect(contributionPolicyDecision({ earned: -5, spent: 4, purchased: 4 }, 0, CFG).ok).toBe(true);
  });
});
