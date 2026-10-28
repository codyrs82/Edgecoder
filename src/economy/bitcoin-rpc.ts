// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { request } from "undici";
import { createHash, randomUUID } from "node:crypto";
import type { BitcoinNetwork } from "../common/types.js";

/* ------------------------------------------------------------------ */
/*  Bitcoin RPC provider – broadcasts OP_RETURN anchors and tracks    */
/*  confirmations via a bitcoind JSON-RPC backend or the public       */
/*  Blockstream/mempool.space REST API when no local node is present. */
/* ------------------------------------------------------------------ */

export interface AnchorBroadcastResult {
  txid: string;
  rawHex?: string;
}

export interface AnchorConfirmationResult {
  confirmed: boolean;
  confirmations: number;
  blockHeight?: number;
  blockHash?: string;
}

export interface BitcoinAnchorProvider {
  /** Broadcast an OP_RETURN transaction embedding `dataHex` (≤80 bytes). */
  broadcastOpReturn(dataHex: string): Promise<AnchorBroadcastResult>;
  /** Check the confirmation status of a previously broadcast txid. */
  getConfirmations(txid: string): Promise<AnchorConfirmationResult>;
  /** Check RPC connectivity and return node info. */
  healthCheck(): Promise<BitcoinNodeHealth>;
  /** Send BTC to multiple outputs in a single transaction (for payout sweeps). */
  sendToMany(outputs: SendToManyOutput[]): Promise<SendToManyResult>;
}

export interface BitcoinNodeHealth {
  reachable: boolean;
  chain?: string;
  blocks?: number;
  headers?: number;
  verificationProgress?: number;
  walletAvailable?: boolean;
  walletBalance?: number;
  provider: string;
  error?: string;
}

export interface SendToManyOutput {
  address: string;
  amountSats: number;
}

export interface SendToManyResult {
  txid: string;
  rawHex?: string;
}

/** #46: anchor fee rate in sat/vB: node estimate (BTC/kvB) with a floor (BITCOIN_ANCHOR_MIN_FEE_SAT_VB, default 2). */
export function anchorFeeRateSatVb(estimateBtcPerKvB: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const floorRaw = Number(env.BITCOIN_ANCHOR_MIN_FEE_SAT_VB ?? "2");
  const floor = Number.isFinite(floorRaw) && floorRaw >= 1 ? floorRaw : 2;
  const est = typeof estimateBtcPerKvB === "number" && Number.isFinite(estimateBtcPerKvB) && estimateBtcPerKvB > 0
    ? (estimateBtcPerKvB * 1e8) / 1000
    : 0;
  return Number(Math.max(floor, est).toFixed(3));
}

/** #46: absolute fee cap for one anchor tx (BITCOIN_ANCHOR_MAX_FEE_SATS, default 20000). */
export function anchorMaxFeeSats(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.BITCOIN_ANCHOR_MAX_FEE_SATS ?? "20000");
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

/* ------------------------------------------------------------------ */
/*  bitcoind JSON-RPC provider                                        */
/* ------------------------------------------------------------------ */

export class BitcoindRpcProvider implements BitcoinAnchorProvider {
  constructor(
    private readonly rpcUrl: string,
    private readonly rpcUser: string,
    private readonly rpcPassword: string,
    private readonly walletName: string
  ) {}

