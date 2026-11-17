/**
 * One shared state for EdgeCoder's local service (the agent and its IDE provider on :4304), which
 * every page that calls it reads: Network, Compute, Tasks, Logs, Active work, bots and chat.
 *
 *   starting    the app just opened (or was just updated) and the service hasn't answered yet
 *   ready       GET /health answers
 *   restarting  it answered before and stopped; the desktop shell is restarting it
 *   failed      it hasn't answered for FAILED_AFTER_MS in spite of the automatic restarts
 *
 * The app never asks the user whether its own service is running: the shell restarts it by itself
 * (src-tauri/src/service_supervisor.rs: 1 s, 2 s, 5 s, 10 s, then every 30 s). While starting or
 * restarting, pages show a neutral "Starting EdgeCoder's local service…" and wait for it before
 * loading data (whenServiceReady); only `failed` shows one message, with Restart now and View log.
 *
 * Health is probed every READY_POLL_MS while ready, on a short backoff (DOWN_POLL_MS) while it
 * isn't, and at once when a request to the service fails at the network level (noteNetworkFailure).
 * Until startServiceMonitor() runs (the web build, which has no local service, and tests), the
 * status is `ready` and nothing changes for the pages.
 */

import { writable, type Readable } from "svelte/store";

export type ServicePhase = "starting" | "ready" | "restarting" | "failed";
export interface ServiceStatus {
  phase: ServicePhase;
  /** When the service stopped answering (null while ready). */
  downSinceMs: number | null;
}

export const STARTING_TEXT = "Starting EdgeCoder's local service…";
export const FAILED_TEXT = "EdgeCoder's local service won't start.";
/** Not answering this long, automatic restarts and all: `failed`. */
export const FAILED_AFTER_MS = 60_000;
export const READY_POLL_MS = 5_000;
/** Probes while the service is down: quick at first so pages come back as soon as it does. */
export const DOWN_POLL_MS: readonly number[] = [500, 1_000, 1_000, 2_000, 2_000, 3_000];

/** The probe interval after `failures` consecutive failed probes. */
export function downPollMs(failures: number): number {
  return DOWN_POLL_MS[Math.min(Math.max(failures, 1), DOWN_POLL_MS.length) - 1];
}

/** Next state after a probe. */
export function nextStatus(s: ServiceStatus, healthy: boolean, nowMs: number): ServiceStatus {
  if (healthy) return { phase: "ready", downSinceMs: null };
  const downSinceMs = s.downSinceMs ?? nowMs;
  if (nowMs - downSinceMs >= FAILED_AFTER_MS) return { phase: "failed", downSinceMs };
  return { phase: s.phase === "ready" ? "restarting" : s.phase, downSinceMs };
}

export interface ServiceMonitorDeps {
  /** GET /health on the local service; true when it answers 200. */
  probe: () => Promise<boolean>;
  /** "Restart now": the shell stops and starts the service at once. */
  restart?: () => Promise<unknown>;
  /** Runs before `ready` is announced (e.g. re-detect the local backend). */
  onReady?: () => Promise<unknown>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export class ServiceMonitor implements Readable<ServiceStatus> {
  private status: ServiceStatus;
  private store;
  private timer: unknown = null;
  private failures = 0;
  private probing: Promise<void> | null = null;
  private running = false;
  private waiters: Array<() => void> = [];
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (id: unknown) => void;

  constructor(private deps: ServiceMonitorDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
    this.status = { phase: "starting", downSinceMs: this.now() };
    this.store = writable(this.status);
  }

  subscribe(run: (v: ServiceStatus) => void, invalidate?: () => void): () => void {
    return this.store.subscribe(run, invalidate as never);
  }

  get current(): ServiceStatus {
    return this.status;
  }

  /** Start probing (the first probe runs at once). */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.check();
  }

