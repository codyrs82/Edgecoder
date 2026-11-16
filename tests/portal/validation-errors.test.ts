// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import * as Sentry from "@sentry/node";
import { registerErrorTracking } from "../../src/common/error-tracking.js";
import { isRequestValidationError, registerRequestValidationErrors } from "../../src/portal/validation-errors.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function build() {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerRequestValidationErrors(app);
  app.post("/thing", async (req) => {
    const body = z.object({ amountSats: z.number().int().positive(), note: z.string().max(10).optional() }).parse(req.body);
    return { ok: true, amountSats: body.amountSats };
  });
  app.get("/boom", async () => {
    throw new Error("database password is hunter2");
  });
  app.get("/conflict", async () => {
    throw Object.assign(new Error("already exists"), { statusCode: 409 });
  });
  app.get("/limited", async () => {
    // What @fastify/rate-limit throws with the portal's errorResponseBuilder (security.ts): not an Error.
    throw { statusCode: 429, error: "rate_limited", retryAfter: "1 minute" };
  });
  app.get("/odd", async () => {
    throw { error: "no_status" };
  });
  return app;
}

describe("portal request validation errors", () => {
  it("answers a malformed body with 400 and the failing fields", async () => {
    const res = await build().inject({ method: "POST", url: "/thing", payload: { amountSats: "lots", note: "x".repeat(50) } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "invalid_request",
      issues: [
        { path: "amountSats", code: "invalid_type" },
        { path: "note", code: "too_big" }
      ]
    });
  });

  it("does not echo the submitted values", async () => {
    const res = await build().inject({ method: "POST", url: "/thing", payload: { amountSats: "s3cret-value" } });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain("s3cret-value");
  });

  it("answers a missing body with 400", async () => {
    const res = await build().inject({ method: "POST", url: "/thing" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });

  it("leaves a valid request alone", async () => {
    const res = await build().inject({ method: "POST", url: "/thing", payload: { amountSats: 5 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, amountSats: 5 });
  });

  it("leaves other errors to Fastify's default handler", async () => {
    const app = build();
    const boom = await app.inject({ method: "GET", url: "/boom" });
    expect(boom.statusCode).toBe(500);
    expect(boom.json()).toMatchObject({ statusCode: 500, error: "Internal Server Error" });
    const conflict = await app.inject({ method: "GET", url: "/conflict" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ statusCode: 409, message: "already exists" });
  });

  it("keeps the status of a thrown plain object (the rate limiter's 429)", async () => {
    const app = build();
    const limited = await app.inject({ method: "GET", url: "/limited" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ statusCode: 429, error: "rate_limited", retryAfter: "1 minute" });
    const odd = await app.inject({ method: "GET", url: "/odd" });
    expect(odd.statusCode).toBe(500);
  });

  it("is not reported to error tracking, while a real failure is", async () => {
    // A transport that keeps envelopes in memory: nothing leaves the process.
    const envelopes: string[] = [];
    const transport: Sentry.NodeOptions["transport"] = (options) =>
      Sentry.createTransport(options, async (request) => {
        envelopes.push(typeof request.body === "string" ? request.body : Buffer.from(request.body).toString("utf8"));
        return { statusCode: 200 };
      });
    const app = build();
    const reporter = await registerErrorTracking(app, "portal-test", {
      env: { SENTRY_DSN: "https://publickey@sentry.example.invalid/1" },
      transport,
      processHandlers: false,
      ignore: isRequestValidationError
    });
    expect(reporter).not.toBeNull();

    expect((await app.inject({ method: "POST", url: "/thing", payload: { amountSats: "lots" } })).statusCode).toBe(400);
    await reporter!.flush(2000);
    expect(envelopes).toHaveLength(0);

    expect((await app.inject({ method: "GET", url: "/boom" })).statusCode).toBe(500);
    await reporter!.flush(2000);
    expect(envelopes).toHaveLength(1);
  });
});
