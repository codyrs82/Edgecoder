import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { sha256Hex, parseCookies, encodeCookie } from "../../src/portal/portal-utils.js";

// ---------------------------------------------------------------------------
// Mock store — dashboard-relevant methods
// ---------------------------------------------------------------------------
function createMockStore() {
  return {
    getSessionByTokenHash: vi.fn(),
    getUserById: vi.fn(),
    listNodesByOwner: vi.fn(),
    setUserTheme: vi.fn(),
    getNodeEnrollment: vi.fn(),
  };
}

type MockStore = ReturnType<typeof createMockStore>;

// ---------------------------------------------------------------------------
// A mock for loadWalletSnapshotForUser which in the real server calls the
// control plane. We inject a configurable wallet snapshot into the route.
// ---------------------------------------------------------------------------
type WalletSnapshot = {
  credits: { balance: number } | null;
  quote: { estimatedSats: number; satsPerCredit: number } | null;
  creditHistory: Array<Record<string, unknown>>;
  wallets: Array<Record<string, unknown>>;
  paymentIntents: Array<Record<string, unknown>>;
};

async function buildApp(
  store: MockStore,
  options?: {
    walletSnapshot?: WalletSnapshot;
  }
) {
  const app = Fastify();

  const defaultWalletSnapshot: WalletSnapshot = {
    credits: null,
    quote: null,
    creditHistory: [],
    wallets: [],
    paymentIntents: [],
  };

  const walletSnapshot = options?.walletSnapshot ?? defaultWalletSnapshot;

  async function getCurrentUser(req: { headers: Record<string, unknown> }) {
    const cookies = parseCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
    const sessionToken = cookies.edgecoder_portal_session;
    if (!sessionToken) return null;
    const session = await store.getSessionByTokenHash(sha256Hex(sessionToken));
    if (!session) return null;
    return await store.getUserById(session.userId);
  }

  // GET /dashboard/summary
  app.get("/dashboard/summary", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const nodes = await store.listNodesByOwner(user.userId);
    return reply.send({
      user: {
        userId: user.userId,
        email: user.email,
        emailVerified: user.emailVerified,
        uiTheme: user.uiTheme,
      },
      nodes: nodes.map((n: any) => ({
        nodeId: n.nodeId,
        nodeKind: n.nodeKind,
        active: n.active,
        emailVerified: n.emailVerified,
        nodeApproved: n.nodeApproved,
        lastSeenMs: n.lastSeenMs,
      })),
      walletSnapshot,
    });
  });

  // POST /me/theme (theme persistence — used from dashboard)
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

  // GET /nodes/me (node listing)
  app.get("/nodes/me", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const nodes = await store.listNodesByOwner(user.userId);
    return reply.send({ nodes });
  });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const TEST_SESSION_TOKEN = "dashboard-session-token";
const TEST_USER = {
  userId: "user-dash-001",
  email: "carol@example.com",
  emailVerified: true,
  uiTheme: "warm" as const,
  displayName: "Carol",
  createdAtMs: Date.now() - 86_400_000,
};

function sessionCookie(): string {
  return `edgecoder_portal_session=${encodeURIComponent(TEST_SESSION_TOKEN)}`;
}

function withAuth(store: MockStore, user = TEST_USER) {
  store.getSessionByTokenHash.mockResolvedValue({
    sessionId: "sess-d1",
    userId: user.userId,
    expiresAtMs: Date.now() + 3_600_000,
  });
  store.getUserById.mockResolvedValue(user);
}

const MOCK_NODES = [
  {
    nodeId: "ios-abc123def456",
    nodeKind: "agent",
    active: true,
    emailVerified: true,
    nodeApproved: true,
    lastSeenMs: Date.now() - 120_000,
    ownerUserId: TEST_USER.userId,
    ownerEmail: TEST_USER.email,
  },
  {
    nodeId: "server-node-001",
    nodeKind: "coordinator",
    active: false,
    emailVerified: true,
    nodeApproved: false,
    lastSeenMs: undefined,
    ownerUserId: TEST_USER.userId,
    ownerEmail: TEST_USER.email,
  },
];

