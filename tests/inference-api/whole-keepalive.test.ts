import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESTARTING_MESSAGE, drainOpenRequests, openRequestCount, registerCompatRoutes, wholeKeepaliveFromEnv, WHOLE_KEEPALIVE_AFTER_MS, WHOLE_KEEPALIVE_EVERY_MS } from "../../src/inference-api/routes.js";
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
