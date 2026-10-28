import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import {
  checkPeerRegistration,
  parsePeerAllowlist,
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

  it("dev without an allowlist keeps unsigned token-only forwarding", () => {
    expect(verifyForwardedResult({ headers: {}, bodyJson: body, allowlist: new Map(), production: false, publicKeyFor: keyFor })).toEqual({ ok: true, mode: "legacy_token" });
    expect(verifyForwardedResult({ headers: {}, bodyJson: body, allowlist: new Map(), production: true, publicKeyFor: keyFor })).toMatchObject({ ok: false, error: "peer_allowlist_required" });
  });
});
