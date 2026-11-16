import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerCompatRoutes } from "../../src/inference-api/routes.js";
import type { ChatBackend } from "../../src/inference-api/types.js";
import { installGracefulShutdown } from "../../src/portal/shutdown.js";

/*
 * A deploy stops the portal (Fly's kill_signal). Streams it was answering are drained: allowed to
 * finish within the grace, then ended with a retryable error, never cut ("terminated").
 */

/** One piece, then waits until aborted (a long reply still being generated). */
const longReply: ChatBackend = async function* (_req, signal) {
  yield { delta: "partial " };
  await new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true })));
};

describe("portal graceful shutdown", () => {
  it("on SIGTERM: stops accepting, ends a stream still open at the grace with server_restarting, then exits 0", async () => {
    const app = Fastify();
    registerCompatRoutes(app, { authenticate: async () => ({}), models: async () => [], resolve: async () => ({ backend: longReply, model: "m1" }), keepaliveMs: 40 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as { port: number };
    const signals = new EventEmitter();
    const exits: number[] = [];
    let exited!: () => void;
    const exitedP = new Promise<void>((r) => (exited = r));
    installGracefulShutdown(app, { graceMs: 100, signals: signals as never, closeWaitMs: 200, exit: (c) => { exits.push(c); exited(); } });

    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let body = dec.decode((await reader.read()).value);
    expect(body).toContain("partial");

    signals.emit("SIGTERM");
    // The rest of the stream arrives and ends cleanly; the read does not throw "terminated".
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      body += dec.decode(value);
    }
    expect(body).toContain('"type":"server_restarting"');
    expect(body.trim().endsWith("data: [DONE]")).toBe(true);
    await exitedP;
    expect(exits).toEqual([0]);
    // No longer taking requests: refused, or Fastify's 503 while closing on a kept-alive connection.
    const after = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: "Bearer k" } }).then((r) => r.status, () => "refused");
    expect([503, "refused"]).toContain(after);
  });
});
