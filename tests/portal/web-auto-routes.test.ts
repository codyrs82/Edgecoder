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

async function coordinator(status: Record<string, unknown>, opts: { submitted?: Array<Record<string, unknown>>; ownStatus?: Record<string, unknown>; searches?: Array<Record<string, unknown>>; results?: Array<Record<string, unknown>>; answer?: string } = {}) {
  const seen: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  const app = Fastify();
  // A model call that answers in words, without calling a tool.
  app.post("/inference/submit", async (req) => {
    opts.submitted?.push(req.body as Record<string, unknown>);
    return { ok: true, subtaskId: "s1" };
  });
  app.post("/inference/stream", async () => ({ chunks: [opts.answer ?? "I can't browse the web."], next: 1, done: true, creditsSpent: 0 }));
  app.post("/v1/tools/web/status", async (req) => {
    seen.push("status");
    const body = (req.body ?? {}) as Record<string, unknown>;
    bodies.push(body);
    return body.ownMachine === true && opts.ownStatus ? opts.ownStatus : status;
  });
  app.post("/v1/tools/web/search", async (req) => {
    seen.push("search");
    opts.searches?.push(req.body as Record<string, unknown>);
    return { cSats: 0.5, results: opts.results ?? [] };
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  apps.push(app);
  const addr = app.server.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, seen, bodies };
}

function portal(coordUrl: string, opts: { logs?: Array<Record<string, unknown>>; ownMachineModels?: (userId: string) => Promise<string[]>; history?: string; added?: Array<Record<string, unknown>> } = {}) {
  // A fake logger: the app's log lines, parsed, in opts.logs.
  const app = opts.logs
    ? Fastify({ logger: { level: "info", stream: { write: (line: string) => void opts.logs!.push(JSON.parse(line)) } } })
    : Fastify();
  apps.push(app);
  const store = {
    getConversationOwner: vi.fn(async () => "u1"),
    addMessage: vi.fn(async (m: Record<string, unknown>) => void opts.added?.push(m)),
    getConversationMessages: vi.fn(async () => [{ role: "user" as const, content: opts.history ?? "What's new in Rust?" }]),
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
    // "What's new in Rust?" needs fresh facts: the server searched once before the first turn (grounding).
    expect(loop).toMatchObject({ turns: 1, toolCalls: ["web_search"], grounded: true, modelReturnedToolCall: false, compute: { target: "mine", model: "qwen3-coder:30b" } });
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

describe("free web on your own machine (portal)", () => {
  const broke = { configured: true, canAfford: false, free: false, balanceCSats: 0, searchesLeftThisHour: 60 };
  const freeOwn = { ...broke, canAfford: true, free: true, freeSearchesLeftToday: 100, freeReadsLeftToday: 200 };

  it("status for My machines asks with the own-machine basis: available and free with 0 cSats", async () => {
    const c = await coordinator(broke, { ownStatus: freeOwn });
    const res = await portal(c.url).inject({ url: "/portal/api/web/status?target=mine&model=qwen3:8b" });
    expect(res.json()).toMatchObject({ available: true, reason: null, free: true, freeSearchesLeftToday: 100 });
    expect(c.bodies[0]).toMatchObject({ accountId: "acct-u1", ownMachine: true });
  });

  it("status for Auto is free only when one of your machines has a model that calls tools", async () => {
    const c = await coordinator(broke, { ownStatus: freeOwn });
    expect((await portal(c.url, { ownMachineModels: async () => ["qwen3:8b"] }).inject({ url: "/portal/api/web/status?target=auto" })).json()).toMatchObject({ available: true, free: true });
    const d = await coordinator(broke, { ownStatus: freeOwn });
    expect((await portal(d.url, { ownMachineModels: async () => [] }).inject({ url: "/portal/api/web/status?target=auto" })).json()).toMatchObject({ available: false, reason: "needs_csats", free: false });
    expect(d.bodies[0]).not.toHaveProperty("ownMachine");
  });

  it("a network chat stays paid: no basis, and 0 cSats isn't offered the web", async () => {
    const c = await coordinator(broke, { ownStatus: freeOwn });
    const res = await portal(c.url).inject({ url: "/portal/api/web/status?target=network&model=qwen3:8b" });
    expect(res.json()).toMatchObject({ available: false, reason: "needs_csats", free: false });
    expect(c.bodies[0]).not.toHaveProperty("ownMachine");
  });

  it("a chat on My machines with 0 cSats is offered the web (no webOff), asked with the basis", async () => {
    const c = await coordinator(broke, { ownStatus: freeOwn });
    const res = await portal(c.url).inject({ method: "POST", url: "/portal/api/chat", payload: { conversationId: "c1", message: "What's new in Rust?", web: true, compute: { target: "mine", model: "qwen3:8b" } } });
    expect(res.body).not.toContain("webOff");
    expect(c.bodies[0]).toMatchObject({ ownMachine: true });
  });

  it("a forged ownMachine in the chat body is ignored for a network chat", async () => {
    const c = await coordinator(broke, { ownStatus: freeOwn });
    const res = await portal(c.url).inject({ method: "POST", url: "/portal/api/chat", payload: { conversationId: "c1", message: "What's new in Rust?", web: true, ownMachine: true, free: true, compute: { target: "network", model: "qwen3:8b", ownMachine: true } } });
    expect(res.body).toContain('"webOff":{"reason":"needs_csats"');
    expect(c.bodies).toHaveLength(1);
    expect(c.bodies[0]).not.toHaveProperty("ownMachine");
    expect(c.seen).toEqual(["status"]);
  });

  it("own machine past today's free calls with 0 cSats: free_used, not needs cSats", async () => {
    const c = await coordinator(broke, { ownStatus: { ...broke, free: false, freeSearchesLeftToday: 0, freeReadsLeftToday: 0 } });
    const res = await portal(c.url).inject({ url: "/portal/api/web/status?target=mine&model=qwen3:8b" });
    expect(res.json()).toMatchObject({ available: false, reason: "free_used", message: "Today's free web searches on your machine are used up" });
  });
});

describe("web grounding (portal)", () => {
  const RESULTS = [{ title: "CISA KEV", url: "https://cisa.example/kev", snippet: "Known exploited" }];
  const Q = "What are today's zero day threats?";
  const chat = (app: FastifyInstance, compute: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/portal/api/chat", payload: { conversationId: "c1", message: Q, web: true, compute } });

  for (const [label, compute, own] of [
    ["Auto on your own machine (free model call)", { target: "auto" }, ["qwen3-coder:30b"]],
    ["a network model (paid model call)", { target: "network", model: "qwen3:8b" }, []],
  ] as const) {
    it(`${label}: one search before the first turn, billed to the account through the coordinator, sources sent, disclaimer stripped`, async () => {
      const submitted: Array<Record<string, unknown>> = [];
      const searches: Array<Record<string, unknown>> = [];
      const added: Array<Record<string, unknown>> = [];
      const c = await coordinator({ configured: true, canAfford: true, searchesLeftThisHour: 10 }, { submitted, searches, results: RESULTS, answer: "As an AI, I don't have real-time access. The top one is CVE-2026-1 [1]." });
      const res = await chat(portal(c.url, { history: Q, added, ownMachineModels: async () => [...own] }), compute);
      expect(c.seen).toEqual(["status", "search"]);
      // The same web tool call as a model's search: the account is named, the query is the question.
      expect(searches[0]).toMatchObject({ query: Q, count: 5, accountId: expect.any(String) });
      // The first model call already has the results, as its own tool call and result.
      const msgs = submitted[0].messages as Array<{ role: string; content: string; tool_calls?: unknown[] }>;
      expect(msgs[0].content).toContain("You have live web access");
      expect(msgs.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ function: { name: "web_search" } }] });
      expect(msgs.at(-1)).toMatchObject({ role: "tool" });
      expect(msgs.at(-1)!.content).toContain("[1] CISA KEV");
      expect(res.body).toContain('"status":"Searching the web…"');
      expect(res.body).toContain('"url":"https://cisa.example/kev"');
      expect(res.body).not.toContain("real-time access");
      const stored = added.find((m) => m.role === "assistant")!;
      expect(stored.content).toMatch(/^The top one is CVE-2026-1 \[1\]\./);
      expect(stored.content).toContain("https://cisa.example/kev");
      // The search's 0.5 cSats is in what the reply cost.
      expect(stored.creditsSpent).toBeGreaterThanOrEqual(0.5);
    });
  }

  it("a coding question isn't searched", async () => {
    const c = await coordinator({ configured: true, canAfford: true, searchesLeftThisHour: 10 }, { results: RESULTS, answer: "Use a loop." });
    await chat(portal(c.url, { history: "How do I reverse a linked list in Python?", ownMachineModels: async () => ["qwen3-coder:30b"] }), { target: "auto" });
    expect(c.seen).toEqual(["status"]);
  });
});
