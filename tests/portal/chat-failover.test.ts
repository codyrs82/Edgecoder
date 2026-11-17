import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatCapacityDirectory } from "../../src/portal/chat-capacity.js";
import { coordinatorUrlAllowed, coordinatorUrlPolicyFromEnv } from "../../src/portal/coordinator-url-policy.js";
import { CHAT_MAX_COORDINATOR_ATTEMPTS, NO_COMPUTE_BODY, registerChatApiRoutes, sseDataLines } from "../../src/portal/routes/chat.js";

// #39: /portal/api/chat runs on a coordinator that has capacity and fails over once, before any token.

type ChatMode = "ok" | "no_models" | "bad_request" | "empty" | "drop_after_first" | "hang" | "slow";
interface Behaviour {
  /** The coordinator's own model server, as /health/runtime reports it. "hang" never answers. */
  ownModels?: number | "hang";
  chat?: ChatMode;
  /** Models connected agents can run, as /inference/models lists them. */
  agentModels?: string[];
  /** What /inference/submit answers; "ok" accepts the job. */
  submit?: "ok" | { status: number; error: string };
  /** What /inference/submit answers for target "mine" (your own machines); default as submit. */
  submitMine?: "ok" | { status: number; error: string };
  /** "slow" chat: ms before the first token. */
  delayMs?: number;
  /** Status of /inference/stream. */
  streamStatus?: number;
  name?: string;
}

const servers: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A coordinator that answers like the real one on the routes a chat uses, and notes every call. */
async function coordinator(b: Behaviour = {}) {
  const name = b.name ?? "co";
  const seen: Array<{ path: string; token: unknown; body?: any }> = [];
  const co = Fastify({ forceCloseConnections: true });
  const note = (req: any) => seen.push({ path: req.url, token: req.headers["x-portal-service-token"], body: req.body });
  co.get("/health/runtime", async (req) => {
    note(req);
    if (b.ownModels === "hang") return new Promise(() => undefined);
    const n = b.ownModels ?? 0;
    return { ok: true, ollama: n > 0 ? { reachable: true, modelCount: n } : { reachable: false, modelCount: 0, error: "connect ECONNREFUSED 127.0.0.1:11434" } };
  });
  co.post("/portal/chat", async (req, reply) => {
    note(req);
    const mode = b.chat ?? "ok";
    if (mode === "no_models") return reply.code(502).send({ error: "no_models_available" });
    if (mode === "bad_request") return reply.code(400).send({ error: "invalid_chat" });
    if (mode === "hang") return new Promise(() => undefined);
    if (mode === "slow") await new Promise((r) => setTimeout(r, b.delayMs ?? 300));
    reply.raw.writeHead(200, { "content-type": "text/event-stream" });
    if (mode === "empty") {
      reply.raw.end("data: [DONE]\n\n");
      return reply;
    }
    reply.raw.write(`data: ${JSON.stringify({ content: `${name}-1 ` })}\n\n`);
    if (mode === "drop_after_first") {
      setTimeout(() => reply.raw.destroy(), 20);
      return reply;
    }
    reply.raw.end(`data: ${JSON.stringify({ content: `${name}-2` })}\n\ndata: [DONE]\n\n`);
    return reply;
  });
  co.get("/inference/models", async (req) => (note(req), { models: (b.agentModels ?? []).map((model) => ({ model, agents: 1, classes: ["gpu"] })) }));
  co.post("/inference/submit", async (req, reply) => {
    note(req);
    const s = ((req.body as { target?: string } | undefined)?.target === "mine" ? b.submitMine : undefined) ?? b.submit ?? "ok";
    return s === "ok" ? { subtaskId: "sub-1" } : reply.code(s.status).send({ error: s.error, neededCSats: 9 });
  });
  co.post("/inference/stream", async (req, reply) => {
    note(req);
    if (b.streamStatus) return reply.code(b.streamStatus).send({ error: "agent_lost" });
    return { chunks: [`${name}-net`], next: 1, done: true, creditsSpent: 0.5 };
  });
  await co.listen({ port: 0, host: "127.0.0.1" });
  servers.push(co);
  const url = `http://127.0.0.1:${(co.server.address() as { port: number }).port}`;
  const paths = (p: string) => seen.filter((s) => s.path === p);
  return { url, seen, paths, behaviour: b, close: () => co.close() };
}

