// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { type ReleaseManifest } from "./release-integrity.js";

const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const GITHUB_RELEASES_API = "https://api.github.com/repos/edgecoder-ai/edgecoder/releases";

export class ReleaseManifestCache {
  private readonly manifests = new Map<string, ReleaseManifest>();
  private readonly refreshIntervalMs: number;
  private readonly githubReleasesUrl: string;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    refreshIntervalMs: number = DEFAULT_REFRESH_INTERVAL_MS,
    githubReleasesUrl: string = GITHUB_RELEASES_API
  ) {
    this.refreshIntervalMs = refreshIntervalMs;
    this.githubReleasesUrl = githubReleasesUrl;
  }

  getManifest(version: string): ReleaseManifest | undefined {
    return this.manifests.get(version);
  }

  getAllManifests(): Map<string, ReleaseManifest> {
    return new Map(this.manifests);
  }

  setManifest(version: string, manifest: ReleaseManifest): void {
    this.manifests.set(version, manifest);
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch(this.githubReleasesUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "EdgeCoder-Coordinator",
        },
      });

      if (!res.ok) return;

      const releases = (await res.json()) as Array<{
        tag_name: string;
        assets: Array<{ name: string; browser_download_url: string }>;
      }>;

      for (const release of releases) {
        const version = release.tag_name.replace(/^v/, "");
        if (this.manifests.has(version)) continue;

        const manifestAsset = release.assets.find(
          (a) => a.name === "release-manifest.json"
        );
        if (!manifestAsset) continue;

        try {
          const manifestRes = await fetch(manifestAsset.browser_download_url, {
            headers: { "User-Agent": "EdgeCoder-Coordinator" },
          });
          if (!manifestRes.ok) continue;

          const manifest = (await manifestRes.json()) as ReleaseManifest;
          if (manifest.version && manifest.distTreeHash) {
            this.manifests.set(version, manifest);
          }
        } catch {
          // Skip individual manifest fetch failures
        }
      }
    } catch {
      // Best effort — will retry on next interval
    }
  }

  start(): void {
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), this.refreshIntervalMs);
    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
