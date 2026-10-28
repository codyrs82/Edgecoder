import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #8: fail fast if CI or an image regresses to an EOL Node.
describe("Node runtime", () => {
  it("runs on Node >= 22", () => {
    expect(Number(process.versions.node.split(".")[0])).toBeGreaterThanOrEqual(22);
  });

  it(".nvmrc and package.json engines agree on Node 22", () => {
    const nvmrc = readFileSync(new URL("../../.nvmrc", import.meta.url), "utf8").trim();
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(nvmrc).toBe("22");
    expect(pkg.engines?.node).toMatch(/>=22/);
  });
});
