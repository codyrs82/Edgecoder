// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * The worker's buffer of results it could not deliver (coordinator unreachable, rate limited).
 *
 * A result the coordinator refused for good is dropped, not retried: 409 `lease_expired` means the
 * claim's lease lapsed and the subtask went back on the queue (src/swarm/lease-gate.ts), so the
 * coordinator will refuse it every time. Kept in the buffer, it was retried forever and, because a
 * flush stops at the first failure, held back every result queued behind it.
 */

/**
 * The coordinator will never take this result: its claim's lease lapsed (409 lease_expired), or it is
 * sealed with an envelope key the coordinator cannot open and this agent holds no claim on it (409
 * envelope_result_unusable: network run 19, a result buffered before the agent restarted).
 */
export function isPermanentResultRefusal(error: unknown): boolean {
  const e = error as { statusCode?: unknown; message?: unknown } | null;
  return !!e && e.statusCode === 409 && typeof e.message === "string" && (e.message.includes("lease_expired") || e.message.includes("envelope_result_unusable"));
}

/**
 * A buffered result remembers the coordinator that issued its claim (drain-failover.ts: an agent
 * serving through a peer during a planned drain still owes its earlier claims' results to the home
 * coordinator, which holds their leases and billing). Rows written before this change are the bare
 * payload and go to the active coordinator, as before.
 */
const ISSUER_WRAP = "edgecoderPendingResult";

/**
 * `envelopeKeyId`: the agent's X25519 public key an encrypted result was sealed for. The agent makes
 * a new envelope key pair every time it starts, so a result buffered before a restart can never be
 * opened by the coordinator afterwards (network run 19: a new Mac's first flush after starting sent
 * one, refused three times as an authentication failure, and it held back the results behind it).
 */
export function encodePendingResult(payload: unknown, issuerUrl?: string | null, envelopeKeyId?: string): string {
  if (!issuerUrl && !envelopeKeyId) return JSON.stringify(payload);
  return JSON.stringify({ [ISSUER_WRAP]: 1, ...(issuerUrl ? { issuerUrl } : {}), ...(envelopeKeyId ? { envelopeKeyId } : {}), payload });
}

export function decodePendingResult(parsed: unknown): { payload: unknown; issuerUrl?: string; envelopeKeyId?: string } {
  const w = parsed as Record<string, unknown> | null;
  if (w && typeof w === "object" && w[ISSUER_WRAP] === 1 && "payload" in w && (typeof w.issuerUrl === "string" || typeof w.envelopeKeyId === "string")) {
    return { payload: w.payload, ...(typeof w.issuerUrl === "string" ? { issuerUrl: w.issuerUrl } : {}), ...(typeof w.envelopeKeyId === "string" ? { envelopeKeyId: w.envelopeKeyId } : {}) };
  }
  return { payload: parsed };
}

/** An envelope-encrypted result payload (it carries the sealed output, not the plaintext). */
function isSealedResult(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).encryptedPayload === "string";
}

/** Thrown by a flush's post when the result's coordinator cannot be reached from here yet: kept, skipped, no attempt counted. */
export class ResultNotRoutableYetError extends Error {
  constructor(issuerUrl: string) {
    super(`result_not_routable_yet: ${issuerUrl}`);
  }
}

export interface PendingResultStore {
  listPendingResults(limit?: number): Array<{ subtaskId: string; payload: string; attempts: number }>;
  markResultSynced(subtaskId: string): void;
  incrementResultAttempt(subtaskId: string): void;
}

export interface FlushOutcome {
  flushed: string[];
  dropped: string[];
  /** Kept for later: owed to a coordinator the agent cannot reach right now. */
  skipped?: string[];
  /** The result the flush stopped at (a failure worth retrying later), if any. */
  stoppedAt?: string;
}

/**
 * Send buffered results oldest first. A delivered one leaves the buffer; one refused for good
 * (isPermanentResultRefusal) is dropped and logged once, and the flush goes on; any other failure
 * counts an attempt and stops the flush (the coordinator is likely still unreachable).
 */
export async function flushPendingResultBuffer(
  store: PendingResultStore,
  post: (payload: unknown, issuerUrl?: string) => Promise<unknown>,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
  limit = 20,
  opts: { envelopeKeyId?: string } = {}
): Promise<FlushOutcome> {
  const outcome: FlushOutcome = { flushed: [], dropped: [] };
  const pending = store.listPendingResults(limit);
  if (pending.length === 0) return outcome;
  log.info(`flushing ${pending.length} buffered result(s)`);
  for (const row of pending) {
    let payload: unknown;
    let issuerUrl: string | undefined;
    let envelopeKeyId: string | undefined;
    try {
      ({ payload, issuerUrl, envelopeKeyId } = decodePendingResult(JSON.parse(row.payload)));
    } catch {
      store.markResultSynced(row.subtaskId);
      outcome.dropped.push(row.subtaskId);
      log.warn(`dropped unreadable buffered result: ${row.subtaskId}`);
      continue;
    }
    // Sealed for an envelope key of an earlier run of this agent (or before keys were recorded, which
    // was also an earlier run): nobody can open it now, so it is not sent.
    if (opts.envelopeKeyId && isSealedResult(payload) && envelopeKeyId !== opts.envelopeKeyId) {
      store.markResultSynced(row.subtaskId);
      outcome.dropped.push(row.subtaskId);
      log.warn(`dropped buffered result ${row.subtaskId}: sealed with this agent's envelope key from before it restarted; the coordinator cannot open it`);
      continue;
    }
    try {
      await post(payload, issuerUrl);
      store.markResultSynced(row.subtaskId);
      outcome.flushed.push(row.subtaskId);
      log.info(`flushed result: ${row.subtaskId}`);
    } catch (error) {
      // Its coordinator is not reachable from here yet (the agent is away from it): later.
      if (error instanceof ResultNotRoutableYetError) {
        (outcome.skipped ??= []).push(row.subtaskId);
        continue;
      }
      if (isPermanentResultRefusal(error)) {
        store.markResultSynced(row.subtaskId);
        outcome.dropped.push(row.subtaskId);
        log.warn(`dropped buffered result ${row.subtaskId}: the coordinator refused it for good (${String((error as { message?: unknown }).message ?? "").includes("envelope_result_unusable") ? "envelope_result_unusable: no claim here and it cannot be opened" : "lease_expired: the claim lapsed and the call went back on the queue"})`);
        continue;
      }
      store.incrementResultAttempt(row.subtaskId);
      log.warn(`flush failed for ${row.subtaskId} (attempt ${row.attempts + 1}), stopping`);
      outcome.stoppedAt = row.subtaskId;
      break;
    }
  }
  return outcome;
}
