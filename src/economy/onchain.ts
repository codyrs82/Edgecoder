// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";
import { bech32m } from "@scure/base";
import { request, type Dispatcher } from "undici";
import type { BitcoinNetwork } from "../common/types.js";
import { LIGHTNING_RPC_TIMEOUT_MS } from "./lightning.js";
import { onchainAddressNetworks } from "./payout-destination.js";

/**
 * On-chain Bitcoin through the coordinator's own LND wallet (no separate wallet service):
 *
 * - funding: each account gets a deposit address from LND (NewAddress), deposits are watched with
 *   GetTransactions and credited as cSats (1 sat = 1 cSat) after ONCHAIN_DEPOSIT_CONFIRMATIONS
 *   (src/economy/onchain-deposits.ts);
 * - payouts: earnings above ONCHAIN_PAYOUT_MIN_SATS go out in periodic batches with SendMany
 *   (src/economy/onchain-payouts.ts).
 *
 * This file holds the configuration, the LND REST calls and the pure helpers both sides share.
 * Everything is behind ONCHAIN_ENABLED (default off).
 */

export type OnchainAddressType = "p2tr" | "p2wkh";
export type OnchainFeePayer = "host" | "edgecoder";

export interface OnchainConfig {
  enabled: boolean;
  network: BitcoinNetwork;
  addressType: OnchainAddressType;
  /** Confirmations before a deposit is credited. */
  depositConfirmations: number;
  /** Deposits below this are recorded but not credited (dust / uneconomic to spend). */
  depositMinSats: number;
  /** Largest single deposit credited automatically; larger ones are held for an operator. 0 = no cap. */
  depositMaxSats: number;
  /** Deposits credited per account over a rolling 24 h; above it new deposits are held. 0 = no cap. */
  depositMaxAccountDailySats: number;
  /** How often the deposit watcher and the batch runner tick. */
  pollMs: number;
  /** Smallest on-chain payout (the output value). */
  payoutMinSats: number;
  /** A new payout batch is built at most this often (across every coordinator on the database). */
  payoutIntervalMs: number;
  /** A batch is only sent while LND's fee estimate is at or below this (sat/vB). */
  payoutMaxFeeRateSatVb: number;
  /** Confirmation target for LND's fee estimate. */
  payoutTargetConf: number;
  /** Who pays the network fee: the host (taken from the payout, default) or EdgeCoder (fee pool). */
  payoutFeePayer: OnchainFeePayer;
  /** Confirmations before a payout counts as paid. */
  payoutConfirmations: number;
  /** A batch whose SendMany outcome is unknown (crash, timeout) and that LND does not know after this long is failed and its payouts released. */
  broadcastGraceMs: number;
}

/** Mainnet defaults when a cap is unset: one deposit up to 0.01 BTC, 0.02 BTC per account per day credited automatically. */
export const MAINNET_DEFAULT_DEPOSIT_MAX_SATS = 1_000_000;
export const MAINNET_DEFAULT_DEPOSIT_MAX_ACCOUNT_DAILY_SATS = 2_000_000;

/**
 * Virtual bytes of a batch transaction charged to one payout when the host pays the fee: its
 * output (43 vB for Taproot, the largest common type) plus a share of the inputs, change and
 * header. A single-payout batch (one input, one output, change) is about 165 vB; larger batches
 * share inputs and cost less per payout. The host's fee cap is this times the batch fee rate.
 */
export const ONCHAIN_VBYTES_PER_PAYOUT = 165;

/** Below this an output is non-standard (dust) on every network. */
export const ONCHAIN_DUST_SATS = 546;

