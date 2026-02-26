import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import {
  sha256Hex,
  normalizeEmail,
  parseCookies,
  hashPassword,
  verifyPassword,
  encodeCookie,
  clearCookie,
} from "../../src/portal/portal-utils.js";

// ---------------------------------------------------------------------------
// Mock store — all auth-relevant methods
// ---------------------------------------------------------------------------
function createMockStore() {
  return {
    getUserByEmail: vi.fn(),
    getUserById: vi.fn(),
    createUser: vi.fn(),
    createSession: vi.fn(),
    getSessionByTokenHash: vi.fn(),
    deleteSessionByTokenHash: vi.fn(),
    createEmailVerification: vi.fn(),
    consumeEmailVerification: vi.fn(),
    markUserEmailVerified: vi.fn(),
    createOauthState: vi.fn(),
    consumeOauthState: vi.fn(),
    findOauthIdentity: vi.fn(),
    linkOauthIdentity: vi.fn(),
    listPasskeysByUserId: vi.fn(),
    createPasskeyChallenge: vi.fn(),
    consumePasskeyChallenge: vi.fn(),
    findPasskeyByCredentialId: vi.fn(),
    upsertPasskeyCredential: vi.fn(),
    updatePasskeyCounter: vi.fn(),
    listNodesByOwner: vi.fn().mockResolvedValue([]),
    getWalletOnboardingByUserId: vi.fn().mockResolvedValue(null),
    createWalletOnboarding: vi.fn(),
    setUserTheme: vi.fn(),
  };
}

type MockStore = ReturnType<typeof createMockStore>;

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Build a minimal Fastify app replicating auth routes
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

  async function createSessionForUser(userId: string, reply: any): Promise<void> {
    const sessionToken = randomUUID();
    await store.createSession({
      sessionId: randomUUID(),
      userId,
      tokenHash: sha256Hex(sessionToken),
      expiresAtMs: Date.now() + SESSION_TTL_MS,
    });
    reply.header("set-cookie", encodeCookie("edgecoder_portal_session", sessionToken, Math.floor(SESSION_TTL_MS / 1000)));
  }

  // POST /auth/signup
  app.post("/auth/signup", async (req, reply) => {
    const body = req.body as { email?: string; password?: string; displayName?: string };
    if (!body.email || !body.password || body.password.length < 8) {
      return reply.code(400).send({ error: "validation_failed" });
    }
    const email = normalizeEmail(body.email);
    const existing = await store.getUserByEmail(email);
    if (existing) return reply.code(409).send({ error: "email_already_registered" });

    const userId = randomUUID();
    const user = {
      userId,
      email,
      emailVerified: false,
      uiTheme: "warm" as const,
      passwordHash: hashPassword(body.password),
      displayName: body.displayName,
      createdAtMs: Date.now(),
    };
    store.createUser.mockResolvedValue(user);
    await store.createUser({
      userId,
      email,
      displayName: body.displayName,
      passwordHash: hashPassword(body.password),
      emailVerified: false,
    });

    const verifyToken = randomUUID();
    await store.createEmailVerification({
      tokenId: randomUUID(),
      userId,
      tokenHash: sha256Hex(verifyToken),
      expiresAtMs: Date.now() + EMAIL_VERIFY_TTL_MS,
    });
    return reply.send({
      ok: true,
      userId,
      emailVerification: "sent",
    });
  });

  // POST /auth/login
  app.post("/auth/login", async (req, reply) => {
    const body = req.body as { email?: string; password?: string };
    if (!body.email || !body.password) {
      return reply.code(400).send({ error: "validation_failed" });
    }
    const user = await store.getUserByEmail(normalizeEmail(body.email));
    if (!user || !user.passwordHash || !verifyPassword(body.password, user.passwordHash)) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    await createSessionForUser(user.userId, reply);
    return reply.send({
      ok: true,
      user: { userId: user.userId, email: user.email, emailVerified: user.emailVerified },
    });
  });

  // POST /auth/logout
  app.post("/auth/logout", async (req, reply) => {
    const cookies = parseCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
    const sessionToken = cookies.edgecoder_portal_session;
    if (sessionToken) {
      await store.deleteSessionByTokenHash(sha256Hex(sessionToken));
    }
    reply.header("set-cookie", clearCookie("edgecoder_portal_session"));
    return reply.send({ ok: true });
  });

  // GET /auth/verify-email
  app.get("/auth/verify-email", async (req, reply) => {
    const query = req.query as { token?: string };
    if (!query.token || query.token.length < 10) {
      return reply.code(400).send({ error: "token_required" });
    }
    const consumed = await store.consumeEmailVerification(sha256Hex(query.token));
    if (!consumed) {
      return reply.code(400).type("text/html").send("Invalid or expired verification token.");
    }
    await store.markUserEmailVerified(consumed.userId);
    return reply.type("text/html").send("Email verified.");
  });

  // POST /auth/resend-verification
  app.post("/auth/resend-verification", async (req, reply) => {
    const body = req.body as { email?: string };
    if (!body.email) return reply.code(400).send({ error: "email_required" });
    const user = await store.getUserByEmail(normalizeEmail(body.email));
    if (!user) return reply.send({ ok: true });
    if (user.emailVerified) return reply.send({ ok: true, alreadyVerified: true });
    const verifyToken = randomUUID();
    await store.createEmailVerification({
      tokenId: randomUUID(),
      userId: user.userId,
      tokenHash: sha256Hex(verifyToken),
      expiresAtMs: Date.now() + EMAIL_VERIFY_TTL_MS,
    });
    return reply.send({ ok: true });
  });

  // GET /auth/capabilities
  app.get("/auth/capabilities", async () => ({
    password: true,
    passkey: { enabled: true, rpId: "localhost", allowedOrigins: ["http://localhost:4310"] },
    oauth: { google: false, microsoft: false, apple: false },
  }));

  // GET /me
  app.get("/me", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    return reply.send({
      user: {
        userId: user.userId,
        email: user.email,
        emailVerified: user.emailVerified,
        uiTheme: user.uiTheme,
      },
    });
  });

  // POST /me/theme
  app.post("/me/theme", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const body = req.body as { theme?: string };
    const validThemes = ["warm", "midnight", "emerald"];
    if (!body.theme || !validThemes.includes(body.theme)) {
      return reply.code(400).send({ error: "invalid_theme" });
    }
    await store.setUserTheme(user.userId, body.theme as any);
    return reply.send({ ok: true, theme: body.theme });
  });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const VALID_PASSWORD = "securePassword123!";
