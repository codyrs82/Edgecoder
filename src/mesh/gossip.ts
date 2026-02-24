import { request } from "undici";
import { MeshMessage, MeshPeerIdentity } from "../common/types.js";

export class GossipMesh {
  private peers = new Map<string, MeshPeerIdentity>();
  private meshToken: string | undefined;

  setMeshToken(token: string): void {
    this.meshToken = token;
  }

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

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.meshToken) {
      headers["x-mesh-token"] = this.meshToken;
    }

    await Promise.all(
      peers.map(async (peer) => {
        try {
          const res = await request(`${peer.coordinatorUrl}/mesh/ingest`, {
            method: "POST",
            headers,
            body: JSON.stringify(message),
            signal: AbortSignal.timeout(10_000)
          });
          const body = await res.body.text().catch(() => "");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            delivered += 1;
          } else {
            console.warn(`[gossip] broadcast to ${peer.coordinatorUrl} failed: ${res.statusCode} ${body}`);
            failed += 1;
          }
        } catch (err) {
          console.warn(`[gossip] broadcast to ${peer.coordinatorUrl} error: ${(err as Error).message}`);
          failed += 1;
        }
      })
    );

    if (peers.length > 0) {
      console.log(`[gossip] broadcast type=${message.type} to ${peers.length} peers: ${delivered} delivered, ${failed} failed`);
    }

    return { delivered, failed };
  }
}
