import { request } from "undici";
import {
  MeshMessage,
  MeshMessageType,
  MeshPeerIdentity,
  MeshPeerRole,
  NetworkMode,
  PeerExchangePayload
} from "../common/types.js";
import { PeerKeys, createPeerIdentity, signPayload } from "./peer.js";
import { MeshProtocol } from "./protocol.js";
import { GossipMesh } from "./gossip.js";

export interface MeshPeerConfig {
  peerId: string;
  keys: PeerKeys;
  publicUrl: string;
  networkMode: NetworkMode;
  role: MeshPeerRole;
  bootstrapUrls: string[];
  meshToken?: string;
  peerExchangeIntervalMs?: number;
  peerTtlMs?: number;
}

export interface PeerTableEntry {
  identity: MeshPeerIdentity;
  role: MeshPeerRole;
  lastSeenMs: number;
}

export type MessageHandler = (message: MeshMessage) => Promise<void>;

const MAX_PEER_EXCHANGE_ENTRIES = 50;

export class MeshPeer {
  readonly identity: MeshPeerIdentity;
  readonly protocol: MeshProtocol;
  readonly gossip: GossipMesh;
  readonly config: MeshPeerConfig;

  private peerTable = new Map<string, PeerTableEntry>();
  private messageHandlers = new Map<MeshMessageType, MessageHandler[]>();
  private peerExchangeTimer?: ReturnType<typeof setInterval>;
  private peerEvictionTimer?: ReturnType<typeof setInterval>;

  constructor(config: MeshPeerConfig) {
    this.config = config;
    this.identity = createPeerIdentity(config.keys, config.publicUrl, config.networkMode);
    this.protocol = new MeshProtocol();
    this.gossip = new GossipMesh();
    if (config.meshToken) this.gossip.setMeshToken(config.meshToken);
  }

  /** Update publicUrl after server port is known. */
  setPublicUrl(url: string): void {
    (this.config as { publicUrl: string }).publicUrl = url;
    (this.identity as { coordinatorUrl: string }).coordinatorUrl = url;
  }

  // ── Bootstrap ──

