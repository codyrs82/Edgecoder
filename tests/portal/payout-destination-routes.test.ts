import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPayoutRegistrar, registerPayoutDestinationRoutes, type PayoutDestinationStore } from "../../src/portal/routes/payout-destination.js";
import { createSecondFactorGate, registerAccountSecurityRoutes } from "../../src/portal/routes/account-security.js";
import { rateLimitFor, WALLET_RATE_LIMIT } from "../../src/portal/security.js";
import type { PayoutDestinationRecord } from "../../src/portal/store.js";
import { base32Decode, hotp, totpStep } from "../../src/portal/totp.js";
import { HOUR, testSecurity } from "./fixtures/account-security-memory.js";

function memoryStore() {
  const destinations = new Map<string, PayoutDestinationRecord>();
  const legacy = new Map<string, { invalidatedAtMs?: number; derivedAddress?: string }>();
  const store: PayoutDestinationStore = {
    async getPayoutDestination(userId) {
      return destinations.get(userId) ?? null;
    },
    async upsertPayoutDestination(i) {
      const prev = destinations.get(i.userId);
      destinations.set(i.userId, { ...i, createdAtMs: prev?.createdAtMs ?? Date.now(), updatedAtMs: Date.now() });
    },
    async createPayoutDestinationChallenge() {},
    async consumePayoutDestinationChallenge() {
      return null;
    },
    async getWalletOnboardingByUserId(userId) {
      return legacy.get(userId) ?? null;
    }
  };
  return { store, destinations, legacy };
}

type Sent = { email: string; destination: string; token: string; code: string; ttlMinutes: number; cooldownHours: number };

/** The routes with a memory store, a settable clock and captured emails (nothing is sent). */
async function setup(opts: { onchainEnabled?: boolean } = {}) {
  const mem = memoryStore();
  const t = testSecurity();
  const user: { current: { userId: string; email: string; emailVerified?: boolean } | null } = { current: { userId: "u1", email: "u1@mail.example", emailVerified: true } };
  const confirmEmails: Sent[] = [];
  const addedEmails: Array<{ email: string; destination: string; activatesAtMs: number; cancelToken: string }> = [];
  const passkeys = new Map<string, number>();
  const sessionsDeleted: string[] = [];
  const register = vi.fn(async () => ({ controlPlane: "ok" as const, coordinator: "ok" as const }));
  const securityStore = {
    listPasskeysByUserId: async (userId: string) => Array.from({ length: passkeys.get(userId) ?? 0 }, (_, i) => ({ credentialId: `cred-${i}` })),
    deleteSessionsForUser: async (userId: string) => void sessionsDeleted.push(userId),
    getUserById: async (userId: string) => ({ userId, email: `${userId}@mail.example` })
  };
  const app = Fastify();
  registerPayoutDestinationRoutes(app, {
    store: mem.store,
    getCurrentUser: async () => user.current,
    network: "signet",
    onchainEnabled: opts.onchainEnabled,
    emailConfigured: true,
    register,
    security: t.security,
    secondFactor: createSecondFactorGate(t.security, securityStore),
    sendConfirm: async (i) => void confirmEmails.push(i),
    sendAdded: async (i) => void addedEmails.push(i)
  });
  registerAccountSecurityRoutes(app, {
    security: t.security,
    store: securityStore,
    getCurrentUser: async () => user.current,
    buildAccessContext: async () => ({ isSystemAdmin: false }),
    sendDestinationAdded: async (i) => void addedEmails.push(i),
    sendAccountLocked: async () => undefined,
    sendTwoFactorChanged: async () => undefined,
    pausePayouts: async () => undefined,
    resumePayouts: async () => undefined
  });
  await app.ready();
  const put = (payload: unknown, headers: Record<string, string> = {}) => app.inject({ method: "PUT", url: "/wallet/payout-destination", payload: payload as object, headers: { cookie: "edgecoder_portal_session=sess-1", ...headers } });
  const get = () => app.inject({ method: "GET", url: "/wallet/payout-destination", headers: { cookie: "edgecoder_portal_session=sess-1" } });
  const confirmLink = (token: string) => app.inject({ method: "POST", url: "/auth/account-security/confirm-destination", payload: { token } });
  const cancelLink = (token: string) => app.inject({ method: "POST", url: "/auth/account-security/cancel-destination", payload: { token } });
  /** Request, confirm by link, and wait out the cooling-off. */
  const activate = async (destination: string) => {
    expect((await put({ destination })).statusCode).toBe(202);
    expect((await confirmLink(confirmEmails.at(-1)!.token)).statusCode).toBe(200);
    t.clock.now += 25 * HOUR;
    expect((await get()).json().destination?.destination).toBe(destination);
  };
  return { app, mem, t, user, confirmEmails, addedEmails, passkeys, sessionsDeleted, register, put, get, confirmLink, cancelLink, activate };
}

