import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { GossipMesh } from "../../src/mesh/gossip.js";
import {
  admitPeer,
  checkPeerRegistration,
  ReplayCache,
  parsePeerAllowlist,
  parsePeerUrlPins,
  publicKeyFingerprint,
  signForwardedResult,
  signRegistration,
  verifyForwardedResult
} from "../../src/mesh/peer-trust.js";

const A = createPeerKeys("coord-a");
const EVIL = createPeerKeys("coord-a"); // same peerId, different key
const URL_A = "https://a.example";
const allow = parsePeerAllowlist(`coord-a:${publicKeyFingerprint(A.publicKeyPem)}`);
const NOW = 1_700_000_000_000;

function reg(keys = A, signer = keys.privateKeyPem, issuedAt = NOW) {
  const base = { peerId: keys.peerId, publicKeyPem: keys.publicKeyPem, coordinatorUrl: URL_A };
  return { ...base, ...signRegistration(base, signer, issuedAt) };
}

describe("peer registration trust (#52)", () => {
  it("accepts an allowlisted key with a fresh valid signature", () => {
    expect(checkPeerRegistration({ body: reg(), allowlist: allow, production: true, nowMs: NOW })).toEqual({ ok: true, mode: "allowlist" });
  });

  it("rejects a peer without an allowlisted key, even with the mesh token", () => {
    expect(checkPeerRegistration({ body: reg(EVIL), allowlist: allow, production: true, nowMs: NOW })).toMatchObject({ ok: false, error: "peer_not_allowlisted" });
    const stranger = createPeerKeys("coord-x");
    expect(checkPeerRegistration({ body: reg(stranger), allowlist: allow, production: true, nowMs: NOW })).toMatchObject({ ok: false, error: "peer_not_allowlisted" });
  });

  it("rejects a replayed allowlisted public key without the private key", () => {
    const forged = reg(A, EVIL.privateKeyPem);
    expect(checkPeerRegistration({ body: forged, allowlist: allow, production: true, nowMs: NOW })).toMatchObject({ ok: false, error: "peer_signature_invalid" });
    const { signature: _s, issuedAtMs: _t, ...unsigned } = reg();
    expect(checkPeerRegistration({ body: unsigned, allowlist: allow, production: true, nowMs: NOW })).toMatchObject({ ok: false, error: "peer_signature_required" });
    expect(checkPeerRegistration({ body: reg(), allowlist: allow, production: true, nowMs: NOW + 10 * 60_000 })).toMatchObject({ ok: false, error: "peer_signature_stale" });
  });

  it("requires an allowlist in production; dev keeps the legacy token path", () => {
    expect(checkPeerRegistration({ body: reg(), allowlist: new Map(), production: true })).toMatchObject({ ok: false, error: "peer_allowlist_required" });
    expect(checkPeerRegistration({ body: reg(), allowlist: new Map(), production: false })).toEqual({ ok: true, mode: "legacy_token" });
  });

  it("parses and validates MESH_PEER_ALLOWLIST", () => {
    expect(parsePeerAllowlist("")).toEqual(new Map());
    expect(() => parsePeerAllowlist("coord-a")).toThrow(/bad entry/);
    expect(() => parsePeerAllowlist("coord-a:xyz")).toThrow(/bad fingerprint/);
    const fp = publicKeyFingerprint(A.publicKeyPem);
    expect(() => parsePeerAllowlist(`coord-a:${fp},coord-a:${fp}`)).toThrow(/duplicate peer id/);
  });

  it("the registration signature covers networkMode and role", () => {
    const base = { peerId: A.peerId, publicKeyPem: A.publicKeyPem, coordinatorUrl: URL_A, networkMode: "public_mesh" };
    const signed = { ...base, ...signRegistration(base, A.privateKeyPem, NOW) };
    expect(checkPeerRegistration({ body: signed, allowlist: allow, production: true, nowMs: NOW }).ok).toBe(true);
    expect(checkPeerRegistration({ body: { ...signed, networkMode: "enterprise_overlay" }, allowlist: allow, production: true, nowMs: NOW })).toMatchObject({ ok: false, error: "peer_signature_invalid" });
  });
});

