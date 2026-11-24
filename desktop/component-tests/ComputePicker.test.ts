import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";

const api = vi.hoisted(() => ({ getOllamaTags: vi.fn(), computeOverview: vi.fn(), listReservations: vi.fn(), getFrontierStatus: vi.fn() }));
vi.mock("../src/lib/api", () => api);

import ComputePicker from "../src/components/ComputePicker.svelte";

async function openPicker(props: Record<string, unknown> = {}) {
  const onSelect = vi.fn();
  render(ComputePicker, { selected: undefined, onSelect, ...props });
  const trigger = screen.getByRole("button", { name: /Auto/ });
  await fireEvent.click(trigger);
  const input = await screen.findByRole("combobox", { name: "Search models" });
  return { onSelect, trigger, input };
}

describe("ComputePicker (#24/#26 searchable model combobox)", () => {
  beforeEach(() => {
    api.getOllamaTags.mockResolvedValue({ models: [{ name: "qwen2.5-coder:7b" }, { name: "llama3.2:3b" }, { name: "nomic-embed-text" }] });
    api.computeOverview.mockResolvedValue({
      connected: true,
      models: [{ model: "deepseek-r1:32b", agents: 2, classes: ["gpu"], cSatsPerMTokens: { input: 3, output: 9 } }],
    });
    api.listReservations.mockResolvedValue({ reservations: [] });
    api.getFrontierStatus.mockResolvedValue({ models: [] });
  });

  it("offers frontier leads only for keys this account has, named with the key", async () => {
    api.getFrontierStatus.mockResolvedValue({ models: ["frontier/anthropic/claude-opus-5-5"] });
    const { onSelect } = await openPicker();
    const opt = await screen.findByRole("option", { name: /Lead: Claude Opus 5\.5 · your key/ });
    await fireEvent.click(opt);
    expect(onSelect).toHaveBeenCalledWith("frontier/anthropic/claude-opus-5-5");
  });

  it("opens a named popup with the search field focused and every choice as an option", async () => {
    const { input } = await openPicker();
    expect(screen.getByRole("dialog", { name: "Model and compute" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(input));
    // The field controls the listbox itself (axe treats the scrolling list as its popup).
    expect(input.getAttribute("aria-controls")).toBe(screen.getByRole("listbox", { name: "Compute" }).id);
    await waitFor(() => expect(screen.getByRole("option", { name: /llama3\.2:3b/ })).toBeTruthy());
    // Embedding models are not chat models.
    expect(screen.queryByRole("option", { name: /nomic/ })).toBeNull();
    // A network model offers one option per machine class, each named with the model.
    expect(screen.getByRole("option", { name: "deepseek-r1:32b, Any" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "deepseek-r1:32b, GPU" })).toBeTruthy();
    // The current choice (Auto on this computer) says so.
    expect(screen.getByRole("option", { name: /This computer only.*current choice/ })).toBeTruthy();
  });

  it("under a bot's Network <class> only card: only the models that class serves, network only", async () => {
    api.computeOverview.mockResolvedValue({
      connected: true,
      models: [
        { model: "deepseek-r1:32b", agents: 2, agentsByClass: { gpu: 2 }, classes: ["gpu"] },
        { model: "qwen2.5-coder:7b", agents: 9, agentsByClass: { cpu: 9 }, classes: ["cpu"] },
      ],
    });
    await openPicker({ networkModels: ["qwen2.5-coder:7b"], networkClass: "cpu", selected: "auto" });
    await waitFor(() => expect(screen.getByRole("option", { name: "qwen2.5-coder:7b, Any" })).toBeTruthy());
    expect(screen.queryByRole("option", { name: /deepseek/ })).toBeNull();
    // Nothing on this computer or your machines under a network-only card.
    expect(screen.queryByRole("option", { name: /llama3\.2:3b/ })).toBeNull();
  });

  it("the class chips say how many machines of that class have the model", async () => {
    api.computeOverview.mockResolvedValue({ connected: true, models: [{ model: "deepseek-r1:32b", agents: 3, agentsByClass: { gpu: 2, "gpu.dc": 1 }, classes: ["gpu", "gpu.dc"] }] });
    await openPicker();
    const chip = await screen.findByRole("option", { name: "deepseek-r1:32b, GPU" });
    expect(chip.getAttribute("title")).toMatch(/Only GPU machines \(2 online\)/);
  });

  it("filters as you type and Enter picks the first match", async () => {
    const { onSelect, input } = await openPicker();
    await waitFor(() => expect(screen.getByRole("option", { name: /llama3\.2:3b/ })).toBeTruthy());
    await fireEvent.input(input, { target: { value: "llama" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    const only = screen.getByRole("option", { name: /llama3\.2:3b/ });
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).toBe(only.id));
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("llama3.2:3b");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("moves through the choices with the arrow keys", async () => {
    const { onSelect, input } = await openPicker();
    await waitFor(() => expect(screen.getByRole("option", { name: /llama3\.2:3b/ })).toBeTruthy());
    const options = screen.getAllByRole("option");
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id));
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).toBe(options[2].id));
    await fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("qwen2.5-coder:7b");
  });

  it("says when nothing matches, and the footer opens a settings section", async () => {
    const onOpenSettings = vi.fn();
    const { input } = await openPicker({ onOpenSettings });
    await fireEvent.input(input, { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain('No models match "zzz"'));
    await fireEvent.click(screen.getByRole("button", { name: "Buy cSats" }));
    expect(onOpenSettings).toHaveBeenCalledWith("plan");
  });
});

describe("ComputePicker: this computer's models versus cloud models", () => {
  it("says the free local models are installed here, and lists cloud models only under Network", async () => {
    api.getOllamaTags.mockResolvedValue({ models: [{ name: "deepseek-r1:14b" }, { name: "gpt-oss:120b-cloud" }, { name: "glm-5.3" }] });
    api.computeOverview.mockResolvedValue({
      connected: true,
      selfAgentId: "me",
      account: { accountId: "a", machines: [
        { agentId: "cloud-host", online: true, computeClass: "cloud", models: ["deepseek-v4.1-flash", "glm-5.3"] },
        { agentId: "studio", online: true, computeClass: "apple", models: ["qwen3.5:9b", "glm-5.3"] },
      ] },
      models: [
        { model: "deepseek-v4.1-flash", agents: 1, classes: ["cloud"] },
        { model: "glm-5.3", agents: 1, classes: ["cloud"] },
      ],
    });
    await openPicker();
    await waitFor(() => expect(screen.getByRole("option", { name: /deepseek-r1:14b/ })).toBeTruthy());
    expect(screen.getByText(/installed on this (Mac|computer)/)).toBeTruthy();
    // An Ollama cloud tag runs on Ollama's servers: not "This computer · free".
    expect(screen.queryByRole("option", { name: /gpt-oss/ })).toBeNull();
    // EdgeCoder cloud models: Network rows only, never this computer or My machines (free).
    expect(screen.queryByRole("option", { name: /glm-5\.3$/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /deepseek-v4\.1-flash.*your machines/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /glm-5\.3.*your machines/ })).toBeNull();
    expect(screen.getByRole("option", { name: /qwen3\.5:9b.*your machines/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: "deepseek-v4.1-flash, Any" })).toBeTruthy();
  });
});
