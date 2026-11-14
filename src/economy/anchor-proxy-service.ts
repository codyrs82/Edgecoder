// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { BitcoindRpcProvider } from "./bitcoin-rpc.js";
import type { BitcoinNetwork } from "../common/types.js";
import { LISTEN_HOST } from "../common/env-guard.js";
import { buildAnchorProxyApp, registerAnchorProxyMetrics, type AnchorProxyStats } from "./anchor-proxy-app.js";
import { rpcHostForLog } from "./anchor-proxy-health.js";
import { exposeRequestId, serviceLoggerOptions } from "../common/http-logging.js";
import { createLogger } from "../common/logger.js";
import { registerMetrics } from "../common/metrics.js";
import { registerErrorTracking } from "../common/error-tracking.js";

/* ------------------------------------------------------------------ */
/*  Bitcoin Anchor Proxy Service                                       */
/*                                                                     */
/*  A lightweight authenticated HTTPS proxy that sits between the      */
/*  coordinator mesh and the Bitcoin Knots/Core RPC endpoint.          */
/*                                                                     */
/*  Why: coordinators should never hold bitcoind RPC credentials.      */
/*  Endpoints (routes live in anchor-proxy-app.ts):                    */
/*    POST /anchor/broadcast      – broadcast an OP_RETURN              */
/*    GET  /anchor/confirm/:txid  – check confirmation status           */
/*    GET  /anchor/find/:dataHex  – wallet tx carrying a payload (#103) */
/*    GET  /anchor/mempool/:txid  – is an unconfirmed tx in the mempool */
/*    POST /anchor/abandon        – abandontransaction for a dropped tx */
/*    GET  /health                – node + wallet health                */
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

// Startup failures happen before the Fastify app (and its logger) exists.
const startupLog = createLogger("anchor-proxy");

if (!ANCHOR_PROXY_TOKEN) {
  startupLog.fatal("ANCHOR_PROXY_TOKEN is required");
  process.exit(1);
}
if (!BITCOIND_RPC_URL || !BITCOIND_RPC_USER || !BITCOIND_RPC_PASSWORD) {
  startupLog.fatal("BITCOIND_RPC_URL, BITCOIND_RPC_USER, BITCOIND_RPC_PASSWORD are required");
  process.exit(1);
}

const stats: AnchorProxyStats = {};
const provider = new BitcoindRpcProvider(BITCOIND_RPC_URL, BITCOIND_RPC_USER, BITCOIND_RPC_PASSWORD, BITCOIND_WALLET_NAME);
const app = buildAnchorProxyApp({
  token: ANCHOR_PROXY_TOKEN,
  provider,
  network: BITCOIN_NETWORK,
  maxBroadcastsPerMinute: Number(process.env.MAX_BROADCASTS_PER_MINUTE ?? "10"),
  maxReconcileCallsPerMinute: Number(process.env.MAX_RECONCILE_CALLS_PER_MINUTE ?? "30"),
  serverOptions: serviceLoggerOptions("anchor-proxy"),
  stats
});
// #14: request ids, Prometheus /metrics and error tracking, like the other services.
exposeRequestId(app);
registerAnchorProxyMetrics(registerMetrics(app, "anchor-proxy"), stats);
await registerErrorTracking(app, "anchor-proxy");

app.listen({ port: PORT, host: LISTEN_HOST }).then((address) => {
  // The RPC URL may carry user:pass; only its host is ever logged.
  app.log.info({ address, network: BITCOIN_NETWORK, rpc: rpcHostForLog(BITCOIND_RPC_URL), wallet: BITCOIND_WALLET_NAME }, "anchor proxy listening");
}).catch((err) => {
  startupLog.fatal({ err }, "failed to start anchor proxy");
  process.exit(1);
});

export { app as anchorProxyServer };
