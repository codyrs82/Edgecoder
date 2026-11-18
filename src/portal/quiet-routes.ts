// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";

/**
 * Route options for high-frequency machine-to-machine routes (coordinators' /internal/nodes/validate
 * and /internal/nodes/lookup, several a second, and health checks): Fastify's "incoming request" /
 * "request completed" lines are info, so at "warn" they're dropped and useful lines (such as
 * portal_web_decision) stay in the short `fly logs` buffer. Warnings and errors still log.
 */
export const QUIET_ROUTE = { logLevel: "warn" } as const;

/**
 * The security-relevant answers of quiet routes still log, at warn: a refused token or credential
 * (401, 403) and server errors (5xx). Add to the plugin (or app) that registers the quiet routes.
 * Routes that aren't quiet already log every request at info.
 */
export function logQuietRouteRefusals(app: FastifyInstance): void {
  app.addHook("onResponse", async (req, reply) => {
    if (req.routeOptions?.logLevel !== QUIET_ROUTE.logLevel) return;
    const statusCode = reply.statusCode;
    if (statusCode !== 401 && statusCode !== 403 && statusCode < 500) return;
    req.log.warn({ method: req.method, url: req.routeOptions.url, statusCode, remoteAddress: req.ip }, "quiet_route_refused");
  });
}
