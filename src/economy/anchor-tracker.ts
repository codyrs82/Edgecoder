// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

import type { BitcoinAnchorRecord } from "../common/types.js";
import {
  anchorCheckpointWithOutcome,
  isLiveAnchor,
  reconcileAnchor,
  reconcileAnchors,
  refreshAnchor,
  type AnchorDeps,
  type ConfirmationEvent,
  type ReconcileConfig,
  type ReconcileEvent
} from "./anchoring.js";

/*
 * #46: the loop that drives an anchor row through its states against the provider.
 *
 *   (no row) --broadcast--> broadcasting --txid returned--> pending
 *   pending  --N confirmations (BITCOIN_ANCHOR_CONFIRMATIONS, default 6)--> anchored
 *   anchored --block hash changed, or tx no longer in a block--> pending          (reorg)
 *   pending  --unconfirmed and gone from the mempool--> failed --re-broadcast--> pending (new row)
 *   pending  --conflicted (negative confirmations)--> failed --re-broadcast--> pending (new row)
 *
 * The transitions themselves live in anchoring.ts (applyConfirmation, reconcileAnchor). This
 * module decides which rows to check and when:
 * - every pending row, plus anchored rows until they are `reorgWatchConfirmations` deep, plus
 *   the newest live anchor of each kind;
 * - a provider that cannot answer changes nothing: rows keep their state, the pass stops, and
 *   the next one is scheduled with exponential backoff;
 * - a restart resumes from the stored rows. The first pass only asks for confirmations; a
 *   pending row is never broadcast again while its transaction is alive.
 */

export interface AnchorTrackerConfig {
  requiredConfirmations: number;
  /** Delay between polls while the provider answers. */
  pollMs: number;
  reconcile: ReconcileConfig;
  /** An anchored row is re-verified for reorgs until it is this deep. */
  reorgWatchConfirmations: number;
  /** First retry delay after a failed poll; doubles per consecutive failure up to maxBackoffMs. */
  retryBaseMs: number;
  maxBackoffMs: number;
}

/** Tuning that only the tracker reads. Depth, poll interval and reconcile config come from the caller. */
export function anchorTrackerTuningFromEnv(
  env: NodeJS.ProcessEnv = process.env
): Pick<AnchorTrackerConfig, "reorgWatchConfirmations" | "retryBaseMs" | "maxBackoffMs"> {
  const n = (key: string, fallback: number, min: number) => {
    const v = Number(env[key]);
    return env[key] !== undefined && env[key] !== "" && Number.isFinite(v) && v >= min ? Math.floor(v) : fallback;
  };
  return {
    reorgWatchConfirmations: n("ANCHOR_REORG_WATCH_CONFIRMATIONS", 100, 1),
    retryBaseMs: n("ANCHOR_POLL_RETRY_BASE_MS", 30_000, 1_000),
    maxBackoffMs: n("ANCHOR_POLL_MAX_BACKOFF_MS", 60 * 60 * 1000, 1_000)
  };
}

export type AnchorTrackerEventName =
  | ConfirmationEvent
  | ReconcileEvent
  /** A replacement transaction was broadcast for a checkpoint whose transaction is gone. */
  | "rebroadcast"
  | "rebroadcast_failed"
  /** A dropped stats anchor that a newer stats anchor already covers; not re-broadcast. */
  | "superseded";

export interface AnchorTrackerEvent {
  anchorId: string;
  event: AnchorTrackerEventName;
  /** The row after the transition (for "rebroadcast": the new row). */
  record: BitcoinAnchorRecord;
  error?: string;
}

export interface AnchorTrackerStatus {
  running: boolean;
  lastPollAtMs?: number;
  /** Last poll in which the provider answered for every row checked. */
  lastSuccessAtMs?: number;
  consecutiveFailures: number;
  nextPollDelayMs: number;
  lastError?: string;
}

export interface AnchorTrackerOptions {
  /** Null while anchoring is disabled (no provider or no database): the tracker then does nothing. */
  deps: () => AnchorDeps | null;
  config: AnchorTrackerConfig;
  onEvent?: (event: AnchorTrackerEvent) => void;
  /**
   * Called when a checkpoint gets a txid outside the normal anchor call: a re-broadcast, a
   * recovered crash-left broadcast, or an abandoned transaction that confirmed after all.
   * Lets owners of a copy of the txid (receipt epochs) follow.
   */
  onTxidAssigned?: (record: BitcoinAnchorRecord) => Promise<void>;
  onError?: (error: unknown, where: string) => void;
}

