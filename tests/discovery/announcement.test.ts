import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import {
  canonicalizeAnnouncement,
  candidateFromAnnouncement,
  mergeCandidates,
  parseAnnouncement,
  pinMatchesKey,
  publicKeyFingerprint,
  signAnnouncement,
  verifyAnnouncement,
  type UnsignedAnnouncement
} from "../../src/discovery/types.js";

const keys = createPeerKeys("coord-test");
const NOW = 1_700_000_000_000;

function unsigned(overrides: Partial<UnsignedAnnouncement> = {}): UnsignedAnnouncement {
  return {
    peerId: keys.peerId,
    publicKeyPem: keys.publicKeyPem,
    url: "https://coord.example",
    region: "ord",
    services: ["swarm"],
    computeClasses: ["cpu.std"],
    version: "1.0.0",
    announcedAtMs: NOW,
    ...overrides
  };
}

describe("announcement sign/verify", () => {
  it("signs over the canonical JSON without the signature and verifies", () => {
    const a = signAnnouncement(unsigned(), keys.privateKeyPem);
    expect(a.signature.length).toBeGreaterThan(40);
    expect(canonicalizeAnnouncement(a)).not.toContain("signature");
    expect(verifyAnnouncement(a, { now: () => NOW + 1000 })).toEqual({ ok: true });
  });

  it("rejects tampered fields and foreign signatures", () => {
    const a = signAnnouncement(unsigned(), keys.privateKeyPem);
    expect(verifyAnnouncement({ ...a, url: "https://evil.example" }, { now: () => NOW })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyAnnouncement({ ...a, region: "fra" }, { now: () => NOW })).toEqual({ ok: false, reason: "bad_signature" });
    const other = createPeerKeys("other");
    const forged = signAnnouncement(unsigned(), other.privateKeyPem);
    expect(verifyAnnouncement(forged, { now: () => NOW }).ok).toBe(false);
    // Claiming another peer's key but signing with your own
    const impostor = signAnnouncement(unsigned({ peerId: "impostor" }), other.privateKeyPem);
    expect(verifyAnnouncement(impostor, { now: () => NOW }).ok).toBe(false);
  });

  it("enforces freshness", () => {
    const a = signAnnouncement(unsigned(), keys.privateKeyPem);
    expect(verifyAnnouncement(a, { now: () => NOW + 25 * 60 * 60 * 1000 })).toEqual({ ok: false, reason: "expired" });
    expect(verifyAnnouncement(a, { now: () => NOW - 10 * 60 * 1000 })).toEqual({ ok: false, reason: "future" });
    expect(verifyAnnouncement(a, { now: () => NOW + 25 * 60 * 60 * 1000, maxAgeMs: 0 })).toEqual({ ok: true });
  });

  it("parses untrusted input defensively", () => {
    expect(parseAnnouncement(null)).toBeNull();
    expect(parseAnnouncement({ peerId: "x" })).toBeNull();
    expect(parseAnnouncement({ ...unsigned({ url: "ftp://nope" }), signature: "abc" })).toBeNull();
    const parsed = parseAnnouncement({ peerId: "p", publicKeyPem: "k", url: "https://ok.example", announcedAtMs: 1, signature: "s" });
    expect(parsed).toMatchObject({ region: "unknown", services: [], computeClasses: [], version: "" });
    expect(verifyAnnouncement({ ...unsigned(), signature: "not-base64!!" } as never, { now: () => NOW })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("matches key pins by fingerprint or PEM", () => {
    const fp = publicKeyFingerprint(keys.publicKeyPem);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(pinMatchesKey(fp.toUpperCase(), keys.publicKeyPem)).toBe(true);
    expect(pinMatchesKey(keys.publicKeyPem.replace(/\n/g, ""), keys.publicKeyPem)).toBe(true);
    expect(pinMatchesKey("00".repeat(32), keys.publicKeyPem)).toBe(false);
    expect(pinMatchesKey("", keys.publicKeyPem)).toBe(false);
  });
});

describe("mergeCandidates", () => {
  it("de-duplicates by url and peerId, keeping the first source and enriching fields", () => {
    const a = signAnnouncement(unsigned(), keys.privateKeyPem);
    const fromAnnouncement = candidateFromAnnouncement(a, "nostr")!;
    const merged = mergeCandidates(
      [{ url: "https://coord.example/", source: "static" }],
      [{ url: "https://coord.example", peerId: keys.peerId, region: "ord", source: "dns" }],
      [fromAnnouncement],
      [{ url: "https://other.example", source: "dns" }],
      [{ url: "not a url", source: "static" }]
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ url: "https://coord.example", source: "static", peerId: keys.peerId, region: "ord" });
    expect(merged[0].announcement).toBe(a);
    expect(merged[0].publicKeyPem).toBe(keys.publicKeyPem);
    expect(merged[1]).toEqual({ url: "https://other.example", source: "dns" });
  });

  it("keeps the newest announcement for a peer", () => {
    const older = signAnnouncement(unsigned({ announcedAtMs: NOW - 10 }), keys.privateKeyPem);
    const newer = signAnnouncement(unsigned({ announcedAtMs: NOW }), keys.privateKeyPem);
    const merged = mergeCandidates([candidateFromAnnouncement(older, "nostr")!], [candidateFromAnnouncement(newer, "peer")!]);
    expect(merged).toHaveLength(1);
    expect(merged[0].announcement?.announcedAtMs).toBe(NOW);
  });
});
