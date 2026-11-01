// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1
//
// Coordinator side of discovery: build and sign the self-announcement, publish it to Nostr on
// an interval, learn peers' announcements from the relays, and expose both over HTTP.

import type { FastifyInstance } from "fastify";
import type { PeerKeys } from "../mesh/peer.js";
import { buildAnnouncementEvent, fetchNostrAnnouncements, nostrKeysFromSecret, nostrRelaysFromEnv, publishNostrEvent, type NostrEvent, type NostrKeys, type PublishResult, type WsConnect } from "./nostr.js";
import { parseAnnouncement, signAnnouncement, verifyAnnouncement, type CoordinatorAnnouncement } from "./types.js";

export interface AnnouncementStore {
  /** Verify and keep `a` when it is newer than what is stored for its peerId. Returns true when stored. */
  upsert(a: unknown): boolean;
  list(): CoordinatorAnnouncement[];
  prune(): void;
  size(): number;
}

export function createAnnouncementStore(opts: { maxAgeMs?: number; max?: number; now?: () => number; selfPeerId?: string } = {}): AnnouncementStore {
  const byPeer = new Map<string, CoordinatorAnnouncement>();
  const now = opts.now ?? Date.now;
  const maxAge = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const max = opts.max ?? 256;
  const prune = () => {
    const t = now();
    for (const [peerId, a] of byPeer) if (t - a.announcedAtMs > maxAge) byPeer.delete(peerId);
    if (byPeer.size > max) {
      const sorted = [...byPeer.values()].sort((x, y) => y.announcedAtMs - x.announcedAtMs);
      byPeer.clear();
      for (const a of sorted.slice(0, max)) byPeer.set(a.peerId, a);
    }
  };
  return {
    upsert(raw) {
      const a = parseAnnouncement(raw);
      if (!a || a.peerId === opts.selfPeerId) return false;
      if (!verifyAnnouncement(a, { maxAgeMs: maxAge, now }).ok) return false;
      const prev = byPeer.get(a.peerId);
      if (prev && prev.announcedAtMs >= a.announcedAtMs) return false;
      byPeer.set(a.peerId, a);
      prune();
      return true;
    },
    list: () => [...byPeer.values()].sort((x, y) => y.announcedAtMs - x.announcedAtMs),
    prune,
    size: () => byPeer.size
  };
}

export interface AnnouncerOptions {
  identity: PeerKeys;
  url: string;
  region?: string;
  services?: string[];
  computeClasses?: string[];
  version?: string;
  /** Publish to Nostr (EDGECODER_NOSTR_ANNOUNCE=1). When false only the HTTP routes are served. */
  enabled?: boolean;
  relays?: string[];
  /** Publish interval (default 5 min). */
  intervalMs?: number;
  /** Nostr secret (NOSTR_SECRET_KEY_HEX); when unset one is derived from the Ed25519 private key. */
  nostrSecretKeyHex?: string;
  /** Per-relay timeout (default 5 s). */
  timeoutMs?: number;
  now?: () => number;
  connect?: WsConnect;
  /** Injectable for tests. */
  publish?: (event: NostrEvent, relays: string[]) => Promise<PublishResult[]>;
  fetchPeers?: (relays: string[]) => Promise<CoordinatorAnnouncement[]>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
}

export interface CoordinatorAnnouncer {
  /** Fresh, signed self-announcement. */
  self(): CoordinatorAnnouncement;
  /** Nostr pubkey (hex) this coordinator signs events with, or null when Nostr is disabled. */
  nostrPubkey(): string | null;
  peers: AnnouncementStore;
  /** Publish once and refresh peers; resolves with per-relay results (empty when disabled). */
  announceNow(): Promise<PublishResult[]>;
  stop(): void;
  readonly enabled: boolean;
  readonly relays: string[];
}

/**
 * Start the announcer. Never throws and never blocks: the first publish is scheduled with
 * setTimeout and every relay call carries a timeout. Returns a handle usable even when disabled.
 */
