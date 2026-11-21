import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { get } from "svelte/store";

// Wallet > Buy cSats limits: the custom range, inline over-limit text, a clamped Buy cSats
// request, and plain-language refusals.
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
import { buyLimitState, buyRequest } from "../src/lib/buy-csats";

function overview() {
  return {
    connected: true, network: "regtest", networkSource: "coordinator", cSats: 1000, earnedSats: 0, btcUsd: 100_000, rateStale: false,
    fees: { purchaseFeeBps: 0, networkFeeBps: 500 }, topup: { minSats: 100, maxSats: 1_000_000 },
    launch: null,
    payouts: null,
  };
}

beforeEach(() => {
  api.computeOverview.mockResolvedValue({ connected: true, account: { cSats: 1000, earnedSats: 0, recent: [] }, models: [] });
  buyRequest.set(null);
  buyLimitState.set(null);
});
afterEach(() => cleanup());

describe("Wallet: purchase limits", () => {
  it("labels the custom range 100 to 1M and keeps every preset enabled", async () => {
    api.getWalletOverview.mockResolvedValue(overview());
    render(PlanUsage);
    await screen.findByText("100 to 1M");
    expect((screen.getByRole("radio", { name: /100,000/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(get(buyLimitState)?.maxSats).toBe(1_000_000);
  });

  it("shows inline text and disables Buy for a custom amount over the limit", async () => {
    api.getWalletOverview.mockResolvedValue(overview());
    render(PlanUsage);
    await screen.findByText("100 to 1M");
    await fireEvent.click(screen.getByRole("radio", { name: /Custom/ }));
    const input = document.getElementById("wallet-custom") as HTMLInputElement;
    expect(input.max).toBe("1000000");
    await fireEvent.input(input, { target: { value: "5000000" } });
    expect((await screen.findByTestId("buy-over-limit")).textContent).toContain("The most you can buy at once is 1,000,000 sats.");
    expect((screen.getByRole("button", { name: "Enter 100 to 1,000,000 sats" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("brings a Buy cSats request over the limit down to it", async () => {
    buyRequest.set({ amountSats: 5_000_000 });
    api.getWalletOverview.mockResolvedValue(overview());
    render(PlanUsage);
    expect((await screen.findByRole("button", { name: "Buy 1,000,000 cSats with Lightning" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a refusal in plain language, never the code", async () => {
    api.getWalletOverview.mockResolvedValue(overview());
    api.computeBuy.mockRejectedValue(new api.FsError("payments_disabled", "payments_disabled", 503));
    render(PlanUsage);
    const buy = await screen.findByRole("button", { name: "Buy 20,000 cSats with Lightning" });
    await waitFor(() => expect((buy as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(buy);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Buying cSats is turned off on this coordinator.");
    expect(alert.textContent).not.toContain("payments_disabled");
  });
});