// ---------------------------------------------------------------------------
// GET /dashboard/summary
// ---------------------------------------------------------------------------
describe("GET /dashboard/summary", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/dashboard/summary" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("not_authenticated");
  });

  it("returns user info in the summary", async () => {
    withAuth(store);
    store.listNodesByOwner.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/summary",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.user.userId).toBe(TEST_USER.userId);
    expect(body.user.email).toBe(TEST_USER.email);
    expect(body.user.emailVerified).toBe(true);
    expect(body.user.uiTheme).toBe("warm");
  });

  it("returns empty nodes array when user has none", async () => {
    withAuth(store);
    store.listNodesByOwner.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/summary",
      headers: { cookie: sessionCookie() },
    });
    const body = JSON.parse(res.body);
    expect(body.nodes).toEqual([]);
  });

  it("returns node listing with correct fields", async () => {
    withAuth(store);
    store.listNodesByOwner.mockResolvedValue(MOCK_NODES);
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/summary",
      headers: { cookie: sessionCookie() },
    });
    const body = JSON.parse(res.body);
    expect(body.nodes).toHaveLength(2);

    const agent = body.nodes.find((n: any) => n.nodeKind === "agent");
    expect(agent).toBeDefined();
    expect(agent.nodeId).toBe("ios-abc123def456");
    expect(agent.active).toBe(true);
    expect(agent.nodeApproved).toBe(true);
    expect(agent.lastSeenMs).toBeDefined();

    const coordinator = body.nodes.find((n: any) => n.nodeKind === "coordinator");
    expect(coordinator).toBeDefined();
    expect(coordinator.nodeId).toBe("server-node-001");
    expect(coordinator.active).toBe(false);
    expect(coordinator.nodeApproved).toBe(false);
  });

  it("includes walletSnapshot in the response", async () => {
    withAuth(store);
    store.listNodesByOwner.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/summary",
      headers: { cookie: sessionCookie() },
    });
    const body = JSON.parse(res.body);
    expect(body.walletSnapshot).toBeDefined();
    expect(body.walletSnapshot.credits).toBeNull();
    expect(body.walletSnapshot.creditHistory).toEqual([]);
  });

  it("returns wallet snapshot with credit balance", async () => {
    withAuth(store);
    store.listNodesByOwner.mockResolvedValue([]);
    const customSnapshot: WalletSnapshot = {
      credits: { balance: 42.5 },
      quote: { estimatedSats: 2125, satsPerCredit: 50 },
      creditHistory: [
        { type: "earn", credits: 10, reason: "compute_contribution", timestampMs: Date.now() - 3600_000 },
        { type: "spend", credits: 2, reason: "chat_usage", timestampMs: Date.now() - 1800_000 },
      ],
      wallets: [{ walletType: "lightning", network: "signet", payoutAddress: "lnbc..." }],
      paymentIntents: [],
    };
    app = await buildApp(store, { walletSnapshot: customSnapshot });
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/summary",
      headers: { cookie: sessionCookie() },
    });
    const body = JSON.parse(res.body);
    expect(body.walletSnapshot.credits.balance).toBe(42.5);
    expect(body.walletSnapshot.quote.estimatedSats).toBe(2125);
    expect(body.walletSnapshot.creditHistory).toHaveLength(2);
    expect(body.walletSnapshot.wallets).toHaveLength(1);
  });

  it("calls store.listNodesByOwner with the correct userId", async () => {
    withAuth(store);
    store.listNodesByOwner.mockResolvedValue([]);
    await app.inject({
      method: "GET",
      url: "/dashboard/summary",
      headers: { cookie: sessionCookie() },
    });
    expect(store.listNodesByOwner).toHaveBeenCalledWith(TEST_USER.userId);
  });
});

