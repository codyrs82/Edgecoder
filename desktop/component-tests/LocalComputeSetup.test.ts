import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/svelte";
import type { ComponentStatus, ComputeStatus } from "../src/lib/local-compute";

const shell = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: shell.invoke }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shell.open }));

import LocalComputeSetup from "../src/components/LocalComputeSetup.svelte";

const comp = (over: Partial<ComponentStatus> = {}): ComponentStatus => ({
  state: "pending", source: "", version: "", detail: "", activity: "", downloaded: 0, total: 0, error: null, required: true, ...over,
});
const status = (over: Partial<ComputeStatus> = {}): ComputeStatus => ({
  managed: true, state: "running", ollama: comp(), docker: comp(), ollama_url: "http://127.0.0.1:11434", docker_host: null, ...over,
});

afterEach(() => cleanup());

describe("LocalComputeSetup", () => {
  it("shows download progress for each component", () => {
    render(LocalComputeSetup, {
      status: status({
        ollama: comp({ state: "downloading", detail: "Downloading ollama 0.40.13", downloaded: 50 * 1024 ** 2, total: 200 * 1024 ** 2 }),
        docker: comp({ state: "starting", detail: "Creating the Docker VM", activity: "provisioning ..." }),
      }),
      onStatus: () => {},
      onDismiss: () => {},
    });
    expect(screen.getByRole("heading", { name: "Setting up local compute" })).toBeTruthy();
    const bar = screen.getByRole("progressbar", { name: /ollama download/i });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByText(/50 MB of 200 MB/)).toBeTruthy();
    expect(screen.getByText("provisioning ...")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows the error plainly and retries", async () => {
    const after = status({ state: "running", ollama: comp({ state: "checking" }) });
    shell.invoke.mockResolvedValue(after);
    const onStatus = vi.fn();
    render(LocalComputeSetup, {
      status: status({ state: "error", ollama: comp({ state: "error", error: "Downloading Ollama failed: timed out." }) }),
      onStatus,
      onDismiss: () => {},
    });
    expect(screen.getByText("Downloading Ollama failed: timed out.")).toBeTruthy();
    await fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith(after));
    expect(shell.invoke).toHaveBeenCalledWith("start_local_compute_setup");
  });

  it("offers the Ollama download page where setup isn't managed", async () => {
    render(LocalComputeSetup, {
      status: status({ managed: false, state: "error", ollama: comp({ state: "error", error: "Ollama isn't installed." }) }),
      onStatus: () => {},
      onDismiss: () => {},
    });
    await fireEvent.click(screen.getByRole("button", { name: "Download Ollama" }));
    expect(shell.open).toHaveBeenCalledWith("https://ollama.com/download");
  });
});
