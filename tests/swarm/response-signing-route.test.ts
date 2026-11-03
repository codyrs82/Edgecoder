import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PinnedKeyStore, checkCoordinatorTrust, type IdentityFetch } from "../../src/trust/pinned-keys.js";
import { AGENT_NONCE_HEADER, RESPONSE_SIG_HEADER, newAgentNonce, verifyCoordinatorResponse } from "../../src/trust/response-signing.js";

/*
 * The real coordinator app signs every response to an agent request (one carrying x-agent-nonce)
 * and advertises it in /identity and in its identity-challenge answer.
 */

let app: any;
let identity: { peerId: string; publicKeyPem: string; trustEntry: string; responseSigning?: number };

beforeAll(async () => {
  process.env.MESH_AUTH_TOKEN = "mesh-secret-test";
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
  identity = (await app.inject({ method: "GET", url: "/identity" })).json();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const injectFetch: IdentityFetch = async (url, init) => {
  const u = new URL(url);
  const res = await app.inject({ method: init?.method ?? "GET", url: u.pathname, headers: init?.headers, payload: init?.body });
  return { ok: res.statusCode < 300, status: res.statusCode, json: async () => res.json() };
};

async function agentCall(method: "GET" | "POST", url: string, headers: Record<string, string> = {}, body?: string) {
  const nonce = newAgentNonce();
  const res = await app.inject({ method, url, headers: { ...headers, [AGENT_NONCE_HEADER]: nonce }, ...(body !== undefined ? { payload: body } : {}) });
  const verdict = verifyCoordinatorResponse(
    { method, path: url, status: res.statusCode, body: res.rawPayload, headers: res.headers },
    { nonce, agentId: headers["x-agent-id"] ?? "" },
    identity
  );
  return { res, verdict };
}

describe("coordinator response signing", () => {
  test("advertises responseSigning in /identity and the challenge answer", async () => {
    expect(identity.responseSigning).toBe(1);
    const store = new PinnedKeyStore({ mode: "strict", entries: identity.trustEntry, pinFile: null });
    const check = await checkCoordinatorTrust("https://coordinator.example", { store, fetch: injectFetch });
    expect(check).toMatchObject({ trusted: true, responseSigning: true, publicKeyPem: identity.publicKeyPem, peerId: identity.peerId });
  });

  test("signs agent-mesh peer lists", async () => {
    const { res, verdict } = await agentCall("GET", "/agent-mesh/peers/agent-1", { "x-mesh-token": "mesh-secret-test", "x-agent-id": "agent-1" });
    expect(res.statusCode).toBe(200);
    expect(verdict).toEqual({ ok: true });
  });

  test("signs heartbeat, pull and result answers, refusals included", async () => {
    for (const path of ["/heartbeat", "/pull", "/result", "/register", "/agent-mesh/accept", "/inference/chunks"]) {
      const { res, verdict } = await agentCall("POST", path, { "content-type": "application/json", "x-mesh-token": "mesh-secret-test", "x-agent-id": "agent-1" }, JSON.stringify({ agentId: "agent-1" }));
      expect(res.headers[RESPONSE_SIG_HEADER], path).toBeDefined();
      expect(verdict, `${path} -> ${res.statusCode}`).toEqual({ ok: true });
    }
  });

  test("a response for one request does not verify for another nonce", async () => {
    const { res } = await agentCall("GET", "/agent-mesh/peers/agent-1", { "x-mesh-token": "mesh-secret-test" });
    const replayed = verifyCoordinatorResponse(
      { method: "GET", path: "/agent-mesh/peers/agent-1", status: res.statusCode, body: res.rawPayload, headers: res.headers },
      { nonce: newAgentNonce(), agentId: "" },
      identity
    );
    expect(replayed).toEqual({ ok: false, error: "response_bad_signature" });
  });

  test("requests without x-agent-nonce (portal, browsers) are not signed", async () => {
    const res = await app.inject({ method: "GET", url: "/identity" });
    expect(res.headers[RESPONSE_SIG_HEADER]).toBeUndefined();
  });
});
