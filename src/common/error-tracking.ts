// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { FastifyInstance } from "fastify";

/*
 * #14: optional error tracking. Off unless SENTRY_DSN is set.
 * - SENTRY_DSN unset (the default): no hook, no import, no network.
 * - SENTRY_DSN set: loads `@sentry/node` at startup. It is not a dependency of this repo; add it
 *   to the image that wants it. If it can't be loaded, one warning is logged and the service runs
 *   normally. Only 5xx errors are reported, tagged with service, route and request id.
 *   Request bodies, headers and cookies are never attached (sendDefaultPii: false).
 */

export interface ErrorReporter {
  captureException(error: unknown, context: Record<string, unknown>): void;
}

export type SentryLike = {
  init(opts: Record<string, unknown>): void;
  captureException(error: unknown, hint?: Record<string, unknown>): unknown;
};

const loadSentry = async (): Promise<SentryLike> => {
  const name = "@sentry/node"; // resolved at runtime only, so the build doesn't need the package
  return (await import(name)) as SentryLike;
};

export async function initErrorTracking(
  service: string,
  env: NodeJS.ProcessEnv = process.env,
  load: () => Promise<SentryLike> = loadSentry
): Promise<ErrorReporter | null> {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  let sentry: SentryLike;
  try {
    sentry = await load();
  } catch {
    console.warn(`[${service}] SENTRY_DSN is set but @sentry/node is not installed; error tracking is off.`);
    return null;
  }
  sentry.init({
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV || "development",
    release: env.SENTRY_RELEASE?.trim() || undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    initialScope: { tags: { service } }
  });
  return {
    captureException: (error, context) => {
      sentry.captureException(error, { tags: { service }, extra: context });
    }
  };
}

/** Report 5xx handler errors when SENTRY_DSN is set; a no-op otherwise. */
export async function registerErrorTracking(
  app: FastifyInstance,
  service: string,
  env: NodeJS.ProcessEnv = process.env,
  load?: () => Promise<SentryLike>
): Promise<ErrorReporter | null> {
  const reporter = await initErrorTracking(service, env, load);
  if (!reporter) return null;
  app.addHook("onError", async (req, _reply, error) => {
    // Thrown errors without a statusCode become 500s (reply.statusCode is not set yet here).
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) return;
    reporter.captureException(error, {
      requestId: String(req.id),
      method: req.method,
      route: req.routeOptions?.url ?? "unmatched"
    });
  });
  return reporter;
}
