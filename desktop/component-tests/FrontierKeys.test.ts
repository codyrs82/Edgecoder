import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";

const api = vi.hoisted(() => ({
  getFrontierStatus: vi.fn(),
  addFrontierKey: vi.fn(),
  testFrontierKey: vi.fn(),
  removeFrontierKey: vi.fn(),
  updateFrontierSettings: vi.fn(),
  getMe: vi.fn(),
}));
vi.mock("../src/lib/api", () => api);

import FrontierKeys from "../src/components/FrontierKeys.svelte";
import { choiceLabel, frontierFooter, usageText } from "../src/lib/compute-choice";
import { servedLine } from "../src/lib/served";

// A dummy key, built at runtime so the repo holds no key-shaped literal (secret scan).
const FAKE_OPENROUTER_KEY = ["sk", "or", "v1", "test".repeat(8)].join("-");

const KEY = "sk-ant-api03-FAKEKEY-abcdefghijklmnopqrstuvwxyz0123456789";
const status = (over: Record<string, unknown> = {}) => ({
  account: "acct-alice",
  storage: "macOS keychain",
  fallbackFile: false,
  providers: [] as unknown[],
  models: [] as string[],
  settings: { defaultLead: "frontier/anthropic/claude-opus-5-5", workerModel: "auto", sessionCapUsd: 5, dailyCapUsd: 25, useForAuto: false, effort: "high" },
  spend: { today: 0.42, last30Days: 3.1 },
  ...over,
});

