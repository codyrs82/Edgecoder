// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import { BitcoindRpcProvider } from "./bitcoin-rpc.js";
import type { BitcoinNetwork } from "../common/types.js";

/* ------------------------------------------------------------------ */
/*  Bitcoin Anchor Proxy Service                                       */
/*                                                                     */
/*  A lightweight authenticated HTTPS proxy that sits between the      */
/*  coordinator mesh and the Bitcoin Knots/Core RPC endpoint.          */
/*                                                                     */
/*  Why: coordinators should never hold bitcoind RPC credentials.      */
/*  This service runs on the same network as the Bitcoin node          */
/*  (or on Fly with the node whitelisted) and exposes three            */
/*  endpoints:                                                         */
/*    POST /anchor/broadcast   – broadcast an OP_RETURN                */
/*    GET  /anchor/confirm/:txid – check confirmation status           */
/*    GET  /health              – node + wallet health                  */
/*                                                                     */
/*  Auth: Bearer token via ANCHOR_PROXY_TOKEN env var.                 */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.ANCHOR_PROXY_PORT ?? "4311");
const ANCHOR_PROXY_TOKEN = process.env.ANCHOR_PROXY_TOKEN;
const BITCOIND_RPC_URL = process.env.BITCOIND_RPC_URL;
const BITCOIND_RPC_USER = process.env.BITCOIND_RPC_USER;
const BITCOIND_RPC_PASSWORD = process.env.BITCOIND_RPC_PASSWORD;
const BITCOIND_WALLET_NAME = process.env.BITCOIND_WALLET_NAME ?? "";
const BITCOIN_NETWORK = (process.env.BITCOIN_NETWORK ?? "signet") as BitcoinNetwork;

if (!ANCHOR_PROXY_TOKEN) {
  console.error("FATAL: ANCHOR_PROXY_TOKEN is required");
  process.exit(1);
}
if (!BITCOIND_RPC_URL || !BITCOIND_RPC_USER || !BITCOIND_RPC_PASSWORD) {
  console.error("FATAL: BITCOIND_RPC_URL, BITCOIND_RPC_USER, BITCOIND_RPC_PASSWORD are required");
  process.exit(1);
}

const provider = new BitcoindRpcProvider(BITCOIND_RPC_URL, BITCOIND_RPC_USER, BITCOIND_RPC_PASSWORD, BITCOIND_WALLET_NAME);
const app = Fastify({ logger: true });

/* ---- auth middleware ---- */
function requireAuth(req: { headers: Record<string, unknown> }, reply: { code: (n: number) => any }): boolean {
  const authHeader = String(req.headers.authorization ?? "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token || !ANCHOR_PROXY_TOKEN || token.length !== ANCHOR_PROXY_TOKEN.length || !timingSafeEqual(Buffer.from(token), Buffer.from(ANCHOR_PROXY_TOKEN))) {
    reply.code(401).send({ error: "unauthorized" });
    return false;
  }
  return true;
}

/* ---- rate limiter (simple sliding window per token) ---- */
const MAX_BROADCASTS_PER_MINUTE = Number(process.env.MAX_BROADCASTS_PER_MINUTE ?? "10");
let broadcastWindow: number[] = [];

function checkBroadcastRateLimit(): boolean {
  const now = Date.now();
  broadcastWindow = broadcastWindow.filter((ts) => now - ts < 60_000);
  if (broadcastWindow.length >= MAX_BROADCASTS_PER_MINUTE) return false;
  broadcastWindow.push(now);
  return true;
}

/* ---- POST /anchor/broadcast ---- */
app.post("/anchor/broadcast", async (req, reply) => {
  if (!requireAuth(req as any, reply)) return;

  const body = req.body as { dataHex?: string } | undefined;
  const dataHex = body?.dataHex;
  if (!dataHex || typeof dataHex !== "string" || !/^[0-9a-fA-F]+$/.test(dataHex)) {
    return reply.code(400).send({ error: "invalid_data_hex" });
  }
  if (dataHex.length > 160) {
    return reply.code(400).send({ error: "op_return_data_too_large", maxBytes: 80 });
  }
  if (!checkBroadcastRateLimit()) {
    return reply.code(429).send({ error: "rate_limited", maxPerMinute: MAX_BROADCASTS_PER_MINUTE });
  }

  try {
    const result = await provider.broadcastOpReturn(dataHex);
    app.log.info({ txid: result.txid }, "anchor_proxy_broadcast_ok");
    return { ok: true, txid: result.txid };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    app.log.error({ error: message }, "anchor_proxy_broadcast_failed");
    return reply.code(502).send({ error: "broadcast_failed", message });
  }
});

/* ---- GET /anchor/confirm/:txid ---- */
app.get<{ Params: { txid: string } }>("/anchor/confirm/:txid", async (req, reply) => {
  if (!requireAuth(req as any, reply)) return;

  const { txid } = req.params;
  if (!txid || !/^[0-9a-fA-F]{64}$/.test(txid)) {
    return reply.code(400).send({ error: "invalid_txid" });
  }

  try {
    const result = await provider.getConfirmations(txid);
    return { ok: true, ...result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(502).send({ error: "confirmation_check_failed", message });
  }
});

/* ---- GET /health ---- */
app.get("/health", async (req, reply) => {
  // Health is unauthenticated for Fly health checks, but returns minimal info
  try {
    const health = await provider.healthCheck();
    return {
      ok: health.reachable,
      network: BITCOIN_NETWORK,
      chain: health.chain,
      blocks: health.blocks,
      walletAvailable: health.walletAvailable,
      provider: "anchor-proxy"
    };
  } catch (error) {
    return reply.code(503).send({ ok: false, error: "health_check_failed" });
  }
});

/* ---- GET /health/detailed ---- */
app.get("/health/detailed", async (req, reply) => {
  if (!requireAuth(req as any, reply)) return;

  try {
    const health = await provider.healthCheck();
    return {
      ok: health.reachable,
      network: BITCOIN_NETWORK,
      node: health,
      rateLimit: {
        maxPerMinute: MAX_BROADCASTS_PER_MINUTE,
        currentWindow: broadcastWindow.filter((ts) => Date.now() - ts < 60_000).length
      }
    };
  } catch (error) {
    return reply.code(503).send({ ok: false, error: "health_check_failed" });
  }
});

/* ---- start ---- */
app.listen({ port: PORT, host: "0.0.0.0" }).then((address) => {
  console.log(`[anchor-proxy] listening on ${address}`);
  console.log(`[anchor-proxy] network=${BITCOIN_NETWORK} rpc=${BITCOIND_RPC_URL} wallet=${BITCOIND_WALLET_NAME}`);
}).catch((err) => {
  console.error("Failed to start anchor proxy:", err);
  process.exit(1);
});

export { app as anchorProxyServer };
