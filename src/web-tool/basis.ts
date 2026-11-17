// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Free web on your own machine (docs/web-tool.md): who may claim it, and how free calls are kept
 * in the usage records. Used by the coordinator's web tool routes (routes/web-tools.ts).
 */
import type { CallerAccount } from "../swarm/coordinator/auth.js";
import type { UsageRecord } from "../economy/usage.js";
import type { FreeWebCount, WebCallBasis } from "./service.js";

/**
 * Whether a call's `ownMachine` claim stands. The portal (service token) is trusted: it set the claim
 * from the compute it resolved. A signed agent only for the account it belongs to: its owner must
 * be the billed account (an unlinked agent, or one whose owner differs, can't make anything free).
 */
export function ownMachineBasis(caller: CallerAccount, claimed: boolean | undefined): WebCallBasis {
  if (claimed !== true) return {};
  if (caller.via === "portal") return { ownMachine: true };
  return caller.ownerAccountId !== null && caller.ownerAccountId === caller.accountId ? { ownMachine: true } : {};
}

/**
 * Free web calls in the usage records (ops visibility; no cSats move): one record per account per
 * UTC day per coordinator, rewritten with the day's totals after each free call.
 */
export function freeWebUsageRecord(accountId: string, count: FreeWebCount, coordinatorId: string, nowMs = Date.now()): UsageRecord {
  return {
    id: `webfree:${coordinatorId}:${accountId}:${count.day}`,
    accountId,
    atMs: nowMs,
    kind: "web",
    placement: "mine",
    source: "web tool (free, your machine)",
    ok: true,
    durationMs: 0,
    costMsat: 0,
    webFree: { searches: count.searches, reads: count.reads },
  };
}
