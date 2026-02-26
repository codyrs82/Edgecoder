import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { sha256Hex, parseCookies, encodeCookie } from "../../src/portal/portal-utils.js";

// ---------------------------------------------------------------------------
// Minimal mock store — just the methods the chat routes touch
// ---------------------------------------------------------------------------
function createMockStore() {
  return {
    getSessionByTokenHash: vi.fn(),
    getUserById: vi.fn(),
    listConversations: vi.fn(),
    createConversation: vi.fn(),
    getConversationMessages: vi.fn(),
    addMessage: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
    listNodesByOwner: vi.fn().mockResolvedValue([]),
  };
}

type MockStore = ReturnType<typeof createMockStore>;

// ---------------------------------------------------------------------------
// Build a minimal Fastify app that registers the chat routes with an
// injectable mock store. We replicate the route handlers from server.ts so
// the test is self-contained and does not import the main server module
// (which carries module-level side-effects).
// ---------------------------------------------------------------------------
async function buildApp(store: MockStore) {
  const app = Fastify();

  // ----- helpers (mirror the real server) -----
  async function getCurrentUser(req: { headers: Record<string, unknown> }) {
    const cookies = parseCookies(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
    const sessionToken = cookies.edgecoder_portal_session;
    if (!sessionToken) return null;
    const session = await store.getSessionByTokenHash(sha256Hex(sessionToken));
    if (!session) return null;
    const user = await store.getUserById(session.userId);
    return user ?? null;
  }

  // GET /portal/api/conversations
  app.get("/portal/api/conversations", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const conversations = await store.listConversations(user.userId);
    return reply.send({ conversations });
  });

  // POST /portal/api/conversations
  app.post("/portal/api/conversations", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const body = req.body as { title?: string };
    const conversationId = randomUUID();
    await store.createConversation({ conversationId, userId: user.userId, title: body.title });
    return reply.send({ conversationId });
  });

  // GET /portal/api/conversations/:id/messages
  app.get("/portal/api/conversations/:id/messages", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const { id } = req.params as { id: string };
    const messages = await store.getConversationMessages(id);
    return reply.send({ messages });
  });

  // PATCH /portal/api/conversations/:id
  app.patch("/portal/api/conversations/:id", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const { id } = req.params as { id: string };
    const body = req.body as { title: string };
    if (!body.title || body.title.length === 0) {
      return reply.code(400).send({ error: "title_required" });
    }
    await store.renameConversation(id, body.title);
    return reply.send({ ok: true });
  });

  // DELETE /portal/api/conversations/:id
  app.delete("/portal/api/conversations/:id", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });
    const { id } = req.params as { id: string };
    await store.deleteConversation(id);
    return reply.send({ ok: true });
  });

  // POST /portal/api/chat (simplified — no real coordinator streaming)
  app.post("/portal/api/chat", async (req, reply) => {
    const user = await getCurrentUser(req as any);
    if (!user) return reply.code(401).send({ error: "not_authenticated" });

    const body = req.body as { conversationId?: string; message?: string };
    if (!body.conversationId || !body.message) {
      return reply.code(400).send({ error: "missing_fields" });
    }

    await store.addMessage({
      messageId: randomUUID(),
      conversationId: body.conversationId,
      role: "user",
      content: body.message,
    });

    // In the real server this discovers coordinators and streams SSE.
    // Here we return a simple JSON response for unit testing the
    // auth guard, persistence, and coordinator-unavailable path.
    return reply.code(502).send({ error: "no_coordinators_available" });
  });

  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------
const TEST_SESSION_TOKEN = "test-session-token-abc123";
const TEST_TOKEN_HASH = sha256Hex(TEST_SESSION_TOKEN);

const TEST_USER = {
  userId: "user-001",
  email: "alice@example.com",
  emailVerified: true,
  uiTheme: "warm" as const,
  createdAtMs: Date.now(),
};

function sessionCookie(): string {
  return `edgecoder_portal_session=${encodeURIComponent(TEST_SESSION_TOKEN)}`;
}

function withAuth(store: MockStore) {
  store.getSessionByTokenHash.mockResolvedValue({
    sessionId: "sess-1",
    userId: TEST_USER.userId,
    expiresAtMs: Date.now() + 3_600_000,
  });
  store.getUserById.mockResolvedValue(TEST_USER);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /portal/api/conversations", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/portal/api/conversations" });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error).toBe("not_authenticated");
  });

  it("returns empty list for user with no conversations", async () => {
    withAuth(store);
    store.listConversations.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/portal/api/conversations",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.conversations).toEqual([]);
  });

  it("returns conversations belonging to the current user", async () => {
    withAuth(store);
    const convs = [
      { conversationId: "conv-1", userId: TEST_USER.userId, title: "First chat", createdAtMs: 1000, updatedAtMs: 2000 },
      { conversationId: "conv-2", userId: TEST_USER.userId, title: "Second chat", createdAtMs: 3000, updatedAtMs: 4000 },
    ];
    store.listConversations.mockResolvedValue(convs);
    const res = await app.inject({
      method: "GET",
      url: "/portal/api/conversations",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.conversations).toHaveLength(2);
    expect(body.conversations[0].conversationId).toBe("conv-1");
    expect(body.conversations[1].title).toBe("Second chat");
  });

  it("calls store.listConversations with the correct userId", async () => {
    withAuth(store);
    store.listConversations.mockResolvedValue([]);
    await app.inject({
      method: "GET",
      url: "/portal/api/conversations",
      headers: { cookie: sessionCookie() },
    });
    expect(store.listConversations).toHaveBeenCalledWith(TEST_USER.userId);
  });
});