  async bootstrap(): Promise<void> {
    const headers = this.meshHeaders();

    for (const seedUrl of this.config.bootstrapUrls) {
      try {
        // Step 1: GET /identity from seed
        const idRes = await request(`${seedUrl}/identity`, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(8_000)
        });
        if (idRes.statusCode < 200 || idRes.statusCode >= 300) {
          await idRes.body.text().catch(() => undefined);
          continue;
        }
        const remote = (await idRes.body.json()) as MeshPeerIdentity & { role?: MeshPeerRole };
        if (remote.peerId === this.config.peerId) continue;

        // Step 2: Register ourselves with seed
        const regRes = await request(`${seedUrl}/mesh/register-peer`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({
            peerId: this.identity.peerId,
            publicKeyPem: this.identity.publicKeyPem,
            coordinatorUrl: this.config.publicUrl,
            networkMode: this.config.networkMode,
            role: this.config.role
          }),
          signal: AbortSignal.timeout(8_000)
        });
        await regRes.body.text().catch(() => undefined);

        // Add seed to our peer table + gossip
        this.addPeer(
          { peerId: remote.peerId, publicKeyPem: remote.publicKeyPem, coordinatorUrl: seedUrl, networkMode: remote.networkMode },
          remote.role ?? "coordinator"
        );

        // Step 3: GET /mesh/peers from seed → learn about entire mesh
        try {
          const peersRes = await request(`${seedUrl}/mesh/peers`, {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(8_000)
          });
          if (peersRes.statusCode >= 200 && peersRes.statusCode < 300) {
            const data = (await peersRes.body.json()) as { peers?: Array<MeshPeerIdentity & { role?: MeshPeerRole }> };
            for (const p of data.peers ?? []) {
              if (p.peerId !== this.config.peerId) {
                this.addPeer(p, p.role ?? "coordinator");
              }
            }
          } else {
            await peersRes.body.text().catch(() => undefined);
          }
        } catch {
          // /mesh/peers may not exist on older coordinators — non-fatal
        }

        // Step 4: Register with each newly discovered peer
        for (const entry of this.peerTable.values()) {
          if (entry.identity.peerId === remote.peerId) continue;
          await this.registerWithPeer(entry.identity).catch(() => undefined);
        }

        console.log(`[mesh-peer] bootstrapped from ${seedUrl}, ${this.peerTable.size} peers known`);
      } catch (err) {
        console.warn(`[mesh-peer] bootstrap ${seedUrl} failed: ${(err as Error).message}`);
      }
    }

    this.startPeerExchange();
    this.startPeerEviction();
  }

  private async registerWithPeer(peer: MeshPeerIdentity): Promise<void> {
    const headers = this.meshHeaders();
    const res = await request(`${peer.coordinatorUrl}/mesh/register-peer`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        peerId: this.identity.peerId,
        publicKeyPem: this.identity.publicKeyPem,
        coordinatorUrl: this.config.publicUrl,
        networkMode: this.config.networkMode,
        role: this.config.role
      }),
      signal: AbortSignal.timeout(8_000)
    });
    await res.body.text().catch(() => undefined);
  }

  // ── Peer Exchange ──

  startPeerExchange(): void {
    const intervalMs = this.config.peerExchangeIntervalMs ?? 30_000;
    this.peerExchangeTimer = setInterval(() => {
      void this.broadcastPeerExchange();
    }, intervalMs);
  }

  private async broadcastPeerExchange(): Promise<void> {
    const entries = [...this.peerTable.values()]
      .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
      .slice(0, MAX_PEER_EXCHANGE_ENTRIES);

    const payload: PeerExchangePayload = {
      peers: entries.map(e => ({
        peerId: e.identity.peerId,
        publicKeyPem: e.identity.publicKeyPem,
        peerUrl: e.identity.coordinatorUrl,
        networkMode: e.identity.networkMode,
        role: e.role,
        lastSeenMs: e.lastSeenMs
      }))
    };

    await this.broadcast("peer_exchange", payload as unknown as Record<string, unknown>);
  }

  private handlePeerExchange(message: MeshMessage): void {
    const payload = message.payload as unknown as PeerExchangePayload;
    for (const p of payload.peers ?? []) {
      if (p.peerId === this.config.peerId) continue;
      const existing = this.peerTable.get(p.peerId);
      if (existing) {
        existing.lastSeenMs = Math.max(existing.lastSeenMs, p.lastSeenMs);
      } else {
        this.addPeer(
          { peerId: p.peerId, publicKeyPem: p.publicKeyPem, coordinatorUrl: p.peerUrl, networkMode: p.networkMode },
          p.role
        );
      }
    }
  }

  // ── Peer Eviction ──

  private startPeerEviction(): void {
    const ttlMs = this.config.peerTtlMs ?? 120_000;
    this.peerEvictionTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of this.peerTable) {
        if (now - entry.lastSeenMs > ttlMs) {
          this.peerTable.delete(id);
          this.gossip.removePeer(id);
        }
      }
    }, 60_000);
  }

  // ── Message Handling ──

  on(type: MeshMessageType, handler: MessageHandler): void {
    const handlers = this.messageHandlers.get(type) ?? [];
    handlers.push(handler);
    this.messageHandlers.set(type, handlers);
  }

  async handleIngest(message: MeshMessage): Promise<{ ok: boolean; reason?: string }> {
    // Skip own messages
    if (message.fromPeerId === this.config.peerId) {
      return { ok: true, reason: "own_message" };
    }

    // Validate signature using sender's public key
    const sender = this.peerTable.get(message.fromPeerId);
    if (sender) {
      const validation = this.protocol.validateMessage(message, sender.identity.publicKeyPem);
      if (!validation.ok) return validation;
      // Update lastSeen on valid message
      sender.lastSeenMs = Date.now();
    }
    // If sender is unknown, we still process (they may be a new peer introducing themselves)

    // Handle peer_exchange internally
    if (message.type === "peer_exchange") {
      this.handlePeerExchange(message);
    }

    // Dispatch to registered handlers
    const handlers = this.messageHandlers.get(message.type) ?? [];
    for (const handler of handlers) {
      try {
        await handler(message);
      } catch (err) {
        console.warn(`[mesh-peer] handler error for ${message.type}: ${(err as Error).message}`);
      }
    }

    return { ok: true };
  }

  // ── Broadcasting ──

  async broadcast(type: MeshMessageType, payload: Record<string, unknown>, ttlMs?: number): Promise<void> {
    const msg = this.protocol.createMessage(
      type,
      this.config.peerId,
      payload,
      this.config.keys.privateKeyPem,
      ttlMs ?? 30_000
    );
    await this.gossip.broadcast(msg, this.config.peerId);
  }

  // ── Peer Table ──

  addPeer(identity: MeshPeerIdentity, role: MeshPeerRole): void {
    if (identity.peerId === this.config.peerId) return;
    this.peerTable.set(identity.peerId, {
      identity,
      role,
      lastSeenMs: Date.now()
    });
    this.gossip.addPeer(identity);
  }

  removePeer(peerId: string): void {
    this.peerTable.delete(peerId);
    this.gossip.removePeer(peerId);
  }

  getPeer(peerId: string): PeerTableEntry | undefined {
    return this.peerTable.get(peerId);
  }

  listPeers(): PeerTableEntry[] {
    return [...this.peerTable.values()];
  }

  peerCount(): number {
    return this.peerTable.size;
  }

  // ── Lifecycle ──

  async shutdown(): Promise<void> {
    if (this.peerExchangeTimer) clearInterval(this.peerExchangeTimer);
    if (this.peerEvictionTimer) clearInterval(this.peerEvictionTimer);
  }

  // ── Helpers ──

  private meshHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.config.meshToken) h["x-mesh-token"] = this.config.meshToken;
    return h;
  }
}
