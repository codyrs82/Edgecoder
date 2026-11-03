import { afterEach, describe, expect, it } from "vitest";
import { request } from "undici";
import { createPeerKeys } from "../../src/mesh/peer.js";
import { MeshPeer } from "../../src/mesh/mesh-peer.js";
import { MeshHttpServer } from "../../src/mesh/mesh-http-server.js";

let server: MeshHttpServer | null = null;
afterEach(async () => {
  await server?.stop();
  server = null;
});

async function start(meshToken?: string) {
  const peer = new MeshPeer({ peerId: "agent-x", keys: createPeerKeys("agent-x"), publicUrl: "http://127.0.0.1:0", networkMode: "public_mesh", role: "agent", bootstrapUrls: [], meshToken });
  server = new MeshHttpServer({ port: 0, host: "127.0.0.1", meshPeer: peer, meshToken });
  const port = await server.start();
  const base = `http://127.0.0.1:${port}`;
  const get = async (path: string, token?: string) => {
    const res = await request(`${base}${path}`, { method: "GET", headers: token ? { "x-mesh-token": token } : {} });
    await res.body.dump();
    return res.statusCode;
  };
  const post = async (path: string, body: unknown, token?: string) => {
    const res = await request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-mesh-token": token } : {}) }, body: JSON.stringify(body) });
    await res.body.dump();
    return res.statusCode;
  };
  return { peer, get, post };
}

const peerBody = { peerId: "intruder", publicKeyPem: createPeerKeys("intruder").publicKeyPem, coordinatorUrl: "http://10.0.0.9:1", networkMode: "public_mesh" };

describe("agent mesh HTTP server fails closed", () => {
  it("without a token refuses everything except /identity", async () => {
    const { peer, get, post } = await start(undefined);
    expect(await get("/identity")).toBe(200);
    expect(await get("/mesh/peers")).toBe(401);
    expect(await get("/mesh/peers", "anything")).toBe(401);
    expect(await post("/mesh/register-peer", peerBody)).toBe(401);
    expect(await post("/mesh/ingest", {})).toBe(401);
    expect(peer.peerCount()).toBe(0);
  });

  it("accepts the right token after setMeshToken, and only that token", async () => {
    const { peer, get, post } = await start(undefined);
    server!.setMeshToken("tok-123");
    peer.setMeshToken("tok-123");
    expect(await get("/mesh/peers", "tok-123")).toBe(200);
    expect(await get("/mesh/peers", "tok-124")).toBe(401);
    expect(await get("/mesh/peers")).toBe(401);
    expect(await post("/mesh/register-peer", peerBody, "tok-123")).toBe(200);
    expect(peer.config.meshToken).toBe("tok-123");
  });
});
