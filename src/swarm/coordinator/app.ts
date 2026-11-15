// Copyright (c) 2025 EdgeCoder, LLC
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

/** The coordinator's Fastify instance type. Route modules take it as `registerXRoutes(app)`. */
export type CoordinatorApp = typeof app;