export function startCoordinatorAnnouncer(opts: AnnouncerOptions): CoordinatorAnnouncer {
  const now = opts.now ?? Date.now;
  const env = opts.env ?? process.env;
  const enabled = opts.enabled ?? env.EDGECODER_NOSTR_ANNOUNCE === "1";
  const relays = opts.relays ?? nostrRelaysFromEnv(env);
  const intervalMs = Math.max(15_000, opts.intervalMs ?? Number(env.EDGECODER_NOSTR_ANNOUNCE_INTERVAL_MS ?? "300000"));
  const timeoutMs = opts.timeoutMs ?? 5000;
  const log = opts.log ?? (() => {});
  const region = opts.region ?? env.COORDINATOR_REGION ?? env.FLY_REGION ?? "unknown";
  const peers = createAnnouncementStore({ now, selfPeerId: opts.identity.peerId });

  let keys: NostrKeys | null = null;
  if (enabled) {
    try {
      keys = nostrKeysFromSecret(opts.nostrSecretKeyHex ?? env.NOSTR_SECRET_KEY_HEX, opts.identity.privateKeyPem);
    } catch (err) {
      log("discovery_nostr_key_invalid", { error: String(err) });
    }
  }

  const self = (): CoordinatorAnnouncement =>
    signAnnouncement(
      {
        peerId: opts.identity.peerId,
        publicKeyPem: opts.identity.publicKeyPem,
        url: opts.url.replace(/\/+$/, ""),
        region,
        services: opts.services ?? ["swarm"],
        computeClasses: opts.computeClasses ?? [],
        version: opts.version ?? env.EDGECODER_VERSION ?? "",
        announcedAtMs: now()
      },
      opts.identity.privateKeyPem
    );

  const publish = opts.publish ?? ((event: NostrEvent, r: string[]) => publishNostrEvent(event, { relays: r, timeoutMs, connect: opts.connect }));
  const fetchPeers = opts.fetchPeers ?? ((r: string[]) => fetchNostrAnnouncements({ relays: r, timeoutMs, connect: opts.connect, verify: { now } }));

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const announceNow = async (): Promise<PublishResult[]> => {
    if (!enabled || !keys || relays.length === 0) return [];
    let results: PublishResult[] = [];
    try {
      const event = buildAnnouncementEvent(self(), keys);
      results = await publish(event, relays);
      log("discovery_nostr_published", { ok: results.filter((r) => r.ok).length, relays: results.length, pubkey: keys.pubkeyHex });
    } catch (err) {
      log("discovery_nostr_publish_failed", { error: String(err) });
    }
    try {
      const found = await fetchPeers(relays);
      let added = 0;
      for (const a of found) if (peers.upsert(a)) added += 1;
      log("discovery_nostr_peers", { found: found.length, added, known: peers.size() });
    } catch (err) {
      log("discovery_nostr_fetch_failed", { error: String(err) });
    }
    return results;
  };
  const tick = () => {
    if (stopped) return;
    void announceNow().finally(() => {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    });
  };
  if (enabled && keys && relays.length > 0) {
    timer = setTimeout(tick, 1000);
    timer.unref?.();
    log("discovery_nostr_announcer_started", { relays, intervalMs, pubkey: keys.pubkeyHex });
  }
  return {
    self,
    nostrPubkey: () => keys?.pubkeyHex ?? null,
    peers,
    announceNow,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    enabled: Boolean(enabled && keys),
    relays
  };
}

/**
 * GET /discovery/announcement  signed self-description
 * GET /discovery/peers         verified announcements learned from Nostr
 * These are public read-only routes: agents call them before they hold a mesh token.
 */
export function registerDiscoveryRoutes(app: FastifyInstance, announcer: Pick<CoordinatorAnnouncer, "self" | "peers" | "nostrPubkey" | "enabled" | "relays">): void {
  app.get("/discovery/announcement", async () => ({
    announcement: announcer.self(),
    nostr: { enabled: announcer.enabled, pubkey: announcer.nostrPubkey(), relays: announcer.relays }
  }));
  app.get("/discovery/peers", async () => {
    announcer.peers.prune();
    return { peers: announcer.peers.list() };
  });
}
