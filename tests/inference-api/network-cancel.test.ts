import { describe, expect, it } from "vitest";
import { streamNetworkCompletion, type NetworkDeps } from "../../src/apps/ide/network-inference.js";

/*
 * A client that stops reading before the reply ended (its HTTP client disconnected, its session was
 * cancelled or deleted) cancels the network call on the coordinator; a reply that ended does not.
 */

function fake(stream: (n: number) => Record<string, unknown>) {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let reads = 0;
  const d: NetworkDeps = {
    forwarder: "",
    token: () => "",
    agentId: "acct-1",
    transport: async (_m, path, body) => {
      calls.push({ path, body: body as Record<string, unknown> });
      if (path === "/inference/submit") return { status: 200, json: { taskId: (body as { taskId: string }).taskId, subtaskId: "sub-1" } };
      if (path === "/inference/stream") return { status: 200, json: stream(reads++) };
      return { status: 200, json: { ok: true } };
    },
  };
  return { d, calls };
}
const req = { model: "qwen2.5-coder:1.5b", computeClass: "any", messages: [{ role: "user", content: "hi" }] };
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("cancelling a network call", () => {
  it("is sent when the reader stops before the reply ended", async () => {
    const { d, calls } = fake((n) => ({ chunks: [`piece ${n} `], next: n + 1, done: false }));
    for await (const p of streamNetworkCompletion(d, req)) {
      if (p.delta) break; // the client went away after the first piece
    }
    await tick();
    const c = calls.find((x) => x.path === "/inference/cancel");
    expect(c?.body).toEqual({ taskId: calls[0].body.taskId, subtaskId: "sub-1" });
  });

  it("is sent when the client's signal aborts", async () => {
    const { d, calls } = fake((n) => ({ chunks: [`p${n}`], next: n + 1, done: false }));
    const ac = new AbortController();
    for await (const p of streamNetworkCompletion(d, req, ac.signal)) if (p.delta) ac.abort();
    await tick();
    expect(calls.some((x) => x.path === "/inference/cancel")).toBe(true);
  });

  it("is not sent for a reply that ended", async () => {
    const { d, calls } = fake(() => ({ chunks: ["all"], next: 1, done: true }));
    for await (const _p of streamNetworkCompletion(d, req)) void _p;
    await tick();
    expect(calls.some((x) => x.path === "/inference/cancel")).toBe(false);
  });
});
