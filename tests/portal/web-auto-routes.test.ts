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

async function coordinator(status: Record<string, unknown>, opts: { submitted?: Array<Record<string, unknown>> } = {}) {
  const seen: string[] = [];
  const app = Fastify();
  // A model call that answers in words, without calling a tool.
  app.post("/inference/submit", async (req) => {
    opts.submitted?.push(req.body as Record<string, unknown>);
    return { ok: true, subtaskId: "s1" };
  });
  app.post("/inference/stream", async () => ({ chunks: ["I can't browse the web."], next: 1, done: true, creditsSpent: 0 }));
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

function portal(coordUrl: string, opts: { logs?: Array<Record<string, unknown>>; ownMachineModels?: (userId: string) => Promise<string[]> } = {}) {
  // A fake logger: the app's log lines, parsed, in opts.logs.
  const app = opts.logs
    ? Fastify({ logger: { level: "info", stream: { write: (line: string) => void opts.logs!.push(JSON.parse(line)) } } })
    : Fastify();
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
    ...(opts.ownMachineModels ? { ownMachineModels: opts.ownMachineModels } : {}),
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

describe("portal_web_decision log", () => {
  const decisions = (logs: Array<Record<string, unknown>>) => logs.filter((l) => l.msg === "portal_web_decision");
  const SECRET = "my secret question about rust";

  it("Auto with an own tool-capable model: mine compute, avail checked, web loop taken; the loop logs turns and tool use", async () => {
    const submitted: Array<Record<string, unknown>> = [];
    const c = await coordinator({ configured: true, canAfford: true, searchesLeftThisHour: 10 }, { submitted });
    const logs: Array<Record<string, unknown>> = [];
    const app = portal(c.url, { logs, ownMachineModels: async () => ["qwen3-coder:30b"] });
    await app.inject({ method: "POST", url: "/portal/api/chat", payload: { conversationId: "c1", message: SECRET, web: true, compute: { target: "auto" } } });
    const d = decisions(logs);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      userId: "u1", target: "auto", model: null,
      ownModels: ["qwen3-coder:30b"], ownTools: "qwen3-coder:30b",
      compute: { target: "mine", model: "qwen3-coder:30b" }, computeNullReason: null,
      availOffer: true, availReason: null, path: "web_loop",
    });
    // The own-machine call carries the web tool definitions.
    expect(submitted[0]).toMatchObject({ target: "mine", model: "qwen3-coder:30b" });
    expect((submitted[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual(expect.arrayContaining(["web_search"]));
    const loop = logs.find((l) => l.msg === "portal_web_loop");
    expect(loop).toMatchObject({ turns: 1, toolCalls: [], modelReturnedToolCall: false, compute: { target: "mine", model: "qwen3-coder:30b" } });
    expect((loop!.first as { toolsSent: number }).toolsSent).toBeGreaterThan(0);
    // Never the message content.
    expect(JSON.stringify(logs.filter((l) => String(l.msg).startsWith("portal_web")))).not.toContain(SECRET);
  });

  it("Auto whose own models can't call tools: compute null with the reason, no avail check, runAuto", async () => {
    const c = await coordinator({ configured: true, canAfford: true });
    const logs: Array<Record<string, unknown>> = [];
    await portal(c.url, { logs, ownMachineModels: async () => ["deepseek-r1:14b"] }).inject({ method: "POST", url: "/portal/api/chat", payload: { conversationId: "c1", message: "hi", web: true, compute: { target: "auto" } } });
    const d = decisions(logs);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ ownModels: ["deepseek-r1:14b"], ownTools: null, compute: null, computeNullReason: "own_models_cannot_call_tools", path: "runAuto" });
    expect(d[0]).not.toHaveProperty("availOffer");
  });

  it("a network model with no cSats for search: avail.reason logged, runOnNetwork; no log without web", async () => {
    const c = await coordinator({ configured: true, canAfford: false });
    const logs: Array<Record<string, unknown>> = [];
    const app = portal(c.url, { logs });
    await app.inject({ method: "POST", url: "/portal/api/chat", payload: { conversationId: "c1", message: "hi", web: true, compute: { target: "network", model: "qwen3:8b" } } });
    expect(decisions(logs)[0]).toMatchObject({ target: "network", model: "qwen3:8b", compute: { target: "network", model: "qwen3:8b" }, availOffer: false, availReason: "needs_csats", path: "runOnNetwork" });
    await app.inject({ method: "POST", url: "/portal/api/chat", payload: { conversationId: "c1", message: "hi", compute: { target: "network", model: "qwen3:8b" } } });
    expect(decisions(logs)).toHaveLength(1);
  });
});
