// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { BitcoindRpcProvider } from "./bitcoin-rpc.js";
import type { BitcoinNetwork } from "../common/types.js";
import { LISTEN_HOST } from "../common/env-guard.js";
import { buildAnchorProxyApp } from "./anchor-proxy-app.js";

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

if (!ANCHOR_PROXY_TOKEN) {
  console.error("FATAL: ANCHOR_PROXY_TOKEN is required");
  process.exit(1);
}
if (!BITCOIND_RPC_URL || !BITCOIND_RPC_USER || !BITCOIND_RPC_PASSWORD) {
  console.error("FATAL: BITCOIND_RPC_URL, BITCOIND_RPC_USER, BITCOIND_RPC_PASSWORD are required");
  process.exit(1);
}

const provider = new BitcoindRpcProvider(BITCOIND_RPC_URL, BITCOIND_RPC_USER, BITCOIND_RPC_PASSWORD, BITCOIND_WALLET_NAME);
const app = buildAnchorProxyApp({
  token: ANCHOR_PROXY_TOKEN,
  provider,
  network: BITCOIN_NETWORK,
  maxBroadcastsPerMinute: Number(process.env.MAX_BROADCASTS_PER_MINUTE ?? "10"),
  maxReconcileCallsPerMinute: Number(process.env.MAX_RECONCILE_CALLS_PER_MINUTE ?? "30"),
  logger: true
});

app.listen({ port: PORT, host: LISTEN_HOST }).then((address) => {
  console.log(`[anchor-proxy] listening on ${address}`);
  console.log(`[anchor-proxy] network=${BITCOIN_NETWORK} rpc=${BITCOIND_RPC_URL} wallet=${BITCOIND_WALLET_NAME}`);
}).catch((err) => {
  console.error("Failed to start anchor proxy:", err);
  process.exit(1);
});

export { app as anchorProxyServer };