/** Minimal logger shape (pino / Fastify). */
interface EventLog {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/** `onEvent` handler that logs the transitions an operator needs to see. */
export function anchorEventLogger(log: EventLog): (e: AnchorTrackerEvent) => void {
  const names: Partial<Record<AnchorTrackerEventName, [keyof EventLog, string]>> = {
    reorg: ["warn", "bitcoin_anchor_reorg_reverted_to_pending"],
    confirmed: ["info", "bitcoin_anchor_confirmed"],
    unknown: ["warn", "bitcoin_anchor_confirmation_unavailable"],
    conflicted: ["warn", "bitcoin_anchor_conflicted_marked_failed"],
    needs_admin: ["error", "bitcoin_anchor_needs_admin_reconcile"],
    recovered: ["info", "bitcoin_anchor_reconciled_txid_recovered"],
    resurrected: ["info", "bitcoin_anchor_abandoned_tx_confirmed"],
    failed: ["warn", "bitcoin_anchor_reconciled_marked_failed"],
    retry_later: ["warn", "bitcoin_anchor_reconcile_lookup_failed"],
    rebroadcast: ["warn", "bitcoin_anchor_rebroadcast"],
    rebroadcast_failed: ["warn", "bitcoin_anchor_rebroadcast_failed"]
  };
  return (e) => {
    const entry = names[e.event];
    if (!entry) return;
    log[entry[0]]({ anchorId: e.anchorId, epochId: e.record.epochId, txRef: e.record.txRef, error: e.error }, entry[1]);
  };
}

const STATS_PREFIX = "stats:";

export class AnchorTracker {
  private failures = 0;
  private lastPollAtMs?: number;
  private lastSuccessAtMs?: number;
  private lastError?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private inFlight?: Promise<AnchorTrackerEvent[]>;
  /** Checkpoints whose replacement broadcast was refused (budget, fee cap); retried on reconcile. */
  private readonly owed = new Map<string, BitcoinAnchorRecord>();

  constructor(private readonly opts: AnchorTrackerOptions) {}

  /** Poll now (resumes whatever the store holds), then keep polling. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  status(): AnchorTrackerStatus {
    return {
      running: this.running,
      lastPollAtMs: this.lastPollAtMs,
      lastSuccessAtMs: this.lastSuccessAtMs,
      consecutiveFailures: this.failures,
      nextPollDelayMs: this.nextDelayMs(),
      lastError: this.lastError
    };
  }

  /** pollMs while the provider answers; retryBaseMs doubling per consecutive failure, capped. */
  nextDelayMs(): number {
    const { pollMs, retryBaseMs, maxBackoffMs } = this.opts.config;
    if (this.failures === 0) return pollMs;
    return Math.min(maxBackoffMs, retryBaseMs * 2 ** Math.min(this.failures - 1, 30));
  }

  /** One confirmation pass. Concurrent callers share the pass that is already running. */
  poll(): Promise<AnchorTrackerEvent[]> {
    this.inFlight ??= this.pollOnce().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /**
   * Resolve crash-left and stuck rows (anchoring.ts reconcileAnchors), then broadcast a
   * replacement for every checkpoint whose transaction is gone.
   */
  async reconcile(): Promise<AnchorTrackerEvent[]> {
    const deps = this.opts.deps();
    // While the provider is known to be down every lookup would fail and count towards
    // needs_admin; wait for a poll to succeed instead.
    if (!deps || this.failures > 0) return [];
    const out: AnchorTrackerEvent[] = [];
    for (const e of await reconcileAnchors(deps, this.opts.config.requiredConfirmations, this.opts.config.reconcile)) {
      if (e.event === "skipped") continue;
      const latest = (await deps.store.latestAnchorByCheckpoint(e.record.checkpointHash)) ?? e.record;
      out.push(this.emit({ anchorId: e.anchorId, event: e.event, record: latest }));
      if (e.event === "recovered" || e.event === "resurrected") await this.txidAssigned(latest);
      // "still_pending" on an abandoned row: an earlier replacement was refused; try again.
      const gone = e.event === "failed" || (e.event === "still_pending" && e.record.status === "failed");
      if (gone) out.push(await this.rebroadcast(deps, latest));
    }
    for (const row of [...this.owed.values()]) {
      if (!out.some((o) => o.record.checkpointHash === row.checkpointHash)) out.push(await this.rebroadcast(deps, row));
    }
    return out;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.poll()
        .catch((error) => this.opts.onError?.(error, "poll"))
        .finally(() => {
          if (this.running) this.schedule(this.nextDelayMs());
        });
    }, delayMs);
    this.timer.unref?.();
  }

  private emit(event: AnchorTrackerEvent): AnchorTrackerEvent {
    this.opts.onEvent?.(event);
    return event;
  }

  private now(deps: AnchorDeps): number {
    return (deps.now ?? Date.now)();
  }

  private fail(deps: AnchorDeps, error: string): void {
    this.failures += 1;
    this.lastError = error;
    this.lastPollAtMs = this.now(deps);
  }

  private async rowsToCheck(deps: AnchorDeps): Promise<BitcoinAnchorRecord[]> {
    const { store } = deps;
    const rows = [
      ...(await store.listPendingAnchors(50)),
      ...((await store.listAnchorsToReverify?.(this.opts.config.reorgWatchConfirmations, 50)) ?? []),
      ...((await store.latestLiveAnchorPerKind?.()) ?? [])
    ];
    const mock = deps.providerName === "mock";
    const seen = new Set<string>();
    return rows.filter((r) => {
      // Only rows this provider can answer for: asking a real node about a mock txid (or
      // another network's) would read as "dropped" and trigger a replacement.
      if (!isLiveAnchor(r) || seen.has(r.anchorId) || r.anchorNetwork !== deps.network || (r.anchorProvider === "mock") !== mock) return false;
      seen.add(r.anchorId);
      return true;
    });
  }

