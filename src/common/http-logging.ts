// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyServerOptions } from "fastify";

/*
 * #14: one logging setup for every Fastify service.
 * - pino JSON logs tagged with the service name and a per-request id.
 * - Incoming `x-request-id` is kept when it looks sane (so a request can be followed across
 *   coordinator -> inference -> portal), otherwise a UUID is generated; it is echoed back.
 * - Secrets in headers and common body fields are redacted before anything is written.
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
const SECRET_FIELDS = ["password", "token", "secret", "privateKeyPem", "mnemonic", "seedPhrase", "apiKey"];

/** Paths that must never reach a log line: secret headers wherever headers are logged, and secret body fields. */
export const REDACT_PATHS = [
  ...SECRET_HEADERS.flatMap((h) => [`req.headers["${h}"]`, `res.headers["${h}"]`, `headers["${h}"]`, `*.headers["${h}"]`]),
  ...SECRET_FIELDS.flatMap((f) => [f, `*.${f}`, `*.*.${f}`])
];

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
      redact: { paths: REDACT_PATHS, censor: "[redacted]" }
    },
    genReqId: (req) => requestIdFrom(req.headers[REQUEST_ID_HEADER]),
    requestIdLogLabel: "requestId"
  };
}

/** Echo the request id so clients and upstream services can correlate. */
export function exposeRequestId(app: FastifyInstance): void {
  app.addHook("onSend", async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });
}