export function onchainConfigFromEnv(network: BitcoinNetwork, env: NodeJS.ProcessEnv = process.env): OnchainConfig {
  const mainnet = network === "bitcoin";
  const num = (k: string, d: number, min = 0) => {
    const v = env[k];
    if (v === undefined || v.trim() === "") return d;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < min) throw new Error(`[onchain] ${k} must be a whole number >= ${min}`);
    return n;
  };
  const enabled = ["1", "true", "yes", "on"].includes((env.ONCHAIN_ENABLED ?? "").trim().toLowerCase());
  const addressType = (env.ONCHAIN_ADDRESS_TYPE ?? "p2tr").trim().toLowerCase();
  if (addressType !== "p2tr" && addressType !== "p2wkh") throw new Error("[onchain] ONCHAIN_ADDRESS_TYPE must be p2tr or p2wkh");
  const payer = (env.ONCHAIN_PAYOUT_FEE_PAYER ?? "host").trim().toLowerCase();
  if (payer !== "host" && payer !== "edgecoder") throw new Error("[onchain] ONCHAIN_PAYOUT_FEE_PAYER must be host or edgecoder");
  return {
    enabled,
    network,
    addressType,
    depositConfirmations: num("ONCHAIN_DEPOSIT_CONFIRMATIONS", mainnet ? 3 : 1, 1),
    depositMinSats: Math.max(ONCHAIN_DUST_SATS, num("ONCHAIN_DEPOSIT_MIN_SATS", 10_000)),
    depositMaxSats: num("ONCHAIN_DEPOSIT_MAX_SATS", mainnet ? MAINNET_DEFAULT_DEPOSIT_MAX_SATS : 0),
    depositMaxAccountDailySats: num("ONCHAIN_DEPOSIT_MAX_ACCOUNT_DAILY_SATS", mainnet ? MAINNET_DEFAULT_DEPOSIT_MAX_ACCOUNT_DAILY_SATS : 0),
    pollMs: num("ONCHAIN_POLL_MS", 30_000, 5_000),
    payoutMinSats: Math.max(ONCHAIN_DUST_SATS, num("ONCHAIN_PAYOUT_MIN_SATS", 50_000)),
    payoutIntervalMs: num("ONCHAIN_PAYOUT_INTERVAL_MS", 21_600_000, 60_000),
    // Regtest LND falls back to 25 sat/vB with no fee history, so the test networks get headroom.
    payoutMaxFeeRateSatVb: num("ONCHAIN_PAYOUT_MAX_FEE_RATE", mainnet ? 30 : 100, 1),
    payoutTargetConf: num("ONCHAIN_PAYOUT_TARGET_CONF", 6, 1),
    payoutFeePayer: payer,
    payoutConfirmations: num("ONCHAIN_PAYOUT_CONFIRMATIONS", 1, 1),
    broadcastGraceMs: num("ONCHAIN_BROADCAST_GRACE_MS", 600_000, 60_000)
  };
}

/** What the wallets show about on-chain (GET /economy/payouts/:accountId policy.onchain). */
export function onchainPolicyView(c: OnchainConfig) {
  return {
    enabled: c.enabled,
    depositConfirmations: c.depositConfirmations,
    depositMinSats: c.depositMinSats,
    depositMaxSats: c.depositMaxSats,
    depositMaxAccountDailySats: c.depositMaxAccountDailySats,
    payoutMinSats: c.payoutMinSats,
    payoutIntervalMs: c.payoutIntervalMs,
    payoutMaxFeeRateSatVb: c.payoutMaxFeeRateSatVb,
    payoutFeePayer: c.payoutFeePayer,
    /** Most a host-paid payout is charged in network fee at the cap. */
    payoutMaxFeeSats: c.payoutFeePayer === "host" ? c.payoutMaxFeeRateSatVb * ONCHAIN_VBYTES_PER_PAYOUT : 0,
    payoutConfirmations: c.payoutConfirmations
  };
}

/* ------------------------------------------------------------------ */
/*  Addresses                                                          */
/* ------------------------------------------------------------------ */

export type OnchainPayoutAddressCheck = { ok: true; address: string } | { ok: false; error: "invalid_onchain_address" | "address_network_mismatch" | "unsupported_address_type"; detail: string };

/**
 * A payout address must be SegWit (bech32 v0, or bech32m v1+ such as Taproot) with the HRP of the
 * coordinator's network: bc (mainnet), tb (testnet, signet), bcrt (regtest). Legacy base58
 * addresses are refused: every wallet in use today can receive to a bc1 address.
 */
export function validateOnchainPayoutAddress(raw: string, network: BitcoinNetwork): OnchainPayoutAddressCheck {
  const v = onchainAddressNetworks(raw ?? "");
  if (!v.ok) return { ok: false, error: "invalid_onchain_address", detail: v.detail };
  if (!/^(bc|tb|bcrt)1/.test(v.address)) return { ok: false, error: "unsupported_address_type", detail: "Use a SegWit or Taproot address (it starts with bc1, tb1 or bcrt1)." };
  if (!v.networks.includes(network)) {
    return { ok: false, error: "address_network_mismatch", detail: `That address is for ${v.networks.join("/")}, but payouts here are on ${network === "bitcoin" ? "Bitcoin mainnet" : network}.` };
  }
  return { ok: true, address: v.address };
}

