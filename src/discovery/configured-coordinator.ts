// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// An operator's explicitly configured coordinator (COORDINATOR_URL other than the platform URL)
// at agent startup: steering keeps it while it answers and is trusted (steering.ts, configuredUrl),
// and neither the portal (/nodes/discover-coordinator) nor other unsigned discovery replaces it.
// Default installs keep steering to the nearest healthy platform coordinator.

import type { SteeringResult } from "./steering.js";

export interface StartupPick {
  url: string;
  source: string;
}

/**
 * Whether the startup discovery pick (portal or unsigned discovery) replaces the steering choice.
 * Returns the pick to apply, or null to keep the current coordinator.
 */
export function applyStartupDiscovery(input: {
  discovered: StartupPick | null;
  steering: SteeringResult | null;
  explicitUrl: string | null;
}): StartupPick | null {
  const { discovered, steering, explicitUrl } = input;
  if (!discovered) return null;
  // A signed-registry pick, or the configured coordinator kept by steering, wins over unsigned discovery.
  if (steering?.source === "registry" || steering?.source === "configured") return null;
  // The portal never overrides an operator's own coordinator.
  if (explicitUrl && discovered.source === "portal") return null;
  return discovered;
}

/** The log line for one steering round (null when nothing worth saying changed). */
export function describeSteering(result: SteeringResult, previous: SteeringResult | null, currentUrl: string): string | null {
  if (result.source === "configured") {
    if (previous?.source === "configured" && previous.url === result.url) return null;
    return `steering: keeping configured coordinator ${result.url} (${result.peerId}, ${result.latencyMs}ms)`;
  }
  if (result.source === "registry") {
    const via = `${result.peerId}, region=${result.region}, ${result.latencyMs}ms${result.kept ? ", kept" : ""}; registry from ${result.registry?.from}`;
    const cp = result.configuredProblem;
    if (cp) {
      if (previous?.source === "registry" && previous.configuredProblem?.problem === cp.problem && previous.url === result.url) return null;
      return `steering: configured coordinator ${cp.url} ${cp.problem}; steering to ${result.url} (${via})`;
    }
    if (result.kept && result.url === currentUrl) return null;
    return `steering: ${result.url} (${via})`;
  }
  const extra = result.configuredProblem ? ` (configured coordinator ${result.configuredProblem.problem})` : "";
  return `steering fell back to ${result.url}: ${result.reason}${extra}`;
}