  private async rpc(method: string, params: unknown[] = []): Promise<unknown> {
    const url = this.walletName
      ? `${this.rpcUrl}/wallet/${encodeURIComponent(this.walletName)}`
      : this.rpcUrl;
    const auth = Buffer.from(`${this.rpcUser}:${this.rpcPassword}`).toString("base64");
    const res = await request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${auth}`
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params })
    });
    const body = (await res.body.json()) as { result?: unknown; error?: { message: string; code: number } };
    if (body.error) {
      throw new Error(`bitcoind_rpc_error: ${body.error.code} ${body.error.message}`);
    }
    return body.result;
  }

  async broadcastOpReturn(dataHex: string): Promise<AnchorBroadcastResult> {
    if (dataHex.length > 160) {
      throw new Error("op_return_data_too_large: max 80 bytes (160 hex chars)");
    }
    // #46: let the wallet do coin selection + change (fundrawtransaction) instead of
    // spending utxos[0]; fee = max(estimatesmartfee, floor) sat/vB, capped in absolute sats.
    const rawTx0 = (await this.rpc("createrawtransaction", [[], [{ data: dataHex }]])) as string;
    const est = ((await this.rpc("estimatesmartfee", [6])) as { feerate?: number }).feerate;
    const feeRateSatVb = anchorFeeRateSatVb(est);
    const funded = (await this.rpc("fundrawtransaction", [
      rawTx0,
      { fee_rate: feeRateSatVb, replaceable: true }
    ])) as { hex: string; fee: number; changepos: number };
    const feeSats = Math.round(funded.fee * 1e8);
    const maxFeeSats = anchorMaxFeeSats();
    if (feeSats > maxFeeSats) {
      throw new Error(`bitcoind_anchor_fee_too_high: ${feeSats} > ${maxFeeSats} sats`);
    }
    const rawTx = funded.hex;
    // 2. Sign the raw transaction
    const signed = (await this.rpc("signrawtransactionwithwallet", [rawTx])) as {
      hex: string;
      complete: boolean;
    };
    if (!signed.complete) {
      throw new Error("bitcoind_signing_incomplete");
    }
    // 3. Broadcast
    const txid = (await this.rpc("sendrawtransaction", [signed.hex])) as string;
    return { txid, rawHex: signed.hex };
  }

  /**
   * #46 review: only a definite answer counts. RPC -5 (unknown txid) means not in
   * the wallet/chain; any other error (node down, auth, timeout, wallet not loaded)
   * is thrown so callers keep the last known state instead of treating it as a reorg.
   * Negative confirmations (conflicted/replaced) are passed through.
   */
  async getConfirmations(txid: string): Promise<AnchorConfirmationResult> {
    let tx: { confirmations?: number; blockhash?: string; blockheight?: number };
    try {
      tx = (await this.rpc("gettransaction", [txid])) as typeof tx;
    } catch (err) {
      if (err instanceof Error && /bitcoind_rpc_error: -5 /.test(err.message)) {
        return { confirmed: false, confirmations: 0 };
      }
      throw err;
    }
    const confirmations = tx.confirmations ?? 0;
    return {
      confirmed: confirmations > 0,
      confirmations,
      blockHeight: confirmations > 0 ? tx.blockheight : undefined,
      blockHash: confirmations > 0 ? tx.blockhash : undefined
    };
  }

  async healthCheck(): Promise<BitcoinNodeHealth> {
    try {
      const info = (await this.rpc("getblockchaininfo")) as {
        chain?: string;
        blocks?: number;
        headers?: number;
        verificationprogress?: number;
      };
      let walletAvailable = false;
      let walletBalance: number | undefined;
      if (this.walletName) {
        try {
          const walletInfo = (await this.rpc("getwalletinfo")) as { balance?: number };
          walletAvailable = true;
          walletBalance = walletInfo.balance;
        } catch {
          walletAvailable = false;
        }
      }
      return {
        reachable: true,
        chain: info.chain,
        blocks: info.blocks,
        headers: info.headers,
        verificationProgress: info.verificationprogress,
        walletAvailable,
        walletBalance,
        provider: "bitcoind"
      };
    } catch (err) {
      return {
        reachable: false,
        provider: "bitcoind",
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  async sendToMany(outputs: SendToManyOutput[]): Promise<SendToManyResult> {
    if (outputs.length === 0) throw new Error("no_outputs");
    const amounts: Record<string, number> = {};
    for (const out of outputs) {
      amounts[out.address] = (amounts[out.address] ?? 0) + out.amountSats / 1e8;
    }
    const utxos = (await this.rpc("listunspent", [1, 9999999])) as Array<{
      txid: string; vout: number; amount: number;
    }>;
    if (utxos.length === 0) throw new Error("bitcoind_no_utxos");
    const totalBtc = outputs.reduce((s, o) => s + o.amountSats / 1e8, 0);
    const feeRate = ((await this.rpc("estimatesmartfee", [6])) as { feerate?: number }).feerate ?? 0.00001;
    const estVbytes = 10 + outputs.length * 34 + utxos.length * 68;
    const feeBtc = feeRate * estVbytes / 1000;
    let inputTotal = 0;
    const selectedUtxos: Array<{ txid: string; vout: number }> = [];
    for (const utxo of utxos) {
      selectedUtxos.push({ txid: utxo.txid, vout: utxo.vout });
      inputTotal += utxo.amount;
      if (inputTotal >= totalBtc + feeBtc) break;
    }
    if (inputTotal < totalBtc + feeBtc) throw new Error("bitcoind_insufficient_funds");
    const changeBtc = inputTotal - totalBtc - feeBtc;
    const txOutputs: Record<string, unknown>[] = [];
    for (const [addr, btc] of Object.entries(amounts)) {
      txOutputs.push({ [addr]: Number(btc.toFixed(8)) });
    }
    if (changeBtc > 0.00000546) {
      const changeAddr = (await this.rpc("getrawchangeaddress")) as string;
      txOutputs.push({ [changeAddr]: Number(changeBtc.toFixed(8)) });
    }
    const rawTx = (await this.rpc("createrawtransaction", [selectedUtxos, txOutputs])) as string;
    const signed = (await this.rpc("signrawtransactionwithwallet", [rawTx])) as {
      hex: string; complete: boolean;
    };
    if (!signed.complete) throw new Error("bitcoind_signing_incomplete");
    const txid = (await this.rpc("sendrawtransaction", [signed.hex])) as string;
    return { txid, rawHex: signed.hex };
  }
}

/* ------------------------------------------------------------------ */
/*  Blockstream / mempool.space REST API provider (no local node)     */
/* ------------------------------------------------------------------ */

function apiBaseUrl(network: BitcoinNetwork): string {
  switch (network) {
    case "bitcoin":
      return "https://blockstream.info/api";
    case "testnet":
      return "https://blockstream.info/testnet/api";
    case "signet":
      return "https://mempool.space/signet/api";
    default:
      return "https://blockstream.info/testnet/api";
  }
}

export class BlockstreamProvider implements BitcoinAnchorProvider {
  constructor(private readonly network: BitcoinNetwork) {}

  async broadcastOpReturn(dataHex: string): Promise<AnchorBroadcastResult> {
    // Blockstream API requires a fully-signed raw transaction hex.
    // Since we don't hold keys here, this provider can only broadcast
    // pre-signed transactions. For OP_RETURN anchoring without a local
    // node, callers must provide a signed raw tx via broadcastRawTx.
    throw new Error(
      "blockstream_broadcast_not_supported: use BitcoindRpcProvider or provide a pre-signed tx via broadcastRawTx"
    );
  }

  /** Broadcast an already-signed raw transaction hex. */
  async broadcastRawTx(rawTxHex: string): Promise<string> {
    const base = apiBaseUrl(this.network);
    const res = await request(`${base}/tx`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: rawTxHex
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const errBody = await res.body.text();
      throw new Error(`blockstream_broadcast_failed: ${res.statusCode} ${errBody}`);
    }
    const txid = await res.body.text();
    return txid.trim();
  }

  async getConfirmations(txid: string): Promise<AnchorConfirmationResult> {
    const base = apiBaseUrl(this.network);
    {
      // #46 review: 404 = definitely unknown; other failures throw (not a reorg).
      const txRes = await request(`${base}/tx/${txid}`, { method: "GET" });
      if (txRes.statusCode === 404) {
        await txRes.body.dump();
        return { confirmed: false, confirmations: 0 };
      }
      if (txRes.statusCode < 200 || txRes.statusCode >= 300) {
        await txRes.body.dump();
        throw new Error(`blockstream_tx_lookup_failed:${txRes.statusCode}`);
      }
      const tx = (await txRes.body.json()) as {
        status?: { confirmed?: boolean; block_height?: number; block_hash?: string };
      };
      if (!tx.status?.confirmed) {
        return { confirmed: false, confirmations: 0 };
      }
      // Get current tip height to compute confirmations
      const tipRes = await request(`${base}/blocks/tip/height`, { method: "GET" });
      if (tipRes.statusCode < 200 || tipRes.statusCode >= 300) {
        await tipRes.body.dump();
        throw new Error(`blockstream_tip_lookup_failed:${tipRes.statusCode}`);
      }
      const tipHeight = Number(await tipRes.body.text());
      const blockHeight = tx.status.block_height ?? 0;
      const confirmations = tipHeight > 0 && blockHeight > 0 ? tipHeight - blockHeight + 1 : 0;
      return {
        confirmed: true,
        confirmations,
        blockHeight,
        blockHash: tx.status.block_hash
      };
    }
  }

  async healthCheck(): Promise<BitcoinNodeHealth> {
    const base = apiBaseUrl(this.network);
    try {
      const tipRes = await request(`${base}/blocks/tip/height`, { method: "GET" });
      if (tipRes.statusCode < 200 || tipRes.statusCode >= 300) {
        return { reachable: false, provider: "blockstream", error: `http_${tipRes.statusCode}` };
      }
      const blocks = Number(await tipRes.body.text());
      return {
        reachable: true,
        chain: this.network === "bitcoin" ? "main" : this.network,
        blocks,
        headers: blocks,
        provider: "blockstream"
      };
    } catch (err) {
      return {
        reachable: false,
        provider: "blockstream",
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  async sendToMany(_outputs: SendToManyOutput[]): Promise<SendToManyResult> {
    throw new Error("sendToMany not supported by this provider");
  }
}

/* ------------------------------------------------------------------ */
/*  Anchor Proxy client provider                                      */
/*  Talks to an authenticated anchor-proxy service over HTTPS rather  */
/*  than directly to bitcoind RPC.  Coordinators never hold RPC creds */
/*  when using this provider.                                         */
/* ------------------------------------------------------------------ */

export class AnchorProxyClientProvider implements BitcoinAnchorProvider {
  constructor(
    private readonly proxyUrl: string,
    private readonly proxyToken: string
  ) {}

  private async proxyRequest(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<unknown> {
    const url = `${this.proxyUrl.replace(/\/+$/, "")}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.proxyToken}`,
      "content-type": "application/json"
    };
    const res = await request(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const json = (await res.body.json()) as Record<string, unknown>;
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`anchor_proxy_error: ${res.statusCode} ${json.error ?? JSON.stringify(json)}`);
    }
    return json;
  }

  async broadcastOpReturn(dataHex: string): Promise<AnchorBroadcastResult> {
    if (dataHex.length > 160) {
      throw new Error("op_return_data_too_large: max 80 bytes (160 hex chars)");
    }
    const result = (await this.proxyRequest("/anchor/broadcast", "POST", { dataHex })) as {
      ok: boolean;
      txid: string;
    };
    return { txid: result.txid };
  }

  /** #46 review: proxy/node errors propagate ("unknown"), they are not "left the chain". */
  async getConfirmations(txid: string): Promise<AnchorConfirmationResult> {
      const result = (await this.proxyRequest(`/anchor/confirm/${txid}`)) as {
        ok: boolean;
        confirmed: boolean;
        confirmations: number;
        blockHeight?: number;
        blockHash?: string;
      };
      if (!result || result.ok !== true || typeof result.confirmations !== "number") {
        throw new Error("anchor_proxy_confirm_invalid_response");
      }
      return {
        confirmed: result.confirmed,
        confirmations: result.confirmations,
        blockHeight: result.blockHeight,
        blockHash: result.blockHash
      };
  }

  async healthCheck(): Promise<BitcoinNodeHealth> {
    try {
      const result = (await this.proxyRequest("/health/detailed")) as {
        ok: boolean;
        network: string;
        node: BitcoinNodeHealth;
        rateLimit?: { maxPerMinute: number; currentWindow: number };
      };
      return {
        ...result.node,
        provider: "anchor-proxy"
      };
    } catch (err) {
      return {
        reachable: false,
        provider: "anchor-proxy",
        error: err instanceof Error ? err.message : String(err)
      };
    }
  }

  async sendToMany(_outputs: SendToManyOutput[]): Promise<SendToManyResult> {
    throw new Error("sendToMany not supported by this provider");
  }
}

/* ------------------------------------------------------------------ */
/*  Mock provider for development / testing                           */
/* ------------------------------------------------------------------ */

export class MockBitcoinAnchorProvider implements BitcoinAnchorProvider {
  async broadcastOpReturn(dataHex: string): Promise<AnchorBroadcastResult> {
    const txid = createHash("sha256").update(`mock:${dataHex}:${Date.now()}`).digest("hex");
    return { txid };
  }

  async getConfirmations(_txid: string): Promise<AnchorConfirmationResult> {
    return { confirmed: true, confirmations: 6, blockHeight: 900_000 };
  }

  async healthCheck(): Promise<BitcoinNodeHealth> {
    return { reachable: true, chain: "mock", blocks: 900_000, headers: 900_000, provider: "mock" };
  }

  async sendToMany(outputs: SendToManyOutput[]): Promise<SendToManyResult> {
    if (outputs.length === 0) throw new Error("no_outputs");
    const txid = createHash("sha256")
      .update(`mock-sweep:${outputs.length}:${Date.now()}`)
      .digest("hex");
    return { txid };
  }
}

/* ------------------------------------------------------------------ */
/*  Factory – create provider from environment variables              */
/* ------------------------------------------------------------------ */

/**
 * #102: providers that can broadcast an anchor. `blockstream` only reads (confirmation lookups);
 * its broadcastOpReturn always throws, so accepting it for anchoring made every tick fail.
 */
export const ANCHORING_PROVIDERS = ["anchor-proxy", "bitcoind"] as const;

/** Every value the factory understands; anything else is a typo and is rejected. */
export const KNOWN_ANCHOR_PROVIDERS = [...ANCHORING_PROVIDERS, "mock"] as const;

function normalizedProvider(env: NodeJS.ProcessEnv): string {
  return (env.BITCOIN_ANCHOR_PROVIDER ?? "").trim().toLowerCase();
}

/** Problems with the value itself, in any environment: blockstream (read-only) or a typo. */
function providerValueProblem(provider: string): string | null {
  if (provider === "blockstream") {
    return "blockstream_cannot_anchor: BITCOIN_ANCHOR_PROVIDER=blockstream is read-only (confirmation lookups) and can't broadcast; use anchor-proxy or bitcoind";
  }
  if (provider && !(KNOWN_ANCHOR_PROVIDERS as readonly string[]).includes(provider)) {
    return `unknown_anchor_provider: BITCOIN_ANCHOR_PROVIDER=${JSON.stringify(provider)}; expected one of ${KNOWN_ANCHOR_PROVIDERS.join(", ")}`;
  }
  return null;
}

/**
 * Strict check for a production startup gate (#102): null only when BITCOIN_ANCHOR_PROVIDER is
 * `anchor-proxy` or `bitcoind` **and** that provider's required env vars are set. Unset, `mock`,
 * `blockstream`, typos and missing provider credentials all return the reason.
 * Values are never echoed for the credential vars.
 */
export function anchorProviderProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const provider = normalizedProvider(env);
  if (!provider) return "anchor_provider_unset: set BITCOIN_ANCHOR_PROVIDER to anchor-proxy or bitcoind";
  const valueProblem = providerValueProblem(provider);
  if (valueProblem) return valueProblem;
  if (provider === "mock") return "anchor_provider_mock: BITCOIN_ANCHOR_PROVIDER=mock produces fake transactions; use anchor-proxy or bitcoind";
  const missing =
    provider === "bitcoind"
      ? ["BITCOIND_RPC_URL", "BITCOIND_RPC_USER", "BITCOIND_RPC_PASSWORD"].filter((k) => !env[k]?.trim())
      : ["ANCHOR_PROXY_URL", "ANCHOR_PROXY_TOKEN"].filter((k) => !env[k]?.trim());
  if (missing.length > 0) return `anchor_provider_missing_env: ${provider} needs ${missing.join(", ")}`;
  return null;
}

export function createBitcoinAnchorProviderFromEnv(network: BitcoinNetwork): BitcoinAnchorProvider {
  const provider = normalizedProvider(process.env) || "mock";
  // Blockstream and typos are rejected everywhere; unset/mock stay allowed outside production.
  const problem = providerValueProblem(provider);
  if (problem) throw new Error(problem);
  if (provider === "bitcoind") {
    const rpcUrl = process.env.BITCOIND_RPC_URL;
    const rpcUser = process.env.BITCOIND_RPC_USER;
    const rpcPassword = process.env.BITCOIND_RPC_PASSWORD;
    const walletName = process.env.BITCOIND_WALLET_NAME ?? "";
    if (!rpcUrl || !rpcUser || !rpcPassword) {
      throw new Error("bitcoind_provider_missing_env: BITCOIND_RPC_URL, BITCOIND_RPC_USER, BITCOIND_RPC_PASSWORD required");
    }
    return new BitcoindRpcProvider(rpcUrl, rpcUser, rpcPassword, walletName);
  }
  if (provider === "anchor-proxy") {
    const proxyUrl = process.env.ANCHOR_PROXY_URL;
    const proxyToken = process.env.ANCHOR_PROXY_TOKEN;
    if (!proxyUrl || !proxyToken) {
      throw new Error("anchor_proxy_missing_env: ANCHOR_PROXY_URL and ANCHOR_PROXY_TOKEN required");
    }
    return new AnchorProxyClientProvider(proxyUrl, proxyToken);
  }
  if (process.env.NODE_ENV === "production") {
    console.error("FATAL: BITCOIN_ANCHOR_PROVIDER must be set to 'anchor-proxy' or 'bitcoind' in production (mock produces fake transactions)");
    process.exit(1);
  }
  console.warn("[bitcoin] using MockBitcoinAnchorProvider — anchoring is simulated (dev only)");
  return new MockBitcoinAnchorProvider();
}

/* ------------------------------------------------------------------ */
/*  Utility – encode checkpoint hash as OP_RETURN data                */
/* ------------------------------------------------------------------ */

/** Prefix: "EC" (EdgeCoder) + version byte + 32-byte SHA256 hash = 35 bytes */
const OP_RETURN_PREFIX = Buffer.from("EC", "ascii");
const OP_RETURN_VERSION = 0x01;

export function encodeCheckpointForOpReturn(checkpointHash: string): string {
  const hashBytes = Buffer.from(checkpointHash, "hex");
  if (hashBytes.length !== 32) {
    throw new Error("checkpoint_hash_must_be_32_bytes");
  }
  const payload = Buffer.concat([OP_RETURN_PREFIX, Buffer.from([OP_RETURN_VERSION]), hashBytes]);
  return payload.toString("hex");
}

export function decodeOpReturnCheckpoint(dataHex: string): { version: number; checkpointHash: string } | null {
  const buf = Buffer.from(dataHex, "hex");
  if (buf.length < 35) return null;
  const prefix = buf.subarray(0, 2).toString("ascii");
  if (prefix !== "EC") return null;
  const version = buf[2];
  const checkpointHash = buf.subarray(3, 35).toString("hex");
  return { version, checkpointHash };
}
