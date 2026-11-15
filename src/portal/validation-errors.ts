// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";

/** True for the error a route's `schema.parse(req.body | req.query | req.params)` throws. */
export function isRequestValidationError(error: unknown): error is ZodError {
  return error instanceof ZodError;
}

/**
 * Portal routes validate input with `schema.parse(...)`, which throws. Without this handler the
 * throw reaches Fastify's default handler and a malformed body is answered 500, as if the
 * server had failed. It is the caller's mistake: answer 400 and say which fields are wrong.
 *
 * The portal only uses a throwing `parse` on request input (upstream responses are checked with
 * `safeParse`), so every ZodError that gets here is a bad request. Everything else is answered
 * exactly as Fastify's default handler would answer it.
 */
export function registerRequestValidationErrors(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, _req, reply) => {
    if (isRequestValidationError(error)) {
      return reply.code(400).send({
        error: "invalid_request",
        // Field path and the rule it broke; never the submitted value.
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code }))
      });
    }
    // An Error sent from a root error handler goes on to Fastify's default handler.
    if (error instanceof Error) return reply.send(error);
    // Anything else thrown (the rate limiter throws a plain `{ statusCode: 429, ... }` body) is
    // sent as an ordinary payload, so its status and headers have to be applied here, the way
    // the default handler applies them. Without this a 429 would go out as a 200.
    const thrown = (error ?? {}) as { status?: unknown; statusCode?: unknown; headers?: unknown };
    if (thrown.headers && typeof thrown.headers === "object") reply.headers(thrown.headers as Record<string, string>);
    return reply.code(thrownStatus(thrown.status) ?? thrownStatus(thrown.statusCode) ?? 500).send(error);
  });
}

function thrownStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}
