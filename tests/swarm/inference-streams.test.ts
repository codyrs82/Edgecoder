import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { InferenceStreams } from "../../src/swarm/inference-streams.js";
import { runInferenceSubtask } from "../../src/swarm/inference-runner.js";
import type { Subtask } from "../../src/common/types.js";

describe("InferenceStreams", () => {
  it("applies pieces in order, ignores duplicates, refuses gaps", () => {
    const s = new InferenceStreams();
    s.open("st");
    expect(s.append("st", 0, "Hel")).toBe("ok");
    expect(s.append("st", 0, "Hel")).toBe("duplicate");
    expect(s.append("st", 2, "x")).toBe("gap");
    expect(s.append("st", 1, "lo", true)).toBe("ok");
    expect(s.append("nope", 0, "x")).toBe("unknown");
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

  it("reports a model the agent doesn't have", async () => {
    server = createServer((_req, res) => { res.statusCode = 404; res.end(JSON.stringify({ error: "model 'x' not found" })); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const st = { id: "s1", taskId: "t1", kind: "inference", timeoutMs: 5_000, requestedModel: "x", input: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) } as unknown as Subtask;
    const r = await runInferenceSubtask(st, { agentId: "a1", ollamaHost: host, post: async () => ({}) });
    expect(r).toMatchObject({ ok: false, error: "ollama: model 'x' not found" });
  });
});
