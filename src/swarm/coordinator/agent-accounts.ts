// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { pgStore } from "../../db/store.js";

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
