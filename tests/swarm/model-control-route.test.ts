import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { signMeshWsBind } from "../../src/mesh/ws-auth.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";
import { CommandReplayGuard, verifyModelControlFrame } from "../../src/model/remote-control/protocol.js";
import { ModelControlAgent } from "../../src/model/remote-control/agent-controller.js";
import { createOllamaAdmin } from "../../src/model/remote-control/ollama-admin.js";
import { overridesPath } from "../../src/model/remote-control/overrides.js";
import { resolveAllowlist } from "../../src/model/remote-control/policy.js";
import { startFakeOllama, type FakeOllama } from "../model/remote-control/fake-ollama.js";

/*
 * Remote model control through the real coordinator app: only the owning account (portal service
 * token + accountId, checked against the verified ownership mapping) can command a machine; the
 * command reaches the agent only down its authenticated mesh WebSocket, signed by the coordinator;
 * the agent's signed reports settle the audit entry. End to end with a fake Ollama.
 */

const accounts = vi.hoisted(() => new Map<string, string>());
vi.mock("../../src/swarm/coordinator/agent-accounts.js", () => ({
  verifiedAccountOf: async (agentId: string) => accounts.get(agentId) ?? null
}));

const PORTAL_TOKEN = "p".repeat(40);
const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.88";
const mine = createPeerKeys("agent-mc-mine");
const theirs = createPeerKeys("agent-mc-theirs");
const unowned = createPeerKeys("agent-mc-unowned");
const offline = createPeerKeys("agent-mc-offline");
let portal: Server;
let app: any;
let ollama: FakeOllama;
const frames = new Map<string, string[]>();
const sockets: any[] = [];
let coordinatorIdentity: { peerId: string; publicKeyPem: string };

function signedPost(keys: PeerKeys, url: string, body: unknown) {
  const payload = JSON.stringify(body);
  const headers = signRequest({ method: "POST", path: url, bodyHash: hashRequestBody(payload), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", ...headers }, payload });
}
const portalPost = (url: string, body: unknown, token: string | null = PORTAL_TOKEN) =>
  app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", ...(token ? { "x-portal-service-token": token } : {}) }, payload: JSON.stringify(body) });
const command = (agentId: string, accountId: string, action: string, args: unknown = {}, token?: string | null) =>
  portalPost(`/agent-control/agents/${agentId}/commands`, { accountId, action, args }, token);
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return cond();
};

beforeAll(async () => {
  accounts.set(mine.peerId, "acct-owner");
  accounts.set(offline.peerId, "acct-owner");
  accounts.set(theirs.peerId, "acct-other");
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body.registrationToken === VALID_TOKEN ? { allowed: true, reason: "portal_validated", node: {} } : { allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((r) => portal.listen(0, "127.0.0.1", r));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.PORTAL_SERVICE_TOKEN = PORTAL_TOKEN;
  process.env.MESH_AUTH_TOKEN = "mesh-secret-mc";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  delete process.env.DATABASE_URL;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  const id = (await app.inject({ method: "GET", url: "/identity" })).json();
  coordinatorIdentity = { peerId: id.peerId, publicKeyPem: id.publicKeyPem };
  for (const k of [mine, theirs, unowned, offline]) {
    const res = await signedPost(k, "/register", { os: "linux", version: "1", mode: "swarm-only", agentId: k.peerId, registrationToken: VALID_TOKEN, publicKeyPem: k.publicKeyPem });
    expect(res.statusCode, res.body).toBe(200);
  }
  // Agents hold no mesh token: they bind the socket with their own key.
  for (const k of [mine, theirs, unowned]) {
    const ws = await app.injectWS(`/mesh/ws?peerId=${k.peerId}`, { headers: signMeshWsBind(k.peerId, k.privateKeyPem) });
    frames.set(k.peerId, []);
    ws.on("message", (d: Buffer) => frames.get(k.peerId)!.push(d.toString()));
    sockets.push(ws);
  }
  ollama = await startFakeOllama({ "qwen3.5:9b": 6.6e9 });
}, 60_000);

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await app?.close();
  await ollama?.close();
  await new Promise<void>((r) => portal.close(() => r()));
});

const modelFrames = (k: PeerKeys) => (frames.get(k.peerId) ?? []).map((f) => JSON.parse(f)).filter((f) => f.type === "model_control");

