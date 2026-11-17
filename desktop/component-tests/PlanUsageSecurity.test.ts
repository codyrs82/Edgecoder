import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";

// Wallet: the desktop surfaces the portal's account security (src/portal/account-security.ts):
// two-factor codes for withdrawals and payout address changes, the web for passkey-only accounts,
// and the payout address cooling-off.
const api = vi.hoisted(() => ({
  computeOverview: vi.fn(),
  computeBuy: vi.fn(),
  computeIntent: vi.fn(),
  portalWebUrl: vi.fn((p: string) => `https://portal.example${p}`),
  getWalletOverview: vi.fn(),
  withdrawToInvoice: vi.fn(),
  getPayoutDestination: vi.fn(),
  savePayoutDestination: vi.fn(),
  getWalletSendRequests: vi.fn(async () => []),
  getOnchainAddress: vi.fn(),
  getPaymentPaths: vi.fn(async () => ({ prepaid: true, directReservations: false, nwc: false })),
  getOnchainDeposits: vi.fn(),
}));
const shell = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../src/lib/api", () => api);
vi.mock("@tauri-apps/plugin-shell", () => shell);

import PlanUsage from "../src/pages/PlanUsage.svelte";

const overview = {
  connected: true, network: "regtest", networkSource: "coordinator", cSats: 1000, earnedSats: 0, btcUsd: 100_000, rateStale: false,
  fees: { purchaseFeeBps: 0, networkFeeBps: 500 }, topup: { minSats: 100, maxSats: 1_000_000 },
  payouts: {
    balance: { earnedMsat: 5_000_000, heldMsat: 0, maturesAtMs: null, paidMsat: 0, pendingMsat: 0, payableMsat: 5_000_000 },
    policy: { network: "regtest", minPayoutSats: 1, maxFeeBps: 100, lightningEnabled: true, paused: false },
    payouts: [],
  },
};
const dest = (over: Record<string, unknown> = {}) => ({ accountId: "acct-u", network: "regtest", destination: { kind: "lightning_address", destination: "old@getalby.com", updatedAtMs: 1 }, needsDestination: false, legacyAddressRetired: false, supportedKinds: ["lightning_address"], onchainSupported: false, ...over });
const TWO_FACTOR = { status: "two_factor_required", methods: ["totp", "recovery_code"], webOnly: false, detail: "Enter the code from your authenticator app.", invalidCode: false };

beforeEach(() => {
  vi.clearAllMocks();
  api.computeOverview.mockResolvedValue({ connected: false });
  api.getWalletOverview.mockResolvedValue(overview);
  api.getPayoutDestination.mockResolvedValue(dest());
});
afterEach(() => cleanup());

describe("Wallet: two-factor authentication", () => {
  it("a withdrawal asks for the authenticator code and sends it with the retry", async () => {
    api.withdrawToInvoice.mockResolvedValueOnce(TWO_FACTOR).mockResolvedValueOnce({ status: "verification_required", challengeId: "ch-1", amountMsat: 2_000_000, detail: "We emailed a code." });
    render(PlanUsage);
    const textarea = await screen.findByLabelText(/payment code \(lnbc…\)/);
    await fireEvent.input(textarea, { target: { value: "lnbcrt20u1test" } });
    await fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    const code = await screen.findByLabelText(/Code from your authenticator app/);
    await fireEvent.input(code, { target: { value: "123456" } });
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.withdrawToInvoice).toHaveBeenCalledTimes(2));
    expect(api.withdrawToInvoice.mock.calls[1][0]).toEqual({ bolt11: "lnbcrt20u1test", twoFactorCode: "123456" });
    await screen.findByText(/We emailed a code\./);
  });

  it("a passkey-only account is sent to the web to finish", async () => {
    api.withdrawToInvoice.mockResolvedValueOnce({ ...TWO_FACTOR, methods: ["passkey"], webOnly: true });
    render(PlanUsage);
    const textarea = await screen.findByLabelText(/payment code \(lnbc…\)/);
    await fireEvent.input(textarea, { target: { value: "lnbcrt20u1test" } });
    await fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    await fireEvent.click(await screen.findByRole("button", { name: /Withdraw on the web/ }));
    expect(shell.open).toHaveBeenCalledWith("https://portal.example/portal/settings/plan#earnings");
  });

  it("a payout address change asks for the code too", async () => {
    api.savePayoutDestination.mockResolvedValueOnce(TWO_FACTOR).mockResolvedValueOnce({ status: "verification_required", challengeId: "c", detail: "We emailed a confirmation link (and code)." });
    render(PlanUsage);
    const input = await screen.findByLabelText("Lightning address");
    await fireEvent.input(input, { target: { value: "new@getalby.com" } });
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const code = await screen.findByLabelText(/Code from your authenticator app/);
    await fireEvent.input(code, { target: { value: "654321" } });
    await fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.savePayoutDestination).toHaveBeenCalledTimes(2));
    expect(api.savePayoutDestination.mock.calls[1][0]).toEqual({ destination: "new@getalby.com", twoFactorCode: "654321" });
    await screen.findByText(/confirmation link/);
  });
});

describe("Wallet: payout address cooling-off", () => {
  it("shows a confirmed change and when it takes effect", async () => {
    api.getPayoutDestination.mockResolvedValue(dest({ pendingDestination: { kind: "lightning_address", destination: "new@getalby.com", first: false, confirmed: true, confirmExpiresAtMs: 1, activatesAtMs: Date.UTC(2030, 0, 2) } }));
    render(PlanUsage);
    await waitFor(() => expect(document.body.textContent).toMatch(/New address new@getalby\.com is confirmed\. Payouts go there from .*withdrawals are paused/));
  });

  it("shows a refused withdrawal's reason", async () => {
    api.withdrawToInvoice.mockResolvedValueOnce({ status: "error", code: "payout_destination_cooling_off", detail: "A new payout address was added, so withdrawals are paused until Tue.", unlocksAtMs: 1 });
    render(PlanUsage);
    const textarea = await screen.findByLabelText(/payment code \(lnbc…\)/);
    await fireEvent.input(textarea, { target: { value: "lnbcrt20u1test" } });
    await fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
    await screen.findByText(/withdrawals are paused until Tue/);
  });
});
