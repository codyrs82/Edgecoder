import { afterEach, describe, expect, it } from "vitest";
import { request } from "undici";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { MAX_UNTRUSTED_PEERS, MeshPeer } from "../../src/mesh/mesh-peer.js";
import { MeshHttpServer } from "../../src/mesh/mesh-http-server.js";
import { MeshProtocol } from "../../src/mesh/protocol.js";
import { MeshTaskQueue } from "../../src/mesh/mesh-task-queue.js";
import type { Subtask } from "../../src/common/types.js";

const coordKeys = createPeerKeys("coord-1");
const coordIdentity = { peerId: "coord-1", publicKeyPem: coordKeys.publicKeyPem, coordinatorUrl: "https://coord.example", networkMode: "public_mesh" as const };

function agent() {
  return new MeshPeer({ peerId: "agent-x", keys: createPeerKeys("agent-x"), publicUrl: "http://127.0.0.1:0", networkMode: "public_mesh", role: "agent", bootstrapUrls: [], meshToken: "tok" });
}

let server: MeshHttpServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("worker mesh peer table admission", () => {
  it("a /mesh/register-peer cannot overwrite the coordinator's entry", async () => {
    const peer = agent();
    peer.addPeer(coordIdentity, "coordinator", { trusted: true });
    server = new MeshHttpServer({ port: 0, host: "127.0.0.1", meshPeer: peer, meshToken: "tok" });
    const port = await server.start();
    const attacker = createPeerKeys("attacker");
    const res = await request(`http://127.0.0.1:${port}/mesh/register-peer`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mesh-token": "tok" },
      body: JSON.stringify({ peerId: "coord-1", publicKeyPem: attacker.publicKeyPem, coordinatorUrl: "http://169.254.169.254", networkMode: "public_mesh", role: "coordinator" })
    });
    await res.body.dump();
    expect(res.statusCode).toBe(409);
    expect(peer.getPeer("coord-1")?.identity.publicKeyPem).toBe(coordKeys.publicKeyPem);
    expect(peer.getPeer("coord-1")?.identity.coordinatorUrl).toBe("https://coord.example");
  });

  it("self-registered peers are not gossip targets and cannot claim the coordinator role", () => {
    const peer = agent();
    expect(peer.addPeer({ ...coordIdentity, peerId: "stranger", coordinatorUrl: "http://10.0.0.1" }, "coordinator")).toBe(true);
    expect(peer.getPeer("stranger")?.role).toBe("agent");
    expect(peer.getPeer("stranger")?.trusted).toBe(false);
    expect(peer.gossip.listPeers().map((p) => p.peerId)).not.toContain("stranger");
    // Re-registering the same identity is fine; changing its key or URL is not.
    expect(peer.addPeer({ ...coordIdentity, peerId: "stranger", coordinatorUrl: "http://10.0.0.1" }, "agent")).toBe(true);
    expect(peer.addPeer({ ...coordIdentity, peerId: "stranger", coordinatorUrl: "http://10.0.0.2" }, "agent")).toBe(false);
  });

  it("a trusted add replaces an untrusted squatter on the coordinator's id", () => {
    const peer = agent();
    peer.addPeer({ ...coordIdentity, publicKeyPem: createPeerKeys("squat").publicKeyPem }, "coordinator");
    expect(peer.addPeer(coordIdentity, "coordinator", { trusted: true })).toBe(true);
    expect(peer.getPeer("coord-1")?.identity.publicKeyPem).toBe(coordKeys.publicKeyPem);
    expect(peer.gossip.listPeers().map((p) => p.peerId)).toContain("coord-1");
  });

  it("caps untrusted entries", () => {
    const peer = agent();
    const pem = createPeerKeys("x").publicKeyPem;
    for (let i = 0; i < MAX_UNTRUSTED_PEERS; i++) {
      expect(peer.addPeer({ peerId: `p${i}`, publicKeyPem: pem, coordinatorUrl: "http://10.0.0.1", networkMode: "public_mesh" }, "agent")).toBe(true);
    }
    expect(peer.addPeer({ peerId: "one-more", publicKeyPem: pem, coordinatorUrl: "http://10.0.0.1", networkMode: "public_mesh" }, "agent")).toBe(false);
    // The coordinator's own entries are not affected by the cap.
    expect(peer.addPeer(coordIdentity, "coordinator", { trusted: true })).toBe(true);
  });

  it("isFromIdentity checks the key on file, not only the id", () => {
    const peer = agent();
    const squatterKey = createPeerKeys("squat").publicKeyPem;
    peer.addPeer({ ...coordIdentity, publicKeyPem: squatterKey }, "coordinator");
    expect(peer.isFromIdentity({ fromPeerId: "coord-1" }, coordIdentity)).toBe(false);
    peer.addPeer(coordIdentity, "coordinator", { trusted: true });
    expect(peer.isFromIdentity({ fromPeerId: "coord-1" }, coordIdentity)).toBe(true);
    expect(peer.isFromIdentity({ fromPeerId: "other" }, coordIdentity)).toBe(false);
    expect(peer.isFromIdentity({ fromPeerId: "coord-1" }, null)).toBe(false);
  });

  it("peer_exchange entries are trusted only when the coordinator sent them", async () => {
    const peer = agent();
    const proto = new MeshProtocol();
    const otherKeys = createPeerKeys("other-agent");
    peer.addPeer({ peerId: "other-agent", publicKeyPem: otherKeys.publicKeyPem, coordinatorUrl: "http://10.0.0.5", networkMode: "public_mesh" }, "agent");
    const entry = (id: string, url: string) => ({ peerId: id, publicKeyPem: otherKeys.publicKeyPem, peerUrl: url, networkMode: "public_mesh", role: "agent", lastSeenMs: Date.now() });

    const fromAgent = proto.createMessage("peer_exchange", "other-agent", { peers: [entry("planted", "http://169.254.169.254")] }, otherKeys.privateKeyPem, 30_000);
    expect((await peer.handleIngest(fromAgent)).ok).toBe(true);
    expect(peer.getPeer("planted")?.trusted).toBe(false);
    expect(peer.gossip.listPeers().map((p) => p.peerId)).not.toContain("planted");

    peer.addPeer(coordIdentity, "coordinator", { trusted: true });
    const fromCoord = proto.createMessage("peer_exchange", "coord-1", { peers: [entry("listed", "https://listed.example")] }, coordKeys.privateKeyPem, 30_000);
    expect((await peer.handleIngest(fromCoord)).ok).toBe(true);
    expect(peer.getPeer("listed")?.trusted).toBe(true);
    expect(peer.gossip.listPeers().map((p) => p.peerId)).toContain("listed");
  });
});

