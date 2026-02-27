#!/usr/bin/env npx tsx
// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Deterministically hash the dist/ directory for release signing.
 * Usage: npx tsx scripts/compute-dist-hash.ts [dist-dir]
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

async function collectFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...await collectFiles(join(dir, entry.name), relPath));
    } else if (entry.isFile()) {
      results.push(relPath);
    }
  }
  return results;
}

async function main() {
  const distDir = resolve(process.argv[2] ?? "dist");
  const files = await collectFiles(distDir);
  files.sort();

  const treeHasher = createHash("sha256");
  const artifacts: Array<{ name: string; sha256: string }> = [];

  for (const relPath of files) {
    const absPath = join(distDir, relPath);
    const content = await readFile(absPath);
    const fileHash = createHash("sha256").update(content).digest("hex");
    treeHasher.update(`${relPath}\0${fileHash}\n`);
    artifacts.push({ name: relPath, sha256: fileHash });
  }

  const distTreeHash = treeHasher.digest("hex");

  const result = {
    distTreeHash,
    fileCount: files.length,
    artifacts,
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
