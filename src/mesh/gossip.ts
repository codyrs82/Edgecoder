import { request } from "undici";
import { MeshMessage, MeshPeerIdentity } from "../common/types.js";

export class GossipMesh {
  private peers = new Map<string, MeshPeerIdentity>();

  addPeer(peer: MeshPeerIdentity): void {
    this.peers.set(peer.peerId, peer);
  }

  removePeer(peerId: string): void {
    this.peers.delete(peerId);
  }

  listPeers(): MeshPeerIdentity[] {
    return [...this.peers.values()];
  }

  async broadcast(message: MeshMessage): Promise<{ delivered: number; failed: number }> {
    const peers = this.listPeers();
    let delivered = 0;
    let failed = 0;

    await Promise.all(
      peers.map(async (peer) => {
        try {
          const res = await request(`${peer.coordinatorUrl}/mesh/ingest`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(message)
          });
          if (res.statusCode >= 200 && res.statusCode < 300) {
            delivered += 1;
          } else {
            failed += 1;
          }
        } catch {
          failed += 1;
        }
      })
    );

    return { delivered, failed };
  }
}