/** BIP 21 URI for a deposit address. Bech32 is upper-cased so a QR code can use alphanumeric mode. */
export function bitcoinUri(address: string): string {
  const a = address.trim();
  return /^(bc|tb|bcrt)1/i.test(a) ? `bitcoin:${a.toUpperCase()}` : `bitcoin:${a}`;
}

/* ------------------------------------------------------------------ */
/*  Fees                                                               */
/* ------------------------------------------------------------------ */

/** sat/kw (LND walletrpc EstimateFee) to whole sat/vB, rounded up: 1 vB = 4 weight units. */
export function satPerKwToSatPerVbyte(satPerKw: number): number {
  return Math.max(1, Math.ceil((satPerKw * 4) / 1000));
}

/**
 * Split a batch's actual network fee. With the host paying, each payout is charged an equal share
 * of the fee, never more than the cap reserved with it; whatever is left (a batch that needed more
 * inputs than the per-payout allowance assumed) is EdgeCoder's. With EdgeCoder paying, all of it is.
 */
export function allocateBatchFee(totalFeeSats: number, capsSats: number[], payer: OnchainFeePayer): { sharesSats: number[]; edgecoderSats: number } {
  const total = Math.max(0, Math.floor(totalFeeSats));
  if (payer === "edgecoder" || capsSats.length === 0) return { sharesSats: capsSats.map(() => 0), edgecoderSats: total };
  const n = capsSats.length;
  const base = Math.floor(total / n);
  let remainder = total - base * n;
  const shares = capsSats.map((cap) => Math.min(Math.max(0, Math.floor(cap)), base));
  // The odd sats go to payouts that still have room under their cap.
  for (let i = 0; i < n && remainder > 0; i++) {
    if (shares[i] < capsSats[i]) {
      shares[i] += 1;
      remainder -= 1;
    }
  }
  return { sharesSats: shares, edgecoderSats: total - shares.reduce((s, x) => s + x, 0) };
}

/* ------------------------------------------------------------------ */
/*  The node's on-chain wallet                                         */
/* ------------------------------------------------------------------ */

export interface ChainOutput {
  address: string;
  outputIndex: number;
  amountSats: number;
  isOurAddress: boolean;
}

export interface ChainTransaction {
  txid: string;
  /** Net effect on the wallet (negative for a send). */
  amountSats: number;
  confirmations: number;
  blockHeight: number;
  totalFeesSats: number;
  label: string;
  outputs: ChainOutput[];
  timestampMs: number;
}

/** The node calls the on-chain flows need. LND implements them; tests use a fake. */
export interface OnchainWallet {
  newAddress(type: OnchainAddressType): Promise<string>;
  /** Wallet transactions from `startHeight` up to the tip, unconfirmed ones included. */
  listTransactions(input: { startHeight: number }): Promise<ChainTransaction[]>;
  /** Fee rate (sat/vB) for confirmation within `targetConf` blocks. */
  estimateFeeRate(targetConf: number): Promise<number>;
  /** Broadcast one transaction paying every output. Returns its txid. */
  sendMany(input: { outputs: Record<string, number>; satPerVbyte: number; label: string }): Promise<{ txid: string }>;
}

/** Whether a SendMany error means the node did not create the transaction (safe to release the batch now). */
export function sendManyFailureIsFinal(error: string): boolean {
  if (/^lnd_sendmany_http_(400|409|422)/.test(error) || /^lnd_sendmany_http_500:/.test(error)) {
    // LND answers 500 with a gRPC message for refused requests: insufficient funds, a bad address,
    // a fee above its own maximum. A transport failure never carries one.
    return /insufficient|not enough|invalid address|unknown address|decode|fee rate|too high|dust|amount|unconfirmed|exceeds/i.test(error);
  }
  return error === "onchain_paused";
}

/** Subset of LND's lnrpc.Transaction REST JSON. */
interface LndChainTx {
  tx_hash?: string;
  amount?: string;
  num_confirmations?: number;
  block_height?: number;
  time_stamp?: string;
  total_fees?: string;
  label?: string;
  output_details?: Array<{ address?: string; output_index?: string | number; amount?: string; is_our_address?: boolean }>;
}

const int = (v: unknown, what: string): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n)) throw new Error(`onchain_malformed:${what}`);
  return n;
};

