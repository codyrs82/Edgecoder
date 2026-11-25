import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import type { ChatCapacityDirectory } from "../../src/portal/chat-capacity.js";
import { CoordinatorDraining, drainFailoverBackend, networkBackend } from "../../src/inference-api/backends.js";
import type { NetworkDeps } from "../../src/apps/ide/network-inference.js";
import type { ChatBackend, ChatPiece, ChatRequest } from "../../src/inference-api/types.js";

/*
 * Run-3 outage test 3b: while the US coordinator drained for a restart, hosted API calls got 503
 * coordinator_draining for ~22 s. The refusal comes from the coordinator's request gate, before
 * anything is reserved (charged: false), so the portal now sends the call once, at once, to a peer
 * coordinator. Only when there is no peer, or the peer refuses too, is the caller's answer a 503
 * with Retry-After. Nothing that has already streamed is sent again.
 */

const US = "https://us.example";
const EU = "https://eu.example";
const MODEL = "qwen2.5-coder:1.5b";
const KEY = "eck_test_drain_key";
const drainingBody = (peer?: string) => ({ error: "coordinator_draining", retryable: true, retryAfterMs: 3_000, charged: false, ...(peer ? { coordinatorUrl: peer } : {}) });

type Submit = { url: string; body: Record<string, unknown> };

let prev: Dispatcher;
let mock: MockAgent;
beforeEach(() => {
  prev = getGlobalDispatcher();
  mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
});
afterEach(async () => {
  setGlobalDispatcher(prev);
  await mock.close();
});

/** Fake US/EU coordinators: `submit` answers /inference/submit; an accepted call streams "hello". */
function coordinators(submit: (url: string, body: Record<string, unknown>) => { status: number; json: Record<string, unknown> }) {
  const submits: Submit[] = [];
  for (const url of [US, EU]) {
    const pool = mock.get(url);
    pool
      .intercept({ path: "/inference/submit", method: "POST" })
      .reply((opts) => {
        const body = JSON.parse(String(opts.body));
        submits.push({ url, body });
        const r = submit(url, body);
        return { statusCode: r.status, data: JSON.stringify(r.json), responseOptions: { headers: { "content-type": "application/json" } } };
      })
      .persist();
    pool
      .intercept({ path: "/inference/stream", method: "POST" })
      .reply(200, { chunks: ["hello"], next: 1, done: true, creditsSpent: 0.4 })
      .persist();
    pool.intercept({ path: "/inference/cancel", method: "POST" }).reply(200, {}).persist();
  }
  return submits;
}

async function hostedApp(capacity: Partial<ChatCapacityDirectory> & { failed?: string[] } = {}) {
  const Fastify = (await import("fastify")).default;
  const { hashApiKey, registerHostedRoutes } = await import("../../src/portal/routes/hosted.js");
  const app = Fastify();
  const failed: string[] = capacity.failed ?? [];
  registerHostedRoutes(app, {
    store: { userForApiKeyHash: async (h: string) => (h === hashApiKey(KEY) ? "u1" : null) } as never,
    getCurrentUser: async () => null,
    PORTAL_SERVICE_TOKEN: "svc",
    EXTERNAL_HTTP_TIMEOUT_MS: 1000,
    discoverCoordinatorUrlsForPortal: async () => [US, EU],
    wholeKeepalive: null,
    chatCapacity: {
      // US has the most room (its report predates the restart); EU is the other one.
      pick: async (_need, exclude = []) => {
        const url = [US, EU].find((u) => !exclude.includes(u)) ?? null;
        return { url, known: 2 };
      },
      markFailed: (u: string) => void failed.push(u),
      networkModels: async () => [{ model: MODEL, agents: 2, classes: ["cpu"] }],
      pickAuto: async () => US,
      isKnown: async (u: string) => u === US || u === EU,
      ...capacity,
    } as ChatCapacityDirectory,
  } as never);
  return { app, failed };
}

