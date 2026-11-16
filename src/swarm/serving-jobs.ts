// Copyright (c) 2025 EdgeCoder, LLC
// SPDX-License-Identifier: BUSL-1.1

/**
 * The network jobs this machine's agent is running right now, for the desktop's Settings → Active
 * work (through the local forwarder's /forward/health, then the IDE provider's /v1/ide/activity).
 *
 * Only what the owner of this machine may see about work it serves: the job kind, the model, when it
 * started and how much it has written so far. Never the prompt or the requester: the agent does not
 * know who asked, and the provider marks a job "you" only when the task id is one it sent itself.
 */

export interface ServingJob {
  /** The coordinator's subtask id. */
  id: string;
  /** The task it belongs to (the provider matches it against the requests it sent itself). */
  taskId: string;
  kind: "inference" | "code";
  model: string | null;
  startedAtMs: number;
  /** Output so far, estimated from the streamed text (about 4 characters a token). */
  outputTokens: number;
}

export interface ServingView {
  jobs: ServingJob[];
  /** Model slots (calls served side by side) and how many are in use. */
  slots: { total: number; busy: number };
  /** The class and tier the coordinator granted this machine at its last registration. */
  computeClass: string | null;
  tier: string | null;
}

export interface ServingHandle {
  /** Streamed reply text, for the tokens-so-far estimate. */
  delta(text: string): void;
  end(): void;
}

const CHARS_PER_TOKEN = 4;

export class ServingJobs {
  private readonly jobs = new Map<string, { job: ServingJob; chars: number }>();
  private computeClass: string | null = null;
  private tier: string | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  start(st: { id: string; taskId: string; kind: string; requestedModel?: string }): ServingHandle {
    const key = `${st.id}:${this.now()}:${Math.random()}`;
    const entry = {
      job: {
        id: String(st.id).slice(0, 80),
        taskId: String(st.taskId).slice(0, 120),
        kind: st.kind === "inference" ? ("inference" as const) : ("code" as const),
        model: st.requestedModel ? String(st.requestedModel).slice(0, 120) : null,
        startedAtMs: this.now(),
        outputTokens: 0,
      },
      chars: 0,
    };
    this.jobs.set(key, entry);
    return {
      delta: (text: string) => {
        entry.chars += text.length;
        entry.job.outputTokens = Math.ceil(entry.chars / CHARS_PER_TOKEN);
      },
      end: () => {
        this.jobs.delete(key);
      },
    };
  }

  /** From a /register reply's hardwareVerification (grantedClass / grantedTier). */
  setGrant(computeClass: unknown, tier: unknown): void {
    if (typeof computeClass === "string" && computeClass) this.computeClass = computeClass.slice(0, 40);
    if (typeof tier === "string" && tier) this.tier = tier.slice(0, 40);
  }

  view(totalSlots: number, busySlots?: number): ServingView {
    const jobs = [...this.jobs.values()].map((e) => ({ ...e.job })).sort((a, b) => a.startedAtMs - b.startedAtMs);
    const inference = jobs.filter((j) => j.kind === "inference").length;
    return {
      jobs,
      slots: { total: Math.max(0, totalSlots), busy: Math.max(0, busySlots ?? inference) },
      computeClass: this.computeClass,
      tier: this.tier,
    };
  }
}
