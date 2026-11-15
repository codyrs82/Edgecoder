// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #19: one license for the whole repository (docs/adrs/0003-license-busl-1.1.md).
const LICENSE = "BUSL-1.1";

// Walks the tree instead of asking git: the Debian CI job runs in a container where git refuses
// the checkout ("dubious ownership"). Dot directories and build output are skipped.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "coverage", "out"]);

function packageManifests(dir = "."): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) found.push(...packageManifests(path));
    } else if (entry.name === "package.json") {
      found.push(path);
    }
  }
  return found;
}

describe("license declarations", () => {
  it("every package.json declares BUSL-1.1", () => {
    const manifests = packageManifests();
    expect(manifests).toEqual(expect.arrayContaining(["package.json", "desktop/package.json", "extensions/vscode/package.json"]));
    for (const file of manifests) {
      expect(JSON.parse(readFileSync(file, "utf8")).license, file).toBe(LICENSE);
    }
  });

  it("the desktop crate declares BUSL-1.1", () => {
    expect(readFileSync("desktop/src-tauri/Cargo.toml", "utf8")).toMatch(/^license = "BUSL-1\.1"$/m);
  });

  it("the VS Code extension ships the repository license text", () => {
    expect(readFileSync("extensions/vscode/LICENSE.txt", "utf8")).toBe(readFileSync("LICENSE", "utf8"));
  });

  it("LICENSE is the Business Source License 1.1 with an Apache-2.0 change license", () => {
    const text = readFileSync("LICENSE", "utf8");
    expect(text).toMatch(/^Business Source License 1\.1/);
    expect(text).toMatch(/Change License:\s+Apache License, Version 2\.0/);
  });
});
