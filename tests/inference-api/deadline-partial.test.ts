import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEADLINE_PARTIAL_NOTE, openRequestCount, registerCompatRoutes, untilDeadline, WHOLE_KEEPALIVE_AFTER_MS, WHOLE_KEEPALIVE_EVERY_MS } from "../../src/inference-api/routes.js";
import { networkBackend } from "../../src/inference-api/backends.js";
import type { NetworkDeps } from "../../src/apps/ide/network-inference.js";
import { ChatBackendError, DEADLINE_ERROR_CODE, type ChatBackend, type ChatPiece } from "../../src/inference-api/types.js";

/*
 * Run 4: non-streamed calls that reached the 180 s deadline after part of the reply had arrived ended
 * as HTTP 200 with only an error body ("timed out after 180 s"), while the host was paid for that
 * part (#544). Now the part is returned as a reply cut at the limit: OpenAI finish_reason "length",
 * Anthropic stop_reason "max_tokens", with a note. Only with real content; streams are unchanged.
 */

const deadline = () => new ChatBackendError("The machine running m1 reported: timed out after 180 s", 502, undefined, { code: DEADLINE_ERROR_CODE });

/** Pieces, then (when the test says) the deadline error. */
function cutAt(pieces: ChatPiece[], err: () => Error = deadline) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const backend: ChatBackend = async function* () {
    for (const p of pieces) yield p;
    await gate;
    throw err();
  };
  return { backend, release: () => release() };
}

const make = (backend: ChatBackend, keepalive = true) => {
  const app = Fastify();
  registerCompatRoutes(app, {
    authenticate: async () => ({}),
    models: async () => [],
    resolve: async () => ({ backend, model: "m1" }),
    ...(keepalive ? { wholeKeepalive: { afterMs: WHOLE_KEEPALIVE_AFTER_MS, everyMs: WHOLE_KEEPALIVE_EVERY_MS } } : {}),
  });
  return app;
};
async function started() {
  for (let i = 0; i < 500 && openRequestCount() < 1; i++) await new Promise((r) => setImmediate(r));
  expect(openRequestCount()).toBe(1);
}
const openai = (stream = false) => ({ method: "POST" as const, url: "/v1/chat/completions", headers: { authorization: "Bearer k" }, payload: { messages: [{ role: "user", content: "x" }], stream } });
const anthropic = { method: "POST" as const, url: "/v1/messages", headers: { "x-api-key": "k" }, payload: { messages: [{ role: "user", content: "x" }] } };

async function collect(it: AsyncIterable<ChatPiece>): Promise<ChatPiece[]> {
  const out: ChatPiece[] = [];
  for await (const p of it) out.push(p);
  return out;
}

describe("untilDeadline", () => {
  it("ends pieces cut by a deadline after real content as a reply cut at the limit", async () => {
    const pieces = await collect(untilDeadline((async function* () {
      yield { delta: "def f():" } as ChatPiece;
      throw deadline();
    })()));
    expect(pieces).toEqual([{ delta: "def f():" }, { done: true, stopReason: "length", note: DEADLINE_PARTIAL_NOTE }]);
  });

  it("passes on a deadline with nothing real sent, and every other error", async () => {
    await expect(collect(untilDeadline((async function* () {
      yield { delta: "  \n" } as ChatPiece;
      throw deadline();
    })()))).rejects.toThrow(/timed out after 180 s/);
    await expect(collect(untilDeadline((async function* () {
      yield { delta: "partial" } as ChatPiece;
      throw new ChatBackendError("The machine running m1 reported: agent_lost_mid_reply: ...", 502);
    })()))).rejects.toThrow(/agent_lost_mid_reply/);
  });

  it("a network backend marks the agent's deadline error, and only it", async () => {
    const ended = (error: string) => {
      const deps: NetworkDeps = {
        forwarder: "",
        token: () => "",
        agentId: "acct-1",
        transport: async (_m, path) => (path === "/inference/submit" ? { status: 200, json: { taskId: "t", subtaskId: "s" } } : { status: 200, json: { chunks: ["part"], next: 1, done: true, error } }),
      };
      return collect(networkBackend(deps, { model: "m1", computeClass: "any" })({ messages: [{ role: "user", content: "x" }] })).catch((e) => e as ChatBackendError);
    };
    const timedOut = await ended("timed out after 180 s");
    expect(timedOut).toBeInstanceOf(ChatBackendError);
    expect((timedOut as ChatBackendError).info?.code).toBe(DEADLINE_ERROR_CODE);
    const lost = await ended("agent_lost_mid_reply: the machine stopped");
    expect((lost as ChatBackendError).info?.code).toBeUndefined();
    // Through untilDeadline: the part that arrived, cut at the limit.
    const deps: NetworkDeps = {
      forwarder: "",
      token: () => "",
      agentId: "acct-1",
      transport: async (_m, path) => (path === "/inference/submit" ? { status: 200, json: { taskId: "t", subtaskId: "s" } } : { status: 200, json: { chunks: ["part"], next: 1, done: true, error: "timed out after 180 s" } }),
    };
    const out = await collect(untilDeadline(networkBackend(deps, { model: "m1", computeClass: "any" })({ messages: [{ role: "user", content: "x" }] })));
    expect(out).toEqual([{ delta: "part" }, { done: true, stopReason: "length", note: DEADLINE_PARTIAL_NOTE }]);
  });
});

describe("a non-streamed reply cut at its deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("OpenAI: after the keepalive commit, the partial text with finish_reason length and a note", async () => {
    const c = cutAt([{ delta: "Here is " }, { delta: "the start" }]);
    const pending = make(c.backend).inject(openai());
    await started();
    await vi.advanceTimersByTimeAsync(181_000);
    c.release();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.error).toBeUndefined();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0]).toMatchObject({ index: 0, message: { role: "assistant", content: "Here is the start" }, finish_reason: "length" });
    expect(json.usage.completion_tokens).toBeGreaterThan(0);
    expect(json.edgecoder.note).toBe(DEADLINE_PARTIAL_NOTE);
  });

  it("Anthropic: the partial text with stop_reason max_tokens", async () => {
    const c = cutAt([{ delta: "Partial answer" }]);
    const pending = make(c.backend).inject(anthropic);
    await started();
    await vi.advanceTimersByTimeAsync(181_000);
    c.release();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    const json = JSON.parse(res.body);
    expect(json).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "Partial answer" }], stop_reason: "max_tokens" });
    expect(json.edgecoder.note).toBe(DEADLINE_PARTIAL_NOTE);
  });

  it("before the keepalive commit too: a plain 200 completion", async () => {
    const c = cutAt([{ delta: "short" }]);
    const pending = make(c.backend, false).inject(openai());
    await started();
    c.release();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0]).toMatchObject({ message: { content: "short" }, finish_reason: "length" });
  });

  it("no real content: the error as before", async () => {
    const c = cutAt([]);
    const pending = make(c.backend).inject(openai());
    await started();
    await vi.advanceTimersByTimeAsync(181_000);
    c.release();
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).error.message).toContain("timed out after 180 s");
  });

  it("streams are unchanged: the pieces, then the error event", async () => {
    const c = cutAt([{ delta: "streamed" }]);
    const pending = make(c.backend).inject(openai(true));
    await started();
    c.release();
    const res = await pending;
    expect(res.body).toContain('"content":"streamed"');
    expect(res.body).toContain("timed out after 180 s");
    expect(res.body).not.toContain('"finish_reason":"length"');
  });
});
