import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #21: community docs exist, there is a single README, and links to the old README.dev.md are gone.
describe("community docs (#21)", () => {
  it.each([
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    ".github/pull_request_template.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/config.yml"
  ])("%s exists", (p) => {
    expect(existsSync(p)).toBe(true);
  });

  it("has one README, with a quick start and the merged developer guide", () => {
    expect(existsSync("README.dev.md")).toBe(false);
    const readme = readFileSync("README.md", "utf8").replace(/\r\n/g, "\n");
    expect(readme).toMatch(/^## Quick Start$/m);
    expect(readme).toMatch(/^## Developer Guide$/m);
    for (const doc of ["CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"]) expect(readme).toContain(`(${doc})`);
  });

  it("SECURITY.md points to private reporting", () => {
    expect(readFileSync("SECURITY.md", "utf8")).toContain("/security/advisories/new");
  });
});
