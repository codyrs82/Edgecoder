import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #70: the .vsix is built from source at a vscode-v* tag; these keep the packaging inputs honest.
describe("VS Code extension packaging (#70)", () => {
  const pkg = JSON.parse(readFileSync("extensions/vscode/package.json", "utf8"));
  const ignore = readFileSync("extensions/vscode/.vscodeignore", "utf8").split(/\r?\n/).map((l) => l.trim());

  it("compiles before packaging and packages with the lockfile-pinned vsce", () => {
    expect(pkg.scripts["vscode:prepublish"]).toBe("npm run compile");
    expect(pkg.scripts.package).toMatch(/^vsce package --no-dependencies/);
    expect(pkg.devDependencies["@vscode/vsce"]).toBeDefined();
  });

  it("keeps sources and source maps (at any depth) out of the .vsix", () => {
    expect(ignore).toContain("src/**");
    expect(ignore).toContain("**/*.map");
  });

  it("the release script checks the tag against the extension version", () => {
    const script = readFileSync("scripts/release/package-vscode.sh", "utf8");
    expect(script).toContain('"${TAG#vscode-v}" = "$VERSION"');
  });
});
