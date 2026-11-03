// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Minimal BOLT11 decoder: enough to validate a payout invoice before paying it.
 * Extracts network, amount (msat), payment hash, timestamp and expiry, and verifies the
 * bech32 checksum. Signature recovery is left to the Lightning node that pays.
 */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

export interface DecodedBolt11 {
  /** "bc" mainnet, "tb" testnet, "tbs" signet, "bcrt" regtest. */
  networkPrefix: string;
  network: "bitcoin" | "testnet" | "signet" | "regtest";
  /** Undefined for amountless invoices. */
  amountMsat?: number;
  paymentHash: string;
  /** Unix seconds. */
  timestamp: number;
  /** Seconds after timestamp; BOLT11 default 3600. */
  expirySeconds: number;
  description?: string;
  /** Hex sha256 the invoice commits to instead of a description (tag h); LNURL-pay uses it for the metadata. */
  descriptionHash?: string;
  payeePubkey?: string;
}

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i];
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function words5ToBytes(words: number[], count: number): Buffer {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8 && out.length < count) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  return Buffer.from(out.slice(0, count));
}

function wordsToInt(words: number[]): number {
  let n = 0;
  for (const w of words) n = n * 32 + w;
  return n;
}

const MULTIPLIER_MSAT: Record<string, number> = { m: 1e8, u: 1e5, n: 1e2, p: 1e-1 }; // × value → msat (1 BTC = 1e11 msat)

export function decodeBolt11(invoice: string): DecodedBolt11 {
  const raw = invoice.trim();
  const lower = raw.toLowerCase();
  if (lower !== raw && raw.toUpperCase() !== raw) throw new Error("bolt11_mixed_case");
  const sep = lower.lastIndexOf("1");
  if (sep < 3 || sep + 7 > lower.length) throw new Error("bolt11_malformed");
  const hrp = lower.slice(0, sep);
  const dataPart = lower.slice(sep + 1);
  const words: number[] = [];
  for (const c of dataPart) {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new Error("bolt11_bad_charset");
    words.push(v);
  }
  if (polymod([...hrpExpand(hrp), ...words]) !== 1) throw new Error("bolt11_bad_checksum");

  const m = /^ln(bcrt|tbs|tb|bc)(\d*)([munp]?)$/.exec(hrp);
  if (!m) throw new Error("bolt11_bad_hrp");
  const networkPrefix = m[1];
  const network = networkPrefix === "bc" ? "bitcoin" : networkPrefix === "tb" ? "testnet" : networkPrefix === "tbs" ? "signet" : "regtest";
  let amountMsat: number | undefined;
  if (m[2]) {
    const value = Number(m[2]);
    const mult = m[3] ? MULTIPLIER_MSAT[m[3]] : 1e11;
    if (m[3] === "p" && value % 10 !== 0) throw new Error("bolt11_sub_msat_amount");
    amountMsat = Math.round(value * mult);
    if (!Number.isFinite(amountMsat) || amountMsat <= 0) throw new Error("bolt11_bad_amount");
  } else if (m[3]) {
    throw new Error("bolt11_bad_amount");
  }

  // data: 7 words timestamp, tagged fields, 104 words signature, 6 words checksum
  const body = words.slice(0, words.length - 6);
  if (body.length < 7 + 104) throw new Error("bolt11_too_short");
  const timestamp = wordsToInt(body.slice(0, 7));
  const tagged = body.slice(7, body.length - 104);
  let paymentHash: string | undefined;
  let expirySeconds = 3600;
  let description: string | undefined;
  let descriptionHash: string | undefined;
  let payeePubkey: string | undefined;
  let i = 0;
  while (i + 3 <= tagged.length) {
    const type = tagged[i];
    const len = tagged[i + 1] * 32 + tagged[i + 2];
    const data = tagged.slice(i + 3, i + 3 + len);
    if (data.length < len) throw new Error("bolt11_truncated_field");
    i += 3 + len;
    switch (type) {
      case 1: // p: payment hash, 52 words
        if (len === 52) paymentHash = words5ToBytes(data, 32).toString("hex");
        break;
      case 6: // x: expiry
        expirySeconds = wordsToInt(data);
        break;
      case 13: // d: description
        description = words5ToBytes(data, Math.floor((len * 5) / 8)).toString("utf8");
        break;
      case 23: // h: description hash, 52 words
        if (len === 52) descriptionHash = words5ToBytes(data, 32).toString("hex");
        break;
      case 19: // n: payee pubkey, 53 words
        if (len === 53) payeePubkey = words5ToBytes(data, 33).toString("hex");
        break;
      default:
        break;
    }
  }
  if (!paymentHash) throw new Error("bolt11_missing_payment_hash");
  return { networkPrefix, network, amountMsat, paymentHash, timestamp, expirySeconds, description, descriptionHash, payeePubkey };
}

export function bolt11IsExpired(decoded: DecodedBolt11, nowMs: number = Date.now(), safetyMarginSeconds = 60): boolean {
  return nowMs / 1000 > decoded.timestamp + decoded.expirySeconds - safetyMarginSeconds;
}
