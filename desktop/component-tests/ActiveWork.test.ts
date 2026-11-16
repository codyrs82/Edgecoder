import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/svelte";
import type { ActivitySnapshot, AgentActivity } from "../src/lib/api";

const api = vi.hoisted(() => ({
  getActivity: vi.fn(),
  isRemoteMode: vi.fn(() => false),
  computeErrorText: (e: unknown) => (e as Error).message,
}));
vi.mock("../src/lib/api", () => ({ ...api, backendReady: Promise.resolve() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

import ActiveWork from "../src/pages/ActiveWork.svelte";

const NOW = 1_800_000_000_000;
const AGENT: AgentActivity = {
  reachable: true, agentId: "desktop-mac-1", coordinatorUrl: "https://coordinator.edgecoder.io", registered: true, region: "us-east",
  paused: null, draining: false, claims: 1, slots: { total: 2, busy: 2 }, computeClass: "apple", tier: "apple.m", jobsUnknown: false,
  jobs: [
    { id: "s1", kind: "inference", model: "qwen2.5-coder:7b", startedAtMs: NOW - 65_000, elapsedMs: 65_000, outputTokens: 1_250, requester: "network" },
    { id: "s2", kind: "inference", model: "llama3.2:3b", startedAtMs: NOW - 4_000, elapsedMs: 4_000, outputTokens: 30, requester: "you" },
  ],
};
const SNAP: ActivitySnapshot = {
  atMs: NOW,
  agent: AGENT,
  mine: [
    { id: "a1", kind: "code", title: "Add a footer", source: "Code", model: "auto", startedAtMs: NOW - 9_000, status: "running", cSats: 0.5, steps: [], progress: "Editing src/app.ts",
      calls: [{ cSats: 0.5, model: "network/qwen3:32b", served: { label: "m-7", own: false, computeClass: "gpu", tier: "24gb", hardware: "GPU", region: "eu-west", country: "DE" } }] },
    { id: "a2", kind: "bot", title: "Harry: schedule run", source: "Harry", startedAtMs: NOW - 2_000, status: "running", cSats: 0, steps: [], progress: "Waiting for your approval", calls: [] },
  ],
};

beforeEach(() => {
  api.getActivity.mockReset();
  api.isRemoteMode.mockReturnValue(false);
});
afterEach(() => cleanup());

describe("Active work", () => {
  it("shows the jobs this Mac serves (never who asked, only you or someone), its slots and your requests", async () => {
    api.getActivity.mockResolvedValue(SNAP);
    render(ActiveWork, { pollMs: 60_000 });
    await screen.findByText("Someone on the network");
    expect(screen.getByText("Connected to coordinator.edgecoder.io · us-east")).toBeTruthy();
    expect(screen.getByText(/2 of 2 slots in use · 0 free/)).toBeTruthy();
    const serving = screen.getAllByRole("table")[0];
    expect(within(serving).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["For", "Model", "Kind", "Started", "Elapsed", "Tokens so far"]);
    expect(within(serving).getByText("You")).toBeTruthy();
    expect(within(serving).getByText("1 min 05 s")).toBeTruthy();
    expect(within(serving).getByText("≈1.3k")).toBeTruthy();
    expect(serving.textContent).not.toContain("desktop-mac-1");
    const mine = screen.getAllByRole("table")[1];
    expect(within(mine).getByText("Add a footer")).toBeTruthy();
    expect(within(mine).getByText(/eu-west/)).toBeTruthy();
    expect(within(mine).getByText("Waiting for your approval")).toBeTruthy();
    expect(document.querySelector("[aria-live=polite]")?.textContent).toBe("2 network jobs on this computer, 2 of your requests running.");
  });

  it("empty states say what would appear", async () => {
    api.getActivity.mockResolvedValue({ atMs: NOW, agent: { ...AGENT, jobs: [] }, mine: [] });
    render(ActiveWork, { pollMs: 60_000 });
    await screen.findByText("No network jobs right now.");
    expect(screen.getByText(/When This (Mac|computer) serves a job, it shows here/)).toBeTruthy();
    expect(screen.getByText("Nothing of yours is running.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("a paused agent: the network's reason and a way to ask for a review", async () => {
    api.getActivity.mockResolvedValue({ atMs: NOW, agent: { ...AGENT, jobs: [], paused: { reason: "Auto-blacklisted by behavioral monitoring: Max heartbeat gap 495s", sinceMs: NOW - 1000 } }, mine: [] });
    render(ActiveWork, { pollMs: 60_000 });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/was paused by the network's safety check/);
    expect(alert.textContent).toContain("Max heartbeat gap 495s");
    expect(screen.getByText("Paused by the network")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request review" })).toBeTruthy();
  });

  it("the host memory guard: paused for memory, and the models served and loaded", async () => {
    const memory = { pressure: "warning" as const, paused: true, pausedReason: "memory_pressure", totalBytes: 48 * 1024 ** 3, budgetBytes: 28 * 1024 ** 3, usedBytes: 9 * 1024 ** 3, loadedModels: ["qwen3.5:9b", "llama3.2:3b"], servingModels: ["qwen3.5:9b"], localOnlyModels: [], tooBigModels: [], contextWindow: 32768, parallel: 2 };
    api.getActivity.mockResolvedValue({ atMs: NOW, agent: { ...AGENT, jobs: [], memory }, mine: [] });
    render(ActiveWork, { pollMs: 60_000 });
    expect((await screen.findByTestId("memory-paused")).textContent).toMatch(/Paused: this (mac|computer) is low on memory/);
    expect(screen.getByText("Serving on the network: qwen3.5:9b · loaded now: qwen3.5:9b, llama3.2:3b")).toBeTruthy();
    expect(screen.getByText(/memory budget 28 GB of 48 GB/)).toBeTruthy();
  });

  it("not enrolled, an older agent, and an error", async () => {
    api.getActivity.mockResolvedValueOnce({ atMs: NOW, agent: null, mine: [] });
    render(ActiveWork, { pollMs: 60_000 });
    await screen.findByText("Not on the network");
    cleanup();
    api.getActivity.mockResolvedValueOnce({ atMs: NOW, agent: { ...AGENT, jobs: [], slots: null, jobsUnknown: true }, mine: [] });
    render(ActiveWork, { pollMs: 60_000 });
    await screen.findByText("This computer's agent doesn't report its jobs");
    cleanup();
    api.getActivity.mockRejectedValueOnce(new Error("IDE server not running"));
    render(ActiveWork, { pollMs: 60_000 });
    expect((await screen.findByRole("alert")).textContent).toContain("IDE server not running");
  });

  it("refreshes on its interval", async () => {
    vi.useFakeTimers();
    try {
      api.getActivity.mockResolvedValue(SNAP);
      render(ActiveWork, { pollMs: 2000 });
      await vi.advanceTimersByTimeAsync(10);
      const first = api.getActivity.mock.calls.length;
      await vi.advanceTimersByTimeAsync(4100);
      expect(api.getActivity.mock.calls.length).toBe(first + 2);
    } finally {
      vi.useRealTimers();
    }
  });
});
