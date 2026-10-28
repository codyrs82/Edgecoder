import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerErrorTracking, type SentryLike } from "../../src/common/error-tracking.js";

function fakeSentry() {
  const s = { init: vi.fn(), captureException: vi.fn() } satisfies SentryLike;
  return { s, load: async () => s };
}

async function build(env: NodeJS.ProcessEnv, load: () => Promise<SentryLike>) {
  const app = Fastify();
  const reporter = await registerErrorTracking(app, "svc", env, load);
  app.get("/boom/:id", async () => {
    throw new Error("boom");
  });
  app.get("/bad", async (_req, reply) => {
    const err = Object.assign(new Error("bad"), { statusCode: 400 });
    return reply.send(err);
  });
  return { app, reporter };
}

describe("optional Sentry (#14)", () => {
  it("does nothing without SENTRY_DSN (the loader is never called)", async () => {
    const load = vi.fn();
    const { reporter, app } = await build({}, load);
    expect(reporter).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect((await app.inject({ url: "/boom/1" })).statusCode).toBe(500);
  });

  it("reports 5xx with service, route and request id, without PII", async () => {
    const { s, load } = fakeSentry();
    const { app } = await build({ SENTRY_DSN: "https://k@example.invalid/1", NODE_ENV: "production" }, load);
    expect(s.init).toHaveBeenCalledWith(expect.objectContaining({ sendDefaultPii: false, environment: "production" }));
    await app.inject({ url: "/boom/42" });
    expect(s.captureException).toHaveBeenCalledTimes(1);
    const [, hint] = s.captureException.mock.calls[0];
    expect(hint).toMatchObject({ tags: { service: "svc" }, extra: { route: "/boom/:id", method: "GET" } });
    expect(JSON.stringify(hint)).not.toContain("42");
  });

  it("does not report 4xx", async () => {
    const { s, load } = fakeSentry();
    const { app } = await build({ SENTRY_DSN: "https://k@example.invalid/1" }, load);
    await app.inject({ url: "/bad" });
    expect(s.captureException).not.toHaveBeenCalled();
  });

  it("keeps running if @sentry/node is not installed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { reporter } = await build({ SENTRY_DSN: "https://k@example.invalid/1" }, async () => {
      throw new Error("Cannot find module");
    });
    expect(reporter).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("error tracking is off"));
    warn.mockRestore();
  });
});
