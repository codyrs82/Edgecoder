// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * "A machine named X tried to connect but isn't enrolled under that name" on Settings > Nodes.
 *
 * When an agent presents a registration token under a node id that isn't enrolled (the installer
 * named it after the host, the owner enrolled another name), the portal's /internal/nodes/validate
 * matches the token's hash to its enrolment and the coordinator records the refused attempt in
 * node_status_projection under that enrolment owner's email (swarm/coordinator/enrollment.ts). The
 * owner's Nodes page lists those rows: recent, agent, not enrolled by anyone, and recorded for this
 * owner's email only, so nobody sees another account's machines.
 */

export interface ProjectionNode {
  nodeId: string;
  nodeKind: string;
  ownerEmail?: string;
  nodeApproved?: boolean;
  lastSeenMs?: number;
  updatedAtMs?: number;
}

export interface RejectedAttempt {
  nodeId: string;
  lastAttemptMs: number;
}

/** Attempts older than this are not shown. */
export const REJECTED_ATTEMPT_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const MAX_REJECTED_ATTEMPTS = 20;

export async function rejectedAttemptsForOwner(input: {
  ownerEmail: string;
  nodes: ProjectionNode[];
  /** True when the node id is enrolled (by anyone): enrolled names are not "unenrolled attempts". */
  isEnrolled: (nodeId: string) => Promise<boolean>;
  nowMs: number;
  windowMs?: number;
}): Promise<RejectedAttempt[]> {
  const email = input.ownerEmail.trim().toLowerCase();
  if (!email) return [];
  const windowMs = input.windowMs ?? REJECTED_ATTEMPT_WINDOW_MS;
  const latest = new Map<string, number>();
  for (const n of input.nodes) {
    if (n.nodeKind !== "agent" || n.nodeApproved === true) continue;
    // Coordinators filter by owner email already; checked again so a coordinator that ignored the
    // filter cannot show one account another's attempts.
    if ((n.ownerEmail ?? "").trim().toLowerCase() !== email) continue;
    const at = Number(n.lastSeenMs ?? n.updatedAtMs ?? 0);
    if (!Number.isFinite(at) || at <= 0 || input.nowMs - at > windowMs) continue;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(n.nodeId)) continue;
    latest.set(n.nodeId, Math.max(latest.get(n.nodeId) ?? 0, at));
  }
  const out: RejectedAttempt[] = [];
  for (const [nodeId, lastAttemptMs] of [...latest.entries()].sort((a, b) => b[1] - a[1])) {
    if (out.length >= MAX_REJECTED_ATTEMPTS) break;
    if (await input.isEnrolled(nodeId)) continue;
    out.push({ nodeId, lastAttemptMs });
  }
  return out;
}
