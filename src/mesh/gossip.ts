// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { request } from "undici";
import type { WebSocket } from "ws";
import { MeshMessage, MeshPeerIdentity } from "../common/types.js";

const MAX_CONSECUTIVE_FAILURES = 5;

export class GossipMesh {
  private peers = new Map<string, MeshPeerIdentity>();
  private wsPeers = new Map<string, WebSocket>();
  private meshToken: string | undefined;
  private failureCounts = new Map<string, number>();

  setMeshToken(token: string): void {
    this.meshToken = token;
  }

  addPeer(peer: MeshPeerIdentity): void {
    this.peers.set(peer.peerId, peer);
  }

  removePeer(peerId: string): void {
    this.peers.delete(peerId);
    this.failureCounts.delete(peerId);
  }

  setWebSocketForPeer(peerId: string, ws: WebSocket): void {
    this.wsPeers.set(peerId, ws);
  }

  removeWebSocketForPeer(peerId: string): void {
    this.wsPeers.delete(peerId);
  }

  listPeers(): MeshPeerIdentity[] {
    return [...this.peers.values()];
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
        // Try WebSocket first (handles NAT traversal)
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

        // HTTP POST fallback (works for same-network peers)
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
          } else {
            console.warn(`[gossip] broadcast to ${peer.coordinatorUrl} failed: ${res.statusCode} ${body}`);
            failed += 1;
            this.recordFailure(peer.peerId);
          }
        } catch (err) {
          console.warn(`[gossip] broadcast to ${peer.coordinatorUrl} error: ${(err as Error).message}`);
          failed += 1;
          this.recordFailure(peer.peerId);
        }
      })
    );

    if (peers.length > 0) {
      console.log(`[gossip] broadcast type=${message.type} to ${peers.length} peers: ${delivered} delivered, ${failed} failed`);
    }

    return { delivered, failed };
  }

  private recordFailure(peerId: string): void {
    const count = (this.failureCounts.get(peerId) ?? 0) + 1;
    this.failureCounts.set(peerId, count);
    if (count >= MAX_CONSECUTIVE_FAILURES) {
      console.warn(`[gossip] evicting peer ${peerId} after ${count} consecutive failures`);
      this.peers.delete(peerId);
      this.failureCounts.delete(peerId);
    }
  }
}
