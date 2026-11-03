import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PinnedKeyStore, checkCoordinatorTrust, type IdentityFetch } from "../../src/trust/pinned-keys.js";
import { newChallengeNonce, verifyIdentityChallenge } from "../../src/trust/identity-challenge.js";

/*
 * The coordinator side of the agent's trust check, against the real app (Fastify inject):
 * POST /identity/challenge is public like /identity and signs with the coordinator's identity key;
 * /mesh/ws takes the mesh token from the header alone (agents no longer put it in the URL).
 */

let app: any;

beforeAll(async () => {
  process.env.MESH_AUTH_TOKEN = "mesh-secret-test";
  ({ coordinatorServer: app } = await import("../../src/swarm/coordinator.js"));
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app?.close();
});

const injectFetch: IdentityFetch = async (url, init) => {
  const u = new URL(url);
  const res = await app.inject({ method: init?.method ?? "GET", url: u.pathname, headers: init?.headers, payload: init?.body });
  return { ok: res.statusCode < 300, status: res.statusCode, json: async () => res.json() };
};

describe("POST /identity/challenge", () => {
  test("is public and signs the nonce with the key /identity reports", async () => {
    const identity = (await app.inject({ method: "GET", url: "/identity" })).json();
    const sent = { nonce: newChallengeNonce(), url: "https://coordinator.example" };
    const res = await app.inject({ method: "POST", url: "/identity/challenge", headers: { "content-type": "application/json" }, payload: JSON.stringify(sent) });
    expect(res.statusCode).toBe(200);
    expect(verifyIdentityChallenge(res.json(), sent, identity)).toEqual({ ok: true });
  });

  test("refuses a malformed challenge", async () => {
    const res = await app.inject({ method: "POST", url: "/identity/challenge", headers: { "content-type": "application/json" }, payload: JSON.stringify({ nonce: "x" }) });
    expect(res.statusCode).toBe(400);
  });

  test("an agent in strict mode trusts it end to end", async () => {
    const identity = (await app.inject({ method: "GET", url: "/identity" })).json();
    const store = new PinnedKeyStore({ mode: "strict", entries: identity.trustEntry, pinFile: null });
    const res = await checkCoordinatorTrust("https://coordinator.example", { store, fetch: injectFetch });
    expect(res).toMatchObject({ trusted: true, proof: "challenge", decision: { reason: "pinned_match" } });
  });
});

describe("/mesh/ws token", () => {
  const closeCode = (ws: any) =>
    new Promise<number | null>((resolve) => {
      const t = setTimeout(() => resolve(null), 300);
      ws.on("close", (code: number) => {
        clearTimeout(t);
        resolve(code);
      });
    });

  test("accepts the header without a token query parameter", async () => {
    const ws = await app.injectWS("/mesh/ws?peerId=agent-ws-test", { headers: { "x-mesh-token": "mesh-secret-test" } });
    expect(await closeCode(ws)).not.toBe(4001);
    ws.terminate();
  });

  test("refuses a connection with no token", async () => {
    const ws = await app.injectWS("/mesh/ws?peerId=agent-ws-test2", { headers: {} });
    expect(await closeCode(ws)).toBe(4001);
  });
});
