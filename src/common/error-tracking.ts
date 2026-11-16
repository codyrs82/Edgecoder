// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";
// Types only: the SDK itself is imported lazily, and only when SENTRY_DSN is set.
import type * as SentryNode from "@sentry/node";
import type { ErrorEvent } from "@sentry/node";
import { moduleLogger } from "./logger.js";
import { redactMeta, scrubText, stripQuery } from "./redaction.js";

/*
 * #14: error tracking through Sentry, off unless SENTRY_DSN is set.
 * - SENTRY_DSN unset (the default): the SDK is never imported, nothing is hooked, no network.
 * - SENTRY_DSN set: `@sentry/node` is imported at startup and reports
 *     - errors that reach Fastify's error handling with a 5xx status (4xx are the caller's), and
 *     - uncaughtException / unhandledRejection, after which the process still exits with code 1.
 *   Events are tagged with service, request id and route pattern; release is the app version and
 *   environment is NODE_ENV.
 * - A bare client is used instead of Sentry.init(): no global state, no OpenTelemetry setup, no
 *   patching of http or other modules, so turning the DSN on cannot change request handling.
 * - Nothing about the request other than those tags is attached, and scrubEvent runs on every
 *   event before it is sent: no bodies, cookies, headers or query strings.
 */

const FLUSH_TIMEOUT_MS = 2_000;
const logger = moduleLogger("error-tracking");

export interface ErrorTrackingConfig {
  dsn: string;
  environment: string;
  release: string | undefined;
}

function appVersion(): string | undefined {
  try {
    // src/common or dist/common -> repo root package.json
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** The only place the SENTRY_* variables are read. Null when error tracking is off. */
export function errorTrackingConfig(env: NodeJS.ProcessEnv = process.env): ErrorTrackingConfig | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  const version = appVersion();
  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.NODE_ENV?.trim() || "development",
    release: env.SENTRY_RELEASE?.trim() || (version ? `edgecoder@${version}` : undefined)
  };
}

// `?a=b&c=d` after something path-like, anywhere in a message.
const QUERY_IN_TEXT_RE = /([\w/.:%\]-])\?[\w.~%[\]-]+=[^\s"'<>)]*/g;

function scrubMessage(text: string): string {
  return scrubText(text).replace(QUERY_IN_TEXT_RE, "$1");
}

/**
 * Last line of defence before an event leaves the process. We never attach request data, but an
 * integration or a future change might, and error messages can quote URLs.
 */
export function scrubEvent<E extends ErrorEvent>(event: E): E {
  if (event.request) {
    // Keep only what identifies the endpoint: no data (body), cookies, headers, query_string, env.
    event.request = { method: event.request.method, url: event.request.url ? stripQuery(event.request.url) : undefined };
  }
  delete event.user;
  delete event.breadcrumbs;
  if (event.extra) event.extra = redactMeta(event.extra) as Record<string, unknown>;
  if (event.message) event.message = scrubMessage(event.message);
  if (event.transaction) event.transaction = stripQuery(event.transaction);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubMessage(exception.value);
  }
  return event;
}

export type ErrorTags = Record<string, string | undefined>;

export interface ErrorReporter {
  captureException(error: unknown, tags?: ErrorTags): void;
  /** Resolves true when everything queued was sent within the timeout. */
  flush(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export interface ErrorTrackingOptions {
  env?: NodeJS.ProcessEnv;
  /** Replaces the HTTP transport (tests). */
  transport?: SentryNode.NodeOptions["transport"];
  /** Replaces the lazy import (tests). */
  load?: () => Promise<typeof SentryNode>;
  /** Report uncaughtException/unhandledRejection too. Default true; tests turn it off. */
  processHandlers?: boolean;
  /** Handler errors the service answers as a client error (4xx) although they carry no statusCode. */
  ignore?: (error: unknown) => boolean;
}

/** A reporter for `service`, or null when SENTRY_DSN is unset (or the SDK cannot be loaded). */
export async function initErrorTracking(service: string, opts: ErrorTrackingOptions = {}): Promise<ErrorReporter | null> {
  const config = errorTrackingConfig(opts.env);
  if (!config) return null;
  let sentry: typeof SentryNode;
  try {
    sentry = await (opts.load ?? (() => import("@sentry/node")))();
  } catch (error) {
    // Never take a service down over its error reporting.
    logger.warn({ err: error, service }, "SENTRY_DSN is set but @sentry/node could not be loaded; error tracking is off");
    return null;
  }
  const client = new sentry.NodeClient({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    transport: opts.transport ?? sentry.makeNodeTransport,
    stackParser: sentry.defaultStackParser,
    // Pure event processors only; nothing here instruments modules or reads request data.
    integrations: [sentry.linkedErrorsIntegration()],
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event)
  });
  const scope = new sentry.Scope();
  scope.setClient(client);
  scope.setTag("service", service);
  client.init();
  logger.info({ service, environment: config.environment, release: config.release }, "error tracking enabled");

  return {
    captureException(error, tags) {
      const set: Record<string, string> = {};
      for (const [k, v] of Object.entries(tags ?? {})) if (v) set[k] = v;
      scope.captureException(error, { captureContext: { tags: set } });
    },
    flush: async (timeoutMs = FLUSH_TIMEOUT_MS) => client.flush(timeoutMs),
    close: async () => {
      await client.close(FLUSH_TIMEOUT_MS);
    }
  };
}

type ProcessLike = Pick<NodeJS.Process, "on">;

/**
 * The handler for a fatal process error: log it, report it, give the report a bounded time to
 * leave, then exit 1. Node's default for both events is to print the error and exit 1; a listener
 * replaces that default, so the exit has to be explicit here.
 */
export function fatalErrorHandler(reporter: ErrorReporter, exit: (code: number) => void = (code) => process.exit(code)) {
  let handling = false;
  return (kind: "uncaughtException" | "unhandledRejection") => (error: unknown): void => {
    if (handling) return; // a second failure while flushing must not restart the sequence
    handling = true;
    logger.fatal({ err: error }, kind);
    try {
      reporter.captureException(error, { mechanism: kind });
    } catch {
      // still exit
    }
    void reporter
      .flush(FLUSH_TIMEOUT_MS)
      .catch(() => false)
      .then(() => exit(1));
  };
}

let processHandlersInstalled = false;

/** Once per process, however many services it hosts. */
export function installProcessErrorHandlers(reporter: ErrorReporter, target: ProcessLike = process): void {
  if (target === process) {
    if (processHandlersInstalled) return;
    processHandlersInstalled = true;
  }
  const handler = fatalErrorHandler(reporter);
  target.on("uncaughtException", handler("uncaughtException"));
  target.on("unhandledRejection", handler("unhandledRejection"));
}

/** Report 5xx handler errors and fatal process errors when SENTRY_DSN is set; a no-op otherwise. */
export async function registerErrorTracking(
  app: FastifyInstance,
  service: string,
  opts: ErrorTrackingOptions = {}
): Promise<ErrorReporter | null> {
  const reporter = await initErrorTracking(service, opts);
  if (!reporter) return null;
  app.addHook("onError", async (req, _reply, error) => {
    // Thrown errors without a statusCode become 500s (reply.statusCode is not set yet here).
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status < 500) return;
    if (opts.ignore?.(error)) return;
    reporter.captureException(error, {
      requestId: String(req.id),
      // The pattern, never the raw URL: ids and query strings stay out of the report.
      route: req.routeOptions?.url ?? "unmatched",
      method: req.method
    });
  });
  if (opts.processHandlers !== false) installProcessErrorHandlers(reporter);
  return reporter;
}
