// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/**
 * What one helper (tentacle) model call may set aside (#525). Each network call carries a price
 * ceiling (`maxCSats`) and the coordinator caps the call's reserve at it. The ceiling is the
 * smaller of
 *
 * - what is left of the tentacle's own budget, and
 * - what is left of the session's tentacle budget after the ceilings of the other helper calls
 *   in flight right now (their reserves are held on the account at the same time),
 *
 * so four helpers on a 25 cSat budget set aside at most 100 cSats together, never 4 × 53.6. A call
 * whose ceiling is below the smallest useful reserve (MIN_HELPER_CALL_CSATS) does not start: it
 * waits while other helpers' calls hold the session budget, and otherwise stops the helper with a
 * message that says why. Free places (this computer, your machines, a lease) hold nothing.
 */

/** The smallest ceiling a paid helper call starts with: below it the reply would be cut short. */
export const MIN_HELPER_CALL_CSATS = 0.05;

/** Reply tokens a helper call may write (sent as max_tokens): a bounded reply keeps the reserve small. */
export const HELPER_MAX_TOKENS = 8192;

/** The helper's reply cap: EDGECODER_TENTACLE_MAX_TOKENS when set (256..32768), else HELPER_MAX_TOKENS. */
export function helperMaxTokens(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EDGECODER_TENTACLE_MAX_TOKENS);
  return env.EDGECODER_TENTACLE_MAX_TOKENS && Number.isFinite(n) ? Math.min(32_768, Math.max(256, Math.floor(n))) : HELPER_MAX_TOKENS;
}

const round = (n: number) => Number(Math.max(0, n).toFixed(6));

/** Whether calls on `model` are billed per call on the network (auto, network/<m>); mine/, reserved/ and local tags are not. */
export function paidWorker(model: string): boolean {
  return model === "auto" || model.startsWith("network/");
}

/** One call's ceiling: the tentacle's budget left, within the session's budget left after the others' holds. */
export function helperCallCeiling(o: { tentacleLeft: number; sessionLeft: number; heldByOthers: number }): number {
  return round(Math.min(o.tentacleLeft, o.sessionLeft - Math.max(0, o.heldByOthers)));
}

/** Why a paid helper call can't start on `ceiling`, or null when it can. */
export function ceilingRefusal(ceiling: number, o: { tentacleBudget: number; tentacleLeft: number }): string | null {
  if (ceiling >= MIN_HELPER_CALL_CSATS) return null;
  const fmt = (c: number) => `${c < 10 ? c.toFixed(2) : Math.round(c)} cSats`;
  return o.tentacleLeft < MIN_HELPER_CALL_CSATS
    ? `budget reached: ${fmt(Math.max(0, o.tentacleLeft))} of the tentacle's ${fmt(o.tentacleBudget)} is left, less than one call sets aside (${fmt(MIN_HELPER_CALL_CSATS)})`
    : `budget reached: the session's tentacle budget left (${fmt(Math.max(0, ceiling))}) is less than one call sets aside (${fmt(MIN_HELPER_CALL_CSATS)})`;
}

/** The ceilings of a session's helper calls in flight (held on the account until each call ends). */
export class CallHolds {
  private readonly holds = new Map<number, number>();
  private next = 0;
  private readonly waiters = new Set<() => void>();

  /** The sum of the holds, without `except`. */
  total(except?: number): number {
    let n = 0;
    for (const [k, v] of this.holds) if (k !== except) n += v;
    return round(n);
  }

  /** Hold `cSats` for a call; returns its key. */
  hold(cSats: number): number {
    const k = ++this.next;
    this.holds.set(k, Math.max(0, cSats));
    return k;
  }

  release(key: number | undefined): void {
    if (key === undefined || !this.holds.delete(key)) return;
    for (const w of [...this.waiters]) w();
  }

  /** Resolves when a hold is released (or after `ms`, or on abort). */
  async released(ms: number, signal?: AbortSignal): Promise<void> {
    if (!this.holds.size || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}
