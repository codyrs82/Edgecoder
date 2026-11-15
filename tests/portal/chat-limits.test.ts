import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { boundChatHistory, CHAT_HISTORY_MAX_MESSAGES, CHAT_MESSAGE_MAX_CHARS, registerChatApiRoutes } from "../../src/portal/routes/chat.js";
import { CONVERSATION_MESSAGES_PAGE, CONVERSATION_TITLE_MAX_CHARS, registerConversationRoutes } from "../../src/portal/routes/conversations.js";
import { CHAT_RATE_LIMIT, rateLimitFor, registerPortalSecurity } from "../../src/portal/security.js";

// /portal/api/chat and conversations: bounded message size, bounded history, per-user rate limit.

function fakeStore() {
  return {
    getConversationOwner: vi.fn(async () => "u1"),
    addMessage: vi.fn(async () => undefined),
    getConversationMessages: vi.fn(async (_id: string, _limit: number) => [
      { role: "user" as const, content: "x".repeat(100_000) },
      { role: "assistant" as const, content: "old answer" },
      { role: "user" as const, content: "latest" }
    ]),
    createConversation: vi.fn(async () => undefined),
    renameConversation: vi.fn(async () => undefined)
  };
}

function chatApp(store = fakeStore()) {
  const app = Fastify();
  registerChatApiRoutes(app, {
    store,
    getCurrentUser: async () => ({ userId: "u1" }),
    PORTAL_SERVICE_TOKEN: "svc",
    discoverCoordinatorUrlsForPortal: async () => []
  } as never);
  registerConversationRoutes(app, { store, getCurrentUser: async () => ({ userId: "u1" }) } as never);
  return { app, store };
}

describe("chat message and history bounds", () => {
  it("refuses an oversized message before storing it", async () => {
    const { app, store } = chatApp();
    const res = await app.inject({ method: "POST", url: "/portal/api/chat", payload: { conversationId: "c1", message: "a".repeat(CHAT_MESSAGE_MAX_CHARS + 1) } });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe("message_too_long");
    expect(store.addMessage).not.toHaveBeenCalled();
  });

  it("loads only a bounded tail of the conversation", async () => {
    const { app, store } = chatApp();
    const res = await app.inject({ method: "POST", url: "/portal/api/chat", payload: { conversationId: "c1", message: "hello" } });
    expect(res.statusCode).toBe(502); // no coordinator in this test
    expect(store.getConversationMessages).toHaveBeenCalledWith("c1", CHAT_HISTORY_MAX_MESSAGES);
  });

  it("boundChatHistory keeps the newest messages within the character budget", () => {
    const msgs = [{ content: "a".repeat(50) }, { content: "b".repeat(30) }, { content: "c".repeat(30) }];
    expect(boundChatHistory(msgs, 70).map((m) => m.content[0])).toEqual(["b", "c"]);
    // The newest message is always kept, even when it alone exceeds the budget.
    expect(boundChatHistory([{ content: "z".repeat(500) }], 10)).toHaveLength(1);
  });

  it("caps conversation titles and the message page", async () => {
    const { app, store } = chatApp();
    const long = "t".repeat(CONVERSATION_TITLE_MAX_CHARS + 1);
    expect((await app.inject({ method: "POST", url: "/portal/api/conversations", payload: { title: long } })).statusCode).toBe(400);
    expect(store.createConversation).not.toHaveBeenCalled();
    expect((await app.inject({ method: "PATCH", url: "/portal/api/conversations/c1", payload: { title: long } })).statusCode).toBe(400);
    expect(store.renameConversation).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: "/portal/api/conversations", payload: { title: "New chat" } })).statusCode).toBe(200);
    await app.inject({ url: "/portal/api/conversations/c1/messages" });
    expect(store.getConversationMessages).toHaveBeenLastCalledWith("c1", CONVERSATION_MESSAGES_PAGE);
  });
});

describe("chat rate limit", () => {
  it("covers chat and new conversations", () => {
    expect(rateLimitFor("/portal/api/chat", "POST")).toEqual(CHAT_RATE_LIMIT);
    expect(rateLimitFor("/portal/api/conversations", "POST")).toEqual(CHAT_RATE_LIMIT);
    expect(rateLimitFor("/portal/api/conversations", "GET")).toBeUndefined();
  });

  it("is per signed-in user, not per address", async () => {
    const app = Fastify({ trustProxy: false });
    await registerPortalSecurity(app, {
      publicOrigin: "https://edgecoder.io",
      trustedOrigins: [],
      env: {},
      rateLimitUserId: async (req) => (typeof req.headers["x-user"] === "string" ? req.headers["x-user"] : null)
    });
    app.post("/portal/api/chat", async () => ({ ok: true }));
    await app.ready();
    const send = (user: string) => app.inject({ method: "POST", url: "/portal/api/chat", remoteAddress: "10.0.0.1", headers: { "x-user": user }, payload: {} });
    const codes: number[] = [];
    for (let i = 0; i <= CHAT_RATE_LIMIT.max; i++) codes.push((await send("alice")).statusCode);
    expect(codes.slice(0, CHAT_RATE_LIMIT.max).every((c) => c === 200)).toBe(true);
    expect(codes[CHAT_RATE_LIMIT.max]).toBe(429);
    // Another user behind the same address has their own bucket.
    expect((await send("bob")).statusCode).toBe(200);
    await app.close();
  });
});
