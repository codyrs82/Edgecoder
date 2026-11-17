import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";

const api = vi.hoisted(() => ({
  createBot: vi.fn(),
  updateBot: vi.fn(),
  getBot: vi.fn(),
  botErrorText: (e: unknown) => (e as Error).message,
  getOllamaTags: vi.fn().mockResolvedValue({ models: [] }),
  computeOverview: vi.fn().mockResolvedValue(null),
  listReservations: vi.fn().mockResolvedValue({ reservations: [] }),
  getFrontierStatus: vi.fn().mockResolvedValue({ models: [] }),
}));
vi.mock("../src/lib/api", () => api);

import BotForm from "../src/components/BotForm.svelte";
import type { Bot } from "../src/lib/bots";

const harry = (over: Partial<Bot> = {}): Bot => ({
  id: "bot_h",
  name: "Harry",
  role: "Engineer",
  instructions: "",
  projectRoot: "/Users/me/Agents/Harry",
  enabled: true,
  schedule: "",
  budgetCSatsPerDay: 100,
  allowedTools: [],
  autoApproveEdits: true,
  compute: { policy: "auto" },
  color: "#0090ff",
  createdAtMs: 0,
  updatedAtMs: 0,
  status: "idle",
  spentTodayCSats: 0,
  pending: [],
  queuedMessages: 0,
  ...over,
} as Bot);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function open(bot: Bot) {
  api.getBot.mockResolvedValue({ bot, memory: "" });
  const onSaved = vi.fn();
  render(BotForm, { bot, onClose: vi.fn(), onSaved });
  return onSaved;
}

describe("BotForm: Network only cards", () => {
  it("shows Network only and the per-class cards with their descriptions", () => {
    open(harry());
    for (const t of ["Network only", "Network GPU only", "Network Apple only", "Network CPU only", "Network Datacenter GPU only", "Local first", "My machines only"]) {
      expect(screen.getByRole("radio", { name: new RegExp(`^${t}`) })).toBeTruthy();
    }
    expect(screen.getByText(/The network's GPU machines only, within the daily budget/)).toBeTruthy();
  });

  it("saves Network GPU only as network_only with the class, best fit by default", async () => {
    const onSaved = open(harry());
    api.updateBot.mockImplementation(async (_id: string, patch: Partial<Bot>) => harry(patch));
    await fireEvent.click(screen.getByRole("radio", { name: /^Network GPU only/ }));
    expect(screen.getByText(/never falls back to this computer or your machines/)).toBeTruthy();
    expect(screen.getByText(/Best fit: the network picks the model/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.updateBot.mock.calls[0][1].compute).toEqual({ policy: "network_only", computeClass: "gpu" });
  });

  it("opens a saved Network Apple only bot on its card, keeping its model", async () => {
    const onSaved = open(harry({ compute: { policy: "network_only", computeClass: "apple", model: "network/qwen3-coder:30b" } }));
    api.updateBot.mockImplementation(async (_id: string, patch: Partial<Bot>) => harry(patch));
    expect((screen.getByRole("radio", { name: /^Network Apple only/ }) as HTMLInputElement).checked).toBe(true);
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.updateBot.mock.calls[0][1].compute).toEqual({ policy: "network_only", computeClass: "apple", model: "network/qwen3-coder:30b" });
  });

  it("shows the server's message when a save is refused", async () => {
    open(harry());
    api.updateBot.mockRejectedValue(new Error("compute.model: Required"));
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("compute.model: Required");
  });
});