  private async pollOnce(): Promise<AnchorTrackerEvent[]> {
    const deps = this.opts.deps();
    if (!deps) return [];
    let rows: BitcoinAnchorRecord[];
    try {
      rows = await this.rowsToCheck(deps);
    } catch (error) {
      // The status endpoints show lastError: a code only, the detail goes to the log.
      this.fail(deps, "anchor_store_unavailable");
      this.opts.onError?.(error, "poll_store");
      return [];
    }
    const out: AnchorTrackerEvent[] = [];
    for (const row of rows) {
      const { record, event } = await refreshAnchor(deps, row, this.opts.config.requiredConfirmations);
      out.push(this.emit({ anchorId: row.anchorId, event, record }));
      if (event === "unknown") {
        // The provider could not answer (a missing tx is an answer, not an error). The other
        // rows would fail the same way: stop, keep every state as stored, retry with backoff.
        this.fail(deps, "anchor_provider_unavailable");
        return out;
      }
      if (event === "conflicted") out.push(await this.rebroadcast(deps, record));
      // Reorged out of its block and not in another one: re-broadcast if the mempool lost it too.
      else if (event === "reorg" && !record.blockHash) out.push(...(await this.replaceIfDropped(deps, record)));
    }
    this.failures = 0;
    this.lastError = undefined;
    this.lastPollAtMs = this.lastSuccessAtMs = this.now(deps);
    return out;
  }

  /** A transaction that fell out of the chain: if it is not in the mempool either, abandon it and broadcast again. */
  private async replaceIfDropped(deps: AnchorDeps, record: BitcoinAnchorRecord): Promise<AnchorTrackerEvent[]> {
    const run = async (): Promise<ReconcileEvent> => {
      const fresh = await deps.store.latestAnchorByCheckpoint(record.checkpointHash);
      if (!fresh || fresh.anchorId !== record.anchorId || fresh.status !== "pending" || fresh.txRef !== record.txRef) return "skipped";
      // Same check reconcile runs on a stuck transaction, without waiting for it to get old.
      return reconcileAnchor(deps, fresh, this.opts.config.requiredConfirmations, { ...this.opts.config.reconcile, stuckAfterMs: 0 });
    };
    const event = deps.store.withCheckpointLock ? await deps.store.withCheckpointLock(record.checkpointHash, run) : await run();
    if (event !== "failed") return [];
    const failed = (await deps.store.latestAnchorByCheckpoint(record.checkpointHash)) ?? record;
    return [this.emit({ anchorId: record.anchorId, event, record: failed }), await this.rebroadcast(deps, failed)];
  }

  private async superseded(deps: AnchorDeps, row: BitcoinAnchorRecord): Promise<boolean> {
    if (!row.epochId.startsWith(STATS_PREFIX)) return false;
    const newest = ((await deps.store.latestLiveAnchorPerKind?.()) ?? []).find((r) => r.epochId.startsWith(STATS_PREFIX));
    return Boolean(newest) && newest!.checkpointHash !== row.checkpointHash && newest!.createdAtMs >= row.createdAtMs;
  }

  /** Broadcast a new transaction for the checkpoint of a failed row. The failed row stays for audit. */
  private async rebroadcast(deps: AnchorDeps, row: BitcoinAnchorRecord): Promise<AnchorTrackerEvent> {
    try {
      if (await this.superseded(deps, row)) {
        this.owed.delete(row.checkpointHash);
        return this.emit({ anchorId: row.anchorId, event: "superseded", record: row });
      }
      const { record, broadcast } = await anchorCheckpointWithOutcome(deps, { epochId: row.epochId, checkpointHash: row.checkpointHash });
      this.owed.delete(row.checkpointHash);
      if (!broadcast) return this.emit({ anchorId: record.anchorId, event: "unchanged", record });
      await this.txidAssigned(record);
      return this.emit({ anchorId: record.anchorId, event: "rebroadcast", record });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // An unresolved "broadcasting" row is reconcile's job; anything else is retried from here.
      if (!/^anchor_broadcast_(unreconciled|ambiguous|invalid_txid)/.test(message)) this.owed.set(row.checkpointHash, row);
      else this.owed.delete(row.checkpointHash);
      return this.emit({ anchorId: row.anchorId, event: "rebroadcast_failed", record: row, error: message });
    }
  }

  private async txidAssigned(record: BitcoinAnchorRecord): Promise<void> {
    if (!this.opts.onTxidAssigned || !isLiveAnchor(record)) return;
    try {
      await this.opts.onTxidAssigned(record);
    } catch (error) {
      this.opts.onError?.(error, "onTxidAssigned");
    }
  }
}