const ask = (app: Awaited<ReturnType<typeof hostedApp>>["app"], model = `network/${MODEL}`) =>
  app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${KEY}` }, payload: { model, messages: [{ role: "user", content: "hi" }], stream: false } });

describe("hosted API: a call a restarting coordinator refuses", () => {
  it("is served at once by the peer the refusal names, with one accepted (billed) submit", async () => {
    const submits = coordinators((url, body) => (url === US ? { status: 503, json: drainingBody(EU) } : { status: 200, json: { taskId: body.taskId, subtaskId: "s-1" } }));
    const { app, failed } = await hostedApp();
    const t0 = Date.now();
    const r = await ask(app);
    expect(r.statusCode).toBe(200);
    expect(r.json().choices[0].message.content).toBe("hello");
    expect(Date.now() - t0).toBeLessThan(2_000); // no 3 s wait on the draining one
    expect(submits.map((s) => s.url)).toEqual([US, EU]);
    // US refused in its request gate (charged: false); only EU accepted, so only EU holds and bills it.
    expect(submits[1].body.routeRedirect).toBeUndefined();
    expect(failed).toContain(US);
  });

  it("goes to another known coordinator when the refusal names none", async () => {
    const submits = coordinators((url, body) => (url === US ? { status: 503, json: drainingBody() } : { status: 200, json: { taskId: body.taskId, subtaskId: "s-1" } }));
    const { app } = await hostedApp();
    const t0 = Date.now();
    const r = await ask(app);
    expect(r.statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(submits.map((s) => s.url)).toEqual([US, EU]);
  });

  it("fails over when no coordinator reported room (the default coordinator was asked)", async () => {
    const submits = coordinators((url, body) => (url === US ? { status: 503, json: drainingBody() } : { status: 200, json: { taskId: body.taskId, subtaskId: "s-1" } }));
    let picks = 0;
    const { app } = await hostedApp({
      // No report for the call itself; the fail-over pick (US left out) finds EU.
      pick: async (_need, exclude = []) => (picks++ === 0 ? { url: null, known: 2 } : { url: [US, EU].find((u) => !exclude.includes(u)) ?? null, known: 2 }),
    });
    const r = await ask(app);
    expect(r.statusCode).toBe(200);
    expect(submits.map((s) => s.url)).toEqual([US, EU]);
  });

  it("model auto fails over too", async () => {
    const submits = coordinators((url, body) => (url === US ? { status: 503, json: drainingBody(EU) } : { status: 200, json: { taskId: body.taskId, subtaskId: "s-1", routing: { model: MODEL, line: "routed" } } }));
    const { app } = await hostedApp({
      // The client-side plan has no free place: the call goes to the coordinator's best fit.
      networkModels: async () => [],
    });
    const r = await ask(app, "auto");
    expect(r.statusCode).toBe(200);
    expect(submits.filter((s) => s.url === US).length).toBe(1);
    expect(submits.filter((s) => s.url === EU).length).toBe(1);
  });

  it("is a 503 with Retry-After when the peer is restarting too (one try each, nothing accepted)", async () => {
    const submits = coordinators((url) => ({ status: 503, json: drainingBody(url === US ? EU : US) }));
    const { app } = await hostedApp();
    const r = await ask(app);
    expect(r.statusCode).toBe(503);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    expect(JSON.stringify(r.json())).toContain("Nothing was charged");
    expect(submits.map((s) => s.url)).toEqual([US, EU]);
  });
});

describe("drainFailoverBackend", () => {
  const req: ChatRequest = { messages: [{ role: "user", content: "hi" }] };
  const collect = async (b: ChatBackend) => {
    const out: ChatPiece[] = [];
    for await (const p of b(req)) out.push(p);
    return out;
  };
  const refusal = () => new CoordinatorDraining("restarting", 3, undefined);

  it("never sends again once a piece was passed on", async () => {
    let peerAsked = false;
    const first: ChatBackend = async function* () {
      yield { delta: "par" };
      throw refusal();
    };
    const b = drainFailoverBackend(first, async () => {
      peerAsked = true;
      return async function* () {
        yield { delta: "again" };
      };
    });
    const out: ChatPiece[] = [];
    await expect(async () => {
      for await (const p of b(req)) out.push(p);
    }).rejects.toBeInstanceOf(CoordinatorDraining);
    expect(out).toEqual([{ delta: "par" }]);
    expect(peerAsked).toBe(false);
  });

  it("passes other errors through without a peer", async () => {
    let peerAsked = false;
    const first: ChatBackend = async function* () {
      throw new Error("boom");
    };
    const b = drainFailoverBackend(first, async () => {
      peerAsked = true;
      return null;
    });
    await expect(collect(b)).rejects.toThrow("boom");
    expect(peerAsked).toBe(false);
  });

  it("with no peer, asks the same coordinator once more after the wait, then gives the 503", async () => {
    let runs = 0;
    const waits: number[] = [];
    const first: ChatBackend = async function* () {
      runs++;
      throw refusal();
    };
    const b = drainFailoverBackend(first, async () => null, async (ms) => void waits.push(ms));
    const err = await collect(b).catch((e) => e);
    expect(err).toBeInstanceOf(CoordinatorDraining);
    expect((err as CoordinatorDraining).status).toBe(503);
    expect((err as CoordinatorDraining).retryAfterSec).toBe(3);
    expect(runs).toBe(2);
    expect(waits).toEqual([3_000]);
  });

  it("a network call without drainFailover keeps the old wait-and-retry and plain error", async () => {
    const calls: string[] = [];
    const deps: NetworkDeps = {
      forwarder: "",
      token: () => "",
      agentId: "acct-1",
      transport: async (_m, path) => {
        calls.push(path);
        return { status: 503, json: { ...drainingBody(EU), retryAfterMs: 1 } };
      },
    };
    const err = await collect(networkBackend(deps, { model: MODEL, computeClass: "any" })).catch((e) => e);
    expect(err).not.toBeInstanceOf(CoordinatorDraining);
    expect(err.status).toBe(503);
    expect(calls).toEqual(["/inference/submit", "/inference/submit"]);
  });
});
