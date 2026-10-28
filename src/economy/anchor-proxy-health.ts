// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { BitcoinNodeHealth } from "./bitcoin-rpc.js";

/**
 * #128 review: GET /health for the anchor proxy. `healthCheck()` reports an unreachable node as
 * `{ reachable: false }` instead of throwing, so the status code must come from `reachable`:
 * Fly's check only looks at the status, and a dead bitcoind has to fail it (503).
 */
export async function anchorProxyHealth(
  provider: { healthCheck(): Promise<BitcoinNodeHealth> },
  network: string
): Promise<{ status: 200 | 503; body: Record<string, unknown> }> {
  try {
    const health = await provider.healthCheck();
    if (!health.reachable) return { status: 503, body: { ok: false, error: "bitcoind_unreachable", provider: "anchor-proxy" } };
    return {
      status: 200,
      body: {
        ok: true,
        network,
        chain: health.chain,
        blocks: health.blocks,
        walletAvailable: health.walletAvailable,
        provider: "anchor-proxy"
      }
    };
  } catch {
    return { status: 503, body: { ok: false, error: "health_check_failed", provider: "anchor-proxy" } };
  }
}

/** Host (and port) of an RPC URL, never its credentials or path, for startup logs. */
export function rpcHostForLog(raw: string | undefined): string {
  try {
    return new URL(raw ?? "").host || "(unset)";
  } catch {
    return "(invalid url)";
  }
}
