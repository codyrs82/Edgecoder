import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";

const shell = vi.hoisted(() => ({ open: vi.fn(async () => {}) }));
vi.mock("@tauri-apps/plugin-shell", () => shell);

import AgentPausedNotice from "../src/components/AgentPausedNotice.svelte";
import { pausedReasonText, reviewMailto, thisMachineLabel } from "../src/lib/agent-paused";

const REASON = "Auto-blacklisted by behavioral monitoring: BHV006, BHV006, BHV006 — Max heartbeat gap 495s while still claiming tasks";

describe("AgentPausedNotice", () => {
  it("says the machine was paused, with the reason, instead of not connected", () => {
    render(AgentPausedNotice, { reason: REASON, agentId: "desktop-maw-mb-02-local-6bfc752c" });
    expect(screen.getByRole("alert").textContent).toMatch(/was paused by the network's safety check/);
    expect(screen.getByText(/Max heartbeat gap 495s while still claiming tasks/)).toBeTruthy();
    expect(screen.queryByText(/Not connected/)).toBeNull();
  });

  it("Request review opens a prefilled email with the agent and the reason", async () => {
    render(AgentPausedNotice, { reason: REASON, agentId: "agent-1" });
    await fireEvent.click(screen.getByRole("button", { name: "Request review" }));
    const url = String((shell.open.mock.calls as unknown[][])[0][0]);
    expect(url.startsWith("mailto:support@edgecoder.io?")).toBe(true);
    expect(decodeURIComponent(url)).toContain("Agent: agent-1");
    expect(decodeURIComponent(url)).toContain("Max heartbeat gap 495s");
  });

  it("Retry calls back", async () => {
    const onRetry = vi.fn();
    render(AgentPausedNotice, { reason: "manual review", onRetry });
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe("agent-paused helpers", () => {
  it("names the machine and trims the coordinator's prefix", () => {
    expect(thisMachineLabel("MacIntel")).toBe("This Mac");
    expect(thisMachineLabel("Win32")).toBe("This computer");
    expect(pausedReasonText(REASON)).toBe("BHV006, BHV006, BHV006 — Max heartbeat gap 495s while still claiming tasks");
    expect(reviewMailto("x")).toContain("Agent%3A%20(unknown)");
  });
});
