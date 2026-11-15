import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { layerOverrides, loadOverrides, overridesPath, saveOverrides, withOverride, withoutKeys } from "../../../src/model/remote-control/overrides.js";

const dir = () => mkdtempSync(join(tmpdir(), "ec-overrides-"));

describe("model override file", () => {
  it("persists remote changes atomically, owner-only, and reads them back", () => {
    const path = overridesPath(join(dir(), "nested"));
    const env = { model: "qwen3-coder:30b", contextWindow: "65536" };
    let o = withOverride({ version: 1 }, "model", "qwen3.5:9b", env, { updatedBy: "acct-u1", commandId: "c-1", nowMs: 5 });
    o = withOverride(o, "keepAlive", "1h", env, { updatedBy: "acct-u1", nowMs: 6 });
    saveOverrides(path, o);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const back = loadOverrides(path);
    expect(back.problems).toEqual([]);
    expect(back.overrides.model).toEqual({ value: "qwen3.5:9b", baseline: "qwen3-coder:30b", updatedAtMs: 5, updatedBy: "acct-u1", commandId: "c-1" });
    expect(back.overrides.keepAlive?.baseline).toBe("");
  });

  it("layers overrides over the env while the env is unchanged; a local change wins", () => {
    const env = { model: "qwen3-coder:30b", contextWindow: "65536", parallel: "1", keepAlive: "-1" };
    let o = withOverride({ version: 1 }, "model", "qwen3.5:9b", env, { updatedBy: "acct-u1" });
    o = withOverride(o, "contextWindow", 32768, env, { updatedBy: "acct-u1" });
    const same = layerOverrides(env, o);
    expect(same.env).toMatchObject({ model: "qwen3.5:9b", contextWindow: "32768", parallel: "1", keepAlive: "-1" });
    expect(same.sources).toEqual({ model: "remote", contextWindow: "remote", parallel: "env", keepAlive: "env" });
    expect(same.superseded).toEqual([]);
    // The operator edits the env file's context window (or the desktop app changes it): theirs wins.
    const edited = layerOverrides({ ...env, contextWindow: "16384" }, o);
    expect(edited.env).toMatchObject({ model: "qwen3.5:9b", contextWindow: "16384" });
    expect(edited.superseded).toEqual(["contextWindow"]);
    expect(withoutKeys(o, edited.superseded).contextWindow).toBeUndefined();
  });

  it("ignores a malformed file, unknown keys and out-of-bounds values (the env alone still works)", () => {
    const d = dir();
    const path = overridesPath(d);
    writeFileSync(path, "{not json");
    expect(loadOverrides(path).overrides).toEqual({ version: 1 });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        contextWindow: { value: 10_000_000, baseline: "" },
        parallel: { value: 64, baseline: "" },
        keepAlive: { value: "999h", baseline: "" },
        model: { value: "evil.com/x:1", baseline: "" },
        shell: { value: "rm -rf /", baseline: "" }
      })
    );
    const r = loadOverrides(path);
    expect(r.overrides).toEqual({ version: 1 });
    expect(r.problems.length).toBe(5);
    expect(loadOverrides(join(d, "missing.json"))).toEqual({ overrides: { version: 1 }, problems: [] });
    expect(readFileSync(path, "utf8")).toContain("rm -rf");
  });
});
