import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";

const api = vi.hoisted(() => ({ computeOverview: vi.fn(), portalWebUrl: (p: string) => p }));
vi.mock("../src/lib/api", () => api);
vi.mock("../src/lib/updater", () => ({ onUpdateStatus: () => () => undefined, downloadAndInstall: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

import ProfileMenu from "../src/components/ProfileMenu.svelte";
import { get } from "svelte/store";
import { balanceState, openWalletRequest } from "../src/lib/buy-csats";

afterEach(() => cleanup());
const user = { id: "u", email: "cody@example.com", displayName: "Cody" } as never;

describe("ProfileMenu: the balance", () => {
  it("a low balance gets a small Buy link, and the shared balance state follows", async () => {
    api.computeOverview.mockResolvedValue({ connected: true, account: { cSats: 0.01 }, models: [] });
    render(ProfileMenu, { user, onOpenSettings: vi.fn(), onLogout: vi.fn() });
    const buy = await screen.findByTestId("balance-buy");
    expect(screen.getByText("0.01 cSats")).toBeTruthy();
    expect(get(balanceState)).toEqual({ cSats: 0.01, low: true });
    const before = get(openWalletRequest);
    await fireEvent.click(buy);
    expect(get(openWalletRequest)).toBe(before + 1);
  });

  it("no Buy link when the balance is fine", async () => {
    api.computeOverview.mockResolvedValue({ connected: true, account: { cSats: 5_000 }, models: [] });
    render(ProfileMenu, { user, onOpenSettings: vi.fn(), onLogout: vi.fn() });
    await waitFor(() => expect(screen.getByText("5,000 cSats")).toBeTruthy());
    expect(screen.queryByTestId("balance-buy")).toBeNull();
  });
});