/** Fails closed: a transaction without a txid or with unreadable amounts makes the whole read an error. */
export function interpretLndTransactions(body: { transactions?: LndChainTx[] }): ChainTransaction[] {
  if (!body || !Array.isArray(body.transactions)) throw new Error("onchain_malformed:transactions");
  return body.transactions.map((t) => {
    if (typeof t.tx_hash !== "string" || !/^[0-9a-f]{64}$/i.test(t.tx_hash)) throw new Error("onchain_malformed:tx_hash");
    return {
      txid: t.tx_hash.toLowerCase(),
      amountSats: int(t.amount ?? "0", "amount"),
      confirmations: Math.max(0, int(t.num_confirmations ?? 0, "num_confirmations")),
      blockHeight: Math.max(0, int(t.block_height ?? 0, "block_height")),
      totalFeesSats: Math.max(0, int(t.total_fees ?? "0", "total_fees")),
      label: typeof t.label === "string" ? t.label : "",
      timestampMs: Math.max(0, int(t.time_stamp ?? "0", "time_stamp")) * 1000,
      outputs: (t.output_details ?? []).map((o) => ({
        address: typeof o.address === "string" ? o.address : "",
        outputIndex: int(o.output_index ?? 0, "output_index"),
        amountSats: int(o.amount ?? "0", "output_amount"),
        isOurAddress: o.is_our_address === true
      }))
    };
  });
}

const LND_ADDRESS_TYPE: Record<OnchainAddressType, number> = { p2wkh: 0, p2tr: 4 };

/**
 * LND REST (>= 0.15 for Taproot addresses and output_details; checked against 0.20.7):
 * GET /v1/newaddress, GET /v1/transactions, GET /v2/wallet/estimatefee/{conf}, POST /v1/transactions/many.
 * Macaroon permissions: address:write, onchain:read, onchain:write.
 */
export class LndOnchainWallet implements OnchainWallet {
  constructor(
    private readonly baseUrl: string,
    private readonly macaroonHex: string,
    private readonly dispatcher?: Dispatcher,
    private readonly timeoutMs = LIGHTNING_RPC_TIMEOUT_MS
  ) {}

  private async call(method: "GET" | "POST", path: string, body?: unknown, tag = "lnd_onchain"): Promise<unknown> {
    const res = await request(`${this.baseUrl}${path}`, {
      dispatcher: this.dispatcher,
      method,
      headers: { "content-type": "application/json", "Grpc-Metadata-macaroon": this.macaroonHex },
      body: body === undefined ? undefined : JSON.stringify(body),
      headersTimeout: this.timeoutMs,
      bodyTimeout: this.timeoutMs
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const text = await res.body.text().catch(() => "");
      let message = "";
      try {
        const parsed = JSON.parse(text) as { message?: string; error?: string };
        message = parsed.message ?? parsed.error ?? "";
      } catch {
        /* not JSON */
      }
      throw new Error(`${tag}_http_${res.statusCode}:${message.slice(0, 200)}`);
    }
    return res.body.json();
  }

  async newAddress(type: OnchainAddressType): Promise<string> {
    const body = (await this.call("GET", `/v1/newaddress?type=${LND_ADDRESS_TYPE[type]}`)) as { address?: string };
    if (typeof body.address !== "string" || !body.address) throw new Error("onchain_malformed:address");
    return body.address;
  }

  async listTransactions(input: { startHeight: number }): Promise<ChainTransaction[]> {
    const start = Math.max(0, Math.floor(input.startHeight));
    return interpretLndTransactions((await this.call("GET", `/v1/transactions?start_height=${start}&end_height=-1`)) as { transactions?: LndChainTx[] });
  }

  async estimateFeeRate(targetConf: number): Promise<number> {
    const body = (await this.call("GET", `/v2/wallet/estimatefee/${Math.max(1, Math.floor(targetConf))}`)) as { sat_per_kw?: string | number };
    return satPerKwToSatPerVbyte(int(body.sat_per_kw, "sat_per_kw"));
  }

  async sendMany(input: { outputs: Record<string, number>; satPerVbyte: number; label: string }): Promise<{ txid: string }> {
    const AddrToAmount: Record<string, string> = {};
    for (const [address, sats] of Object.entries(input.outputs)) AddrToAmount[address] = String(Math.floor(sats));
    const body = (await this.call(
      "POST",
      "/v1/transactions/many",
      { AddrToAmount, sat_per_vbyte: String(Math.max(1, Math.floor(input.satPerVbyte))), label: input.label, min_confs: 1, spend_unconfirmed: false },
      "lnd_sendmany"
    )) as { txid?: string };
    if (typeof body.txid !== "string" || !/^[0-9a-f]{64}$/i.test(body.txid)) throw new Error("onchain_malformed:txid");
    return { txid: body.txid.toLowerCase() };
  }
}

/* ------------------------------------------------------------------ */
/*  Mock wallet (dev with LIGHTNING_PROVIDER=mock, tests)              */
/* ------------------------------------------------------------------ */

const BECH32_HRP_BY_NETWORK: Record<BitcoinNetwork, string> = { bitcoin: "bc", testnet: "tb", signet: "tb", regtest: "bcrt" };

/** A valid Taproot address for `network` from 32 bytes (dev and tests only). */
export function taprootAddressFor(network: BitcoinNetwork, key: Uint8Array): string {
  return bech32m.encode(BECH32_HRP_BY_NETWORK[network], [1, ...bech32m.toWords(key)], 90);
}

/**
 * An in-memory on-chain wallet. Deposits and blocks are simulated by the caller (receive, mine);
 * sendMany records a labelled send whose fee is the requested rate times a simple size estimate.
 */
export class MockOnchainWallet implements OnchainWallet {
  height = 100;
  feeRateSatVb = 2;
  readonly txs: ChainTransaction[] = [];
  readonly sent: Array<{ outputs: Record<string, number>; satPerVbyte: number; label: string; txid: string }> = [];
  private counter = 0;
  /** Set to make the next sendMany throw this message (after optionally recording the tx: `broadcastAnyway`). */
  failNextSend: { error: string; broadcastAnyway?: boolean } | null = null;
  constructor(readonly network: BitcoinNetwork = "regtest") {}

