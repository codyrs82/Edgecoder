// Offline mode (lib/connectivity.ts): a calm app-wide bar, "Available when you're back online"
// in place of network pages' data (no red errors), network-only bots say "Offline", and the page
// reloads by itself on reconnect.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/svelte";
import { WORLD } from "../a11y/world-fixture";

const api = vi.hoisted(() => ({
  networkWorld: vi.fn(),
  isRemoteMode: vi.fn(() => false),
  readServiceLog: vi.fn(async () => ""),
  botMessages: vi.fn(async () => []),
  botHistory: vi.fn(async () => []),
  updateBot: vi.fn(),
  runBot: vi.fn(),
  deleteBot: vi.fn(),
  cancelBotRun: vi.fn(),
  sendBotMessage: vi.fn(),
  approveBotCall: vi.fn(),
  getBot: vi.fn(),
  syncBotRepository: vi.fn(),
  botErrorText: (e: unknown) => String(e),
}));
vi.mock("../src/lib/api", () => ({ ...api, backendReady: Promise.resolve() }));
vi.mock("../src/lib/bots-store", () => ({ refreshBots: vi.fn().mockResolvedValue([]) }));
Element.prototype.scrollTo ??= function () {};

import OfflineBar from "../src/components/OfflineBar.svelte";
import MeshTopology from "../src/pages/MeshTopology.svelte";
import BotView from "../src/pages/BotView.svelte";
import { OFFLINE_TEXT, setConnectivityForTests, stopConnectivityMonitor } from "../src/lib/connectivity";
import type { Bot } from "../src/lib/bots";

const bot = (over: Partial<Bot> = {}): Bot => ({
  id: "bot_n", name: "Nina", role: "Researcher", instructions: "", projectRoot: "/tmp/nina", enabled: true, schedule: "every 30 minutes",
  budgetCSatsPerDay: 100, allowedTools: [], autoApproveEdits: true, compute: { policy: "network_only" }, color: "#0090ff",
  createdAtMs: 0, updatedAtMs: 0, status: "error", spentTodayCSats: 0, pending: [], queuedMessages: 0, ...over,
}) as Bot;

beforeEach(() => {
  api.networkWorld.mockReset();
  api.networkWorld.mockResolvedValue(structuredClone(WORLD));
});
afterEach(() => {
  cleanup();
  stopConnectivityMonitor();
});

describe("offline bar", () => {
  it("shows the calm offline line while offline and goes away when back online", async () => {
    setConnectivityForTests("offline");
    render(OfflineBar);
    const bar = screen.getByTestId("offline-bar");
    expect(bar.textContent).toContain(OFFLINE_TEXT);
    expect(bar.getAttribute("role")).toBe("status");
    setConnectivityForTests("online");
    await waitFor(() => expect(screen.queryByTestId("offline-bar")).toBeNull());
  });
});

describe("Network page offline", () => {
  it("shows 'Available when you're back online' instead of an error, then loads on reconnect", async () => {
    setConnectivityForTests("offline");
    api.networkWorld.mockRejectedValue(new TypeError("Load failed"));
    render(MeshTopology, { props: { pollInterval: 60_000 } });
    expect(await screen.findByText("Available when you're back online")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector(".error-banner")).toBeNull();
    api.networkWorld.mockResolvedValue(structuredClone(WORLD));
    setConnectivityForTests("online");
    expect(await screen.findByRole("region", { name: /network summary/i })).toBeTruthy();
    expect(screen.queryByTestId("offline-placeholder")).toBeNull();
  });
});

describe("bot status offline", () => {
  it("a network-only bot says Offline, not Failed, while offline", async () => {
    setConnectivityForTests("offline");
    render(BotView, { bot: bot(), onEdit: vi.fn(), onDeleted: vi.fn(), onOpenSettings: vi.fn() });
    expect(screen.getByTestId("bot-status-chip").textContent).toBe("Offline");
  });
  it("a This-computer-only bot keeps its own status offline", async () => {
    setConnectivityForTests("offline");
    render(BotView, { bot: bot({ compute: { policy: "local_only" }, status: "idle" }), onEdit: vi.fn(), onDeleted: vi.fn(), onOpenSettings: vi.fn() });
    expect(screen.getByTestId("bot-status-chip").textContent).not.toBe("Offline");
  });
  it("online, a failed network bot still says Failed", async () => {
    setConnectivityForTests("online");
    render(BotView, { bot: bot(), onEdit: vi.fn(), onDeleted: vi.fn(), onOpenSettings: vi.fn() });
    expect(screen.getByTestId("bot-status-chip").textContent).toBe("Failed");
  });
});
