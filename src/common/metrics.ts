// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

/*
 * #14: Prometheus /metrics for every Fastify service, with no extra dependency.
 * Exposes, in the text exposition format (version 0.0.4):
 *   edgecoder_http_requests_total{service,method,route,status}          counter
 *   edgecoder_http_request_duration_seconds{service,method,route}        histogram
 *   edgecoder_process_uptime_seconds / _resident_memory_bytes / _heap_used_bytes  gauges
 * `route` is the Fastify route pattern (e.g. /nodes/:nodeId), never the raw URL, so ids and
 * query strings can't blow up cardinality or leak into metrics. Unmatched requests use "unmatched".
 *
 * The inference service already had a JSON /metrics, which is kept; its Prometheus endpoint is
 * /metrics/prometheus.
 *
 * Access: when METRICS_TOKEN is set, /metrics needs `Authorization: Bearer <token>`.
 * In production without METRICS_TOKEN, /metrics is not registered at all (404), so it is
 * never public by accident. Outside production it is open, for local scraping.
 */

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type Labels = Record<string, string>;

function labelString(labels: Labels): string {
  const parts = Object.entries(labels).map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

export class MetricsRegistry {
  private counts = new Map<string, { labels: Labels; value: number }>();
  private hists = new Map<string, { labels: Labels; buckets: number[]; sum: number; count: number }>();

  constructor(readonly service: string) {}

  observeRequest(method: string, route: string, status: number, seconds: number): void {
    const cl = { service: this.service, method, route, status: String(status) };
    const ck = JSON.stringify(cl);
    const c = this.counts.get(ck) ?? { labels: cl, value: 0 };
    c.value += 1;
    this.counts.set(ck, c);

    const hl = { service: this.service, method, route };
    const hk = JSON.stringify(hl);
    const h = this.hists.get(hk) ?? { labels: hl, buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) h.buckets[i] += 1;
    });
    h.sum += seconds;
    h.count += 1;
    this.hists.set(hk, h);
  }

  render(): string {
    const out: string[] = [];
    out.push("# HELP edgecoder_http_requests_total HTTP requests handled, by route pattern and status.");
    out.push("# TYPE edgecoder_http_requests_total counter");
    for (const { labels, value } of this.counts.values()) out.push(`edgecoder_http_requests_total${labelString(labels)} ${value}`);

    out.push("# HELP edgecoder_http_request_duration_seconds HTTP request duration in seconds.");
    out.push("# TYPE edgecoder_http_request_duration_seconds histogram");
    for (const { labels, buckets, sum, count } of this.hists.values()) {
      BUCKETS.forEach((b, i) => out.push(`edgecoder_http_request_duration_seconds_bucket${labelString({ ...labels, le: String(b) })} ${buckets[i]}`));
      out.push(`edgecoder_http_request_duration_seconds_bucket${labelString({ ...labels, le: "+Inf" })} ${count}`);
      out.push(`edgecoder_http_request_duration_seconds_sum${labelString(labels)} ${sum}`);
      out.push(`edgecoder_http_request_duration_seconds_count${labelString(labels)} ${count}`);
    }

    const mem = process.memoryUsage();
    const svc = labelString({ service: this.service });
    out.push("# HELP edgecoder_process_uptime_seconds Process uptime in seconds.");
    out.push("# TYPE edgecoder_process_uptime_seconds gauge");
    out.push(`edgecoder_process_uptime_seconds${svc} ${process.uptime()}`);
    out.push("# HELP edgecoder_process_resident_memory_bytes Resident set size in bytes.");
    out.push("# TYPE edgecoder_process_resident_memory_bytes gauge");
    out.push(`edgecoder_process_resident_memory_bytes${svc} ${mem.rss}`);
    out.push("# HELP edgecoder_process_heap_used_bytes V8 heap used in bytes.");
    out.push("# TYPE edgecoder_process_heap_used_bytes gauge");
    out.push(`edgecoder_process_heap_used_bytes${svc} ${mem.heapUsed}`);
    return `${out.join("\n")}\n`;
  }
}

function bearerMatches(header: unknown, token: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const METRICS_PATH = "/metrics";

/** Count and time every request, and serve /metrics (see access rules above). */
export function registerMetrics(
  app: FastifyInstance,
  service: string,
  opts: { path?: string; env?: NodeJS.ProcessEnv } = {}
): MetricsRegistry {
  const env = opts.env ?? process.env;
  const path = opts.path ?? METRICS_PATH;
  const registry = new MetricsRegistry(service);
  const token = env.METRICS_TOKEN?.trim() ?? "";
  const production = (env.NODE_ENV ?? "").trim() === "production";

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions?.url ?? "unmatched";
    if (route === path) return;
    registry.observeRequest(req.method, route, reply.statusCode, reply.elapsedTime / 1000);
  });

  if (production && !token) return registry;

  app.get(path, async (req, reply) => {
    if (token && !bearerMatches(req.headers.authorization, token)) {
      return reply.code(401).send({ error: "metrics_token_required" });
    }
    return reply.type("text/plain; version=0.0.4; charset=utf-8").send(registry.render());
  });
  return registry;
}
