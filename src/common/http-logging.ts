// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyServerOptions } from "fastify";
import { redactMeta, SECRET_KEY_RE } from "./logger.js";

/*
 * #14: one logging setup for every Fastify service.
 * - pino JSON logs tagged with the service name and a per-request id.
 * - Incoming `x-request-id` is kept when it looks sane, otherwise a UUID is generated; it is
 *   echoed back. (Forwarding it on outbound calls between services is still to do, #14.)
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

/** Echo the request id so clients and upstream services can correlate. */
export function exposeRequestId(app: FastifyInstance): void {
  app.addHook("onSend", async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });
}
