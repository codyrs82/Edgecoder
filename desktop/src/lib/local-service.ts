/**
 * Calls to EdgeCoder's local service (the IDE provider on :4304) while it restarts, e.g. during an
 * auto-update: fetch() rejects at the network level (WebKit "Load failed", Chromium "Failed to
 * fetch", Firefox "NetworkError…", all TypeErrors) because nothing is listening for a few seconds.
 * Those calls are retried with backoff for about 10 s, with `localServiceRestarting` set so forms
 * can say "EdgeCoder's local service is restarting, trying again…"; then a plain error, never the
 * raw "Load failed". Only failures with no response are retried: the request never reached the
 * service, so a save isn't applied twice.
 */

import { writable } from "svelte/store";

export const RESTARTING_TEXT = "EdgeCoder's local service is restarting, trying again…";
export const UNREACHABLE_SAVE_TEXT = "Couldn't reach EdgeCoder's local service. Your changes weren't saved. Try again.";
export const UNREACHABLE_TEXT = "Couldn't reach EdgeCoder's local service. Try again.";

/** Waits between tries: about 10 s in all. */
export const RESTART_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 1_500, 2_000, 2_250, 2_500];

/** True while a call is waiting for the local service to come back. */
export const localServiceRestarting = writable(false);

export class LocalServiceUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalServiceUnreachableError";
  }
}

/** A fetch that failed before any response: nothing listening, connection refused or reset. */
export function isNetworkFailure(e: unknown): boolean {
  if (e instanceof LocalServiceUnreachableError) return false;
  if ((e as { name?: string })?.name === "AbortError") return false;
  if (e instanceof TypeError) return true;
  return /load failed|failed to fetch|networkerror|network connection was lost|could not connect to the server|econnrefused/i.test(String((e as Error)?.message ?? e));
}

let waiting = 0;

/**
 * `send()` against the local service, retried while it restarts. Throws LocalServiceUnreachableError
 * (with the save wording for anything but a GET) once the retries are used up; other errors and
 * any HTTP response pass through untouched.
 */
export async function fetchLocalService(
  send: () => Promise<Response>,
  opts: { method?: string; delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void>; signal?: AbortSignal | null } = {},
): Promise<Response> {
  const delays = opts.delaysMs ?? RESTART_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let marked = false;
  try {
    for (let i = 0; ; i++) {
      try {
        return await send();
      } catch (e) {
        if (!isNetworkFailure(e) || opts.signal?.aborted) throw e;
        if (i >= delays.length) {
          const write = (opts.method ?? "GET").toUpperCase() !== "GET";
          throw new LocalServiceUnreachableError(write ? UNREACHABLE_SAVE_TEXT : UNREACHABLE_TEXT);
        }
        if (!marked) {
          marked = true;
          if (waiting++ === 0) localServiceRestarting.set(true);
        }
        await sleep(delays[i]);
      }
    }
  } finally {
    if (marked && --waiting === 0) localServiceRestarting.set(false);
  }
}
