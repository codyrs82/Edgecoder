// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The newest agent release, for "update available" on the portal's machine rows: the same choice
 * `edgecoder-install update` makes (newest published, non-prerelease agent-vX.Y.Z on GitHub),
 * cached for an hour (10 minutes after a failure). Never blocks a page: the first call answers
 * null and fills the cache in the background.
 */
import { compareVersions, parseVersion, pickLatestTag, RELEASE_API_URL } from "../install/update.js";

const OK_TTL_MS = 60 * 60_000;
const FAIL_TTL_MS = 10 * 60_000;

export type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { headers: { "user-agent": "edgecoder-portal", accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(5_000) });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export function createLatestAgentVersion(fetchJson: FetchJson = defaultFetchJson, now: () => number = Date.now, url = RELEASE_API_URL): () => string | null {
  let value: string | null = null;
  let expiresAtMs = 0;
  let inFlight = false;
  const refresh = () => {
    inFlight = true;
    fetchJson(url)
      .then((listing) => {
        const tag = pickLatestTag(listing);
        if (tag) value = tag.replace(/^agent-v/, "");
        expiresAtMs = now() + (tag ? OK_TTL_MS : FAIL_TTL_MS);
      })
      .catch(() => {
        expiresAtMs = now() + FAIL_TTL_MS;
      })
      .finally(() => {
        inFlight = false;
      });
  };
  return () => {
    if (!inFlight && now() >= expiresAtMs) refresh();
    return value;
  };
}

/** True when `version` is a release version older than `latest`; false when either is unknown. */
export function agentUpdateAvailable(version: unknown, latest: string | null | undefined): boolean {
  if (typeof version !== "string" || !latest || !parseVersion(version) || !parseVersion(latest)) return false;
  return compareVersions(version, latest) < 0;
}
