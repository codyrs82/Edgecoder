import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";

// Wallet > Buy cSats under early-access caps: the custom range, disabled presets, inline
// over-limit text, a clamped Buy cSats request, and plain-language refusals.
const api = vi.hoisted(() => {
  class FsError extends Error {
    constructor(readonly code: string, message: string, readonly status: number, readonly data?: Record<string, unknown>) { super(message); }
  }
  return {
    FsError,
    computeOverview: vi.fn(),
    computeBuy: vi.fn(),
    computeIntent: vi.fn(),
    portalWebUrl: vi.fn((p: string) => p),
    getWalletOverview: vi.fn(),
    withdrawToInvoice: vi.fn(),
    getPayoutDestination: vi.fn(async () => ({ accountId: "a", network: "regtest", destination: null, needsDestination: true, legacyAddressRetired: false, supportedKinds: [], onchainSupported: false })),
    savePayoutDestination: vi.fn(),
    getWalletSendRequests: vi.fn(async () => []),
    getOnchainAddress: vi.fn(),
    getPaymentPaths: vi.fn(async () => ({ prepaid: true, directReservations: false, nwc: false })),
    getOnchainDeposits: vi.fn(),
  };
});
vi.mock("../src/lib/api", () => api);
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

import PlanUsage from "../src/pages/PlanUsage.svelte";
import { buyLimitState, buyRequest, suggestedTopUpSats } from "../src/lib/buy-csats";

function overview(bought: number) {
  return {
    connected: true, network: "regtest", networkSource: "coordinator", cSats: 1000, earnedSats: 0, btcUsd: 100_000, rateStale: false,
    fees: { purchaseFeeBps: 0, networkFeeBps: 500 }, topup: { minSats: 100, maxSats: 1_000_000 },
    launch: { mode: "invite", maxBuySatsPerDay: 50_000, maxBalanceSats: 200_000, maxPayoutSatsPerDay: 50_000, boughtWindowSats: bought },
    payouts: null,
  };
}

beforeEach(() => {
  api.computeOverview.mockResolvedValue({ connected: true, account: { cSats: 1000, earnedSats: 0, recent: [] }, models: [] });
  buyRequest.set(null);
  buyLimitState.set(null);
});
afterEach(() => cleanup());

describe("Wallet: early-access purchase limits", () => {
  it("labels the custom range with what is left today and disables presets over it", async () => {
    api.getWalletOverview.mockResolvedValue(overview(5_000));
    render(PlanUsage);
    await screen.findByText("100 to 45,000 today");
    const big = screen.getByRole("radio", { name: /100,000/ });
    expect((big as HTMLButtonElement).disabled).toBe(true);
    expect(big.getAttribute("title")).toBe("Early access: up to 50,000 sats per day (45,000 left today).");
    expect((screen.getByRole("radio", { name: /20,000/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(get(buyLimitState)?.maxSats).toBe(45_000);
  });

  it("shows inline text and disables Buy for a custom amount over the limit", async () => {
    api.getWalletOverview.mockResolvedValue(overview(5_000));
    render(PlanUsage);
    await screen.findByText("100 to 45,000 today");
    await fireEvent.click(screen.getByRole("radio", { name: /Custom/ }));
    const input = document.getElementById("wallet-custom") as HTMLInputElement;
    expect(input.max).toBe("45000");
    await fireEvent.input(input, { target: { value: "500000" } });
    expect((await screen.findByTestId("buy-over-limit")).textContent).toContain("Early access: up to 50,000 sats per day (45,000 left today).");
    expect((screen.getByRole("button", { name: "Enter 100 to 45,000 sats" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("brings a Buy cSats request over the limit down to it", async () => {
    buyRequest.set({ amountSats: 100_000 });
    api.getWalletOverview.mockResolvedValue(overview(30_000));
    render(PlanUsage);
    expect((await screen.findByRole("button", { name: "Buy 20,000 cSats with Lightning" }) as HTMLButtonElement).disabled).toBe(false);
    expect(suggestedTopUpSats({ budgetCSatsPerDay: 80_000 })).toBe(20_000);
  });

  it("shows a refusal in plain language, never the code", async () => {
    api.getWalletOverview.mockResolvedValue(overview(0));
    api.computeBuy.mockRejectedValue(new api.FsError("launch_buy_daily_cap", "launch_buy_daily_cap", 429, { remainingSats: 45_000, limitSats: 50_000 }));
    render(PlanUsage);
    const buy = await screen.findByRole("button", { name: "Buy 20,000 cSats with Lightning" });
    await waitFor(() => expect((buy as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(buy);
    const alert = await screen.findByRole("alert");
    expect((alert).textContent).toContain("That's over today's early-access limit. You can buy up to 45,000 sats more today.");
    expect(alert.textContent).not.toContain("launch_buy_daily_cap");
  });
});
