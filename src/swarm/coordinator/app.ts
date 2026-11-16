// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The coordinator's Fastify instance and the plugins every request passes through.
 * Evaluated first: every other coordinator module imports this one, directly or indirectly.
 */
import { DESKTOP_APP_ORIGINS } from "../../common/desktop-origins.js";
import Fastify from "fastify";
import { exposeRequestId, serviceLoggerOptions } from "../../common/http-logging.js";
import { registerMetrics } from "../../common/metrics.js";
import { registerErrorTracking } from "../../common/error-tracking.js";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { installRawBodyCapture } from "../../security/request-signing.js";
import { isAgentRateLimitedError } from "../../security/agent-rate-limiter.js";

export const app = Fastify({ ...serviceLoggerOptions("coordinator") });
exposeRequestId(app);

// The coordinator gauges are attached in coordinator.ts, once the modules they read are loaded.
export const metrics = registerMetrics(app, "coordinator");
await registerErrorTracking(app, "coordinator");
// #118 review: keep the exact request bytes so signed bodies (forwarded /result, agent requests)
// are verified against what was sent, not a re-serialization.
installRawBodyCapture(app);
await app.register(cors, {
  origin: [...DESKTOP_APP_ORIGINS],
  credentials: true,
});
await app.register(websocket);

// A signed agent request over its per-identity limit (thrown from verifyAgentRequest) is answered
// 429 with Retry-After and a stable error code. Every other error goes on to Fastify's default
// handler, unchanged.
app.setErrorHandler((error, _req, reply) => {
  if (isAgentRateLimitedError(error)) {
    return reply.code(429).headers(error.headers).send({ error: "agent_rate_limited", retryAfterMs: error.retryAfterMs });
  }
  throw error;
});

/** The coordinator's Fastify instance type. Route modules take it as `registerXRoutes(app)`. */
export type CoordinatorApp = typeof app;
