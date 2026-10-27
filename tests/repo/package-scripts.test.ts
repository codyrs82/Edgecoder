import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findMissingScriptPaths } from "../../scripts/check-scripts.mjs";

describe("package.json scripts (#12)", () => {
  it("every src/tests/scripts/bin path referenced by a script exists", () => {
    expect(findMissingScriptPaths(resolve(__dirname, "../.."))).toEqual([]);
  });

  it("detects a missing path", () => {
    const root = mkdtempSync(join(tmpdir(), "scripts-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "real.ts"), "");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { ok: "tsx src/real.ts", bad: "tsx src/handshake/mock-server.ts" } })
    );
    expect(findMissingScriptPaths(root)).toEqual([{ script: "bad", path: "src/handshake/mock-server.ts" }]);
  });

  it("e2e harnesses are excluded from unit vitest (#7)", () => {
    const cfg = readFileSync(resolve(__dirname, "../../vitest.config.ts"), "utf8");
    expect(cfg).toContain('"tests/e2e/**"');
  });
});