describe("only the owning account can control a machine", () => {
  test("no portal service token: refused", async () => {
    expect((await command(mine.peerId, "acct-owner", "refresh", {}, null)).statusCode).toBe(401);
    expect((await command(mine.peerId, "acct-owner", "refresh", {}, "x".repeat(40))).statusCode).toBe(401);
  });

  test("another account cannot control my machine, and nothing reaches the agent", async () => {
    const res = await command(mine.peerId, "acct-other", "pull", { model: "qwen3.5:4b" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_your_machine");
    expect(modelFrames(mine)).toEqual([]);
  });

  test("a machine with no verified owner cannot be controlled by anyone", async () => {
    expect((await command(unowned.peerId, "acct-owner", "pull", { model: "qwen3.5:4b" })).json().error).toBe("not_your_machine");
    expect((await command(unowned.peerId, unowned.peerId, "pull", { model: "qwen3.5:4b" })).statusCode).toBe(400);
  });

  test("invalid commands are refused before anything is signed", async () => {
    expect((await command(mine.peerId, "acct-owner", "pull", { model: "evil.com/x:1" })).statusCode).toBe(400);
    expect((await command(mine.peerId, "acct-owner", "install_ollama", {})).statusCode).toBe(400);
    expect((await command(mine.peerId, "acct-owner", "set_settings", { parallel: 2, shell: "x" })).statusCode).toBe(400);
  });

  test("a machine without an authenticated socket is not connected", async () => {
    expect((await command(offline.peerId, "acct-owner", "restart_model")).json().error).toBe("agent_not_connected");
  });

  test("a machine's list shows only the caller's own machines", async () => {
    const res = await portalPost("/agent-control/machines", { accountId: "acct-owner", agentIds: [mine.peerId, theirs.peerId, unowned.peerId] });
    expect(res.statusCode).toBe(200);
    expect(res.json().machines.map((m: any) => m.agentId)).toEqual([mine.peerId]);
    // What a target "mine" call could run there (the portal's web chat Auto reads it): nothing reported yet.
    expect(res.json().machines[0].models).toEqual([]);
  });
});

describe("end to end: portal -> coordinator -> agent -> fake Ollama -> report", () => {
  test("the owner's pull is signed for the agent, carried out, and audited", async () => {
    const res = await command(mine.peerId, "acct-owner", "pull", { model: "qwen3.5:4b" });
    expect(res.statusCode, res.body).toBe(200);
    const commandId = res.json().commandId;
    expect(await until(() => modelFrames(mine).length === 1)).toBe(true);
    const frame = modelFrames(mine)[0];
    expect(frame.command).toMatchObject({ id: commandId, agentId: mine.peerId, requestedBy: "acct-owner", action: "pull", coordinatorId: coordinatorIdentity.peerId });
    // The other agents got nothing.
    expect(modelFrames(theirs)).toEqual([]);
    // The agent verifies it against the coordinator key it pinned.
    expect(verifyModelControlFrame(frame, { agentId: mine.peerId, coordinator: coordinatorIdentity, replay: new CommandReplayGuard() }).ok).toBe(true);

    const reports: number[] = [];
    const agent = new ModelControlAgent({
      agentId: mine.peerId,
      enabled: true,
      allowlist: resolveAllowlist(undefined),
      ollama: createOllamaAdmin(ollama.url),
      overridesFile: overridesPath(mkdtempSync(join(tmpdir(), "ec-mc-e2e-"))),
      env: { model: "qwen3.5:9b" },
      overrides: { version: 1 },
      current: () => ({ model: "qwen3.5:9b", contextWindow: 16384, parallel: 2, keepAlive: "30m", sources: { model: "env", contextWindow: "default", parallel: "default", keepAlive: "default" } }),
      apply: async () => undefined,
      hardware: { ramBytes: 64e9 },
      modelsDir: tmpdir(),
      diskSpace: () => ({ freeBytes: 500e9, totalBytes: 1000e9 }),
      sizeOf: async () => undefined,
      report: async (body) => {
        const r = await signedPost(mine, `/agent-control/agents/${mine.peerId}/report`, body);
        reports.push(r.statusCode);
      }
    });
    const outcome = await agent.handleFrame(frame, coordinatorIdentity);
    expect(outcome.status).toBe("done");
    expect(ollama.models.has("qwen3.5:4b")).toBe(true);
    expect(reports.every((c) => c === 200)).toBe(true);
    // The same frame again (a replay down the socket) is refused by the agent.
    expect((await agent.handleFrame(frame, coordinatorIdentity)).error).toBe("replayed");

    const view = (await portalPost("/agent-control/machines", { accountId: "acct-owner", agentIds: [mine.peerId] })).json().machines[0];
    expect(view.connected).toBe(true);
    expect(view.state.installed.map((m: any) => m.name)).toContain("qwen3.5:4b");
    expect(view.audit[0]).toMatchObject({ commandId, action: "pull", status: "done", accountId: "acct-owner" });
    // Another account sees none of it.
    expect((await portalPost("/agent-control/machines", { accountId: "acct-other", agentIds: [mine.peerId] })).json().machines).toEqual([]);
  });

  test("an agent reports only for itself, and only on commands sent to it", async () => {
    const res = await command(mine.peerId, "acct-owner", "restart_model");
    const commandId = res.json().commandId;
    // Signed by another agent at my path: refused.
    expect((await signedPost(theirs, `/agent-control/agents/${mine.peerId}/report`, { result: { commandId, status: "done" } })).statusCode).toBe(403);
    // Its own path, my command id: not its command.
    expect((await signedPost(theirs, `/agent-control/agents/${theirs.peerId}/report`, { result: { commandId, status: "done" } })).json().error).toBe("unknown_command");
    // Unsigned: refused at the gate.
    const unsigned = await app.inject({ method: "POST", url: `/agent-control/agents/${mine.peerId}/report`, remoteAddress: REMOTE, headers: { "content-type": "application/json" }, payload: JSON.stringify({ result: { commandId, status: "done" } }) });
    expect(unsigned.statusCode).toBe(401);
    const view = (await portalPost("/agent-control/machines", { accountId: "acct-owner", agentIds: [mine.peerId] })).json().machines[0];
    expect(view.audit.find((e: any) => e.commandId === commandId).status).toBe("sent");
  });

  test("commands are rate-limited per machine, and one pull runs at a time", async () => {
    const first = await command(mine.peerId, "acct-owner", "pull", { model: "qwen3.5:2b" });
    expect(first.statusCode).toBe(200);
    expect((await command(mine.peerId, "acct-owner", "pull", { model: "qwen3.5:0.8b" })).json().error).toBe("pull_in_progress");
    let limited = false;
    for (let i = 0; i < 15 && !limited; i++) limited = (await command(mine.peerId, "acct-owner", "set_settings", { parallel: 2 })).statusCode === 429;
    expect(limited).toBe(true);
    // A refresh right after another one is limited too.
    await command(mine.peerId, "acct-owner", "refresh");
    expect((await command(mine.peerId, "acct-owner", "refresh")).statusCode).toBe(429);
  });
});