describe("Settings → Frontier models (your keys)", () => {
  beforeEach(() => {
    api.getMe.mockResolvedValue({ email: "alice@example.com" });
    api.getFrontierStatus.mockResolvedValue(status());
  });

  it("says who may use the key and where calls go", async () => {
    render(FrontierKeys);
    expect(screen.getByRole("heading", { name: "Frontier models (your keys)" })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("frontier-account-rule").textContent).toContain("Usable only by your account (alice@example.com) on this computer. Never used for other people's requests or for network work."));
    expect(await screen.findByText("Your key stays on this computer. Calls go straight to Anthropic and are billed by them.")).toBeTruthy();
    await fireEvent.change(screen.getByRole("combobox", { name: "Provider" }), { target: { value: "openai" } });
    expect(await screen.findByText("Your key stays on this computer. Calls go straight to OpenAI and are billed by them.")).toBeTruthy();
    expect(screen.getByText(/Pooling, sharing or reselling keys isn't supported/)).toBeTruthy();
  });

  it("tests and saves a key, clears the field, and shows it as usable", async () => {
    api.addFrontierKey.mockResolvedValue({ provider: { id: "anthropic" }, models: ["claude-opus-5-5"] });
    render(FrontierKeys);
    const input = (await screen.findByLabelText("API key")) as HTMLInputElement;
    expect(input.type).toBe("password");
    await fireEvent.input(input, { target: { value: KEY } });
    api.getFrontierStatus.mockResolvedValue(
      status({ providers: [{ id: "anthropic", kind: "anthropic", accountId: "acct-alice", storage: "keychain", usable: true }], models: ["frontier/anthropic/claude-opus-5-5", "frontier/anthropic/claude-sonnet-5-5"] }),
    );
    await fireEvent.click(screen.getByRole("button", { name: "Test and save" }));
    await waitFor(() => expect(api.addFrontierKey).toHaveBeenCalledWith({ id: "anthropic", key: KEY }));
    expect(await screen.findByText(/Saved and tested\. 1 models available\./)).toBeTruthy();
    expect(input.value).toBe("");
    expect(await screen.findByText(/Key saved in your keychain · usable/)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("FAKEKEY");
    // The lead choices name the model and the key.
    expect(screen.getByRole("option", { name: "Lead: Claude Opus 5.5 · your key" })).toBeTruthy();
  });

  it("sends an OpenAI-compatible provider with its base URL", async () => {
    api.addFrontierKey.mockResolvedValue({ provider: { id: "openrouter" }, models: [] });
    render(FrontierKeys);
    await fireEvent.change(await screen.findByRole("combobox", { name: "Provider" }), { target: { value: "other" } });
    await fireEvent.input(screen.getByLabelText("Provider name"), { target: { value: "OpenRouter" } });
    await fireEvent.input(screen.getByLabelText("Base URL"), { target: { value: "https://openrouter.ai/api/v1" } });
    await fireEvent.input(screen.getByLabelText("API key"), { target: { value: FAKE_OPENROUTER_KEY } });
    await fireEvent.click(screen.getByRole("button", { name: "Test and save" }));
    await waitFor(() => expect(api.addFrontierKey).toHaveBeenCalledWith({ id: "openrouter", key: FAKE_OPENROUTER_KEY, kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1" }));
  });

  it("shows a failed test, tests a stored key, and removes another account's key as that account's", async () => {
    api.getFrontierStatus.mockResolvedValue(
      status({
        providers: [
          { id: "anthropic", kind: "anthropic", accountId: "acct-alice", storage: "keychain", usable: true },
          { id: "openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", accountId: "acct-bob", storage: "keychain", usable: false, reason: "Belongs to another account: it can be removed here, and used only when that account signs back in." },
        ],
      }),
    );
    api.testFrontierKey.mockResolvedValue({ models: ["claude-opus-5-5"] });
    api.removeFrontierKey.mockResolvedValue({ removed: true });
    api.addFrontierKey.mockRejectedValue(new Error("Anthropic rejected your API key (HTTP 401)."));
    render(FrontierKeys);
    expect(await screen.findByText(/Belongs to another account/)).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("Works: claude-opus-5-5")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Remove the OpenAI key (another account)" }));
    await waitFor(() => expect(api.removeFrontierKey).toHaveBeenCalledWith("openai", "acct-bob"));
    await fireEvent.input(screen.getByLabelText("API key"), { target: { value: KEY } });
    await fireEvent.click(screen.getByRole("button", { name: "Test and save" }));
    expect(await screen.findByText("Anthropic rejected your API key (HTTP 401).")).toBeTruthy();
  });

  it("saves the lead, worker, caps and the Auto opt-in", async () => {
    api.updateFrontierSettings.mockImplementation(async (p) => ({ settings: { ...status().settings, ...p } }));
    render(FrontierKeys);
    const session = (await screen.findByLabelText("Session cap (USD)")) as HTMLInputElement;
    await fireEvent.input(session, { target: { value: "2" } });
    await fireEvent.input(screen.getByLabelText("Daily cap (USD)"), { target: { value: "" } });
    await fireEvent.input(screen.getByLabelText("Worker model"), { target: { value: "network/qwen3-coder:30b" } });
    const auto = screen.getByLabelText("Use my frontier key for Auto") as HTMLInputElement;
    expect(auto.checked).toBe(false);
    await fireEvent.click(auto);
    await fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(api.updateFrontierSettings).toHaveBeenCalledWith({ defaultLead: "frontier/anthropic/claude-opus-5-5", workerModel: "network/qwen3-coder:30b", sessionCapUsd: 2, dailyCapUsd: null, useForAuto: true }),
    );
    expect(await screen.findByText("Saved")).toBeTruthy();
  });

  it("asks to sign in only when the account check says signed out", async () => {
    api.getFrontierStatus.mockResolvedValue(status({ account: null, accountState: "signed_out" }));
    api.getMe.mockRejectedValue(new Error("Not authenticated"));
    render(FrontierKeys);
    expect(await screen.findByText(/Sign in to EdgeCoder on this computer to add or use keys/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Test and save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows no sign-in error while the account is still loading", async () => {
    api.getFrontierStatus.mockReturnValue(new Promise(() => {}));
    render(FrontierKeys);
    expect(await screen.findByText("Checking your account…")).toBeTruthy();
    expect(screen.queryByText(/Sign in to EdgeCoder/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("treats an account the provider couldn't check yet as checking, then shows the key form once it's known", async () => {
    api.getFrontierStatus.mockResolvedValueOnce(status({ account: null, accountState: "unknown" })).mockResolvedValue(status());
    render(FrontierKeys);
    expect(await screen.findByTestId("frontier-account-checking")).toBeTruthy();
    expect(screen.queryByText(/Sign in to EdgeCoder/)).toBeNull();
    expect((screen.getByRole("button", { name: "Test and save" }) as HTMLButtonElement).disabled).toBe(true);
    // Re-checked shortly: now signed in, the form is usable.
    await waitFor(() => expect(screen.queryByTestId("frontier-account-checking")).toBeNull(), { timeout: 4000 });
    await fireEvent.input(screen.getByLabelText("API key"), { target: { value: KEY } });
    expect((screen.getByRole("button", { name: "Test and save" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/Sign in to EdgeCoder/)).toBeNull();
  });

  it("an older provider's null account while the app is signed in is checking, not signed out", async () => {
    api.getFrontierStatus.mockResolvedValue(status({ account: null }));
    render(FrontierKeys);
    expect(await screen.findByTestId("frontier-account-checking")).toBeTruthy();
    expect(screen.queryByText(/Sign in to EdgeCoder/)).toBeNull();
  });

  it("after a few unanswered checks, offers a neutral retry instead of 'sign in'", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.getFrontierStatus.mockResolvedValue(status({ account: null, accountState: "unknown" }));
      render(FrontierKeys);
      expect(await screen.findByTestId("frontier-account-checking")).toBeTruthy();
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2_100);
      expect(await screen.findByTestId("frontier-account-unknown")).toBeTruthy();
      expect(screen.queryByText(/Sign in to EdgeCoder/)).toBeNull();
      api.getFrontierStatus.mockResolvedValue(status());
      await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(screen.queryByTestId("frontier-account-unknown")).toBeNull());
      expect(screen.getByLabelText("API key")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed status request is a neutral, retryable message", async () => {
    api.getFrontierStatus.mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValue(status());
    render(FrontierKeys);
    expect((await screen.findByTestId("frontier-load-error")).textContent).toContain("Couldn't load your keys right now");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Sign in to EdgeCoder/)).toBeNull();
    await fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("API key")).toBeTruthy();
  });
});

describe("frontier labels in the picker and footers", () => {
  it("names the lead and the key, and shows spend in dollars", () => {
    expect(choiceLabel("frontier/anthropic/claude-opus-5-5")).toEqual({ model: "Lead: Claude Opus 5.5", where: "your key" });
    expect(frontierFooter("frontier/anthropic/claude-opus-5-5", 0.42)).toBe("Claude Opus 5.5 · your key · $0.42 this session");
    expect(usageText({ cSats: 0, where: "Claude Opus 5.5 · your key", usd: 0.0731 })).toBe("Claude Opus 5.5 · your key · $0.07");
    // The served line under a reply: provider · model · your key · tokens · $cost (no cSats).
    const served = { label: "Anthropic (your key)", own: true, computeClass: "frontier", tier: null, hardware: "Anthropic · your key", region: null, country: null, promptTokens: 24_800, outputTokens: 312, genMs: 6_500, usd: 0.42 };
    expect(servedLine([{ cSats: 0, model: "frontier/anthropic/claude-opus-5-5", served }])).toBe("Anthropic · claude-opus-5-5 · your key · read 24.8k tok · wrote 312 tok in 6.5 s · $0.42");
  });
});
