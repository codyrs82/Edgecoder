import { describe, expect, it } from "vitest";
import { checkLaunchBuy, launchBuyUsage, launchConfigFromEnv, launchModeFromEnv, launchPolicyView, layerLaunchPayoutLimits, LAUNCH_WINDOW_MS } from "../../src/economy/launch-gate.js";

const invite = launchConfigFromEnv({ LAUNCH_MODE: "invite", LAUNCH_MAX_BUY_SATS_PER_DAY: "10000", LAUNCH_MAX_BALANCE_SATS: "15000", LAUNCH_MAX_PAYOUT_SATS_PER_DAY: "5000" });

describe("soft-launch gate", () => {
  it("is off unless LAUNCH_MODE=invite, with defaults for unset caps", () => {
    expect(launchModeFromEnv({})).toBe("open");
    expect(launchModeFromEnv({ LAUNCH_MODE: "open" })).toBe("open");
    expect(launchModeFromEnv({ LAUNCH_MODE: " Invite " })).toBe("invite");
    expect(launchConfigFromEnv({ LAUNCH_MODE: "invite" })).toEqual({ mode: "invite", maxBuySatsPerDay: 50_000, maxBalanceSats: 200_000, maxPayoutSatsPerDay: 50_000 });
    expect(() => launchConfigFromEnv({ LAUNCH_MAX_BALANCE_SATS: "-1" })).toThrow(/LAUNCH_MAX_BALANCE_SATS/);
  });

  it("caps purchases per 24 h, counting paid and open invoices", () => {
    const base = { amountSats: 4000, newCreditsSats: 4000, balanceSats: 0, openCreditsSats: 0 };
    expect(checkLaunchBuy({ ...base, boughtWindowSats: 6000 }, invite)).toBeNull();
    expect(checkLaunchBuy({ ...base, boughtWindowSats: 6001 }, invite)).toMatchObject({ error: "launch_buy_daily_cap", limitSats: 10000, remainingSats: 3999 });
    // Open mode: no cap at all.
    expect(checkLaunchBuy({ ...base, amountSats: 10 ** 6, boughtWindowSats: 10 ** 6 }, launchConfigFromEnv({}))).toBeNull();
  });

  it("caps the balance a purchase may bring the account to", () => {
    expect(checkLaunchBuy({ amountSats: 5000, newCreditsSats: 5000, boughtWindowSats: 0, balanceSats: 9000, openCreditsSats: 1000 }, invite)).toBeNull();
    const v = checkLaunchBuy({ amountSats: 5000, newCreditsSats: 5000, boughtWindowSats: 0, balanceSats: 9000, openCreditsSats: 2000 }, invite);
    expect(v).toMatchObject({ error: "launch_balance_cap", limitSats: 15000, remainingSats: 4000 });
    expect(v!.detail).toMatch(/^Early access: /);
  });

  it("layers the payout cap under the existing per-account daily cap", () => {
    const limits = { maxSingleSats: 100_000, maxAccountDailySats: 500_000, maxGlobalDailySats: 2_000_000 };
    expect(layerLaunchPayoutLimits(limits, invite)).toEqual({ ...limits, maxAccountDailySats: 5000 });
    // The lower cap wins, and an unset (0) cap does not lift the other.
    expect(layerLaunchPayoutLimits({ ...limits, maxAccountDailySats: 1000 }, invite).maxAccountDailySats).toBe(1000);
    expect(layerLaunchPayoutLimits({ ...limits, maxAccountDailySats: 0 }, invite).maxAccountDailySats).toBe(5000);
    expect(layerLaunchPayoutLimits(limits, { ...invite, maxPayoutSatsPerDay: 0 }).maxAccountDailySats).toBe(500_000);
    expect(layerLaunchPayoutLimits(limits, launchConfigFromEnv({}))).toBe(limits);
  });

  it("counts an account's paid and payable purchases in the window", () => {
    const now = 10 * LAUNCH_WINDOW_MS;
    const ttl = 3_600_000;
    const intents = [
      { accountId: "a", amountSats: 1000, quotedCredits: 990, status: "settled", createdAtMs: now - 1000 },
      { accountId: "a", amountSats: 2000, quotedCredits: 1980, status: "created", createdAtMs: now - 1000 },
      { accountId: "a", amountSats: 4000, quotedCredits: 3960, status: "created", createdAtMs: now - ttl - 1 }, // lapsed invoice
      { accountId: "a", amountSats: 8000, quotedCredits: 7920, status: "expired", createdAtMs: now - 1000 },
      { accountId: "a", amountSats: 16000, quotedCredits: 1, status: "settled", createdAtMs: now - LAUNCH_WINDOW_MS - 1 }, // before the window
      { accountId: "b", amountSats: 32000, quotedCredits: 1, status: "settled", createdAtMs: now }
    ];
    expect(launchBuyUsage(intents, "a", now, ttl)).toEqual({ boughtWindowSats: 3000, openCreditsSats: 1980 });
  });

  it("shows the caps only in invite mode", () => {
    expect(launchPolicyView(invite, 1234)).toEqual({ mode: "invite", maxBuySatsPerDay: 10000, maxBalanceSats: 15000, maxPayoutSatsPerDay: 5000, boughtWindowSats: 1234 });
    expect(launchPolicyView(launchConfigFromEnv({ LAUNCH_MAX_BUY_SATS_PER_DAY: "5" }), 9)).toEqual({ mode: "open", maxBuySatsPerDay: 0, maxBalanceSats: 0, maxPayoutSatsPerDay: 0 });
  });
});
