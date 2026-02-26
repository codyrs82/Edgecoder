// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

export interface ReconnectionState {
  peerId: string;
  attempt: number;
  nextRetryMs: number;
  maxAttempts: number;
  gaveUp: boolean;
}

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 8;
const JITTER_FRACTION = 0.1;

export class ReconnectionManager {
  private readonly states = new Map<string, ReconnectionState>();
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly defaultMaxAttempts: number;

  constructor(options?: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    maxAttempts?: number;
  }) {
    this.baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.defaultMaxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  private getOrCreate(peerId: string): ReconnectionState {
    let state = this.states.get(peerId);
    if (!state) {
      state = {
        peerId,
        attempt: 0,
        nextRetryMs: 0,
        maxAttempts: this.defaultMaxAttempts,
        gaveUp: false,
      };
      this.states.set(peerId, state);
    }
    return state;
  }

  /**
   * Computes the raw exponential backoff delay for the current attempt,
   * capped at maxDelayMs.
   */
  private computeBaseDelay(attempt: number): number {
    const raw = this.baseDelayMs * Math.pow(2, attempt);
    return Math.min(raw, this.maxDelayMs);
  }

  /**
   * Adds jitter of +/-10% to the given delay.
   */
  private applyJitter(delay: number): number {
    const jitterRange = delay * JITTER_FRACTION;
    const jitter = (Math.random() * 2 - 1) * jitterRange; // [-jitterRange, +jitterRange]
    return Math.max(0, Math.round(delay + jitter));
  }

  /**
   * Schedules a reconnection for the given peer. Increments the attempt
   * counter and computes the next retry delay with exponential backoff
   * and jitter.
   *
   * Returns the computed delay in milliseconds.
   */
  scheduleReconnect(peerId: string): number {
    const state = this.getOrCreate(peerId);
    if (state.gaveUp) return -1;

    const baseDelay = this.computeBaseDelay(state.attempt);
    const delay = this.applyJitter(baseDelay);
    state.nextRetryMs = delay;
    state.attempt++;

    if (state.attempt >= state.maxAttempts) {
      state.gaveUp = true;
    }

    return delay;
  }

  /**
   * Returns true if the peer has not exceeded its max retry attempts.
   */
  shouldRetry(peerId: string): boolean {
    const state = this.states.get(peerId);
    if (!state) return true; // no state means no failures yet
    return !state.gaveUp;
  }

  /**
   * Records a successful connection, fully resetting backoff state for
   * the given peer.
   */
  recordSuccess(peerId: string): void {
    this.states.delete(peerId);
  }

  /**
   * Returns the current backoff delay in milliseconds for the peer.
   * Returns 0 if no reconnection has been scheduled.
   */
  getBackoffMs(peerId: string): number {
    const state = this.states.get(peerId);
    return state?.nextRetryMs ?? 0;
  }

  /**
   * Returns the current attempt count for the peer.
   */
  getAttemptCount(peerId: string): number {
    const state = this.states.get(peerId);
    return state?.attempt ?? 0;
  }

  /**
   * Returns the full reconnection state for a peer, or undefined.
   */
  getState(peerId: string): ReconnectionState | undefined {
    return this.states.get(peerId);
  }

  /**
   * Clears all reconnection state.
   */
  resetAll(): void {
    this.states.clear();
  }
}
