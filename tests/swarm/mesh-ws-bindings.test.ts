import { describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { MESH_WS_BIND_MAX_SKEW_MS, signMeshWsBind } from "../../src/mesh/ws-auth.js";
import { MeshWsBindingTable, pendingBindFrom, type BindableSocket } from "../../src/swarm/coordinator/mesh-ws-bindings.js";

const agent = createPeerKeys("agent-held-1");
const other = createPeerKeys("agent-held-2");

class FakeSocket implements BindableSocket {
  readyState = 1;
  closed: { code: number; reason: string } | null = null;
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}

function pendingFor(peerId: string, privateKeyPem: string, nowMs = Date.now()) {
  const h = signMeshWsBind(peerId, privateKeyPem, nowMs);
  return pendingBindFrom(h["x-mesh-ws-signature"], h["x-mesh-ws-ts"], nowMs)!;
}

describe("mesh socket that arrives before its agent registers (coordinator restart)", () => {
  it("is held unauthenticated, then promoted by the key the agent registers", () => {
    const t = new MeshWsBindingTable<FakeSocket>();
    const s = new FakeSocket();
    t.bind(agent.peerId, { socket: s, authenticated: false, pending: pendingFor(agent.peerId, agent.privateKeyPem), held: true });
    expect(t.authenticatedOpen(agent.peerId)).toBeNull();
    expect(t.heldCount()).toBe(1);
    expect(t.promote(agent.peerId, agent.publicKeyPem)).toBe("promoted");
    expect(t.authenticatedOpen(agent.peerId)).toBe(s);
    expect(t.get(agent.peerId)?.held).toBe(false);
    expect(t.heldCount()).toBe(0);
    expect(s.closed).toBeNull();
    // Nothing left to promote.
    expect(t.promote(agent.peerId, agent.publicKeyPem)).toBe("none");
  });

  it("a bind signed by another key is closed when the real key is registered", () => {
    const t = new MeshWsBindingTable<FakeSocket>();
    const s = new FakeSocket();
    t.bind(agent.peerId, { socket: s, authenticated: false, pending: pendingFor(agent.peerId, other.privateKeyPem), held: true });
    expect(t.promote(agent.peerId, agent.publicKeyPem)).toBe("rejected");
    expect(s.closed).toEqual({ code: 4003, reason: "invalid_signature" });
    expect(t.get(agent.peerId)).toBeUndefined();
  });

  it("a garbage signature cannot be promoted", () => {
    const t = new MeshWsBindingTable<FakeSocket>();
    const s = new FakeSocket();
    t.bind(agent.peerId, { socket: s, authenticated: false, pending: { signature: "AAAA", issuedAtMs: Date.now(), connectedAtMs: Date.now() }, held: true });
    expect(t.promote(agent.peerId, agent.publicKeyPem)).toBe("rejected");
    expect(t.authenticatedOpen(agent.peerId)).toBeNull();
  });

  it("the skew window is measured at connect time, so a slow re-registration still promotes", () => {
    const t = new MeshWsBindingTable<FakeSocket>();
    const s = new FakeSocket();
    const connectedAt = Date.now() - 2 * MESH_WS_BIND_MAX_SKEW_MS;
    t.bind(agent.peerId, { socket: s, authenticated: false, pending: pendingFor(agent.peerId, agent.privateKeyPem, connectedAt), held: true });
    expect(t.promote(agent.peerId, agent.publicKeyPem)).toBe("promoted");
  });

  it("a stale bind is not even held", () => {
    const h = signMeshWsBind(agent.peerId, agent.privateKeyPem, Date.now() - MESH_WS_BIND_MAX_SKEW_MS - 1000);
    expect(pendingBindFrom(h["x-mesh-ws-signature"], h["x-mesh-ws-ts"])).toBeNull();
    expect(pendingBindFrom(null, String(Date.now()))).toBeNull();
    expect(pendingBindFrom("sig", null)).toBeNull();
  });

  it("a closed socket is not promoted, and only the holder releases the binding", () => {
    const t = new MeshWsBindingTable<FakeSocket>();
    const a = new FakeSocket();
    const b = new FakeSocket();
    t.bind(agent.peerId, { socket: a, authenticated: false, pending: pendingFor(agent.peerId, agent.privateKeyPem), held: true });
    t.bind(agent.peerId, { socket: b, authenticated: false, pending: pendingFor(agent.peerId, agent.privateKeyPem, Date.now() + 1), held: true });
    expect(a.closed).toEqual({ code: 4004, reason: "replaced_by_new_connection" });
    expect(t.release(agent.peerId, a)).toBe(false);
    b.readyState = 3;
    expect(t.promote(agent.peerId, agent.publicKeyPem)).toBe("none");
    expect(t.release(agent.peerId, b)).toBe(true);
  });

  it("a mesh-token connection that could not be checked is upgraded, or simply stays unauthenticated", () => {
    const t = new MeshWsBindingTable<FakeSocket>();
    const s = new FakeSocket();
    t.bind(agent.peerId, { socket: s, authenticated: false, pending: pendingFor(agent.peerId, other.privateKeyPem) });
    expect(t.promote(agent.peerId, agent.publicKeyPem)).toBe("rejected");
    expect(s.closed).toBeNull();
    expect(t.get(agent.peerId)?.authenticated).toBe(false);
  });
});