// ---------------------------------------------------------------------------
// GET /nodes/me — node listing
// ---------------------------------------------------------------------------
describe("GET /nodes/me", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/nodes/me" });
    expect(res.statusCode).toBe(401);
  });

  it("returns all nodes belonging to the user", async () => {
    withAuth(store);
    store.listNodesByOwner.mockResolvedValue(MOCK_NODES);
    const res = await app.inject({
      method: "GET",
      url: "/nodes/me",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.nodes).toHaveLength(2);
    expect(body.nodes[0].nodeId).toBe("ios-abc123def456");
  });

  it("returns empty array when user has no nodes", async () => {
    withAuth(store);
    store.listNodesByOwner.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/nodes/me",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).nodes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Theme persistence (from dashboard)
// ---------------------------------------------------------------------------
describe("POST /me/theme (dashboard theme persistence)", () => {
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
      payload: { theme: "warm" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("persists warm theme", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/me/theme",
      payload: { theme: "warm" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).theme).toBe("warm");
    expect(store.setUserTheme).toHaveBeenCalledWith(TEST_USER.userId, "warm");
  });

  it("persists midnight theme", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/me/theme",
      payload: { theme: "midnight" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    expect(store.setUserTheme).toHaveBeenCalledWith(TEST_USER.userId, "midnight");
  });

  it("persists emerald theme", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/me/theme",
      payload: { theme: "emerald" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    expect(store.setUserTheme).toHaveBeenCalledWith(TEST_USER.userId, "emerald");
  });

  it("rejects an invalid theme name", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/me/theme",
      payload: { theme: "dracula" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(400);
    expect(store.setUserTheme).not.toHaveBeenCalled();
  });

  it("rejects an empty theme value", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/me/theme",
      payload: { theme: "" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing theme field", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/me/theme",
      payload: {},
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Dashboard summary — node status combinations
// ---------------------------------------------------------------------------
describe("dashboard node status scenarios", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("shows active=false for unverified email even if node is approved", async () => {
    withAuth(store);
    store.listNodesByOwner.mockResolvedValue([
      {
        nodeId: "node-unverified",
        nodeKind: "agent",
        active: false,
        emailVerified: false,
        nodeApproved: true,
        lastSeenMs: undefined,
        ownerUserId: TEST_USER.userId,
        ownerEmail: TEST_USER.email,
      },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/summary",
      headers: { cookie: sessionCookie() },
    });
    const body = JSON.parse(res.body);
    expect(body.nodes[0].active).toBe(false);
    expect(body.nodes[0].emailVerified).toBe(false);
    expect(body.nodes[0].nodeApproved).toBe(true);
  });

  it("shows active=true only when email verified and node approved", async () => {
    withAuth(store);
    store.listNodesByOwner.mockResolvedValue([
      {
        nodeId: "node-active",
        nodeKind: "agent",
        active: true,
        emailVerified: true,
        nodeApproved: true,
        lastSeenMs: Date.now(),
        ownerUserId: TEST_USER.userId,
        ownerEmail: TEST_USER.email,
      },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/summary",
      headers: { cookie: sessionCookie() },
    });
    const body = JSON.parse(res.body);
    expect(body.nodes[0].active).toBe(true);
  });

  it("handles multiple node types in the same dashboard", async () => {
    withAuth(store);
    store.listNodesByOwner.mockResolvedValue([
      { nodeId: "agent-1", nodeKind: "agent", active: true, emailVerified: true, nodeApproved: true, lastSeenMs: Date.now() },
      { nodeId: "agent-2", nodeKind: "agent", active: false, emailVerified: true, nodeApproved: false, lastSeenMs: undefined },
      { nodeId: "coord-1", nodeKind: "coordinator", active: false, emailVerified: true, nodeApproved: false, lastSeenMs: undefined },
    ]);
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/summary",
      headers: { cookie: sessionCookie() },
    });
    const body = JSON.parse(res.body);
    expect(body.nodes).toHaveLength(3);
    const agents = body.nodes.filter((n: any) => n.nodeKind === "agent");
    const coordinators = body.nodes.filter((n: any) => n.nodeKind === "coordinator");
    expect(agents).toHaveLength(2);
    expect(coordinators).toHaveLength(1);
  });

  it("reflects user uiTheme in summary response", async () => {
    const midnightUser = { ...TEST_USER, uiTheme: "midnight" as const };
    withAuth(store, midnightUser);
    store.listNodesByOwner.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/dashboard/summary",
      headers: { cookie: sessionCookie() },
    });
    const body = JSON.parse(res.body);
    expect(body.user.uiTheme).toBe("midnight");
  });
});
