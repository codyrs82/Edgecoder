// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/** BITCOIN_NETWORK names real bitcoin ("bitcoin", or "mainnet" as some tooling spells it). */
export function isMainnetNetwork(network: string | undefined): boolean {
  const n = (network ?? "").trim().toLowerCase();
  return n === "bitcoin" || n === "mainnet";
}

/**
 * The control-plane faucet (POST /credits/:accountId/faucet) mints cSats with no sats behind them:
 * test networks only. On mainnet it is refused whatever else is set, and mainnet solvency never
 * counts faucet grants as backing (src/economy/payout-reconcile.ts).
 */
export function faucetAllowed(network: string | undefined): boolean {
  return !isMainnetNetwork(network);
}
