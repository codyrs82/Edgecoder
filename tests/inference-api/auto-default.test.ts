import { describe, expect, it } from "vitest";
import { AUTO_MODEL_ID, BEST_FIT_ROUTE, isUnpinnedModel, routeLabel, type RouteInputs, type Route } from "../../src/inference-api/auto-route.js";
import { autoBackend, withBestFit } from "../../src/inference-api/backends.js";
import type { RoutingHints } from "../../src/inference-api/job-descriptor.js";
import { ChatBackendError, type ChatBackend, type ChatPiece, type ChatRequest } from "../../src/inference-api/types.js";
import { computeLabel, networkTargetFor } from "../../src/portal/routes/compute.js";

/*
 * Auto by default: a network request whose model the user did not pin goes out as model "auto", so
 * the coordinator's best-fit routing picks the model, class and machine. Free places (this computer,
 * your machines, a lease) still come first where the policy says so; a pin stays a pin.
 */

const prices = { cpu: 0.009, apple: 0.052, gpu: 0.043, "gpu.dc": 0.304 };
const net = [{ model: "qwen2.5-coder:14b", classes: ["gpu"], cSatsPerMTokens: { input: 100, output: 400 } }];
const base: RouteInputs = { localModels: [], myModels: [], leases: [], networkModels: net, classPrice: prices, balanceCSats: 500 };
const heavy: ChatRequest = { messages: [{ role: "user", content: "fix the bug" }], tools: [{ type: "function", function: { name: "Edit" } }], hints: { quality: "best" } };

/** A backend that records where it ran and what best fit was asked with. */
function harness(opts: { failBestFit?: boolean; failLocal?: boolean } = {}) {
  const ran: string[] = [];
  const hints: RoutingHints[] = [];
  const run = (r: Route): ChatBackend =>
    async function* () {
      ran.push(`${r.placement}:${r.model}`);
      if (opts.failLocal && r.placement === "local") throw new ChatBackendError("Ollama isn't running", 503);
      yield { delta: "ok" };
      yield { done: true, cSatsSpent: 0 };
    };
  const networkBestFit = (routing: RoutingHints): ChatBackend =>
    async function* () {
      ran.push("best-fit");
      hints.push(routing);
      if (opts.failBestFit) throw new ChatBackendError("no_route_fits", 409);
      yield { delta: "ok" };
      yield { done: true, cSatsSpent: 0.8, where: "routed to qwen3-coder:30b on gpu because agentic" };
    };
  return { ran, hints, run, networkBestFit };
}

const collect = async (b: ChatBackend, req: ChatRequest = heavy) => {
  const out: ChatPiece[] = [];
  for await (const p of b(req)) out.push(p);
  return out;
};

describe("what counts as not pinned", () => {
  it("no model, empty, default and auto leave it to the network; anything else is a pin", () => {
    for (const m of [undefined, null, "", "  ", "default", "DEFAULT", "auto"]) expect(isUnpinnedModel(m)).toBe(true);
    for (const m of ["qwen3.5:9b", "network/qwen3-coder:30b@gpu", "mine/qwen2.5-coder:7b", "reserved/r1/m", "frontier/anthropic/claude", "edgecoder-local"]) expect(isUnpinnedModel(m)).toBe(false);
  });

  it("the best-fit route is a network route for model auto, labelled as such", () => {
    expect(BEST_FIT_ROUTE).toMatchObject({ placement: "network", model: AUTO_MODEL_ID, bestFit: true });
    expect(routeLabel(BEST_FIT_ROUTE)).toBe("Network · best fit");
  });

  it("best fit goes in front of the network routes, after the free places, and only when the network is in the plan", () => {
    const local: Route = { placement: "local", model: "qwen3.5:9b", cSatsPerSecond: 0, reason: "this computer" };
    const network: Route = { placement: "network", model: "qwen2.5-coder:14b", computeClass: "gpu", cSatsPerSecond: 0.04, reason: "network gpu" };
    const fallback: Route = { ...local, model: "qwen2.5-coder:1.5b", fallback: true };
    expect(withBestFit([local, network, fallback])).toEqual([local, BEST_FIT_ROUTE, network, fallback]);
    expect(withBestFit([local, fallback])).toEqual([local, fallback]);
  });
});

