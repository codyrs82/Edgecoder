// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Socket liveness (#524): an agent whose authenticated mesh WebSocket closed is gone for routing at
 * once, not when its last heartbeat is AGENT_CONNECTED_WINDOW_MS (2 min) old.
 *
 * The coordinator sees a dead machine's socket close within seconds (the WebSocket ping times out),
 * but the agent's capability record stayed "connected" for two minutes: its free slots were still
 * offered to best fit, to the portal (/inference/models) and to peers (/network/world/local), and a
 * claim it held waited out the 45 s lease before anyone else could run it.
 *
 * Three cases, told apart by what the coordinator has seen from the agent:
 * - Never had a socket (HTTP pull only: older agents, iOS on battery, a WebSocket blocked by a
 *   proxy): not affected. The 2-minute window is all there is for them, as before.
 * - Had one and it is open: live.
 * - Had one and it closed, and nothing has come over HTTP since (no pull, heartbeat, chunk or
 *   result): lost. A live agent whose socket merely dropped keeps pulling over HTTP while it
 *   reconnects (every 1-3 s), so one request is enough to make it routable again.
 *
 * Pure bookkeeping, no imports: memory-admission.ts (agentUnavailable) and dispatch.ts read it.
 */

/** A claim held by a lost agent is handed to another agent once it has been lost this long. */
export const SOCKET_LOST_CLAIM_GRACE_MS = 20_000;
/** Entries for agents not heard from in this long are dropped. */
const KEEP_MS = 60 * 60_000;

interface SocketState {
  open: boolean;
  openedAtMs: number;
  closedAtMs?: number;
}

const sockets = new Map<string, SocketState>();
const httpAt = new Map<string, number>();

/** An authenticated mesh socket for `agentId` went live. */
export function noteAgentSocketOpen(agentId: string, nowMs = Date.now()): void {
  sockets.set(agentId, { open: true, openedAtMs: nowMs });
}

/** The authenticated mesh socket for `agentId` closed (only the connection holding the binding). */
export function noteAgentSocketClosed(agentId: string, nowMs = Date.now()): void {
  const s = sockets.get(agentId);
  sockets.set(agentId, { open: false, openedAtMs: s?.openedAtMs ?? nowMs, closedAtMs: nowMs });
}

/** A signed HTTP request from the agent (pull, heartbeat, chunk, result, register): it is alive. */
export function noteAgentHttpAlive(agentId: string, nowMs = Date.now()): void {
  httpAt.set(agentId, nowMs);
}

/** How long `agentId` has been lost (socket closed, nothing over HTTP since); null when it is not. */
export function socketLostForMs(agentId: string, nowMs = Date.now()): number | null {
  const s = sockets.get(agentId);
  if (!s || s.open || s.closedAtMs === undefined) return null;
  if ((httpAt.get(agentId) ?? -Infinity) > s.closedAtMs) return null;
  return Math.max(0, nowMs - s.closedAtMs);
}

/** The agent had a socket, it closed, and it has not been heard from since: offer it no new work. */
export function agentSocketLost(agentId: string, nowMs = Date.now()): boolean {
  return socketLostForMs(agentId, nowMs) !== null;
}

/** Agents lost for at least `minMs` (the claim sweep). */
export function agentsLostFor(minMs: number, nowMs = Date.now()): string[] {
  const out: string[] = [];
  for (const id of sockets.keys()) {
    const lost = socketLostForMs(id, nowMs);
    if (lost !== null && lost >= minMs) out.push(id);
  }
  return out;
}

export function pruneAgentLiveness(nowMs = Date.now()): void {
  for (const [id, s] of sockets) if (!s.open && nowMs - (s.closedAtMs ?? s.openedAtMs) > KEEP_MS) sockets.delete(id);
  for (const [id, at] of httpAt) if (nowMs - at > KEEP_MS && !sockets.has(id)) httpAt.delete(id);
}
setInterval(() => pruneAgentLiveness(), 10 * 60_000).unref?.();

/** Tests. */
export function resetAgentLiveness(): void {
  sockets.clear();
  httpAt.clear();
}
