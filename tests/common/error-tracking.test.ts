import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import * as Sentry from "@sentry/node";
import { describe, expect, it, vi } from "vitest";
import {
  errorTrackingConfig,
  fatalErrorHandler,
  initErrorTracking,
  installProcessErrorHandlers,
  registerErrorTracking,
  scrubEvent,
  type ErrorReporter
} from "../../src/common/error-tracking.js";

const DSN = "https://publickey@sentry.example.invalid/1";
const VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

type SentEvent = {
  tags?: Record<string, string>;
  release?: string;
  environment?: string;
  exception?: { values?: { type?: string; value?: string }[] };
  request?: unknown;
  user?: unknown;
  breadcrumbs?: unknown;
};

/** A transport that keeps envelopes in memory: nothing leaves the process. */
function fakeTransport() {
  const envelopes: string[] = [];
  const transport: Sentry.NodeOptions["transport"] = (options) =>
    Sentry.createTransport(options, async (request) => {
      envelopes.push(typeof request.body === "string" ? request.body : Buffer.from(request.body).toString("utf8"));
      return { statusCode: 200 };
    });
  const events = (): SentEvent[] =>
    envelopes.flatMap((envelope) => {
      // Envelope: header line, then (item header, item payload) pairs.
      const lines = envelope.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      const out: SentEvent[] = [];
      for (let i = 1; i < lines.length - 1; i += 2) if (lines[i]!.type === "event") out.push(lines[i + 1] as SentEvent);
      return out;
    });
  return { envelopes, transport, events };
}

async function build(env: NodeJS.ProcessEnv, extra: Parameters<typeof registerErrorTracking>[2] = {}) {
  const app = Fastify({ genReqId: () => "req-id-0001" });
  const reporter = await registerErrorTracking(app, "svc", { env, processHandlers: false, ...extra });
  app.post("/boom/:id", async () => {
    throw new Error("upstream http://rpcuser:hunter2pass@10.0.0.5:8332/wallet/main?apikey=QUERYSECRET1 said no (Bearer abcdefghijklmnopqrstuvwxyz012345)");
  });
  app.get("/unavailable", async (_req, reply) => reply.send(Object.assign(new Error("down"), { statusCode: 503 })));
  app.get("/bad", async (_req, reply) => reply.send(Object.assign(new Error("bad"), { statusCode: 400 })));
  return { app, reporter };
}

