// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The update nudge, coordinator side: /register and /heartbeat answer
 * `updateAvailable: "agent-vX.Y.Z"` to an agent whose reported version is older than the newest
 * published, non-prerelease agent release (GitHub, refreshed in the background at most every 10
 * minutes; a 403/429 waits for GitHub's reset). The agent only asks its own root updater to check
 * early (src/swarm/update-nudge.ts); nothing here can choose what gets installed.
 * AGENT_UPDATE_HINTS=off turns it off; it is off under NODE_ENV=test (no GitHub calls in tests).
 */
import { agentUpdateAvailable, createLatestAgentVersion } from "../../portal/agent-release.js";

export const RELEASE_POLL_MS = 10 * 60_000;

let source: (() => string | null) | undefined;

function latest(): string | null {
  if (!source) {
    const off = process.env.AGENT_UPDATE_HINTS === "off" || process.env.NODE_ENV === "test";
    source = off ? () => null : createLatestAgentVersion(undefined, undefined, undefined, { okMs: RELEASE_POLL_MS, failMs: RELEASE_POLL_MS });
  }
  return source();
}

/** Tests: where the newest release comes from (undefined: back to the default). */
export function setLatestAgentReleaseSource(fn: (() => string | null) | undefined): void {
  source = fn;
}

/** `{ updateAvailable: "agent-v1.2.7" }` for an agent reporting an older release version, else {}. */
export function agentUpdateHint(version: unknown): { updateAvailable?: string } {
  const newest = latest();
  return newest && agentUpdateAvailable(version, newest) ? { updateAvailable: `agent-v${newest}` } : {};
}
