// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { request } from "undici";
import type { WebSocket } from "ws";
import { MeshMessage, MeshPeerIdentity } from "../common/types.js";

const MAX_CONSECUTIVE_FAILURES = 5;

/** After this many HTTP failures, mark a peer as NATed (skip HTTP, prefer WS/relay). */
const NAT_DETECTION_THRESHOLD = 2;

export class GossipMesh {
  private peers = new Map<string, MeshPeerIdentity>();
  private wsPeers = new Map<string, WebSocket>();
  private meshToken: string | undefined;
  private failureCounts = new Map<string, number>();

  /** Peers whose coordinatorUrl is unreachable (behind NAT/firewall). */
  private natPeers = new Set<string>();

  setMeshToken(token: string): void {
    this.meshToken = token;
  }

  addPeer(peer: MeshPeerIdentity): void {
    this.peers.set(peer.peerId, peer);
  }

  removePeer(peerId: string): void {
    this.peers.delete(peerId);
    this.failureCounts.delete(peerId);
    this.natPeers.delete(peerId);
  }

  setWebSocketForPeer(peerId: string, ws: WebSocket): void {
    this.wsPeers.set(peerId, ws);
    // Peer connected via WS — clear NAT flag since we can reach them now
    this.natPeers.delete(peerId);
    this.failureCounts.delete(peerId);
  }

  removeWebSocketForPeer(peerId: string): void {
    this.wsPeers.delete(peerId);
  }

  hasWebSocket(peerId: string): boolean {
    const ws = this.wsPeers.get(peerId);
    return Boolean(ws && ws.readyState === 1);
  }

  isNatted(peerId: string): boolean {
    return this.natPeers.has(peerId);
  }

  listPeers(): MeshPeerIdentity[] {
    return [...this.peers.values()];
  }

  /**
   * Return all peer IDs that have an open WS connection.
   * Used by the coordinator to relay gossip to NATed peers.
   */
  getWsConnectedPeerIds(): string[] {
    const ids: string[] = [];
    for (const [peerId, ws] of this.wsPeers) {
      if (ws.readyState === 1) ids.push(peerId);
    }
    return ids;
  }

  async broadcast(message: MeshMessage, excludePeerId?: string): Promise<{ delivered: number; failed: number }> {
    const peers = this.listPeers().filter(p => !excludePeerId || p.peerId !== excludePeerId);
    let delivered = 0;
    let failed = 0;

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.meshToken) {
      headers["x-mesh-token"] = this.meshToken;
    }

    const serialized = JSON.stringify(message);

    await Promise.all(
      peers.map(async (peer) => {
        // ── Path 1: Direct WebSocket (best for NATed peers) ──
        const ws = this.wsPeers.get(peer.peerId);
        if (ws && ws.readyState === 1 /* OPEN */) {
          try {
            ws.send(serialized);
            delivered += 1;
            return;
          } catch {
            // WS send failed, fall through to HTTP
          }
        }

        // ── Path 2: HTTP POST (works for publicly reachable peers) ──
        // Skip HTTP for peers we know are behind NAT — go straight to relay
        if (!this.natPeers.has(peer.peerId)) {
          try {
            const res = await request(`${peer.coordinatorUrl}/mesh/ingest`, {
              method: "POST",
              headers,
              body: serialized,
              signal: AbortSignal.timeout(10_000)
            });
            const body = await res.body.text().catch(() => "");
            if (res.statusCode >= 200 && res.statusCode < 300) {
              delivered += 1;
              this.failureCounts.delete(peer.peerId);
              return;
            }
            console.warn(`[gossip] broadcast to ${peer.coordinatorUrl} failed: ${res.statusCode} ${body}`);
            this.recordFailure(peer.peerId);
          } catch (err) {
            console.warn(`[gossip] broadcast to ${peer.coordinatorUrl} error: ${(err as Error).message}`);
            this.recordFailure(peer.peerId);
          }
        }

        // ── Path 3: Relay through any WS-connected peer ──
        // If we couldn't reach the peer directly, try relaying through a
        // coordinator that may have a WS connection to them.
        if (await this.relayViaConnectedPeer(peer.peerId, serialized)) {
          delivered += 1;
          return;
        }

        failed += 1;
      })
    );

    if (peers.length > 0) {
      console.log(`[gossip] broadcast type=${message.type} to ${peers.length} peers: ${delivered} delivered, ${failed} failed`);
    }

    return { delivered, failed };
  }

  /**
   * Try relaying a message to an unreachable peer through any WS-connected
   * coordinator that might be able to forward it.
   */
  private async relayViaConnectedPeer(targetPeerId: string, serialized: string): Promise<boolean> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.meshToken) headers["x-mesh-token"] = this.meshToken;

    // Ask each WS-connected coordinator to relay to the target
    for (const [connectedId, ws] of this.wsPeers) {
      if (connectedId === targetPeerId) continue;
      if (ws.readyState !== 1) continue;

      // Look up the connected peer's HTTP URL for the relay request
      const connectedPeer = this.peers.get(connectedId);
      if (!connectedPeer) continue;

      try {
        const res = await request(`${connectedPeer.coordinatorUrl}/mesh/relay-gossip`, {
          method: "POST",
          headers,
          body: JSON.stringify({ targetPeerId, message: serialized }),
          signal: AbortSignal.timeout(8_000)
        });
        await res.body.text().catch(() => "");
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[gossip] relayed to ${targetPeerId} via ${connectedId}`);
          return true;
        }
      } catch {
        // Relay attempt failed, try next connected peer
      }
    }

    return false;
  }

  private recordFailure(peerId: string): void {
    const count = (this.failureCounts.get(peerId) ?? 0) + 1;
    this.failureCounts.set(peerId, count);

    // Mark peer as NATed after repeated failures — skip HTTP on future broadcasts
    if (count >= NAT_DETECTION_THRESHOLD && !this.natPeers.has(peerId)) {
      console.log(`[gossip] marking peer ${peerId} as NATed after ${count} HTTP failures`);
      this.natPeers.add(peerId);
    }

    if (count >= MAX_CONSECUTIVE_FAILURES) {
      // Only evict if we have no WS connection — NATed peers with WS are still reachable
      if (!this.hasWebSocket(peerId)) {
        console.warn(`[gossip] evicting unreachable peer ${peerId} after ${count} consecutive failures`);
        this.peers.delete(peerId);
        this.failureCounts.delete(peerId);
        this.natPeers.delete(peerId);
      } else {
        // Reset failure count — peer is reachable via WS
        this.failureCounts.set(peerId, 0);
      }
    }
  }
}
