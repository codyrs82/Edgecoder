// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * Worker side of /agent-mesh/connect: which listed peers to try this heartbeat pass, and an hour's
 * back-off from a peer the coordinator refused (403: another account, or no verified account).
 * Mirrors the back-off the direct-work offer path keeps in lastOfferAtByPeer.
 */

export const MESH_CONNECT_REFUSED_BACKOFF_MS = 60 * 60_000;
export const MESH_CONNECT_ATTEMPTS_PER_PASS = 2;

export class MeshConnectBackoff {
  private readonly refusedUntil = new Map<string, number>();

  /** Up to `max` peers worth a connect now: not self, not blacklisted, no tunnel, not backing off. */
  pick(
    peers: readonly string[],
    opts: { self: string; nowMs: number; blacklisted: (id: string) => boolean; hasTunnel: (id: string) => boolean; max?: number }
  ): string[] {
    const max = opts.max ?? MESH_CONNECT_ATTEMPTS_PER_PASS;
    const out: string[] = [];
    for (const id of peers) {
      if (out.length >= max) break;
      if (id === opts.self || opts.blacklisted(id) || opts.hasTunnel(id)) continue;
      if (this.isBackingOff(id, opts.nowMs)) continue;
      out.push(id);
    }
    return out;
  }

  /** Record a connect answer: a 403 starts the back-off; a success clears it. */
  note(peerId: string, statusCode: number, nowMs: number): void {
    if (statusCode === 403) this.refusedUntil.set(peerId, nowMs + MESH_CONNECT_REFUSED_BACKOFF_MS);
    else if (statusCode >= 200 && statusCode < 300) this.refusedUntil.delete(peerId);
  }

  isBackingOff(peerId: string, nowMs: number): boolean {
    const until = this.refusedUntil.get(peerId);
    if (until === undefined) return false;
    if (nowMs >= until) {
      this.refusedUntil.delete(peerId);
      return false;
    }
    return true;
  }
}
