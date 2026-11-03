import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, timingSafeEqual } from "node:crypto";
import { createPayoutRegistrar, registerPayoutDestinationRoutes, type PayoutDestinationStore } from "../../src/portal/routes/payout-destination.js";
import { rateLimitFor, WALLET_RATE_LIMIT } from "../../src/portal/security.js";
import type { PayoutDestinationChallenge, PayoutDestinationRecord } from "../../src/portal/store.js";

const sha256Hex = (v: string) => createHash("sha256").update(v).digest("hex");
const secureCompare = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function memoryStore() {
  const destinations = new Map<string, PayoutDestinationRecord>();
  const challenges = new Map<string, PayoutDestinationChallenge & { consumed?: boolean }>();
  const legacy = new Map<string, { invalidatedAtMs?: number; derivedAddress?: string }>();
  const store: PayoutDestinationStore = {
    async getPayoutDestination(userId) {
      return destinations.get(userId) ?? null;
    },
    async upsertPayoutDestination(i) {
      const prev = destinations.get(i.userId);
      destinations.set(i.userId, { ...i, createdAtMs: prev?.createdAtMs ?? Date.now(), updatedAtMs: Date.now() });
    },
    async createPayoutDestinationChallenge(i) {
      challenges.set(i.challengeId, { ...i });
    },
    async consumePayoutDestinationChallenge(id) {
      const c = challenges.get(id);
      if (!c || c.consumed || c.expiresAtMs <= Date.now()) return null;
      c.consumed = true;
      return c;
    },
    async getWalletOnboardingByUserId(userId) {
      return legacy.get(userId) ?? null;
    }
  };
  return { store, destinations, challenges, legacy };
}

