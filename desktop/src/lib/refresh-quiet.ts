// Quiet refresh failures for polled pages (the Network page). One failed refresh (a coordinator
// deploy, a dropped connection) must not flash a red banner: the last view stays up with a muted
// "Updated 40 s ago · reconnecting…" note, the page retries on a short backoff, and the banner
// shows only after LOUD_AFTER_MS of continuous failure, or at once for an auth error. With no view
// yet there is nothing to keep showing, so the banner comes after FIRST_LOAD_FAILURES tries instead.
// Framework-free, so it is unit-tested directly.

/** Retry delays after the 1st, 2nd and 3rd+ consecutive failure. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;
/** Continuous failure before the red banner shows. */
export const LOUD_AFTER_MS = 60_000;
/** No view yet: the banner after this many failed tries in a row (about 7 s with the backoff). */
export const FIRST_LOAD_FAILURES = 3;

export function retryDelayMs(failures: number): number {
  if (failures < 1) return 0;
  return RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length) - 1];
}

/** An HTTP status that retrying won't fix: the banner shows at once. */
export function isAuthStatus(status: unknown): boolean {
  return status === 401 || status === 403;
}

export interface RefreshState {
  /** When the last refresh succeeded (null: never). */
  lastOkMs: number | null;
  /** When the current run of failures began (null: not failing). */
  failingSinceMs: number | null;
  /** Consecutive failures. */
  failures: number;
  /** The last failure was an auth error. */
  authError: boolean;
}

export const initialRefreshState = (): RefreshState => ({ lastOkMs: null, failingSinceMs: null, failures: 0, authError: false });

export function refreshSucceeded(_s: RefreshState, nowMs: number): RefreshState {
  return { lastOkMs: nowMs, failingSinceMs: null, failures: 0, authError: false };
}

export function refreshFailed(s: RefreshState, nowMs: number, status?: unknown): RefreshState {
  return { lastOkMs: s.lastOkMs, failingSinceMs: s.failingSinceMs ?? nowMs, failures: s.failures + 1, authError: isAuthStatus(status) };
}

/** Show the red banner: an auth error, failing for LOUD_AFTER_MS or more, or (no view yet) FIRST_LOAD_FAILURES tries. */
export function showBanner(s: RefreshState, nowMs: number): boolean {
  if (s.failingSinceMs === null) return false;
  if (s.authError || nowMs - s.failingSinceMs >= LOUD_AFTER_MS) return true;
  return s.lastOkMs === null && s.failures >= FIRST_LOAD_FAILURES;
}

/** "Updated 40 s ago · reconnecting…" while quietly failing with a view up; null otherwise. */
export function staleNote(s: RefreshState, nowMs: number): string | null {
  if (s.failingSinceMs === null || s.lastOkMs === null || showBanner(s, nowMs)) return null;
  return `Updated ${ago(nowMs - s.lastOkMs)} · reconnecting…`;
}

function ago(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec} s ago`;
  const min = Math.round(sec / 60);
  return `${min} min ago`;
}
