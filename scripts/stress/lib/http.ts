// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * HTTP for the load generator: undici with a keep-alive pool per origin, every call timed and
 * recorded under a stable endpoint name. Secrets never reach the recorder: request evidence keeps
 * the method, a redacted URL and a body excerpt, and headers are not recorded at all.
 */
import { Agent, request, type Dispatcher } from "undici";
import type { Recorder } from "./metrics.js";

const dispatchers = new Map<string, Dispatcher>();

function dispatcherFor(url: string, ca?: string, servername?: string): Dispatcher {
  const origin = new URL(url).origin;
  const key = `${origin}|${ca ? "ca" : ""}|${servername ?? ""}`;
  let d = dispatchers.get(key);
  if (!d) {
    d = new Agent({
      connections: 512,
      pipelining: 1,
      keepAliveTimeout: 30_000,
      connect: ca ? { ca, rejectUnauthorized: true, ...(servername ? { servername } : {}), timeout: 10_000 } : { timeout: 10_000 }
    });
    dispatchers.set(key, d);
  }
  return d;
}

export async function closeDispatchers(): Promise<void> {
  await Promise.all([...dispatchers.values()].map((d) => d.close().catch(() => undefined)));
  dispatchers.clear();
}

export interface CallOptions {
  method?: "GET" | "POST" | "DELETE";
  headers?: Record<string, string>;
  /** Exact bytes to send (signed requests hash these). Objects are JSON-encoded. */
  body?: string | object;
  timeoutMs?: number;
  /** PEM CA for a self-signed TLS endpoint (LND). */
  ca?: string;
  /** TLS name to check the certificate against (e.g. "localhost" when dialling 127.0.0.1). */
  servername?: string;
  /** Record evidence for non-2xx outcomes (default true). */
  evidence?: boolean;
  /** Statuses that are the expected answer here (a poll's 404, an attack's 401): not errors. */
  expected?: number[];
}

export interface CallResult<T = any> {
  status: number;
  /** "200", "409:duplicate_task", "0:ECONNREFUSED", ... */
  outcome: string;
  json: T;
  text: string;
  ms: number;
}

const SECRETISH = /(eck_[A-Za-z0-9_-]+|lnbcrt[0-9a-z]+|[0-9a-f]{64,})/gi;

export function redact(s: string, max = 600): string {
  const r = s.replace(SECRETISH, (m) => `${m.slice(0, 8)}…[${m.length}]`);
  return r.length > max ? `${r.slice(0, max)}…(+${r.length - max})` : r;
}

/** The error code a JSON body names (error / code / error.type), for outcome keys. */
export function errorCodeOf(json: any): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const v = typeof json.error === "string" ? json.error : typeof json.code === "string" ? json.code : typeof json.error?.type === "string" ? json.error.type : typeof json.reason === "string" ? json.reason : undefined;
  return v ? String(v).slice(0, 60) : undefined;
}

export async function call<T = any>(rec: Recorder | null, endpoint: string, url: string, opts: CallOptions = {}): Promise<CallResult<T>> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const body = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";
  const started = performance.now();
  let status = 0;
  let text = "";
  let json: any = undefined;
  let outcome: string;
  try {
    const res = await request(url, {
      method,
      headers,
      body,
      dispatcher: dispatcherFor(url, opts.ca, opts.servername),
      headersTimeout: opts.timeoutMs ?? 30_000,
      bodyTimeout: opts.timeoutMs ?? 30_000
    });
    status = res.statusCode;
    text = await res.body.text();
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    const code = status >= 300 ? errorCodeOf(json) : undefined;
    outcome = code ? `${status}:${code}` : String(status);
    if (opts.expected?.includes(status)) outcome = `expected:${outcome}`;
  } catch (err) {
    const e = err as { code?: string; name?: string; message?: string };
    outcome = `0:${e.code ?? e.name ?? "error"}`;
    text = e.message ?? String(err);
  }
  const ms = performance.now() - started;
  if (rec) {
    rec.record(endpoint, ms, outcome, opts.evidence === false ? undefined : {
      request: { method, url: redact(url, 200), ...(body !== undefined ? { body: redact(body, 400) } : {}) },
      response: { status, body: redact(text, 600) }
    });
  }
  return { status, outcome, json: json as T, text, ms };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
