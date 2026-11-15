import { describe, expect, it } from "vitest";
import { allowedModel, fitCheck, keepAliveSeconds, parseSizeText, remoteControlEnabled, resolveAllowlist, settingsProblem } from "../../../src/model/remote-control/policy.js";

const GB = 1e9;

describe("remote control policy", () => {
  it("is on unless the host says off", () => {
    expect(remoteControlEnabled(undefined)).toBe(true);
    expect(remoteControlEnabled("on")).toBe(true);
    for (const v of ["off", "OFF", "0", "false", "no"]) expect(remoteControlEnabled(v)).toBe(false);
  });

  it("allows the catalog by default, an operator list instead, and nothing with none", () => {
    const def = resolveAllowlist(undefined);
    expect(allowedModel(def, "qwen3-coder:30b")?.sizeBytes).toBe(19 * GB);
    expect(allowedModel(def, "someone/finetune:latest")).toBeUndefined();
    const locked = resolveAllowlist("qwen3.5:9b");
    expect(allowedModel(locked, "qwen3.5:9b")).toBeDefined();
    expect(allowedModel(locked, "qwen3-coder:30b")).toBeUndefined();
    const extended = resolveAllowlist("catalog, someone/finetune:q4");
    expect(allowedModel(extended, "qwen3-coder:30b")).toBeDefined();
    expect(allowedModel(extended, "someone/finetune:q4")).toEqual({});
    expect(resolveAllowlist("none").models.size).toBe(0);
    // Malformed names in the list are dropped, never matched.
    expect(resolveAllowlist("evil.com/x:1,../etc").models.size).toBe(0);
    // A bare name means :latest.
    expect(allowedModel(resolveAllowlist("mistral"), "mistral:latest")).toBeDefined();
  });

  it("bounds the settings", () => {
    expect(settingsProblem({ contextWindow: 65536, parallel: 2, keepAlive: "-1" })).toBeNull();
    expect(settingsProblem({ contextWindow: 1024 })).toBe("context_window_out_of_bounds");
    expect(settingsProblem({ contextWindow: 262_144 })).toBe("context_window_out_of_bounds");
    expect(settingsProblem({ contextWindow: 8192.5 })).toBe("context_window_out_of_bounds");
    expect(settingsProblem({ parallel: 0 })).toBe("parallel_out_of_bounds");
    expect(settingsProblem({ parallel: 9 })).toBe("parallel_out_of_bounds");
    expect(settingsProblem({ keepAlive: "48h" })).toBe("keep_alive_out_of_bounds");
    expect(settingsProblem({ keepAlive: "soon" })).toBe("keep_alive_malformed");
    expect(keepAliveSeconds("30m")).toBe(1800);
    expect(keepAliveSeconds("0")).toBe(0);
  });

  it("refuses a pull that does not fit the disk or the memory", () => {
    expect(fitCheck({ sizeBytes: 19 * GB, diskFreeBytes: 500 * GB, ramBytes: 117 * 2 ** 30, vramBytes: 30 * 2 ** 30, minMemoryGb: 24 }).ok).toBe(true);
    expect(fitCheck({ sizeBytes: 19 * GB, diskFreeBytes: 15 * GB, ramBytes: 64 * GB })).toMatchObject({ ok: false, reason: "insufficient_disk" });
    // Re-pulling an installed tag downloads only what changed.
    expect(fitCheck({ sizeBytes: 19 * GB, diskFreeBytes: 3 * GB, ramBytes: 64 * GB, alreadyInstalledBytes: 19 * GB }).ok).toBe(true);
    expect(fitCheck({ sizeBytes: 43 * GB, diskFreeBytes: 500 * GB, ramBytes: 16 * GB })).toMatchObject({ ok: false, reason: "insufficient_memory" });
    expect(fitCheck({ sizeBytes: 4 * GB, minMemoryGb: 48, diskFreeBytes: 500 * GB, ramBytes: 32 * GB })).toMatchObject({ ok: false, reason: "insufficient_memory" });
    expect(parseSizeText("4.7 GB")).toBe(4.7 * GB);
  });
});
