import { describe, expect, it } from "vitest";
import type { NetworkDeps } from "../../src/apps/ide/network-inference.js";
import { networkBackend, redirectingNetworkBackend } from "../../src/inference-api/backends.js";
import type { ChatBackend, ChatPiece, ChatRequest } from "../../src/inference-api/types.js";

/*
 * #526: a named network model with no free slot on the chosen coordinator, free on a peer: the
 * coordinator answers route_elsewhere before reserving anything, and the portal resubmits there
 * once (only to a coordinator it knows), with the buyer's region. Nothing is submitted twice for
 * billing: the first coordinator refused before its reserve, the second runs the call.
 */

const US = "https://us.example";
const EU = "https://eu.example";
type Call = { url: string; path: string; body: Record<string, unknown> };

function fakeCoordinators(submit: (url: string, body: Record<string, unknown>) => { status: number; json: Record<string, unknown> }) {
  const calls: Call[] = [];
  const deps = (url: string): NetworkDeps => ({
    forwarder: "",
    token: () => "",
    agentId: "acct-1",
    transport: async (_method, path, body) => {
      calls.push({ url, path, body: body as Record<string, unknown> });
      if (path === "/inference/submit") return submit(url, body as Record<string, unknown>);
      return { status: 200, json: { chunks: ["hello"], next: 1, done: true, creditsSpent: 0.4, promptTokens: 12, outputTokens: 3 } };
    },
  });
  return { calls, deps };
}

const req: ChatRequest = { messages: [{ role: "user", content: "hi" }] };
const collect = async (b: ChatBackend) => {
  const out: ChatPiece[] = [];
  for await (const p of b(req)) out.push(p);
  return out;
};
const backend = (deps: (url: string) => NetworkDeps, allowed: (url: string) => boolean) =>
  redirectingNetworkBackend({ url: US, allowed, run: (url, routeRedirect) => networkBackend(deps(url), { model: "qwen2.5-coder:1.5b", computeClass: "any", routeRedirect, clientRegion: "lhr" }) });

describe("named-model redirect", () => {
  it("follows route_elsewhere once to a known coordinator, with the buyer's region", async () => {
    const { calls, deps } = fakeCoordinators((url, body) =>
      url === US && body.routeRedirect ? { status: 409, json: { error: "route_elsewhere", coordinatorUrl: `${EU}/`, model: body.model } } : { status: 200, json: { taskId: body.taskId, subtaskId: "s-1" } },
    );
    const out = await collect(backend(deps, (u) => u === EU));
    expect(out.map((p) => p.delta).filter(Boolean).join("")).toBe("hello");
    const submits = calls.filter((c) => c.path === "/inference/submit");
    expect(submits.map((c) => c.url)).toEqual([US, EU]);
    expect(submits[0].body).toMatchObject({ model: "qwen2.5-coder:1.5b", routeRedirect: true, clientRegion: "lhr" });
    // The follow-up may not be sent on again.
    expect(submits[1].body.routeRedirect).toBeUndefined();
    expect(submits[1].body.clientRegion).toBe("lhr");
  });

  it("does not follow to a coordinator it does not know; the first one takes the call", async () => {
    const { calls, deps } = fakeCoordinators((url, body) =>
      body.routeRedirect ? { status: 409, json: { error: "route_elsewhere", coordinatorUrl: "https://evil.example" } } : { status: 200, json: { taskId: body.taskId, subtaskId: "s-1" } },
    );
    await collect(backend(deps, () => false));
    expect(calls.filter((c) => c.path === "/inference/submit").map((c) => c.url)).toEqual([US, US]);
  });

  it("a call for your own machines or a lease never asks to be redirected", async () => {
    const { calls, deps } = fakeCoordinators((_u, body) => ({ status: 200, json: { taskId: body.taskId, subtaskId: "s-1" } }));
    await collect(networkBackend(deps(US), { model: "m:7b", computeClass: "any", target: "mine", routeRedirect: true }));
    expect(calls.find((c) => c.path === "/inference/submit")!.body.routeRedirect).toBeUndefined();
  });
});
