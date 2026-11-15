import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { InferenceStreams, OUTPUT_TOKEN_ALLOWANCE, PROMPT_TOKEN_ALLOWANCE, boundTokenCounts, maxTokensOf } from "../../src/swarm/inference-streams.js";
import { runInferenceSubtask } from "../../src/swarm/inference-runner.js";
import type { Subtask } from "../../src/common/types.js";

describe("InferenceStreams", () => {
  it("takes nothing after the final piece, and counts the reply's bytes", () => {
    const s = new InferenceStreams();
    s.open("st", "task-1");
    expect(s.taskOf("st")).toBe("task-1");
    expect(s.append("st", 0, "héllo")).toBe("ok");
    expect(s.append("st", 1, "", true)).toBe("ok");
    expect(s.append("st", 2, "more", true)).toBe("closed");
    expect(s.append("st", 1, "", true)).toBe("duplicate");
    expect(s.replyBytes("st")).toBe(6);
  });

  it("bounds reported token counts by the request and reply sizes", () => {
    expect(boundTokenCounts({ promptTokens: 10_000_000, outputTokens: 10_000_000 }, 100, 50)).toEqual({ promptTokens: 100 + PROMPT_TOKEN_ALLOWANCE, outputTokens: 50 + OUTPUT_TOKEN_ALLOWANCE });
    expect(boundTokenCounts({ promptTokens: 12, outputTokens: 3 }, 100, 50)).toEqual({ promptTokens: 12, outputTokens: 3 });
    expect(boundTokenCounts({ outputTokens: 3 }, 100, 50)).toEqual({ promptTokens: undefined, outputTokens: 3 });
    // The call's output cap bounds them too (an agent that streams past the cap is not paid for it).
    expect(boundTokenCounts({ outputTokens: 10_000_000 }, 100, 1_000_000, 4096)).toEqual({ promptTokens: undefined, outputTokens: 4096 + OUTPUT_TOKEN_ALLOWANCE });
    expect(boundTokenCounts({ outputTokens: 10_000_000 }, 100, 50, 4096).outputTokens).toBe(50 + OUTPUT_TOKEN_ALLOWANCE);
    expect(maxTokensOf(JSON.stringify({ messages: [], maxTokens: 512 }))).toBe(512);
    expect(maxTokensOf(JSON.stringify({ messages: [] }))).toBeUndefined();
    expect(maxTokensOf("not json")).toBeUndefined();
  });

  it("applies pieces in order, ignores duplicates, refuses gaps", () => {
    const s = new InferenceStreams();
    s.open("st");
    expect(s.append("st", 0, "Hel")).toBe("ok");
    expect(s.append("st", 0, "Hel")).toBe("duplicate");
    expect(s.append("st", 2, "x")).toBe("gap");
    expect(s.append("st", 1, "lo", true)).toBe("ok");
    expect(s.append("nope", 0, "x")).toBe("unknown");
  });

  // Live probe (2026-11-15): 2 of 120 calls ended 200 with no text but were billed. The agent's
  // result carried the reply; its pieces had not reached the stream (a lost post makes every later
  // piece a gap). The result fills in what the stream is missing before it ends.
  it("backfills text the stream lost from the result, and never rewrites what was sent", async () => {
    const s = new InferenceStreams();
    s.open("lost");
    expect(s.backfill("lost", "Paris")).toBe(true);
    s.finish("lost");
    expect((await s.read("lost", 0, 0))!.chunks.join("")).toBe("Paris");

    s.open("partial");
    s.append("partial", 0, "Par");
    expect(s.append("partial", 2, "s")).toBe("gap");
    expect(s.backfill("partial", "Paris")).toBe(true);
    expect((await s.read("partial", 0, 0))!.chunks).toEqual(["Par", "is"]);

    s.open("complete");
    s.append("complete", 0, "Paris");
    expect(s.backfill("complete", "Paris")).toBe(false);

    // What the requester already has is not a prefix of the result: leave it alone.
    s.open("diverged");
    s.append("diverged", 0, "Lyon");
    expect(s.backfill("diverged", "Paris")).toBe(false);
    expect((await s.read("diverged", 0, 0))!.chunks).toEqual(["Lyon"]);

    s.open("ended");
    s.append("ended", 0, "x", true);
    expect(s.backfill("ended", "xyz")).toBe(false);
  });

  it("a long poll returns as soon as a piece arrives, and at once when there is news", async () => {
    const s = new InferenceStreams();
    s.open("st");
    const t0 = Date.now();
    const waiting = s.read("st", 0, 5_000);
    setTimeout(() => s.append("st", 0, "hi"), 50);
    const r = await waiting;
    expect(r).toEqual({ chunks: ["hi"], next: 1, done: false });
    expect(Date.now() - t0).toBeLessThan(1_000);
    s.append("st", 1, "!", true);
    expect(await s.read("st", 1, 5_000)).toEqual({ chunks: ["!"], next: 2, done: true });
    expect(await s.read("missing", 0, 0)).toBeNull();
  });

  it("an empty final piece does not end the stream, and an empty stream can start again for another agent", () => {
    const s = new InferenceStreams();
    s.open("st", "t");
    expect(s.append("st", 0, "", true)).toBe("ok");
    expect(s.isDone("st")).toBe(false);
    expect(s.hasContent("st")).toBe(false);
    expect(s.reopenIfEmpty("st")).toBe(true);
    expect(s.append("st", 0, "hi")).toBe("ok");
    expect(s.append("st", 1, "", true)).toBe("ok");
    expect(s.isDone("st")).toBe(true);
    // Something reached the requester: never reopened.
    expect(s.reopenIfEmpty("st")).toBe(false);
    // An error ends an empty stream (the failed result decides whether it is retried).
    s.open("e");
    s.append("e", 0, "", true, "boom");
    expect(s.isDone("e")).toBe(true);
    expect(s.reopenIfEmpty("e")).toBe(true);
    expect(s.isDone("e")).toBe(false);
  });

  it("an idle poll times out without leaving listeners behind", async () => {
    const s = new InferenceStreams();
    s.open("st");
    for (let i = 0; i < 20; i++) await s.read("st", 0, 5);
    expect((s as unknown as { events: { listenerCount: (e: string) => number } }).events.listenerCount("st")).toBe(0);
  });
});

