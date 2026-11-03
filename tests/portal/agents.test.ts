import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_CHALLENGE_TTL_MS, registerAgentRoutes, verifyAgentSignature } from "../../src/portal/routes/agents.js";
import { registerHostedRoutes } from "../../src/portal/routes/hosted.js";
import { AUTH_RATE_LIMIT, rateLimitFor, TOPUP_RATE_LIMIT } from "../../src/portal/security.js";
import { fakeStore } from "./fake-agent-store.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const digest = (s: string) => new Uint8Array(createHash("sha256").update(s, "utf8").digest());

function hostedApp(store = fakeStore(), coordinatorUrls: string[] = []) {
  const app = Fastify();
  const created: string[] = [];
  registerHostedRoutes(app, {
    store: store as never,
    getCurrentUser: async () => null,
    PORTAL_SERVICE_TOKEN: "svc-token",
    EXTERNAL_HTTP_TIMEOUT_MS: 1000,
    discoverCoordinatorUrlsForPortal: async () => coordinatorUrls,
    ensureCreditAccountForUser: async (u) => void created.push(u.userId),
  });
  return { app, store, created };
}

const nostrKey = () => {
  const { secretKey, publicKey } = schnorr.keygen();
  return { keyType: "secp256k1" as const, publicKey: hex(publicKey), sign: (c: string) => hex(schnorr.sign(digest(c), secretKey)) };
};
const edKey = () => {
  const { secretKey, publicKey } = ed25519.keygen();
  return { keyType: "ed25519" as const, publicKey: hex(publicKey), sign: (c: string) => hex(ed25519.sign(digest(c), secretKey)) };
};

async function challenge(app: ReturnType<typeof Fastify>, k: { keyType: string; publicKey: string }) {
  const r = await app.inject({ method: "POST", url: "/agents/challenge", payload: { keyType: k.keyType, publicKey: k.publicKey } });
  expect(r.statusCode).toBe(200);
  return r.json() as { nonce: string; challenge: string; expiresAtMs: number };
}
async function signup(app: ReturnType<typeof Fastify>, k: ReturnType<typeof nostrKey>, extra: Record<string, unknown> = {}) {
  const c = await challenge(app, k);
  return app.inject({ method: "POST", url: "/agents/signup", payload: { keyType: k.keyType, publicKey: k.publicKey, nonce: c.nonce, signature: k.sign(c.challenge), ...extra } });
}

