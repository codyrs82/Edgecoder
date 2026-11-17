import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerChatApiRoutes } from "../../src/portal/routes/chat.js";
import { forgetWebAvailability } from "../../src/web-tool/tools.js";

// Web is automatic (docs/web-tool.md): /portal/api/web/status says why it can't be used, and
// /portal/api/chat with web doesn't offer the tools to an account without cSats (it notes it once).

const apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  forgetWebAvailability();
});

async function coordinator(status: Record<string, unknown>) {
  const seen: string[] = [];
  const app = Fastify();
  app.post("/v1/tools/web/status", async () => {
    seen.push("status");
    return status;
  });
  app.post("/v1/tools/web/search", async () => {
    seen.push("search");
    return { cSats: 0.5, results: [] };
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  apps.push(app);
  const addr = app.server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, seen };
}

function portal(coordUrl: string) {
  const app = Fastify();
  apps.push(app);
  const store = {
    getConversationOwner: vi.fn(async () => "u1"),
    addMessage: vi.fn(async () => undefined),
    getConversationMessages: vi.fn(async () => [{ role: "user" as const, content: "What's new in Rust?" }]),
  };
  registerChatApiRoutes(app, {
    store,
    getCurrentUser: async () => ({ userId: "u1" }),
    PORTAL_SERVICE_TOKEN: "svc",
    discoverCoordinatorUrlsForPortal: async () => [coordUrl],
  } as never);
  return app;
}

describe("/portal/api/web/status", () => {
  it("is available when set up, affordable and under the hour's limit, with the per-reply limits", async () => {
    const c = await coordinator({ configured: true, canAfford: true, searchesLeftThisHour: 10, searchCSats: 0.5, readCSats: 0.2 });
    const res = await portal(c.url).inject({ url: "/portal/api/web/status?target=auto" });
    expect(res.json()).toMatchObject({ available: true, reason: null, maxSearchesPerReply: 3, maxReadsPerReply: 4 });
  });

  it("rate_limited when the hour's searches are used; no_tools for a model that can't call tools", async () => {
    const c = await coordinator({ configured: true, canAfford: true, searchesLeftThisHour: 0 });
    expect((await portal(c.url).inject({ url: "/portal/api/web/status?target=auto" })).json()).toMatchObject({ available: false, reason: "rate_limited" });
    const d = await coordinator({ configured: true, canAfford: true, searchesLeftThisHour: 5 });
    expect((await portal(d.url).inject({ url: "/portal/api/web/status?target=network&model=deepseek-r1:14b" })).json()).toMatchObject({ available: false, reason: "no_tools" });
  });
});

describe("/portal/api/chat with web (Auto)", () => {
  it("an account without cSats isn't offered the web tools: no search, and the stream notes webOff", async () => {
    const c = await coordinator({ configured: true, canAfford: false });
    const res = await portal(c.url).inject({ method: "POST", url: "/portal/api/chat", payload: { conversationId: "c1", message: "What's new in Rust?", web: true, compute: { target: "network", model: "qwen3:8b" } } });
    expect(res.body).toContain('"webOff":{"reason":"needs_csats","message":"Web search needs cSats"}');
    expect(c.seen).toEqual(["status"]);
  });

  it("a model that can't call tools answers without the web, with no warning and no status call", async () => {
    const c = await coordinator({ configured: true, canAfford: true });
    const res = await portal(c.url).inject({ method: "POST", url: "/portal/api/chat", payload: { conversationId: "c1", message: "hi", web: true, compute: { target: "network", model: "deepseek-r1:14b" } } });
    expect(res.body).not.toContain("webOff");
    expect(res.body).not.toContain("Web needs a model that can use tools");
    expect(c.seen).toEqual([]);
  });
});
