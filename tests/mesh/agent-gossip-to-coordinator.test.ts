import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { MeshPeer } from "../../src/mesh/mesh-peer.js";

/*
 * Since agents stopped holding the coordinators' mesh token (#288), a coordinator answers an
 * agent's POST /mesh/ingest with 401 mesh_unauthorized. Agents used to try anyway on every
 * peer_exchange (30 s), log a warning and mark the coordinator NATed. They now gossip to a
 * coordinator only down the signed mesh WebSocket, and never over the token-gated HTTP routes.
 */
let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

/** A stand-in coordinator that refuses every mesh request without the token, as production does. */
async function tokenGatedCoordinator(): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    req.resume();
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "mesh_unauthorized" }));
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  return { url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`, hits };
}

function peer(role: "agent" | "coordinator", meshToken?: string) {
  return new MeshPeer({ peerId: `${role}-x`, keys: createPeerKeys(`${role}-x`), publicUrl: "http://127.0.0.1:0", networkMode: "public_mesh", role, bootstrapUrls: [], meshToken });
}

function addCoordinator(p: MeshPeer, url: string) {
  p.addPeer({ peerId: "coord-1", publicKeyPem: createPeerKeys("coord-1").publicKeyPem, coordinatorUrl: url, networkMode: "public_mesh" }, "coordinator", { trusted: true });
}

describe("agent gossip to coordinators", () => {
  it("an agent without the mesh token never POSTs gossip to a coordinator and does not mark it NATed", async () => {
    const coord = await tokenGatedCoordinator();
    const agent = peer("agent");
    addCoordinator(agent, coord.url);
    for (let i = 0; i < 3; i++) await agent.broadcast("peer_exchange", { peers: [] });
    expect(coord.hits).toEqual([]);
    expect(agent.gossip.isNatted("coord-1")).toBe(false);
    // Still a gossip target: the entry is kept (no eviction as unreachable).
    expect(agent.gossip.listPeers().map((p) => p.peerId)).toContain("coord-1");
  });

  it("it still gossips to the coordinator down the open mesh WebSocket", async () => {
    const coord = await tokenGatedCoordinator();
    const agent = peer("agent");
    addCoordinator(agent, coord.url);
    const sent: string[] = [];
    agent.gossip.setWebSocketForPeer("coord-1", { readyState: 1, send: (d: string) => sent.push(d) } as never);
    await agent.broadcast("task_claim", { subtaskId: "s1", claimedByCoordinator: "agent-x" });
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]).type).toBe("task_claim");
    expect(coord.hits).toEqual([]);
  });

  it("coordinators, and agents an operator gave the token, keep the HTTP path", async () => {
    const coord = await tokenGatedCoordinator();
    const c = peer("coordinator", "tok");
    addCoordinator(c, coord.url);
    await c.broadcast("peer_exchange", { peers: [] });
    expect(coord.hits).toContain("POST /mesh/ingest");
    coord.hits.length = 0;
    const operatorAgent = peer("agent", "tok");
    addCoordinator(operatorAgent, coord.url);
    await operatorAgent.broadcast("peer_exchange", { peers: [] });
    expect(coord.hits).toContain("POST /mesh/ingest");
  });
});