describe("/wallet/payout-destination", () => {
  let s: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    s = await setup();
  });

  it("requires a session for GET, PUT and cancel", async () => {
    s.user.current = null;
    expect((await s.get()).statusCode).toBe(401);
    expect((await s.put({ destination: "alice@getalby.com" })).statusCode).toBe(401);
    expect((await s.app.inject({ method: "POST", url: "/wallet/payout-destination/cancel" })).statusCode).toBe(401);
    expect(s.register).not.toHaveBeenCalled();
  });

  it("reports no destination, and a retired server-generated address, until one is set", async () => {
    s.mem.legacy.set("u1", { invalidatedAtMs: 1, derivedAddress: "tb1qold" });
    const r = await s.get();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ accountId: "acct-u1", network: "signet", destination: null, needsDestination: true, legacyAddressRetired: true, onchainSupported: false, supportedKinds: ["lightning_address"], pendingDestination: null, cooldownHours: 24, firstCooldownHours: 1, locked: false });
  });

  it("rejects invalid input with an inline-ready detail and saves nothing", async () => {
    for (const [payload, error] of [
      [{}, "invalid_request"],
      [{ destination: "alice@localhost" }, "invalid_lightning_address"],
      [{ destination: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" }, "address_network_mismatch"],
      [{ destination: "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k8" }, "invalid_onchain_address"]
    ] as const) {
      const r = await s.put(payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().error).toBe(error);
      expect(typeof r.json().detail).toBe("string");
    }
    expect(s.mem.destinations.size).toBe(0);
    expect(s.confirmEmails).toHaveLength(0);
  });

  it("refuses a valid on-chain address because payouts cannot pay it yet", async () => {
    const r = await s.put({ destination: "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7" });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("onchain_payouts_not_supported");
  });

  it("the first destination needs the emailed link too, then cools off for 1 h before it is saved and registered", async () => {
    const r = await s.put({ destination: "Alice@GetAlby.com" });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ verificationRequired: true, confirmation: "email_link", cooldownHours: 1 });
    expect(s.confirmEmails).toHaveLength(1);
    expect(s.confirmEmails[0]).toMatchObject({ email: "u1@mail.example", destination: "alice@getalby.com", ttlMinutes: 30, cooldownHours: 1 });
    expect(s.mem.destinations.size).toBe(0);

    const c = await s.confirmLink(s.confirmEmails[0].token);
    expect(c.statusCode).toBe(200);
    expect(c.json().activatesAtMs).toBe(s.t.clock.now + HOUR);
    expect(s.addedEmails).toHaveLength(1);
    expect(s.addedEmails[0]).toMatchObject({ email: "u1@mail.example", destination: "alice@getalby.com" });
    // The link is single use.
    expect((await s.confirmLink(s.confirmEmails[0].token)).statusCode).toBe(400);

    s.t.clock.now += 59 * 60 * 1000;
    expect((await s.get()).json()).toMatchObject({ destination: null, pendingDestination: { destination: "alice@getalby.com", confirmed: true, first: true } });
    expect(s.register).not.toHaveBeenCalled();
    s.t.clock.now += 2 * 60 * 1000;
    expect((await s.get()).json()).toMatchObject({ destination: { destination: "alice@getalby.com" }, pendingDestination: null });
    expect(s.register).toHaveBeenCalledWith({ accountId: "acct-u1", kind: "lightning_address", destination: "alice@getalby.com", network: "signet" });
  });

  it("a change cools off for 24 h; the old destination stays registered meanwhile", async () => {
    await s.activate("alice@getalby.com");
    s.register.mockClear();
    const start = await s.put({ destination: "alice@strike.me" });
    expect(start.statusCode).toBe(202);
    expect(start.json().cooldownHours).toBe(24);
    await s.confirmLink(s.confirmEmails.at(-1)!.token);
    s.t.clock.now += 23 * HOUR;
    expect((await s.get()).json().destination.destination).toBe("alice@getalby.com");
    expect(s.register).not.toHaveBeenCalled();
    s.t.clock.now += 2 * HOUR;
    expect((await s.get()).json().destination.destination).toBe("alice@strike.me");
    expect(s.register).toHaveBeenCalledTimes(1);
  });

  it("the confirmation link expires after 30 minutes", async () => {
    await s.put({ destination: "alice@getalby.com" });
    s.t.clock.now += 31 * 60 * 1000;
    const r = await s.confirmLink(s.confirmEmails[0].token);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("link_invalid");
  });

  it("the emailed code confirms from the app; a wrong code uses the request up; it only confirms its own address", async () => {
    const start = await s.put({ destination: "alice@strike.me" });
    const { challengeId } = start.json();
    const code = s.confirmEmails[0].code;
    const swapped = await s.put({ destination: "mallory@strike.me", challengeId, emailCode: code });
    expect(swapped.statusCode).toBe(400);
    expect(swapped.json().error).toBe("payout_destination_challenge_invalid");
    const wrong = await s.put({ destination: "alice@strike.me", challengeId, emailCode: "999999" === code ? "999998" : "999999" });
    expect(wrong.statusCode).toBe(400);
    const reused = await s.put({ destination: "alice@strike.me", challengeId, emailCode: code });
    expect(reused.statusCode).toBe(400);

    const again = await s.put({ destination: "alice@strike.me" });
    const ok = await s.put({ destination: "alice@strike.me", challengeId: again.json().challengeId, emailCode: s.confirmEmails.at(-1)!.code });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().pendingDestination).toMatchObject({ destination: "alice@strike.me", confirmed: true });
    expect(s.addedEmails).toHaveLength(1);
  });

  it("another user's request cannot be confirmed with your code", async () => {
    const start = await s.put({ destination: "alice@strike.me" });
    const code = s.confirmEmails[0].code;
    s.user.current = { userId: "u2", email: "u2@mail.example", emailVerified: true };
    const r = await s.put({ destination: "alice@strike.me", challengeId: start.json().challengeId, emailCode: code });
    expect(r.statusCode).toBe(400);
  });

  it("the cancel link in the notice drops the change and signs out every session", async () => {
    await s.activate("alice@getalby.com");
    await s.put({ destination: "mallory@strike.me" });
    await s.confirmLink(s.confirmEmails.at(-1)!.token);
    const cancel = await s.cancelLink(s.addedEmails.at(-1)!.cancelToken);
    expect(cancel.statusCode).toBe(200);
    expect(s.sessionsDeleted).toEqual(["u1"]);
    expect((await s.cancelLink(s.addedEmails.at(-1)!.cancelToken)).statusCode).toBe(400);
    s.t.clock.now += 48 * HOUR;
    expect((await s.get()).json()).toMatchObject({ destination: { destination: "alice@getalby.com" }, pendingDestination: null });
  });

  it("the owner can cancel from the signed-in Wallet page", async () => {
    await s.put({ destination: "alice@getalby.com" });
    const r = await s.app.inject({ method: "POST", url: "/wallet/payout-destination/cancel", headers: { cookie: "edgecoder_portal_session=sess-1" } });
    expect(r.statusCode).toBe(200);
    expect(r.json().pendingDestination).toBeNull();
    expect((await s.app.inject({ method: "POST", url: "/wallet/payout-destination/cancel" })).statusCode).toBe(409);
  });

  it("re-saving the address already in use needs no email and drops a pending change", async () => {
    await s.activate("alice@getalby.com");
    await s.put({ destination: "alice@strike.me" });
    const sent = s.confirmEmails.length;
    const r = await s.put({ destination: "alice@getalby.com" });
    expect(r.statusCode).toBe(200);
    expect(r.json().pendingDestination).toBeNull();
    expect(s.confirmEmails).toHaveLength(sent);
  });

  it("needs a verified email", async () => {
    s.user.current = { userId: "u1", email: "u1@mail.example", emailVerified: false };
    const r = await s.put({ destination: "alice@getalby.com" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("email_not_verified");
  });

  it("with 2FA on, a change needs the second factor (inline code or a step-up in this session)", async () => {
    const setupTotp = await s.t.security.startTotp("u1", "u1@mail.example");
    if (!setupTotp.ok) throw new Error("setup");
    const secret = base32Decode(setupTotp.secret);
    await s.t.security.enableTotp("u1", hotp(secret, totpStep(s.t.clock.now)));
    s.t.clock.now += 60_000;
    const refused = await s.put({ destination: "alice@getalby.com" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: "two_factor_required", methods: ["totp", "recovery_code"] });
    expect(s.confirmEmails).toHaveLength(0);
    const wrong = await s.put({ destination: "alice@getalby.com" }, { "x-edgecoder-2fa-code": "000000" });
    expect(wrong.statusCode).toBe(401);
    const ok = await s.put({ destination: "alice@getalby.com" }, { "x-edgecoder-2fa-code": hotp(secret, totpStep(s.t.clock.now)) });
    expect(ok.statusCode).toBe(202);
    // The code made a step-up for this session: the next protected call needs no new code.
    expect((await s.put({ destination: "bob@getalby.com" })).statusCode).toBe(202);
  });

  it("a passkey counts as 2FA", async () => {
    s.passkeys.set("u1", 1);
    const r = await s.put({ destination: "alice@getalby.com" });
    expect(r.statusCode).toBe(403);
    expect(r.json().methods).toEqual(["passkey"]);
  });

  it("a locked account cannot change its destination, and a due change does not activate", async () => {
    await s.put({ destination: "alice@getalby.com" });
    await s.confirmLink(s.confirmEmails[0].token);
    await s.t.security.lock("u1", "receipt_link");
    const r = await s.put({ destination: "bob@getalby.com" });
    expect(r.statusCode).toBe(423);
    expect(r.json().error).toBe("account_locked");
    s.t.clock.now += 2 * HOUR;
    expect((await s.get()).json()).toMatchObject({ destination: null, locked: true });
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

  it("clears the account's addresses at the coordinator for a lock", async () => {
    const coordSeen: Array<{ url: string; body: any }> = [];
    const coord = Fastify();
    coord.post("/economy/payouts/address", async (req) => (coordSeen.push({ url: req.url, body: req.body }), { ok: true }));
    coord.post("/economy/payouts/onchain-address", async (req) => (coordSeen.push({ url: req.url, body: req.body }), { ok: true }));
    await coord.listen({ port: 0, host: "127.0.0.1" });
    const a = coord.server.address();
    const cbase = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    const reg = createPayoutRegistrar({ portalServiceToken: "svc", timeoutMs: 2000, discoverCoordinatorUrls: async () => [cbase] });
    expect(await reg.clear("acct-u1")).toBe("ok");
    expect(coordSeen).toEqual(
      expect.arrayContaining([
        { url: "/economy/payouts/address", body: { accountId: "acct-u1", lightningAddress: null } },
        { url: "/economy/payouts/onchain-address", body: { accountId: "acct-u1", address: null } }
      ])
    );
    await coord.close();
  });

  it("reports unconfigured or unreachable services instead of throwing", async () => {
    const none = createPayoutRegistrar({ timeoutMs: 500, discoverCoordinatorUrls: async () => [] });
    expect(await none({ accountId: "a", kind: "lightning_address", destination: "x@y.com", network: "signet" })).toEqual({ controlPlane: "not_configured", coordinator: "not_configured" });
    const down = createPayoutRegistrar({ controlPlaneUrl: "http://127.0.0.1:1", controlPlaneAdminToken: "t", portalServiceToken: "s", timeoutMs: 500, discoverCoordinatorUrls: async () => ["http://127.0.0.1:1"] });
    expect(await down({ accountId: "a", kind: "lightning_address", destination: "x@y.com", network: "signet" })).toEqual({ controlPlane: "failed", coordinator: "failed" });
  });
});

describe("/wallet/payout-destination with ONCHAIN_ENABLED", () => {
  const SIGNET_P2WSH = "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7";
  async function appWith(onchainEnabled: boolean) {
    const s = await setup({ onchainEnabled });
    return { app: s.app, mem: s.mem, register: s.register, s };
  }

  it("saves a SegWit address on the portal's network and registers it as an on-chain destination", async () => {
    const { app, register, s } = await appWith(true);
    expect((await app.inject({ url: "/wallet/payout-destination" })).json()).toMatchObject({ onchainSupported: true, supportedKinds: ["lightning_address", "onchain"] });
    await s.activate(SIGNET_P2WSH);
    expect((await s.get()).json()).toMatchObject({ destination: { kind: "onchain", destination: SIGNET_P2WSH } });
    expect(register).toHaveBeenCalledWith({ accountId: "acct-u1", kind: "onchain", destination: SIGNET_P2WSH, network: "signet" });
  });

  it("still refuses a wrong-network address and legacy base58 addresses", async () => {
    const { app, register } = await appWith(true);
    const main = await app.inject({ method: "PUT", url: "/wallet/payout-destination", payload: { destination: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4" } });
    expect(main.json().error).toBe("address_network_mismatch");
    const legacy = await app.inject({ method: "PUT", url: "/wallet/payout-destination", payload: { destination: "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn" } });
    expect(legacy.statusCode).toBe(400);
    expect(legacy.json().error).toBe("unsupported_address_type");
    expect(register).not.toHaveBeenCalled();
  });

  it("without it, on-chain addresses stay refused (Coming soon)", async () => {
    const { app } = await appWith(false);
    const r = await app.inject({ method: "PUT", url: "/wallet/payout-destination", payload: { destination: SIGNET_P2WSH } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("onchain_payouts_not_supported");
  });
});

describe("createPayoutRegistrar for an on-chain address", () => {
  it("registers it with the coordinator's on-chain route", async () => {
    const seen: Array<{ url: string; body: any; svc: unknown }> = [];
    const upstream = Fastify();
    upstream.post("/economy/payouts/onchain-address", async (req) => (seen.push({ url: req.url, body: req.body, svc: req.headers["x-portal-service-token"] }), { ok: true }));
    upstream.post("/economy/wallets/register", async (req) => (seen.push({ url: req.url, body: req.body, svc: undefined }), { ok: true }));
    await upstream.listen({ port: 0, host: "127.0.0.1" });
    const a = upstream.server.address();
    const base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
    const reg = createPayoutRegistrar({ controlPlaneUrl: base, controlPlaneAdminToken: "admin", portalServiceToken: "svc", timeoutMs: 2000, discoverCoordinatorUrls: async () => [base] });
    expect(await reg({ accountId: "acct-u1", kind: "onchain", destination: "tb1qaddr", network: "signet" })).toEqual({ controlPlane: "ok", coordinator: "ok" });
    expect(seen.find((s) => s.url === "/economy/payouts/onchain-address")).toMatchObject({ svc: "svc", body: { accountId: "acct-u1", address: "tb1qaddr" } });
    expect(seen.find((s) => s.url === "/economy/wallets/register")).toMatchObject({ body: { walletType: "onchain", payoutAddress: "tb1qaddr" } });
    await upstream.close();
  });
});
