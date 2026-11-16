// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { pgStore } from "../../db/store.js";
import { agentCapabilities } from "./agent-state.js";

/**
 * The account an agent verifiably belongs to: its portal-linked ownership row. null when it has none
 * (unlike rewardAccountForAgent, which falls back to the agent id).
 */
export async function verifiedAccountOf(agentId: string): Promise<string | null> {
  try {
    return (await pgStore?.getAgentOwnership(agentId))?.accountId ?? null;
  } catch {
    return null;
  }
}

const accountCache = new Map<string, { accountId: string | null; atMs: number }>();
const ACCOUNT_TTL_MS = 60_000;

/**
 * Owner account per agent (agent_ownership), cached for a minute; null when not linked or not known
 * here. A slow database leaves the misses unknown after `maxWaitMs` rather than holding the caller.
 */
export async function accountsFor(agentIds: string[], nowMs: number, maxWaitMs = 2_000): Promise<Map<string, string | null>> {
  for (const id of accountCache.keys()) if (!agentCapabilities.has(id)) accountCache.delete(id);
  const out = new Map<string, string | null>();
  const misses: string[] = [];
  for (const id of agentIds) {
    const hit = accountCache.get(id);
    if (hit && nowMs - hit.atMs < ACCOUNT_TTL_MS) out.set(id, hit.accountId);
    else misses.push(id);
  }
  if (misses.length && pgStore) {
    const lookups = Promise.all(
      misses.map(async (id) => {
        const accountId = (await pgStore!.getAgentOwnership(id).catch(() => null))?.accountId ?? null;
        accountCache.set(id, { accountId, atMs: nowMs });
        out.set(id, accountId);
      })
    );
    await Promise.race([lookups, new Promise((r) => setTimeout(r, maxWaitMs).unref?.())]);
  }
  for (const id of agentIds) if (!out.has(id)) out.set(id, accountCache.get(id)?.accountId ?? null);
  return out;
}
