import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { discoverCoordinators, parseStaticUrls, selectCoordinator, selectCoordinatorFromEnv, selectOptionsFromEnv } from "../../src/discovery/index.js";
import { buildAnnouncementEvent, nostrKeysFromSecret, type NostrEvent, type WsLike } from "../../src/discovery/nostr.js";
import type { FetchLike } from "../../src/discovery/selector.js";
import { signAnnouncement, type CoordinatorAnnouncement } from "../../src/discovery/types.js";
import type { DnsResolver } from "../../src/discovery/dns.js";

const NOW = 1_700_000_000_000;
const nostrCoord = createPeerKeys("coord-nostr");
const peerCoord = createPeerKeys("coord-peer");

const ann = (k: ReturnType<typeof createPeerKeys>, url: string, region: string): CoordinatorAnnouncement =>
  signAnnouncement({ peerId: k.peerId, publicKeyPem: k.publicKeyPem, url, region, services: ["swarm"], computeClasses: ["cpu.std"], version: "1", announcedAtMs: NOW }, k.privateKeyPem);

function relayWith(events: NostrEvent[]) {
  return (): WsLike => {
    const ws: WsLike = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close() {},
      send(data) {
        const msg = JSON.parse(data) as unknown[];
        if (msg[0] !== "REQ") return;
        queueMicrotask(() => {
          for (const e of events) ws.onmessage?.({ data: JSON.stringify(["EVENT", msg[1], e]) });
          ws.onmessage?.({ data: JSON.stringify(["EOSE", msg[1]]) });
        });
      }
    };
    queueMicrotask(() => ws.onopen?.({}));
    return ws;
  };
}

const resolver: DnsResolver = {
  resolveTxt: async () => [["v=ec1 url=https://dns.example region=ord peer=coord-dns"], ["v=ec1 url=https://static.example/ region=ord"]],
  resolveSrv: async () => []
};

/** Serves /health/runtime for every host, and /discovery/peers from static.example only. */
function fakeFetch(down: string[] = []): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (down.includes(u.host)) throw new Error("down");
    if (u.pathname === "/discovery/peers") {
      if (u.host === "static.example") return { status: 200, json: async () => ({ peers: [ann(peerCoord, "https://peer.example", "fra"), { junk: true }] }) };
      return { status: 404, json: async () => ({}) };
    }
    if (u.pathname === "/health/runtime") return { status: 200, json: async () => ({ ok: true, coordinator: { queued: u.host === "peer.example" ? 50 : 0, agents: 2 } }) };
    return { status: 401, json: async () => ({}) };
  };
  return { fetch, calls };
}

describe("parseStaticUrls", () => {
  it("merges every static env list, normalizing and de-duplicating", () => {
    expect(parseStaticUrls({})).toEqual([]);
    expect(parseStaticUrls({ COORDINATOR_DISCOVERY_URLS: "https://a/, https://b", COORDINATOR_BOOTSTRAP_URLS: "https://b,https://c", COORDINATOR_DISCOVERY_URL: "junk" })).toEqual([
      "https://a",
      "https://b",
      "https://c"
    ]);
  });
});

describe("discoverCoordinators", () => {
  it("merges static, DNS, Nostr and one-hop peer sources de-duplicated by url/peerId", async () => {
    const nk = nostrKeysFromSecret("44".repeat(32))!;
    const events = [buildAnnouncementEvent(ann(nostrCoord, "https://nostr.example", "sjc"), nk)];
    const f = fakeFetch();
    const found = await discoverCoordinators({
      staticUrls: ["https://static.example"],
      domain: "example.org",
      relays: ["wss://r"],
      currentUrl: "https://current.example/",
      resolver,
      connect: relayWith(events),
      fetch: f.fetch,
      now: () => NOW,
      allowUnpinnedNostr: true
    });
    expect(found.map((c) => [c.url, c.source])).toEqual([
      ["https://current.example", "current"],
      ["https://static.example", "static"],
      ["https://dns.example", "dns"],
      ["https://nostr.example", "nostr"],
      ["https://peer.example", "peer"]
    ]);
    expect(found[1].region).toBe("ord"); // enriched from DNS
    expect(found[3]).toMatchObject({ peerId: nostrCoord.peerId, publicKeyPem: nostrCoord.publicKeyPem, region: "sjc" });
    expect(found[4].announcement?.peerId).toBe(peerCoord.peerId);
    // Peer expansion is asked of non-nostr seeds only.
    expect(f.calls.filter((u) => u.endsWith("/discovery/peers")).map((u) => new URL(u).host).sort()).toEqual(["current.example", "dns.example", "static.example"]);
  });

  it("skips unpinned Nostr unless authors, a key filter or the explicit opt-in is given", async () => {
    const nk = nostrKeysFromSecret("44".repeat(32))!;
    const events = [buildAnnouncementEvent(ann(nostrCoord, "https://nostr.example", "sjc"), nk)];
    const base = { staticUrls: [], domain: false as const, relays: ["wss://r"], expandPeers: false, connect: relayWith(events), fetch: fakeFetch().fetch, now: () => NOW };
    expect(await discoverCoordinators(base)).toEqual([]);
    expect((await discoverCoordinators({ ...base, acceptNostrCandidate: () => false }))).toEqual([]);
    const trusted = await discoverCoordinators({ ...base, acceptNostrCandidate: (c) => c.peerId === nostrCoord.peerId });
    expect(trusted.map((c) => c.url)).toEqual(["https://nostr.example"]);
    const byAuthor = await discoverCoordinators({ ...base, nostrAuthors: [nk.pubkeyHex] });
    expect(byAuthor.map((c) => c.url)).toEqual(["https://nostr.example"]);
    expect(selectOptionsFromEnv({ env: { EDGECODER_NOSTR_ALLOW_UNPINNED: "1" } }).allowUnpinnedNostr).toBe(true);
    expect(selectOptionsFromEnv({ env: {} }).allowUnpinnedNostr).toBe(false);
  });

  it("can disable DNS, Nostr and peer expansion and copes with failing sources", async () => {
    const failing: DnsResolver = {
      resolveTxt: async () => {
        throw new Error("boom");
      },
      resolveSrv: async () => {
        throw new Error("boom");
      }
    };
    const f = fakeFetch();
    const found = await discoverCoordinators({ staticUrls: ["https://static.example"], domain: false, relays: false, expandPeers: false, resolver: failing, fetch: f.fetch });
    expect(found).toEqual([{ url: "https://static.example", source: "static" }]);
    expect(f.calls).toEqual([]);
    const viaDns = await discoverCoordinators({ staticUrls: [], domain: "x", relays: false, expandPeers: false, resolver: failing, fetch: f.fetch });
    expect(viaDns).toEqual([]);
  });
});

