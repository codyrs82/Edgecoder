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
    expect(screen.getByText(/Any GPU on the network, consumer or datacenter, within the daily budget/)).toBeTruthy();
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

/** The network on the day of the report: one A100 (gpu.dc), two Macs, nine CPU machines, no consumer GPU. */
const network = (over: Record<string, number> = {}) => {
  const n = { cpu: 9, apple: 2, gpu: 0, "gpu.dc": 1, ...over };
  return {
    connected: true,
    classes: Object.fromEntries(Object.entries(n).map(([c, agents]) => [c, { label: c, cSatsPerSecondBaseTier: 1, agents }])),
    models: [
      ...(n["gpu.dc"] || n.apple ? [{ model: "qwen3-coder:30b", agents: n["gpu.dc"] + n.apple, agentsByClass: { "gpu.dc": n["gpu.dc"], apple: n.apple }, classes: [...(n["gpu.dc"] ? ["gpu.dc"] : []), ...(n.apple ? ["apple"] : [])] }] : []),
      ...(n.cpu ? [{ model: "qwen2.5-coder:7b", agents: n.cpu, agentsByClass: { cpu: n.cpu }, classes: ["cpu"] }] : []),
    ],
  };
};
const card = (name: string) => screen.getByRole("radio", { name: new RegExp(`^${name}`) }) as HTMLInputElement;
const cardLabel = (name: string) => card(name).closest("label") as HTMLElement;

describe("BotForm: what the network has now", () => {
  it("each network card says how many machines are online and what they serve", async () => {
    api.computeOverview.mockResolvedValue(network());
    open(harry());
    await waitFor(() => expect(cardLabel("Network CPU only").textContent).toMatch(/9 online · qwen2\.5-coder:7b/));
    expect(cardLabel("Network Apple only").textContent).toMatch(/2 online · qwen3-coder:30b/);
    // GPU is any GPU: the A100 counts.
    expect(cardLabel("Network GPU only").textContent).toMatch(/1 online · qwen3-coder:30b/);
    expect(cardLabel("Network Datacenter GPU only").textContent).toMatch(/1 online/);
    expect(cardLabel("Network only").textContent).toMatch(/12 online/);
    expect(card("Network GPU only").disabled).toBe(false);
    // The other cards have no availability line.
    expect(cardLabel("Local first").textContent).not.toMatch(/online/);
  });

  it("a class with no machines can't be picked, and says why", async () => {
    api.computeOverview.mockResolvedValue(network({ "gpu.dc": 0 }));
    open(harry());
    await waitFor(() => expect(card("Network GPU only").disabled).toBe(true));
    const gpu = cardLabel("Network GPU only");
    expect(gpu.getAttribute("aria-disabled")).toBe("true");
    expect(gpu.getAttribute("title")).toBe("No GPU machines on the network right now");
    expect(gpu.textContent).toMatch(/None online/);
    expect(card("Network Datacenter GPU only").disabled).toBe(true);
    expect(card("Network CPU only").disabled).toBe(false);
  });

  it("a saved choice whose class is empty now stays selected, with a warning, and saves unchanged", async () => {
    api.computeOverview.mockResolvedValue(network({ "gpu.dc": 0 }));
    const onSaved = open(harry({ compute: { policy: "network_only", computeClass: "gpu.dc" } }));
    api.updateBot.mockImplementation(async (_id: string, patch: Partial<Bot>) => harry(patch));
    const warn = await screen.findByTestId("compute-unavailable-warning");
    expect(warn.textContent).toBe("No Datacenter GPU machines online: runs will fail until one is back. Choose another option.");
    expect(card("Network Datacenter GPU only").checked).toBe(true);
    expect(card("Network Datacenter GPU only").disabled).toBe(false);
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(api.updateBot.mock.calls[0][1].compute).toEqual({ policy: "network_only", computeClass: "gpu.dc" });
  });

  it("with a model chosen, availability is machines of that class serving that model", async () => {
    api.computeOverview.mockResolvedValue(network());
    open(harry({ compute: { policy: "network_only", computeClass: "apple", model: "network/qwen3-coder:30b" } }));
    await waitFor(() => expect(cardLabel("Network Apple only").textContent).toMatch(/2 online · qwen3-coder:30b/));
    // No CPU machine has qwen3-coder:30b.
    expect(card("Network CPU only").disabled).toBe(true);
    expect(cardLabel("Network CPU only").getAttribute("title")).toBe("No CPU machines with qwen3-coder:30b on the network right now");
  });

  it("offline or not signed in: nothing is disabled, and each says Availability unknown", async () => {
    api.computeOverview.mockResolvedValue({ connected: false, reason: "not_enrolled" });
    open(harry());
    await waitFor(() => expect(cardLabel("Network GPU only").textContent).toMatch(/Availability unknown/));
    for (const n of ["Network only", "Network GPU only", "Network Apple only", "Network CPU only", "Network Datacenter GPU only"]) expect(card(n).disabled).toBe(false);
    expect(screen.queryByTestId("compute-unavailable-warning")).toBeNull();
    api.computeOverview.mockRejectedValue(new Error("offline"));
    cleanup();
    open(harry());
    await waitFor(() => expect(cardLabel("Network CPU only").textContent).toMatch(/Availability unknown/));
    expect(card("Network CPU only").disabled).toBe(false);
  });
});

describe("BotForm: the project folder", () => {
  it("says the project folder isn't set when there's no repository, and where it is when there is", async () => {
    open(harry({ projectRoot: "/Users/me/Dropbox/Agents/Harry the Engineer" }));
    const line = screen.getByTestId("bot-project-folder");
    expect(line.textContent).toMatch(/^Project folder: not set\./);
    await fireEvent.input(screen.getByLabelText("Repository"), { target: { value: "codyrs82/Edgecoder" } });
    expect(line.textContent).toBe("Project folder: cloned when you save");
    cleanup();
    open(harry({ repository: "codyrs82/Edgecoder", repoPath: "/Users/me/Projects/Edgecoder" }));
    expect(screen.getByTestId("bot-project-folder").textContent).toBe("Project folder: /Users/me/Projects/Edgecoder");
  });
});
