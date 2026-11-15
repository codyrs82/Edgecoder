import { readFileSync } from "node:fs";
import { parse } from "acorn";
import { describe, expect, it } from "vitest";
import { verificationMessage, type VerificationView } from "../../src/common/hardware-verification-copy.js";
import { classifyHardware, type HardwareProfile } from "../../src/economy/compute-classes.js";
import { HardwareVerifier, ownerVerificationView } from "../../src/swarm/hardware-verification.js";
import { MARKET_SCRIPT } from "../../src/portal/pages/market.js";

const NOW = 1_800_000_000_000;
const apple = (over: Partial<VerificationView> = {}): VerificationView => ({ status: "unverified", claimedTier: "apple.m.hi", grantedTier: "apple.m", reason: null, nextCheckAtMs: NOW + 15 * 60_000, ...over });

describe("verificationMessage: one message per reason, saying whether the owner can act", () => {
  it("waiting for a witness: nothing to do, paid at the standard Apple rate", () => {
    const m = verificationMessage(apple({ reason: "cross_check_unavailable" }), NOW);
    expect(m.actionable).toBe(false);
    expect(m.tone).toBe("info");
    expect(m.text).toContain("another machine running the same model");
    expect(m.text).toContain("Nothing to do");
    expect(m.text).toContain("the standard Apple silicon rate (apple.m)");
    expect(m.text).toContain("in 15 min");
    expect(m.text).not.toMatch(/until it passes the speed check/);
  });

  it("inconclusive cross-check: nothing to do, retried with another machine", () => {
    const m = verificationMessage(apple({ reason: "cross_check_inconclusive" }), NOW);
    expect(m.actionable).toBe(false);
    expect(m.text).toContain("different machine");
  });

  it("slow, timed out, declined and demoted: says what to do and when it re-checks", () => {
    const slow = verificationMessage(apple({ reason: "slow_sample_unconfirmed", nextCheckAtMs: NOW + 60_000 }), NOW);
    expect(slow).toMatchObject({ tone: "warn", actionable: true });
    expect(slow.text).toContain("measured slower than apple.m.hi");
    expect(slow.text).toContain("plugged in");
    expect(slow.text).toContain("in about a minute");

    expect(verificationMessage(apple({ reason: "challenge_timeout" }), NOW).text).toContain("awake");
    expect(verificationMessage(apple({ reason: "declined:model_unavailable" }), NOW).text).toContain("wasn't loaded");
    const err = verificationMessage(apple({ reason: "declined:error:boom" }), NOW);
    expect(err).toMatchObject({ actionable: true });
    expect(err.text).toContain("couldn't run the speed check (error:boom)");

    const demoted = verificationMessage({ status: "demoted", claimedTier: "gpu.c24", grantedTier: "gpu.c16", reason: "below_claimed_tier", nextCheckAtMs: NOW + 3 * 3_600_000 }, NOW);
    expect(demoted.text).toContain("paid at the gpu.c16 rate");
    expect(demoted.text).toContain("in about 3 h");
    expect(verificationMessage({ status: "demoted", claimedTier: "gpu.c24", grantedTier: "gpu.c8", reason: "task_speed_below_tier" }, NOW).text).toContain("Real jobs ran much slower");
    expect(verificationMessage({ status: "demoted", claimedTier: "gpu.c24", grantedTier: "gpu.c8", reason: "invalid:cross_check_mismatch" }, NOW).text).toContain("didn't match other machines");
    expect(verificationMessage({ status: "demoted", claimedTier: "cpu.hi", grantedTier: "cpu.std", reason: "invalid:bad_proof" }, NOW).text).toContain("Update EdgeCoder");
  });

  it("no failure yet: old agent, model problems, or simply not checked", () => {
    expect(verificationMessage(apple({ checkSupported: false }), NOW)).toMatchObject({ actionable: true });
    expect(verificationMessage(apple({ checkSupported: false }), NOW).text).toContain("can't run the speed check");
    expect(verificationMessage(apple({ flags: ["challenge_model_too_small"] }), NOW).text).toContain("at least 3B");
    expect(verificationMessage(apple({ flags: ["challenge_no_model"] }), NOW).text).toContain("none is loaded");
    expect(verificationMessage(apple({ flags: ["challenge_model_unknown"] }), NOW).text).toContain("catalog");
    const fresh = verificationMessage(apple({ nextCheckAtMs: null }), NOW);
    expect(fresh).toMatchObject({ tone: "info", actionable: false });
    expect(fresh.text).toContain("runs soon");
  });

  it("verified, base and pending", () => {
    expect(verificationMessage({ status: "verified", claimedTier: "apple.m.hi", grantedTier: "apple.m.hi" }, NOW)).toMatchObject({ tone: "ok", actionable: false });
    expect(verificationMessage({ status: "base", claimedTier: "cpu.std", grantedTier: "cpu.std" }, NOW).text).toContain("nothing to verify");
    expect(verificationMessage(apple({ status: "pending" }), NOW).text).toContain("in progress");
  });
});

describe("one copy for the desktop app and the portal", () => {
  it("desktop/src/lib/hardware-verification-copy.ts is byte-identical", () => {
    expect(readFileSync("desktop/src/lib/hardware-verification-copy.ts", "utf8")).toBe(readFileSync("src/common/hardware-verification-copy.ts", "utf8"));
  });

  it("the portal market script embeds it as valid browser JS that gives the same answers", () => {
    expect(() => parse(MARKET_SCRIPT, { ecmaVersion: 2022 })).not.toThrow();
    const browserFn = new Function("var __name = function (f) { return f; }; return " + verificationMessage.toString())() as typeof verificationMessage;
    for (const reason of [null, "cross_check_unavailable", "slow_sample_unconfirmed", "declined:model_unavailable", "invalid:x"]) {
      expect(browserFn(apple({ reason }), NOW)).toEqual(verificationMessage(apple({ reason }), NOW));
    }
    expect(MARKET_SCRIPT).toContain("verificationDetail");
  });
});

describe("ownerVerificationView (what /account/summary and /economy/market/orders return)", () => {
  const MAC: HardwareProfile = { cpuCores: 12, ramGb: 64, platform: "darwin", arch: "arm64", cpuModel: "Apple M3 Max", gpu: { vendor: "apple", model: "Apple M3 Max", vramGb: 64 } };
  it("carries the reason, next check and whether this agent can answer the check", () => {
    const v = new HardwareVerifier();
    const claimed = classifyHardware(MAC);
    const old = ownerVerificationView(v.register({ agentId: "mac-old", claimed, profile: MAC, nowMs: NOW }));
    expect(old).toMatchObject({ status: "unverified", claimedTier: claimed.tier, checkSupported: false, reason: null });
    const cur = ownerVerificationView(v.register({ agentId: "mac-new", claimed, profile: MAC, challengeKinds: ["cpu", "gpu"], nowMs: NOW }));
    expect(cur.checkSupported).toBe(true);
    expect(cur.nextCheckAtMs).toBe(NOW);
    expect(verificationMessage(old, NOW).actionable).toBe(true);
  });
});
