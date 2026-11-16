import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/svelte";

/*
 * Settings > General, local network (docs/security/lan-proximity.md): discovery on and "Accept work
 * directly from machines on my network" off by default; turning direct on saves both choices
 * (the app restarts its agent with AGENT_LAN_DISCOVERY / AGENT_LAN_DIRECT).
 */
const shell = vi.hoisted(() => ({
  settings: { bleEnabled: true, lanDiscovery: true, lanDirect: false },
  calls: [] as Array<{ command: string; args?: Record<string, unknown> }>,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    shell.calls.push({ command, args });
    if (command === "get_local_token") return "t";
    if (command === "get_agent_settings") return { ...shell.settings };
    if (command === "set_agent_lan") {
      shell.settings = { ...shell.settings, lanDiscovery: Boolean(args?.discovery), lanDirect: Boolean(args?.direct) };
      return { ...shell.settings };
    }
    throw new Error("not running in the desktop shell");
  },
}));

import Settings from "../src/pages/Settings.svelte";

afterEach(() => cleanup());

describe("Settings: local network", () => {
  it("discovery is on and direct transfer is off by default; turning direct on saves it", async () => {
    render(Settings);
    const discovery = await screen.findByRole("switch", { name: "Find EdgeCoder machines on my network" });
    const direct = screen.getByRole("switch", { name: "Accept work directly from machines on my network" });
    await waitFor(() => expect(discovery.getAttribute("aria-checked")).toBe("true"));
    expect(direct.getAttribute("aria-checked")).toBe("false");
    await fireEvent.click(direct);
    await waitFor(() => expect(direct.getAttribute("aria-checked")).toBe("true"));
    expect(shell.calls.find((c) => c.command === "set_agent_lan")?.args).toEqual({ discovery: true, direct: true });
    expect(screen.getAllByRole("status").some((s) => /accept work directly/.test(s.textContent ?? ""))).toBe(true);
  });

  it("direct transfer cannot be on without discovery", async () => {
    shell.settings = { bleEnabled: true, lanDiscovery: false, lanDirect: true };
    render(Settings);
    const direct = await screen.findByRole("switch", { name: "Accept work directly from machines on my network" });
    await waitFor(() => expect((direct as HTMLButtonElement).disabled).toBe(true));
    expect(direct.getAttribute("aria-checked")).toBe("false");
  });
});
