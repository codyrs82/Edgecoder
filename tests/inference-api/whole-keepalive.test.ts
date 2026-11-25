import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESTARTING_MESSAGE, drainOpenRequests, type CallOutcome, openRequestCount, registerCompatRoutes, wholeKeepaliveFromEnv, WHOLE_KEEPALIVE_AFTER_MS, WHOLE_KEEPALIVE_EVERY_MS } from "../../src/inference-api/routes.js";
import { ChatBackendError, type ChatBackend } from "../../src/inference-api/types.js";

/*
 * D2 (network test 3b): a non-streamed hosted call that took 125.6 s got Cloudflare's 524 (100 s
 * to the first byte). Past 20 s the reply commits 200 + JSON and sends whitespace every 15 s.
 */

/** A backend that answers (or fails) when the test says so. */
function controlled() {
  let settle!: (v: { text?: string; err?: Error }) => void;
  const gate = new Promise<{ text?: string; err?: Error }>((r) => (settle = r));
  const backend: ChatBackend = async function* () {
    const v = await gate;
    if (v.err) throw v.err;
    yield { delta: v.text ?? "" };
    yield { done: true, stopReason: "stop" } as never;
  };
  return { backend, answer: (text: string) => settle({ text }), fail: (err: Error) => settle({ err }) };
}

const make = (backend: ChatBackend) => {
  const app = Fastify();
  registerCompatRoutes(app, {
    authenticate: async () => ({}),
    models: async () => [],
    resolve: async () => ({ backend, model: "m1" }),
    wholeKeepalive: { afterMs: WHOLE_KEEPALIVE_AFTER_MS, everyMs: WHOLE_KEEPALIVE_EVERY_MS },
  });
  return app;
};
/** Let the request reach the backend (inject runs on real setImmediate ticks, which are not faked). */
async function started() {
  for (let i = 0; i < 500 && openRequestCount() < 1; i++) await new Promise((r) => setImmediate(r));
  expect(openRequestCount()).toBe(1);
}
const openai = { method: "POST" as const, url: "/v1/chat/completions", headers: { authorization: "Bearer k" }, payload: { messages: [{ role: "user", content: "x" }] } };
const anthropic = { method: "POST" as const, url: "/v1/messages", headers: { "x-api-key": "k" }, payload: { messages: [{ role: "user", content: "x" }] } };

describe("non-streamed keepalive (hosted, Cloudflare 100 s)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a 125 s call commits 200 JSON at 20 s, sends a space every 15 s, then the answer", async () => {
    const c = controlled();
    const pending = make(c.backend).inject(openai);
    await started();
    await vi.advanceTimersByTimeAsync(125_000);
    c.answer("hello");
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    const lead = res.body.length - res.body.trimStart().length;
    // One at 20 s, then 35, 50, ... 125 s.
    expect(lead).toBe(1 + Math.floor((125_000 - 20_000) / 15_000));
    expect(res.body.slice(0, lead).trim()).toBe("");
    const json = JSON.parse(res.body);
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("hello");
  });

  it("a call that fails after the commit ends with the OpenAI error object (status stays 200, no Retry-After)", async () => {
    const c = controlled();
    const pending = make(c.backend).inject(openai);
    await started();
    await vi.advanceTimersByTimeAsync(30_000);
    c.fail(new ChatBackendError("Every machine is busy", 503, 15));
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.headers["retry-after"]).toBeUndefined();
    expect(JSON.parse(res.body)).toEqual({ error: { message: "Every machine is busy", type: "no_capacity", code: 503 } });
  });

  it("an upstream 502 after the commit is reported as upstream_error 503 in the body", async () => {
    const c = controlled();
    const pending = make(c.backend).inject(openai);
    await started();
    await vi.advanceTimersByTimeAsync(21_000);
    c.fail(new ChatBackendError("agent reported: empty_reply", 502));
    const res = await pending;
    expect(JSON.parse(res.body).error).toMatchObject({ type: "upstream_error", code: 503 });
  });

  it("Anthropic format: the error body is Anthropic's error object", async () => {
    const c = controlled();
    const pending = make(c.backend).inject(anthropic);
    await started();
    await vi.advanceTimersByTimeAsync(40_000);
    c.fail(new ChatBackendError("Every machine is busy", 503, 15));
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ type: "error", error: { type: "overloaded_error", message: "Every machine is busy" } });
  });

  it("a call that fails before the commit keeps its 503 + Retry-After", async () => {
    const c = controlled();
    const pending = make(c.backend).inject(openai);
    await started();
    await vi.advanceTimersByTimeAsync(5_000);
    c.fail(new ChatBackendError("Every machine is busy", 503, 15));
    const res = await pending;
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("15");
    // And no keepalive fires later on the finished reply.
    await vi.advanceTimersByTimeAsync(60_000);
  });

  it("a server stop after the commit ends the body with server_restarting", async () => {
    const c = controlled();
    const pending = make(c.backend).inject(openai);
    await started();
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await drainOpenRequests(0)).toBe(1);
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).error).toMatchObject({ type: "server_restarting", code: 503, message: RESTARTING_MESSAGE });
    c.answer("late");
  });

  it("a fast call gets a plain body with no leading whitespace", async () => {
    const c = controlled();
    const pending = make(c.backend).inject(openai);
    await started();
    await vi.advanceTimersByTimeAsync(1_000);
    c.answer("quick");
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.body.startsWith("{")).toBe(true);
  });

  it("streamed calls are unaffected (SSE keepalive instead)", async () => {
    const c = controlled();
    const pending = make(c.backend).inject({ ...openai, payload: { ...openai.payload, stream: true } });
    await started();
    await vi.advanceTimersByTimeAsync(25_000);
    c.answer("s");
    const res = await pending;
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.body.startsWith(" ")).toBe(false);
  });
});