describe("/wallet/payout-destination", () => {
  let app: FastifyInstance;
  let mem: ReturnType<typeof memoryStore>;
  let user: { userId: string; email: string } | null;
  const sent: Array<{ email: string; code: string; destination: string }> = [];
  const register = vi.fn(async () => ({ controlPlane: "ok" as const, coordinator: "ok" as const }));

  beforeEach(async () => {
    mem = memoryStore();
    user = { userId: "u1", email: "u1@mail.example" };
    sent.length = 0;
    register.mockClear();
    app = Fastify();
    let code = 100000;
    registerPayoutDestinationRoutes(app, {
      store: mem.store,
      getCurrentUser: async () => user,
      network: "signet",
      codeTtlMs: 600_000,
      emailConfigured: true,
      sendCode: async (i) => {
        sent.push(i);
      },
      register,
      generateSixDigitCode: () => String(code++),
      sha256Hex,
      secureCompare
    });
    await app.ready();
  });

  const put = (payload: unknown) => app.inject({ method: "PUT", url: "/wallet/payout-destination", payload: payload as object });

  it("requires a session for GET and PUT", async () => {
    user = null;
    expect((await app.inject({ method: "GET", url: "/wallet/payout-destination" })).statusCode).toBe(401);
    expect((await put({ destination: "alice@getalby.com" })).statusCode).toBe(401);
    expect(register).not.toHaveBeenCalled();
  });

  it("reports no destination, and a retired server-generated address, until one is set", async () => {
    mem.legacy.set("u1", { invalidatedAtMs: 1, derivedAddress: "tb1qold" });
    const r = await app.inject({ method: "GET", url: "/wallet/payout-destination" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ accountId: "acct-u1", network: "signet", destination: null, needsDestination: true, legacyAddressRetired: true, onchainSupported: false, supportedKinds: ["lightning_address"] });
  });

  it("rejects invalid input with an inline-ready detail and saves nothing", async () => {
    for (const [payload, error] of [
      [{}, "invalid_request"],
      [{ destination: "alice@localhost" }, "invalid_lightning_address"],
      [{ destination: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" }, "address_network_mismatch"],
      [{ destination: "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k8" }, "invalid_onchain_address"]
    ] as const) {
      const r = await put(payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().error).toBe(error);
      expect(typeof r.json().detail).toBe("string");
    }
    expect(mem.destinations.size).toBe(0);
    expect(register).not.toHaveBeenCalled();
  });

  it("refuses a valid on-chain address because payouts cannot pay it yet", async () => {
    const r = await put({ destination: "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("onchain_payouts_not_supported");
    expect(mem.destinations.size).toBe(0);
  });

  it("saves the first Lightning address without a code and registers it as the payout address", async () => {
    const r = await put({ destination: "Alice@GetAlby.com" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, destination: { kind: "lightning_address", destination: "alice@getalby.com" }, needsDestination: false, registration: { controlPlane: "ok", coordinator: "ok" } });
    expect(mem.destinations.get("u1")).toMatchObject({ accountId: "acct-u1", kind: "lightning_address", destination: "alice@getalby.com", network: "signet" });
    expect(register).toHaveBeenCalledWith({ accountId: "acct-u1", kind: "lightning_address", destination: "alice@getalby.com", network: "signet" });
    expect(sent).toHaveLength(0);
  });

  it("changing an existing destination needs the emailed code; a wrong or reused code is refused", async () => {
    await put({ destination: "alice@getalby.com" });
    register.mockClear();

    const start = await put({ destination: "alice@strike.me" });
    expect(start.statusCode).toBe(202);
    const { challengeId, verificationRequired } = start.json();
    expect(verificationRequired).toBe(true);
    expect(sent).toEqual([{ email: "u1@mail.example", code: "100000", destination: "alice@strike.me" }]);
    expect(mem.destinations.get("u1")?.destination).toBe("alice@getalby.com");

    const wrong = await put({ destination: "alice@strike.me", challengeId, emailCode: "999999" });
    expect(wrong.statusCode).toBe(401);
    // The challenge is single use: the right code after a wrong one needs a new challenge.
    const reused = await put({ destination: "alice@strike.me", challengeId, emailCode: "100000" });
    expect(reused.statusCode).toBe(400);
    expect(mem.destinations.get("u1")?.destination).toBe("alice@getalby.com");

    // A code confirms only the address it was sent for.
    const again = await put({ destination: "alice@strike.me" });
    const swapped = await put({ destination: "mallory@strike.me", challengeId: again.json().challengeId, emailCode: "100001" });
    expect(swapped.statusCode).toBe(400);
    expect(swapped.json().error).toBe("payout_destination_challenge_invalid");

    const third = await put({ destination: "alice@strike.me" });
    const ok = await put({ destination: "alice@strike.me", challengeId: third.json().challengeId, emailCode: "100002" });
    expect(ok.statusCode).toBe(200);
    expect(mem.destinations.get("u1")?.destination).toBe("alice@strike.me");
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("re-saving the same destination needs no code (re-registers it)", async () => {
    await put({ destination: "alice@getalby.com" });
    const r = await put({ destination: "alice@getalby.com" });
    expect(r.statusCode).toBe(200);
    expect(register).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(0);
  });

  it("another user's challenge cannot be used", async () => {
    await put({ destination: "alice@getalby.com" });
    const start = await put({ destination: "alice@strike.me" });
    user = { userId: "u2", email: "u2@mail.example" };
    await put({ destination: "bob@getalby.com" });
    const r = await put({ destination: "alice@strike.me", challengeId: start.json().challengeId, emailCode: "100000" });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("payout_destination_challenge_invalid");
    expect(mem.destinations.get("u2")?.destination).toBe("bob@getalby.com");
  });

  it("is rate limited like the wallet send routes", () => {
    expect(rateLimitFor("/wallet/payout-destination", "PUT")).toEqual(WALLET_RATE_LIMIT);
    expect(rateLimitFor("/wallet/payout-destination", "GET")).toBeUndefined();
  });
});

describe("createPayoutRegistrar", () => {
  const seen: Array<{ url: string; auth: unknown; svc: unknown; body: any }> = [];
  const upstream = Fastify();
  let base = "";
  beforeAll(async () => {
    upstream.post("/economy/wallets/register", async (req) => {
      seen.push({ url: req.url, auth: req.headers.authorization, svc: undefined, body: req.body });
      return { ok: true };
    });
    upstream.post("/economy/payouts/address", async (req) => {
      seen.push({ url: req.url, auth: undefined, svc: req.headers["x-portal-service-token"], body: req.body });
      return { ok: true };
    });
    await upstream.listen({ port: 0, host: "127.0.0.1" });
    const a = upstream.server.address();
    base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  });
  afterAll(async () => {
    await upstream.close();
  });

  it("registers the Lightning address with the control plane and the coordinator", async () => {
    const reg = createPayoutRegistrar({ controlPlaneUrl: base, controlPlaneAdminToken: "admin", portalServiceToken: "svc", timeoutMs: 2000, discoverCoordinatorUrls: async () => [base + "/"] });
    const r = await reg({ accountId: "acct-u1", kind: "lightning_address", destination: "alice@getalby.com", network: "signet" });
    expect(r).toEqual({ controlPlane: "ok", coordinator: "ok" });
    expect(seen.find((s) => s.url === "/economy/wallets/register")).toMatchObject({ auth: "Bearer admin", body: { accountId: "acct-u1", walletType: "lightning", network: "signet", payoutAddress: "alice@getalby.com" } });
    expect(seen.find((s) => s.url === "/economy/wallets/register")?.body.encryptedSecretRef).toBeUndefined();
    expect(seen.find((s) => s.url === "/economy/payouts/address")).toMatchObject({ svc: "svc", body: { accountId: "acct-u1", lightningAddress: "alice@getalby.com" } });
  });

  it("reports unconfigured or unreachable services instead of throwing", async () => {
    const none = createPayoutRegistrar({ timeoutMs: 500, discoverCoordinatorUrls: async () => [] });
    expect(await none({ accountId: "a", kind: "lightning_address", destination: "x@y.com", network: "signet" })).toEqual({ controlPlane: "not_configured", coordinator: "not_configured" });
    const down = createPayoutRegistrar({ controlPlaneUrl: "http://127.0.0.1:1", controlPlaneAdminToken: "t", portalServiceToken: "s", timeoutMs: 500, discoverCoordinatorUrls: async () => ["http://127.0.0.1:1"] });
    expect(await down({ accountId: "a", kind: "lightning_address", destination: "x@y.com", network: "signet" })).toEqual({ controlPlane: "failed", coordinator: "failed" });
  });
});