/** The portal's chat route over the given coordinators, in priority order. */
function portal(
  urls: string[],
  opts: { allowed?: (u: string) => boolean; timeoutMs?: number; own?: boolean; ownModels?: string[]; keepalive?: { graceMs: number; intervalMs: number }; lastMessage?: { role: "user" | "assistant"; content: string } } = {},
) {
  const store = {
    getConversationOwner: vi.fn(async () => "u1"),
    addMessage: vi.fn(async (_m: { role: string; content: string }) => undefined),
    getConversationMessages: vi.fn(async () => [opts.lastMessage ?? { role: "user" as const, content: "hi" }]),
  };
  const app = Fastify();
  const chatCapacity = opts.own
    ? undefined
    : createChatCapacityDirectory({ candidates: async () => urls, allowed: opts.allowed ?? (() => true), serviceToken: "svc", timeoutMs: opts.timeoutMs ?? 500 });
  registerChatApiRoutes(app, {
    store,
    getCurrentUser: async () => ({ userId: "u1" }),
    PORTAL_SERVICE_TOKEN: "svc",
    discoverCoordinatorUrlsForPortal: async () => urls,
    chatCapacity,
    ...(opts.ownModels ? { ownMachineModels: async () => opts.ownModels } : {}),
    chatKeepalive: opts.keepalive ?? { graceMs: 60_000, intervalMs: 60_000 },
  } as never);
  servers.push(app);
  const chat = (extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/portal/api/chat", payload: { conversationId: "c1", message: "hi", ...extra } });
  const saved = () => store.addMessage.mock.calls.map(([m]) => m).filter((m) => m.role === "assistant").map((m) => m.content);
  const savedUser = () => store.addMessage.mock.calls.map(([m]) => m).filter((m) => m.role === "user").map((m) => m.content);
  return { app, chat, saved, savedUser };
}

/** The JSON events of an SSE answer. */
const events = (body: string) => body.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]").map((l) => JSON.parse(l.slice(6)));
const text = (body: string) => events(body).map((e) => e.content ?? "").join("");
const network = (model = "m") => ({ compute: { target: "network", model } });

describe("default chat picks a coordinator with a model", () => {
  it("skips the coordinator-only primary and answers from the one that runs a model", async () => {
    const us = await coordinator({ name: "us", ownModels: 0, chat: "no_models" });
    const eu = await coordinator({ name: "eu", ownModels: 1 });
    const p = portal([us.url, eu.url]);
    const res = await p.chat({ model: "qwen3.5:4b" });
    expect(res.statusCode).toBe(200);
    expect(text(res.body)).toBe("eu-1 eu-2");
    expect(res.body.endsWith("data: [DONE]\n\n")).toBe(true);
    expect(us.paths("/portal/chat")).toHaveLength(0);
    expect(eu.paths("/portal/chat")).toEqual([{ path: "/portal/chat", token: "svc", body: { messages: [{ role: "user", content: "hi" }], model: "qwen3.5:4b" } }]);
    expect(p.saved()).toEqual(["eu-1 eu-2"]);
  });

  it("uses the primary when it has a model, and asks about capacity once for several chats", async () => {
    const us = await coordinator({ name: "us", ownModels: 2 });
    const eu = await coordinator({ name: "eu", ownModels: 1 });
    const p = portal([us.url, eu.url]);
    for (let i = 0; i < 3; i++) expect(text((await p.chat()).body)).toBe("us-1 us-2");
    expect(eu.paths("/portal/chat")).toHaveLength(0);
    expect(us.paths("/health/runtime")).toHaveLength(1);
    // The capacity question carries no credential: /health/runtime is public.
    expect(us.paths("/health/runtime")[0].token).toBeUndefined();
  });

  it("works without an injected directory (the discovered list is the candidate list)", async () => {
    const us = await coordinator({ name: "us", ownModels: 0 });
    const eu = await coordinator({ name: "eu", ownModels: 1 });
    expect(text((await portal([us.url, eu.url], { own: true }).chat()).body)).toBe("eu-1 eu-2");
  });
});