const VALID_EMAIL = "alice@example.com";

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-001",
    email: VALID_EMAIL,
    emailVerified: true,
    uiTheme: "warm" as const,
    passwordHash: hashPassword(VALID_PASSWORD),
    createdAtMs: Date.now(),
    ...overrides,
  };
}

const TEST_SESSION_TOKEN = "session-token-xyz";

function sessionCookie(): string {
  return `edgecoder_portal_session=${encodeURIComponent(TEST_SESSION_TOKEN)}`;
}

function withAuth(store: MockStore, user = makeUser()) {
  store.getSessionByTokenHash.mockResolvedValue({
    sessionId: "sess-1",
    userId: user.userId,
    expiresAtMs: Date.now() + SESSION_TTL_MS,
  });
  store.getUserById.mockResolvedValue(user);
}

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------
describe("POST /auth/signup", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("creates a new user and returns userId", async () => {
    store.getUserByEmail.mockResolvedValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: VALID_EMAIL, password: VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.userId).toBeDefined();
    expect(body.emailVerification).toBe("sent");
  });

  it("returns 409 when email already registered", async () => {
    store.getUserByEmail.mockResolvedValue(makeUser());
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: VALID_EMAIL, password: VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toBe("email_already_registered");
  });

  it("normalizes email to lowercase", async () => {
    store.getUserByEmail.mockResolvedValue(null);
    await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: "Alice@EXAMPLE.COM", password: VALID_PASSWORD },
    });
    expect(store.getUserByEmail).toHaveBeenCalledWith("alice@example.com");
  });

  it("returns 400 for a password shorter than 8 chars", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: VALID_EMAIL, password: "short" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("creates an email verification token on successful signup", async () => {
    store.getUserByEmail.mockResolvedValue(null);
    await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: VALID_EMAIL, password: VALID_PASSWORD },
    });
    expect(store.createEmailVerification).toHaveBeenCalledTimes(1);
    const call = store.createEmailVerification.mock.calls[0][0];
    expect(call.userId).toBeDefined();
    expect(call.tokenHash).toBeDefined();
    expect(call.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("accepts an optional displayName", async () => {
    store.getUserByEmail.mockResolvedValue(null);
    await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email: VALID_EMAIL, password: VALID_PASSWORD, displayName: "Alice W." },
    });
    expect(store.createUser).toHaveBeenCalledTimes(1);
    const call = store.createUser.mock.calls[0][0];
    expect(call.displayName).toBe("Alice W.");
  });
});

