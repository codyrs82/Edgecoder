import { describe, expect, it } from "vitest";
import type { NetworkDeps } from "../../src/apps/ide/network-inference.js";
import { coordinatorAutoBackend, networkBackend } from "../../src/inference-api/backends.js";
import type { ChatBackend, ChatPiece, ChatRequest } from "../../src/inference-api/types.js";

/*
 * The portal's hosted "auto" forwards to the coordinator's best-fit routing: the request goes out
 * as model "auto" with the client's hints, a route_elsewhere answer is followed once to a known
 * coordinator, the last piece says "routed to … because …", and an older coordinator (one that
 * looks for a model called "auto") falls back to planning on the portal's side.
 */

const US = "https://us.example";
const EU = "https://eu.example";
const LINE = "routed to qwen3-coder:30b on gpu because agentic · complexity high (0.62): most capable that fits";

type Call = { url: string; path: string; body: Record<string, unknown> };

/** A fake coordinator per URL: answers submit with `submit(url, body)`, then one finished stream piece. */
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

const req: ChatRequest = { messages: [{ role: "user", content: "fix it" }], hints: { job: "agentic", quality: "best", sessionId: "s-1" } };
const collect = async (b: ChatBackend, r: ChatRequest = req) => {
  const out: ChatPiece[] = [];
  for await (const p of b(r)) out.push(p);
  return out;
};
const ok = (url: string) => ({ status: 200, json: { taskId: "t", subtaskId: `sub-${url}`, model: "qwen3-coder:30b", routing: { model: "qwen3-coder:30b", computeClass: "gpu", line: LINE } } });
const clientSideMarker: ChatBackend = async function* () {
  yield { delta: "client-side" };
  yield { done: true, where: "network gpu (per-token price, fastest available) · qwen2.5-coder:7b" };
};

function backend(f: ReturnType<typeof fakeCoordinators>, opts: { known?: string[]; useClientSide?: boolean; pick?: string | null } = {}) {
  return coordinatorAutoBackend({
    useClientSide: async () => opts.useClientSide ?? false,
    clientSide: clientSideMarker,
    pick: async () => (opts.pick === undefined ? US : opts.pick),
    allowed: async (url) => (opts.known ?? [US, EU]).includes(url),
    run: (url, routeRedirect) => networkBackend(f.deps(url), { model: "auto", computeClass: "any", routeRedirect }),
  });
}

describe("hosted auto forwards to the coordinator's best-fit routing", () => {
  it("sends model auto with the hints, and the last piece says where and why", async () => {
    const f = fakeCoordinators((url) => ok(url));
    const pieces = await collect(backend(f));
    const submit = f.calls.find((c) => c.path === "/inference/submit")!;
    expect(submit.url).toBe(US);
    expect(submit.body).toMatchObject({ model: "auto", computeClass: "any", routing: { job: "agentic", quality: "best", sessionId: "s-1" }, routeRedirect: true });
    expect(pieces[0]).toEqual({ delta: "hello" });
    expect(pieces.at(-1)).toMatchObject({ done: true, where: LINE, cSatsSpent: 0.4 });
  });

  it("follows route_elsewhere once to a known coordinator, without a second redirect", async () => {
    const f = fakeCoordinators((url) => (url === US ? { status: 409, json: { error: "route_elsewhere", coordinatorUrl: `${EU}/`, routing: { line: "x" } } } : ok(url)));
    const pieces = await collect(backend(f));
    const submits = f.calls.filter((c) => c.path === "/inference/submit");
    expect(submits.map((c) => [c.url, c.body.routeRedirect])).toEqual([[US, true], [EU, undefined]]);
    expect(pieces.at(-1)).toMatchObject({ where: LINE });
  });

  it("does not follow a redirect to a coordinator the portal does not know: the first places it locally", async () => {
    const f = fakeCoordinators((url, body) => (url === US && body.routeRedirect ? { status: 409, json: { error: "route_elsewhere", coordinatorUrl: "https://evil.example" } } : ok(url)));
    await collect(backend(f, { known: [US] }));
    expect(f.calls.filter((c) => c.path === "/inference/submit").map((c) => [c.url, c.body.routeRedirect])).toEqual([[US, true], [US, undefined]]);
  });

  it("falls back to the portal's own plan with an older coordinator", async () => {
    // An older coordinator looks for a model called "auto" and finds none.
    const f = fakeCoordinators(() => ({ status: 409, json: { error: "no_agent_has_model", model: "auto" } }));
    const pieces = await collect(backend(f));
    expect(pieces[0]).toEqual({ delta: "client-side" });
  });

  it("free places (your reservation, your machines) and no known coordinator stay with the client-side plan", async () => {
    const f = fakeCoordinators((url) => ok(url));
    expect((await collect(backend(f, { useClientSide: true })))[0]).toEqual({ delta: "client-side" });
    expect((await collect(backend(f, { pick: null })))[0]).toEqual({ delta: "client-side" });
    expect(f.calls).toEqual([]);
  });

  it("passes the coordinator's refusal on as an error", async () => {
    const f = fakeCoordinators(() => ({ status: 409, json: { error: "no_route_fits", detail: "every fitting model costs more than the 0.1 cSats ceiling" } }));
    await expect(collect(backend(f))).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/cSats ceiling/) });
  });
});

