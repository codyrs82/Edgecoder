// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from "node:fs";

let cached: string | undefined;

/**
 * The agent's version, read once. A signed agent release (install.sh / install.ps1 /
 * `edgecoder-install update`) carries edgecoder-release.json with its tag (agent-v1.2.3 -> "1.2.3"):
 * package.json's version is not bumped per release, so the tag is what the portal compares with the
 * newest release. Otherwise (desktop app, source checkout) package.json's version.
 */
export function appVersion(): string {
  if (cached !== undefined) return cached;
  cached = releaseTagVersion(readText(new URL("../../edgecoder-release.json", import.meta.url))) ?? packageVersion();
  return cached;
}

/** A signed agent release (its edgecoder-release.json names an agent-v tag): what `edgecoder-install update` updates. */
export function isReleaseInstall(): boolean {
  return releaseTagVersion(readText(new URL("../../edgecoder-release.json", import.meta.url))) !== undefined;
}

function readText(url: URL): string | undefined {
  try {
    return readFileSync(url, "utf8");
  } catch {
    return undefined;
  }
}

/** "1.2.3" from an edgecoder-release.json whose tag is agent-v1.2.3; undefined otherwise. */
export function releaseTagVersion(json: string | undefined): string | undefined {
  if (!json) return undefined;
  try {
    const tag = (JSON.parse(json) as { tag?: unknown }).tag;
    const m = typeof tag === "string" ? /^agent-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag) : null;
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

function packageVersion(): string {
  try {
    return (JSON.parse(readText(new URL("../../package.json", import.meta.url)) ?? "{}") as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}
