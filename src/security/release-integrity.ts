// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface ReleaseManifest {
  version: string;
  artifacts: Array<{ name: string; sha256: string }>;
  distTreeHash: string;
  timestamp: string;
}

export interface ReleaseManifestSigned {
  manifest: ReleaseManifest;
  signature: string;
}

export type DistributionChannel = "github" | "npm" | "pkg" | "deb" | "msi" | "dev";

/**
 * Deterministically hash an installed dist/ directory.
 * Sorted filenames + per-file SHA-256 → single tree hash.
 */
export async function computeDistHash(distDir: string): Promise<string> {
  const files = await collectFiles(distDir);
  files.sort();

  const treeHasher = createHash("sha256");
  for (const relPath of files) {
    const absPath = join(distDir, relPath);
    const content = await readFile(absPath);
    const fileHash = createHash("sha256").update(content).digest("hex");
    treeHasher.update(`${relPath}\0${fileHash}\n`);
  }

  return treeHasher.digest("hex");
}

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

/**
 * Load release-manifest.json from well-known paths adjacent to the dist/ directory.
 */
export async function loadReleaseManifest(distDir: string): Promise<ReleaseManifestSigned | null> {
  const candidates = [
    join(distDir, "..", "release-manifest.json"),
    join(distDir, "release-manifest.json"),
  ];

  for (const candidate of candidates) {
    try {
      const absPath = resolve(candidate);
      const raw = await readFile(absPath, "utf-8");
      const parsed = JSON.parse(raw);

      // Also try to load the signature file
      const sigPath = absPath.replace(/\.json$/, ".sig");
      let signature = "";
      try {
        signature = (await readFile(sigPath, "utf-8")).trim();
      } catch {
        // signature file may not exist
      }

      if (parsed.version && parsed.distTreeHash) {
        return {
          manifest: {
            version: parsed.version,
            artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts : [],
            distTreeHash: parsed.distTreeHash,
            timestamp: parsed.timestamp ?? "",
          },
          signature,
        };
      }
    } catch {
      // Try next candidate
    }
  }

  return null;
}

/**
 * Heuristic to detect how the agent was installed.
 */
export function detectDistributionChannel(): DistributionChannel {
  const execPath = process.execPath;
  const argv0 = process.argv[0] ?? "";

  if (process.env.NODE_ENV === "development" || process.env.EDGECODER_DEV === "1") {
    return "dev";
  }

  // macOS .pkg installs to /Applications or /usr/local
  if (execPath.includes("/Applications/") || execPath.includes(".app/")) {
    return "pkg";
  }

  // Linux .deb installs to /usr/lib or /opt
  if (execPath.startsWith("/usr/lib/") || execPath.startsWith("/opt/")) {
    return "deb";
  }

  // Windows .msi installs to Program Files
  if (execPath.includes("Program Files") || execPath.includes("ProgramData")) {
    return "msi";
  }

  // npm global installs
  if (execPath.includes("node_modules/.bin") || argv0.includes("npx")) {
    return "npm";
  }

  // Check for release manifest → likely GitHub release
  if (process.env.EDGECODER_RELEASE === "github") {
    return "github";
  }

  return "dev";
}
