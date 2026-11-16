// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import * as undici from "undici";
import type { Dispatcher } from "undici";
import type { FastifyBaseLogger, FastifyInstance, FastifyServerOptions } from "fastify";
import { HAS_REQUEST_ID, loggerOptions, nameProcessService } from "./logger.js";
import { currentRequestId, runWithRequestContext } from "./request-context.js";

export { REDACT_PATHS, redactUrl } from "./redaction.js";
export { currentRequestId } from "./request-context.js";

/*
 * #14: one logging setup for every Fastify service.
 * - pino JSON logs tagged with the service name and a per-request id, built from the shared
 *   options in logger.ts (level, redaction, serializers).
 * - Incoming `x-request-id` is kept when it looks sane, otherwise a UUID is generated; it is
 *   echoed back, and forwarded on outbound undici/fetch calls to the other EdgeCoder services
 *   (installRequestIdForwarding below), so one id follows a request across services.
 * - Secrets are redacted before anything is written (redaction.ts), and request bodies are not
 *   logged: Fastify's request lines carry only method, url (query secrets masked), host and peer.
 */

export const REQUEST_ID_HEADER = "x-request-id";
// Strict on purpose: the id is echoed in a response header and written to every log line, so it
// must not be able to carry header/log injection or unbounded data.
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestIdFrom(header: unknown): string {
  const v = Array.isArray(header) ? header[0] : header;
  return typeof v === "string" && REQUEST_ID_RE.test(v) ? v : randomUUID();
}

export function serviceLoggerOptions(service: string, env: NodeJS.ProcessEnv = process.env): Pick<
  FastifyServerOptions,
  "logger" | "genReqId" | "requestIdLogLabel" | "childLoggerFactory"
> {
  nameProcessService(service);
  return {
    logger: loggerOptions(service, env),
    genReqId: (req) => requestIdFrom(req.headers[REQUEST_ID_HEADER]),
    requestIdLogLabel: "requestId",
    // Fastify binds the request id on this child; mark it so the logger mixin does not repeat it.
    childLoggerFactory: (logger, bindings, opts) => {
      const child = logger.child(bindings, opts) as FastifyBaseLogger & { [HAS_REQUEST_ID]?: boolean };
      child[HAS_REQUEST_ID] = true;
      return child;
    }
  };
}

/** Internal service origins that get x-request-id forwarded. Third-party APIs never do. */
export function internalOrigins(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const raw = [
    env.COORDINATOR_URL,
    env.CONTROL_PLANE_URL,
    env.INFERENCE_URL,
    env.PORTAL_SERVICE_URL,
    env.COORDINATOR_PUBLIC_URL,
    ...(env.COORDINATOR_DISCOVERY_URLS ?? "").split(","),
    ...(env.REQUEST_ID_FORWARD_ORIGINS ?? "").split(",")
  ];
  const out = new Set<string>();
  for (const v of raw) {
    if (!v?.trim()) continue;
    try {
      out.add(new URL(v.trim()).origin);
    } catch {
      // not a URL; config validation reports it
    }
  }
  return out;
}

function hasHeader(headers: Dispatcher.DispatchOptions["headers"], name: string): boolean {
  if (!headers) return false;
  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) if (String(headers[i]).toLowerCase() === name) return true;
    return false;
  }
  if (typeof (headers as Iterable<unknown>)[Symbol.iterator] === "function") return false;
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

/** Add x-request-id to outbound dispatches whose origin is in `origins`, unless already set. */
export function requestIdInterceptor(origins: Set<string>): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) => (opts, handler) => {
    const id = currentRequestId();
    const origin = typeof opts.origin === "string" ? opts.origin : opts.origin?.origin;
    if (!id || !origin || !origins.has(new URL(origin).origin) || hasHeader(opts.headers, REQUEST_ID_HEADER)) {
      return dispatch(opts, handler);
    }
    const headers = opts.headers;
    let next: Dispatcher.DispatchOptions["headers"];
    if (!headers) next = { [REQUEST_ID_HEADER]: id };
    else if (Array.isArray(headers)) next = [...headers, REQUEST_ID_HEADER, id];
    else if (typeof (headers as Iterable<unknown>)[Symbol.iterator] === "function") return dispatch(opts, handler);
    else next = { ...(headers as Record<string, string>), [REQUEST_ID_HEADER]: id };
    return dispatch({ ...opts, headers: next }, handler);
  };
}

let forwardingInstalled = false;

/** Once per process: forward the current request id to internal services on every undici/fetch call. */
export function installRequestIdForwarding(env: NodeJS.ProcessEnv = process.env): void {
  if (forwardingInstalled) return;
  forwardingInstalled = true;
  try {
    undici.setGlobalDispatcher(undici.getGlobalDispatcher().compose(requestIdInterceptor(internalOrigins(env))));
  } catch {
    // undici stubbed out (unit tests that vi.mock("undici")): nothing to forward through.
  }
}

/**
 * Echo the request id so clients can correlate, make it the current id for the request's async
 * work (currentRequestId), and forward it on calls to the other services.
 */
export function exposeRequestId(app: FastifyInstance): void {
  installRequestIdForwarding();
  const service = (app.log as { bindings?: () => Record<string, unknown> }).bindings?.().service;
  app.addHook("onRequest", (req, _reply, done) => {
    runWithRequestContext({ requestId: String(req.id), service: typeof service === "string" ? service : undefined }, done);
  });
  app.addHook("onSend", async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });
}
