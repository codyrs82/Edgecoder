// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { BitcoinAnchorProvider } from "./bitcoin-rpc.js";
import type { BitcoinNetwork } from "../common/types.js";
import { anchorProxyHealth } from "./anchor-proxy-health.js";
import type { ServiceMetrics } from "../common/metrics.js";

/*
 * Route definitions for the anchor proxy (see anchor-proxy-service.ts), split out so the
 * routes can be tested with app.inject() (#116 review).
 *
 * `dataHex` everywhere is the raw OP_RETURN payload (what broadcastOpReturn embeds), not the
 * full script: at most 80 bytes = 160 hex chars, even length.
 */

export interface AnchorProxyOptions {
  token: string;
  provider: Required<Pick<BitcoinAnchorProvider, "findCheckpointTx" | "isInMempool" | "abandonTx">> & BitcoinAnchorProvider;
  network: BitcoinNetwork;
  maxBroadcastsPerMinute?: number;
  /** #116 review: shared budget for the reconciliation routes (find is expensive, abandon mutates the wallet). */
  maxReconcileCallsPerMinute?: number;
  now?: () => number;
  logger?: boolean;
  /** #14: logger/request-id options from serviceLoggerOptions(); overrides `logger` when set. */
  serverOptions?: Pick<FastifyServerOptions, "logger" | "genReqId" | "requestIdLogLabel" | "childLoggerFactory">;
  /** #14: filled in by the health routes so /metrics can report the node's state without its own RPC call. */
  stats?: AnchorProxyStats;
}

export interface AnchorProxyStats {
  bitcoindReachable?: boolean;
  blocks?: number;
  lastHealthCheckMs?: number;
}

/**
 * #14: anchor state for /metrics, as last seen by the health routes (Fly probes /health every
 * 30s), so a scrape costs no RPC call. NaN until the first health check.
 */
export function registerAnchorProxyMetrics(metrics: ServiceMetrics, stats: AnchorProxyStats): void {
  metrics.gauge("edgecoder_anchor_proxy_bitcoind_reachable", "1 when the last health check reached bitcoind, 0 when it did not.", () =>
    stats.bitcoindReachable === undefined ? Number.NaN : Number(stats.bitcoindReachable)
  );
  metrics.gauge("edgecoder_anchor_proxy_block_height", "Chain height reported by bitcoind at the last health check.", () => stats.blocks ?? Number.NaN);
  metrics.gauge("edgecoder_anchor_proxy_last_health_check_timestamp_seconds", "When bitcoind health was last checked.", () =>
    stats.lastHealthCheckMs === undefined ? Number.NaN : stats.lastHealthCheckMs / 1000
  );
}

const TXID_RE = /^[0-9a-fA-F]{64}$/;

export function isValidPayloadHex(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 160 && v.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(v);
}

class SlidingWindow {
  private hits: number[] = [];
  constructor(private readonly max: number, private readonly now: () => number) {}
  take(): boolean {
    const t = this.now();
    this.hits = this.hits.filter((ts) => t - ts < 60_000);
    if (this.hits.length >= this.max) return false;
    this.hits.push(t);
    return true;
  }
  current(): number {
    const t = this.now();
    return this.hits.filter((ts) => t - ts < 60_000).length;
  }
}

