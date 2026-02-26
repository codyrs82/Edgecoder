import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  sha256Hex,
  parseCookies,
  encodeCookie,
  hashPassword,
  generateSixDigitCode,
  secureCompare,
} from "../../src/portal/portal-utils.js";

// ---------------------------------------------------------------------------
// Mock store — wallet-relevant methods
// ---------------------------------------------------------------------------
function createMockStore() {
  return {
    getSessionByTokenHash: vi.fn(),
    getUserById: vi.fn(),
    getWalletOnboardingByUserId: vi.fn(),
    createWalletOnboarding: vi.fn(),
    upsertWalletOnboardingSeed: vi.fn(),
    acknowledgeWalletOnboarding: vi.fn(),
    listWalletSendRequestsByUser: vi.fn(),
    createWalletSendMfaChallenge: vi.fn(),
    consumeWalletSendMfaChallenge: vi.fn(),
    createWalletSendRequest: vi.fn(),
    listPasskeysByUserId: vi.fn(),
    findPasskeyByCredentialId: vi.fn(),
    updatePasskeyCounter: vi.fn(),
    listNodesByOwner: vi.fn().mockResolvedValue([]),
  };
}

type MockStore = ReturnType<typeof createMockStore>;

// ---------------------------------------------------------------------------
// Build wallet routes
// ---------------------------------------------------------------------------
async function buildApp(store: MockStore) {
  const app = Fastify();

  async function getCurrentUser(req: { headers: Record<string, unknown> }) {
    const cookies = parseCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
    const sessionToken = cookies.edgecoder_portal_session;
    if (!sessionToken) return null;
    const session = await store.getSessionByTokenHash(sha256Hex(sessionToken));
    if (!session) return null;
    return await store.getUserById(session.userId);
  }

  // GET /wallet/onboarding
  app.get("/wallet/onboarding", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const onboarding = await store.getWalletOnboardingByUserId(user.userId);
    if (!onboarding) return reply.code(404).send({ error: "wallet_onboarding_not_found" });
    return reply.send({
      accountId: onboarding.accountId,
      network: onboarding.network,
      createdAtMs: onboarding.createdAtMs,
      acknowledgedAtMs: onboarding.acknowledgedAtMs,
    });
  });

  // POST /wallet/onboarding/acknowledge
  app.post("/wallet/onboarding/acknowledge", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    await store.acknowledgeWalletOnboarding(user.userId);
    return reply.send({ ok: true });
  });

  // GET /wallet/send/requests
  app.get("/wallet/send/requests", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const requests = await store.listWalletSendRequestsByUser(user.userId, 25);
    return reply.send({ requests });
  });

  // POST /wallet/send/mfa/start
  app.post("/wallet/send/mfa/start", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const body = req.body as { destination?: string; amountSats?: number; note?: string };
    if (!body.destination || !body.amountSats || body.amountSats <= 0) {
      return reply.code(400).send({ error: "validation_failed" });
    }
    const walletOnboarding = await store.getWalletOnboardingByUserId(user.userId);
    if (!walletOnboarding) return reply.code(409).send({ error: "wallet_onboarding_required" });
    const passkeys = await store.listPasskeysByUserId(user.userId);
    if (passkeys.length === 0) {
      return reply.code(409).send({ error: "passkey_required_for_wallet_send" });
    }

    const challengeId = randomUUID();
    const code = generateSixDigitCode();
    const expiresAtMs = Date.now() + 600_000;
    await store.createWalletSendMfaChallenge({
      challengeId,
      userId: user.userId,
      accountId: walletOnboarding.accountId,
      destination: body.destination.trim(),
      amountSats: body.amountSats,
      note: body.note?.trim() || undefined,
      emailCodeHash: sha256Hex(`${challengeId}:${code}`),
      passkeyChallenge: "mock-passkey-challenge",
      expiresAtMs,
    });

    return reply.send({
      ok: true,
      challengeId,
      expiresAtMs,
    });
  });

  // POST /wallet/send/mfa/confirm
  app.post("/wallet/send/mfa/confirm", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });

    const body = req.body as {
      challengeId?: string;
      emailCode?: string;
      credentialId?: string;
      response?: unknown;
    };
    if (!body.challengeId || !body.emailCode || !body.credentialId) {
      return reply.code(400).send({ error: "validation_failed" });
    }
    const challenge = await store.consumeWalletSendMfaChallenge(body.challengeId);
    if (!challenge || challenge.userId !== user.userId) {
      return reply.code(400).send({ error: "wallet_send_mfa_challenge_invalid" });
    }
    const expectedCodeHash = sha256Hex(`${challenge.challengeId}:${body.emailCode.trim()}`);
    if (!secureCompare(challenge.emailCodeHash, expectedCodeHash)) {
      return reply.code(401).send({ error: "wallet_send_email_code_invalid" });
    }
    const credential = await store.findPasskeyByCredentialId(body.credentialId);
    if (!credential || credential.userId !== user.userId) {
      return reply.code(404).send({ error: "passkey_credential_not_found" });
    }

    // In the real server this verifies the passkey response. We skip that
    // here and assume the passkey verification passes.
    const requestId = randomUUID();
    await store.createWalletSendRequest({
      requestId,
      userId: user.userId,
      accountId: challenge.accountId,
      destination: challenge.destination,
      amountSats: challenge.amountSats,
      note: challenge.note,
      status: "pending_manual_review",
      mfaChallengeId: challenge.challengeId,
    });

    return reply.send({
      ok: true,
      request: {
        requestId,
        accountId: challenge.accountId,
        destination: challenge.destination,
        amountSats: challenge.amountSats,
        status: "pending_manual_review",
      },
    });
  });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const TEST_SESSION_TOKEN = "wallet-session-token-abc";