describe("MeshTaskQueue bounds", () => {
  const st = (id: string): Subtask => ({ id, taskId: "t", kind: "single_step", language: "python", input: "x", timeoutMs: 1000, snapshotRef: "s", projectMeta: { projectId: "p", resourceClass: "cpu", priority: 1 } });

  it("refuses offers past the queue cap and duplicates", () => {
    const q = new MeshTaskQueue(2, 10);
    expect(q.push({ subtask: st("a"), fromPeerId: "c" })).toBe(true);
    expect(q.push({ subtask: st("a"), fromPeerId: "c" })).toBe(false);
    expect(q.push({ subtask: st("b"), fromPeerId: "c" })).toBe(true);
    expect(q.push({ subtask: st("c"), fromPeerId: "c" })).toBe(false);
    expect(q.length).toBe(2);
    expect(q.remove("a")).toBe(true);
    expect(q.shift()?.subtask.id).toBe("b");
  });

  it("bounds the remembered claimed ids", () => {
    const q = new MeshTaskQueue(1000, 3);
    for (const id of ["a", "b", "c", "d"]) q.push({ subtask: st(id), fromPeerId: "c" });
    expect(q.hasClaimed("a")).toBe(false);
    expect(q.hasClaimed("d")).toBe(true);
  });
});