// ---------------------------------------------------------------------------
// Login tests
// ---------------------------------------------------------------------------
describe("POST /auth/login", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns ok and user info on valid credentials", async () => {
    store.getUserByEmail.mockResolvedValue(makeUser());
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: VALID_EMAIL, password: VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.user.email).toBe(VALID_EMAIL);
  });

  it("sets a session cookie on successful login", async () => {
    store.getUserByEmail.mockResolvedValue(makeUser());
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: VALID_EMAIL, password: VALID_PASSWORD },
    });
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeDefined();
    expect(String(setCookie)).toContain("edgecoder_portal_session=");
    expect(String(setCookie)).toContain("HttpOnly");
    expect(String(setCookie)).toContain("Path=/");
  });

  it("creates a session in the store on successful login", async () => {
    store.getUserByEmail.mockResolvedValue(makeUser());
    await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: VALID_EMAIL, password: VALID_PASSWORD },
    });
    expect(store.createSession).toHaveBeenCalledTimes(1);
    const call = store.createSession.mock.calls[0][0];
    expect(call.userId).toBe("user-001");
    expect(call.tokenHash).toBeDefined();
    expect(call.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it("returns 401 for wrong password", async () => {
    store.getUserByEmail.mockResolvedValue(makeUser());
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: VALID_EMAIL, password: "wrongPassword999" },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("invalid_credentials");
  });

  it("returns 401 when user does not exist", async () => {
    store.getUserByEmail.mockResolvedValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@example.com", password: VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("invalid_credentials");
  });

  it("returns 401 when user has no passwordHash (OAuth-only account)", async () => {
    store.getUserByEmail.mockResolvedValue(makeUser({ passwordHash: undefined }));
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: VALID_EMAIL, password: VALID_PASSWORD },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Logout tests
// ---------------------------------------------------------------------------
describe("POST /auth/logout", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("deletes the session and clears the cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(store.deleteSessionByTokenHash).toHaveBeenCalledWith(sha256Hex(TEST_SESSION_TOKEN));
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toContain("Max-Age=0");
  });

  it("succeeds even without a session cookie", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/logout" });
    expect(res.statusCode).toBe(200);
    expect(store.deleteSessionByTokenHash).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Email verification tests
// ---------------------------------------------------------------------------
describe("GET /auth/verify-email", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("consumes the token and marks email as verified", async () => {
    const token = "verification-token-valid-1234567890";
    store.consumeEmailVerification.mockResolvedValue({ userId: "user-001" });
    const res = await app.inject({
      method: "GET",
      url: `/auth/verify-email?token=${encodeURIComponent(token)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(store.consumeEmailVerification).toHaveBeenCalledWith(sha256Hex(token));
    expect(store.markUserEmailVerified).toHaveBeenCalledWith("user-001");
  });

  it("returns 400 for an invalid/expired token", async () => {
    store.consumeEmailVerification.mockResolvedValue(null);
    const res = await app.inject({
      method: "GET",
      url: "/auth/verify-email?token=expired-or-bad-token123",
    });
    expect(res.statusCode).toBe(400);
    expect(store.markUserEmailVerified).not.toHaveBeenCalled();
  });

  it("returns 400 when token query param is too short", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/auth/verify-email?token=short",
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Resend verification tests
// ---------------------------------------------------------------------------
describe("POST /auth/resend-verification", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("creates a new verification token for unverified users", async () => {
    store.getUserByEmail.mockResolvedValue(makeUser({ emailVerified: false }));
    const res = await app.inject({
      method: "POST",
      url: "/auth/resend-verification",
      payload: { email: VALID_EMAIL },
    });
    expect(res.statusCode).toBe(200);
    expect(store.createEmailVerification).toHaveBeenCalledTimes(1);
  });

  it("returns ok without creating token for already verified users", async () => {
    store.getUserByEmail.mockResolvedValue(makeUser({ emailVerified: true }));
    const res = await app.inject({
      method: "POST",
      url: "/auth/resend-verification",
      payload: { email: VALID_EMAIL },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.alreadyVerified).toBe(true);
    expect(store.createEmailVerification).not.toHaveBeenCalled();
  });

  it("returns ok silently when user does not exist (no information leakage)", async () => {
    store.getUserByEmail.mockResolvedValue(null);
    const res = await app.inject({
      method: "POST",
      url: "/auth/resend-verification",
      payload: { email: "nobody@example.com" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(store.createEmailVerification).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Auth capabilities tests
// ---------------------------------------------------------------------------
describe("GET /auth/capabilities", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns capability flags", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/capabilities" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.password).toBe(true);
    expect(body.passkey.enabled).toBe(true);
    expect(body.oauth).toBeDefined();
    expect(body.oauth.apple).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session management tests (/me)
// ---------------------------------------------------------------------------
describe("GET /me — session management", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 without a session cookie", async () => {
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 with an invalid session token", async () => {
    store.getSessionByTokenHash.mockResolvedValue(null);
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns user info when session is valid", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user.userId).toBe("user-001");
    expect(body.user.email).toBe(VALID_EMAIL);
    expect(body.user.emailVerified).toBe(true);
  });

  it("looks up session by sha256 hash of the cookie value", async () => {
    store.getSessionByTokenHash.mockResolvedValue(null);
    await app.inject({
      method: "GET",
      url: "/me",
      headers: { cookie: sessionCookie() },
    });
    expect(store.getSessionByTokenHash).toHaveBeenCalledWith(sha256Hex(TEST_SESSION_TOKEN));
  });
});

// ---------------------------------------------------------------------------
// Theme persistence tests
// ---------------------------------------------------------------------------
describe("POST /me/theme", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/me/theme",
      payload: { theme: "midnight" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("updates theme to midnight", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/me/theme",
      payload: { theme: "midnight" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).theme).toBe("midnight");
    expect(store.setUserTheme).toHaveBeenCalledWith("user-001", "midnight");
  });

  it("updates theme to emerald", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/me/theme",
      payload: { theme: "emerald" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).theme).toBe("emerald");
  });

  it("returns 400 for an invalid theme value", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/me/theme",
      payload: { theme: "neon" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(400);
  });
});
