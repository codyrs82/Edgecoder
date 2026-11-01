// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import * as undici from "undici";
import type { Dispatcher } from "undici";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { redactMeta, SECRET_KEY_RE } from "./logger.js";

/*
 * #14: one logging setup for every Fastify service.
 * - pino JSON logs tagged with the service name and a per-request id.
 * - Incoming `x-request-id` is kept when it looks sane, otherwise a UUID is generated; it is
 *   echoed back, and forwarded on outbound undici/fetch calls to the other EdgeCoder services
 *   (installRequestIdForwarding below), so one id follows a request across services.
 * - Secrets are redacted before anything is written: pino `redact` paths for known headers, plus
 *   the deep, case-insensitive `redactMeta` rule (logger.ts) as the `formatters.log` hook.
 * - Query-string values for secret-looking keys are masked in the logged `url` (e.g. ?token=).
 */

export const REQUEST_ID_HEADER = "x-request-id";
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

const SECRET_HEADERS = [
  "authorization",
  "cookie",
  "set-cookie",
  "x-mesh-token",
  "x-inference-token",
  "x-admin-token",
  "x-portal-service-token",
  "x-payment-signature",
  "x-coordinator-signature"
];
const SECRET_FIELDS = [
  "password", "Password", "token", "accessToken", "refreshToken", "apiToken", "meshToken", "sessionToken",
  "secret", "privateKey", "privateKeyPem", "mnemonic", "seed", "seedPhrase", "apiKey", "api_key", "xprv", "wif"
];

/** Paths that must never reach a log line: secret headers wherever headers are logged, and secret body fields. */
export const REDACT_PATHS = [
  ...SECRET_HEADERS.flatMap((h) => [`req.headers["${h}"]`, `res.headers["${h}"]`, `headers["${h}"]`, `*.headers["${h}"]`]),
  ...SECRET_FIELDS.flatMap((f) => [f, `*.${f}`, `*.*.${f}`, `*.*.*.${f}`])
];

/** Mask query values whose key looks secret (`?token=abc` -> `?token=[redacted]`). */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  let changed = false;
  for (const key of [...params.keys()]) {
    if (SECRET_KEY_RE.test(key)) {
      params.set(key, "[redacted]");
      changed = true;
    }
  }
  return changed ? `${url.slice(0, q)}?${params.toString()}` : url;
}

export function requestIdFrom(header: unknown): string {
  const v = Array.isArray(header) ? header[0] : header;
  return typeof v === "string" && REQUEST_ID_RE.test(v) ? v : randomUUID();
}

export function serviceLoggerOptions(service: string, env: NodeJS.ProcessEnv = process.env): Pick<
  FastifyServerOptions,
  "logger" | "genReqId" | "requestIdLogLabel"
> {
  return {
    logger: {
      level: env.LOG_LEVEL?.trim() || "info",
      base: { service },
      redact: { paths: REDACT_PATHS, censor: "[redacted]" },
      formatters: { log: (obj: Record<string, unknown>) => redactMeta(obj) as Record<string, unknown> },
      serializers: {
        req: (req: { method?: string; url?: string; hostname?: string; ip?: string; socket?: { remotePort?: number } }) => ({
          method: req.method,
          url: redactUrl(req.url ?? ""),
          host: req.hostname,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort
        })
      }
    },
    genReqId: (req) => requestIdFrom(req.headers[REQUEST_ID_HEADER]),
    requestIdLogLabel: "requestId"
  };
}

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

/** The id of the request being handled, if any (undefined outside a request). */
export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
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
  app.addHook("onRequest", (req, _reply, done) => {
    requestContext.run({ requestId: String(req.id) }, done);
  });
  app.addHook("onSend", async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });
}