describe("wholeKeepaliveFromEnv", () => {
  it("defaults to 20 s / 15 s, 0 turns it off, values are clamped", () => {
    expect(wholeKeepaliveFromEnv({})).toEqual({ afterMs: 20_000, everyMs: 15_000 });
    expect(wholeKeepaliveFromEnv({ PORTAL_NONSTREAM_KEEPALIVE_AFTER_MS: "0" })).toBeNull();
    expect(wholeKeepaliveFromEnv({ PORTAL_NONSTREAM_KEEPALIVE_AFTER_MS: "5000", PORTAL_NONSTREAM_KEEPALIVE_MS: "10" })).toEqual({ afterMs: 5_000, everyMs: 1_000 });
    expect(wholeKeepaliveFromEnv({ PORTAL_NONSTREAM_KEEPALIVE_AFTER_MS: "junk" })).toEqual({ afterMs: 20_000, everyMs: 15_000 });
  });
});

/*
 * Run 5: a non-streamed hosted call (inf-1795599027496-de8dd861) had its connection terminated at
 * 50 s with no answer, and the logs had rotated. Each call now reports how it ended (onCallDone):
 * status, early commit, timing, who closed it and the backend's error class and code, with no prompt,
 * reply or error message.
 */
describe("how a call ended (per-call log line)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const withLog = (backend: ChatBackend) => {
    const outcomes: CallOutcome[] = [];
    const app = Fastify();
    registerCompatRoutes(app, {
      authenticate: async () => ({ who: "acct-1" }),
      models: async () => [],
      resolve: async () => ({ backend, model: "m1" }),
      wholeKeepalive: { afterMs: WHOLE_KEEPALIVE_AFTER_MS, everyMs: WHOLE_KEEPALIVE_EVERY_MS },
      onCallDone: (ctx, o) => {
        expect(ctx).toEqual({ who: "acct-1" });
        outcomes.push(o);
      },
    });
    return { app, outcomes };
  };

  it("a busy refusal after the early commit: 200, committed early, ended by the server, the error's class and status", async () => {
    const c = controlled();
    const { app, outcomes } = withLog(c.backend);
    const pending = app.inject(openai);
    await started();
    await vi.advanceTimersByTimeAsync(45_600);
    c.fail(new ChatBackendError("Every machine that runs m1 is busy and none could start this request in time.", 503, 15));
    await pending;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ format: "openai", stream: false, status: 200, committedEarly: true, closedBy: "server", error: { status: 503, type: "ChatBackendError" } });
    expect(outcomes[0].elapsedMs).toBeGreaterThanOrEqual(45_600);
    expect(outcomes[0].firstPieceMs).toBeGreaterThanOrEqual(45_600);
    // Spaces at 20, 35 s and the error body.
    expect(outcomes[0].bytes).toBeGreaterThan(2);
    expect(JSON.stringify(outcomes[0])).not.toContain("busy");
  });

  it("an answer before the commit: the status, no error, ended by the server", async () => {
    const c = controlled();
    const { app, outcomes } = withLog(c.backend);
    const pending = app.inject(openai);
    await started();
    c.answer("hi");
    expect((await pending).statusCode).toBe(200);
    expect(outcomes[0]).toMatchObject({ status: 200, committedEarly: false, closedBy: "server", firstPieceMs: expect.any(Number) });
    expect(outcomes[0].error).toBeUndefined();
  });

  it("a refusal before the commit keeps its HTTP status", async () => {
    const c = controlled();
    const { app, outcomes } = withLog(c.backend);
    const pending = app.inject(openai);
    await started();
    c.fail(new ChatBackendError("no", 402));
    expect((await pending).statusCode).toBe(402);
    expect(outcomes[0]).toMatchObject({ status: 402, closedBy: "server", error: { status: 402 } });
  });
});

describe("a connection closed under the reply", () => {
  it("is recorded as closed by the client (or a proxy), with when it closed", async () => {
    const outcomes: CallOutcome[] = [];
    // Runs until the request is aborted (the connection closed).
    const backend: ChatBackend = async function* (_req, signal) {
      await new Promise<void>((r) => signal?.addEventListener("abort", () => r(), { once: true }));
      throw new ChatBackendError("aborted", 499);
    };
    const app = Fastify();
    registerCompatRoutes(app, {
      authenticate: async () => ({}),
      models: async () => [],
      resolve: async () => ({ backend, model: "m1" }),
      wholeKeepalive: { afterMs: 20, everyMs: 1_000 },
      onCallDone: (_ctx, o) => void outcomes.push(o),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { port } = app.server.address() as { port: number };
      const http = await import("node:http");
      await new Promise<void>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions", headers: { authorization: "Bearer k", "content-type": "application/json" } }, (res) => {
          // The 200 head and the first space arrived (committed early): now the connection is cut.
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        });
        req.on("error", () => undefined);
        req.end(JSON.stringify({ messages: [{ role: "user", content: "x" }], stream: false }));
      });
      for (let i = 0; i < 200 && outcomes.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ status: 200, committedEarly: true, closedBy: "client", closedAtMs: expect.any(Number) });
    } finally {
      await app.close();
    }
  });
});