describe("default chat fails over before any token", () => {
  it("retries on the next coordinator when the chosen one has no model after all", async () => {
    const us = await coordinator({ name: "us", ownModels: 1, chat: "no_models" });
    const eu = await coordinator({ name: "eu", ownModels: 1 });
    const p = portal([us.url, eu.url]);
    const res = await p.chat();
    expect(res.statusCode).toBe(200);
    expect(text(res.body)).toBe("eu-1 eu-2");
    expect(us.paths("/portal/chat")).toHaveLength(1);
    // The next chat goes straight to the one that worked.
    expect(text((await p.chat()).body)).toBe("eu-1 eu-2");
    expect(us.paths("/portal/chat")).toHaveLength(1);
  });

  it("retries when the chosen coordinator went away after the capacity check", async () => {
    const us = await coordinator({ name: "us", ownModels: 1 });
    const eu = await coordinator({ name: "eu", ownModels: 1 });
    const p = portal([us.url, eu.url]);
    expect(text((await p.chat()).body)).toBe("us-1 us-2");
    await us.close(); // connection refused from now on; the cached answer still says "yes"
    const res = await p.chat();
    expect(res.statusCode).toBe(200);
    expect(text(res.body)).toBe("eu-1 eu-2");
  });

  it("retries when the stream ends without an event", async () => {
    const us = await coordinator({ name: "us", ownModels: 1, chat: "empty" });
    const eu = await coordinator({ name: "eu", ownModels: 1 });
    expect(text((await portal([us.url, eu.url]).chat()).body)).toBe("eu-1 eu-2");
  });

  it("does not retry once tokens were streamed", async () => {
    const us = await coordinator({ name: "us", ownModels: 1, chat: "drop_after_first" });
    const eu = await coordinator({ name: "eu", ownModels: 1 });
    const p = portal([us.url, eu.url]);
    const res = await p.chat();
    expect(res.statusCode).toBe(200);
    expect(events(res.body)).toEqual([{ content: "us-1 " }, { error: "stream_interrupted" }]);
    expect(eu.paths("/portal/chat")).toHaveLength(0);
    expect(p.saved()).toEqual(["us-1 "]);
  });

  it("does not retry a request the coordinator calls invalid", async () => {
    const us = await coordinator({ name: "us", ownModels: 1, chat: "bad_request" });
    const eu = await coordinator({ name: "eu", ownModels: 1 });
    const res = await portal([us.url, eu.url]).chat();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "all_coordinators_failed", triedCount: 1 });
    expect(eu.paths("/portal/chat")).toHaveLength(0);
  });

  it("tries two coordinators at most", async () => {
    const all = await Promise.all(["a", "b", "c"].map((name) => coordinator({ name, ownModels: 1, chat: "no_models" })));
    const res = await portal(all.map((c) => c.url)).chat();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "all_coordinators_failed", triedCount: CHAT_MAX_COORDINATOR_ATTEMPTS });
    expect(all.map((c) => c.paths("/portal/chat").length)).toEqual([1, 1, 0]);
  });
});

describe("no compute", () => {
  it("answers at once, in words, when no coordinator has a model", async () => {
    const us = await coordinator({ name: "us", ownModels: 0 });
    const eu = await coordinator({ name: "eu", ownModels: 0 });
    const p = portal([us.url, eu.url]);
    const started = Date.now();
    const res = await p.chat();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual(NO_COMPUTE_BODY);
    expect(res.json().error).toMatch(/^No compute is available right now/);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect([...us.paths("/portal/chat"), ...eu.paths("/portal/chat")]).toHaveLength(0);
    // The user's message is kept; no assistant message is invented.
    expect(p.saved()).toEqual([]);
  });

  it("does not hang on coordinators that do not answer the capacity check", async () => {
    const us = await coordinator({ name: "us", ownModels: "hang" });
    const down = await coordinator({ name: "down" });
    await down.close();
    const started = Date.now();
    const res = await portal([us.url, down.url], { timeoutMs: 200 }).chat();
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("no_compute_available");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(us.paths("/portal/chat")).toHaveLength(0);
  });

  it("keeps 'no coordinator configured' apart from 'no compute'", async () => {
    const res = await portal([]).chat();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "no_coordinators_available" });
  });
});

