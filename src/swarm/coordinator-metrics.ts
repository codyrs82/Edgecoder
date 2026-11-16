// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { ServiceMetrics } from "../common/metrics.js";
import type { ReconcileResult } from "../economy/payout-reconcile.js";

/*
 * #14: coordinator gauges for /metrics. Each one reads state the coordinator already keeps in
 * memory, at scrape time: no I/O, no new bookkeeping. Anchor state lives in Postgres only, so it
 * is not exported here (the anchor proxy reports the node's state).
 */

export interface CoordinatorMetricSources {
  queue: () => { queued: number; agents: number; results: number };
  /** Agents seen recently (heartbeat or register within the connected window). */
  connectedAgents: () => number;
  /** Agents in the in-memory registry, seen recently or not (pruned after AGENT_CAPABILITY_TTL_MS). */
  knownAgents?: () => number;
  payoutReconcile: () => ReconcileResult | null;
  /** Fast dispatch: pickup time (claimable to claimed) over recent claims, and nudges sent. */
  dispatch?: () => { count: number; p50: number; p90: number; nudges: number };
  /** Task privacy (src/swarm/envelope-policy.ts): envelope deliveries since start. */
  envelope?: () => { encrypted: number; plaintext: number; encryptFailed: number; rederived: number; decryptFailed: number };
}

/** ReconcileResult["status"], plus "never_run" until the first run completes. */
export const PAYOUT_RECONCILE_STATES = ["ok", "alert", "tripped", "error", "unsupported", "never_run"] as const;

export function registerCoordinatorMetrics(metrics: ServiceMetrics, sources: CoordinatorMetricSources): void {
  metrics.gauge("edgecoder_queue_depth", "Tasks waiting in the swarm queue.", () => sources.queue().queued);
  metrics.gauge("edgecoder_queue_results", "Task results held by the swarm queue.", () => sources.queue().results);
  metrics.gauge("edgecoder_connected_agents", "Agents seen by this coordinator in the last 2 minutes.", sources.connectedAgents);
  if (sources.knownAgents) metrics.gauge("edgecoder_known_agents", "Agents in this coordinator's registry (seen within the retention window).", sources.knownAgents);
  if (sources.dispatch) {
    const d = sources.dispatch;
    metrics.gauge("edgecoder_dispatch_pickup_p50_ms", "Median time from a subtask becoming claimable to an agent claiming it, recent claims (ms).", () => d().p50);
    metrics.gauge("edgecoder_dispatch_pickup_p90_ms", "90th percentile time from a subtask becoming claimable to an agent claiming it, recent claims (ms).", () => d().p90);
    metrics.gauge("edgecoder_dispatch_nudges_sent", "work_available nudges sent to agents since start.", () => d().nudges);
  }
  if (sources.envelope) {
    const e = sources.envelope;
    // Counts since start (gauges read from in-memory counters, like the dispatch nudges above).
    metrics.gauge("edgecoder_envelope_encrypted_deliveries_total", "Subtasks sent to agents as encrypted envelopes since start.", () => e().encrypted);
    metrics.gauge("edgecoder_envelope_plaintext_deliveries_total", "Subtasks sent in plaintext to agents without an envelope key since start (ENVELOPE_REQUIRED off).", () => e().plaintext);
    metrics.gauge("edgecoder_envelope_encrypt_failures_total", "Envelope builds that failed since start; the subtask was handed back, nothing sent.", () => e().encryptFailed);
    metrics.gauge("edgecoder_envelope_key_rederived_total", "Encrypted results opened with a re-derived key (e.g. after a coordinator restart) since start.", () => e().rederived);
    metrics.gauge("edgecoder_envelope_decrypt_failures_total", "Encrypted results that could not be opened since start.", () => e().decryptFailed);
  }
  metrics.stateGauge(
    "edgecoder_payout_reconcile_status",
    "Outcome of the last payout reconciliation run (1 for the current state).",
    "status",
    PAYOUT_RECONCILE_STATES,
    () => sources.payoutReconcile()?.status ?? "never_run"
  );
  metrics.gauge(
    "edgecoder_payout_reconcile_last_run_timestamp_seconds",
    "When payout reconciliation last ran (0 if it has not).",
    () => (sources.payoutReconcile()?.atMs ?? 0) / 1000
  );
}
