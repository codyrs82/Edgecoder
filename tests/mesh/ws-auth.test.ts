import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { MESH_WS_BIND_MAX_SKEW_MS, decideMeshWsBind, meshWsSenderMatches, signMeshWsBind } from "../../src/mesh/ws-auth.js";

const agent = createPeerKeys("agent-1");
const other = createPeerKeys("agent-2");

function bind(peerId: string, privateKeyPem: string, nowMs = Date.now()) {
  const h = signMeshWsBind(peerId, privateKeyPem, nowMs);
  return { issuedAtMs: h["x-mesh-ws-ts"], signature: h["x-mesh-ws-signature"] };
}

describe("/mesh/ws peer binding (pentest LOW)", () => {
  it("a bind signed with the peer's registered key is authenticated", () => {
    expect(decideMeshWsBind({ peerId: "agent-1", ...bind("agent-1", agent.privateKeyPem), knownPublicKeyPem: agent.publicKeyPem, existingAuthenticated: false, requireSigned: true })).toEqual({ ok: true, authenticated: true });
  });

  it("a mesh-token holder cannot bind another peer's id with its own key", () => {
    const d = decideMeshWsBind({ peerId: "agent-1", ...bind("agent-1", other.privateKeyPem), knownPublicKeyPem: agent.publicKeyPem, existingAuthenticated: false, requireSigned: false });
    expect(d).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("a signature for a different peerId does not transfer", () => {
    const d = decideMeshWsBind({ peerId: "agent-1", ...bind("agent-2", agent.privateKeyPem), knownPublicKeyPem: agent.publicKeyPem, existingAuthenticated: false, requireSigned: false });
    expect(d).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects stale signed binds", () => {
    const old = bind("agent-1", agent.privateKeyPem, Date.now() - MESH_WS_BIND_MAX_SKEW_MS - 1000);
    expect(decideMeshWsBind({ peerId: "agent-1", ...old, knownPublicKeyPem: agent.publicKeyPem, existingAuthenticated: false, requireSigned: false })).toEqual({ ok: false, reason: "stale_signature" });
  });

  it("older unsigned agents still connect, but cannot displace an authenticated connection", () => {
    expect(decideMeshWsBind({ peerId: "agent-1", existingAuthenticated: false, requireSigned: false })).toEqual({ ok: true, authenticated: false });
    expect(decideMeshWsBind({ peerId: "agent-1", existingAuthenticated: true, requireSigned: false })).toEqual({ ok: false, reason: "peer_bound_by_authenticated_connection" });
  });

  it("MESH_WS_REQUIRE_SIGNED refuses unsigned binds and keys it cannot check", () => {
    expect(decideMeshWsBind({ peerId: "agent-1", existingAuthenticated: false, requireSigned: true })).toEqual({ ok: false, reason: "signature_required" });
    expect(decideMeshWsBind({ peerId: "agent-1", ...bind("agent-1", agent.privateKeyPem), existingAuthenticated: false, requireSigned: true })).toEqual({ ok: false, reason: "unknown_peer_key" });
    // Off: a signature from a not-yet-registered agent is treated as an unsigned bind.
    expect(decideMeshWsBind({ peerId: "agent-1", ...bind("agent-1", agent.privateKeyPem), existingAuthenticated: false, requireSigned: false })).toEqual({ ok: true, authenticated: false });
  });

  it("requires a peerId", () => {
    expect(decideMeshWsBind({ peerId: " ", existingAuthenticated: false, requireSigned: false })).toEqual({ ok: false, reason: "missing_peer_id" });
  });

  it("messages on a bound socket must come from the bound peer", () => {
    expect(meshWsSenderMatches("agent-1", { fromPeerId: "agent-1" })).toBe(true);
    expect(meshWsSenderMatches("agent-1", { fromPeerId: "coord-a" })).toBe(false);
    expect(meshWsSenderMatches("agent-1", {})).toBe(false);
  });
});
