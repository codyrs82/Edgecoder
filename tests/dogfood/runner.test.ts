// The dogfood runner's guards: which tier a job goes to, which paths a job may touch, and which
// context commands it may run (read-only gh only). Also checks every seeded job spec is complete.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contextCommandAllowed, pathAllowed, tierFor } from "../../scripts/dogfood/runner.mjs";

describe("dogfood runner", () => {
  it("routes jobs to tiers by type", () => {
    expect(tierFor({ job: "tests" })).toBe("gpu");
    expect(tierFor({ job: "code_edit", complexity: "medium" })).toBe("gpu");
    expect(tierFor({ job: "code_edit", complexity: "small" })).toBe("mac");
    expect(tierFor({ job: "docs" })).toBe("mac");
    expect(tierFor({ job: "summarize" })).toBe("cpu");
    expect(tierFor({ job: "docs", tier: "gpu" })).toBe("gpu");
  });

  it("allows exact paths and dir/** prefixes only", () => {
    expect(pathAllowed("tests/a.test.ts", ["tests/a.test.ts"])).toBe(true);
    expect(pathAllowed("./tests/a.test.ts", ["tests/a.test.ts"])).toBe(true);
    expect(pathAllowed("tests/b.test.ts", ["tests/a.test.ts"])).toBe(false);
    expect(pathAllowed("site-docs/guide/x.md", ["site-docs/guide/**"])).toBe(true);
    expect(pathAllowed("site-docs/guidex.md", ["site-docs/guide/**"])).toBe(false);
  });

  it("runs only read-only gh commands for context", () => {
    expect(contextCommandAllowed(["gh", "pr", "list", "--state", "open"])).toBe(true);
    expect(contextCommandAllowed(["gh", "run", "view", "1", "--log-failed"])).toBe(true);
    expect(contextCommandAllowed(["gh", "api", "repos/o/r/pulls"])).toBe(true);
    expect(contextCommandAllowed(["gh", "api", "-X", "POST", "repos/o/r/issues"])).toBe(false);
    expect(contextCommandAllowed(["gh", "pr", "merge", "1"])).toBe(false);
    expect(contextCommandAllowed(["sh", "-c", "gh pr list"])).toBe(false);
  });

  it("has complete job specs with checks and allowed paths", () => {
    const dir = new URL("../../scripts/dogfood/jobs/", import.meta.url);
    const ids = new Set<string>();
    for (const f of readdirSync(dir)) {
      const j = JSON.parse(readFileSync(new URL(f, dir), "utf8"));
      for (const k of ["id", "title", "job", "instructions", "acceptance", "allowedPaths"]) expect(j, `${f}: ${k}`).toHaveProperty(k);
      expect(`${j.id}.json`).toBe(f);
      expect(ids.has(j.id)).toBe(false);
      ids.add(j.id);
      expect(j.allowedPaths.length).toBeGreaterThan(0);
      for (const a of [j.acceptance].flat()) expect(["vitest", "tsc", "grep", "none"]).toContain(a.kind);
    }
    expect(ids.size).toBeGreaterThanOrEqual(10);
  });
});