describe("selectCoordinator", () => {
  it("discovers, ranks and applies stickiness", async () => {
    const f = fakeFetch();
    const picked = await selectCoordinator({ staticUrls: ["https://static.example"], domain: "example.org", relays: false, resolver, fetch: f.fetch, now: () => Date.now(), expandPeers: true });
    expect(picked?.healthy).toBe(true);
    expect(["https://static.example", "https://dns.example"]).toContain(picked?.url);
    // The busy peer (queued 50, no capacity info) ranks below the idle ones.
    expect(picked?.url).not.toBe("https://peer.example");
    const sticky = await selectCoordinator({ staticUrls: ["https://static.example"], domain: "example.org", relays: false, resolver, fetch: f.fetch, currentUrl: "https://dns.example", expandPeers: false });
    expect(sticky?.url).toBe("https://dns.example");
    expect(await selectCoordinator({ staticUrls: [], domain: false, relays: false, fetch: f.fetch })).toBeNull();
    expect(await selectCoordinator({ staticUrls: ["https://static.example"], domain: false, relays: false, expandPeers: false, fetch: fakeFetch(["static.example"]).fetch })).toBeNull();
  });
});

describe("env-driven options", () => {
  it("maps env vars to selector options", () => {
    const keys = createPeerKeys("pin");
    const fp = "ab".repeat(32);
    const o = selectOptionsFromEnv({
      env: {
        COORDINATOR_DISCOVERY_URLS: "https://a",
        EDGECODER_DISCOVERY_DOMAIN: "mesh.example",
        EDGECODER_NOSTR_RELAYS: "wss://r1,wss://r2",
        EDGECODER_NOSTR_AUTHORS: "cc".repeat(32) + ",junk",
        EDGECODER_COORDINATOR_PINS: `${fp},coord-x,${keys.publicKeyPem.replace(/\n/g, "")}`,
        EDGECODER_DISCOVERY_TIMEOUT_MS: "2500",
        EDGECODER_DISCOVERY_MARGIN: "0.5",
        EDGECODER_COMPUTE_CLASS: "gpu.c8"
      },
      currentUrl: "https://cur",
      meshToken: "t"
    });
    expect(o).toMatchObject({
      staticUrls: ["https://a"],
      domain: ["mesh.example"],
      relays: ["wss://r1", "wss://r2"],
      nostrAuthors: ["cc".repeat(32)],
      currentUrl: "https://cur",
      meshToken: "t",
      computeClass: "gpu.c8",
      pinnedPeerIds: ["coord-x"],
      timeoutMs: 2500,
      stickinessMargin: 0.5
    });
    expect(o.pinnedKeys).toHaveLength(2);
    expect(o.pinnedKeys?.[0]).toBe(fp);
  });

  it("honours off switches and defaults", () => {
    const o = selectOptionsFromEnv({ env: { EDGECODER_DISCOVERY_DOMAIN: "off", EDGECODER_NOSTR_RELAYS: "off", EDGECODER_DISCOVERY_TIMEOUT_MS: "nope" } });
    expect(o.domain).toBe(false);
    expect(o.relays).toBe(false);
    expect(o.timeoutMs).toBe(4000);
    expect(o.stickinessMargin).toBe(0.2);
    const d = selectOptionsFromEnv({ env: {} });
    expect(d.domain).toEqual(["edgecoder.io"]);
    expect(d.relays).toEqual(["wss://relay.damus.io", "wss://nos.lol"]);
  });

  it("selectCoordinatorFromEnv never throws", async () => {
    const f = fakeFetch();
    const picked = await selectCoordinatorFromEnv({ env: { COORDINATOR_DISCOVERY_URLS: "https://static.example", EDGECODER_DISCOVERY_DOMAIN: "off", EDGECODER_NOSTR_RELAYS: "off" }, fetch: f.fetch });
    expect(picked?.url).toBe("https://static.example");
    const broken = await selectCoordinatorFromEnv({
      env: { COORDINATOR_DISCOVERY_URLS: "https://static.example", EDGECODER_DISCOVERY_DOMAIN: "off", EDGECODER_NOSTR_RELAYS: "off" },
      fetch: (() => {
        throw new Error("sync explosion");
      }) as unknown as FetchLike
    });
    expect(broken).toBeNull();
  });
});
