/**
 * Network connectivity, separate from EdgeCoder's own local service (service-status.ts): can this
 * computer reach the EdgeCoder network (the coordinator or the portal)?
 *
 *   online   the last check reached one of them
 *   offline  FAILS_TO_GO_OFFLINE checks in a row reached neither (or the OS says there is no
 *            network); one success brings it back. Debounced so one dropped request never flaps.
 *
 * Offline is a mode, not an error: an app-wide bar says the app runs on this computer only, pages
 * that need the network show "Available when you're back online", network-only bots pause, and on
 * reconnect a short "Back online" toast shows, pages refresh and paused work resumes.
 *
 * Checks run every ONLINE_CHECK_MS while online, quickly (CONFIRM_MS) after a first failure, on a
 * backoff (OFFLINE_BACKOFF_MS) while offline, and at once on the window's online/offline events.
 * Until startConnectivityMonitor() runs (tests, the web build) the state is `online`.
 */

import { writable, type Readable } from "svelte/store";

export type Connectivity = "online" | "offline";
export interface ConnectivityState {
  state: Connectivity;
  /** When it went offline (null while online). */
  offlineSinceMs: number | null;
}

export const OFFLINE_TEXT = "Offline: running on this computer only. Network models, wallet and sync resume when you're back online.";
export const BACK_ONLINE_TEXT = "Back online";
export const BACK_ONLINE_TOAST_MS = 3_000;
export const UNAVAILABLE_OFFLINE_TEXT = "Available when you're back online";

export const FAILS_TO_GO_OFFLINE = 2;
export const ONLINE_CHECK_MS = 30_000;
/** After a first failed check while online: confirm soon rather than in 30 s. */
export const CONFIRM_MS = 2_000;
/** Checks while offline: quick at first, then every 30 s. */
export const OFFLINE_BACKOFF_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000];

export function offlineBackoffMs(checksWhileOffline: number): number {
  return OFFLINE_BACKOFF_MS[Math.min(Math.max(checksWhileOffline, 0), OFFLINE_BACKOFF_MS.length - 1)];
}

/** The debounce, as a pure step: `fails` is the consecutive failed checks before this one. */
export function nextConnectivity(s: ConnectivityState, fails: number, reachable: boolean, nowMs: number): { state: ConnectivityState; fails: number } {
  if (reachable) return { state: { state: "online", offlineSinceMs: null }, fails: 0 };
  const n = fails + 1;
  if (s.state === "offline") return { state: s, fails: n };
  return n >= FAILS_TO_GO_OFFLINE ? { state: { state: "offline", offlineSinceMs: nowMs }, fails: n } : { state: s, fails: n };
}

type EventTarget = Pick<Window, "addEventListener" | "removeEventListener">;

export interface ConnectivityDeps {
  /** True when the coordinator or the portal answers (any HTTP response counts). */
  check: () => Promise<boolean>;
  /** Went offline (after the debounce). */
  onOffline?: () => void;
  /** Came back after being offline. */
  onOnline?: () => void;
  /** The window, for its online/offline events. */
  events?: EventTarget | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export class ConnectivityMonitor implements Readable<ConnectivityState> {
  private value: ConnectivityState = { state: "online", offlineSinceMs: null };
  private store = writable(this.value);
  private fails = 0;
  private offlineChecks = 0;
  private timer: unknown = null;
  private checking: Promise<void> | null = null;
  private running = false;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (id: unknown) => void;
  private onEvent = () => void this.checkNow();

  constructor(private deps: ConnectivityDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  subscribe(run: (v: ConnectivityState) => void, invalidate?: () => void): () => void {
    return this.store.subscribe(run, invalidate as never);
  }

  get current(): ConnectivityState {
    return this.value;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.deps.events?.addEventListener("online", this.onEvent);
    this.deps.events?.addEventListener("offline", this.onEvent);
    void this.checkNow();
  }

  stop(): void {
    this.running = false;
    this.deps.events?.removeEventListener("online", this.onEvent);
    this.deps.events?.removeEventListener("offline", this.onEvent);
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Check now; concurrent calls share one check. */
  checkNow(): Promise<void> {
    if (!this.checking) this.checking = this.checkOnce().finally(() => (this.checking = null));
    return this.checking;
  }

  private async checkOnce(): Promise<void> {
    const reachable = await this.deps.check().catch(() => false);
    if (!this.running) return;
    const was = this.value.state;
    const next = nextConnectivity(this.value, this.fails, reachable, this.now());
    this.fails = next.fails;
    if (next.state.state !== this.value.state || next.state.offlineSinceMs !== this.value.offlineSinceMs) {
      this.value = next.state;
      this.store.set(next.state);
    }
    if (was === "online" && next.state.state === "offline") {
      this.offlineChecks = 0;
      this.deps.onOffline?.();
    } else if (was === "offline" && next.state.state === "online") {
      this.deps.onOnline?.();
    }
    let wait: number;
    if (next.state.state === "online") wait = this.fails > 0 ? CONFIRM_MS : ONLINE_CHECK_MS;
    else wait = offlineBackoffMs(this.offlineChecks++);
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.running) void this.checkNow();
    }, wait);
  }
}

// ---- The app's one monitor -----------------------------------------------------------------

const ONLINE: ConnectivityState = { state: "online", offlineSinceMs: null };
const shared = writable<ConnectivityState>(ONLINE);
let monitor: ConnectivityMonitor | null = null;
let unlink: (() => void) | null = null;

/** The shared connectivity every page reads. */
export const connectivity: Readable<ConnectivityState> = { subscribe: shared.subscribe };

export function startConnectivityMonitor(deps: ConnectivityDeps): ConnectivityMonitor {
  stopConnectivityMonitor();
  monitor = new ConnectivityMonitor(deps);
  unlink = monitor.subscribe((s) => shared.set(s));
  monitor.start();
  return monitor;
}

export function stopConnectivityMonitor(): void {
  monitor?.stop();
  unlink?.();
  monitor = null;
  unlink = null;
  shared.set(ONLINE);
}

/** Run `fn` each time the app comes back online (offline → online). Returns the unsubscribe. */
export function onBackOnline(fn: () => void): () => void {
  let prev: Connectivity | null = null;
  return shared.subscribe((s) => {
    if (prev === "offline" && s.state === "online") fn();
    prev = s.state;
  });
}

/** Tests: set the shared state directly. */
export function setConnectivityForTests(state: Connectivity): void {
  shared.set(state === "online" ? ONLINE : { state, offlineSinceMs: 0 });
}

/**
 * The real check: the OS has a network and the coordinator or the portal answers. Any HTTP
 * response counts (a 5xx is a server problem, not being offline). Plain fetch, so a failure here
 * never raises the red "unreachable" banner.
 */
export async function reachEdgeCoder(urls: string[], opts: { timeoutMs?: number; fetchImpl?: typeof fetch; navigatorOnLine?: () => boolean } = {}): Promise<boolean> {
  const onLine = opts.navigatorOnLine ?? (() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  if (!onLine()) return false;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const one = async (url: string): Promise<boolean> => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      await doFetch(url, { method: "GET", cache: "no-store", signal: ctrl.signal });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  };
  const results = await Promise.all(urls.map(one));
  return results.some(Boolean);
}
