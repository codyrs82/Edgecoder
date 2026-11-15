import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createPeerKeys, type PeerKeys } from "../../src/mesh/peer.js";
import { hashRequestBody, signRequest } from "../../src/security/request-signing.js";

/*
 * DoS: any registered agent can post direct-work offers to any other agent. Offers ride the
 * target's heartbeat responses, so their size, count and lifetime must be bounded.
 */

const VALID_TOKEN = "valid-registration-token";
const REMOTE = "203.0.113.55";
let portal: Server;
let app: any;
const attacker = createPeerKeys("agent-dw-attacker");
const victim = createPeerKeys("agent-dw-victim");

function signed(keys: PeerKeys, path: string, raw: string): Record<string, string> {
  return signRequest({ method: "POST", path, bodyHash: hashRequestBody(raw), privateKeyPem: keys.privateKeyPem, agentId: keys.peerId }) as unknown as Record<string, string>;
}
function post(keys: PeerKeys, url: string, body: unknown) {
  const payload = JSON.stringify(body);
  return app.inject({ method: "POST", url, remoteAddress: REMOTE, headers: { "content-type": "application/json", ...signed(keys, url, payload) }, payload });
}

beforeAll(async () => {
  portal = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body.registrationToken === VALID_TOKEN ? { allowed: true, reason: "ok", node: {} } : { allowed: false, reason: "invalid_token" }));
    });
  });
  await new Promise<void>((resolve) => portal.listen(0, "127.0.0.1", resolve));
  process.env.PORTAL_SERVICE_URL = `http://127.0.0.1:${(portal.address() as AddressInfo).port}`;
  process.env.MESH_AUTH_TOKEN = "mesh-secret-dw";
  delete process.env.COORDINATOR_TRUST_PROXY;
  delete process.env.FLY_APP_NAME;
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  for (const keys of [attacker, victim]) {
    const res = await post(keys, "/register", { os: "macos", version: "1", mode: "swarm-only", agentId: keys.peerId, registrationToken: VALID_TOKEN, publicKeyPem: keys.publicKeyPem });
    expect(res.statusCode).toBe(200);
  }
}, 60_000);

afterAll(async () => {
  vi.useRealTimers();
  await app?.close();
  await new Promise<void>((resolve) => portal.close(() => resolve()));
});

const offer = (input: string) => ({ fromAgentId: attacker.peerId, toAgentId: victim.peerId, workType: "code_task", language: "python", input });

describe("direct-work offers are bounded", () => {
  test("an oversized offer is refused", async () => {
    expect((await post(attacker, "/agent-mesh/direct-work/offer", offer("x".repeat(200_000)))).statusCode).toBe(400);
  });

  test("a target's pending inbox is capped, and its heartbeat carries at most the cap", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 20; i++) codes.push((await post(attacker, "/agent-mesh/direct-work/offer", offer(`print(${i})`))).statusCode);
    expect(codes.filter((c) => c === 200).length).toBe(16);
    expect(codes.filter((c) => c === 429).length).toBe(4);
    const hb = await post(victim, "/heartbeat", { agentId: victim.peerId });
    expect(hb.statusCode).toBe(200);
    expect(hb.json().directWorkOffers.length).toBe(16);
  });

  test("pending offers expire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const hb = await post(victim, "/heartbeat", { agentId: victim.peerId });
    expect(hb.statusCode).toBe(200);
    expect(hb.json().directWorkOffers.length).toBe(0);
    // The inbox has room again.
    expect((await post(attacker, "/agent-mesh/direct-work/offer", offer("print(1)"))).statusCode).toBe(200);
    vi.useRealTimers();
  });
});
