// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * Background jobs on the EdgeCoder network from the IDE: the request goes to the swarm (signed by
 * this machine's agent, one credit), another machine writes and runs code for it in its sandbox,
 * and the output comes back here. The IDE keeps working meanwhile and lists the jobs with their
 * state. In memory; the newest MAX_TASKS are kept.
 */

import { SwarmPostSubmitError } from "../../model/router.js";

const MAX_TASKS = 50;
const POLL_MS = 3000;
const TIMEOUT_MS = 15 * 60_000;

export interface NetworkTask {
  id: string;
  prompt: string;
  language: "python" | "javascript";
  state: "running" | "done" | "failed" | "timed_out";
  submittedAtMs: number;
  finishedAtMs?: number;
  output?: string;
  error?: string;
  creditsSpent?: number;
}

export interface SwarmClient {
  submitSwarm(prompt: string, opts: { language?: "python" | "javascript" }): Promise<{ taskId: string; subtaskId: string }>;
  pollSwarm(taskId: string, subtaskId: string): Promise<{ output: string; ok?: boolean; error?: string; creditsSpent?: number } | null>;
}

export class NetworkTasks {
  private readonly tasks = new Map<string, NetworkTask & { subtaskId: string }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly swarm: SwarmClient, private readonly now: () => number = Date.now) {}

  /** Submit; resolves once the network accepted the job (it then runs in the background). */
  async submit(prompt: string, language: "python" | "javascript" = "python"): Promise<NetworkTask> {
    let ids: { taskId: string; subtaskId: string };
    try {
      ids = await this.swarm.submitSwarm(prompt, { language });
    } catch (err) {
      // After the request went out the job may exist and be billed: say so rather than hide it.
      if (err instanceof SwarmPostSubmitError) throw new Error(`${err.message}. It may still run; check again shortly.`);
      throw err;
    }
    const task = { id: ids.taskId, subtaskId: ids.subtaskId, prompt, language, state: "running" as const, submittedAtMs: this.now() };
    this.tasks.set(task.id, task);
    while (this.tasks.size > MAX_TASKS) this.tasks.delete(this.tasks.keys().next().value!);
    this.ensurePolling();
    return this.view(task);
  }

  list(): NetworkTask[] {
    return [...this.tasks.values()].reverse().map((t) => this.view(t));
  }

  private view(t: NetworkTask & { subtaskId: string }): NetworkTask {
    const { subtaskId: _s, ...rest } = t;
    return { ...rest };
  }

  private ensurePolling() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollOnce(), POLL_MS);
    this.timer.unref?.();
  }

  /** One round of polling every running job (exposed for tests). */
  async pollOnce(): Promise<void> {
    const running = [...this.tasks.values()].filter((t) => t.state === "running");
    if (running.length === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      return;
    }
    for (const t of running) {
      if (this.now() - t.submittedAtMs > TIMEOUT_MS) {
        t.state = "timed_out";
        t.finishedAtMs = this.now();
        continue;
      }
      try {
        const r = await this.swarm.pollSwarm(t.id, t.subtaskId);
        if (!r) continue;
        t.state = r.ok === false ? "failed" : "done";
        t.output = r.output;
        t.error = r.error;
        t.creditsSpent = r.creditsSpent;
        t.finishedAtMs = this.now();
      } catch {
        // network hiccup: try again next round
      }
    }
  }
}
