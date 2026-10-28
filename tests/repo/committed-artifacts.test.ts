import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #20: build output, IDE user state and internal planning docs stay out of the repo.
const REMOVED = [
  "EDGECODER_PLAN.md",
  "docs/plans",
  "docs/archive",
  "extensions/vscode/out",
  "extensions/vscode/edgecoder-0.1.0.vsix",
  "desktop/src-tauri/gen/schemas",
  "ios/EdgeCoderIOS/Edge Coder.xcodeproj/project.xcworkspace/xcuserdata",
  "ios/EdgeCoderIOS/EdgeCoderIOS.xcodeproj/project.xcworkspace/xcuserdata"
];

describe("committed artifacts (#20)", () => {
  it.each(REMOVED)("%s is not in the checkout", (p) => {
    expect(existsSync(p)).toBe(false);
  });

  it("gitignores the generated paths", () => {
    const ignore = readFileSync(".gitignore", "utf8").replace(/\r\n/g, "\n").split("\n");
    for (const pattern of ["extensions/vscode/out/", "*.vsix", "desktop/src-tauri/gen/schemas/", "xcuserdata/", "*.xcuserstate"]) {
      expect(ignore).toContain(pattern);
    }
  });
});
