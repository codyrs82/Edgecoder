// Copyright (c) 2025 EdgeCoder
// SPDX-License-Identifier: BUSL-1.1

/*
 * How `edgecoder-install update` (src/install/update.ts) asks a headless agent whether it is idle
 * before restarting it, without opening any port:
 *   - the agent writes agent-status.json in its own HOME (/var/lib/edgecoder/agent-<n>, the only
 *     directory it can write) at start, on every change and every STATUS_INTERVAL_MS: pid, version,
 *     whether it is registered, draining, and how many claims and network calls are running;
 *   - SIGUSR2 (only root or the service account can signal it) starts an update drain: no new
 *     claims, running ones finish. The drain lapses by itself after UPDATE_DRAIN_MS, so an updater
 *     that dies never leaves the machine idle for good;
 *   - SIGHUP ends it (the updater gave up waiting and will try again on its next run).
 * The file advertises `drainSignal`, so the updater never sends SIGUSR2 to an agent that would not
 * handle it (Node's default action for SIGUSR2 and SIGHUP is to exit).
 */
import { renameSync, writeFileSync } from "node:fs";
import { posix } from "node:path";

export const AGENT_STATUS_FILE = "agent-status.json";
export const STATUS_INTERVAL_MS = 15_000;
/** Longer than the updater's own wait (10 minutes), so the drain covers it. */
export const UPDATE_DRAIN_MS = 15 * 60_000;

export interface AgentStatusFile {
  v: 1;
  pid: number;
  version: string;
  startedAtMs: number;
  updatedAtMs: number;
  registered: boolean;
  draining: boolean;
  /** Claims and network model calls running now. */
  busy: number;
  /** The signal that starts an update drain (and SIGHUP ends it); absent on agents that predate it. */
  drainSignal: "SIGUSR2";
}

export interface UpdateDrainHooks {
  home: string;
  version: string;
  status: () => { registered: boolean; draining: boolean; busy: number };
  startDrain: (ms: number) => void;
  endDrain: () => void;
  log: (line: string) => void;
  now?: () => number;
  /** For tests: where signal handlers go (default: process). */
  on?: (signal: "SIGUSR2" | "SIGHUP", fn: () => void) => void;
  write?: (path: string, text: string) => void;
}

/** Atomic: a reader never sees half a file (write a sibling, then rename over). */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, path);
}

/** Wire the signals and start writing the status file; returns `write` (call it on a change) and `stop`. */
export function startUpdateDrain(h: UpdateDrainHooks): { write: () => void; stop: () => void } {
  const now = h.now ?? Date.now;
  const startedAtMs = now();
  // POSIX only (Linux/macOS installs): worker-runner never starts this on Windows.
  const path = posix.join(h.home, AGENT_STATUS_FILE);
  const put = h.write ?? writeAtomic;
  const write = () => {
    const s = h.status();
    const body: AgentStatusFile = { v: 1, pid: process.pid, version: h.version, startedAtMs, updatedAtMs: now(), registered: s.registered, draining: s.draining, busy: Math.max(0, Math.floor(s.busy)), drainSignal: "SIGUSR2" };
    try {
      put(path, JSON.stringify(body) + "\n");
    } catch {
      // no writable HOME (a desktop or dev run): the updater then treats this agent as unknown
    }
  };
  const on = h.on ?? ((signal, fn) => void process.on(signal, fn));
  on("SIGUSR2", () => {
    h.startDrain(UPDATE_DRAIN_MS);
    h.log("update drain: taking no new work; running work finishes");
    write();
  });
  on("SIGHUP", () => {
    h.endDrain();
    h.log("update drain ended: taking work again");
    write();
  });
  write();
  const timer = setInterval(write, STATUS_INTERVAL_MS);
  timer.unref?.();
  return { write, stop: () => clearInterval(timer) };
}
