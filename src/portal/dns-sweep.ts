// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import { isDnsConfigured } from "./dns-manager.js";
import type { PortalStore } from "./store.js";

// #16: moved unchanged from server.ts.
const DNS_STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DNS_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily

export async function runDnsStaleSweep(store: PortalStore | null | undefined): Promise<void> {
  if (!store || !isDnsConfigured()) return;
  try {
    const count = await store.markStaleCoordinatorDns(DNS_STALE_THRESHOLD_MS);
    if (count > 0) {
      console.log(`[portal] DNS stale sweep: marked ${count} coordinator(s) as stale`);
    }
  } catch (err) {
    console.error("[portal] DNS stale sweep failed:", err);
  }
}

/** Daily sweep, plus one run 30 s after startup, when DNS is configured. */
export function startDnsStaleSweep(store: PortalStore | null | undefined): void {
  if (!isDnsConfigured()) return;
  setInterval(() => runDnsStaleSweep(store), DNS_SWEEP_INTERVAL_MS);
  setTimeout(() => runDnsStaleSweep(store), 30_000);
}