describe("forwarded results (#52)", () => {
  const body = JSON.stringify({ subtaskId: "s1", taskId: "t1", agentId: "w", ok: true, output: "42" });
  const keyFor = (id: string) => (id === "coord-a" ? A.publicKeyPem : null);

  it("verifies a result signed by an allowlisted peer", () => {
    const headers = signForwardedResult("coord-a", A.privateKeyPem, body, NOW);
    expect(verifyForwardedResult({ headers, bodyJson: body, allowlist: allow, production: true, publicKeyFor: keyFor, nowMs: NOW })).toMatchObject({ ok: true, fromPeerId: "coord-a" });
  });

  it("rejects tampered, unsigned, unknown-peer and wrong-key results", () => {
    const headers = signForwardedResult("coord-a", A.privateKeyPem, body, NOW);
    const tampered = body.replace("42", "43");
    expect(verifyForwardedResult({ headers, bodyJson: tampered, allowlist: allow, production: true, publicKeyFor: keyFor, nowMs: NOW })).toMatchObject({ ok: false, error: "peer_signature_invalid" });
    expect(verifyForwardedResult({ headers: {}, bodyJson: body, allowlist: allow, production: true, publicKeyFor: keyFor, nowMs: NOW })).toMatchObject({ ok: false, error: "peer_signature_required" });
    const forged = signForwardedResult("coord-a", EVIL.privateKeyPem, body, NOW);
    expect(verifyForwardedResult({ headers: forged, bodyJson: body, allowlist: allow, production: true, publicKeyFor: keyFor, nowMs: NOW })).toMatchObject({ ok: false, error: "peer_signature_invalid" });
    const other = signForwardedResult("coord-x", EVIL.privateKeyPem, body, NOW);
    expect(verifyForwardedResult({ headers: other, bodyJson: body, allowlist: allow, production: true, publicKeyFor: () => EVIL.publicKeyPem, nowMs: NOW })).toMatchObject({ ok: false, error: "peer_not_allowlisted" });
  });

  it("a replayed forwarded result is rejected", () => {
    const headers = signForwardedResult("coord-a", A.privateKeyPem, body, NOW);
    const replay = new ReplayCache();
    const args = { headers, bodyJson: body, allowlist: allow, production: true, publicKeyFor: keyFor, nowMs: NOW, replay };
    expect(verifyForwardedResult(args).ok).toBe(true);
    expect(verifyForwardedResult(args)).toMatchObject({ ok: false, code: 409, error: "peer_signature_replayed" });
  });

  it("dev without an allowlist keeps unsigned token-only forwarding", () => {
    expect(verifyForwardedResult({ headers: {}, bodyJson: body, allowlist: new Map(), production: false, publicKeyFor: keyFor })).toEqual({ ok: true, mode: "legacy_token" });
    expect(verifyForwardedResult({ headers: {}, bodyJson: body, allowlist: new Map(), production: true, publicKeyFor: keyFor })).toMatchObject({ ok: false, error: "peer_allowlist_required" });
  });
});

