// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

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
import { moduleLogger } from "../common/logger.js";

const logger = moduleLogger("mesh-peer");
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
  /**
   * The entry came from the coordinator this peer bootstrapped from (its /identity, its
   * /mesh/peers list, its peer_exchange) or from a caller-verified identity. Only trusted
   * entries are gossip targets, so the mesh token is only sent to URLs the coordinator gave us.
   */
  trusted: boolean;
}

export interface AddPeerOptions {
  /** See PeerTableEntry.trusted. A trusted add may replace an existing entry. */
  trusted?: boolean;
}

export type MessageHandler = (message: MeshMessage) => Promise<void>;

const MAX_PEER_EXCHANGE_ENTRIES = 50;
/** Cap on entries learned from untrusted sources (/mesh/register-peer, peers' peer_exchange). */
export const MAX_UNTRUSTED_PEERS = 256;

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

  /** Set (or rotate) the mesh token used on outbound mesh requests and gossip. */
  setMeshToken(token: string | undefined): void {
    (this.config as { meshToken?: string }).meshToken = token || undefined;
    if (token) this.gossip.setMeshToken(token);
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

        // Add seed to our peer table + gossip. Seeds are the configured coordinator URLs.
        this.addPeer(
          { peerId: remote.peerId, publicKeyPem: remote.publicKeyPem, coordinatorUrl: seedUrl, networkMode: remote.networkMode },
          remote.role ?? "coordinator",
          { trusted: true }
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
                // The coordinator's own list (it admits and URL-pins its peers).
                this.addPeer(p, p.role ?? "coordinator", { trusted: true });
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
          if (entry.identity.peerId === remote.peerId || !entry.trusted) continue;
          await this.registerWithPeer(entry.identity).catch(() => undefined);
        }

        logger.info({ bootstrapUrl: seedUrl, peers: this.peerTable.size }, "mesh bootstrapped");
      } catch (err) {
        logger.warn({ bootstrapUrl: seedUrl, error: (err as Error).message }, "mesh bootstrap failed");
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
    // Entries are trusted only when a trusted coordinator sent the list; anything else (another
    // agent, a self-registered peer) can name arbitrary URLs and must not become a gossip target.
    const sender = this.peerTable.get(message.fromPeerId);
    const fromCoordinator = sender?.trusted === true && sender.role === "coordinator";
    const peers = Array.isArray(payload.peers) ? payload.peers.slice(0, MAX_PEER_EXCHANGE_ENTRIES) : [];
    for (const p of peers) {
      if (!p || typeof p.peerId !== "string" || p.peerId === this.config.peerId) continue;
      const existing = this.peerTable.get(p.peerId);
      if (existing) {
        // Only the coordinator's view keeps another entry alive.
        if (fromCoordinator && Number.isFinite(p.lastSeenMs)) {
          existing.lastSeenMs = Math.max(existing.lastSeenMs, Math.min(p.lastSeenMs, Date.now()));
        }
        continue;
      }
      if (typeof p.publicKeyPem !== "string" || typeof p.peerUrl !== "string") continue;
      this.addPeer(
        { peerId: p.peerId, publicKeyPem: p.publicKeyPem, coordinatorUrl: p.peerUrl, networkMode: p.networkMode },
        p.role,
        { trusted: fromCoordinator }
      );
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
    // Only peers in the table (added by bootstrap or /mesh/register-peer) are heard, and only
    // with a valid signature from the key on file.
    const sender = this.peerTable.get(message.fromPeerId);
    if (!sender) return { ok: false, reason: "unknown_sender" };
    const validation = this.protocol.validateMessage(message, sender.identity.publicKeyPem);
    if (!validation.ok) return validation;
    sender.lastSeenMs = Date.now();

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
        logger.warn({ type: message.type, error: (err as Error).message }, "mesh handler error");
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

  /**
   * Add a peer. An untrusted add (the default: /mesh/register-peer, a peer's peer_exchange) never
   * replaces an existing entry, is recorded as role "agent", is capped at MAX_UNTRUSTED_PEERS and
   * is not a gossip target: its key only verifies the messages it sends us. Returns false when
   * the add is refused.
   */
  addPeer(identity: MeshPeerIdentity, role: MeshPeerRole, opts: AddPeerOptions = {}): boolean {
    if (identity.peerId === this.config.peerId) return false;
    const trusted = opts.trusted === true;
    const existing = this.peerTable.get(identity.peerId);
    if (!trusted) {
      if (existing) {
        const same =
          existing.identity.publicKeyPem.trim() === identity.publicKeyPem.trim() &&
          existing.identity.coordinatorUrl === identity.coordinatorUrl;
        if (same) existing.lastSeenMs = Date.now();
        return same;
      }
      let untrusted = 0;
      for (const e of this.peerTable.values()) if (!e.trusted) untrusted++;
      if (untrusted >= MAX_UNTRUSTED_PEERS) return false;
    }
    this.peerTable.set(identity.peerId, {
      identity,
      role: trusted ? role : "agent",
      lastSeenMs: Date.now(),
      trusted
    });
    if (trusted) this.gossip.addPeer(identity);
    return true;
  }

  /**
   * Whether an ingested message came from `expected` (e.g. the worker's verified coordinator).
   * handleIngest checks the signature against the table entry's key, so the sender is `expected`
   * only when the id matches and the key on file is `expected`'s key: a self-registered entry
   * squatting the id fails here.
   */
  isFromIdentity(message: Pick<MeshMessage, "fromPeerId">, expected: { peerId: string; publicKeyPem: string } | null | undefined): boolean {
    if (!expected || message.fromPeerId !== expected.peerId) return false;
    const entry = this.peerTable.get(message.fromPeerId);
    return entry !== undefined && entry.identity.publicKeyPem.trim() === expected.publicKeyPem.trim();
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
