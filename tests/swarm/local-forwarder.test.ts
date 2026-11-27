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

  it("reports the jobs this machine serves and its slots on /forward/health", async () => {
    const withServing = createLocalForwarder({
      token: () => "secret-token",
      coordinatorUrl: () => registered,
      meshHeaders: () => ({}),
      signedHeaders: () => ({}),
      agentId: "mac-1",
      lifecycle: () => ({ paused: { reason: "too many failures", sinceMs: 5 }, draining: false, drainingUntilMs: null, claims: 1 }),
      serving: () => ({ jobs: [{ id: "s1", taskId: "inf-1", kind: "inference", model: "qwen3:8b", startedAtMs: 1, outputTokens: 7 }], slots: { total: 2, busy: 1 }, computeClass: "apple", tier: "apple.m" }),
    });
    const url = await listen(withServing);
    const res = await request(`${url}/forward/health`, { headers: { authorization: "Bearer secret-token" } });
    expect(await res.body.json()).toMatchObject({ paused: { reason: "too many failures" }, claims: 1, serving: { slots: { total: 2, busy: 1 }, jobs: [{ model: "qwen3:8b", outputTokens: 7 }] } });
    withServing.close();
  });

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

  it("relays the world view as a signed GET to the coordinator", async () => {
    const res = await request(`${fwdUrl}/forward/network/world`, { headers: auth });
    expect(res.statusCode).toBe(200);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/network/world" });
    expect(seen[0].headers["x-signature"]).toBe("sig:/network/world:0");
    expect(seen[0].headers.authorization).toBeUndefined();
    // Only the agent-facing path: the coordinators' own view is not reachable through it.
    expect((await request(`${fwdUrl}/forward/network/world/local`, { headers: auth })).statusCode).toBe(404);
    expect((await request(`${fwdUrl}/forward/network/world`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" })).statusCode).toBe(404);
  });

  it("relays result polls and rejects other paths", async () => {
    const res = await request(`${fwdUrl}/forward/tasks/t1/subtasks/s1/result`, { headers: auth });
    expect(res.statusCode).toBe(200);
    expect(seen[0].url).toBe("/tasks/t1/subtasks/s1/result");
    expect((await request(`${fwdUrl}/forward/tasks/../subtasks/x/result`, { headers: auth })).statusCode).toBe(404);
    expect((await request(`${fwdUrl}/forward/admin`, { headers: auth })).statusCode).toBe(404);
  });

  it("answers 503 until the agent has registered, after asking it to register and waiting a little", async () => {
    let nudges = 0;
    const waiting = createLocalForwarder({
      token: () => "secret-token",
      coordinatorUrl: () => null,
      meshHeaders: () => ({}),
      signedHeaders: () => ({}),
      agentId: "mac-1",
      nudgeRegistration: () => nudges++,
      registrationWaitMs: 50,
    });
    const url = await listen(waiting);
    const res = await request(`${url}/forward/submit`, { method: "POST", headers: auth, body: "{}" });
    expect(res.statusCode).toBe(503);
    expect(await res.body.json()).toEqual({ error: "agent_not_registered", retryAfterMs: 15_000 });
    expect(nudges).toBe(1);
    expect(seen).toHaveLength(0);
    waiting.close();
  });

  it("a call that comes in while the agent is reconnecting goes through once it has registered", async () => {
    let now: string | null = null;
    const reconnecting = createLocalForwarder({
      token: () => "secret-token",
      coordinatorUrl: () => now,
      meshHeaders: () => ({}),
      signedHeaders: () => ({ "x-agent-id": "mac-1" }),
      agentId: "mac-1",
      // Registering takes a moment after the nudge.
      nudgeRegistration: () => void setTimeout(() => (now = coordUrl), 100),
      registrationWaitMs: 5_000,
    });
    const url = await listen(reconnecting);
    const res = await request(`${url}/forward/submit`, { method: "POST", headers: auth, body: JSON.stringify({ taskId: "t1" }) });
    expect(res.statusCode).toBe(200);
    expect(seen.map((x) => x.url)).toEqual(["/submit"]);
    reconnecting.close();
  });
});
