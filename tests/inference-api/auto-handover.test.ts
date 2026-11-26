import { describe, expect, it } from "vitest";
import type { NetworkDeps } from "../../src/apps/ide/network-inference.js";
import { coordinatorAutoBackend, networkBackend } from "../../src/inference-api/backends.js";
import type { ChatBackend, ChatPiece, ChatRequest } from "../../src/inference-api/types.js";

/*
 * Network run 20 (inf-1795727244974-d5f19016): an Auto call the EU coordinator could not start
 * (no cloud host there, its CPU hosts taken by the burst) is refused with no_capacity reason
 * "elsewhere" naming the US coordinator, whose cloud host had room. The portal sends it there at
 * once, as a route_elsewhere answer: redirected, not to be sent on again, nothing charged at EU.
 */

const US = "https://us.example";
const EU = "https://eu.example";
type Call = { url: string; path: string; body: Record<string, unknown> };

const req: ChatRequest = { messages: [{ role: "user", content: "hi" }] };
const collect = async (b: ChatBackend) => {
  const out: ChatPiece[] = [];
  for await (const p of b(req)) out.push(p);
  return out;
};

function coordinators(euStream: Record<string, unknown>) {
  const calls: Call[] = [];
  const deps = (url: string): NetworkDeps => ({
    forwarder: "", token: () => "", agentId: "acct-1",
    transport: async (_m, path, body) => {
      calls.push({ url, path, body: body as Record<string, unknown> });
      if (path === "/inference/submit") return { status: 200, json: { taskId: (body as { taskId: string }).taskId, subtaskId: "s-1", model: "qwen2.5-coder:1.5b" } };
      if (url === EU && path === "/inference/stream") return { status: 503, json: euStream };
      return { status: 200, json: { chunks: ["hello"], next: 1, done: true } };
    },
  });
  const backend = coordinatorAutoBackend({
    useClientSide: async () => false,
    clientSide: async function* () {},
    pick: async () => EU,
    allowed: (u) => u === US,
    run: (url, routeRedirect) => networkBackend(deps(url), { model: "auto", computeClass: "any", routeRedirect, clientRegion: "fra" }),
  });
  return { calls, backend };
}

describe("run 20: an Auto call handed over by a coordinator that cannot start it", () => {
  it("is sent at once to the coordinator named (reason elsewhere), redirected, and runs there", async () => {
    const { calls, backend } = coordinators({ error: "no_capacity", reason: "elsewhere", coordinatorUrl: US, retryAfterSec: 1 });
    const out = await collect(backend);
    expect(out.map((p) => p.delta).filter(Boolean).join("")).toBe("hello");
    const submits = calls.filter((c) => c.path === "/inference/submit");
    expect(submits.map((c) => c.url)).toEqual([EU, US]);
    expect(submits[0].body.routeRedirect).toBe(true);
    expect(submits[1].body.routeRedirect).toBeUndefined();
    expect(submits[1].body.redirected).toBe(true);
    // Ended (refunded) at EU: nothing to cancel there.
    expect(calls.some((c) => c.path === "/inference/cancel")).toBe(false);
  });

  it("a plain busy refusal is not followed (503 as before)", async () => {
    const { calls, backend } = coordinators({ error: "no_capacity", reason: "busy", retryAfterSec: 15 });
    await expect(collect(backend)).rejects.toMatchObject({ status: 503 });
    expect(calls.filter((c) => c.path === "/inference/submit").map((c) => c.url)).toEqual([EU]);
  });
});
