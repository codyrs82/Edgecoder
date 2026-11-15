import { describe, expect, it } from "vitest";
import { verificationMessage } from "../src/lib/hardware-verification-copy";

// Settings > Compute > Your machines: the verification line explains the reason the coordinator returns.
describe("desktop verification message", () => {
  const now = 1_800_000_000_000;
  it("a Mac waiting for a witness is told there is nothing to do", () => {
    const m = verificationMessage({ status: "unverified", claimedTier: "apple.m.hi", grantedTier: "apple.m", reason: "cross_check_unavailable", nextCheckAtMs: now + 600_000 }, now);
    expect(m.actionable).toBe(false);
    expect(m.text).toMatch(/^This machine finished the speed check for apple\.m\.hi\./);
    expect(m.text).toContain("Nothing to do: you're paid at the standard Apple silicon rate (apple.m) meanwhile");
  });
  it("an older coordinator without nextCheckAtMs still gets a sentence", () => {
    expect(verificationMessage({ status: "unverified", claimedTier: "apple.m.hi", grantedTier: "apple.m", reason: "slow_sample_unconfirmed" }, now).text).toContain("re-checks soon");
  });
});