describe("peer table admission (#118 review)", () => {
  const mk = (keys = A, url = "https://a.example") => ({ peerId: keys.peerId, publicKeyPem: keys.publicKeyPem, coordinatorUrl: url, networkMode: "public_mesh" as const });
  const fpA = publicKeyFingerprint(A.publicKeyPem);
  const pinnedRaw = `coord-a:${fpA}@https://a.example/`;
  const pins = parsePeerUrlPins(pinnedRaw);

  function meshWith(allowlist: ReturnType<typeof parsePeerAllowlist>, production: boolean, urlPins = new Map<string, string>()) {
    const m = new GossipMesh();
    m.setAdmission((peer, existing, opts) =>
      admitPeer({ allowlist, pins: urlPins, production, peer, existing, authoritative: opts.authoritative, source: opts.source })
    );
    return m;
  }

  it("parses an optional @url pin per allowlist entry", () => {
    expect(parsePeerAllowlist(pinnedRaw)).toEqual(new Map([["coord-a", fpA]]));
    expect(pins).toEqual(new Map([["coord-a", "https://a.example"]]));
    expect(parsePeerUrlPins(`coord-a:${fpA}`)).toEqual(new Map());
    expect(() => parsePeerAllowlist(`coord-a:${fpA}@ftp://x`)).toThrow(/bad url/);
    expect(() => parsePeerAllowlist(`coord-a:${fpA}@https://u:p@x`)).toThrow(/bad url/);
  });

  it("drops non-allowlisted entries on every path", () => {
    const m = meshWith(allow, true, pins);
    for (const source of ["gossip", "bootstrap", "register"] as const) {
      expect(m.addPeer(mk(createPeerKeys("coord-x")), { source })).toBe(false);
      expect(m.addPeer(mk(EVIL), { source, authoritative: source === "register" })).toBe(false); // right id, wrong key
    }
    expect(m.listPeers()).toEqual([]);
  });

  it("gossip never sets an endpoint: unpinned unknown peers are dropped", () => {
    const m = meshWith(allow, true);
    expect(m.addPeer(mk(A, "https://attacker.example"), { source: "gossip" })).toBe(false);
    expect(m.listPeers()).toEqual([]);
  });

  it("gossip of a pinned peer stores the pinned URL, not the gossiped one", () => {
    const m = meshWith(allow, true, pins);
    expect(m.addPeer(mk(A, "https://attacker.example"), { source: "gossip" })).toBe(true);
    expect(m.listPeers()[0].coordinatorUrl).toBe("https://a.example");
  });

  it("bootstrap sets the endpoint for an unpinned peer; gossip can't change it", () => {
    const m = meshWith(allow, true);
    expect(m.addPeer(mk(A, "https://a.example/"), { source: "bootstrap" })).toBe(true);
    expect(m.listPeers()[0].coordinatorUrl).toBe("https://a.example");
    expect(m.addPeer(mk(A, "https://attacker.example"), { source: "gossip" })).toBe(false);
    expect(m.listPeers()[0].coordinatorUrl).toBe("https://a.example");
  });

  it("bootstrap and registration that disagree with the pin are refused", () => {
    const m = meshWith(allow, true, pins);
    expect(m.addPeer(mk(A, "https://other.example"), { source: "bootstrap" })).toBe(false);
    expect(m.addPeer(mk(A, "https://other.example"), { source: "register", authoritative: true })).toBe(false);
    expect(m.addPeer(mk(A, "https://a.example"), { source: "register", authoritative: true })).toBe(true);
  });

  it("unpinned registration can only confirm the bootstrap endpoint, never move it", () => {
    const m = meshWith(allow, true);
    expect(m.addPeer(mk(A, "https://a.example"), { source: "register", authoritative: true })).toBe(false); // unknown, unpinned
    m.addPeer(mk(A, "https://a.example"), { source: "bootstrap" });
    expect(m.addPeer(mk(A, "https://a2.example"), { source: "register", authoritative: true })).toBe(false);
    expect(m.addPeer(mk(A, "https://a.example"), { source: "register", authoritative: true })).toBe(true);
    expect(m.listPeers()[0].coordinatorUrl).toBe("https://a.example");
  });

  it("a squatter entry (dev legacy, then allowlist on) is replaced by the real peer", () => {
    // Squatter got in before the allowlist was configured.
    expect(admitPeer({ allowlist: allow, pins, production: true, peer: mk(A), existing: mk(EVIL) })).toMatchObject({ coordinatorUrl: "https://a.example" });
    expect(admitPeer({ allowlist: allow, pins, production: true, peer: mk(EVIL), existing: mk(A) })).toBeNull();
  });

  it("production without an allowlist admits nobody; dev keeps first-wins", () => {
    expect(admitPeer({ allowlist: new Map(), production: true, peer: mk(A) })).toBeNull();
    expect(admitPeer({ allowlist: new Map(), production: false, peer: mk(A) })).not.toBeNull();
    expect(admitPeer({ allowlist: new Map(), production: false, peer: mk(EVIL), existing: mk(A) })).toBeNull();
    expect(admitPeer({ allowlist: new Map(), production: false, peer: mk(EVIL), existing: mk(A), authoritative: true })).not.toBeNull();
  });

  it("onBroadcast sees task_offer messages", async () => {
    const m = new GossipMesh();
    const seen: string[] = [];
    m.onBroadcast((msg) => seen.push(msg.type));
    await m.broadcast({ id: "1", type: "task_offer", fromPeerId: "me", issuedAtMs: 0, ttlMs: 1, payload: { subtaskId: "s" }, signature: "x" });
    expect(seen).toEqual(["task_offer"]);
  });
});

describe("ReplayCache", () => {
  it("expires entries after the TTL", () => {
    const c = new ReplayCache(1000);
    expect(c.firstSeen("k", 0)).toBe(true);
    expect(c.firstSeen("k", 500)).toBe(false);
    expect(c.firstSeen("k", 1001)).toBe(true);
  });
});
