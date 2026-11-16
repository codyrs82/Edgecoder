// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

import type { AlertManager } from "./manager.js";
import type { Monitor } from "./monitors.js";

/**
 * Runs each monitor on its interval and hands its answer to the manager. A monitor that throws
 * (its source is unreachable) leaves its rule's incidents as they are for that round. Rounds of one
 * monitor never overlap. Timers are unref'd so they never keep a process alive.
 */
export class AlertRunner {
  private timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<string>();

  constructor(
    private readonly manager: AlertManager,
    private readonly monitors: Monitor[],
    private readonly o: { intervalMs: number; now?: () => number; log?: { warn: (o: unknown, m: string) => void } }
  ) {}

  /** One round of one monitor (also what the tests call). */
  async runOnce(m: Monitor): Promise<void> {
    if (this.running.has(m.name)) return;
    this.running.add(m.name);
    try {
      const active = await m.check((this.o.now ?? Date.now)());
      await this.manager.apply(m.scope, m.name, active);
    } catch (error) {
      this.o.log?.warn({ monitor: m.name, error: error instanceof Error ? error.message : String(error) }, "alert_monitor_failed");
    } finally {
      this.running.delete(m.name);
    }
  }

  async runAll(): Promise<void> {
    await Promise.all(this.monitors.map((m) => this.runOnce(m)));
  }

  start(): void {
    this.stop();
    for (const m of this.monitors) {
      const t = setInterval(() => void this.runOnce(m), m.intervalMs ?? this.o.intervalMs);
      t.unref?.();
      this.timers.push(t);
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