describe("runInferenceSubtask", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("streams the model's reply in order and returns it whole", async () => {
    let sentBody: Record<string, unknown> = {};
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        sentBody = JSON.parse(raw);
        for (const w of ["Hello", ", ", "world"]) res.write(JSON.stringify({ message: { content: w } }) + "\n");
        res.end(JSON.stringify({ done: true }) + "\n");
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const posted: Array<{ seq: number; delta: string; done: boolean }> = [];
    const st = {
      id: "s1", taskId: "t1", kind: "inference", language: "python", timeoutMs: 30_000, snapshotRef: "inference",
      requestedModel: "qwen2.5-coder:32b",
      input: JSON.stringify({ messages: [{ role: "user", content: "hi" }], maxTokens: 64 }),
      projectMeta: { projectId: "inference", resourceClass: "gpu", priority: 50 },
    } as unknown as Subtask;
    const r = await runInferenceSubtask(st, { agentId: "a1", ollamaHost: host, post: async (_p, b) => { posted.push(b as never); return {}; } });
    expect(r).toMatchObject({ ok: true, output: "Hello, world", subtaskId: "s1", taskId: "t1", agentId: "a1" });
    expect(sentBody).toMatchObject({ model: "qwen2.5-coder:32b", stream: true, think: false, options: { num_predict: 64 } });
    expect(posted.map((p) => p.delta).join("")).toBe("Hello, world");
    expect(posted.map((p) => p.seq)).toEqual(posted.map((_, i) => i));
    expect(posted.at(-1)?.done).toBe(true);
  });

  it("a lost piece is sent again with the next one, keeping its number (no gap for the rest)", async () => {
    server = createServer((req, res) => {
      req.resume();
      req.on("end", async () => {
        for (const w of ["Hello", ", ", "world"]) {
          res.write(JSON.stringify({ message: { content: w } }) + "\n");
          await new Promise((r) => setTimeout(r, 120)); // past the flush interval: one post per word
        }
        res.end(JSON.stringify({ done: true }) + "\n");
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const accepted: Array<{ seq: number; delta: string; done: boolean }> = [];
    let calls = 0;
    const st = {
      id: "s2", taskId: "t2", kind: "inference", timeoutMs: 30_000, requestedModel: "x",
      input: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    } as unknown as Subtask;
    const r = await runInferenceSubtask(st, {
      agentId: "a1", ollamaHost: host,
      post: async (_p, b) => {
        if (++calls === 1) throw new Error("socket hang up");
        accepted.push(b as never);
        return {};
      },
    });
    expect(r).toMatchObject({ ok: true, output: "Hello, world" });
    expect(calls).toBeGreaterThan(1);
    expect(accepted.map((p) => p.seq)).toEqual(accepted.map((_, i) => i));
    expect(accepted.map((p) => p.delta).join("")).toBe("Hello, world");
    expect(accepted.at(-1)?.done).toBe(true);
  });

  const st1 = { id: "s1", taskId: "t1", kind: "inference", timeoutMs: 5_000, requestedModel: "x", input: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) } as unknown as Subtask;
  const listen = async (handler: Parameters<typeof createServer>[0]) => {
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };

  it("an empty reply (no text, no tool call) is a failure, with no final piece sent", async () => {
    const host = await listen((_req, res) => {
      res.write(JSON.stringify({ message: { content: "\n " } }) + "\n");
      res.end(JSON.stringify({ done: true, eval_count: 1 }) + "\n");
    });
    const posted: Array<{ done: boolean }> = [];
    const r = await runInferenceSubtask(st1, { agentId: "a1", ollamaHost: host, post: async (_p, b) => { posted.push(b as never); return {}; } });
    expect(r).toMatchObject({ ok: false, output: "", error: "empty_reply" });
    expect(posted.some((p) => p.done)).toBe(false);
  });

  it("a reply that is only a tool call is an answer", async () => {
    const host = await listen((_req, res) => {
      res.write(JSON.stringify({ message: { content: "", tool_calls: [{ function: { name: "read", arguments: {} } }] } }) + "\n");
      res.end(JSON.stringify({ done: true }) + "\n");
    });
    const posted: Array<{ done: boolean; toolCalls?: unknown[] }> = [];
    const r = await runInferenceSubtask(st1, { agentId: "a1", ollamaHost: host, post: async (_p, b) => { posted.push(b as never); return {}; } });
    expect(r.ok).toBe(true);
    expect(posted.at(-1)).toMatchObject({ done: true, toolCalls: [{ function: { name: "read" } }] });
  });

  it("an agent's calls all use its one context window, whatever their size; a call that does not fit is refused before Ollama", async () => {
    const seen: number[] = [];
    const host = await listen((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push(JSON.parse(raw).options.num_ctx);
        res.end(JSON.stringify({ message: { content: "ok" }, done: true }) + "\n");
      });
    });
    const call = (content: string, maxTokens?: number) =>
      runInferenceSubtask({ ...st1, input: JSON.stringify({ messages: [{ role: "user", content }], maxTokens }) } as Subtask, { agentId: "a1", ollamaHost: host, contextWindow: 16_384, post: async () => ({}) });
    expect((await call("hi", 64)).ok).toBe(true);
    expect((await call("x".repeat(30_000), 1024)).ok).toBe(true); // ~10k tokens: per-call sizing would ask for 16k; a short one 8k
    expect(seen).toEqual([16_384, 16_384]);
    const tooLong = await call("x".repeat(60_000), 1024);
    expect(tooLong).toMatchObject({ ok: false, error: expect.stringMatching(/^context_too_long: needs \d+ tokens, this agent serves 16384$/) });
    expect(seen).toHaveLength(2);
  });

  it("a failure before any output sends no final piece (the call can be retried elsewhere)", async () => {
    const host = await listen((_req, res) => { res.statusCode = 500; res.end(JSON.stringify({ error: "model failed to load" })); });
    const posted: unknown[] = [];
    const r = await runInferenceSubtask(st1, { agentId: "a1", ollamaHost: host, post: async (_p, b) => { posted.push(b); return {}; } });
    expect(r).toMatchObject({ ok: false, error: "ollama: model failed to load" });
    expect(posted).toEqual([]);
  });

  it("reports a model the agent doesn't have", async () => {
    server = createServer((_req, res) => { res.statusCode = 404; res.end(JSON.stringify({ error: "model 'x' not found" })); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const st = { id: "s1", taskId: "t1", kind: "inference", timeoutMs: 5_000, requestedModel: "x", input: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) } as unknown as Subtask;
    const r = await runInferenceSubtask(st, { agentId: "a1", ollamaHost: host, post: async () => ({}) });
    expect(r).toMatchObject({ ok: false, error: "ollama: model 'x' not found" });
  });
});

describe("stream memory is bounded (DoS by the agent running the subtask)", () => {
  it("tool calls count against the stream's size cap", async () => {
    const { InferenceStreams } = await import("../../src/swarm/inference-streams.js");
    const streams = new InferenceStreams();
    streams.open("sub-tc", "task-tc");
    const big = [{ function: { name: "f", arguments: { pad: "x".repeat(500_000) } } }];
    const results: string[] = [];
    for (let seq = 0; seq < 40; seq++) results.push(streams.append("sub-tc", seq, "", false, undefined, big));
    expect(results.filter((r) => r === "ok").length).toBeLessThanOrEqual(16);
    expect(results).toContain("too_large");
    expect(streams.replyBytes("sub-tc")!).toBeLessThanOrEqual(8_000_000);
  });

  it("a stream that never ends is dropped eventually", async () => {
    const { InferenceStreams } = await import("../../src/swarm/inference-streams.js");
    const streams = new InferenceStreams();
    streams.open("sub-open", "task-open");
    streams.append("sub-open", 0, "partial");
    streams.prune(Date.now() + 3 * 60 * 60_000);
    expect(streams.has("sub-open")).toBe(false);
  });
});