describe("POST /portal/api/conversations", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/portal/api/conversations",
      payload: { title: "Chat" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates a conversation and returns a conversationId", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/portal/api/conversations",
      payload: { title: "My chat" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.conversationId).toBeDefined();
    expect(typeof body.conversationId).toBe("string");
    expect(body.conversationId.length).toBeGreaterThan(10);
  });

  it("passes the title to store.createConversation", async () => {
    withAuth(store);
    await app.inject({
      method: "POST",
      url: "/portal/api/conversations",
      payload: { title: "Backend task" },
      headers: { cookie: sessionCookie() },
    });
    expect(store.createConversation).toHaveBeenCalledTimes(1);
    const callArg = store.createConversation.mock.calls[0][0];
    expect(callArg.userId).toBe(TEST_USER.userId);
    expect(callArg.title).toBe("Backend task");
    expect(callArg.conversationId).toBeDefined();
  });

  it("works with an empty body (title is optional)", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/portal/api/conversations",
      payload: {},
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    expect(store.createConversation).toHaveBeenCalled();
    const callArg = store.createConversation.mock.calls[0][0];
    expect(callArg.title).toBeUndefined();
  });
});

describe("GET /portal/api/conversations/:id/messages", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.inject({ method: "GET", url: "/portal/api/conversations/conv-1/messages" });
    expect(res.statusCode).toBe(401);
  });

  it("returns messages for a given conversation", async () => {
    withAuth(store);
    const msgs = [
      { messageId: "m1", conversationId: "conv-1", role: "user", content: "Hello", tokensUsed: 5, creditsSpent: 0, createdAtMs: 1000 },
      { messageId: "m2", conversationId: "conv-1", role: "assistant", content: "Hi there!", tokensUsed: 8, creditsSpent: 1, createdAtMs: 2000 },
    ];
    store.getConversationMessages.mockResolvedValue(msgs);
    const res = await app.inject({
      method: "GET",
      url: "/portal/api/conversations/conv-1/messages",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].content).toBe("Hi there!");
  });

  it("returns empty messages array when conversation has none", async () => {
    withAuth(store);
    store.getConversationMessages.mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/portal/api/conversations/conv-empty/messages",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.messages).toEqual([]);
  });
});

describe("PATCH /portal/api/conversations/:id", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/portal/api/conversations/conv-1",
      payload: { title: "New title" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("renames a conversation", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "PATCH",
      url: "/portal/api/conversations/conv-1",
      payload: { title: "Renamed conversation" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(store.renameConversation).toHaveBeenCalledWith("conv-1", "Renamed conversation");
  });
});

describe("DELETE /portal/api/conversations/:id", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.inject({ method: "DELETE", url: "/portal/api/conversations/conv-1" });
    expect(res.statusCode).toBe(401);
  });

  it("deletes a conversation", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "DELETE",
      url: "/portal/api/conversations/conv-1",
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(store.deleteConversation).toHaveBeenCalledWith("conv-1");
  });
});

describe("POST /portal/api/chat", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("returns 401 when unauthenticated", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/portal/api/chat",
      payload: { conversationId: "conv-1", message: "Hello" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("persists the user message before attempting coordinator discovery", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/portal/api/chat",
      payload: { conversationId: "conv-1", message: "Hello coordinator" },
      headers: { cookie: sessionCookie() },
    });
    // The simplified handler always returns 502 (no coordinators); but the
    // user message should already be persisted.
    expect(res.statusCode).toBe(502);
    expect(store.addMessage).toHaveBeenCalledTimes(1);
    const call = store.addMessage.mock.calls[0][0];
    expect(call.conversationId).toBe("conv-1");
    expect(call.role).toBe("user");
    expect(call.content).toBe("Hello coordinator");
  });

  it("returns 502 with no_coordinators_available when no coordinator is reachable", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/portal/api/chat",
      payload: { conversationId: "conv-1", message: "test" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).error).toBe("no_coordinators_available");
  });

  it("returns 400 when conversationId or message is missing", async () => {
    withAuth(store);
    const res = await app.inject({
      method: "POST",
      url: "/portal/api/chat",
      payload: { conversationId: "conv-1" },
      headers: { cookie: sessionCookie() },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("conversation message persistence (store integration)", () => {
  let store: MockStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    store = createMockStore();
    app = await buildApp(store);
  });

  it("addMessage is called with a unique messageId each time", async () => {
    withAuth(store);
    await app.inject({
      method: "POST",
      url: "/portal/api/chat",
      payload: { conversationId: "conv-1", message: "First" },
      headers: { cookie: sessionCookie() },
    });
    await app.inject({
      method: "POST",
      url: "/portal/api/chat",
      payload: { conversationId: "conv-1", message: "Second" },
      headers: { cookie: sessionCookie() },
    });
    expect(store.addMessage).toHaveBeenCalledTimes(2);
    const id1 = store.addMessage.mock.calls[0][0].messageId;
    const id2 = store.addMessage.mock.calls[1][0].messageId;
    expect(id1).not.toBe(id2);
  });

  it("user messages record role=user", async () => {
    withAuth(store);
    await app.inject({
      method: "POST",
      url: "/portal/api/chat",
      payload: { conversationId: "conv-2", message: "What is 2+2?" },
      headers: { cookie: sessionCookie() },
    });
    const call = store.addMessage.mock.calls[0][0];
    expect(call.role).toBe("user");
    expect(call.content).toBe("What is 2+2?");
    expect(call.conversationId).toBe("conv-2");
  });
});
