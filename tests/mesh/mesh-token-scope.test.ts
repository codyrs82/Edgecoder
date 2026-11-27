import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { GossipMesh } from "../../src/mesh/gossip.js";
import { meshTokenAllowedFor, meshTokenForUrl, parseMeshTokenScope } from "../../src/mesh/mesh-token-scope.js";

describe("MESH_TOKEN_PEER_URLS (which peers get the mesh token)", () => {
  it("unset sends the token to every peer (today's behaviour)", () => {
    expect(parseMeshTokenScope(undefined)).toBeNull();
    expect(parseMeshTokenScope(" , ")).toBeNull();
    expect(meshTokenForUrl("tok", null, "https://anyone.example/mesh/ingest")).toBe("tok");
  });

  it("set: only the listed origins get it, matched by scheme, host and port", () => {
    const scope = parseMeshTokenScope("https://coordinator.edgecoder.io, https://Coordinator-EU.edgecoder.io/");
    expect(meshTokenForUrl("tok", scope, "https://coordinator.edgecoder.io/mesh/ingest")).toBe("tok");
    expect(meshTokenForUrl("tok", scope, "https://coordinator-eu.edgecoder.io/receipts/since?cursor=")).toBe("tok");
    expect(meshTokenForUrl("tok", scope, "https://outside.example/mesh/ingest")).toBeUndefined();
    expect(meshTokenForUrl("tok", scope, "http://coordinator.edgecoder.io/mesh/ingest")).toBeUndefined();
    expect(meshTokenForUrl("tok", scope, "https://coordinator.edgecoder.io:8443/x")).toBeUndefined();
    expect(meshTokenForUrl("tok", scope, "https://coordinator.edgecoder.io.evil.example/x")).toBeUndefined();
    expect(meshTokenAllowedFor(scope, "not a url")).toBe(false);
    expect(meshTokenForUrl("", scope, "https://coordinator.edgecoder.io/x")).toBeUndefined();
  });

  it("refuses an entry that is not a URL", () => {
    expect(() => parseMeshTokenScope("coordinator.edgecoder.io")).toThrow(/MESH_TOKEN_PEER_URLS/);
  });

  it("gossip leaves the token off requests to peers outside the scope", async () => {
    const got: Array<{ port: number; headers: IncomingHttpHeaders }> = [];
    const servers = await Promise.all(
      [0, 1].map(
        () =>
          new Promise<ReturnType<typeof createServer>>((resolve) => {
            const s = createServer((req, res) => {
              req.resume();
              req.on("end", () => {
                got.push({ port: (s.address() as AddressInfo).port, headers: req.headers });
                res.writeHead(200, { "content-type": "application/json" });
                res.end("{}");
              });
            });
            s.listen(0, "127.0.0.1", () => resolve(s));
          })
      )
    );
    try {
      const [inside, outside] = servers.map((s) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`);
      const scope = parseMeshTokenScope(inside);
      const mesh = new GossipMesh();
      mesh.setMeshToken("tok");
      mesh.setMeshTokenScope((url) => meshTokenAllowedFor(scope, url));
      mesh.addPeer({ peerId: "ours", publicKeyPem: "pk", coordinatorUrl: inside, networkMode: "public_mesh" });
      mesh.addPeer({ peerId: "theirs", publicKeyPem: "pk2", coordinatorUrl: outside, networkMode: "public_mesh" });
      await mesh.broadcast({ id: "m-1", type: "queue_summary", fromPeerId: "self", issuedAtMs: Date.now(), ttlMs: 1000, payload: { queued: 0 }, signature: "sig" });
      expect(got).toHaveLength(2);
      const byPort = new Map(got.map((g) => [g.port, g.headers]));
      expect(byPort.get((servers[0].address() as AddressInfo).port)?.["x-mesh-token"]).toBe("tok");
      expect(byPort.get((servers[1].address() as AddressInfo).port)?.["x-mesh-token"]).toBeUndefined();
    } finally {
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    }
  });
});
