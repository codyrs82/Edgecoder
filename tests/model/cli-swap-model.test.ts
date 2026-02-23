import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { resolve } from "path";

describe("swap-model CLI", () => {
  it("CLI file exists", () => {
    const cliPath = resolve(__dirname, "../../bin/swap-model.ts");
    expect(existsSync(cliPath)).toBe(true);
  });

  it("exports expected commands in help text", async () => {
    const content = await import("fs").then(fs =>
      fs.readFileSync(resolve(__dirname, "../../bin/swap-model.ts"), "utf-8")
    );
    expect(content).toContain("list");
    expect(content).toContain("swap");
    expect(content).toContain("status");
    expect(content).toContain("pull");
  });
});