describe("hosted /v1/chat/completions with model auto", () => {
  it("forwards to the coordinator chosen for auto, with the hints from the body and headers", async () => {
    const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = await import("undici");
    const prev = getGlobalDispatcher();
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    try {
      let submitted: Record<string, unknown> | undefined;
      mock.get(US).intercept({ path: "/inference/submit", method: "POST" }).reply(200, (opts) => {
        submitted = JSON.parse(String(opts.body));
        return { taskId: "t1", subtaskId: "s1", model: "qwen2.5-coder:7b", routing: { model: "qwen2.5-coder:7b", computeClass: "apple", line: "routed to qwen2.5-coder:7b on apple because chat · complexity low (0.00): fastest that fits" } };
      });
      mock.get(US).intercept({ path: "/inference/stream", method: "POST" }).reply(200, { chunks: ["Hi"], next: 1, done: true, creditsSpent: 0.03 });
      const Fastify = (await import("fastify")).default;
      const { hashApiKey, registerHostedRoutes } = await import("../../src/portal/routes/hosted.js");
      const key = "eck_test_auto_key";
      const app = Fastify();
      registerHostedRoutes(app, {
        store: { userForApiKeyHash: async (h: string) => (h === hashApiKey(key) ? "u1" : null) } as never,
        getCurrentUser: async () => null,
        PORTAL_SERVICE_TOKEN: "svc",
        EXTERNAL_HTTP_TIMEOUT_MS: 1000,
        discoverCoordinatorUrlsForPortal: async () => [],
        chatCapacity: {
          pick: async () => ({ url: null, known: 0 }),
          markFailed: () => undefined,
          networkModels: async () => [],
          pickAuto: async () => US,
          isKnown: async (u: string) => u === US,
        },
      } as never);
      const r = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: `Bearer ${key}`, "x-edgecoder-latency": "batch", "x-session-id": "conv-7" },
        payload: { model: "auto", messages: [{ role: "user", content: "hi" }], edgecoder: { job: "chat", maxCSats: 2 } },
      });
      expect(r.statusCode, r.body).toBe(200);
      expect(submitted).toMatchObject({ model: "auto", routeRedirect: true, routing: { job: "chat", maxCSats: 2, latency: "batch", sessionId: "conv-7" } });
      expect(r.json().choices[0].message.content).toBe("Hi");
      expect(r.json().edgecoder.where).toMatch(/^routed to qwen2\.5-coder:7b on apple because chat/);
      await app.close();
    } finally {
      setGlobalDispatcher(prev);
      await mock.close();
    }
  });
});
