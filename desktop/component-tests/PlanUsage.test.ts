import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/svelte";

// Wallet: Fund with Bitcoin and the Bitcoin on-chain payout method follow the coordinator's
// policy.onchain; without it both stay "Coming soon" (Zcash always does).
const ADDR = "bcrt1pqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsxs0cuf";
const api = vi.hoisted(() => ({
  computeOverview: vi.fn(),
  computeBuy: vi.fn(),
  computeIntent: vi.fn(),
  portalWebUrl: vi.fn((p: string) => p),
  getWalletOverview: vi.fn(),
  withdrawToInvoice: vi.fn(),
  getPayoutDestination: vi.fn(),
  savePayoutDestination: vi.fn(),
  getWalletSendRequests: vi.fn(async () => []),
  getOnchainAddress: vi.fn(),
  getPaymentPaths: vi.fn(async () => ({ prepaid: true, directReservations: false, nwc: false })),
  getOnchainDeposits: vi.fn(),
}));
vi.mock("../src/lib/api", () => api);
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

import PlanUsage from "../src/pages/PlanUsage.svelte";

const ONCHAIN_POLICY = {
  enabled: true, depositConfirmations: 3, depositMinSats: 10_000, depositMaxSats: 1_000_000, payoutMinSats: 50_000,
  payoutIntervalMs: 21_600_000, payoutMaxFeeRateSatVb: 30, payoutFeePayer: "host", payoutMaxFeeSats: 4_950, payoutConfirmations: 1,
};
function overview(onchain: unknown) {
  return {
    connected: true, network: "regtest", networkSource: "coordinator", cSats: 1000, earnedSats: 0, btcUsd: 100_000, rateStale: false,
    fees: { purchaseFeeBps: 0, networkFeeBps: 500 }, topup: { minSats: 100, maxSats: 1_000_000 },
    payouts: {
      balance: { earnedMsat: 0, heldMsat: 0, maturesAtMs: null, paidMsat: 0, pendingMsat: 0, payableMsat: 0 },
      policy: { network: "regtest", minPayoutSats: 1000, maxFeeBps: 100, lightningEnabled: true, paused: false, ...(onchain ? { onchain } : {}) },
      payouts: [{ createdAtMs: 1, kind: "onchain", amountMsat: 60_000_000, feeMsat: 1_200_000, status: "pending", txid: "ab".repeat(32) }],
    },
  };
}
const dest = (onchainSupported: boolean) => ({ accountId: "acct-u", network: "regtest", destination: null, needsDestination: true, legacyAddressRetired: false, supportedKinds: [], onchainSupported });

beforeEach(() => {
  api.computeOverview.mockResolvedValue({ connected: false });
  api.getOnchainAddress.mockResolvedValue({
    enabled: true, network: "regtest", address: ADDR, uri: `bitcoin:${ADDR.toUpperCase()}`, confirmationsRequired: 3, minSats: 10_000, maxSats: 0,
    deposits: [
      { txid: "aa".repeat(32), vout: 0, amountSats: 25_000, confirmations: 1, requiredConfirmations: 3, status: "pending", seenAtMs: 1, creditedAtMs: null },
      { txid: "bb".repeat(32), vout: 1, amountSats: 40_000, confirmations: 5, requiredConfirmations: 3, status: "credited", seenAtMs: 2, creditedAtMs: 3 },
      { txid: "cc".repeat(32), vout: 0, amountSats: 500, confirmations: 4, requiredConfirmations: 3, status: "below_minimum", seenAtMs: 4, creditedAtMs: null },
    ],
  });
  api.getOnchainDeposits.mockResolvedValue({ enabled: true, network: "regtest", address: ADDR, uri: null, deposits: [] });
});
afterEach(() => cleanup());

