import { describe, expect, it } from "vitest";
import { budgetLine, localOnlyLine, memoryPausedDetail, memoryPausedTitle, servingLine } from "../src/lib/memory-status";
import type { MemoryOverview } from "../src/lib/api";

const GB = 1024 ** 3;
const mem = (o: Partial<MemoryOverview> = {}): MemoryOverview => ({
  pressure: "normal", paused: false, pausedReason: null, totalBytes: 48 * GB, budgetBytes: 28.8 * GB, usedBytes: 14 * GB,
  loadedModels: ["qwen3.5:9b"], servingModels: ["qwen3.5:9b"], localOnlyModels: ["deepseek-r1:14b"], tooBigModels: ["qwen3-coder:30b"],
  contextWindow: 32768, parallel: 2, ...o,
});

describe("memory status text", () => {
  it("says when this Mac is paused for memory", () => {
    expect(memoryPausedTitle(mem(), "MacIntel")).toBeNull();
    expect(memoryPausedTitle(mem({ paused: true, pressure: "warning" }), "MacIntel")).toBe("Paused: this mac is low on memory");
    expect(memoryPausedTitle(mem({ paused: true, pressure: "critical" }), "Win32")).toBe("Paused: this computer is critically low on memory");
    expect(memoryPausedTitle(mem({ paused: true }), "MacIntel")).toMatch(/no installed model fits/);
    expect(memoryPausedDetail(mem({ pressure: "warning" }))).toMatch(/Your own chats keep working/);
  });

  it("lists what is served on the network and what stays local", () => {
    expect(servingLine(mem())).toBe("Serving on the network: qwen3.5:9b");
    expect(servingLine(mem({ servingModels: [] }))).toBe("Serving on the network: none");
    expect(budgetLine(mem())).toBe("memory budget 29 GB of 48 GB · 14 GB loaded · 32k context × 2 parallel");
    expect(localOnlyLine(mem())).toBe("local only (past this machine's network model limit): deepseek-r1:14b; local only (too big for the memory budget): qwen3-coder:30b");
  });
});
