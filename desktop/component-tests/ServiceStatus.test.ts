// The Network page while EdgeCoder's local service starts, restarts or won't start
// (lib/service-status.ts + components/ServiceNotice.svelte): a neutral notice, never a red error,
// and one clear message with Restart now and View log only after about a minute.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";
import { WORLD } from "../a11y/world-fixture";

const api = vi.hoisted(() => ({
  networkWorld: vi.fn(),
  isRemoteMode: vi.fn(() => false),
  readServiceLog: vi.fn(async () => "line one\nEdgeCoder's local service exited (exit status: 1)"),
}));
vi.mock("../src/lib/api", () => ({ ...api, backendReady: Promise.resolve() }));

import MeshTopology from "../src/pages/MeshTopology.svelte";
import { FAILED_AFTER_MS, setServiceStatusForTests, startServiceMonitor, stopServiceMonitor } from "../src/lib/service-status";

/** A monitor on a hand-moved clock, its probe answering `health.ok`. */
function monitor(opts: { ok?: boolean; restart?: () => Promise<unknown> } = {}) {
  const clock = { now: 0 };
  const health = { ok: opts.ok ?? false };
  const m = startServiceMonitor({
    probe: async () => health.ok,
    restart: opts.restart,
    now: () => clock.now,
    setTimer: () => 0, // the test drives the probes with m.check()
    clearTimer: () => {},
  });
  return { m, clock, health };
}

const noRedError = () => {
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.querySelector(".error-banner")).toBeNull();
  expect(screen.queryByText(/is your agent running/i)).toBeNull();
  expect(screen.queryByText(/couldn't (load|reach|refresh)/i)).toBeNull();
};

beforeEach(() => {
  api.isRemoteMode.mockReturnValue(false);
  api.networkWorld.mockReset();
  api.networkWorld.mockResolvedValue(structuredClone(WORLD));
});
afterEach(() => {
  cleanup();
  stopServiceMonitor();
});

describe("Network page while the local service starts", () => {
  it("starting: a neutral 'Starting EdgeCoder's local service…', no red error, no request yet", async () => {
    monitor({ ok: false });
    render(MeshTopology, { props: { pollInterval: 60_000 } });
    expect(await screen.findByTestId("service-starting")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Starting EdgeCoder's local service…");
    noRedError();
    // It waits for health before loading data.
    expect(api.networkWorld).not.toHaveBeenCalled();
  });

  it("loads the network on its own once the service answers", async () => {
    const { m, health } = monitor({ ok: false });
    render(MeshTopology, { props: { pollInterval: 60_000 } });
    await screen.findByTestId("service-starting");
    health.ok = true;
    await m.check();
    expect(await screen.findByRole("region", { name: /network summary/i })).toBeTruthy();
    expect(screen.queryByTestId("service-starting")).toBeNull();
    noRedError();
  });

  it("restarting (it was up, then stopped answering): the same neutral notice, even when requests fail", async () => {
    const { m, health, clock } = monitor({ ok: true });
    await m.check();
    render(MeshTopology, { props: { pollInterval: 60_000 } });
    await screen.findByRole("region", { name: /network summary/i });
    api.networkWorld.mockRejectedValue(new TypeError("Load failed"));
    health.ok = false;
    clock.now = 5_000;
    await m.check();
    expect(m.current.phase).toBe("restarting");
    expect(await screen.findByTestId("service-starting")).toBeTruthy();
    // Past the page's own 60 s rule its banner would show; while restarting it never does.
    clock.now = 5_000 + FAILED_AFTER_MS - 1;
    await m.check();
    noRedError();
  });

  it("failed after about a minute: one message with Restart now and View log", async () => {
    const restart = vi.fn(async () => undefined);
    const { m, clock } = monitor({ ok: false, restart });
    render(MeshTopology, { props: { pollInterval: 60_000 } });
    await screen.findByTestId("service-starting");
    clock.now = FAILED_AFTER_MS;
    await m.check();
    const failed = await screen.findByTestId("service-failed");
    expect(failed.textContent).toContain("EdgeCoder's local service won't start.");
    expect(screen.getAllByTestId("service-failed")).toHaveLength(1);
    expect(screen.queryByText(/is your agent running/i)).toBeNull();

    await fireEvent.click(screen.getByRole("button", { name: "View log" }));
    expect((await screen.findByTestId("service-log")).textContent).toContain("local service exited");
    expect(api.readServiceLog).toHaveBeenCalledOnce();

    await fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    await waitFor(() => expect(restart).toHaveBeenCalledOnce());
    // Back to the neutral notice while it starts again.
    expect(await screen.findByTestId("service-starting")).toBeTruthy();
    expect(screen.queryByTestId("service-failed")).toBeNull();
  });

  it("ready: a network-level failure while /health answers shows the request's own text, not 'is your agent running'", async () => {
    setServiceStatusForTests("ready");
    api.networkWorld.mockRejectedValue(new Error("EdgeCoder's local service is running, but it blocked this request before it arrived."));
    render(MeshTopology, { props: { pollInterval: 60 } });
    expect(await screen.findByText(/couldn't load the network: EdgeCoder's local service is running, but it blocked/i, {}, { timeout: 15_000 })).toBeTruthy();
    expect(screen.queryByText(/is your agent running/i)).toBeNull();
  }, 20_000);
});
