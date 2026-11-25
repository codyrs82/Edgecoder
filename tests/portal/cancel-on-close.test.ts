import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import type { ChatCapacityDirectory } from "../../src/portal/chat-capacity.js";
import { cancelOnClose } from "../../src/portal/cancel-on-close.js";
import type { Transport } from "../../src/apps/ide/network-inference.js";

/*
 * Network run 6: buyers' calls closed at 120 s kept running upstream to 153–224 s (hosted_call
 * said cancelled: false). The portal now cancels the coordinator call the moment the buyer's
 * connection closes: streamed, non-streamed during the keepalive, queued, or still being submitted.
 */

const US = "https://us.example";
const MODEL = "qwen2.5-coder:1.5b";
const KEY = "eck_test_cancel_key";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let prev: Dispatcher;
let mock: MockAgent;
beforeEach(() => {
  prev = getGlobalDispatcher();
  mock = new MockAgent();
  mock.disableNetConnect();
  mock.enableNetConnect(/127\.0\.0\.1/);
  setGlobalDispatcher(mock);
});
afterEach(async () => {
  setGlobalDispatcher(prev);
  await mock.close();
});

type Read = (n: number) => Record<string, unknown>;

/** A fake coordinator: submit accepts, each stream read answers `read(n)` (after 20 ms). */
function coordinator(read: Read) {
  const cancels: Array<Record<string, unknown>> = [];
  let reads = 0;
  const pool = mock.get(US);
  pool
    .intercept({ path: "/inference/submit", method: "POST" })
    .reply((opts) => {
      const body = JSON.parse(String(opts.body));
      return { statusCode: 200, data: JSON.stringify({ taskId: body.taskId, subtaskId: "sub-1" }), responseOptions: { headers: { "content-type": "application/json" } } };
    })
    .persist();
  pool
    .intercept({ path: "/inference/stream", method: "POST" })
    .reply(() => ({ statusCode: 200, data: JSON.stringify(read(reads++)), responseOptions: { headers: { "content-type": "application/json" } } }))
    .delay(20)
    .persist();
  pool
    .intercept({ path: "/inference/cancel", method: "POST" })
    .reply((opts) => {
      cancels.push(JSON.parse(String(opts.body)));
      return { statusCode: 200, data: JSON.stringify({ ok: true, outcome: "stopping" }), responseOptions: { headers: { "content-type": "application/json" } } };
    })
    .persist();
  return { cancels, reads: () => reads };
}

async function hostedApp(logLines: string[]) {
  const Fastify = (await import("fastify")).default;
  const { hashApiKey, registerHostedRoutes } = await import("../../src/portal/routes/hosted.js");
  const app = Fastify({ logger: { level: "info", stream: { write: (l: string) => void logLines.push(l) } } });
  registerHostedRoutes(app, {
    store: { userForApiKeyHash: async (h: string) => (h === hashApiKey(KEY) ? "u1" : null) } as never,
    getCurrentUser: async () => null,
    PORTAL_SERVICE_TOKEN: "svc",
    EXTERNAL_HTTP_TIMEOUT_MS: 1000,
    discoverCoordinatorUrlsForPortal: async () => [US],
    wholeKeepalive: { afterMs: 30, everyMs: 1_000 },
    chatCapacity: {
      pick: async () => ({ url: US, known: 1 }),
      markFailed: () => undefined,
      networkModels: async () => [{ model: MODEL, agents: 1, classes: ["cpu"] }],
      pickAuto: async () => US,
      isKnown: async (u: string) => u === US,
    } as unknown as ChatCapacityDirectory,
  } as never);
  await app.listen({ port: 0, host: "127.0.0.1" });
  return app;
}

/** POST a chat call; the client drops the connection once what it read matches `cutAt` (null: reads it all). */
function callAndCut(port: number, stream: boolean, cutAt: RegExp | null): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path: "/v1/chat/completions", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" } },
      (res) => {
        res.on("data", (d) => {
          text += String(d);
          if (cutAt?.test(text)) {
            req.destroy();
            resolve(text);
          }
        });
        res.on("end", () => resolve(text));
      },
    );
    req.on("error", () => resolve(text));
    req.end(JSON.stringify({ model: `network/${MODEL}`, messages: [{ role: "user", content: "hi" }], stream }));
  });
}

async function until(cond: () => boolean, ms = 2_000) {
  for (let t = 0; t < ms && !cond(); t += 10) await wait(10);
}
const hostedLine = (lines: string[]) => lines.map((l) => JSON.parse(l)).find((l) => l.msg === "hosted_call")?.hostedCall;

