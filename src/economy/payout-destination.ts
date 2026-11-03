// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { createHash } from "node:crypto";
import { bech32, bech32m, createBase58check } from "@scure/base";
import type { BitcoinNetwork } from "../common/types.js";

/**
 * Where a user is paid: a Lightning address from their own wallet (name@domain), or an on-chain
 * address from their own wallet. EdgeCoder never creates or holds the keys for either.
 *
 * Payouts today are Lightning only (src/economy/payout-service.ts pays BOLT11 invoices fetched
 * from a Lightning address). On-chain addresses are validated so the user gets a precise error,
 * but callers refuse to save them until an on-chain payout path exists.
 */
export type PayoutDestinationKind = "lightning_address" | "onchain";

export type PayoutDestinationValidation =
  | { ok: true; kind: PayoutDestinationKind; destination: string; network: BitcoinNetwork }
  | { ok: false; error: PayoutDestinationError; detail: string };

export type PayoutDestinationError =
  | "destination_required"
  | "invalid_lightning_address"
  | "invalid_onchain_address"
  | "address_network_mismatch"
  | "unsupported_destination";

/** Same shape the coordinator's LNURL resolver accepts (src/economy/payouts.ts lnurlPayEndpoint). */
const LIGHTNING_ADDRESS_RE = /^([a-z0-9._%+-]{1,64})@([a-z0-9.-]{1,253})$/;
const DOMAIN_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** Hosts that can never be a public Lightning address server. */
const BLOCKED_HOST_SUFFIXES = ["localhost", ".local", ".internal", ".lan", ".home", ".corp", ".localdomain", ".onion", ".test", ".example", ".invalid"];

const BECH32_HRP: Record<BitcoinNetwork, string> = { bitcoin: "bc", testnet: "tb", signet: "tb", regtest: "bcrt" };
/** Base58 version bytes: P2PKH, P2SH. Testnet, signet and regtest share them. */
const BASE58_VERSIONS: Record<"main" | "test", { p2pkh: number; p2sh: number }> = {
  main: { p2pkh: 0x00, p2sh: 0x05 },
  test: { p2pkh: 0x6f, p2sh: 0xc4 }
};

const base58check = createBase58check((data) => new Uint8Array(createHash("sha256").update(data).digest()));

function networkLabel(n: BitcoinNetwork): string {
  return n === "bitcoin" ? "Bitcoin mainnet" : n;
}

export function validateLightningAddress(raw: string): { ok: true; address: string } | { ok: false; detail: string } {
  const address = raw.trim().toLowerCase();
  const m = LIGHTNING_ADDRESS_RE.exec(address);
  if (!m) return { ok: false, detail: "A Lightning address looks like name@wallet-domain.com." };
  const [, name, domain] = m;
  if (name.startsWith(".") || name.endsWith(".") || name.includes("..")) return { ok: false, detail: "The name part of the Lightning address is not valid." };
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => DOMAIN_LABEL_RE.test(l))) return { ok: false, detail: "The domain of the Lightning address is not valid." };
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,63}$/.test(tld) && !/^xn--[a-z0-9-]{2,59}$/.test(tld)) return { ok: false, detail: "The domain of the Lightning address must end in a real top-level domain." };
  if (BLOCKED_HOST_SUFFIXES.some((s) => domain === s.replace(/^\./, "") || domain.endsWith(s))) {
    return { ok: false, detail: "The domain of the Lightning address must be a public internet domain." };
  }
  return { ok: true, address };
}

