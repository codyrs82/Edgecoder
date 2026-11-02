import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { createAnnouncementStore, registerDiscoveryRoutes, startCoordinatorAnnouncer } from "../../src/discovery/announce.js";
import { announcementFromEvent, type NostrEvent } from "../../src/discovery/nostr.js";
import { signAnnouncement, verifyAnnouncement, type CoordinatorAnnouncement } from "../../src/discovery/types.js";

const NOW = 1_700_000_000_000;
const self = createPeerKeys("coord-self");
const peer = createPeerKeys("coord-peer");

function peerAnnouncement(announcedAtMs = NOW, url = "https://peer.example"): CoordinatorAnnouncement {
  return signAnnouncement({ peerId: peer.peerId, publicKeyPem: peer.publicKeyPem, url, region: "fra", services: ["swarm"], computeClasses: [], version: "1", announcedAtMs }, peer.privateKeyPem);
}

describe("announcement store", () => {
  it("keeps only verified, newest-per-peer, non-self announcements", () => {
    const store = createAnnouncementStore({ now: () => NOW, selfPeerId: self.peerId });
    expect(store.upsert(peerAnnouncement(NOW - 10))).toBe(true);
    expect(store.upsert(peerAnnouncement(NOW - 20))).toBe(false); // older
    expect(store.upsert(peerAnnouncement(NOW))).toBe(true);
    expect(store.upsert({ ...peerAnnouncement(NOW + 1), url: "https://evil.example" })).toBe(false); // bad signature
    expect(store.upsert(signAnnouncement({ peerId: self.peerId, publicKeyPem: self.publicKeyPem, url: "https://self.example", region: "x", services: [], computeClasses: [], version: "", announcedAtMs: NOW }, self.privateKeyPem))).toBe(false);
    expect(store.upsert("junk")).toBe(false);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].announcedAtMs).toBe(NOW);
  });

  it("prunes stale entries", () => {
    let now = NOW;
    const store = createAnnouncementStore({ now: () => now, maxAgeMs: 1000 });
    expect(store.upsert(peerAnnouncement(NOW))).toBe(true);
    now += 2000;
    store.prune();
    expect(store.size()).toBe(0);
  });
});

describe("startCoordinatorAnnouncer", () => {
  const handles: Array<{ stop(): void }> = [];
  afterEach(() => {
    for (const h of handles.splice(0)) h.stop();
  });

  it("signs a fresh self-announcement and stays inert when disabled", async () => {
    const announcer = startCoordinatorAnnouncer({ identity: self, url: "https://self.example/", region: "ord", services: ["swarm"], enabled: false, now: () => NOW, env: {} });
    handles.push(announcer);
    const a = announcer.self();
    expect(a).toMatchObject({ peerId: self.peerId, publicKeyPem: self.publicKeyPem, url: "https://self.example", region: "ord", announcedAtMs: NOW });
    expect(verifyAnnouncement(a, { now: () => NOW })).toEqual({ ok: true });
    expect(announcer.enabled).toBe(false);
    expect(announcer.nostrPubkey()).toBeNull();
    expect(await announcer.announceNow()).toEqual([]);
  });

  it("publishes a signed event to the relays and learns peers on each announce", async () => {
    const published: Array<{ event: NostrEvent; relays: string[] }> = [];
    const logs: string[] = [];
    const announcer = startCoordinatorAnnouncer({
      identity: self,
      url: "https://self.example",
      region: "ord",
      enabled: true,
      relays: ["wss://r1", "wss://r2"],
      nostrSecretKeyHex: "33".repeat(32),
      now: () => NOW,
      intervalMs: 60_000,
      env: {},
      publish: async (event, relays) => {
        published.push({ event, relays });
        return relays.map((relay) => ({ relay, ok: true }));
      },
      fetchPeers: async () => [peerAnnouncement()],
      log: (msg) => logs.push(msg)
    });
    handles.push(announcer);
    expect(announcer.enabled).toBe(true);
    expect(announcer.nostrPubkey()).toMatch(/^[0-9a-f]{64}$/);
    const results = await announcer.announceNow();
    expect(results.every((r) => r.ok)).toBe(true);
    expect(published).toHaveLength(1);
    expect(published[0].relays).toEqual(["wss://r1", "wss://r2"]);
    expect(published[0].event.pubkey).toBe(announcer.nostrPubkey());
    const inner = announcementFromEvent(published[0].event, { now: () => NOW });
    expect(inner?.peerId).toBe(self.peerId);
    expect(announcer.peers.list().map((p) => p.peerId)).toEqual([peer.peerId]);
    expect(logs).toContain("discovery_nostr_announcer_started");
    expect(logs).toContain("discovery_nostr_published");
  });

  it("never throws when publishing or fetching fails", async () => {
    const announcer = startCoordinatorAnnouncer({
      identity: self,
      url: "https://self.example",
      enabled: true,
      relays: ["wss://r1"],
      now: () => NOW,
      env: {},
      publish: async () => {
        throw new Error("relay exploded");
      },
      fetchPeers: async () => {
        throw new Error("relay exploded again");
      }
    });
    handles.push(announcer);
    await expect(announcer.announceNow()).resolves.toEqual([]);
  });

  it("reads the enable flag, relays and interval from env when not given", () => {
    const announcer = startCoordinatorAnnouncer({ identity: self, url: "https://self.example", env: { EDGECODER_NOSTR_ANNOUNCE: "1", EDGECODER_NOSTR_RELAYS: "wss://only", FLY_REGION: "ams" }, now: () => NOW, publish: async () => [], fetchPeers: async () => [] });
    handles.push(announcer);
    expect(announcer.enabled).toBe(true);
    expect(announcer.relays).toEqual(["wss://only"]);
    expect(announcer.self().region).toBe("ams");
  });
});

describe("discovery routes", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it("serves the signed self announcement and known peers", async () => {
    app = Fastify();
    const announcer = startCoordinatorAnnouncer({ identity: self, url: "https://self.example", region: "ord", enabled: false, now: () => NOW, env: {} });
    announcer.peers.upsert(peerAnnouncement());
    registerDiscoveryRoutes(app, announcer);
    await app.ready();

    const selfRes = await app.inject({ method: "GET", url: "/discovery/announcement" });
    expect(selfRes.statusCode).toBe(200);
    const body = selfRes.json() as { announcement: CoordinatorAnnouncement; nostr: { enabled: boolean; pubkey: string | null } };
    expect(verifyAnnouncement(body.announcement, { now: () => NOW })).toEqual({ ok: true });
    expect(body.announcement.url).toBe("https://self.example");
    expect(body.nostr).toEqual({ enabled: false, pubkey: null, relays: expect.any(Array) });

    const peersRes = await app.inject({ method: "GET", url: "/discovery/peers" });
    expect(peersRes.statusCode).toBe(200);
    const peers = (peersRes.json() as { peers: CoordinatorAnnouncement[] }).peers;
    expect(peers).toHaveLength(1);
    expect(peers[0].peerId).toBe(peer.peerId);
    expect(verifyAnnouncement(peers[0], { now: () => NOW }).ok).toBe(true);
  });
});