export function buildAnchorProxyApp(opts: AnchorProxyOptions): FastifyInstance {
  const { token: TOKEN, provider } = opts;
  const now = opts.now ?? Date.now;
  const maxBroadcasts = opts.maxBroadcastsPerMinute ?? 10;
  const maxReconcile = opts.maxReconcileCallsPerMinute ?? 30;
  const broadcastLimit = new SlidingWindow(maxBroadcasts, now);
  const reconcileLimit = new SlidingWindow(maxReconcile, now);
  // Fastify's default maxParamLength (100) would 414 a full 80-byte (160 hex) payload in /anchor/find.
  const app = Fastify({ logger: opts.logger ?? false, maxParamLength: 256, ...opts.serverOptions });

  function requireAuth(req: { headers: Record<string, unknown> }, reply: { code: (n: number) => any }): boolean {
    const authHeader = String(req.headers.authorization ?? "");
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!token || token.length !== TOKEN.length || !timingSafeEqual(Buffer.from(token), Buffer.from(TOKEN))) {
      reply.code(401).send({ error: "unauthorized" });
      return false;
    }
    return true;
  }

  /** Node errors are logged; the client only gets the error code (#116 review nit). */
  function nodeError(reply: { code: (n: number) => any }, code: string, error: unknown) {
    app.log.error({ error: error instanceof Error ? error.message : String(error) }, `anchor_proxy_${code}`);
    return reply.code(502).send({ error: code });
  }

  app.post("/anchor/broadcast", async (req, reply) => {
    if (!requireAuth(req as any, reply)) return;
    const dataHex = (req.body as { dataHex?: unknown } | undefined)?.dataHex;
    if (typeof dataHex === "string" && /^[0-9a-fA-F]+$/.test(dataHex) && dataHex.length > 160) {
      return reply.code(400).send({ error: "op_return_data_too_large", maxBytes: 80 });
    }
    if (!isValidPayloadHex(dataHex)) return reply.code(400).send({ error: "invalid_data_hex" });
    if (!broadcastLimit.take()) return reply.code(429).send({ error: "rate_limited", maxPerMinute: maxBroadcasts });
    try {
      const result = await provider.broadcastOpReturn(dataHex);
      app.log.info({ txid: result.txid }, "anchor_proxy_broadcast_ok");
      return { ok: true, txid: result.txid };
    } catch (error) {
      return nodeError(reply, "broadcast_failed", error);
    }
  });

  app.get<{ Params: { txid: string } }>("/anchor/confirm/:txid", async (req, reply) => {
    if (!requireAuth(req as any, reply)) return;
    const { txid } = req.params;
    if (!TXID_RE.test(txid ?? "")) return reply.code(400).send({ error: "invalid_txid" });
    try {
      return { ok: true, ...(await provider.getConfirmations(txid)) };
    } catch (error) {
      return nodeError(reply, "confirmation_check_failed", error);
    }
  });

  // ---- #103 reconciliation ----
  app.get<{ Params: { dataHex: string } }>("/anchor/find/:dataHex", async (req, reply) => {
    if (!requireAuth(req as any, reply)) return;
    const { dataHex } = req.params;
    if (!isValidPayloadHex(dataHex)) return reply.code(400).send({ error: "invalid_data_hex" });
    if (!reconcileLimit.take()) return reply.code(429).send({ error: "rate_limited", maxPerMinute: maxReconcile });
    try {
      return { ok: true, txid: await provider.findCheckpointTx(dataHex) };
    } catch (error) {
      return nodeError(reply, "find_failed", error);
    }
  });

  app.get<{ Params: { txid: string } }>("/anchor/mempool/:txid", async (req, reply) => {
    if (!requireAuth(req as any, reply)) return;
    const { txid } = req.params;
    if (!TXID_RE.test(txid ?? "")) return reply.code(400).send({ error: "invalid_txid" });
    if (!reconcileLimit.take()) return reply.code(429).send({ error: "rate_limited", maxPerMinute: maxReconcile });
    try {
      // bitcoind isInMempool returns false only for RPC -5 (not in mempool); other errors throw -> 502.
      return { ok: true, inMempool: await provider.isInMempool(txid) };
    } catch (error) {
      return nodeError(reply, "mempool_check_failed", error);
    }
  });

  app.post("/anchor/abandon", async (req, reply) => {
    if (!requireAuth(req as any, reply)) return;
    const txid = (req.body as { txid?: unknown } | undefined)?.txid;
    if (typeof txid !== "string" || !TXID_RE.test(txid)) return reply.code(400).send({ error: "invalid_txid" });
    if (!reconcileLimit.take()) return reply.code(429).send({ error: "rate_limited", maxPerMinute: maxReconcile });
    try {
      await provider.abandonTx(txid);
      app.log.info({ txid }, "anchor_proxy_abandon_ok");
      return { ok: true };
    } catch (error) {
      return nodeError(reply, "abandon_failed", error);
    }
  });

  function recordHealth(reachable: boolean, blocks?: number): void {
    if (!opts.stats) return;
    opts.stats.bitcoindReachable = reachable;
    if (typeof blocks === "number") opts.stats.blocks = blocks;
    opts.stats.lastHealthCheckMs = now();
  }

  app.get("/health", async (_req, reply) => {
    // Unauthenticated for Fly health checks; minimal info only. The status code carries the
    // result (503 when bitcoind is unreachable): Fly's check looks at nothing else.
    const { status, body } = await anchorProxyHealth(provider, opts.network);
    recordHealth(status === 200, body.blocks as number | undefined);
    return reply.code(status).send(body);
  });

  app.get("/health/detailed", async (req, reply) => {
    if (!requireAuth(req as any, reply)) return;
    try {
      const health = await provider.healthCheck();
      recordHealth(health.reachable, health.blocks);
      return {
        ok: health.reachable,
        network: opts.network,
        node: health,
        rateLimit: { maxPerMinute: maxBroadcasts, currentWindow: broadcastLimit.current(), reconcileMaxPerMinute: maxReconcile, reconcileCurrentWindow: reconcileLimit.current() }
      };
    } catch {
      return reply.code(503).send({ ok: false, error: "health_check_failed" });
    }
  });

  return app;
}
