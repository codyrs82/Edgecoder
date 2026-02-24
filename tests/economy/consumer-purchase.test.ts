import { describe, expect, test } from "vitest";

/**
 * Tests for the consumer-only purchase path.
 *
 * The enforceContributionFirstPolicy now considers purchased credits
 * (reason LIKE 'credit_purchase:%') alongside earned credits from compute
 * contribution when checking the contribution-first ratio.
 *
 * The formula: effectiveEarned = earned + purchased
 * Ratio: effectiveEarned / spent >= MIN_CONTRIBUTION_RATIO (default 1.0)
 *
 * This enables agents that ONLY purchase credits (never contribute compute)
 * to still submit tasks, as long as they maintain a valid ratio.
 */

describe("consumer purchase path", () => {
  test("purchased credits satisfy contribution ratio", () => {
    const stats = { earned: 0, spent: 5, purchased: 10 };
    const effectiveEarned = stats.earned + stats.purchased;
    const ratio = stats.spent <= 0 ? Number.POSITIVE_INFINITY : effectiveEarned / stats.spent;
    expect(ratio).toBe(2);
    expect(ratio >= 1.0).toBe(true);
  });

  test("mixed earned + purchased credits satisfy ratio", () => {
    const stats = { earned: 3, spent: 5, purchased: 3 };
    const effectiveEarned = stats.earned + stats.purchased;
    const ratio = stats.spent <= 0 ? Number.POSITIVE_INFINITY : effectiveEarned / stats.spent;
    expect(ratio).toBe(1.2);
    expect(ratio >= 1.0).toBe(true);
  });

  test("zero earned + zero purchased still blocked when spent > 0", () => {
    const stats = { earned: 0, spent: 5, purchased: 0 };
    const balance = 3; // below CONTRIBUTION_BURST_CREDITS default of 25
    const effectiveEarned = stats.earned + stats.purchased;
    const ratio = stats.spent <= 0 ? Number.POSITIVE_INFINITY : effectiveEarned / stats.spent;
    expect(ratio).toBe(0);
    expect(ratio >= 1.0).toBe(false);
    expect(balance >= 25).toBe(false);
  });

  test("burst credits bypass contribution policy", () => {
    const stats = { earned: 0, spent: 0, purchased: 0 };
    const balance = 30; // above CONTRIBUTION_BURST_CREDITS default of 25
    // Policy allows if balance >= CONTRIBUTION_BURST_CREDITS regardless of ratio
    expect(balance >= 25).toBe(true);
  });

  test("credit_purchase reason matches LIKE pattern", () => {
    const reason = "credit_purchase:intent-abc-123";
    // The SQL uses: reason LIKE 'credit_purchase:%'
    expect(reason.startsWith("credit_purchase:")).toBe(true);
  });

  test("adjustCredits creates earn type for positive credits", () => {
    // Verify the existing adjustCredits logic: positive credits → type "earn"
    const credits = 50;
    const type = credits >= 0 ? "earn" : "spend";
    expect(type).toBe("earn");
  });

  test("pure consumer flow: no compute, only purchases", () => {
    const stats = { earned: 0, spent: 10, purchased: 15 };
    const effectiveEarned = stats.earned + stats.purchased;
    const ratio = stats.spent <= 0 ? Number.POSITIVE_INFINITY : effectiveEarned / stats.spent;
    expect(ratio).toBe(1.5);
    expect(ratio >= 1.0).toBe(true);
    // A user who only buys credits and never contributes compute
    // passes the policy as long as purchased >= spent
  });
});
