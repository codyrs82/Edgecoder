import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/*
 * /portal/chat fails over to a peer coordinator when local Ollama is down (real coordinator app,
 * Fastify inject). The portal service token names any account and must never be sent to a peer:
 * the forward carries the mesh token, which peers already hold.
 */

const MESH = "mesh-secret-chat";
const PORTAL = "portal-secret-chat";
let peer: Server;
let deadOllama: Server;
let app: any;
const seen: IncomingHttpHeaders[] = [];

beforeAll(async () => {
  peer = createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("data: {\"done\":true}\n\n");
    });
  });
  // An Ollama that is not there: a port that refuses connections.
  deadOllama = createServer();
  await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => deadOllama.listen(0, "127.0.0.1", resolve));
  const deadPort = (deadOllama.address() as AddressInfo).port;
  await new Promise<void>((resolve) => deadOllama.close(() => resolve()));
  process.env.MESH_AUTH_TOKEN = MESH;
  process.env.PORTAL_SERVICE_TOKEN = PORTAL;
  process.env.OLLAMA_HOST = `http://127.0.0.1:${deadPort}`;
  process.env.COORDINATOR_BOOTSTRAP_URLS = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;
  delete process.env.MESH_PEER_ALLOWLIST;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
  await new Promise<void>((resolve) => peer.close(() => resolve()));
  delete process.env.COORDINATOR_BOOTSTRAP_URLS;
  delete process.env.OLLAMA_HOST;
});

describe("/portal/chat peer failover", () => {
  test("sends the mesh token to the peer, never the portal service token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/portal/chat",
      headers: { "content-type": "application/json", "x-portal-service-token": PORTAL },
      payload: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.statusCode).toBe(200);
    expect(seen.length).toBeGreaterThan(0);
    for (const h of seen) {
      expect(h["x-portal-service-token"]).toBeUndefined();
      expect(h["x-mesh-token"]).toBe(MESH);
    }
  });
});