const TEST_USER = {
  userId: "user-wallet-001",
  email: "bob@example.com",
  emailVerified: true,
  uiTheme: "warm" as const,
  createdAtMs: Date.now(),
};

function sessionCookie(): string {
  return `edgecoder_portal_session=${encodeURIComponent(TEST_SESSION_TOKEN)}`;
}

function withAuth(store: MockStore) {
  store.getSessionByTokenHash.mockResolvedValue({
    sessionId: "sess-w1",
    userId: TEST_USER.userId,
    expiresAtMs: Date.now() + 3_600_000,
  });
  store.getUserById.mockResolvedValue(TEST_USER);
}

const MOCK_ONBOARDING = {
  userId: TEST_USER.userId,
  accountId: `acct-${TEST_USER.userId}`,
  network: "signet",
  seedPhraseHash: "abc123",
  encryptedPrivateKeyRef: "seed-sha256:def456",
  createdAtMs: Date.now() - 86_400_000,
  acknowledgedAtMs: undefined as number | undefined,
};

const MOCK_PASSKEY = {
  credentialId: "cred-001",
  userId: TEST_USER.userId,
  webauthnUserId: "webauthn-001",
  publicKeyB64Url: "publickeybase64url",
  counter: 5,
  deviceType: "singleDevice",
  backedUp: false,
  transports: ["internal"],
};

// ---------------------------------------------------------------------------
// Wallet onboarding tests
// ---------------------------------------------------------------------------
describe("GET /wallet/onboarding", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/wallet/onboarding" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 404 when no wallet onboarding exists", async () => {
    withAuth(store);
    store.getWalletOnboardingByUserId.mockResolvedValue(null);
    const res = await app.inject({
      method: "GET",
      url: "/wallet/onboarding",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("wallet_onboarding_not_found");
  });

  it("returns wallet onboarding details", async () => {
    withAuth(store);
    store.getWalletOnboardingByUserId.mockResolvedValue(MOCK_ONBOARDING);
    const res = await app.inject({
      method: "GET",
      url: "/wallet/onboarding",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.accountId).toBe(MOCK_ONBOARDING.accountId);
    expect(body.network).toBe("signet");
    expect(body.createdAtMs).toBe(MOCK_ONBOARDING.createdAtMs);
  });

  it("returns acknowledgedAtMs when the wallet backup has been confirmed", async () => {
    withAuth(store);
    const ackTime = Date.now();
    store.getWalletOnboardingByUserId.mockResolvedValue({ ...MOCK_ONBOARDING, acknowledgedAtMs: ackTime });
    const res = await app.inject({
      method: "GET",
      url: "/wallet/onboarding",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).acknowledgedAtMs).toBe(ackTime);
  });
});

// ---------------------------------------------------------------------------
// Acknowledge wallet onboarding
// ---------------------------------------------------------------------------
describe("POST /wallet/onboarding/acknowledge", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.inject({ method: "POST", url: "/wallet/onboarding/acknowledge" });
    expect(res.statusCode).toBe(401);
  });

  it("acknowledges wallet onboarding for the current user", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/wallet/onboarding/acknowledge",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(store.acknowledgeWalletOnboarding).toHaveBeenCalledWith(TEST_USER.userId);
  });
});