describe("error tracking (#14)", () => {
  it("is completely off without SENTRY_DSN: the SDK is never loaded", async () => {
    const load = vi.fn();
    for (const env of [{}, { SENTRY_DSN: "" }, { SENTRY_DSN: "   " }]) {
      const { reporter, app } = await build(env, { load });
      expect(reporter).toBeNull();
      expect((await app.inject({ method: "POST", url: "/boom/1" })).statusCode).toBe(500);
      await app.close();
    }
    expect(load).not.toHaveBeenCalled();
    expect(errorTrackingConfig({})).toBeNull();
  });

  it("imports @sentry/node lazily, never at module load", () => {
    const source = readFileSync(new URL("../../src/common/error-tracking.ts", import.meta.url), "utf8");
    const staticImports = source.split("\n").filter((l) => /^import\b/.test(l) && l.includes("@sentry/"));
    expect(staticImports.length).toBeGreaterThan(0);
    for (const line of staticImports) expect(line).toMatch(/^import type /);
    expect(source).toContain('import("@sentry/node")');
  });

  it("reports a 5xx with service, request id, route pattern, release and environment", async () => {
    const { transport, events } = fakeTransport();
    const { app, reporter } = await build({ SENTRY_DSN: DSN, NODE_ENV: "production" }, { transport });
    const res = await app.inject({ method: "POST", url: "/boom/user-4242?session=QUERYSECRET2" });
    expect(res.statusCode).toBe(500);
    expect(await reporter!.flush()).toBe(true);

    const [event, ...rest] = events();
    expect(rest).toHaveLength(0);
    expect(event!.tags).toEqual({ service: "svc", requestId: "req-id-0001", route: "/boom/:id", method: "POST" });
    expect(event!.release).toBe(`edgecoder@${VERSION}`);
    expect(event!.environment).toBe("production");
    expect(event!.exception?.values?.[0]?.type).toBe("Error");
    await reporter!.close();
    await app.close();
  });

  it("sends no body, cookies, auth headers, query strings or raw ids", async () => {
    const { transport, envelopes, events } = fakeTransport();
    const { app, reporter } = await build({ SENTRY_DSN: DSN }, { transport });
    await app.inject({
      method: "POST",
      url: "/boom/user-4242?session=QUERYSECRET2&code=QUERYSECRET3",
      headers: { cookie: "sid=COOKIESECRET", authorization: "Bearer HEADERSECRET-0123456789", "x-admin-token": "ADMINSECRET", "x-api-key": "APIKEYSECRET" },
      payload: { password: "BODYSECRET", mnemonic: "abandon ability able", note: "BODYNOTE" }
    });
    await reporter!.flush();
    expect(events()).toHaveLength(1);
    const sent = envelopes.join("\n");
    for (const secret of [
      "BODYSECRET", "abandon ability", "BODYNOTE", "COOKIESECRET", "HEADERSECRET", "ADMINSECRET", "APIKEYSECRET",
      "QUERYSECRET1", "QUERYSECRET2", "QUERYSECRET3", "user-4242", "hunter2pass", "rpcuser", "abcdefghijklmnopqrstuvwxyz012345"
    ]) {
      expect(sent, secret).not.toContain(secret);
    }
    // The message itself survives, minus the credentials it quoted.
    expect(events()[0]!.exception?.values?.[0]?.value).toBe("upstream http://[redacted]@10.0.0.5:8332/wallet/main said no (Bearer [redacted])");
    expect(events()[0]!.request).toBeUndefined();
    expect(events()[0]!.user).toBeUndefined();
    expect(events()[0]!.breadcrumbs).toBeUndefined();
    await reporter!.close();
    await app.close();
  });

  it("reports errors sent with a 5xx statusCode and ignores 4xx", async () => {
    const { transport, events } = fakeTransport();
    const { app, reporter } = await build({ SENTRY_DSN: DSN }, { transport });
    expect((await app.inject({ url: "/bad" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/nope" })).statusCode).toBe(404);
    await reporter!.flush();
    expect(events()).toHaveLength(0);
    expect((await app.inject({ url: "/unavailable" })).statusCode).toBe(503);
    await reporter!.flush();
    expect(events().map((e) => e.tags?.route)).toEqual(["/unavailable"]);
    await reporter!.close();
    await app.close();
  });

  it("takes release and environment overrides, defaulting to the app version and NODE_ENV", () => {
    expect(errorTrackingConfig({ SENTRY_DSN: DSN })).toEqual({ dsn: DSN, environment: "development", release: `edgecoder@${VERSION}` });
    expect(errorTrackingConfig({ SENTRY_DSN: DSN, NODE_ENV: "staging" })?.environment).toBe("staging");
    expect(errorTrackingConfig({ SENTRY_DSN: DSN, NODE_ENV: "production", SENTRY_ENVIRONMENT: "canary", SENTRY_RELEASE: "abc123" })).toEqual({
      dsn: DSN,
      environment: "canary",
      release: "abc123"
    });
  });

  it("keeps the service running when the SDK cannot be loaded", async () => {
    const { reporter, app } = await build({ SENTRY_DSN: DSN }, {
      load: async () => {
        throw new Error("Cannot find module '@sentry/node'");
      }
    });
    expect(reporter).toBeNull();
    expect((await app.inject({ method: "POST", url: "/boom/1" })).statusCode).toBe(500);
    await app.close();
  });
});

describe("scrubEvent (#14)", () => {
  it("strips request data, user, breadcrumbs and secrets from an event", () => {
    const event = scrubEvent({
      type: undefined,
      message: "GET /oauth/callback?code=OAUTHCODE&state=xyz failed",
      transaction: "GET /nodes/1?token=TXSECRET",
      request: {
        method: "POST",
        url: "https://portal.example/auth/login?next=/x&token=URLSECRET#frag",
        data: { password: "BODYSECRET" },
        cookies: { sid: "COOKIESECRET" },
        headers: { authorization: "Bearer HEADERSECRET", cookie: "sid=COOKIESECRET" },
        query_string: "token=URLSECRET",
        env: { REMOTE_ADDR: "198.51.100.7" }
      },
      user: { id: "user-1", email: "person@example.com", ip_address: "198.51.100.7" },
      breadcrumbs: [{ message: "fetch https://api.example/?key=CRUMBSECRET" }],
      extra: { apiKey: "EXTRASECRET", nested: { preimage: "PREIMAGESECRET" }, attempt: 2 },
      exception: { values: [{ type: "Error", value: "connect http://u:PWSECRET@db:5432/x?sslmode=require failed" }] }
    });
    expect(event.request).toEqual({ method: "POST", url: "https://portal.example/auth/login" });
    expect(event.user).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
    expect(event.extra).toEqual({ apiKey: "[redacted]", nested: { preimage: "[redacted]" }, attempt: 2 });
    expect(event.message).toBe("GET /oauth/callback failed");
    expect(event.transaction).toBe("GET /nodes/1");
    expect(event.exception?.values?.[0]?.value).toBe("connect http://[redacted]@db:5432/x failed");
    const json = JSON.stringify(event);
    for (const secret of ["OAUTHCODE", "TXSECRET", "URLSECRET", "BODYSECRET", "COOKIESECRET", "HEADERSECRET", "CRUMBSECRET", "EXTRASECRET", "PREIMAGESECRET", "PWSECRET", "person@example.com", "198.51.100.7"]) {
      expect(json, secret).not.toContain(secret);
    }
  });
});

describe("fatal process errors (#14)", () => {
  function fakeReporter(flush: () => Promise<boolean> = async () => true) {
    const calls: string[] = [];
    const captured: { error: unknown; tags: unknown }[] = [];
    const reporter: ErrorReporter = {
      captureException(error, tags) {
        calls.push("capture");
        captured.push({ error, tags });
      },
      async flush() {
        calls.push("flush");
        return flush();
      },
      async close() {}
    };
    return { reporter, calls, captured };
  }

  it("reports, flushes, then exits 1", async () => {
    const { reporter, calls, captured } = fakeReporter();
    const exited = new Promise<number>((resolve) => {
      const handler = fatalErrorHandler(reporter, (code) => {
        calls.push("exit");
        resolve(code);
      });
      handler("unhandledRejection")(new Error("lost promise"));
    });
    expect(await exited).toBe(1);
    expect(calls).toEqual(["capture", "flush", "exit"]);
    expect(captured[0]!.tags).toEqual({ mechanism: "unhandledRejection" });
    expect((captured[0]!.error as Error).message).toBe("lost promise");
  });

  it("still exits when reporting or flushing fails, and handles only the first failure", async () => {
    const { reporter, calls } = fakeReporter(async () => {
      throw new Error("network down");
    });
    reporter.captureException = () => {
      calls.push("capture");
      throw new Error("sdk broke");
    };
    const exit = vi.fn();
    const handler = fatalErrorHandler(reporter, exit);
    handler("uncaughtException")(new Error("first"));
    handler("uncaughtException")(new Error("second"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["capture", "flush"]);
  });

  it("listens for uncaughtException and unhandledRejection", () => {
    const target = new EventEmitter();
    installProcessErrorHandlers(fakeReporter().reporter, target as unknown as NodeJS.Process);
    expect(target.listenerCount("uncaughtException")).toBe(1);
    expect(target.listenerCount("unhandledRejection")).toBe(1);
  });

  it("sends a fatal error through the real client with its mechanism tag", async () => {
    const { transport, events } = fakeTransport();
    const reporter = (await initErrorTracking("svc", { env: { SENTRY_DSN: DSN }, transport }))!;
    const exit = vi.fn();
    fatalErrorHandler(reporter, exit)("uncaughtException")(new TypeError("fatal one"));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(events()).toHaveLength(1);
    expect(events()[0]!.tags).toEqual({ service: "svc", mechanism: "uncaughtException" });
    expect(events()[0]!.exception?.values?.[0]).toMatchObject({ type: "TypeError", value: "fatal one" });
    await reporter.close();
  });

  it("does not add process listeners when processHandlers is false", async () => {
    const before = [process.listenerCount("uncaughtException"), process.listenerCount("unhandledRejection")];
    const { transport } = fakeTransport();
    const { app, reporter } = await build({ SENTRY_DSN: DSN }, { transport });
    expect([process.listenerCount("uncaughtException"), process.listenerCount("unhandledRejection")]).toEqual(before);
    await reporter!.close();
    await app.close();
  });
});
