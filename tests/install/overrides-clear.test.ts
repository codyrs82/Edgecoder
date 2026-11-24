import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearOverrideEntries, instanceOverridesPath } from "../../src/install/overrides-clear.js";
import { loadOverrides } from "../../src/model/remote-control/overrides.js";
import { defaultPaths } from "../../src/install/services.js";

const entry = (value: unknown) => ({ value, baseline: "", updatedAtMs: 1, updatedBy: "acct-u" });
let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

describe("--context-window auto / --parallel auto clear the portal override", () => {
  it("removes only the cleared settings' entries and keeps the rest, the mode included", () => {
    dir = mkdtempSync(join(tmpdir(), "ovr-"));
    const path = join(dir, "model-overrides.json");
    writeFileSync(path, JSON.stringify({ version: 1, model: entry("qwen3:8b"), contextWindow: entry(32768), parallel: entry(4), keepAlive: entry("2h") }));
    chmodSync(path, 0o600);
    expect(clearOverrideEntries(path, ["contextWindow"])).toBe("cleared");
    const { overrides, problems } = loadOverrides(path);
    expect(problems).toEqual([]);
    expect(overrides.contextWindow).toBeUndefined();
    expect(overrides.model?.value).toBe("qwen3:8b");
    expect(overrides.parallel?.value).toBe(4);
    expect(overrides.keepAlive?.value).toBe("2h");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(clearOverrideEntries(path, ["contextWindow", "parallel"])).toBe("cleared");
    expect(loadOverrides(path).overrides.parallel).toBeUndefined();
    expect(clearOverrideEntries(path, ["contextWindow"])).toBe("unchanged");
  });

  it("a missing file is fine; a corrupt one is left untouched", () => {
    dir = mkdtempSync(join(tmpdir(), "ovr-"));
    expect(clearOverrideEntries(join(dir, "none.json"), ["contextWindow"])).toBe("missing");
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(clearOverrideEntries(bad, ["parallel"])).toBe("unreadable");
    expect(readFileSync(bad, "utf8")).toBe("{not json");
  });

  it("finds each instance's file in its agent HOME", () => {
    expect(instanceOverridesPath("linux", defaultPaths("linux"), 2)).toBe("/var/lib/edgecoder/agent-2/.config/edgecoder/model-overrides.json");
    expect(instanceOverridesPath("darwin", defaultPaths("darwin"), 0)).toMatch(/agent-0\/Library\/Application Support\/EdgeCoder\/model-overrides\.json$/);
    expect(instanceOverridesPath("win32", defaultPaths("win32"), 0)).toBeUndefined();
  });
});
