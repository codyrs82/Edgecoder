// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { pino } from "pino";
import type { DestinationStream, Logger, LoggerOptions } from "pino";
import { CENSOR, REDACT_PATHS, redactMeta, redactUrl, scrubText } from "./redaction.js";
import { currentRequestContext } from "./request-context.js";

export { redactMeta, SECRET_KEY_RE } from "./redaction.js";

/*
 * #14: the one logger factory. Every log line in the services is pino JSON built from
 * `loggerOptions`, whether it comes from Fastify (http-logging.ts passes the same options),
 * from a service logger (`createLogger`), or from library code (`moduleLogger`, `log`).
 * So redaction, level and the request id behave the same everywhere.
 *
 * Request bodies are never logged by this module: the `req` serializer below is an allow-list
 * (method, redacted url, host, peer address). Code that chooses to log a body or headers still
 * goes through the redaction in redaction.ts.
 */

const LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

/** LOG_LEVEL, or "info" when it is unset or not a pino level (pino would throw at startup). */
export function logLevel(env: NodeJS.ProcessEnv = process.env): string {
  const level = env.LOG_LEVEL?.trim().toLowerCase() ?? "";
  return LEVELS.has(level) ? level : "info";
}

/**
 * Set on Fastify's per-request child logger (http-logging.ts), whose bindings already carry the
 * request id, so the mixin does not write the field twice. Children inherit it: pino children
 * are created with Object.create(parent).
 */
export const HAS_REQUEST_ID = Symbol("edgecoder.logger.hasRequestId");

// What module loggers report as `service` outside a request: the name the entry point gave the
// process (src/index.ts runs several services in one), else the one Fastify service built in it.
const builtServices = new Set<string>();
let processName: string | undefined;

/** Called for each Fastify service built in this process (http-logging.ts). */
export function nameProcessService(service: string): void {
  builtServices.add(service);
}

/** Names the whole process; wins over the services built in it. */
export function setProcessName(name: string): void {
  processName = name;
}

function processService(): string {
  if (processName) return processName;
  return builtServices.size === 1 ? [...builtServices][0]! : "edgecoder";
}

type RequestLike = { method?: string; url?: string; hostname?: string; ip?: string; socket?: { remotePort?: number } };

/**
 * pino options shared by every logger. With `service` the logger is bound to that service; without
 * it (module loggers) the service is resolved per line from the request being handled.
 */
export function loggerOptions(service: string | undefined, env: NodeJS.ProcessEnv = process.env): LoggerOptions {
  return {
    level: logLevel(env),
    // No pid/hostname: the platform's log shipper already tags the machine.
    base: service ? { service } : null,
    redact: { paths: REDACT_PATHS, censor: CENSOR },
    formatters: { log: (obj: Record<string, unknown>) => redactMeta(obj) as Record<string, unknown> },
    serializers: {
      req: (req: RequestLike) => ({
        method: req.method,
        url: redactUrl(req.url ?? ""),
        host: req.hostname,
        remoteAddress: req.ip,
        remotePort: req.socket?.remotePort
      })
    },
    hooks: {
      // Message strings and printf-style arguments bypass formatters.log.
      logMethod(args, method) {
        const scrubbed: unknown[] = args.map((a) => (typeof a === "string" ? scrubText(a) : a));
        // Without a message pino copies the error's own, unscrubbed: log.error(err), log.error({ err }).
        const first = scrubbed[0];
        if (scrubbed[1] === undefined && first !== null && typeof first === "object") {
          const err = first instanceof Error ? first : (first as { err?: unknown }).err;
          const message = (err as { message?: unknown } | null | undefined)?.message;
          if (typeof message === "string") scrubbed[1] = scrubText(message);
        }
        method.apply(this, scrubbed as typeof args);
      }
    },
    // Stamps the request id on lines written during a request through a logger that is not the
    // request's own (app.log, module loggers). Returns a fresh object: pino merges into it.
    mixin(_obj: object, _level: number, logger: object) {
      const context = currentRequestContext();
      const fields: Record<string, unknown> = {};
      if (!service) fields.service = context?.service ?? processService();
      if (context && !(logger as { [HAS_REQUEST_ID]?: boolean })[HAS_REQUEST_ID]) fields.requestId = context.requestId;
      return fields;
    }
  };
}

export interface CreateLoggerOptions {
  env?: NodeJS.ProcessEnv;
  /** Where lines go; stdout when omitted. Tests pass a capturing stream. */
  destination?: DestinationStream;
}

/** A logger for one service, e.g. for startup code that runs before the Fastify app exists. */
export function createLogger(service: string, opts: CreateLoggerOptions = {}): Logger {
  const options = loggerOptions(service, opts.env);
  return opts.destination ? pino(options, opts.destination) : pino(options);
}

let root: Logger | undefined;
function rootLogger(): Logger {
  root ??= pino(loggerOptions(undefined));
  return root;
}

/**
 * A logger for code that is not tied to one service (mesh, economy, model routing, ...). Lines
 * carry `component`, the service handling the current request (or the process's service), and the
 * request id when there is one.
 */
export function moduleLogger(component: string): Logger {
  return rootLogger().child({ component });
}

/** Message-first helper kept for existing callers; same pipeline as every other logger. */
export const log = {
  info(message: string, meta?: unknown): void {
    rootLogger().info(meta === undefined ? {} : { meta }, message);
  },
  warn(message: string, meta?: unknown): void {
    rootLogger().warn(meta === undefined ? {} : { meta }, message);
  },
  error(message: string, meta?: unknown): void {
    rootLogger().error(meta === undefined ? {} : { meta }, message);
  }
};