describe("Auto on a connected machine (chat Auto, Code view, edgecoder code, bots, connections)", () => {
  it("the network leg is the coordinator's best fit, not a model picked here", async () => {
    const h = harness();
    const out = await collect(autoBackend({ inputs: async () => base, run: h.run, networkBestFit: h.networkBestFit }));
    expect(h.ran).toEqual(["best-fit"]);
    // The coordinator's line says where it ran.
    expect(out.at(-1)).toMatchObject({ done: true, where: "routed to qwen3-coder:30b on gpu because agentic" });
    expect(h.hints[0]).toMatchObject({ quality: "best", maxCSats: 500 });
  });

  it("a free place that fits still comes first (your own machines are never picked by best fit)", async () => {
    const h = harness();
    await collect(autoBackend({ inputs: async () => ({ ...base, localModels: ["qwen2.5-coder:14b"] }), run: h.run, networkBestFit: h.networkBestFit }));
    expect(h.ran).toEqual(["local:qwen2.5-coder:14b"]);
    const h2 = harness({ failLocal: true });
    await collect(autoBackend({ inputs: async () => ({ ...base, localModels: ["qwen2.5-coder:14b"] }), run: h2.run, networkBestFit: h2.networkBestFit }));
    expect(h2.ran).toEqual(["local:qwen2.5-coder:14b", "best-fit"]);
  });

  it("a coordinator that refuses (or predates auto) falls back to the client-side network routes", async () => {
    const h = harness({ failBestFit: true });
    await collect(autoBackend({ inputs: async () => base, run: h.run, networkBestFit: h.networkBestFit }));
    expect(h.ran).toEqual(["best-fit", "network:qwen2.5-coder:14b"]);
  });

  it("a bot's budget left is the price ceiling best fit is asked with", async () => {
    const h = harness();
    await collect(autoBackend({ inputs: async () => base, run: h.run, networkBestFit: h.networkBestFit, policy: "local_first", plan: () => ({ allowanceCSats: 3 }) }));
    expect(h.hints[0].maxCSats).toBe(3);
    // A smaller ceiling from the client wins.
    const h2 = harness();
    await collect(autoBackend({ inputs: async () => base, run: h2.run, networkBestFit: h2.networkBestFit, plan: () => ({ allowanceCSats: 3 }) }), { ...heavy, hints: { maxCSats: 1 } });
    expect(h2.hints[0].maxCSats).toBe(1);
  });

  it("policies that keep off the network, a spent budget and a pinned model never reach best fit", async () => {
    for (const [policy, plan] of [["local_only", {}], ["mine_only", {}], ["local_first", { allowanceCSats: 0 }], ["model", { model: "network/qwen2.5-coder:14b@gpu" }]] as const) {
      const h = harness();
      await collect(autoBackend({ inputs: async () => ({ ...base, localModels: ["qwen2.5-coder:1.5b"] }), run: h.run, networkBestFit: h.networkBestFit, policy, plan: () => plan })).catch(() => undefined);
      expect(h.ran, policy).not.toContain("best-fit");
    }
  });

  it("without a network connection there is no best-fit leg (the plan runs as before)", async () => {
    const h = harness();
    await collect(autoBackend({ inputs: async () => base, run: h.run }));
    expect(h.ran).toEqual(["network:qwen2.5-coder:14b"]);
  });
});

describe("portal chat Auto", () => {
  it("is the network's best fit", () => {
    expect(networkTargetFor({ target: "auto" })).toEqual({ model: "auto", computeClass: "any" });
    expect(computeLabel({ target: "auto" })).toBe("Network · best fit");
  });
});

describe("hosted /v1/chat/completions without a model", () => {
  const US = "https://us.example";
  for (const model of [undefined, "default"]) {
    it(`${model === undefined ? "no model" : `model "${model}"`} is auto: the coordinator's best fit`, async () => {
      const { MockAgent, setGlobalDispatcher, getGlobalDispatcher } = await import("undici");
      const prev = getGlobalDispatcher();
      const mock = new MockAgent();
      mock.disableNetConnect();
      setGlobalDispatcher(mock);
      try {
        let submitted: Record<string, unknown> | undefined;
        mock.get(US).intercept({ path: "/inference/submit", method: "POST" }).reply(200, (opts) => {
          submitted = JSON.parse(String(opts.body));
          return { taskId: "t1", subtaskId: "s1", model: "qwen2.5-coder:7b", routing: { model: "qwen2.5-coder:7b", computeClass: "apple", line: "routed to qwen2.5-coder:7b on apple because chat" } };
        });
        mock.get(US).intercept({ path: "/inference/stream", method: "POST" }).reply(200, { chunks: ["Hi"], next: 1, done: true, creditsSpent: 0.03 });
        const Fastify = (await import("fastify")).default;
        const { hashApiKey, registerHostedRoutes } = await import("../../src/portal/routes/hosted.js");
        const key = "eck_test_default_key";
        const app = Fastify();
        registerHostedRoutes(app, {
          store: { userForApiKeyHash: async (h: string) => (h === hashApiKey(key) ? "u1" : null) } as never,
          getCurrentUser: async () => null,
          PORTAL_SERVICE_TOKEN: "svc",
          EXTERNAL_HTTP_TIMEOUT_MS: 1000,
          discoverCoordinatorUrlsForPortal: async () => [],
          chatCapacity: { pick: async () => ({ url: null, known: 0 }), markFailed: () => undefined, networkModels: async () => [], pickAuto: async () => US, isKnown: async (u: string) => u === US },
        } as never);
        const r = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          headers: { authorization: `Bearer ${key}` },
          payload: { ...(model !== undefined ? { model } : {}), messages: [{ role: "user", content: "hi" }] },
        });
        expect(r.statusCode, r.body).toBe(200);
        expect(submitted).toMatchObject({ model: "auto" });
        expect(r.json().model).toBe("auto");
        await app.close();
      } finally {
        setGlobalDispatcher(prev);
        await mock.close();
      }
    });
  }
});
