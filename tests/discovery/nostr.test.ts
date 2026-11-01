import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { signAnnouncement } from "../../src/discovery/types.js";
import {
  NOSTR_ANNOUNCEMENT_DTAG,
  NOSTR_ANNOUNCEMENT_KIND,
  announcementFromEvent,
  buildAnnouncementEvent,
  fetchNostrAnnouncements,
  nostrEventId,
  nostrKeysFromSecret,
  nostrRelaysFromEnv,
  publishNostrEvent,
  verifyNostrEvent,
  type NostrEvent,
  type WsLike
} from "../../src/discovery/nostr.js";

const keys = createPeerKeys("coord-nostr");
const NOW = 1_700_000_000_000;
const SECRET = "11".repeat(32);

function announcement(announcedAtMs = NOW) {
  return signAnnouncement(
    { peerId: keys.peerId, publicKeyPem: keys.publicKeyPem, url: "https://coord.example", region: "ord", services: ["swarm"], computeClasses: [], version: "1", announcedAtMs },
    keys.privateKeyPem
  );
}

describe("nostr keys", () => {
  it("loads a hex secret and derives a 32-byte x-only pubkey", () => {
    const k = nostrKeysFromSecret(SECRET);
    expect(k?.pubkeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(nostrKeysFromSecret(SECRET)?.pubkeyHex).toBe(k?.pubkeyHex);
  });

  it("derives a deterministic fallback from a seed and rejects malformed hex", () => {
    const a = nostrKeysFromSecret(undefined, keys.privateKeyPem);
    const b = nostrKeysFromSecret("", keys.privateKeyPem);
    expect(a?.pubkeyHex).toBe(b?.pubkeyHex);
    expect(nostrKeysFromSecret(undefined)).toBeNull();
    expect(() => nostrKeysFromSecret("zz")).toThrow(/64 hex/);
  });

  it("reads relays from the environment with defaults", () => {
    expect(nostrRelaysFromEnv({})).toEqual(["wss://relay.damus.io", "wss://nos.lol"]);
    expect(nostrRelaysFromEnv({ EDGECODER_NOSTR_RELAYS: " wss://a.example ,wss://a.example, http://nope, ws://local:7777" })).toEqual(["wss://a.example", "ws://local:7777"]);
  });
});

describe("nostr event construction and verification", () => {
  it("builds a kind-30078 replaceable event with the d-tag and a valid id/sig", () => {
    const nk = nostrKeysFromSecret(SECRET)!;
    const a = announcement();
    const event = buildAnnouncementEvent(a, nk);
    expect(event.kind).toBe(NOSTR_ANNOUNCEMENT_KIND);
    expect(event.tags[0]).toEqual(["d", NOSTR_ANNOUNCEMENT_DTAG]);
    expect(event.tags).toContainEqual(["url", "https://coord.example"]);
    expect(event.tags).toContainEqual(["peer", keys.peerId]);
    expect(event.created_at).toBe(Math.floor(NOW / 1000));
    expect(event.pubkey).toBe(nk.pubkeyHex);
    const { id, sig, ...rest } = event;
    const expectedId = createHash("sha256").update(JSON.stringify([0, rest.pubkey, rest.created_at, rest.kind, rest.tags, rest.content])).digest("hex");
    expect(id).toBe(expectedId);
    expect(nostrEventId(rest)).toBe(expectedId);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyNostrEvent(event)).toBe(true);
    expect(JSON.parse(event.content)).toEqual(a);
  });

  it("rejects events with a tampered body, bad signature or wrong shape", () => {
    const nk = nostrKeysFromSecret(SECRET)!;
    const event = buildAnnouncementEvent(announcement(), nk);
    expect(verifyNostrEvent({ ...event, content: event.content + " " })).toBe(false);
    expect(verifyNostrEvent({ ...event, sig: "00".repeat(64) })).toBe(false);
    expect(verifyNostrEvent({ ...event, pubkey: "22".repeat(32) })).toBe(false);
    expect(verifyNostrEvent({ ...event, id: "nope" })).toBe(false);
    expect(verifyNostrEvent(null)).toBe(false);
    expect(verifyNostrEvent({ ...event, tags: "x" })).toBe(false);
  });

  it("extracts the announcement only when both signatures and the d-tag check out", () => {
    const nk = nostrKeysFromSecret(SECRET)!;
    const a = announcement();
    const event = buildAnnouncementEvent(a, nk);
    expect(announcementFromEvent(event, { now: () => NOW })).toEqual(a);
    // Relay key valid, inner Ed25519 signature forged
    const forged = buildAnnouncementEvent({ ...a, region: "fra" }, nk);
    expect(verifyNostrEvent(forged)).toBe(true);
    expect(announcementFromEvent(forged, { now: () => NOW })).toBeNull();
    // Wrong d-tag / kind
    expect(announcementFromEvent(buildAnnouncementEvent(a, nk, { dTag: "other" }), { now: () => NOW })).toBeNull();
    const wrongKind: NostrEvent = { ...event, kind: 1 };
    expect(announcementFromEvent(wrongKind, { now: () => NOW })).toBeNull();
    // Stale
    expect(announcementFromEvent(event, { now: () => NOW + 48 * 3600 * 1000 })).toBeNull();
    // Non-JSON content with a valid outer signature
    const junk = buildAnnouncementEvent(a, nk);
    const junkUnsigned = { ...junk, content: "not json" };
    expect(announcementFromEvent(junkUnsigned, { now: () => NOW })).toBeNull();
  });
});

