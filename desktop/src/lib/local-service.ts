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
import { noteServiceNetworkFailure } from "./service-status";

export const RESTARTING_TEXT = "EdgeCoder's local service is restarting, trying again…";
export const UNREACHABLE_SAVE_TEXT = "Couldn't reach EdgeCoder's local service. Your changes weren't saved. Try again.";
export const UNREACHABLE_TEXT = "Couldn't reach EdgeCoder's local service. Try again.";
/**
 * The request failed at the network level, yet the service answers /health: it is up, and the
 * request was turned away before it arrived (a CORS rule, e.g. a method its preflight doesn't
 * allow). Not a restart, so it isn't retried, and not "couldn't reach".
 */
export const BLOCKED_SAVE_TEXT = "EdgeCoder's local service is running, but it blocked this request before it arrived. Your changes weren't saved. Restart EdgeCoder; if it keeps happening, update it.";
export const BLOCKED_TEXT = "EdgeCoder's local service is running, but it blocked this request before it arrived. Restart EdgeCoder; if it keeps happening, update it.";

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

/**
 * What to show for an HTTP error from the local service: the server's own message for a 4xx or
 * 5xx ({ error } or { message }), never "couldn't reach" (it answered). A bare status when the
 * body says nothing.
 */
export function serviceErrorText(status: number, body: { error?: unknown; message?: unknown } = {}): string {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const error = str(body.error);
  const message = str(body.message);
  // A code ("not_found") or Fastify's reason phrase ({ error: "Not Found", message: "Route PATCH:/x
  // not found" }) next to a message: the message says more. Bot routes send the sentence as `error`.
  const label = !!error && !!message && (/^[a-z0-9_.-]+$/.test(error) || /^[A-Z][a-z]+(?: [A-Z][a-z]+)*$/.test(error));
  const text = (label ? message : error ?? message) ?? `It answered ${status}.`;
  return status >= 500 ? `EdgeCoder's local service hit an error (${status}): ${text}` : text;
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
  opts: {
    method?: string;
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal | null;
    /**
     * Whether the service answers (GET /health), asked once after the first network failure: when
     * it does, the request was blocked (BLOCKED_TEXT) rather than the service restarting.
     */
    probe?: () => Promise<boolean>;
  } = {},
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
        // The shared service status (service-status.ts) looks at /health now.
        if (i === 0) noteServiceNetworkFailure();
        const write = (opts.method ?? "GET").toUpperCase() !== "GET";
        if (i === 0 && opts.probe && (await opts.probe().catch(() => false))) {
          throw new LocalServiceUnreachableError(write ? BLOCKED_SAVE_TEXT : BLOCKED_TEXT);
        }
        if (i >= delays.length) throw new LocalServiceUnreachableError(write ? UNREACHABLE_SAVE_TEXT : UNREACHABLE_TEXT);
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
