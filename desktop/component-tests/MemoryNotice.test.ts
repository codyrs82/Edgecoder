import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/svelte";
import type { MemoryOverview } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({ computeOverview: vi.fn(async () => ({ connected: true })), isRemoteMode: () => false }));

import MemoryNotice from "../src/components/MemoryNotice.svelte";

const GB = 1024 ** 3;
const mem = (o: Partial<MemoryOverview> = {}): MemoryOverview => ({
  pressure: "normal", paused: false, pausedReason: null, totalBytes: 48 * GB, budgetBytes: 28.8 * GB, usedBytes: 14 * GB,
  loadedModels: ["qwen3.5:9b"], servingModels: ["qwen3.5:9b"], localOnlyModels: [], tooBigModels: [], contextWindow: 32768, parallel: 2, ...o,
});

describe("MemoryNotice", () => {
  afterEach(cleanup);
  it("shows the low-memory pause in Active work", () => {
    render(MemoryNotice, { memory: mem({ paused: true, pressure: "warning" }) });
    expect(screen.getByTestId("memory-paused").textContent).toMatch(/Paused: this (mac|computer) is low on memory/);
  });

  it("shows nothing while network work runs", () => {
    render(MemoryNotice, { memory: mem() });
    expect(screen.queryByTestId("memory-paused")).toBeNull();
  });

  it("lists the models served on the network in Settings → Models", () => {
    render(MemoryNotice, { memory: mem(), showServing: true });
    expect(screen.getByTestId("memory-serving").textContent).toContain("Serving on the network: qwen3.5:9b");
  });
});
