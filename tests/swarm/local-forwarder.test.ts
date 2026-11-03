import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request } from "undici";
import { createLocalForwarder } from "../../src/swarm/local-forwarder.js";

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

describe("local forwarder", () => {
  let coordinator: Server;
  let forwarder: Server;
  let coordUrl: string;
  let fwdUrl: string;
  let registered: string | null;
  const seen: Array<{ method?: string; url?: string; headers: Record<string, unknown>; body: string }> = [];

  beforeEach(async () => {
    seen.length = 0;
    coordinator = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(req.url === "/submit" ? JSON.stringify({ taskId: "t1", subtasks: ["s1"] }) : JSON.stringify({ output: "42", ok: true }));
      });
    });
    coordUrl = await listen(coordinator);
    registered = coordUrl;
    forwarder = createLocalForwarder({
      token: () => "secret-token",
      coordinatorUrl: () => registered,
      meshHeaders: () => ({ "x-mesh-token": "mesh" }),
      signedHeaders: (path, raw) => ({ "x-agent-id": "mac-1", "x-signature": `sig:${path}:${raw.length}` }),
      agentId: "mac-1",
      steering: () => ({ url: coordUrl, source: "registry", peerId: "coord-ord", region: "ord", latencyMs: 12, reason: "", decidedAtMs: 1 })
    });
    fwdUrl = await listen(forwarder);
  });

  it("reports the coordinator steering decision on /forward/health", async () => {
    const res = await request(`${fwdUrl}/forward/health`, { headers: { authorization: "Bearer secret-token" } });
    expect(res.statusCode).toBe(200);
    expect(await res.body.json()).toMatchObject({ registered: true, steering: { source: "registry", region: "ord", latencyMs: 12 } });
  });

  afterEach(() => {
    coordinator.close();
    forwarder.close();
  });

  const auth = { authorization: "Bearer secret-token" };

  it("requires the bearer token and refuses browser requests", async () => {
    expect((await request(`${fwdUrl}/forward/health`)).statusCode).toBe(401);
    expect((await request(`${fwdUrl}/forward/health`, { headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await request(`${fwdUrl}/forward/health`, { headers: { ...auth, origin: "https://evil.example" } })).statusCode).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("signs and relays a submission with the exact body bytes", async () => {
    const raw = JSON.stringify({ taskId: "t1", prompt: "add two numbers", snapshotRef: "a".repeat(40) });
    const res = await request(`${fwdUrl}/forward/submit`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: raw });
    expect(res.statusCode).toBe(200);
    expect(await res.body.json()).toEqual({ taskId: "t1", subtasks: ["s1"] });
    expect(seen[0].url).toBe("/submit");
    expect(seen[0].body).toBe(raw);
    expect(seen[0].headers["x-mesh-token"]).toBe("mesh");
    expect(seen[0].headers["x-signature"]).toBe(`sig:/submit:${raw.length}`);
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it("relays result polls and rejects other paths", async () => {
    const res = await request(`${fwdUrl}/forward/tasks/t1/subtasks/s1/result`, { headers: auth });
    expect(res.statusCode).toBe(200);
    expect(seen[0].url).toBe("/tasks/t1/subtasks/s1/result");
    expect((await request(`${fwdUrl}/forward/tasks/../subtasks/x/result`, { headers: auth })).statusCode).toBe(404);
    expect((await request(`${fwdUrl}/forward/admin`, { headers: auth })).statusCode).toBe(404);
  });

  it("answers 503 until the agent has registered", async () => {
    registered = null;
    const res = await request(`${fwdUrl}/forward/submit`, { method: "POST", headers: auth, body: "{}" });
    expect(res.statusCode).toBe(503);
    expect(seen).toHaveLength(0);
  });
});