/** Network an on-chain address belongs to, or why it is not a valid address. */
export function onchainAddressNetworks(raw: string): { ok: true; address: string; networks: BitcoinNetwork[] } | { ok: false; detail: string } {
  const s = raw.trim();
  if (/^(bc|tb|bcrt)1/i.test(s)) {
    if (s !== s.toLowerCase() && s !== s.toUpperCase()) return { ok: false, detail: "Bech32 addresses must not mix upper and lower case." };
    const lower = s.toLowerCase();
    const hrp = lower.slice(0, lower.lastIndexOf("1"));
    // Witness version is the first data character; v0 uses bech32, v1+ bech32m (BIP 350).
    const versionChar = lower.charAt(hrp.length + 1);
    const version = "qpzry9x8gf2tvdw0s3jn54khce6mua7l".indexOf(versionChar);
    if (version < 0 || version > 16) return { ok: false, detail: "Unknown witness version." };
    const coder = version === 0 ? bech32 : bech32m;
    const decoded = coder.decodeUnsafe(lower, 90);
    if (!decoded || decoded.prefix !== hrp) return { ok: false, detail: "The address checksum does not match (check for a typo)." };
    const [ver, ...rest] = decoded.words;
    const program = bech32.fromWordsUnsafe(rest);
    if (!program || ver !== version) return { ok: false, detail: "The address data is not valid." };
    if (program.length < 2 || program.length > 40) return { ok: false, detail: "The witness program has the wrong length." };
    if (version === 0 && program.length !== 20 && program.length !== 32) return { ok: false, detail: "A version 0 address must be P2WPKH or P2WSH." };
    if (version === 1 && program.length !== 32) return { ok: false, detail: "A Taproot address must carry a 32-byte key." };
    const networks = (Object.keys(BECH32_HRP) as BitcoinNetwork[]).filter((n) => BECH32_HRP[n] === hrp);
    return { ok: true, address: lower, networks };
  }
  if (/^[123mn][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(s)) {
    let bytes: Uint8Array;
    try {
      bytes = base58check.decode(s);
    } catch {
      return { ok: false, detail: "The address checksum does not match (check for a typo)." };
    }
    if (bytes.length !== 21) return { ok: false, detail: "The address has the wrong length." };
    const v = bytes[0];
    if (v === BASE58_VERSIONS.main.p2pkh || v === BASE58_VERSIONS.main.p2sh) return { ok: true, address: s, networks: ["bitcoin"] };
    if (v === BASE58_VERSIONS.test.p2pkh || v === BASE58_VERSIONS.test.p2sh) return { ok: true, address: s, networks: ["testnet", "signet", "regtest"] };
    return { ok: false, detail: "Unknown address version." };
  }
  return { ok: false, detail: "Not a Bitcoin address." };
}

/**
 * Validate a payout destination for `network` (the portal's WALLET_DEFAULT_NETWORK). A string with
 * an `@` is a Lightning address; anything else must be an on-chain address on that network.
 */
export function validatePayoutDestination(raw: unknown, network: BitcoinNetwork): PayoutDestinationValidation {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "destination_required", detail: "Enter a Lightning address or a Bitcoin address from your own wallet." };
  const value = raw.trim();
  if (value.length > 256) return { ok: false, error: "unsupported_destination", detail: "That destination is too long." };
  if (value.includes("@")) {
    const ln = validateLightningAddress(value);
    return ln.ok ? { ok: true, kind: "lightning_address", destination: ln.address, network } : { ok: false, error: "invalid_lightning_address", detail: ln.detail };
  }
  if (/^(lnbc|lntb|lntbs|lnbcrt)[0-9]/i.test(value)) {
    return { ok: false, error: "unsupported_destination", detail: "That is a one-time Lightning invoice. Use a Lightning address (name@domain) so every payout can reach you." };
  }
  if (/^lnurl1/i.test(value)) {
    return { ok: false, error: "unsupported_destination", detail: "Use the Lightning address (name@domain) your wallet shows instead of an LNURL." };
  }
  const chain = onchainAddressNetworks(value);
  if (!chain.ok) return { ok: false, error: "invalid_onchain_address", detail: chain.detail };
  if (!chain.networks.includes(network)) {
    return {
      ok: false,
      error: "address_network_mismatch",
      detail: `That address is for ${chain.networks.map(networkLabel).join("/")}, but payouts here are on ${networkLabel(network)}.`
    };
  }
  return { ok: true, kind: "onchain", destination: chain.address, network };
}

/** Payout kinds the payout service can actually pay today. */
export const PAYABLE_DESTINATION_KINDS: ReadonlySet<PayoutDestinationKind> = new Set(["lightning_address"]);
