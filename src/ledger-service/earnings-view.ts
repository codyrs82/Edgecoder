// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1
//
// How a coordinator operator's routing-fee earnings (routing_fee:<task> earn rows, the ledger
// service's routing share) show in an account's activity: each row names the coordinator that
// routed the call, and the account's earnings say how much of them came from routing. The rows are
// ordinary earn rows with their msat, so the earned, held and payable totals and the payouts already
// count them as they count host earnings (db/postgres.ts EARNED_MSAT_SQL).

import { ROUTING_FEE_REASON_PREFIX } from "./protocol.js";

/** The task of a routing-fee row (`routing_fee:<task>`), else null. */
export function routingFeeTaskId(reason: string | undefined | null): string | null {
  const r = String(reason ?? "");
  return r.startsWith(ROUTING_FEE_REASON_PREFIX) && r.length > ROUTING_FEE_REASON_PREFIX.length ? r.slice(ROUTING_FEE_REASON_PREFIX.length) : null;
}

/** A coordinator as people know it: its public host name, else its operator's name, else its peer id. */
export function coordinatorLabel(peerId: string, entry: { urls?: string[]; operator?: { name?: string } } | null | undefined): string {
  for (const u of entry?.urls ?? []) {
    try {
      const host = new URL(u).hostname;
      if (host) return host;
    } catch {
      /* not a URL: next one */
    }
  }
  const name = entry?.operator?.name?.trim();
  return name || peerId;
}

export interface ActivityRow {
  type: string;
  cSats: number;
  reason: string;
  taskId?: string;
  atMs: number;
  /** A routing-fee row: the coordinator that routed the call. */
  coordinator?: string;
}

/**
 * An account's recent activity (newest first, `limit` rows) and its routing-fee earnings in sats
 * (cSats; 1 cSat = 1 sat). `coordinatorFor` names the coordinator of a routing-fee row's task.
 */
export function accountActivity(
  history: Array<{ type: string; credits: number; reason: string; relatedTaskId?: string; timestampMs: number }>,
  coordinatorFor: (taskId: string) => string | undefined,
  limit = 25
): { recent: ActivityRow[]; routingFeeSats: number } {
  let routing = 0;
  for (const t of history) if (t.type === "earn" && routingFeeTaskId(t.reason)) routing += Number(t.credits) || 0;
  const recent = [...history]
    .sort((a, b) => b.timestampMs - a.timestampMs)
    .slice(0, limit)
    .map((t) => {
      const task = routingFeeTaskId(t.reason);
      const coordinator = task ? coordinatorFor(t.relatedTaskId ?? task) : undefined;
      return { type: t.type, cSats: Number(t.credits), reason: t.reason, taskId: t.relatedTaskId, atMs: t.timestampMs, ...(coordinator ? { coordinator } : {}) };
    });
  return { recent, routingFeeSats: Number(routing.toFixed(3)) };
}
