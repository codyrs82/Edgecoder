import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLES, resolveRole } from "../../src/cli/edgecoder.js";

describe("edgecoder role dispatcher", () => {
  it("resolves the role from the first argument or EDGE_RUNTIME_MODE", () => {
    expect(resolveRole(["agent", "--x"], {})).toEqual({ role: "agent", rest: ["--x"] });
    expect(resolveRole([], { EDGE_RUNTIME_MODE: "portal" })).toEqual({ role: "portal", rest: [] });
    expect(resolveRole([], {})).toEqual({ role: "all-in-one", rest: [] });
    expect(resolveRole(["nope"], {})).toMatchObject({ error: expect.stringContaining("unknown role") });
    expect(resolveRole([], { EDGE_RUNTIME_MODE: "nope" })).toMatchObject({ error: expect.stringContaining("not a role") });
  });

  it("every role points at a real entry module and every npm bin is a dispatcher stub", () => {
    for (const target of Object.values(ROLES)) expect(() => readFileSync(`src/cli/${target.replace(/\.js$/, ".ts")}`)).not.toThrow();
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { bin: Record<string, string> };
    expect(Object.keys(pkg.bin).sort()).toEqual(["edgecoder", "edgecoder-agent", "edgecoder-coordinator", "edgecoder-install", "edgecoder-portal"]);
    for (const [name, file] of Object.entries(pkg.bin)) {
      const src = readFileSync(file.replace(/^dist\//, "src/").replace(/\.js$/, ".ts"), "utf8");
      expect(src.startsWith("#!/usr/bin/env node"), name).toBe(true);
    }
  });
});
