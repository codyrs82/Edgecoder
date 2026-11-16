import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import axe from "axe-core";

const api = vi.hoisted(() => ({
  getOnboarding: vi.fn(),
  saveOnboarding: vi.fn(),
  computeOverview: vi.fn(),
  getCliStatus: vi.fn(),
  getModelPullProgress: vi.fn(),
  getOllamaTags: vi.fn(),
  getOnchainDeposits: vi.fn(),
  getSystemMetrics: vi.fn(),
  getWalletOverview: vi.fn(),
  installCliTool: vi.fn(),
  pullModel: vi.fn(),
  portalWebUrl: (p = "") => `https://edgecoder.io${p}`,
}));
vi.mock("../src/lib/api", () => api);
const shell = vi.hoisted(() => ({ open: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-shell", () => shell);

import OnboardingWizard from "../src/components/OnboardingWizard.svelte";
import GettingStarted from "../src/pages/GettingStarted.svelte";
import { emptyOnboardingState, type OnboardingSignals, type OnboardingState } from "../src/lib/onboarding";

const SIGNALS: OnboardingSignals = {
  machines: 1, machinesOnline: 1, balanceCSats: 0, apiKeys: 0, github: false, firstTask: false,
  hostApproved: false, hostRequested: false, newAccount: true, localModels: null, cliInstalled: null,
};
const saved = (over: Partial<OnboardingState> = {}): OnboardingState => ({ ...emptyOnboardingState(1), firstSeenAtMs: 1, ...over });
let current: OnboardingState | null = null;

function props(over: Record<string, unknown> = {}) {
  return { onClose: vi.fn(), onOpenSettings: vi.fn(), onRun: vi.fn(), ...over };
}
const heading = () => screen.getByRole("heading", { level: 2 });

describe("Getting started (desktop wizard)", () => {
  beforeEach(() => {
    current = null;
    api.getOnboarding.mockImplementation(async () => ({ state: current, signals: SIGNALS, show: true }));
    api.saveOnboarding.mockImplementation(async (patch: Record<string, unknown>) => {
      const base = current ?? saved({ firstSeenAtMs: 2 });
      current = { ...base, ...patch } as OnboardingState;
      return { state: current, signals: SIGNALS, show: true };
    });
    api.getOllamaTags.mockResolvedValue({ models: [{ name: "qwen3.5:9b" }, { name: "nomic-embed-text" }] });
    api.getCliStatus.mockResolvedValue({ installed: false });
    api.getSystemMetrics.mockResolvedValue({ memory_total_mb: 16384 });
    api.computeOverview.mockResolvedValue({ connected: true, selfAgentId: "a1", account: { machines: [{ agentId: "a1", computeClass: "apple" }] }, models: [{ model: "qwen3-coder:30b", cSatsPerMTokens: { input: 322.7, output: 939.8 } }] });
    api.getWalletOverview.mockResolvedValue({ btcUsd: 176600 });
    api.getOnchainDeposits.mockResolvedValue({ enabled: false });
  });

  it("first sign-in: opens on Welcome, focuses the step heading, and has a route, a video anchor and a hidden video slot", async () => {
    render(OnboardingWizard, props());
    await waitFor(() => expect(heading().textContent).toBe("Welcome to EdgeCoder"));
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    expect(screen.getByText("Step 1 of 10")).toBeTruthy();
    const panel = document.querySelector("[data-video-anchor='welcome-welcome']")!;
    expect(panel).toBeTruthy();
    expect((panel.querySelector("[data-video-slot='welcome']") as HTMLElement).hidden).toBe(true);
    await waitFor(() => expect(location.hash).toBe("#/welcome/welcome"));
    expect(screen.getByRole("status").textContent).toContain("Step 1 of 10: Welcome to EdgeCoder");
    // Opening marks it seen (and un-dismisses it).
    await waitFor(() => expect(api.saveOnboarding).toHaveBeenCalledWith({ current: "welcome", dismissed: false }));
  });

  it("resumes at the saved step", async () => {
    current = saved({ goal: "both", current: "fund", done: ["welcome", "how"] });
    render(OnboardingWizard, props());
    await waitFor(() => expect(heading().textContent).toBe("Fund your account"));
    expect(screen.getByText("Step 6 of 10")).toBeTruthy();
    // The estimator from live prices; Bitcoin is coming soon.
    await waitFor(() => expect(screen.getByTestId("wz-estimate").textContent).toMatch(/About \d[\d,]* cSats a day/));
    expect(screen.getByText("Coming soon")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Fund with Bitcoin" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent?.toLowerCase()).not.toContain("invoice");
  });

  it("the goal tailors the steps; Next saves progress and moves on", async () => {
    render(OnboardingWizard, props());
    await waitFor(() => expect(heading().textContent).toBe("Welcome to EdgeCoder"));
    await fireEvent.click(screen.getByLabelText(/Buy network compute/));
    expect(api.saveOnboarding).toHaveBeenCalledWith({ goal: "buy" });
    expect(screen.getByText("Step 1 of 9")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add your other machines/ })).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(heading().textContent).toBe("How EdgeCoder works"));
    expect(api.saveOnboarding).toHaveBeenCalledWith({ done: ["welcome"], skipped: [] });
    expect(location.hash).toBe("#/welcome/how");
  });

  it("detects this computer's models and the account's machine; suggests a model by memory and downloads it with progress", async () => {
    current = saved({ current: "this-machine" });
    api.pullModel.mockResolvedValue({});
    api.getModelPullProgress.mockResolvedValueOnce({ model: "qwen3.5:9b", status: "pulling", progressPct: 40 }).mockResolvedValue({ model: "qwen3.5:9b", status: "success", progressPct: 100 });
    render(OnboardingWizard, props());
    await waitFor(() => expect(heading().textContent).toBe("Set up this computer"));
    await waitFor(() => expect(document.querySelector("[data-item='local-model']")!.textContent).toContain("Done"));
    expect(document.querySelector("[data-item='machine-linked']")!.textContent).toContain("Done");
    await waitFor(() => expect(screen.getByText("Suggested for this computer: Qwen3.5 9B (6.6 GB)")).toBeTruthy());
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await fireEvent.click(screen.getByRole("button", { name: "Download qwen3.5:9b" }));
      expect(api.pullModel).toHaveBeenCalledWith("qwen3.5:9b");
      await vi.advanceTimersByTimeAsync(2500);
      await waitFor(() => expect(screen.getByText("qwen3.5:9b is ready.")).toBeTruthy());
    } finally {
      vi.useRealTimers();
    }
  });

  it("Skip records the step as skipped and moves on", async () => {
    current = saved({ current: "fund", goal: "own" });
    render(OnboardingWizard, props());
    await waitFor(() => expect(heading().textContent).toBe("Fund your account"));
    expect(screen.getByText("You chose your own machines: they're free, so you can skip this.")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Skip: I'll use my own machines" }));
    expect(api.saveOnboarding).toHaveBeenCalledWith({ skipped: ["fund"] });
    await waitFor(() => expect(heading().textContent).toBe("Connect your tools"));
  });

  it("Close guide dismisses it on the account", async () => {
    const p = props();
    render(OnboardingWizard, p);
    await waitFor(() => expect(heading().textContent).toBe("Welcome to EdgeCoder"));
    await fireEvent.click(screen.getByRole("button", { name: "Close guide" }));
    await waitFor(() => expect(p.onClose).toHaveBeenCalled());
    expect(api.saveOnboarding).toHaveBeenCalledWith({ dismissed: true });
  });

  it("deep links: a Settings section, an app action, and a web page", async () => {
    current = saved({ current: "fund" });
    const p = props();
    render(OnboardingWizard, p);
    await waitFor(() => expect(heading().textContent).toBe("Fund your account"));
    await fireEvent.click(screen.getByRole("button", { name: "Buy cSats" }));
    expect(p.onClose).toHaveBeenCalled();
    expect(p.onOpenSettings).toHaveBeenCalledWith("plan");

    const q = props();
    current = saved({ current: "try" });
    render(OnboardingWizard, q);
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 2 }).some((h) => h.textContent === "Try it")).toBe(true));
    await fireEvent.click(screen.getByRole("button", { name: "Ask in Chat" }));
    expect(q.onRun).toHaveBeenCalledWith("try-chat");
  });

  it("opens the web for steps that live there (host request)", async () => {
    current = saved({ current: "host" });
    render(OnboardingWizard, props());
    await waitFor(() => expect(heading().textContent).toBe("Host for the network"));
    await fireEvent.click(screen.getByRole("button", { name: "Request to host" }));
    expect(shell.open).toHaveBeenCalledWith("https://edgecoder.io/host");
  });

  it("finishing marks it complete", async () => {
    current = saved({ current: "done" });
    const p = props();
    render(OnboardingWizard, p);
    await waitFor(() => expect(heading().textContent).toBe("You're set"));
    await fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(p.onClose).toHaveBeenCalled());
    expect(api.saveOnboarding).toHaveBeenCalledWith(expect.objectContaining({ completed: true }));
  });

  it("opens on the step a route names", async () => {
    current = saved({ current: "fund" });
    render(OnboardingWizard, props({ initialStep: "tools" }));
    await waitFor(() => expect(heading().textContent).toBe("Connect your tools"));
    expect(screen.getByText(/localhost:4304\/v1/)).toBeTruthy();
  });

  it("is keyboard reachable and passes axe", async () => {
    current = saved({ current: "models", goal: "both" });
    const { container } = render(OnboardingWizard, props());
    await waitFor(() => expect(heading().textContent).toBe("Choose models and where they run"));
    expect(screen.getByRole("radio", { name: /Auto.*Recommended/ })).toBeTruthy();
    expect((screen.getByRole("radio", { name: /^Auto/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("navigation", { name: "Getting started steps" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Choose models and where they run/ }).getAttribute("aria-current")).toBe("step");
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
    expect(container).toBeTruthy();
  });

  it("Settings → Getting started shows progress and reopens the guide", async () => {
    current = saved({ goal: "both", done: ["welcome", "how"], dismissed: true });
    const onOpenGuide = vi.fn();
    render(GettingStarted, { onOpenGuide });
    await waitFor(() => expect(screen.getByText(/of 10 steps done/)).toBeTruthy());
    expect(screen.getByText("Closed. Open it to carry on where you left off.")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Open the guide" }));
    expect(onOpenGuide).toHaveBeenCalled();
  });
});