describe("coordinator URL policy", () => {
  it("never contacts a coordinator the policy refuses, with or without the service token", async () => {
    const rogue = await coordinator({ name: "rogue", ownModels: 5, agentModels: ["m"] });
    const eu = await coordinator({ name: "eu", ownModels: 1, agentModels: ["m"] });
    const p = portal([rogue.url, eu.url], { allowed: (u) => u !== rogue.url });
    expect(text((await p.chat()).body)).toBe("eu-1 eu-2");
    expect(text((await p.chat(network())).body)).toBe("eu-net");
    expect(rogue.seen).toEqual([]);
  });

  it("under the production policy a discovered loopback or plain-http URL gets no request", async () => {
    const local = await coordinator({ name: "local", ownModels: 1, agentModels: ["m"] });
    const policy = coordinatorUrlPolicyFromEnv({ NODE_ENV: "production" }, ["https://seed.example.com"]);
    const p = portal([local.url, "http://seed.example.com", "https://169.254.169.254"], { allowed: (u) => coordinatorUrlAllowed(u, policy) });
    const res = await p.chat();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "no_coordinators_available" });
    expect((await p.chat(network())).statusCode).toBe(502);
    expect(local.seen).toEqual([]);
  });
});

describe("network chat picks and fails over", () => {
  it("runs on the coordinator whose agents have the model", async () => {
    const us = await coordinator({ name: "us", agentModels: [] });
    const eu = await coordinator({ name: "eu", agentModels: ["m"] });
    const res = await portal([us.url, eu.url]).chat(network());
    expect(res.statusCode).toBe(200);
    expect(events(res.body)).toEqual([{ content: "eu-net" }, { done: true, compute: "Network · m", cSatsSpent: 0.5 }]);
    expect(us.paths("/inference/submit")).toHaveLength(0);
    expect(eu.paths("/inference/submit")[0]).toMatchObject({ token: "svc", body: { model: "m", submitterAccountId: "acct-u1" } });
    // Submit and stream of one chat go to the same coordinator.
    expect(eu.paths("/inference/stream")).toHaveLength(1);
    expect(us.paths("/inference/stream")).toHaveLength(0);
  });

  it("retries on the next coordinator when the first turns the job down", async () => {
    const us = await coordinator({ name: "us", agentModels: ["m"], submit: { status: 409, error: "no_agent_has_model" } });
    const eu = await coordinator({ name: "eu", agentModels: ["m"] });
    const res = await portal([us.url, eu.url]).chat(network());
    expect(res.statusCode).toBe(200);
    expect(text(res.body)).toBe("eu-net");
    expect(us.paths("/inference/submit")).toHaveLength(1);
  });

  it("retries when the first coordinator cannot be reached for the submit", async () => {
    const us = await coordinator({ name: "us", agentModels: ["m"] });
    const eu = await coordinator({ name: "eu", agentModels: ["m"] });
    const p = portal([us.url, eu.url]);
    expect(text((await p.chat(network())).body)).toBe("us-net");
    await us.close();
    expect(text((await p.chat(network())).body)).toBe("eu-net");
  });

  it("does not resubmit a job a coordinator accepted (it could bill twice)", async () => {
    const us = await coordinator({ name: "us", agentModels: ["m"], streamStatus: 500 });
    const eu = await coordinator({ name: "eu", agentModels: ["m"] });
    const res = await portal([us.url, eu.url]).chat(network());
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "Network stream failed: agent_lost", compute: "Network · m" });
    expect(eu.paths("/inference/submit")).toHaveLength(0);
  });

  it("does not look elsewhere when the account is short of cSats", async () => {
    const us = await coordinator({ name: "us", agentModels: ["m"], submit: { status: 402, error: "insufficient_credits" } });
    const eu = await coordinator({ name: "eu", agentModels: ["m"] });
    const res = await portal([us.url, eu.url]).chat(network());
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toMatch(/Not enough cSats/);
    expect(eu.paths("/inference/submit")).toHaveLength(0);
  });

  it("returns the first coordinator's refusal when no coordinator has a machine for the model", async () => {
    const us = await coordinator({ name: "us", agentModels: [], submit: { status: 409, error: "no_agent_has_model" } });
    const eu = await coordinator({ name: "eu", agentModels: ["other"], submit: { status: 409, error: "no_own_agent_has_model" } });
    const res = await portal([us.url, eu.url]).chat(network());
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "No machine on the network has m right now.", compute: "Network · m" });
    expect([us.paths("/inference/submit").length, eu.paths("/inference/submit").length]).toEqual([1, 1]);
  });

  it("says no compute is available when no coordinator answers", async () => {
    const us = await coordinator({ name: "us" });
    const eu = await coordinator({ name: "eu" });
    await Promise.all([us.close(), eu.close()]);
    const started = Date.now();
    const res = await portal([us.url, eu.url]).chat(network());
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ...NO_COMPUTE_BODY, compute: "Network · m" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("sseDataLines", () => {
  async function collect(chunks: Array<string | Buffer>) {
    const out: string[] = [];
    for await (const l of sseDataLines((async function* () { yield* chunks; })())) out.push(l);
    return out;
  }

  it("yields each data payload whatever the chunk boundaries", async () => {
    expect(await collect(['data: {"a":1}\n\ndata: {"b":2}\n\n', "data: [DONE]\n\n"])).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
    expect(await collect(['da', 'ta: {"a"', ':1}\n', '\ndata: {"b":2}'])).toEqual(['{"a":1}', '{"b":2}']);
    expect(await collect([Buffer.from('data: {"c":"é"}\r\n\r\n')])).toEqual(['{"c":"é"}']);
    const bytes = Buffer.from('data: {"c":"日本"}\n\n');
    expect(await collect([bytes.subarray(0, 13), bytes.subarray(13)])).toEqual(['{"c":"日本"}']);
    expect(await collect([])).toEqual([]);
  });
});

describe("Auto (the page's default) asks the network's best fit", () => {
  const auto = { compute: { target: "auto" } };

  it("sends model auto to the coordinator with room and streams its answer", async () => {
    const us = await coordinator({ name: "us", agentModels: ["m"], ownModels: 1 });
    const res = await portal([us.url]).chat(auto);
    expect(res.statusCode).toBe(200);
    expect(events(res.body)).toEqual([{ content: "us-net" }, { done: true, compute: "Network · best fit", cSatsSpent: 0.5 }]);
    expect(us.paths("/inference/submit")[0]).toMatchObject({ body: { model: "auto", submitterAccountId: "acct-u1" } });
    expect(us.paths("/portal/chat")).toHaveLength(0);
  });

  it("says out of cSats (no slow free fallback) when the network turns it down for cSats", async () => {
    const us = await coordinator({ name: "us", agentModels: ["m"], ownModels: 1, submit: { status: 402, error: "insufficient_credits" } });
    const p = portal([us.url]);
    const res = await p.chat(auto);
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ code: "out_of_csats", compute: "Network · best fit" });
    expect(res.json().error).toMatch(/Not enough cSats/);
    expect(us.paths("/portal/chat")).toHaveLength(0);
    expect(p.saved()).toEqual([]);
  });

  it("runs on your own online machines first, free, before the network", async () => {
    const us = await coordinator({ name: "us", agentModels: ["mine-m"], submit: { status: 402, error: "insufficient_credits" }, submitMine: "ok" });
    const res = await portal([us.url], { ownModels: ["mine-m"] }).chat(auto);
    expect(res.statusCode).toBe(200);
    expect(events(res.body)).toEqual([{ content: "us-net" }, { done: true, compute: "My machines · mine-m", cSatsSpent: 0.5 }]);
    expect(us.paths("/inference/submit")).toHaveLength(1);
    expect(us.paths("/inference/submit")[0]).toMatchObject({ body: { model: "mine-m", target: "mine" } });
  });

  it("goes on to the network when your own machines turn it down", async () => {
    const us = await coordinator({ name: "us", agentModels: ["mine-m"], submitMine: { status: 409, error: "no_own_agent_has_model" } });
    const res = await portal([us.url], { ownModels: ["mine-m"] }).chat(auto);
    expect(res.statusCode).toBe(200);
    expect(events(res.body).at(-1)).toMatchObject({ done: true, compute: "Network · best fit" });
    expect(us.paths("/inference/submit")[0]).toMatchObject({ body: { model: "mine-m", target: "mine" } });
    expect(us.paths("/inference/submit").at(-1)).toMatchObject({ body: { model: "auto" } });
  });

  it("falls back to the coordinator's own chat (free) when no route fits", async () => {
    const us = await coordinator({ name: "us", agentModels: ["m"], ownModels: 1, submit: { status: 409, error: "no_route_fits" } });
    const p = portal([us.url]);
    const res = await p.chat(auto);
    expect(res.statusCode).toBe(200);
    expect(text(res.body)).toBe("us-1 us-2");
    expect(us.paths("/portal/chat")).toHaveLength(1);
    expect(p.saved()).toEqual(["us-1 us-2"]);
  });
});

