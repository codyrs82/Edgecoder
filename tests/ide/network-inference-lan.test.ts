import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { streamNetworkCompletion, type NetworkDeps } from "../../src/apps/ide/network-inference.js";

/*
 * The requester side of direct LAN transfer in the IDE provider: when the coordinator hands a
 * ticket back, the reply is read from the LAN host through the local agent (NDJSON); the receipt and
 * the settled cost still come from the coordinator; any failure falls back to the coordinator path
 * without showing a character twice.
 */
describe("streamNetworkCompletion with a direct LAN ticket", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  const TICKET = { tid: "ab".repeat(16), hostLanId: "0011223344556677" };

  async function forwarder(opts: { coordinatorChunks: string[]; ticket?: boolean }) {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        calls.push({ path: req.url ?? "", body });
        if (req.url === "/forward/inference/submit") return res.end(JSON.stringify({ taskId: body.taskId, subtaskId: "st-1", ...(opts.ticket !== false ? { lanDirect: { ticket: TICKET } } : {}) }));
        if (req.url === "/forward/inference/lan-receipt") return res.end(JSON.stringify({ ok: true, match: true }));
        const after = body.after as number;
        const chunks = after >= opts.coordinatorChunks.length ? [] : opts.coordinatorChunks.slice(after);
        res.end(JSON.stringify({ chunks, next: opts.coordinatorChunks.length, done: true, creditsSpent: 1.25, promptTokens: 9, outputTokens: 4 }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base: NetworkDeps = { forwarder: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: () => "tok", agentId: "agent-1" };
    return { base, calls };
  }

  const run = async (deps: NetworkDeps) => {
    const out: Array<Record<string, unknown>> = [];
    for await (const p of streamNetworkCompletion(deps, { model: "m:7b", computeClass: "any", messages: [{ role: "user", content: "hi" }] })) out.push(p as Record<string, unknown>);
    return out;
  };

  it("asks for direct transfer; reads the reply from the LAN host; sends the receipt; takes the cost from the coordinator", async () => {
    const { base, calls } = await forwarder({ coordinatorChunks: ["Hello", " there"] });
    let directBody: unknown;
    const deps: NetworkDeps = {
      ...base,
      directLines: async function* (body) {
        directBody = body;
        yield { t: "chunk", seq: 0, delta: "Hello" };
        yield { t: "chunk", seq: 1, delta: " there" };
        yield { t: "done", replySha256: "c".repeat(64), replyBytes: 11, outputTokens: 4 };
      },
    };
    const out = await run(deps);
    expect(out).toEqual([{ delta: "Hello" }, { delta: " there" }, { done: true, direct: true, creditsSpent: 1.25, promptTokens: 9, outputTokens: 4 }]);
    expect(calls[0].body.lanDirect).toBe(true);
    expect(directBody).toEqual({ ticket: TICKET, request: { messages: [{ role: "user", content: "hi" }] } });
    expect(calls.find((c) => c.path === "/forward/inference/lan-receipt")?.body).toEqual({ taskId: calls[0].body.taskId, subtaskId: "st-1", tid: TICKET.tid, replySha256: "c".repeat(64), replyBytes: 11 });
    // The coordinator's stream was read only for the summary (past every piece), never the text.
    expect(calls.filter((c) => c.path === "/forward/inference/stream").map((c) => c.body.after)).toEqual([1_000_000_000]);
  });

  it("falls back to the coordinator from the start when the direct connection fails", async () => {
    const { base } = await forwarder({ coordinatorChunks: ["Hello", " there"] });
    const out = await run({ ...base, directLines: async function* () { yield { t: "fallback", phase: "connect", reason: "timeout", chars: 0 }; } });
    expect(out.filter((p) => p.delta).map((p) => p.delta).join("")).toBe("Hello there");
    expect(out.at(-1)).toMatchObject({ done: true, creditsSpent: 1.25 });
    expect(out.at(-1)?.direct).toBeUndefined();
  });

  it("a stream that breaks halfway continues from the coordinator's copy without repeating text", async () => {
    const { base } = await forwarder({ coordinatorChunks: ["Hel", "lo th", "ere"] });
    const out = await run({
      ...base,
      directLines: async function* () {
        yield { t: "chunk", seq: 0, delta: "Hell" };
        yield { t: "fallback", phase: "stream", reason: "closed", chars: 4 };
      },
    });
    expect(out.filter((p) => p.delta).map((p) => p.delta)).toEqual(["Hell", "o th", "ere"]);
  });

  it("no ticket (direct off, no neighbour, coordinator said no): the ordinary path", async () => {
    const { base } = await forwarder({ coordinatorChunks: ["ok"], ticket: false });
    let asked = false;
    const out = await run({ ...base, directLines: async function* () { asked = true; } });
    expect(asked).toBe(false);
    expect(out[0]).toEqual({ delta: "ok" });
  });

  it("never asks for direct transfer through a hosted transport, or when turned off", async () => {
    const { base, calls } = await forwarder({ coordinatorChunks: ["ok"], ticket: false });
    await run({ ...base, lanDirect: false });
    expect(calls[0].body.lanDirect).toBeUndefined();
  });
});