describe("hosted /v1: the buyer's connection closes before the reply ended", () => {
  it("mid-stream: one cancel goes to the coordinator, and the call's log line says so", async () => {
    const c = coordinator((n) => ({ chunks: [`piece${n} `], next: n + 1, done: false }));
    const lines: string[] = [];
    const app = await hostedApp(lines);
    try {
      const got = await callAndCut((app.server.address() as { port: number }).port, true, /piece/);
      expect(got).toContain("piece");
      await until(() => c.cancels.length > 0 && !!hostedLine(lines));
      await wait(100); // the reader's own cancel, if any, would have been sent by now
      expect(c.cancels).toEqual([{ taskId: expect.stringMatching(/^inf-/), subtaskId: "sub-1" }]);
      expect(hostedLine(lines)).toMatchObject({ closedBy: "client", upstream: { cancelled: true } });
    } finally {
      await app.close();
    }
  });

  it("non-streamed, during the keepalive (still queued upstream): the call is cancelled", async () => {
    // Nobody has claimed it: every read comes back empty.
    const c = coordinator((n) => ({ chunks: [], next: 0, done: false, n }));
    const lines: string[] = [];
    const app = await hostedApp(lines);
    try {
      // The 200 head and the first keepalive space arrive (at 30 ms); then the client goes away.
      const got = await callAndCut((app.server.address() as { port: number }).port, false, /^\s/);
      expect(got.trim()).toBe("");
      await until(() => c.cancels.length > 0);
      await wait(100);
      expect(c.cancels).toHaveLength(1);
      expect(c.cancels[0].subtaskId).toBe("sub-1");
    } finally {
      await app.close();
    }
  });

  it("a normal completion sends no cancel", async () => {
    const c = coordinator(() => ({ chunks: ["all of it"], next: 1, done: true, creditsSpent: 0.1 }));
    const lines: string[] = [];
    const app = await hostedApp(lines);
    try {
      const got = await callAndCut((app.server.address() as { port: number }).port, true, null);
      expect(got).toContain("all of it");
      await until(() => !!hostedLine(lines));
      await wait(100);
      expect(c.cancels).toHaveLength(0);
      expect(hostedLine(lines)).toMatchObject({ closedBy: "server", upstream: { cancelled: false, done: true } });
    } finally {
      await app.close();
    }
  });
});

describe("cancelOnClose (the transport wrapper)", () => {
  const fake = (submitMs = 0) => {
    const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
    const t: Transport = async (_m, path, body, signal) => {
      sent.push({ path, body: body as Record<string, unknown> });
      if (path === "/inference/submit") {
        await wait(submitMs);
        return { status: 200, json: { taskId: (body as { taskId: string }).taskId, subtaskId: "sub-9" } };
      }
      if (path === "/inference/stream")
        return new Promise((_res, rej) => signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      return { status: 200, json: { ok: true } };
    };
    return { t, sent, cancels: () => sent.filter((s) => s.path === "/inference/cancel") };
  };

  it("a close while the submit is on its way: the caller is released, and the call is cancelled once it lands", async () => {
    const f = fake(60);
    const tr = cancelOnClose(f.t);
    const ac = new AbortController();
    const p = tr("POST", "/inference/submit", { taskId: "inf-1" }, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(f.cancels()).toHaveLength(0);
    await wait(100);
    expect(f.cancels().map((c) => c.body)).toEqual([{ taskId: "inf-1", subtaskId: "sub-9" }]);
  });

  it("sends one cancel: the reader's own cancel after the close is not sent again", async () => {
    const f = fake();
    const tr = cancelOnClose(f.t);
    const ac = new AbortController();
    await tr("POST", "/inference/submit", { taskId: "inf-2" }, ac.signal);
    const read = tr("POST", "/inference/stream", { taskId: "inf-2", subtaskId: "sub-9", after: 0 }, ac.signal);
    ac.abort();
    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    const again = await tr("POST", "/inference/cancel", { taskId: "inf-2", subtaskId: "sub-9" });
    expect(again.status).toBe(200);
    expect(f.cancels()).toHaveLength(1);
  });

  it("submits nothing once the caller has gone", async () => {
    const f = fake();
    const ac = new AbortController();
    ac.abort();
    await expect(cancelOnClose(f.t)("POST", "/inference/submit", { taskId: "inf-3" }, ac.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(f.sent).toHaveLength(0);
  });
});