describe("a slow first token keeps the browser's request alive (iOS Safari 'Load failed')", () => {
  const auto = { compute: { target: "auto" } };

  it("sends the SSE head and heartbeats while the coordinator's own model is still thinking", async () => {
    const us = await coordinator({ name: "us", agentModels: ["m"], ownModels: 1, chat: "slow", delayMs: 300, submit: { status: 409, error: "no_route_fits" } });
    const res = await portal([us.url], { keepalive: { graceMs: 20, intervalMs: 50 } }).chat(auto);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.body.indexOf(": keepalive")).toBeGreaterThanOrEqual(0);
    expect(res.body.match(/: keepalive/g)!.length).toBeGreaterThan(1);
    expect(res.body.indexOf(": keepalive")).toBeLessThan(res.body.indexOf('"content"'));
    expect(events(res.body)[0]).toEqual({ status: "Answering with EdgeCoder's own model (free, slower)..." });
    expect(text(res.body)).toBe("us-1 us-2");
  });

  it("a failure after the head went out is an error event, not a broken stream", async () => {
    // Both coordinators fail after the head went out: the browser gets the failure as an event.
    const us = await coordinator({ name: "us", ownModels: 1, chat: "no_models" });
    const eu = await coordinator({ name: "eu", ownModels: 1, chat: "no_models" });
    const res = await portal([us.url, eu.url], { keepalive: { graceMs: 0, intervalMs: 1_000 } }).chat();
    expect(res.statusCode).toBe(200);
    expect(events(res.body)).toEqual([{ error: "all_coordinators_failed", triedCount: 2, httpStatus: 502 }]);
    expect(res.body.trimEnd().endsWith("data: [DONE]")).toBe(true);
  });

  it("a refusal inside the grace keeps its HTTP status", async () => {
    const us = await coordinator({ name: "us", agentModels: ["m"], submit: { status: 402, error: "insufficient_credits" } });
    const res = await portal([us.url], { keepalive: { graceMs: 5_000, intervalMs: 5_000 } }).chat(auto);
    expect(res.statusCode).toBe(402);
    expect(res.headers["content-type"]).toMatch(/json/);
  });
});

describe("Retry (resend)", () => {
  it("does not save the same message twice", async () => {
    const us = await coordinator({ name: "us", ownModels: 1 });
    const p = portal([us.url], { lastMessage: { role: "user", content: "hi" } });
    await p.chat({ resend: true });
    expect(p.savedUser()).toEqual([]);
    await p.chat();
    expect(p.savedUser()).toEqual(["hi"]);
  });
});