  private hex(n: number, seed: string): string {
    return createHash("sha256").update(`${n}:${seed}`).digest("hex");
  }

  async newAddress(): Promise<string> {
    this.counter += 1;
    const key = new Uint8Array(32);
    for (let i = 0; i < 32; i++) key[i] = (this.counter * 31 + i * 7) % 256;
    return taprootAddressFor(this.network, key);
  }

  /** A payment into the wallet: one output to `address`. Returns the txid. */
  receive(address: string, amountSats: number, confirmations = 0, vout = 0): string {
    this.counter += 1;
    const txid = this.hex(this.counter, address);
    this.txs.push({ txid, amountSats, confirmations, blockHeight: confirmations > 0 ? this.height - confirmations + 1 : 0, totalFeesSats: 0, label: "", timestampMs: Date.now(), outputs: [{ address, outputIndex: vout, amountSats, isOurAddress: true }] });
    return txid;
  }

  /** Mine `n` blocks: every listed transaction gains confirmations (unconfirmed ones confirm in the first). */
  mine(n = 1): void {
    for (let i = 0; i < n; i++) {
      this.height += 1;
      for (const t of this.txs) {
        if (t.confirmations === 0) {
          t.confirmations = 1;
          t.blockHeight = this.height;
        } else t.confirmations += 1;
      }
    }
  }

  /** Remove a transaction (replaced, double-spent or reorged out). */
  drop(txid: string): void {
    const i = this.txs.findIndex((t) => t.txid === txid);
    if (i >= 0) this.txs.splice(i, 1);
  }

  async listTransactions(input: { startHeight: number }): Promise<ChainTransaction[]> {
    return this.txs.filter((t) => t.blockHeight === 0 || t.blockHeight >= input.startHeight).map((t) => structuredClone(t));
  }

  async estimateFeeRate(): Promise<number> {
    return this.feeRateSatVb;
  }

  async sendMany(input: { outputs: Record<string, number>; satPerVbyte: number; label: string }): Promise<{ txid: string }> {
    this.counter += 1;
    const txid = this.hex(this.counter, input.label);
    const n = Object.keys(input.outputs).length;
    const fee = Math.ceil(input.satPerVbyte * (11 + 68 + 43 * (n + 1)));
    const record = () => {
      const total = Object.values(input.outputs).reduce((s, v) => s + v, 0);
      this.txs.push({
        txid,
        amountSats: -(total + fee),
        confirmations: 0,
        blockHeight: 0,
        totalFeesSats: fee,
        label: input.label,
        timestampMs: Date.now(),
        outputs: Object.entries(input.outputs).map(([address, amountSats], i) => ({ address, outputIndex: i, amountSats, isOurAddress: false }))
      });
      this.sent.push({ ...input, txid });
    };
    const fail = this.failNextSend;
    if (fail) {
      this.failNextSend = null;
      if (fail.broadcastAnyway) record();
      throw new Error(fail.error);
    }
    record();
    return { txid };
  }
}