  stop(): void {
    this.running = false;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /** Resolves once the service is ready (at once when it is). */
  whenReady(): Promise<void> {
    if (this.status.phase === "ready") return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** A request failed with no response: look now rather than at the next poll. */
  noteNetworkFailure(): void {
    if (this.running && !this.probing) void this.check();
  }

  /** Probe now; concurrent calls share one probe. */
  check(): Promise<void> {
    if (!this.probing) this.probing = this.probeOnce().finally(() => (this.probing = null));
    return this.probing;
  }

  /** "Restart now": back to `restarting` (the 60 s clock starts over) and ask the shell. */
  async restartNow(): Promise<void> {
    this.set({ phase: "restarting", downSinceMs: this.now() });
    this.failures = 0;
    try {
      await this.deps.restart?.();
    } catch {
      // The probes decide what happens next.
    }
    if (this.running) await this.check();
  }

  private async probeOnce(): Promise<void> {
    const healthy = await this.deps.probe().catch(() => false);
    if (!this.running) return;
    const next = nextStatus(this.status, healthy, this.now());
    if (next.phase === "ready" && this.status.phase !== "ready") {
      await this.deps.onReady?.().catch(() => undefined);
      if (!this.running) return;
    }
    this.failures = healthy ? 0 : this.failures + 1;
    this.set(next);
    this.schedule(healthy ? READY_POLL_MS : downPollMs(this.failures));
  }

  private schedule(ms: number): void {
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.running) void this.check();
    }, ms);
  }

  private set(next: ServiceStatus): void {
    const changed = next.phase !== this.status.phase || next.downSinceMs !== this.status.downSinceMs;
    this.status = next;
    if (changed) this.store.set(next);
    if (next.phase === "ready" && this.waiters.length) {
      const w = this.waiters;
      this.waiters = [];
      for (const fn of w) fn();
    }
  }
}

// ---- The app's one monitor -----------------------------------------------------------------

const READY: ServiceStatus = { phase: "ready", downSinceMs: null };
const shared = writable<ServiceStatus>(READY);
let monitor: ServiceMonitor | null = null;
let unlink: (() => void) | null = null;

/** Running inside the desktop shell (Tauri), which owns a local service; not the web build. */
export function inDesktopShell(): boolean {
  return typeof window !== "undefined" && !!(globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

/** The shared status every page reads. */
export const serviceStatus: Readable<ServiceStatus> = { subscribe: shared.subscribe };

/** True while pages should show the starting notice or the failed message instead of their data. */
export function serviceDown(s: ServiceStatus): boolean {
  return s.phase !== "ready";
}

/** Start watching the local service (App, in the desktop app only). */
export function startServiceMonitor(deps: ServiceMonitorDeps): ServiceMonitor {
  stopServiceMonitor();
  monitor = new ServiceMonitor(deps);
  unlink = monitor.subscribe((s) => shared.set(s));
  monitor.start();
  return monitor;
}

export function stopServiceMonitor(): void {
  monitor?.stop();
  unlink?.();
  monitor = null;
  unlink = null;
  shared.set(READY);
}

/** Resolves once the local service answers (at once without a monitor). */
export function whenServiceReady(): Promise<void> {
  return monitor ? monitor.whenReady() : Promise.resolve();
}

/** Called by fetchLocalService when a request got no response. */
export function noteServiceNetworkFailure(): void {
  monitor?.noteNetworkFailure();
}

export function restartServiceNow(): Promise<void> {
  return monitor ? monitor.restartNow() : Promise.resolve();
}

/**
 * Run `fn` each time the service comes back (restarting/starting/failed → ready), so a page
 * reloads its data on its own. Returns the unsubscribe.
 */
export function onServiceReady(fn: () => void): () => void {
  let prev: ServicePhase | null = null;
  return shared.subscribe((s) => {
    if (prev !== null && prev !== "ready" && s.phase === "ready") fn();
    prev = s.phase;
  });
}

/** Tests: set the shared status directly. */
export function setServiceStatusForTests(s: ServiceStatus | ServicePhase): void {
  shared.set(typeof s === "string" ? { phase: s, downSinceMs: s === "ready" ? null : 0 } : s);
}
