// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

const STALE_THRESHOLD_MS = 90_000;

export interface ModelSeeder {
  agentId: string;
  lastSeenMs: number;
}

export function findModelSeeders(
  modelName: string,
  agents: Map<string, { localModelCatalog: string[]; lastSeenMs: number }>,
): ModelSeeder[] {
  const now = Date.now();
  const seeders: ModelSeeder[] = [];

  for (const [agentId, info] of agents) {
    if (now - info.lastSeenMs > STALE_THRESHOLD_MS) continue;
    if (info.localModelCatalog.includes(modelName)) {
      seeders.push({ agentId, lastSeenMs: info.lastSeenMs });
    }
  }

  return seeders;
}

export function rankSeeders(seeders: ModelSeeder[]): ModelSeeder[] {
  return [...seeders].sort((a, b) => b.lastSeenMs - a.lastSeenMs);
}
