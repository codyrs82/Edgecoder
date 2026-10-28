import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #20: build output, IDE user state and internal planning docs stay out of the repo.
// Checks what git tracks (git ls-files), not the working tree: local builds legitimately
// create out/, gen/schemas/ and xcuserdata/ on disk, and those are fine as long as they're ignored.
const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\0")
  .filter(Boolean);

const FORBIDDEN: Array<[string, RegExp]> = [
  ["EDGECODER_PLAN.md", /^EDGECODER_PLAN\.md$/],
  ["docs/plans/", /^docs\/plans\//],
  ["docs/archive/", /^docs\/archive\//],
  ["extensions/vscode/out/", /^extensions\/vscode\/out\//],
  ["*.vsix", /\.vsix$/],
  ["desktop/src-tauri/gen/schemas/", /^desktop\/src-tauri\/gen\/schemas\//],
  ["xcuserdata/", /(^|\/)xcuserdata\//],
  ["*.xcuserstate", /\.xcuserstate$/]
];

describe("committed artifacts (#20)", () => {
  it("git ls-files sees the repo", () => {
    expect(tracked).toContain("package.json");
  });

  it.each(FORBIDDEN)("nothing tracked matches %s", (_label, re) => {
    expect(tracked.filter((p) => re.test(p))).toEqual([]);
  });

  it("gitignores the generated paths", () => {
    const ignore = readFileSync(".gitignore", "utf8").replace(/\r\n/g, "\n").split("\n");
    for (const pattern of ["extensions/vscode/out/", "*.vsix", "desktop/src-tauri/gen/schemas/", "xcuserdata/", "*.xcuserstate"]) {
      expect(ignore).toContain(pattern);
    }
  });
});
