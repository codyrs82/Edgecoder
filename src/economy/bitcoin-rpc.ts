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
    // 1. Create a raw transaction with an OP_RETURN output
    const utxos = (await this.rpc("listunspent", [1, 9999999])) as Array<{
      txid: string;
      vout: number;
      amount: number;
    }>;
    if (utxos.length === 0) {
      throw new Error("bitcoind_no_utxos: wallet has no spendable inputs");
    }
    // Pick the first utxo with enough value for a fee (OP_RETURN is dust-free)
    const utxo = utxos[0];
    const feeRate = ((await this.rpc("estimatesmartfee", [6])) as { feerate?: number }).feerate ?? 0.00001;
    // OP_RETURN tx is ~250 vbytes
    const feeBtc = feeRate * 250 / 1000;
    const changeBtc = utxo.amount - feeBtc;
    if (changeBtc < 0) {
      throw new Error("bitcoind_insufficient_funds: utxo too small for anchor fee");
    }
    const changeAddress = (await this.rpc("getrawchangeaddress")) as string;
    const outputs: Record<string, unknown>[] = [
      { data: dataHex },
      { [changeAddress]: Number(changeBtc.toFixed(8)) }
    ];
    const rawTx = (await this.rpc("createrawtransaction", [
      [{ txid: utxo.txid, vout: utxo.vout }],
      outputs
    ])) as string;
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

  async getConfirmations(txid: string): Promise<AnchorConfirmationResult> {
    try {
      const tx = (await this.rpc("gettransaction", [txid])) as {
        confirmations?: number;
        blockhash?: string;
        blockheight?: number;
      };
      const confirmations = tx.confirmations ?? 0;
      return {
        confirmed: confirmations > 0,
        confirmations,
        blockHeight: tx.blockheight,
        blockHash: tx.blockhash
      };
    } catch {
      return { confirmed: false, confirmations: 0 };
    }
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
    try {
      const txRes = await request(`${base}/tx/${txid}`, { method: "GET" });
      if (txRes.statusCode < 200 || txRes.statusCode >= 300) {
        return { confirmed: false, confirmations: 0 };
      }
      const tx = (await txRes.body.json()) as {
        status?: { confirmed?: boolean; block_height?: number; block_hash?: string };
      };
      if (!tx.status?.confirmed) {
        return { confirmed: false, confirmations: 0 };
      }
      // Get current tip height to compute confirmations
      const tipRes = await request(`${base}/blocks/tip/height`, { method: "GET" });
      const tipHeight = tipRes.statusCode >= 200 && tipRes.statusCode < 300
        ? Number(await tipRes.body.text())
        : 0;
      const blockHeight = tx.status.block_height ?? 0;
      const confirmations = tipHeight > 0 && blockHeight > 0 ? tipHeight - blockHeight + 1 : 0;
      return {
        confirmed: true,
        confirmations,
        blockHeight,
        blockHash: tx.status.block_hash
      };
    } catch {
      return { confirmed: false, confirmations: 0 };
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

  async getConfirmations(txid: string): Promise<AnchorConfirmationResult> {
    try {
      const result = (await this.proxyRequest(`/anchor/confirm/${txid}`)) as {
        ok: boolean;
        confirmed: boolean;
        confirmations: number;
        blockHeight?: number;
        blockHash?: string;
      };
      return {
        confirmed: result.confirmed,
        confirmations: result.confirmations,
        blockHeight: result.blockHeight,
        blockHash: result.blockHash
      };
    } catch {
      return { confirmed: false, confirmations: 0 };
    }
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
}

/* ------------------------------------------------------------------ */
/*  Factory – create provider from environment variables              */
/* ------------------------------------------------------------------ */

export function createBitcoinAnchorProviderFromEnv(network: BitcoinNetwork): BitcoinAnchorProvider {
  const provider = (process.env.BITCOIN_ANCHOR_PROVIDER ?? "mock").toLowerCase();
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
  if (provider === "blockstream") {
    return new BlockstreamProvider(network);
  }
  if (process.env.NODE_ENV === "production") {
    console.error("FATAL: BITCOIN_ANCHOR_PROVIDER must be set to 'bitcoind', 'anchor-proxy', or 'blockstream' in production (mock produces fake transactions)");
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