describe("agent signup by public key", () => {
  it("creates an agent account without email and returns a working API key once", async () => {
    const { app, store, created } = hostedApp();
    const k = nostrKey();
    const c = await challenge(app, k);
    expect(c.challenge).toContain(`secp256k1:${k.publicKey}`);
    expect(c.expiresAtMs - Date.now()).toBeLessThanOrEqual(AGENT_CHALLENGE_TTL_MS);
    const r = await app.inject({ method: "POST", url: "/agents/signup", payload: { keyType: k.keyType, publicKey: k.publicKey, nonce: c.nonce, signature: k.sign(c.challenge), name: "Bot" } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.created).toBe(true);
    expect(body.apiKey).toMatch(/^eck_/);
    const userId = body.accountId.replace(/^acct-/, "");
    expect(store.users.get(userId)).toMatchObject({ kind: "agent", displayName: "Bot" });
    expect(store.users.get(userId)!.email).toMatch(/@agents\.invalid$/);
    expect(created).toEqual([userId]);
    // Only the hash is kept; the key works on the hosted endpoint.
    expect([...store.keys.keys()].some((h) => h.includes("eck_"))).toBe(false);
    const models = await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${body.apiKey}` } });
    expect(models.statusCode).toBe(200);
    expect(models.json().data.map((m: { id: string }) => m.id)).toContain("auto");
  });

  it("accepts ed25519 keys", async () => {
    const { app } = hostedApp();
    const r = await signup(app, edKey() as never);
    expect(r.statusCode).toBe(200);
    expect(r.json().created).toBe(true);
  });

  it("refuses a replayed challenge", async () => {
    const { app } = hostedApp();
    const k = nostrKey();
    const c = await challenge(app, k);
    const payload = { keyType: k.keyType, publicKey: k.publicKey, nonce: c.nonce, signature: k.sign(c.challenge) };
    expect((await app.inject({ method: "POST", url: "/agents/signup", payload })).statusCode).toBe(200);
    const again = await app.inject({ method: "POST", url: "/agents/signup", payload });
    expect(again.statusCode).toBe(401);
    expect(again.json().error).toBe("unknown_challenge");
  });

  it("refuses an expired challenge", async () => {
    let t = 1_000_000;
    const store = fakeStore();
    const app = Fastify();
    registerAgentRoutes(app, { store: store as never, issueApiKey: async () => "eck_x", now: () => t });
    const k = nostrKey();
    const c = await challenge(app, k);
    t += AGENT_CHALLENGE_TTL_MS + 1;
    const r = await app.inject({ method: "POST", url: "/agents/signup", payload: { keyType: k.keyType, publicKey: k.publicKey, nonce: c.nonce, signature: k.sign(c.challenge) } });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe("challenge_expired");
    // and it is gone afterwards
    expect(store.challenges.size).toBe(0);
  });

  it("refuses a wrong signature, a signature by another key, and a challenge issued to another key", async () => {
    const { app } = hostedApp();
    const k = nostrKey();
    const other = nostrKey();
    let c = await challenge(app, k);
    const bad = await app.inject({ method: "POST", url: "/agents/signup", payload: { keyType: k.keyType, publicKey: k.publicKey, nonce: c.nonce, signature: "00".repeat(64) } });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toBe("signature_invalid");
    c = await challenge(app, k);
    const forged = await app.inject({ method: "POST", url: "/agents/signup", payload: { keyType: k.keyType, publicKey: k.publicKey, nonce: c.nonce, signature: other.sign(c.challenge) } });
    expect(forged.json().error).toBe("signature_invalid");
    c = await challenge(app, k);
    const swapped = await app.inject({ method: "POST", url: "/agents/signup", payload: { keyType: other.keyType, publicKey: other.publicKey, nonce: c.nonce, signature: other.sign(c.challenge) } });
    expect(swapped.statusCode).toBe(401);
    expect(swapped.json().error).toBe("challenge_key_mismatch");
    // malformed input is a 400, not a crash
    expect((await app.inject({ method: "POST", url: "/agents/challenge", payload: { keyType: "rsa", publicKey: "ab" } })).statusCode).toBe(400);
    expect(verifyAgentSignature("secp256k1", "zz", "x", "zz")).toBe(false);
  });

  it("rotates the API key on a signed re-signup: same account, old key revoked", async () => {
    const { app } = hostedApp();
    const k = nostrKey();
    const first = (await signup(app, k)).json();
    const second = (await signup(app, k)).json();
    expect(second.accountId).toBe(first.accountId);
    expect(second.created).toBe(false);
    expect(second.revokedKeys).toBe(1);
    expect(second.apiKey).not.toBe(first.apiKey);
    expect((await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${first.apiKey}` } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${second.apiKey}` } })).statusCode).toBe(200);
  });

  it("caps new agent accounts per hour per instance", async () => {
    const app = Fastify();
    registerAgentRoutes(app, { store: fakeStore() as never, issueApiKey: async () => "eck_x", maxNewAccountsPerHour: 1 });
    expect((await signup(app, nostrKey())).statusCode).toBe(200);
    expect((await signup(app, nostrKey())).statusCode).toBe(429);
  });

  it("rate-limits signup, challenge and top-up", () => {
    expect(rateLimitFor("/agents/challenge", "POST")).toEqual(AUTH_RATE_LIMIT);
    expect(rateLimitFor("/agents/signup", "POST")).toEqual(AUTH_RATE_LIMIT);
    expect(rateLimitFor("/v1/account/topup", "POST")).toEqual(TOPUP_RATE_LIMIT);
    expect(rateLimitFor("/v1/account", "GET")).toBeUndefined();
  });
});

describe("account routes for API keys (/v1/account)", () => {
  let coordinator: ReturnType<typeof Fastify> | undefined;
  afterEach(async () => {
    await coordinator?.close();
    coordinator = undefined;
  });

  async function fakeCoordinator() {
    const seen: Array<{ path: string; body: any; token: unknown }> = [];
    coordinator = Fastify();
    const record = (path: string, reply: object) =>
      coordinator!.post(path, async (req) => {
        seen.push({ path, body: req.body, token: req.headers["x-portal-service-token"] });
        return reply;
      });
    record("/account/buy", { intentId: "int-1", invoice: "lnbcrt10u1fake", amountSats: 1000, cSats: 1000, feeSats: 0, network: "regtest", expiresInSeconds: 900 });
    record("/account/intent", { intentId: "int-1", status: "settled", cSats: 1000 });
    record("/account/summary", { accountId: "x", cSats: 42.5, earnedSats: 0, recent: [{ type: "debit", cSats: 1 }], machines: [] });
    record("/account/usage", { totals: { requests: 3, cSats: 1.5 }, byDay: [], byModel: [], records: [{ model: "m" }] });
    record("/account/reservations/list", { reservations: [{ id: "res-1" }], available: {} });
    record("/account/reservations", { reservation: { id: "res-2" } });
    record("/account/reservations/cancel", { ok: true, refundedCSats: 3 });
    await coordinator.listen({ port: 0, host: "127.0.0.1" });
    const addr = coordinator.server.address() as { port: number };
    return { url: `http://127.0.0.1:${addr.port}`, seen };
  }

  async function withKey(urls: string[]) {
    const h = hostedApp(fakeStore(), urls);
    const { apiKey, accountId } = (await signup(h.app, nostrKey())).json();
    return { ...h, auth: { authorization: `Bearer ${apiKey}` }, accountId };
  }

  it("top-up returns the coordinator's Lightning invoice, billed to the key's account as the portal", async () => {
    const c = await fakeCoordinator();
    const { app, auth, accountId } = await withKey([c.url]);
    const r = await app.inject({ method: "POST", url: "/v1/account/topup", headers: auth, payload: { amountSats: 1000 } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ invoice: "lnbcrt10u1fake", amountSats: 1000, intentId: "int-1" });
    expect(c.seen[0]).toEqual({ path: "/account/buy", body: { amountSats: 1000, accountId }, token: "svc-token" });
    // The caller cannot name another account.
    await app.inject({ method: "POST", url: "/v1/account/topup", headers: auth, payload: { amountSats: 1000, accountId: "acct-victim" } });
    expect(c.seen[1].body.accountId).toBe(accountId);
    expect((await app.inject({ method: "POST", url: "/v1/account/topup", headers: auth, payload: { amountSats: 5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/account/topup", payload: { amountSats: 1000 } })).statusCode).toBe(401);
    const status = await app.inject({ method: "GET", url: "/v1/account/topup/int-1", headers: auth });
    expect(status.json().status).toBe("settled");
  });

  it("GET /v1/account merges balance and recent usage; reservations proxy through", async () => {
    const c = await fakeCoordinator();
    const { app, auth, accountId } = await withKey([c.url]);
    const r = await app.inject({ method: "GET", url: "/v1/account", headers: auth });
    expect(r.json()).toMatchObject({ accountId, cSats: 42.5, recent: [{ type: "debit" }], usage: { days: 30, totals: { requests: 3 }, recent: [{ model: "m" }] } });
    expect((await app.inject({ method: "GET", url: "/v1/account/usage?days=7", headers: auth })).json().totals.requests).toBe(3);
    expect(c.seen.find((s) => s.path === "/account/usage" && s.body.days === 7)).toBeTruthy();
    expect((await app.inject({ method: "GET", url: "/v1/account/reservations", headers: auth })).json().reservations[0].id).toBe("res-1");
    const made = await app.inject({ method: "POST", url: "/v1/account/reservations", headers: auth, payload: { computeClass: "gpu", minutes: 30 } });
    expect(made.json().reservation.id).toBe("res-2");
    expect((await app.inject({ method: "POST", url: "/v1/account/reservations", headers: auth, payload: { computeClass: "tpu", minutes: 30 } })).statusCode).toBe(400);
    const cancel = await app.inject({ method: "POST", url: "/v1/account/reservations/cancel", headers: auth, payload: { reservationId: "res-2" } });
    expect(cancel.json().ok).toBe(true);
    expect(c.seen.every((s) => s.token === "svc-token" && s.body.accountId === accountId)).toBe(true);
  });

  it("reports an unreachable network as an error, not a balance of zero", async () => {
    const { app, auth } = await withKey([]);
    const r = await app.inject({ method: "GET", url: "/v1/account", headers: auth });
    expect(r.statusCode).toBe(503);
  });
});
