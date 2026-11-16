// Host memory safety in the load-test report (scripts/loadgen/memory.mjs): a run fails when any
// host hit critical memory pressure or loaded models past its budget.
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without type declarations
import { formatHostMemory, hostMemoryReport, hostsFromSnapshots } from "../../scripts/loadgen/memory.mjs";
// @ts-expect-error plain .mjs script without type declarations
import { capacityFrom } from "../../scripts/loadgen/capacity.mjs";

const GB = 1024 ** 3;
const agent = (agentId: string, memory: Record<string, unknown> | null) => ({ agentId, connected: true, slots: 2, freeSlots: 2, modelsInstalled: ["qwen3.5:9b"], memory });
const mem = (pressure: string, usedGb: number, extra: Record<string, unknown> = {}) => ({ pressure, usedBytes: usedGb * GB, budgetBytes: 28.8 * GB, totalBytes: 48 * GB, loadedModels: [{ name: "qwen3.5:9b", bytes: usedGb * GB }], incidents: [], ...extra });

describe("loadgen host memory report", () => {
  it("records per-host peaks from capacity samples and passes a healthy run", () => {
    const s1 = capacityFrom([{ models: [], agents: [agent("mac-1", mem("normal", 10)), agent("old", null)] }], 1_000);
    const s2 = capacityFrom([{ models: [], agents: [agent("mac-1", mem("warning", 16))] }], 2_000);
    expect(Object.keys(s1.hosts)).toEqual(["mac-1"]);
    const r = hostMemoryReport([s1, s2], {}, 0, 3_000);
    expect(r.ok).toBe(true);
    expect(r.hosts["mac-1"]).toMatchObject({ peakPressure: "warning", peakUsedBytes: 16 * GB, budgetBytes: 28.8 * GB, samples: 2 });
    expect(formatHostMemory(r)).toContain("mac-1: peak pressure warning, peak loaded 16.0 GB of 28.8 GB budget");
  });

  it("FLAGs a host that hit critical pressure or went over its budget, from samples or the coordinator's incidents", () => {
    const sample = capacityFrom([{ models: [], agents: [agent("mac-1", mem("critical", 12))] }], 1_000);
    const final = hostsFromSnapshots([{ agents: [agent("mac-2", mem("normal", 5, { incidents: [{ atMs: 1_500, kind: "over_budget", usedBytes: 40 * GB, budgetBytes: 28.8 * GB }, { atMs: 99_999, kind: "critical", usedBytes: 0, budgetBytes: 0 }] }))] }]);
    const r = hostMemoryReport([sample], final, 0, 3_000);
    expect(r.ok).toBe(false);
    expect(r.flags).toEqual([
      "FLAG host-memory: mac-1 hit CRITICAL memory pressure during the run",
      "FLAG host-memory: mac-2 loaded 40.0 GB of models, over its 28.8 GB budget",
    ]);
    // The incident outside the run window does not count.
    expect(r.hosts["mac-2"].critical).toBe(false);
  });
});
