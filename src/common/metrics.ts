// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
// The only importer of prom-client, so the library can be swapped in one file.
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

/*
 * #14: Prometheus /metrics for every Fastify service (text exposition format 0.0.4).
 *   edgecoder_http_requests_total{service,method,route,status_class}             counter
 *   edgecoder_http_request_duration_seconds{service,method,route,status_class}   histogram
 *   process_* / nodejs_*    prom-client's default process metrics (one set per process)
 *   plus the domain gauges each service registers (queue depth, connected agents, ...).
 * `route` is the Fastify route pattern (e.g. /nodes/:nodeId), never the raw URL, so ids, tokens
 * and query strings can neither leak into metrics nor blow up cardinality. Requests that match
 * no route are counted under "unmatched".
 *
 * The inference service already had a JSON /metrics, which is kept; its Prometheus endpoint is
 * /metrics/prometheus.
 *
 * Access. The services sit on the public internet behind an edge proxy, so /metrics is never
 * public:
 *   - a loopback caller (same machine, no proxy in between) is served;
 *   - anyone else needs `Authorization: Bearer <METRICS_TOKEN>`: 401 when it is missing or wrong;
 *   - when METRICS_TOKEN is unset, anyone else gets the service's ordinary 404, so the endpoint
 *     cannot be told apart from a route that does not exist.
 */

export const METRICS_PATH = "/metrics";

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export function statusClass(status: number): string {
  return status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : "other";
}

// One process, one set of process metrics, however many services it hosts (src/index.ts runs
// three). Started on first use so importing this module has no side effects.
let processRegistry: Registry | undefined;
function processMetrics(): Registry {
  if (!processRegistry) {
    processRegistry = new Registry();
    collectDefaultMetrics({ register: processRegistry });
  }
  return processRegistry;
}

export class ServiceMetrics {
  readonly registry = new Registry();
  private readonly requests: Counter<"method" | "route" | "status_class">;
  private readonly duration: Histogram<"method" | "route" | "status_class">;

  constructor(readonly service: string) {
    this.registry.setDefaultLabels({ service });
    this.requests = new Counter({
      name: "edgecoder_http_requests_total",
      help: "HTTP requests handled, by method, route pattern and status class.",
      labelNames: ["method", "route", "status_class"],
      registers: [this.registry]
    });
    this.duration = new Histogram({
      name: "edgecoder_http_request_duration_seconds",
      help: "HTTP request duration in seconds, by method, route pattern and status class.",
      labelNames: ["method", "route", "status_class"],
      buckets: BUCKETS,
      registers: [this.registry]
    });
  }

  observeRequest(method: string, route: string, status: number, seconds: number): void {
    const labels = { method: METHODS.has(method) ? method : "OTHER", route, status_class: statusClass(status) };
    this.requests.inc(labels);
    this.duration.observe(labels, seconds);
  }

  /**
   * A gauge read from existing state when /metrics is scraped. `read` must be cheap (no I/O);
   * a throwing or non-finite read is reported as NaN rather than failing the whole scrape.
   */
  gauge(name: string, help: string, read: () => number): void {
    new Gauge({
      name,
      help,
      registers: [this.registry],
      collect() {
        let value = Number.NaN;
        try {
          value = read();
        } catch {
          // keep NaN
        }
        this.set(Number.isFinite(value) ? value : Number.NaN);
      }
    });
  }

  /**
   * A one-of-N state as `name{<label>="<state>"} 0|1`, the Prometheus convention for enums.
   * `states` must be a fixed list: it is the label's whole value set.
   */
  stateGauge<S extends string>(name: string, help: string, label: string, states: readonly S[], read: () => S | undefined): void {
    new Gauge({
      name,
      help,
      labelNames: [label],
      registers: [this.registry],
      collect() {
        let current: S | undefined;
        try {
          current = read();
        } catch {
          // report no state
        }
        for (const state of states) this.set({ [label]: state }, state === current ? 1 : 0);
      }
    });
  }

  async render(): Promise<string> {
    return `${await this.registry.metrics()}\n${await processMetrics().metrics()}`;
  }
}

function tokenMatches(header: unknown, token: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7).trim());
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.startsWith("::ffff:") ? address.slice(7) : address;
  return a === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function isLoopbackHost(host: unknown): boolean {
  if (typeof host !== "string") return false;
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name === "localhost" || name === "[::1]" || isLoopbackAddress(name);
}

// A proxy on the same machine (cloudflared, nginx, a sidecar) connects from 127.0.0.1 on behalf
// of the internet. Any of these headers means the request was relayed.
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-real-ip", "forwarded", "via", "cf-connecting-ip", "cf-ray", "fly-client-ip"];

/**
 * True only for a direct connection from this machine: loopback peer address (the socket's, not
 * `req.ip`, which trustProxy can make client-controlled), no proxy headers, and a loopback Host
 * (a browser tricked into calling 127.0.0.1 under another name, i.e. DNS rebinding, fails this).
 */
export function isLoopbackCaller(req: Pick<FastifyRequest, "headers" | "socket">): boolean {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  if (PROXY_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  return isLoopbackHost(req.headers.host);
}

export type MetricsAccess = "allowed" | "unauthorized" | "hidden";

export function metricsAccess(req: Pick<FastifyRequest, "headers" | "socket">, token: string): MetricsAccess {
  if (isLoopbackCaller(req)) return "allowed";
  if (!token) return "hidden";
  return tokenMatches(req.headers.authorization, token) ? "allowed" : "unauthorized";
}

/** METRICS_TOKEN is read here and nowhere else. */
export function metricsToken(env: NodeJS.ProcessEnv = process.env): string {
  return env.METRICS_TOKEN?.trim() ?? "";
}

/** Count and time every request, and serve /metrics (see access rules above). */
export function registerMetrics(
  app: FastifyInstance,
  service: string,
  opts: { path?: string; env?: NodeJS.ProcessEnv } = {}
): ServiceMetrics {
  const path = opts.path ?? METRICS_PATH;
  const metrics = new ServiceMetrics(service);
  const token = metricsToken(opts.env);

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unmatched";
    if (route === path) return;
    metrics.observeRequest(req.method, route, reply.statusCode, reply.elapsedTime / 1000);
  });

  app.get(path, async (req, reply) => {
    const access = metricsAccess(req, token);
    if (access === "hidden") return reply.callNotFound();
    if (access === "unauthorized") {
      return reply.code(401).header("www-authenticate", "Bearer").send({ error: "metrics_token_required" });
    }
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(await metrics.render());
  });
  return metrics;
}