// ---------------------------------------------------------------------------
// Transaction history (send requests)
// ---------------------------------------------------------------------------
describe("GET /wallet/send/requests", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/wallet/send/requests" });
    expect(res.statusCode).toBe(401);
  });

  it("returns empty list when no send requests exist", async () => {
    withAuth(store);
    store.listWalletSendRequestsByUser.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/wallet/send/requests",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.requests).toEqual([]);
  });

  it("returns send request history for the user", async () => {
    withAuth(store);
    const requests = [
      {
        requestId: "req-1",
        accountId: MOCK_ONBOARDING.accountId,
        destination: "bc1q...",
        amountSats: 50000,
        status: "pending_manual_review",
        createdAtMs: Date.now() - 60_000,
      },
      {
        requestId: "req-2",
        accountId: MOCK_ONBOARDING.accountId,
        destination: "lnbc...",
        amountSats: 10000,
        note: "Test payment",
        status: "sent",
        createdAtMs: Date.now() - 120_000,
      },
    ];
    store.listWalletSendRequestsByUser.mockResolvedValue(requests);
    const res = await app.inject({
      method: "GET",
      url: "/wallet/send/requests",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0].requestId).toBe("req-1");
    expect(body.requests[1].amountSats).toBe(10000);
    expect(body.requests[1].note).toBe("Test payment");
  });

  it("queries store with user id and limit 25", async () => {
    withAuth(store);
    store.listWalletSendRequestsByUser.mockResolvedValue([]);
    await app.inject({
      method: "GET",
      url: "/wallet/send/requests",
      headers: { cookie: sessionCookie() },
    });
    expect(store.listWalletSendRequestsByUser).toHaveBeenCalledWith(TEST_USER.userId, 25);
  });
});