/** In-memory relay: records EVENTs, answers REQs with stored events + EOSE. */
function fakeRelay(opts: { events?: NostrEvent[]; ack?: boolean; silent?: boolean; failConnect?: boolean } = {}) {
  const stored: NostrEvent[] = [...(opts.events ?? [])];
  const sent: unknown[] = [];
  const connect = (url: string): WsLike => {
    if (opts.failConnect) throw new Error(`cannot connect ${url}`);
    const ws: WsLike = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close() {
        queueMicrotask(() => ws.onclose?.({}));
      },
      send(data: string) {
        const msg = JSON.parse(data) as unknown[];
        sent.push(msg);
        if (opts.silent) return;
        if (msg[0] === "EVENT") {
          const e = msg[1] as NostrEvent;
          stored.push(e);
          queueMicrotask(() => ws.onmessage?.({ data: JSON.stringify(["OK", e.id, opts.ack ?? true, opts.ack === false ? "blocked: nope" : ""]) }));
        } else if (msg[0] === "REQ") {
          const sub = msg[1] as string;
          const filter = msg[2] as { kinds?: number[]; "#d"?: string[] };
          queueMicrotask(() => {
            for (const e of stored) {
              if (filter.kinds && !filter.kinds.includes(e.kind)) continue;
              if (filter["#d"] && !e.tags.some((t) => t[0] === "d" && filter["#d"]!.includes(t[1]))) continue;
              ws.onmessage?.({ data: Buffer.from(JSON.stringify(["EVENT", sub, e])) });
            }
            ws.onmessage?.({ data: JSON.stringify(["EOSE", sub]) });
          });
        }
      }
    };
    queueMicrotask(() => ws.onopen?.({}));
    return ws;
  };
  return { connect, stored, sent };
}

describe("relay I/O (fake websockets)", () => {
  it("publishes to every relay and reports OK / rejection / timeout / connect failure per relay", async () => {
    const nk = nostrKeysFromSecret(SECRET)!;
    const event = buildAnnouncementEvent(announcement(), nk);
    const ok = fakeRelay();
    const nack = fakeRelay({ ack: false });
    const silent = fakeRelay({ silent: true });
    const dead = fakeRelay({ failConnect: true });
    const byUrl: Record<string, ReturnType<typeof fakeRelay>> = { "wss://ok": ok, "wss://nack": nack, "wss://silent": silent, "wss://dead": dead };
    const results = await publishNostrEvent(event, { relays: Object.keys(byUrl), timeoutMs: 50, connect: (url) => byUrl[url].connect(url) });
    expect(results).toEqual([
      { relay: "wss://ok", ok: true, message: "" },
      { relay: "wss://nack", ok: false, message: "blocked: nope" },
      { relay: "wss://silent", ok: false, message: "timeout" },
      { relay: "wss://dead", ok: false, message: expect.stringContaining("cannot connect") }
    ]);
    expect(ok.stored).toHaveLength(1);
    expect(ok.sent[0]).toEqual(["EVENT", event]);
  });

  it("fetches, verifies and de-duplicates announcements across relays (newest per peer wins)", async () => {
    const nk = nostrKeysFromSecret(SECRET)!;
    const older = buildAnnouncementEvent(announcement(NOW - 5000), nk);
    const newer = buildAnnouncementEvent(announcement(NOW), nk);
    const forged = buildAnnouncementEvent({ ...announcement(NOW + 1000), url: "https://evil.example" }, nk);
    const otherKind: NostrEvent = { ...newer, kind: 1 };
    const r1 = fakeRelay({ events: [older, forged, otherKind] });
    const r2 = fakeRelay({ events: [newer] });
    const r3 = fakeRelay({ silent: true });
    const byUrl: Record<string, ReturnType<typeof fakeRelay>> = { "wss://r1": r1, "wss://r2": r2, "wss://r3": r3 };
    const found = await fetchNostrAnnouncements({ relays: Object.keys(byUrl), timeoutMs: 50, connect: (url) => byUrl[url].connect(url), verify: { now: () => NOW } });
    expect(found).toEqual([announcement(NOW)]);
    const req = r1.sent.find((m) => (m as unknown[])[0] === "REQ") as unknown[];
    expect(req[2]).toMatchObject({ kinds: [NOSTR_ANNOUNCEMENT_KIND], "#d": [NOSTR_ANNOUNCEMENT_DTAG] });
    expect(r1.sent.some((m) => (m as unknown[])[0] === "CLOSE")).toBe(true);
  });

  it("filters by author when configured", async () => {
    const nk = nostrKeysFromSecret(SECRET)!;
    const other = nostrKeysFromSecret("22".repeat(32))!;
    const relay = fakeRelay({ events: [buildAnnouncementEvent(announcement(), other)] });
    const none = await fetchNostrAnnouncements({ relays: ["wss://r"], timeoutMs: 50, connect: relay.connect, authors: [nk.pubkeyHex], verify: { now: () => NOW } });
    expect(none).toEqual([]);
    const some = await fetchNostrAnnouncements({ relays: ["wss://r"], timeoutMs: 50, connect: relay.connect, authors: [other.pubkeyHex], verify: { now: () => NOW } });
    expect(some).toHaveLength(1);
  });
});