describe("Wallet: Bitcoin on-chain", () => {
  it("keeps Fund with Bitcoin and the on-chain payout method as Coming soon when the coordinator has it off", async () => {
    api.getWalletOverview.mockResolvedValue(overview(null));
    api.getPayoutDestination.mockResolvedValue(dest(false));
    render(PlanUsage);
    const methods = await screen.findByRole("group", { name: "How to fund" });
    const btc = within(methods).getByRole("button", { name: /Fund with Bitcoin/ });
    expect(btc).toHaveProperty("disabled", true);
    expect(btc.textContent).toContain("Coming soon");
    const payoutMethods = screen.getAllByRole("listitem").filter((li) => /on-chain/.test(li.textContent ?? ""));
    expect(payoutMethods.map((li) => li.textContent)).toEqual([expect.stringMatching(/Bitcoin on-chain.*Coming soon/), expect.stringMatching(/Zcash on-chain.*Coming soon/)]);
    expect(screen.getByLabelText("Lightning address")).toBeTruthy();
    expect(api.getOnchainAddress).not.toHaveBeenCalled();
  });

  it("shows the deposit address, its QR, and each deposit with its confirmations", async () => {
    api.getWalletOverview.mockResolvedValue(overview(ONCHAIN_POLICY));
    api.getPayoutDestination.mockResolvedValue(dest(true));
    render(PlanUsage);
    const methods = await screen.findByRole("group", { name: "How to fund" });
    const btc = await within(methods).findByRole("button", { name: /Fund with Bitcoin/ });
    expect(btc).toHaveProperty("disabled", false);
    await fireEvent.click(btc);
    expect(btc.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(screen.getByLabelText("Your Bitcoin deposit address").textContent).toBe(ADDR));
    expect(screen.getByRole("img", { name: /Bitcoin deposit address QR code/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open in wallet/ }).getAttribute("href")).toBe(`bitcoin:${ADDR}`);
    expect(screen.getByText(/Credited after 3 confirmations\. Minimum 10,000 sats/)).toBeTruthy();
    const table = screen.getByRole("table", { name: "Bitcoin deposits" });
    const rows = within(table).getAllByRole("row").slice(1).map((r) => r.textContent);
    expect(rows[0]).toMatch(/25,000.*1 of 3.*Confirming/);
    expect(rows[1]).toMatch(/40,000.*5.*Added/);
    expect(rows[2]).toMatch(/500.*Below minimum/);
    // The wording is "payment" / "address", never "invoice".
    expect(document.body.textContent?.toLowerCase()).not.toContain("invoice");
  });

  it("makes Bitcoin on-chain a selectable payout method with the minimum, schedule and fee note", async () => {
    api.getWalletOverview.mockResolvedValue(overview(ONCHAIN_POLICY));
    api.getPayoutDestination.mockResolvedValue(dest(true));
    render(PlanUsage);
    const item = await waitFor(() => {
      const li = screen.getAllByRole("listitem").find((x) => /Bitcoin on-chain/.test(x.textContent ?? ""));
      expect(li?.textContent).toContain("Available");
      return li!;
    });
    expect(item.textContent).toMatch(/every 6 h once at least 50,000 sats/);
    expect(item.textContent).toMatch(/network fee comes out of your payout \(at most 4,950 sats/);
    expect(screen.getAllByRole("listitem").find((x) => /Zcash/.test(x.textContent ?? ""))?.textContent).toContain("Coming soon");
    const input = screen.getByLabelText("Lightning address or Bitcoin address") as HTMLInputElement;
    expect(input.placeholder).toContain("bc1");
    // On-chain payouts appear in the history with their txid.
    expect(screen.getByText(/On-chain · abababab/)).toBeTruthy();
  });
});

describe("Wallet: buying cSats for the first time", () => {
  it("helps without a wallet, says what the amount buys, warns on signet with the faucet, and explains expiry", async () => {
    api.computeOverview.mockResolvedValue({ connected: true, models: [{ model: "qwen3-coder:30b", agents: 1, classes: [], cSatsPerMTokens: { input: 322.7, output: 939.8 } }] });
    api.getWalletOverview.mockResolvedValue({ ...overview(null), network: "signet" });
    api.getPayoutDestination.mockResolvedValue(dest(false));
    api.computeBuy.mockResolvedValue({ intentId: "i1", invoice: "lntbs1test", amountSats: 20_000, cSats: 20_000, feeSats: 0, network: "signet", expiresInSeconds: 900 });
    api.computeIntent.mockResolvedValue({ status: "pending" });
    render(PlanUsage);
    const help = await screen.findByTestId("no-wallet-help");
    expect(help.textContent).toMatch(/No Lightning wallet\?.*Any Lightning wallet works/);
    await waitFor(() => expect(screen.getByTestId("buy-calls").textContent).toMatch(/^About 7,\d{3} calls on a 30B coder model\.$/));
    await waitFor(() => expect(document.body.textContent).toContain("faucet.mutinynet.com"));
    await fireEvent.click(screen.getByRole("button", { name: /Buy 20,000 cSats with Lightning/ }));
    await screen.findByText("Waiting for payment…");
    expect(document.body.textContent).toContain("The code works for 15 minutes; if it runs out, nothing is charged: just make a new one.");
  });
});