// ---------------------------------------------------------------------------
// MFA start for wallet send
// ---------------------------------------------------------------------------
describe("POST /wallet/send/mfa/start", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/wallet/send/mfa/start",
      payload: { destination: "bc1q...", amountSats: 1000 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 409 when no wallet onboarding exists", async () => {
    withAuth(store);
    store.getWalletOnboardingByUserId.mockResolvedValue(null);
    store.listPasskeysByUserId.mockResolvedValue([MOCK_PASSKEY]);
    const res = await app.inject({
      method: "POST",
      url: "/wallet/send/mfa/start",
      payload: { destination: "bc1qtest123456", amountSats: 1000 },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("wallet_onboarding_required");
  });

  it("returns 409 when user has no passkeys", async () => {
    withAuth(store);
    store.getWalletOnboardingByUserId.mockResolvedValue(MOCK_ONBOARDING);
    store.listPasskeysByUserId.mockResolvedValue([]);
    const res = await app.inject({
      method: "POST",
      url: "/wallet/send/mfa/start",
      payload: { destination: "bc1qtest123456", amountSats: 1000 },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("passkey_required_for_wallet_send");
  });

  it("creates an MFA challenge and returns challengeId", async () => {
    withAuth(store);
    store.getWalletOnboardingByUserId.mockResolvedValue(MOCK_ONBOARDING);
    store.listPasskeysByUserId.mockResolvedValue([MOCK_PASSKEY]);
    const res = await app.inject({
      method: "POST",
      url: "/wallet/send/mfa/start",
      payload: { destination: "bc1qtest123456", amountSats: 5000 },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.challengeId).toBeDefined();
    expect(body.expiresAtMs).toBeGreaterThan(Date.now());
    expect(store.createWalletSendMfaChallenge).toHaveBeenCalledTimes(1);
  });

  it("persists the challenge with correct destination and amount", async () => {
    withAuth(store);
    store.getWalletOnboardingByUserId.mockResolvedValue(MOCK_ONBOARDING);
    store.listPasskeysByUserId.mockResolvedValue([MOCK_PASSKEY]);
    await app.inject({
      method: "POST",
      url: "/wallet/send/mfa/start",
      payload: { destination: "  bc1qtrimmed  ", amountSats: 7777, note: " a note " },
      headers: { cookie: sessionCookie() },
    });
    const call = store.createWalletSendMfaChallenge.mock.calls[0][0];
    expect(call.destination).toBe("bc1qtrimmed");
    expect(call.amountSats).toBe(7777);
    expect(call.note).toBe("a note");
    expect(call.userId).toBe(TEST_USER.userId);
    expect(call.accountId).toBe(MOCK_ONBOARDING.accountId);
    expect(call.emailCodeHash).toBeDefined();
    expect(call.passkeyChallenge).toBeDefined();
  });

  it("returns 400 when destination is missing", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/wallet/send/mfa/start",
      payload: { amountSats: 1000 },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when amountSats is zero or negative", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/wallet/send/mfa/start",
      payload: { destination: "bc1qtest123456", amountSats: 0 },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// MFA confirm for wallet send
// ---------------------------------------------------------------------------
describe("POST /wallet/send/mfa/confirm", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/wallet/send/mfa/confirm",
      payload: { challengeId: "c1", emailCode: "123456", credentialId: "cred-001" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 when challenge is invalid or expired", async () => {
    withAuth(store);
    store.consumeWalletSendMfaChallenge.mockResolvedValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/wallet/send/mfa/confirm",
      payload: { challengeId: "expired-challenge", emailCode: "123456", credentialId: "cred-001" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("wallet_send_mfa_challenge_invalid");
  });

  it("returns 401 when email code is wrong", async () => {
    withAuth(store);
    const challengeId = "challenge-001";
    const correctCode = "999999";
    store.consumeWalletSendMfaChallenge.mockResolvedValue({
      challengeId,
      userId: TEST_USER.userId,
      accountId: MOCK_ONBOARDING.accountId,
      destination: "bc1qtest",
      amountSats: 5000,
      emailCodeHash: sha256Hex(`${challengeId}:${correctCode}`),
      passkeyChallenge: "passkey-challenge",
      expiresAtMs: Date.now() + 300_000,
    });
    const res = await app.inject({
      method: "POST",
      url: "/wallet/send/mfa/confirm",
      payload: { challengeId, emailCode: "000000", credentialId: "cred-001" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("wallet_send_email_code_invalid");
  });

  it("returns 404 when passkey credential is not found", async () => {
    withAuth(store);
    const challengeId = "challenge-002";
    const code = "123456";
    store.consumeWalletSendMfaChallenge.mockResolvedValue({
      challengeId,
      userId: TEST_USER.userId,
      accountId: MOCK_ONBOARDING.accountId,
      destination: "bc1qtest",
      amountSats: 5000,
      emailCodeHash: sha256Hex(`${challengeId}:${code}`),
      passkeyChallenge: "passkey-challenge",
      expiresAtMs: Date.now() + 300_000,
    });
    store.findPasskeyByCredentialId.mockResolvedValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/wallet/send/mfa/confirm",
      payload: { challengeId, emailCode: code, credentialId: "nonexistent-cred" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("passkey_credential_not_found");
  });

  it("creates a send request on successful MFA confirmation", async () => {
    withAuth(store);
    const challengeId = "challenge-003";
    const code = "654321";
    store.consumeWalletSendMfaChallenge.mockResolvedValue({
      challengeId,
      userId: TEST_USER.userId,
      accountId: MOCK_ONBOARDING.accountId,
      destination: "bc1qsuccess",
      amountSats: 25000,
      note: "Invoice payment",
      emailCodeHash: sha256Hex(`${challengeId}:${code}`),
      passkeyChallenge: "passkey-challenge",
      expiresAtMs: Date.now() + 300_000,
    });
    store.findPasskeyByCredentialId.mockResolvedValue(MOCK_PASSKEY);
    const res = await app.inject({
      method: "POST",
      url: "/wallet/send/mfa/confirm",
      payload: { challengeId, emailCode: code, credentialId: MOCK_PASSKEY.credentialId, response: {} },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.request.destination).toBe("bc1qsuccess");
    expect(body.request.amountSats).toBe(25000);
    expect(body.request.status).toBe("pending_manual_review");
    expect(store.createWalletSendRequest).toHaveBeenCalledTimes(1);
    const reqCall = store.createWalletSendRequest.mock.calls[0][0];
    expect(reqCall.userId).toBe(TEST_USER.userId);
    expect(reqCall.accountId).toBe(MOCK_ONBOARDING.accountId);
    expect(reqCall.mfaChallengeId).toBe(challengeId);
  });

  it("rejects when challenge userId does not match current user", async () => {
    withAuth(store);
    const challengeId = "challenge-mismatch";
    store.consumeWalletSendMfaChallenge.mockResolvedValue({
      challengeId,
      userId: "different-user-999",
      accountId: "acct-different",
      destination: "bc1q...",
      amountSats: 1000,
      emailCodeHash: sha256Hex(`${challengeId}:111111`),
      passkeyChallenge: "passkey-challenge",
      expiresAtMs: Date.now() + 300_000,
    });
    const res = await app.inject({
      method: "POST",
      url: "/wallet/send/mfa/confirm",
      payload: { challengeId, emailCode: "111111", credentialId: "cred-001" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("wallet_send_mfa_challenge_invalid");
  });

  it("rejects when passkey belongs to a different user", async () => {
    withAuth(store);
    const challengeId = "challenge-004";
    const code = "777777";
    store.consumeWalletSendMfaChallenge.mockResolvedValue({
      challengeId,
      userId: TEST_USER.userId,
      accountId: MOCK_ONBOARDING.accountId,
      destination: "bc1q...",
      amountSats: 1000,
      emailCodeHash: sha256Hex(`${challengeId}:${code}`),
      passkeyChallenge: "passkey-challenge",
      expiresAtMs: Date.now() + 300_000,
    });
    store.findPasskeyByCredentialId.mockResolvedValue({
      ...MOCK_PASSKEY,
      userId: "other-user-id",
    });
    const res = await app.inject({
      method: "POST",
      url: "/wallet/send/mfa/confirm",
      payload: { challengeId, emailCode: code, credentialId: "cred-001" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe("passkey_credential_not_found");
  });
});
